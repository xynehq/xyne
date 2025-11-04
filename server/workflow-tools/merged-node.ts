import { z } from "zod"
import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionContext, ToolExecutionResult } from "./types"

// Merged Node tool configuration schema
export const mergedNodeConfigSchema = z.object({
  mergeStrategy: z.enum(["wait_all", "wait_any", "first_complete"]).default("wait_all"),
  requiredInputCount: z.number().min(1).default(2),
  timeoutSeconds: z.number().optional(), // Optional timeout for waiting
  combineResults: z.boolean().default(true),
  outputFormat: z.enum(["array", "object", "concatenated"]).default("object"),
})

// Merged Node tool input schema
export const mergedNodeInputSchema = z.object({
  inputs: z.array(z.any()).min(1), // Array of inputs from previous steps
  inputMetadata: z.array(z.object({
    stepId: z.string(),
    stepName: z.string(),
    completedAt: z.string(),
  })).optional(),
})

// Merged Node tool output schema
export const mergedNodeOutputSchema = z.object({
  mergedResult: z.any(),
  inputsReceived: z.number(),
  inputsExpected: z.number(),
  mergeStrategy: z.string(),
  processedAt: z.string(),
  sourceSteps: z.array(z.string()),
})

export type MergedNodeConfig = z.infer<typeof mergedNodeConfigSchema>
export type MergedNodeInput = z.infer<typeof mergedNodeInputSchema>
export type MergedNodeOutput = z.infer<typeof mergedNodeOutputSchema>

export class MergedNodeTool implements WorkflowTool<MergedNodeConfig, MergedNodeInput, MergedNodeOutput> {
  type = ToolType.MERGED_NODE
  category = ToolCategory.SYSTEM

  async execute(
    input: MergedNodeInput,
    config: MergedNodeConfig,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<MergedNodeOutput>> {
    try {
      const inputsReceived = input.inputs.length
      const inputsExpected = config.requiredInputCount

      // Check if we have enough inputs based on merge strategy
      let shouldProceed = false
      switch (config.mergeStrategy) {
        case "wait_all":
          shouldProceed = inputsReceived >= inputsExpected
          break
        case "wait_any":
          shouldProceed = inputsReceived >= 1
          break
        case "first_complete":
          shouldProceed = inputsReceived >= 1
          break
      }

      if (!shouldProceed) {
        return {
          status: "awaiting_user_input",
          result: {
            mergedResult: null,
            inputsReceived,
            inputsExpected,
            mergeStrategy: config.mergeStrategy,
            processedAt: new Date().toISOString(),
            sourceSteps: input.inputMetadata?.map(m => m.stepId) || [],
          } as MergedNodeOutput,
        }
      }

      // Merge the inputs based on output format
      let mergedResult: any
      switch (config.outputFormat) {
        case "array":
          mergedResult = input.inputs
          break
        case "concatenated":
          mergedResult = input.inputs
            .map(item => typeof item === "string" ? item : JSON.stringify(item))
            .join("\n\n")
          break
        case "object":
        default:
          mergedResult = {}
          input.inputs.forEach((inputItem, index) => {
            const stepName = input.inputMetadata?.[index]?.stepName || `step_${index + 1}`
            mergedResult[stepName] = inputItem
          })
          break
      }

      const output: MergedNodeOutput = {
        mergedResult,
        inputsReceived,
        inputsExpected,
        mergeStrategy: config.mergeStrategy,
        processedAt: new Date().toISOString(),
        sourceSteps: input.inputMetadata?.map(m => m.stepId) || [],
      }

      return {
        status: "success",
        result: output,
      }
    } catch (error) {
      return {
        status: "error",
        result: {
          mergedResult: null,
          inputsReceived: input.inputs?.length || 0,
          inputsExpected: config.requiredInputCount,
          mergeStrategy: config.mergeStrategy,
          processedAt: new Date().toISOString(),
          sourceSteps: [],
        } as MergedNodeOutput,
      }
    }
  }

  validateInput(input: unknown): input is MergedNodeInput {
    return mergedNodeInputSchema.safeParse(input).success
  }

  validateConfig(config: unknown): config is MergedNodeConfig {
    return mergedNodeConfigSchema.safeParse(config).success
  }

  getInputSchema() {
    return mergedNodeInputSchema
  }

  getConfigSchema() {
    return mergedNodeConfigSchema
  }

  getDefaultConfig(): MergedNodeConfig {
    return {
      mergeStrategy: "wait_all",
      requiredInputCount: 2,
      combineResults: true,
      outputFormat: "object",
    }
  }
}