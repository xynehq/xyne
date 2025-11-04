import { z } from "zod"
import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionContext, ToolExecutionResult } from "./types"

// Delay tool configuration schema
export const delayConfigSchema = z.object({
  duration: z.number().min(1), // Duration in seconds
  unit: z.enum(["seconds", "minutes", "hours", "days"]).default("seconds"),
  message: z.string().optional(),
})

// Delay tool input schema
export const delayInputSchema = z.object({
  durationOverride: z.number().optional(), // Override config duration
  unitOverride: z.enum(["seconds", "minutes", "hours", "days"]).optional(),
})

// Delay tool output schema
export const delayOutputSchema = z.object({
  delayedFor: z.number(),
  unit: z.string(),
  delayedUntil: z.string(),
  message: z.string(),
})

export type DelayConfig = z.infer<typeof delayConfigSchema>
export type DelayInput = z.infer<typeof delayInputSchema>
export type DelayOutput = z.infer<typeof delayOutputSchema>

// Helper function to convert duration to milliseconds
const convertToMilliseconds = (duration: number, unit: string): number => {
  switch (unit) {
    case "seconds":
      return duration * 1000
    case "minutes":
      return duration * 60 * 1000
    case "hours":
      return duration * 60 * 60 * 1000
    case "days":
      return duration * 24 * 60 * 60 * 1000
    default:
      return duration * 1000
  }
}

export class DelayTool implements WorkflowTool<DelayConfig, DelayInput, DelayOutput> {
  type = ToolType.DELAY
  category = ToolCategory.SYSTEM

  async execute(
    input: DelayInput,
    config: DelayConfig,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<DelayOutput>> {
    try {
      const duration = input.durationOverride ?? config.duration
      const unit = input.unitOverride ?? config.unit
      const milliseconds = convertToMilliseconds(duration, unit)

      // Simulate delay
      await new Promise(resolve => setTimeout(resolve, milliseconds))

      const delayedUntil = new Date(Date.now() + milliseconds).toISOString()

      const output: DelayOutput = {
        delayedFor: duration,
        unit,
        delayedUntil,
        message: config.message || `Delayed for ${duration} ${unit}`,
      }

      return {
        status: "success",
        result: output,
      }
    } catch (error) {
      return {
        status: "error",
        result: {
          delayedFor: 0,
          unit: config.unit,
          delayedUntil: new Date().toISOString(),
          message: `Delay failed: ${error instanceof Error ? error.message : String(error)}`,
        } as DelayOutput,
      }
    }
  }

  validateInput(input: unknown): input is DelayInput {
    return delayInputSchema.safeParse(input).success
  }

  validateConfig(config: unknown): config is DelayConfig {
    return delayConfigSchema.safeParse(config).success
  }

  getInputSchema() {
    return delayInputSchema
  }

  getConfigSchema() {
    return delayConfigSchema
  }

  getDefaultConfig(): DelayConfig {
    return {
      duration: 5,
      unit: "seconds",
      message: "Workflow paused",
    }
  }
}