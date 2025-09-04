// import { Google, type GoogleRefreshedTokens, type GoogleTokens } from "arctic";
import type { Context } from "hono"
import config from "@/config"
import { db } from "@/db/client"
import { getPublicUserAndWorkspaceByEmail } from "@/db/user"
import { type PublicUserWorkspace } from "@/db/schema"
import { sign } from "hono/jwt"
import { getCookie } from "hono/cookie"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const { JwtPayloadKey, agentWhiteList } = config
const Logger = getLogger(Subsystem.Server)
const userSecret = process.env.USER_SECRET!

export const GetUserWorkspaceInfo = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  const email = sub
  const userAndWorkspace: PublicUserWorkspace =
    await getPublicUserAndWorkspaceByEmail(db, workspaceId, email)
  
  // Get auth method and context from enhanced middleware
  const authMethod = c.get("authMethod") || "xyne"
  const authContext = c.get("authContext")
  
  // Base response
  const response: any = {
    ...userAndWorkspace,
    agentWhiteList: true,
    authMethod,
  }
  
  // Add Keycloak-specific information if authenticated via Keycloak
  if (authMethod === "keycloak" && authContext) {
    try {
      // Get the original Keycloak token to extract additional fields (same logic as enhanced middleware)
      const authHeader = c.req.header("Authorization")
      const cookieToken = getCookie(c, "auth-token") || getCookie(c, "access-token")
      
      let token = null
      if (authHeader?.startsWith("Bearer ")) {
        token = authHeader.substring(7)
      } else if (cookieToken) {
        token = cookieToken
      }
      
      if (token) {
        // Decode JWT payload to extract Keycloak fields
        const parts = token.split(".")
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], "base64").toString())
          
          // Add Keycloak-specific fields to user object
          if (response.user) {
            response.user = {
              ...response.user,
              email_verified: payload.email_verified || false,
              preferred_username: payload.preferred_username || payload.email,
              given_name: payload.given_name || "",
              family_name: payload.family_name || "",
              realm_access: payload.realm_access || { roles: [] },
              resource_access: payload.resource_access || {},
              scope: payload.scope || "",
            }
          }
        }
      }
    } catch (error) {
      Logger.error("Error extracting Keycloak token information:", error)
      // Continue without Keycloak fields if extraction fails
    }
  }
  
  return c.json(response)
}

export const GenerateApiKey = async (c: Context) => {
  try {
    // Check if USER_SECRET is provided
    if (!userSecret) {
      Logger.error("USER_SECRET environment variable is not provided")
      return c.json(
        {
          error: true,
          message: "User secret is not configured.",
        },
        500,
      )
    }

    // Get user info from JWT token (already authenticated)
    const payload = c.get("jwtPayload")
    const email = payload.sub as string
    const role = payload.role as string
    const workspaceId = payload.workspaceId as string

    // Get expiration days from query parameter
    // @ts-ignore
    const { expirationDays } = c.req.valid("query")

    Logger.info(
      `API Key generation request - Email: ${email}, ExpirationDays: ${expirationDays}`,
    )

    // Validate expiration days
    if (!expirationDays || expirationDays < 1 / 1440) {
      Logger.warn(`Invalid expiration days: ${expirationDays}`)
      return c.json(
        {
          error: true,
          message: "Invalid expiration time. Minimum is 1 minute",
        },
        400,
      )
    }

    if (expirationDays > 30) {
      Logger.warn(`Expiration days too long: ${expirationDays}`)
      return c.json(
        {
          error: true,
          message: "Maximum expiration time is 30 days",
        },
        400,
      )
    }

    const expirationSeconds = Math.floor(expirationDays * 24 * 60 * 60) // Convert days to seconds and round down

    // Generate API key with user-selected expiration
    const apiKeyPayload = {
      sub: email,
      role: role,
      workspaceId,
      type: "api_key", // Mark as API key for identification
      exp: Math.floor(Date.now() / 1000) + expirationSeconds,
    }

    const apiKey = await sign(apiKeyPayload, userSecret)

    Logger.info(
      `Generated API key for user: ${email} with ${expirationDays} days expiration (${expirationSeconds} seconds)`,
    )

    // Format expiration display text
    let expiresInText = ""
    if (expirationDays < 1) {
      const hours = Math.floor(expirationDays * 24)
      const minutes = Math.floor((expirationDays * 24 * 60) % 60)
      if (hours > 0) {
        expiresInText = `${hours} hour${hours !== 1 ? "s" : ""}${minutes > 0 ? ` ${minutes} minute${minutes !== 1 ? "s" : ""}` : ""}`
      } else {
        const totalMinutes = Math.floor(expirationDays * 24 * 60)
        expiresInText = `${totalMinutes} minute${totalMinutes !== 1 ? "s" : ""}`
      }
    } else if (expirationDays === 1) {
      expiresInText = "1 day"
    } else {
      expiresInText = `${Math.floor(expirationDays)} days`
    }

    return c.json({
      apiKey,
      expiresIn: expiresInText,
      expirationDays,
      instructions: "Use this API key in the x-api-key header for API requests",
    })
  } catch (error) {
    Logger.error("Error generating API key:", error)
    return c.json(
      {
        error: true,
        message: "Failed to generate API key",
      },
      500,
    )
  }
}
