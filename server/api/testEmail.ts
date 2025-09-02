import { type Context } from "hono"
import { emailService } from "@/services/emailService"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server)

export const TestEmailApi = async (c: Context) => {
  try {
    Logger.info("Testing email sending...")

   if (process.env.NODE_ENV !== "production") {
        Logger.debug("SES env debug", {
          awsAccessKeyIdPrefix: process.env.AWS_ACCESS_KEY_ID?.slice(0, 4) ?? "unset",
          awsRegion: process.env.AWS_REGION ?? "unset",
          sesFromEmail: process.env.SES_FROM_EMAIL ?? "unset",
        })
      }
    const { email, name } = await c.req.json()

    if (!email) {
      return c.json({ error: "Email is required" }, 400)
    }

    const success = await emailService.sendWelcomeEmail(email, name || "User")

    if (success) {
      return c.json({ message: "Test email sent successfully" })
    } else {
      return c.json({ message: "Email service not configured or failed" }, 503)
    }
  } catch (error) {
    Logger.error("Error in TestEmailApi", { error: (error as Error).message })
    return c.json({ error: "Failed to send email" }, 500)
  }
}
