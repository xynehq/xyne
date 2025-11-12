import { SESClient, SendEmailCommand, SendRawEmailCommand } from "@aws-sdk/client-ses"
import { readFile } from "node:fs/promises"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server)

interface EmailOptions {
  to: string
  subject: string
  body: string
  contentType?: "text" | "html"
  attachments?: Array<{
    filename: string
    path: string
    contentType?: string
  }>
}

class SimpleEmailService {
  private sesClient: SESClient | null = null
  private fromEmail: string = process.env.SES_FROM_EMAIL || "noreply@xyne.io"

  constructor() {
    Logger.info("📧 Initializing Email Service...")

    if (process.env.SES_AWS_ACCESS_KEY_ID && process.env.SES_AWS_SECRET_ACCESS_KEY) {
      try {
        this.sesClient = new SESClient({
          region: process.env.SES_AWS_REGION || "us-east-1",
          credentials: {
            accessKeyId: process.env.SES_AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.SES_AWS_SECRET_ACCESS_KEY,
          },
        })
        this.fromEmail = process.env.SES_FROM_EMAIL || "noreply@xyne.io"
        Logger.info("✅ Email service initialized with AWS credentials")
      } catch (error) {
        Logger.error("❌ Failed to initialize SES client:", {
          error: (error as Error).message,
        })
        this.sesClient = null
      }
    } else {
      Logger.info("⚠️  Email service disabled - no AWS credentials provided")
    }
  }

  async sendEmail({
    to,
    subject,
    body,
    contentType = "text",
    attachments = [],
  }: EmailOptions): Promise<boolean> {
    Logger.info(`📤 Attempting to send email to: ${to} (${contentType})${attachments.length > 0 ? ` with ${attachments.length} attachments` : ''}`)

    if (!this.sesClient) {
      Logger.info("⚠️  Email service not configured, skipping email")
      return false
    }

    try {
      // If no attachments, use simple email
      if (attachments.length === 0) {
        // Build email body based on content type
        const emailBody =
          contentType === "html"
            ? { Html: { Data: body } }
            : { Text: { Data: body } }

        const command = new SendEmailCommand({
          Source: this.fromEmail,
          Destination: { ToAddresses: [to] },
          Message: {
            Subject: { Data: subject },
            Body: emailBody,
          },
        })

        Logger.info("📡 Sending simple email via SES...", {
          to,
          subject,
          from: this.fromEmail,
        })
        const result = await this.sesClient.send(command)
        Logger.info("✅ Email sent successfully", {
          messageId: result.MessageId,
          to,
        })
        return true
      } else {
        // Use raw email for attachments
        const rawEmail = await this.buildRawEmail({
          to,
          subject,
          body,
          contentType,
          attachments,
        })

        const command = new SendRawEmailCommand({
          Source: this.fromEmail,
          Destinations: [to],
          RawMessage: {
            Data: new TextEncoder().encode(rawEmail),
          },
        })

        Logger.info("📡 Sending raw email with attachments via SES...", {
          to,
          subject,
          from: this.fromEmail,
          attachmentCount: attachments.length,
        })
        const result = await this.sesClient.send(command)
        Logger.info("✅ Email with attachments sent successfully", {
          messageId: result.MessageId,
          to,
          attachmentCount: attachments.length,
        })
        return true
      }
    } catch (error) {
      const err = error as any
      Logger.error("❌ Failed to send email:", {
        message: err.message,
        name: err.name,
        code: err.Code || err.code || err.$metadata?.httpStatusCode,
        requestId: err.$metadata?.requestId,
        to,
        attachmentCount: attachments.length,
      })

      return false
    }
  }

  private async buildRawEmail({
    to,
    subject,
    body,
    contentType,
    attachments,
  }: {
    to: string
    subject: string
    body: string
    contentType: "text" | "html"
    attachments: Array<{
      filename: string
      path: string
      contentType?: string
    }>
  }): Promise<string> {
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36)}`
    
    let rawEmail = `From: ${this.fromEmail}\r\n`
    rawEmail += `To: ${to}\r\n`
    rawEmail += `Subject: ${subject}\r\n`
    rawEmail += `MIME-Version: 1.0\r\n`
    rawEmail += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n`
    rawEmail += `\r\n`
    
    // Add message body
    rawEmail += `--${boundary}\r\n`
    rawEmail += `Content-Type: ${contentType === "html" ? "text/html" : "text/plain"}; charset=UTF-8\r\n`
    rawEmail += `Content-Transfer-Encoding: 8bit\r\n`
    rawEmail += `\r\n`
    rawEmail += `${body}\r\n`
    rawEmail += `\r\n`
    
    // Add attachments
    for (const attachment of attachments) {
      try {
        const fileBuffer = await readFile(attachment.path)
        const base64Content = fileBuffer.toString('base64')
        const contentType = attachment.contentType || 'application/octet-stream'
        
        rawEmail += `--${boundary}\r\n`
        rawEmail += `Content-Type: ${contentType}\r\n`
        rawEmail += `Content-Transfer-Encoding: base64\r\n`
        rawEmail += `Content-Disposition: attachment; filename="${attachment.filename}"\r\n`
        rawEmail += `\r\n`
        
        // Split base64 into 76-character lines
        const lines = base64Content.match(/.{1,76}/g) || []
        rawEmail += lines.join('\r\n') + '\r\n'
        rawEmail += `\r\n`
        
        Logger.info(`📎 Added attachment: ${attachment.filename} (${fileBuffer.length} bytes)`)
      } catch (error) {
        Logger.error(`❌ Failed to read attachment file: ${attachment.path}`, error)
        throw new Error(`Could not read attachment file: ${attachment.filename}`)
      }
    }
    
    rawEmail += `--${boundary}--\r\n`
    
    return rawEmail
  }

  // Simple welcome email
  async sendWelcomeEmail(
    userEmail: string,
    userName: string,
  ): Promise<boolean> {
    Logger.info(`🎉 Sending welcome email to ${userEmail} for user ${userName}`)

    return this.sendEmail({
      to: userEmail,
      subject: "Welcome to Xyne!",
      body: `Hi ${userName},\n\nWelcome to Xyne! Your account is ready.\n\nBest regards,\nThe Xyne Team`,
    })
  }
}

export const emailService = new SimpleEmailService()
