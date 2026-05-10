import { type Context, type Next } from "hono"
import { HTTPException } from "hono/http-exception"
import { verify, decode } from "hono/jwt"
import { db } from "@/db/client"
import { getProviderConfigByWorkspaceExternalId } from "@/db/providerConfig"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server)

export const ProviderTokenMiddleware = async (c: Context, next: Next) => {
  const authHeader = c.req.header("Authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    throw new HTTPException(401, { message: "Missing Bearer token" })
  }
  const token = authHeader.slice(7)

  try {
    // 1. Decode without verifying to get workspace_id
    const { payload: decoded } = decode(token)
    const workspaceId = decoded.workspace_id as string

    if (!workspaceId || decoded.token_type !== "provider") {
      throw new HTTPException(401, { message: "Invalid token" })
    }

    // 2. Look up providerConfig → get tokenSecret
    const config = await getProviderConfigByWorkspaceExternalId(db, workspaceId)
    if (!config || !config.enabled) {
      throw new HTTPException(401, { message: "Invalid token" })
    }

    // 3. Verify JWT signature with this workspace's tokenSecret
    const payload = await verify(token, config.tokenSecret!)

    // 4. Set on context
    c.set("workspaceId", payload.workspace_id as string)
    c.set("accessTags", payload.access_tags as string[])
    c.set("providerSub", payload.sub as string)
    c.set("providerEmail", payload.email as string | undefined)

    await next()
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Provider token validation failed")
    throw new HTTPException(401, { message: "Invalid or expired token" })
  }
}

export const ProviderCorsMiddleware = async (c: Context, next: Next) => {
  const origin = c.req.header("Origin")
  if (!origin) {
    await next()
    return
  }

  const workspaceId = c.get("workspaceId") as string | undefined
  if (!workspaceId) {
    await next()
    return
  }

  const config = await getProviderConfigByWorkspaceExternalId(db, workspaceId)
  if (config?.allowedOrigins?.includes(origin)) {
    c.header("Access-Control-Allow-Origin", origin)
    c.header("Access-Control-Allow-Headers", "Authorization, Content-Type")
    c.header("Access-Control-Allow-Methods", "POST, OPTIONS")
    c.header("Access-Control-Allow-Credentials", "true")
  }

  await next()
}
