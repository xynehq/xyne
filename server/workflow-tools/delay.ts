import { ToolType, ToolCategory, ToolExecutionStatus } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext } from "./types"
import { z } from "zod"

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

export class DelayTool implements WorkflowTool {
  type = ToolType.DELAY
  category = ToolCategory.SYSTEM
  
  defaultConfig = {
    inputCount: 1,
    outputCount: 1,
    options: {
      duration: {
        type: "number",
        default: 5,
        optional: false
      },
      unit: {
        type: "select",
        default: "seconds",
        optional: false
      },
      message: {
        type: "string",
        default: "Waiting...",
        optional: true
      }
    }
  }

  inputSchema = z.object({
    durationOverride: z.number().positive().optional(),
    unitOverride: z.enum(["seconds", "minutes", "hours", "days"]).optional()
  })

  outputSchema = z.object({
    delayedFor: z.number(),
    unit: z.string(),
    delayedUntil: z.string(),
    message: z.string()
  })

  configSchema = z.object({
    duration: z.number().positive().default(5),
    unit: z.enum(["seconds", "minutes", "hours", "days"]).default("seconds"),
    message: z.string().optional()
  })

  async execute(
    input: Record<string, any>,
    config: Record<string, any>,
    workflowContext: WorkflowContext
  ): Promise<ToolExecutionResult> {
    try {
      const duration = input.durationOverride ?? config.duration ?? 5
      const unit = input.unitOverride ?? config.unit ?? "seconds"
      const milliseconds = convertToMilliseconds(duration, unit)

      // Simulate delay
      await new Promise(resolve => setTimeout(resolve, milliseconds))

      const delayedUntil = new Date(Date.now() + milliseconds).toISOString()

      return {
        status: ToolExecutionStatus.COMPLETED,
        output: {
          delayedFor: duration,
          unit,
          delayedUntil,
          message: config.message || `Delayed for ${duration} ${unit}`,
        },
      }
    } catch (error) {
      return {
        status: ToolExecutionStatus.FAILED,
        output: {
          delayedFor: 0,
          unit: config.unit || "seconds",
          delayedUntil: new Date().toISOString(),
          message: `Delay failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      }
    }
  }
}