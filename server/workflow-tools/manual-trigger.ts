import { ToolType, ToolCategory, ToolExecutionStatus } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext,defaultToolConfig } from "./types"


export class ManualTriggerTool implements WorkflowTool {
  type = ToolType.MANUAL_TRIGGER
  category = ToolCategory.TRIGGER
  defaultConfig:defaultToolConfig = {
    inputCount: 0, // No input required for trigger
    outputCount: 1,
    button:{
      text:"start workflow"
    },
    options: {
      description: {
        type: "string",
        default: "",
        optional: true
      },
    }
  }


  async execute(
    input: Record<string, any>,
    config: Record<string, any>,
    workflowContext: WorkflowContext
  ): Promise<ToolExecutionResult> {
    try {
      return {
        status: ToolExecutionStatus.AWAITING_USER_INPUT,
        output: {
          triggeredAt: new Date().toISOString()
        },
      }
    } catch (error) {
      return {
        status: ToolExecutionStatus.FAILED,
        output: {
          triggeredAt: new Date().toISOString(),
          triggeredBy: input.triggeredBy || "unknown",
          triggerReason: `Manual trigger failed: ${error instanceof Error ? error.message : String(error)}`,
          title: config.title || "Manual Trigger",
          description: config.description || "",
          metadata: input.metadata || {},
        },
      }
    }
  }
}