import { z } from "zod"
import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionContext, ToolExecutionResult } from "./types"

// Conditional tool configuration schema
export const conditionalConfigSchema = z.object({
  condition: z.string().min(1), // JavaScript expression to evaluate
  trueOutput: z.any().optional(),
  falseOutput: z.any().optional(),
  operator: z.enum(["equals", "not_equals", "greater_than", "less_than", "contains", "custom"]).default("equals"),
  compareValue: z.any().optional(),
})

// Conditional tool input schema
export const conditionalInputSchema = z.object({
  inputValue: z.any(),
  customCondition: z.string().optional(),
})

// Conditional tool output schema
export const conditionalOutputSchema = z.object({
  result: z.boolean(),
  outputValue: z.any(),
  conditionEvaluated: z.string(),
  inputValue: z.any(),
  executedAt: z.string(),
})

export type ConditionalConfig = z.infer<typeof conditionalConfigSchema>
export type ConditionalInput = z.infer<typeof conditionalInputSchema>
export type ConditionalOutput = z.infer<typeof conditionalOutputSchema>

// Helper function to evaluate condition
const evaluateCondition = (
  inputValue: any,
  operator: string,
  compareValue: any,
  customCondition?: string
): boolean => {
  if (operator === "custom" && customCondition) {
    try {
      // Simple eval for custom conditions - in production, use a safer expression evaluator
      const func = new Function('input', `return ${customCondition}`)
      return Boolean(func(inputValue))
    } catch {
      return false
    }
  }

  switch (operator) {
    case "equals":
      return inputValue === compareValue
    case "not_equals":
      return inputValue !== compareValue
    case "greater_than":
      return Number(inputValue) > Number(compareValue)
    case "less_than":
      return Number(inputValue) < Number(compareValue)
    case "contains":
      return String(inputValue).includes(String(compareValue))
    default:
      return false
  }
}

export class ConditionalTool implements WorkflowTool<ConditionalConfig, ConditionalInput, ConditionalOutput> {
  type = ToolType.CONDITIONAL
  category = ToolCategory.SYSTEM

  async execute(
    input: ConditionalInput,
    config: ConditionalConfig,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<ConditionalOutput>> {
    try {
      const { inputValue, customCondition } = input
      const { operator, compareValue, trueOutput, falseOutput } = config

      // Evaluate the condition
      const conditionResult = evaluateCondition(
        inputValue,
        operator,
        compareValue,
        customCondition || config.condition
      )

      // Determine output value based on condition result
      const outputValue = conditionResult ? trueOutput : falseOutput

      const output: ConditionalOutput = {
        result: conditionResult,
        outputValue,
        conditionEvaluated: customCondition || config.condition,
        inputValue,
        executedAt: new Date().toISOString(),
      }

      return {
        status: "success",
        result: output,
      }
    } catch (error) {
      return {
        status: "error",
        result: {
          result: false,
          outputValue: null,
          conditionEvaluated: config.condition,
          inputValue: input.inputValue,
          executedAt: new Date().toISOString(),
        } as ConditionalOutput,
      }
    }
  }

  validateInput(input: unknown): input is ConditionalInput {
    return conditionalInputSchema.safeParse(input).success
  }

  validateConfig(config: unknown): config is ConditionalConfig {
    return conditionalConfigSchema.safeParse(config).success
  }

  getInputSchema() {
    return conditionalInputSchema
  }

  getConfigSchema() {
    return conditionalConfigSchema
  }

  getDefaultConfig(): ConditionalConfig {
    return {
      condition: "input === true",
      operator: "equals",
      compareValue: true,
      trueOutput: "condition_met",
      falseOutput: "condition_not_met",
    }
  }
}