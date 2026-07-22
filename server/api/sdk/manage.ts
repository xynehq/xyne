import { type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { db } from "@/db/client"
import { apiKeys, users, sdkConfigs } from "@/db/schema"
import { getUserByEmail, createUserApiKey } from "@/db/user"
import {
  getSdkConfigByWorkspaceExternalId,
  updateSdkConfig,
} from "@/db/sdkConfig"
import type { SpacesConfig } from "@/db/schema/sdkConfigs"
import { eq, and } from "drizzle-orm"

/**
 * GET /api/sdk/manage/me
 * Returns current SDK user info + workspace + config.
 */
export const SdkMeApi = async (c: Context) => {
  const payload = c.get("jwtPayload")
  const email = payload.sub as string
  const workspaceId = payload.workspaceId as string

  const userRes = await getUserByEmail(db, email)
  if (!userRes.length) {
    throw new HTTPException(404, { message: "User not found" })
  }

  const user = userRes[0]
  const sdkConfig = await getSdkConfigByWorkspaceExternalId(db, workspaceId)

  return c.json({
    user: {
      email: user.email,
      name: user.name,
      role: user.role,
    },
    workspace_id: workspaceId,
    config: sdkConfig
      ? {
          token_expiry_seconds: sdkConfig.tokenExpirySeconds,
          allowed_origins: sdkConfig.allowedOrigins,
          enabled: sdkConfig.enabled,
          spaces_config: sdkConfig.spacesConfig,
        }
      : null,
  })
}

/**
 * GET /api/sdk/manage/config
 * Returns SDK configuration.
 */
export const GetSdkConfigApi = async (c: Context) => {
  const payload = c.get("jwtPayload")
  const workspaceId = payload.workspaceId as string

  const sdkConfig = await getSdkConfigByWorkspaceExternalId(db, workspaceId)

  if (!sdkConfig) {
    throw new HTTPException(404, { message: "SDK config not found" })
  }

  return c.json({
    token_expiry_seconds: sdkConfig.tokenExpirySeconds,
    allowed_origins: sdkConfig.allowedOrigins,
    enabled: sdkConfig.enabled,
    spaces_config: sdkConfig.spacesConfig,
  })
}

/**
 * PUT /api/sdk/manage/config
 * Updates SDK configuration (allowed_origins, token_expiry_seconds, spaces_config).
 */
export const UpdateSdkConfigApi = async (c: Context) => {
  const payload = c.get("jwtPayload")
  const workspaceId = payload.workspaceId as string
  const body = c.req.valid("json" as never) as {
    allowed_origins?: string[]
    token_expiry_seconds?: number
    spaces_config?: SpacesConfig
  }

  const updates: Parameters<typeof updateSdkConfig>[2] = {}
  if (body.allowed_origins !== undefined) {
    updates.allowedOrigins = body.allowed_origins
  }
  if (body.token_expiry_seconds !== undefined) {
    updates.tokenExpirySeconds = body.token_expiry_seconds
  }
  if (body.spaces_config !== undefined) {
    updates.spacesConfig = body.spaces_config
  }

  const updated = await updateSdkConfig(db, workspaceId, updates)

  return c.json({
    token_expiry_seconds: updated.tokenExpirySeconds,
    allowed_origins: updated.allowedOrigins,
    enabled: updated.enabled,
    spaces_config: updated.spacesConfig,
  })
}

/**
 * GET /api/sdk/manage/api-keys
 * Lists API keys for the SDK user.
 */
export const ListSdkApiKeysApi = async (c: Context) => {
  const payload = c.get("jwtPayload")
  const email = payload.sub as string
  const workspaceId = payload.workspaceId as string

  const userRes = await getUserByEmail(db, email)
  if (!userRes.length) {
    throw new HTTPException(404, { message: "User not found" })
  }

  const user = userRes[0]

  const keys = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, user.externalId),
        eq(apiKeys.workspaceId, workspaceId),
      ),
    )
    .orderBy(apiKeys.createdAt)

  const formattedKeys = keys.map((key) => ({
    id: key.id.toString(),
    name: key.name,
    key_prefix: key.keyPrefix,
    created_at: key.createdAt.toISOString(),
  }))

  return c.json({ api_keys: formattedKeys })
}

/**
 * POST /api/sdk/manage/api-keys
 * Creates a new API key for the SDK user.
 */
export const CreateSdkApiKeyApi = async (c: Context) => {
  const payload = c.get("jwtPayload")
  const email = payload.sub as string
  const workspaceId = payload.workspaceId as string

  const userRes = await getUserByEmail(db, email)
  if (!userRes.length) {
    throw new HTTPException(404, { message: "User not found" })
  }

  const user = userRes[0]

  const result = await createUserApiKey({
    db,
    userId: user.externalId,
    workspaceId,
    name: "SDK API Key",
    scope: { scopes: ["sdk"] },
  })

  if (!result.success) {
    throw new HTTPException(500, { message: "Failed to create API key" })
  }

  return c.json({
    api_key: result.key,
    id: result.apiKey?.id,
    name: result.apiKey?.name,
    created_at: result.apiKey?.createdAt,
  })
}

/**
 * DELETE /api/sdk/manage/api-keys/:id
 * Revokes an API key.
 */
export const DeleteSdkApiKeyApi = async (c: Context) => {
  const keyId = c.req.param("id")
  const payload = c.get("jwtPayload")
  const email = payload.sub as string
  const workspaceId = payload.workspaceId as string

  const userRes = await getUserByEmail(db, email)
  if (!userRes.length) {
    throw new HTTPException(404, { message: "User not found" })
  }

  const user = userRes[0]

  const deleted = await db
    .delete(apiKeys)
    .where(
      and(
        eq(apiKeys.id, parseInt(keyId)),
        eq(apiKeys.userId, user.externalId),
        eq(apiKeys.workspaceId, workspaceId),
      ),
    )
    .returning()

  if (!deleted.length) {
    throw new HTTPException(404, { message: "API key not found" })
  }

  return c.json({ success: true })
}
