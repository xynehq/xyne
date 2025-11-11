import { ToolType, ToolCategory, ToolExecutionStatus } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext,defaultToolConfig } from "./types"
import { z } from "zod"

export class ManualTriggerTool implements WorkflowTool {
  type = ToolType.MANUAL_TRIGGER
  category = ToolCategory.TRIGGER
  
  defaultConfig:defaultToolConfig = {
    inputCount: 0, // No input required for trigger
    outputCount: 1,
    options: {
      buttonText: {
        type: "string",
        default: "Start Workflow",
        optional: true
      },
      description: {
        type: "string",
        default: "",
        optional: true
      },
      requireConfirmation: {
        type: "boolean",
        default: false,
        optional: true
      }
    }
  }

  inputSchema = z.object({
    triggeredBy: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional()
  })

  outputSchema = z.object({
    triggeredAt: z.string(),
    triggeredBy: z.string().optional(),
    triggerReason: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional()
  })

  configSchema = z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    allowedUsers: z.array(z.string()).optional()
  })

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