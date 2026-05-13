import { type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { db } from "@/db/client"
import { apiKeys, users, providerConfigs } from "@/db/schema"
import { getUserByEmail, createUserApiKey } from "@/db/user"
import {
  getProviderConfigByWorkspaceExternalId,
  updateProviderConfig,
} from "@/db/providerConfig"
import { eq, and } from "drizzle-orm"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { DeleteDocument } from "@/search/vespa"
import { KbItemsSchema } from "@xyne/vespa-ts/types"
import { resolveWorkspaceCreator } from "@/api/provider/collections"

const Logger = getLogger(Subsystem.Server)

/**
 * GET /api/provider/manage/me
 * Returns current provider user info + workspace + config.
 */
export const ProviderMeApi = async (c: Context) => {
  const payload = c.get("jwtPayload")
  const email = payload.sub as string
  const workspaceId = payload.workspaceId as string

  const userRes = await getUserByEmail(db, email)
  if (!userRes.length) {
    throw new HTTPException(404, { message: "User not found" })
  }

  const user = userRes[0]
  const providerConfig = await getProviderConfigByWorkspaceExternalId(
    db,
    workspaceId,
  )

  return c.json({
    user: {
      email: user.email,
      name: user.name,
      role: user.role,
    },
    workspace_id: workspaceId,
    config: providerConfig
      ? {
          token_expiry_seconds: providerConfig.tokenExpirySeconds,
          allowed_origins: providerConfig.allowedOrigins,
          enabled: providerConfig.enabled,
        }
      : null,
  })
}

/**
 * GET /api/provider/manage/config
 * Returns provider configuration.
 */
export const GetProviderConfigApi = async (c: Context) => {
  const payload = c.get("jwtPayload")
  const workspaceId = payload.workspaceId as string

  const providerConfig = await getProviderConfigByWorkspaceExternalId(
    db,
    workspaceId,
  )

  if (!providerConfig) {
    throw new HTTPException(404, { message: "Provider config not found" })
  }

  return c.json({
    token_expiry_seconds: providerConfig.tokenExpirySeconds,
    allowed_origins: providerConfig.allowedOrigins,
    enabled: providerConfig.enabled,
  })
}

/**
 * PUT /api/provider/manage/config
 * Updates provider configuration (allowed_origins, token_expiry_seconds).
 */
export const UpdateProviderConfigApi = async (c: Context) => {
  const payload = c.get("jwtPayload")
  const workspaceId = payload.workspaceId as string
  const body = c.req.valid("json" as never) as {
    allowed_origins?: string[]
    token_expiry_seconds?: number
  }

  const updates: Parameters<typeof updateProviderConfig>[2] = {}
  if (body.allowed_origins !== undefined) {
    updates.allowedOrigins = body.allowed_origins
  }
  if (body.token_expiry_seconds !== undefined) {
    updates.tokenExpirySeconds = body.token_expiry_seconds
  }

  const updated = await updateProviderConfig(db, workspaceId, updates)

  return c.json({
    token_expiry_seconds: updated.tokenExpirySeconds,
    allowed_origins: updated.allowedOrigins,
    enabled: updated.enabled,
  })
}

/**
 * GET /api/provider/manage/documents
 * Lists documents uploaded by this provider (queries Vespa by workspace metadata).
 */
export const ListProviderDocumentsApi = async (c: Context) => {
  const payload = c.get("jwtPayload")
  const workspaceId = payload.workspaceId as string
  const createdBy = await resolveWorkspaceCreator(workspaceId)

  const yql = `select * from kb_items where createdBy contains "${createdBy}"`

  const response = await fetch(
    `${config.vespaEndpoint.queryEndpoint}/search/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        yql,
        hits: 100,
        offset: 0,
        "presentation.summary": "default",
      }),
    },
  )

  if (!response.ok) {
    Logger.error(
      { status: response.status },
      "Vespa query failed for provider documents list",
    )
    return c.json({ documents: [] })
  }

  const vespaResult = (await response.json()) as {
    root?: {
      children?: Array<{
        fields?: Record<string, unknown>
      }>
    }
  }

  const documents =
    vespaResult.root?.children?.map((hit) => ({
      docId: hit.fields?.docId as string,
      title: hit.fields?.fileName as string,
      visibility: (hit.fields?.visibility as string) ?? "public",
      accessTags: ((hit.fields?.access_tags as string[]) ?? []).filter(
        (t) => t !== "__all_authenticated__",
      ),
      createdAt: hit.fields?.createdAt as number,
      collectionId: hit.fields?.clId as string,
    })) ?? []

  return c.json({ documents })
}

/**
 * DELETE /api/provider/manage/documents/:docId
 * Deletes a specific document from Vespa.
 */
export const DeleteProviderDocumentApi = async (c: Context) => {
  const docId = c.req.param("docId")

  try {
    await DeleteDocument(docId, KbItemsSchema)
  } catch (error) {
    Logger.error(
      { error, docId },
      "Failed to delete provider document from Vespa",
    )
    throw new HTTPException(500, { message: "Failed to delete document" })
  }

  return c.json({ success: true, docId })
}

/**
 * GET /api/provider/manage/documents (API key auth)
 * Lists documents uploaded by this provider (queries Vespa by workspace metadata).
 */
export const ListProviderDocumentsByApiKeyApi = async (c: Context) => {
  const workspaceId = c.get("workspaceId") as string
  const createdBy = await resolveWorkspaceCreator(workspaceId)

  const yql = `select * from kb_items where createdBy contains "${createdBy}"`

  const response = await fetch(
    `${config.vespaEndpoint.queryEndpoint}/search/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        yql,
        hits: 100,
        offset: 0,
        "presentation.summary": "default",
      }),
    },
  )

  if (!response.ok) {
    Logger.error(
      { status: response.status },
      "Vespa query failed for provider documents list",
    )
    return c.json({ documents: [] })
  }

  const vespaResult = (await response.json()) as {
    root?: {
      children?: Array<{
        fields?: Record<string, unknown>
      }>
    }
  }

  const documents =
    vespaResult.root?.children?.map((hit) => ({
      docId: hit.fields?.docId as string,
      title: hit.fields?.fileName as string,
      visibility: (hit.fields?.visibility as string) ?? "public",
      accessTags: ((hit.fields?.access_tags as string[]) ?? []).filter(
        (t) => t !== "__all_authenticated__",
      ),
      createdAt: hit.fields?.createdAt as number,
      collectionId: hit.fields?.clId as string,
    })) ?? []

  return c.json({ documents })
}

/**
 * DELETE /api/provider/manage/documents/:docId (API key auth)
 * Deletes a specific document from Vespa.
 */
export const DeleteProviderDocumentByApiKeyApi = async (c: Context) => {
  const docId = c.req.param("docId")

  try {
    await DeleteDocument(docId, KbItemsSchema)
  } catch (error) {
    Logger.error(
      { error, docId },
      "Failed to delete provider document from Vespa",
    )
    throw new HTTPException(500, { message: "Failed to delete document" })
  }

  return c.json({ success: true, docId })
}

/**
 * GET /api/provider/manage/api-keys
 * Lists API keys for the provider user.
 */
export const ListProviderApiKeysApi = async (c: Context) => {
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
 * POST /api/provider/manage/api-keys
 * Creates a new API key for the provider.
 */
export const CreateProviderApiKeyApi = async (c: Context) => {
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
    name: "Provider API Key",
    scope: { scopes: ["provider"] },
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
 * DELETE /api/provider/manage/api-keys/:id
 * Revokes an API key.
 */
export const DeleteProviderApiKeyApi = async (c: Context) => {
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
