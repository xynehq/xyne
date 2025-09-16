import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server)

interface EmailOptions {
  to: string
  subject: string
  body: string
  contentType?: "text" | "html"
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
  }: EmailOptions): Promise<boolean> {
    Logger.info(`📤 Attempting to send email to: ${to} (${contentType})`)

    if (!this.sesClient) {
      Logger.info("⚠️  Email service not configured, skipping email")
      return false
    }

    try {
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

      Logger.info("📡 Sending email via SES...", {
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
    } catch (error) {
      const err = error as any
      Logger.error("❌ Failed to send email:", {
        message: err.message,
        name: err.name,
        code: err.Code || err.code || err.$metadata?.httpStatusCode,
        requestId: err.$metadata?.requestId,
        to,
      })

      // Log error details separately to avoid truncation
      //   console.error("🔍 AWS SES Error Details:")
      //   console.error("Error Message:", err.message)
      //   console.error("Error Name:", err.name)
      //   console.error("Error Code:", err.Code || err.code)
      //   console.error("HTTP Status:", err.$metadata?.httpStatusCode)
      //   console.error("Request ID:", err.$metadata?.requestId)
      //   console.error("Region:", process.env.SES_AWS_REGION)
      //   console.error("From Email:", this.fromEmail)
      //   console.error("To Email:", to)
      //   console.error("Full Error Object:", err)

      return false
    }
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
