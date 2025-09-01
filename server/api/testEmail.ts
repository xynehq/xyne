import { Context } from "hono"
import { emailService } from "@/services/emailService"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server)



export const TestEmailApi = async (c: Context) => {
    try {
        Logger.info("Testing email sending...")
        

        console.log("🔍 Environment variables debug:")
        console.log("AWS_ACCESS_KEY_ID:", process.env.AWS_ACCESS_KEY_ID?.substring(0, 8) + '...')
        console.log("AWS_SECRET_ACCESS_KEY:", process.env.AWS_SECRET_ACCESS_KEY ? 'SET' : 'NOT SET')
        console.log("AWS_REGION:", process.env.AWS_REGION)
        console.log("SES_FROM_EMAIL:", process.env.SES_FROM_EMAIL)
        
        const { email, name } = await c.req.json()

        if (!email) {
            return c.json({ error: "Email is required" }, 400)
        }

        const success = await emailService.sendWelcomeEmail(email, name || "User")

        if (success) {
            return c.json({ message: "Test email sent successfully" })
        } else {
            return c.json({ message: "Email service not configured or failed" }, 200)
        }
    } catch (error) {
        Logger.error("Error in TestEmailApi", { error: (error as Error).message })
        return c.json({ error: "Failed to send email" }, 500)
    }
}