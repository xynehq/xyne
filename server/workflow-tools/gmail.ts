import { z } from "zod"
import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionContext, ToolExecutionResult } from "./types"

// Gmail tool configuration schema
export const gmailConfigSchema = z.object({
  to: z.union([z.string().email(), z.array(z.string().email())]),
  cc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
  bcc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
  subject: z.string().optional(),
  contentType: z.enum(["html", "text"]).default("html"),
  attachFiles: z.boolean().default(false),
  priority: z.enum(["high", "normal", "low"]).default("normal"),
  replyToEmail: z.string().email().optional(),
})

// Gmail tool input schema
export const gmailInputSchema = z.object({
  emailBody: z.string().optional(),
  subjectOverride: z.string().optional(),
  toOverride: z.union([z.string().email(), z.array(z.string().email())]).optional(),
  attachments: z.array(z.object({
    filename: z.string(),
    content: z.string(), // Base64 encoded content
    mimeType: z.string(),
  })).optional(),
  templateData: z.record(z.string(), z.any()).optional(),
})

// Gmail tool output schema
export const gmailOutputSchema = z.object({
  emailSent: z.boolean(),
  messageId: z.string().optional(),
  recipients: z.object({
    to: z.array(z.string()),
    cc: z.array(z.string()).optional(),
    bcc: z.array(z.string()).optional(),
  }),
  subject: z.string(),
  sentAt: z.string(),
  contentLength: z.number(),
  attachmentCount: z.number(),
  error: z.string().optional(),
})

export type GmailConfig = z.infer<typeof gmailConfigSchema>
export type GmailInput = z.infer<typeof gmailInputSchema>
export type GmailOutput = z.infer<typeof gmailOutputSchema>

// Helper function to extract content from previous step results (similar to email tool)
const extractContentFromPreviousStep = (
  previousStepResults: any
): string => {
  if (!previousStepResults) return ""

  const stepKeys = Object.keys(previousStepResults)
  if (stepKeys.length === 0) return ""

  const latestStepKey = stepKeys[stepKeys.length - 1]
  const latestStepResult = previousStepResults[latestStepKey]

  return latestStepResult?.result?.aiOutput ||
    latestStepResult?.result?.content ||
    latestStepResult?.result?.message ||
    JSON.stringify(latestStepResult?.result || {})
}

// Helper function to format HTML email
const formatHtmlEmail = (content: string, workflowName: string): string => {
  if (content.includes("<html")) {
    return content
  }

  return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: 'Arial', sans-serif; line-height: 1.6; margin: 20px; }
        .container { max-width: 600px; margin: 0 auto; }
        .header { background: #f4f4f4; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        .content { background: white; padding: 20px; border: 1px solid #ddd; border-radius: 8px; }
        .footer { margin-top: 20px; font-size: 12px; color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>📧 ${workflowName}</h2>
            <p>Sent on: ${new Date().toLocaleString()}</p>
        </div>
        <div class="content">
            ${content.replace(/\n/g, "<br>")}
        </div>
        <div class="footer">
            <p>This email was sent automatically by your workflow automation system.</p>
        </div>
    </div>
</body>
</html>`
}

export class GmailTool implements WorkflowTool<GmailConfig, GmailInput, GmailOutput> {
  type = ToolType.GMAIL
  category = ToolCategory.ACTION

  async execute(
    input: GmailInput,
    config: GmailConfig,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<GmailOutput>> {
    try {
      // Determine recipients
      const toRecipients = Array.isArray(input.toOverride || config.to) 
        ? (input.toOverride || config.to) as string[]
        : [input.toOverride || config.to] as string[]
      
      const ccRecipients = config.cc 
        ? Array.isArray(config.cc) ? config.cc : [config.cc]
        : []
      
      const bccRecipients = config.bcc 
        ? Array.isArray(config.bcc) ? config.bcc : [config.bcc]
        : []

      // Determine email content
      let emailBody = input.emailBody || ""
      if (!emailBody) {
        emailBody = extractContentFromPreviousStep(context.previousStepResults)
      }

      if (!emailBody) {
        emailBody = "No content available"
      }

      // Format email body based on content type
      if (config.contentType === "html") {
        emailBody = formatHtmlEmail(emailBody, "Workflow Email")
      }

      // Determine subject
      const subject = input.subjectOverride || config.subject || "Workflow Notification"

      // Prepare Gmail API payload (this is a simplified version)
      // In a real implementation, you would use the Gmail API with proper authentication
      const emailData = {
        to: toRecipients,
        cc: ccRecipients,
        bcc: bccRecipients,
        subject,
        body: emailBody,
        contentType: config.contentType,
        attachments: input.attachments || [],
        priority: config.priority,
        replyTo: config.replyToEmail,
      }

      // Simulate email sending (in real implementation, this would call Gmail API)
      // For now, we'll assume success and return appropriate data
      const messageSent = true // In reality, this would be the result of the Gmail API call
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

      const output: GmailOutput = {
        emailSent: messageSent,
        messageId: messageSent ? messageId : undefined,
        recipients: {
          to: toRecipients,
          cc: ccRecipients.length > 0 ? ccRecipients : undefined,
          bcc: bccRecipients.length > 0 ? bccRecipients : undefined,
        },
        subject,
        sentAt: new Date().toISOString(),
        contentLength: emailBody.length,
        attachmentCount: input.attachments?.length || 0,
        error: messageSent ? undefined : "Failed to send email via Gmail API",
      }

      return {
        status: messageSent ? "success" : "error",
        result: output,
      }
    } catch (error) {
      return {
        status: "error",
        result: {
          emailSent: false,
          recipients: {
            to: [],
          },
          subject: input.subjectOverride || config.subject || "",
          sentAt: new Date().toISOString(),
          contentLength: 0,
          attachmentCount: 0,
          error: `Gmail tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        } as GmailOutput,
      }
    }
  }

  validateInput(input: unknown): input is GmailInput {
    return gmailInputSchema.safeParse(input).success
  }

  validateConfig(config: unknown): config is GmailConfig {
    return gmailConfigSchema.safeParse(config).success
  }

  getInputSchema() {
    return gmailInputSchema
  }

  getConfigSchema() {
    return gmailConfigSchema
  }

  getDefaultConfig(): GmailConfig {
    return {
      to: "user@example.com",
      contentType: "html",
      attachFiles: false,
      priority: "normal",
    }
  }
}