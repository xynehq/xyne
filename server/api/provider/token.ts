import { type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { sign } from "hono/jwt"
import { db } from "@/db/client"
import { getProviderConfigByWorkspaceExternalId } from "@/db/providerConfig"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server)

export const IssueProviderTokenApi = async (c: Context) => {
  const { external_user_id, email, tags } = c.req.valid("json" as never)
  const workspaceId = c.get("workspaceId") as string

  try {
    // Look up provider config for this workspace
    const providerConfig = await getProviderConfigByWorkspaceExternalId(
      db,
      workspaceId,
    )

    if (!providerConfig || !providerConfig.enabled) {
      throw new HTTPException(404, {
        message: "This workspace is not configured as a provider",
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
    const expiresAt = now + providerConfig.tokenExpirySeconds

    // Sign JWT with provider's tokenSecret
    const payload = {
      iss: "xyne",
      sub: external_user_id as string,
      ...(email ? { email: email as string } : {}),
      authenticated: true,
      access_tags: uniqueTags,
      workspace_id: workspaceId,
      token_type: "provider",
      iat: now,
      exp: expiresAt,
    }

    const token = await sign(payload, providerConfig.tokenSecret!)

    return c.json({
      token,
      expires_at: expiresAt,
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Failed to issue provider token")
    throw new HTTPException(500, { message: "Failed to issue token" })
  }
}
