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
