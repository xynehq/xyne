import { z } from "zod"
import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionContext, ToolExecutionResult } from "./types"

// Email tool configuration schema
export const emailConfigSchema = z.object({
  to_email: z.union([z.string().email(), z.array(z.string().email())]).optional(),
  recipients: z.union([z.string().email(), z.array(z.string().email())]).optional(),
  from_email: z.string().email().default("no-reply@xyne.io"),
  subject: z.string().optional(),
  content_type: z.enum(["html", "text"]).default("html"),
  content_path: z.string().optional(),
  content_source_path: z.string().optional(),
})

// Email tool input schema
export const emailInputSchema = z.object({
  content: z.string().optional(),
  subject_override: z.string().optional(),
  recipients_override: z.union([z.string().email(), z.array(z.string().email())]).optional(),
})

// Email tool output schema
export const emailOutputSchema = z.object({
  emails_sent: z.number(),
  total_recipients: z.number(),
  all_sent: z.boolean(),
  results: z.array(z.object({
    recipient: z.string(),
    sent: z.boolean(),
    error: z.string().optional(),
  })),
  email_details: z.object({
    from: z.string(),
    subject: z.string(),
    content_type: z.string(),
    body_length: z.number(),
  }),
  message: z.string(),
})

export type EmailConfig = z.infer<typeof emailConfigSchema>
export type EmailInput = z.infer<typeof emailInputSchema>
export type EmailOutput = z.infer<typeof emailOutputSchema>

// Helper function to extract content from previous step results
const extractContentFromPath = (
  previousStepResults: any,
  contentPath: string,
): string => {
  try {
    if (!contentPath.startsWith("input.")) {
      return `Invalid path: ${contentPath}. Only paths starting with 'input.' are supported.`
    }

    const stepKeys = Object.keys(previousStepResults || {})
    if (stepKeys.length === 0) {
      return "No previous steps available"
    }

    const propertyPath = contentPath.slice(6) // Remove "input."
    const pathParts = propertyPath.split(".")

    const latestStepKey = stepKeys[stepKeys.length - 1]
    const latestStepResult = previousStepResults[latestStepKey]

    if (latestStepResult?.result) {
      let target = latestStepResult.result

      for (const part of pathParts) {
        if (target && typeof target === "object" && part in target) {
          target = target[part]
        } else {
          return `Property '${part}' not found in any step result. Available steps: ${stepKeys.join(", ")}`
        }
      }

      if (typeof target === "string") {
        return target
      } else if (target !== null && target !== undefined) {
        return JSON.stringify(target, null, 2)
      }
    }

    return `No content found for path '${contentPath}' in any step. Available steps: ${stepKeys.join(", ")}`
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`
  }
}

export class EmailTool implements WorkflowTool<EmailConfig, EmailInput, EmailOutput> {
  type = ToolType.EMAIL
  category = ToolCategory.ACTION

  async execute(
    input: EmailInput,
    config: EmailConfig,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<EmailOutput>> {
    try {
      // Determine recipients
      const toEmail = input.recipients_override || config.to_email || config.recipients || []
      const fromEmail = config.from_email || "no-reply@xyne.io"
      const contentType = config.content_type || "html"
      
      // Get workflow name for subject
      const workflowName = "Workflow Execution" // TODO: Get from context
      const subject = input.subject_override || config.subject || `Results of Workflow: ${workflowName}`
      
      // Determine email content
      let emailBody = ""
      
      if (input.content) {
        // Use direct content from input
        emailBody = input.content
      } else if (config.content_path || config.content_source_path) {
        // Extract content using configurable path
        const contentPath = config.content_path || config.content_source_path!
        emailBody = extractContentFromPath(context.previousStepResults, contentPath)
        if (!emailBody) {
          emailBody = `No content found at path: ${contentPath}`
        }
      } else {
        // Fallback to extracting from response.aiOutput path
        emailBody = extractContentFromPath(context.previousStepResults || {}, "input.aiOutput")
        if (!emailBody) {
          emailBody = "No content available from previous step"
        }
      }

      // Wrap plain text in HTML if content type is HTML
      if (contentType === "html" && !emailBody.includes("<html")) {
        emailBody = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: 'Segoe UI', sans-serif; line-height: 1.6; margin: 20px; }
        .content { max-width: 800px; margin: 0 auto; }
        .header { background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        .body-content { background: white; padding: 20px; border: 1px solid #dee2e6; border-radius: 8px; }
    </style>
</head>
<body>
    <div class="content">
        <div class="header">
            <h2>🤖 Results of Workflow: ${workflowName} </h2>
            <p>Generated on: ${new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })}</p>
        </div>
        <div class="body-content">
            ${emailBody.replace(/\n/g, "<br>")}
        </div>
    </div>
</body>
</html>`
      }

      // Validate email configuration
      if (!toEmail || (Array.isArray(toEmail) && toEmail.length === 0)) {
        return {
          status: "error",
          result: {
            emails_sent: 0,
            total_recipients: 0,
            all_sent: false,
            results: [],
            email_details: {
              from: fromEmail,
              subject,
              content_type: contentType,
              body_length: emailBody.length,
            },
            message: "No email recipients configured in tool config (to_email or recipients field required)",
          } as EmailOutput,
        }
      }

      // Import and use the email service
      const { emailService } = await import("@/services/emailService")

      // Convert single email to array if needed
      const recipients = Array.isArray(toEmail) ? toEmail : [toEmail]

      // Send email to all recipients
      const emailResults = []
      for (const recipient of recipients) {
        try {
          const emailSent = await emailService.sendEmail({
            to: recipient,
            subject,
            body: emailBody,
            contentType: contentType === "html" ? "html" : "text",
          })
          emailResults.push({ recipient, sent: emailSent })
        } catch (emailError) {
          emailResults.push({
            recipient,
            sent: false,
            error: emailError instanceof Error ? emailError.message : String(emailError),
          })
        }
      }

      const successCount = emailResults.filter((r) => r.sent).length
      const allSent = successCount === recipients.length

      const output: EmailOutput = {
        emails_sent: successCount,
        total_recipients: recipients.length,
        all_sent: allSent,
        results: emailResults,
        email_details: {
          from: fromEmail,
          subject,
          content_type: contentType,
          body_length: emailBody.length,
        },
        message: allSent
          ? `Email sent successfully to all ${successCount} recipients`
          : `Email sent to ${successCount} of ${recipients.length} recipients`,
      }

      return {
        status: allSent ? "success" : "partial_success",
        result: output,
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
            subject: input.subject_override || config.subject || "",
            content_type: config.content_type || "html",
            body_length: 0,
          },
          message: `Email tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        } as EmailOutput,
      }
    }
  }

  validateInput(input: unknown): input is EmailInput {
    return emailInputSchema.safeParse(input).success
  }

  validateConfig(config: unknown): config is EmailConfig {
    return emailConfigSchema.safeParse(config).success
  }

  getInputSchema() {
    return emailInputSchema
  }

  getConfigSchema() {
    return emailConfigSchema
  }

  getDefaultConfig(): EmailConfig {
    return {
      from_email: "no-reply@xyne.io",
      content_type: "html",
    }
  }
}