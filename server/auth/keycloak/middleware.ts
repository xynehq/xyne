import type { Context, Next } from "hono"
import { verify } from "hono/jwt"
import { getCookie } from "hono/cookie"
import { getKeycloakConfig } from "./config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { db } from "@/db/client"
import { createUser, getUserByEmail } from "@/db/user"
import { UserRole } from "@/shared/types"

const Logger = getLogger(Subsystem.Server)
const { JwtPayloadKey } = config
const userSecret = process.env.USER_SECRET!
const keycloakConfig = getKeycloakConfig()

export interface AuthContext {
  sub: string
  role: string
  workspaceId: string
  source: "xyne" | "keycloak" | "api-key"
  exp: number
  user?: any
}

// Enhanced JWT middleware that supports both Xyne and Keycloak tokens, plus API keys
export const enhancedJwtMiddleware = () => {
  return async (c: Context, next: Next) => {
    try {
      let token: string | undefined

      // Check for token in different places
      const authHeader = c.req.header("Authorization")
      const apiKeyHeader = c.req.header("x-api-key")
      const cookieToken = getCookie(c, "auth-token") || getCookie(c, "access-token")

      if (authHeader?.startsWith("Bearer ")) {
        token = authHeader.substring(7)
      } else if (apiKeyHeader) {
        // Handle API key authentication
        const apiKeyValid = await validateApiKey(apiKeyHeader)
        if (apiKeyValid) {
          const serviceAuthContext: AuthContext = {
            sub: "service-account",
            role: "Service",
            workspaceId: "service",
            source: "api-key",
            exp: Math.floor(Date.now() / 1000) + 3600,
          }

          c.set(JwtPayloadKey, serviceAuthContext)
          c.set("authContext", serviceAuthContext)
          c.set("authMethod", "api-key")

          await next()
          return
        } else {
          Logger.warn("Invalid API key provided")
          return c.json({ error: "Invalid API key" }, 401)
        }
      } else if (cookieToken) {
        token = cookieToken
      }

      if (!token) {
        Logger.warn("No authentication token provided")
        return c.json({ error: "Unauthorized" }, 401)
      }

      // Try to determine token type and validate accordingly
      const authContext = await validateToken(token)

      if (!authContext) {
        Logger.warn("Invalid or expired token")
        return c.json({ error: "Invalid token" }, 401)
      }

      // Set auth context for downstream handlers
      c.set(JwtPayloadKey, authContext)
      c.set("authContext", authContext)
      c.set("authMethod", authContext.source)

      // Set user context if available (for Keycloak tokens)
      if (authContext.user) {
        c.set("user", authContext.user)
      }

      await next()
    } catch (error) {
      Logger.error("Authentication middleware error:", error)
      return c.json({ error: "Authentication failed" }, 401)
    }
  }
}

// Validate token from either Xyne or Keycloak
async function validateToken(token: string): Promise<AuthContext | null> {
  const currentKeycloakConfig = getKeycloakConfig()

  // Try Keycloak validation first if enabled
  Logger.info("Keycloak config:", {
    enabled: currentKeycloakConfig.enabled,
    baseUrl: currentKeycloakConfig.baseUrl,
    realm: currentKeycloakConfig.defaultRealm,
  })

  if (currentKeycloakConfig.enabled) {
    Logger.info("Attempting Keycloak token validation")
    const keycloakResult = await validateKeycloakToken(token)
    if (keycloakResult) {
      return keycloakResult
    }
    Logger.info("Keycloak validation failed, trying Xyne validation")
  } else {
    Logger.info("Keycloak is disabled, using Xyne validation only")
  }

  // Fallback to Xyne JWT validation
  const xyneResult = await validateXyneToken(token)
  return xyneResult
}

// Validate Keycloak JWT token
async function validateKeycloakToken(
  token: string,
): Promise<AuthContext | null> {
  try {
    // Decode JWT payload first
    const parts = token.split(".")
    if (parts.length !== 3) {
      return null
    }

    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString())

    // Check expiration
    if (payload.exp < Date.now() / 1000) {
      Logger.warn("Keycloak token expired")
      return null
    }

    // Check if this is a Keycloak token by looking at issuer
    if (!payload.iss || !payload.iss.includes(keycloakConfig.baseUrl)) {
      return null
    }

    Logger.info("Processing Keycloak token for user:", payload.email)

    // Extract roles from Keycloak token
    const realmRoles = payload.realm_access?.roles || []
    const resourceRoles = payload.resource_access?.["oa-backend"]?.roles || []
    const allRoles = [...realmRoles, ...resourceRoles]

    // Determine primary role (prioritize oa-backend manager, then admin, then user)
    let primaryRole = UserRole.User
    const oaBackendRoles = payload.resource_access?.["oa-backend"]?.roles || []

    if (
      oaBackendRoles.includes("manager") ||
      oaBackendRoles.includes("Manager")
    ) {
      primaryRole = UserRole.Admin // Map manager to admin for XYNE
    } else if (allRoles.includes("admin") || allRoles.includes("Admin")) {
      primaryRole = UserRole.Admin
    }

    // Auto-create user in database if they don't exist
    const userEmail = payload.email
    const userName = payload.name || payload.preferred_username || "User"

    try {
      // Check if user exists in database
      const existingUsers = await getUserByEmail(db, userEmail)

      if (!existingUsers || existingUsers.length === 0) {
        // Create user with default values - XYNE doesn't have projects like DPIP
        await createUser(
          db,
          1, // Default workspace ID (juspay.in)
          userEmail,
          userName,
          "", // No photo link from Keycloak by default
          primaryRole,
          "wkh5nwq7o0es10kpcgg8lu9o", // juspay.in workspace external ID
          undefined, // No password for Keycloak users
        )
      }
    } catch (dbError) {
      Logger.error("Error creating/checking user in database:", dbError)
      // Continue with authentication even if DB operation fails
    }

    // Get the actual workspace external ID from the database
    let workspaceExternalId = "wkh5nwq7o0es10kpcgg8lu9o" // Default to juspay.in workspace
    
    try {
      const existingUsers = await getUserByEmail(db, userEmail)
      if (existingUsers && existingUsers.length > 0) {
        workspaceExternalId = existingUsers[0].workspaceExternalId
      }
    } catch (error) {
      Logger.error("Error getting workspace external ID:", error)
    }

    // Create auth context with role information
    const authContext: AuthContext = {
      sub: userEmail,
      role: primaryRole,
      workspaceId: workspaceExternalId,
      source: "keycloak",
      exp: payload.exp,
      user: {
        email: userEmail,
        name: userName,
        role: primaryRole,
        workspace_external_id: workspaceExternalId,
        keycloak_roles: allRoles, // Include all Keycloak roles for reference
      },
    }

    return authContext
  } catch (error) {
    Logger.error("Keycloak token validation failed:", error)
    return null
  }
}

// Validate Xyne JWT token (existing logic)
async function validateXyneToken(token: string): Promise<AuthContext | null> {
  try {
    const payload = await verify(token, userSecret)

    // Check required fields
    if (!payload.sub || !payload.role || !payload.workspaceId) {
      Logger.warn("Invalid Xyne token payload")
      return null
    }

    // Check expiration
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      Logger.warn("Xyne token expired")
      return null
    }

    return {
      sub: payload.sub as string,
      role: payload.role as string,
      workspaceId: payload.workspaceId as string,
      source: "xyne",
      exp: payload.exp as number,
    }
  } catch (error) {
    Logger.debug("Token is not a valid Xyne token:", error)
    return null
  }
}

// API key validation - validates JWT-based API keys
async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    // First check environment-based static API keys
    const validApiKeys = process.env.VALID_API_KEYS?.split(",") || []
    if (validApiKeys.includes(apiKey)) {
      return true
    }

    // Then validate JWT-based API keys (generated by /generate-api-key)
    try {
      const payload = await verify(apiKey, userSecret)

      // Check if it's marked as an API key
      if (payload.type === "api_key") {
        Logger.info("Valid JWT API key authenticated")
        return true
      }

      Logger.warn("JWT token is not marked as API key")
      return false
    } catch (jwtError) {
      Logger.warn("JWT API key validation failed:", jwtError)
      return false
    }
  } catch (error) {
    Logger.error("API key validation error:", error)
    return false
  }
}