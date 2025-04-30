import { sign } from "hono/jwt"
import { config } from "dotenv"
import path from "path"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

// Load environment variables from .env file at the root
config({ path: path.resolve(process.cwd(), ".env") })

const Logger = getLogger(Subsystem.Utils).child({
  script: "generate-auth-token",
})

const generateToken = async (
  email: string,
  role: string,
  workspaceId: string,
  jwtSecret: string,
): Promise<string> => {
  Logger.info(
    {
      tokenInfo: {
        // email: email, // Avoid logging PII
        role: role,
        workspaceId,
      },
    },
    "Generating token for the following details",
  )
  const payload = {
    sub: email,
    role: role,
    workspaceId,
    // Set expiration (e.g., 60 days like in server.ts)
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 60,
  }
  const jwtToken = await sign(payload, jwtSecret)
  return jwtToken
}

const run = async () => {
  const args = process.argv.slice(2) // Skip node and script path

  if (args.length !== 3) {
    console.error(
      "Usage: bun server/scripts/generate-auth-token.ts <email> <role> <workspaceExternalId>",
    )
    process.exit(1)
  }

  const [email, role, workspaceId] = args
  const jwtSecret = process.env.JWT_SECRET

  if (!jwtSecret) {
    Logger.error(
      "JWT_SECRET environment variable is not set. Please ensure it's available in your .env file.",
    )
    process.exit(1)
  }

  if (!email || !role || !workspaceId) {
    Logger.error("Email, role, and workspaceExternalId are required arguments.")
    console.error(
      "Usage: bun server/scripts/generate-auth-token.ts <email> <role> <workspaceExternalId>",
    )
    process.exit(1)
  }

  try {
    const token = await generateToken(email, role, workspaceId, jwtSecret)
    console.log("\nGenerated auth-token value:")
    console.log("------------------------------------")
    console.log(token)
    console.log("------------------------------------")
    console.log("\nSet this value in a cookie named 'auth-token'.")
    process.exit(0)
  } catch (error) {
    Logger.error(`Error generating token: ${error}`)
    process.exit(1)
  }
}

run()
