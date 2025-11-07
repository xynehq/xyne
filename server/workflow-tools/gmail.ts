import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext } from "./types"
import { z } from "zod"

export class GmailTool implements WorkflowTool {
  type = ToolType.GMAIL
  category = ToolCategory.ACTION
  triggerIfActive = false

  inputSchema = z.object({
    subject: z.string().optional(),
    body: z.string().optional(),
    attachments: z.array(z.string()).optional(),
    previousStepData: z.record(z.string(), z.any()).optional()
  })

  outputSchema = z.object({
    messageId: z.string().optional(),
    to: z.array(z.string()),
    subject: z.string(),
    body: z.string(),
    sentAt: z.string(),
    status: z.string()
  })

  configSchema = z.object({
    to: z.array(z.string()).min(1, "At least one recipient is required"),
    cc: z.array(z.string()).optional(),
    bcc: z.array(z.string()).optional(),
    from: z.string().optional(),
    replyTo: z.string().optional(),
    template: z.string().optional(),
    priority: z.enum(["low", "normal", "high"]).optional()
  })

  async execute(
    input: Record<string, any>,
    config: Record<string, any>,
    workflowContext: WorkflowContext
  ): Promise<ToolExecutionResult> {
    return {
      status: "success",
      result: {
        message: "Gmail task completed",
        data: input,
      },
    }
  }
}
