import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext } from "./types"
import { z } from "zod"

export class EmailTool implements WorkflowTool {
  type = ToolType.EMAIL
  category = ToolCategory.ACTION
  triggerIfActive = false

  inputSchema = z.object({
    recipients_override: z.union([z.string(), z.array(z.string())]).optional(),
    subject_override: z.string().optional(),
    content: z.string().optional()
  })

  outputSchema = z.object({
    messageId: z.string().optional(),
    to: z.array(z.string()),
    subject: z.string(),
    content: z.string(),
    sentAt: z.string(),
    status: z.string()
  })

  configSchema = z.object({
    recipients: z.union([z.string(), z.array(z.string())]).optional(),
    to_email: z.union([z.string(), z.array(z.string())]).optional(),
    from_email: z.string().optional(),
    subject: z.string().optional()
  })

  async execute(
    input: Record<string, any>,
    config: Record<string, any>,
    workflowContext: WorkflowContext
  ): Promise<ToolExecutionResult> {
    try {
      // Extract configuration with defaults
      const recipients = input.recipients_override || config.recipients || config.to_email
      const subject = input.subject_override || config.subject || "No Subject"
      const content = input.content || "No content provided"
      const fromEmail = config.from_email || "no-reply@xyne.io"

      // Simulate email sending (actual implementation to be added later)
      const recipientList = Array.isArray(recipients) ? recipients : [recipients]
      
      return {
        status: "success",
        result: {
          emails_sent: recipientList.length,
          total_recipients: recipientList.length,
          all_sent: true,
          results: recipientList.map(recipient => ({
            recipient,
            sent: true,
          })),
          email_details: {
            from: fromEmail,
            subject,
            content_type: config.content_type || "html",
            body_length: content.length,
          },
          message: `Successfully sent email to ${recipientList.length} recipient(s)`,
        },
      }
    } catch (error) {
      return {
        status: "error",
        result: {
          emails_sent: 0,
          total_recipients: 0,
          all_sent: false,
          results: [],
          email_details: {
            from: config.from_email || "no-reply@xyne.io",
            subject: input.subject_override || config.subject || "No Subject",
            content_type: config.content_type || "html",
            body_length: 0,
          },
          message: `Failed to send email: ${error instanceof Error ? error.message : String(error)}`,
        },
      }
    }
  }
}