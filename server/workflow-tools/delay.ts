import { ToolType, ToolCategory, ToolExecutionStatus } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext } from "./types"

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
        values: ["seconds", "minutes", "hours", "days"],
        optional: false
      },
      message: {
        type: "string",
        default: "Waiting...",
        optional: true
      }
    }
  }


  async execute(
    input: Record<string, any>,
    config: Record<string, any>,
    workflowContext: WorkflowContext
  ): Promise<ToolExecutionResult> {
      const duration = input.durationOverride ?? config.duration ?? 0
      const unit = input.unitOverride ?? config.unit ?? "seconds"
      const milliseconds = convertToMilliseconds(duration, unit)

      const nextExecuteAfterSeconds = Math.ceil(milliseconds / 1000)

      return {
        status: ToolExecutionStatus.COMPLETED,
        output: input,
        nextExecuteAfter: nextExecuteAfterSeconds
      }
    
  }
}