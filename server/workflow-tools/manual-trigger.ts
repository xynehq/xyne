import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext } from "./types"
import { z } from "zod"

export class ManualTriggerTool implements WorkflowTool {
  type = ToolType.MANUAL_TRIGGER
  category = ToolCategory.TRIGGER
  triggerIfActive = false

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
        status: "awaiting_user_input",
        result: {
          triggeredAt: new Date().toISOString()
        },
      }
    } catch (error) {
      return {
        status: "error",
        result: {
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