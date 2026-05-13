import { type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { sign } from "hono/jwt"
import { db } from "@/db/client"
import { getSdkConfigByWorkspaceExternalId } from "@/db/sdkConfig"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server)

export const IssueSdkTokenApi = async (c: Context) => {
  const { external_user_id, email, tags } = c.req.valid("json" as never)
  const workspaceId = c.get("workspaceId") as string

  try {
    // Look up SDK config for this workspace
    const sdkConfig = await getSdkConfigByWorkspaceExternalId(
      db,
      workspaceId,
    )

    if (!sdkConfig || !sdkConfig.enabled) {
      throw new HTTPException(404, {
        message: "This workspace is not configured for SDK access",
      })
    }

    // Build access_tags: only granular permission tags + user:<id>
    const accessTags = [
      `user:${external_user_id}`,
      ...(tags as string[]),
    ]

    // Remove duplicates
    const uniqueTags = [...new Set(accessTags)]

    const now = Math.floor(Date.now() / 1000)
    const expiresAt = now + sdkConfig.tokenExpirySeconds

    // Sign JWT with SDK's tokenSecret
    const payload = {
      iss: "xyne",
      sub: external_user_id as string,
      ...(email ? { email: email as string } : {}),
      authenticated: true,
      access_tags: uniqueTags,
      workspace_id: workspaceId,
      token_type: "sdk",
      iat: now,
      exp: expiresAt,
    }

    const token = await sign(payload, sdkConfig.tokenSecret!)

    return c.json({
      token,
      expires_at: expiresAt,
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Failed to issue SDK token")
    throw new HTTPException(500, { message: "Failed to issue token" })
  }
}
