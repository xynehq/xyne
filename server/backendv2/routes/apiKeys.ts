// /v2/api-keys — list / create / revoke personal API keys.
//
// Backed by the v2-only `v2_api_keys` Postgres table. Keys created here can
// then auth any /v2/* request via `x-api-key` / `Authorization: Bearer …`
// / `?api_key=…`. This management surface itself is cookie-gated by
// `RequireCookie` in server.ts so a stolen key can't mint more keys —
// only a logged-in browser session can administer the key list.
//
// The full plaintext key is returned exactly once on POST; thereafter only
// the 4-char prefix is exposed. Storage is one-way scrypt via the
// `oneWayEncryption` column type on v2ApiKeys.key.

import * as crypto from "node:crypto"
import { and, eq, isNull, sql } from "drizzle-orm"
import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"

import { db } from "@/db/client"
import { v2ApiKeys } from "@/db/schema"
import { getUserByEmail } from "@/db/user"

type Vars = { jwtPayload: { sub: string; workspaceId: string } }

const router = new Hono<{ Variables: Vars }>()

const createSchema = z.object({
  name: z.string().trim().min(1, "name required").max(255),
  allowedAgents: z.array(z.string()).optional(),
})

type PublicApiKey = {
  id: string
  name: string
  /** Always masked. Format: `<prefix>****…` so the table can render it
   *  without ever holding the secret in client memory. */
  displayKey: string
  allowedAgents: string[]
  createdAt: string
}

const mask = (prefix: string): string => `${prefix}${"*".repeat(28)}`

const toPublic = (row: {
  id: number
  name: string
  keyPrefix: string
  config: unknown
  createdAt: Date
}): PublicApiKey => {
  const cfg = (row.config ?? {}) as { allowedAgents?: unknown }
  const allowedAgents = Array.isArray(cfg.allowedAgents)
    ? cfg.allowedAgents.filter((v): v is string => typeof v === "string")
    : []
  return {
    id: String(row.id),
    name: row.name,
    displayKey: mask(row.keyPrefix),
    allowedAgents,
    createdAt: row.createdAt.toISOString(),
  }
}

const resolveCaller = async (
  c: Context<{ Variables: Vars }>,
): Promise<{ userExternalId: string; workspaceId: string }> => {
  const p = c.get("jwtPayload")
  const rows = await getUserByEmail(db, p.sub)
  const user = rows[0]
  if (!user) {
    throw new HTTPException(404, { message: "User not found" })
  }
  return { userExternalId: user.externalId, workspaceId: p.workspaceId }
}

// GET /v2/api-keys
router.get("/", async (c) => {
  const { userExternalId, workspaceId } = await resolveCaller(c)
  const rows = await db
    .select({
      id: v2ApiKeys.id,
      name: v2ApiKeys.name,
      keyPrefix: v2ApiKeys.keyPrefix,
      config: v2ApiKeys.config,
      createdAt: v2ApiKeys.createdAt,
    })
    .from(v2ApiKeys)
    .where(
      and(
        eq(v2ApiKeys.userId, userExternalId),
        eq(v2ApiKeys.workspaceId, workspaceId),
        isNull(v2ApiKeys.deletedAt),
      ),
    )
    .orderBy(v2ApiKeys.createdAt)
  return c.json({ keys: rows.map(toPublic) })
})

// POST /v2/api-keys
router.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const payload = createSchema.parse(body)
  const { userExternalId, workspaceId } = await resolveCaller(c)

  // 32 hex chars — same shape v1's createUserApiKey generates so a key is
  // visually indistinguishable across surfaces.
  const plaintext = crypto.randomBytes(16).toString("hex")
  const keyPrefix = plaintext.substring(0, 4)
  const config = {
    allowedAgents: payload.allowedAgents ?? [],
  }

  const [inserted] = await db
    .insert(v2ApiKeys)
    .values({
      userId: userExternalId,
      workspaceId,
      name: payload.name,
      key: plaintext,
      keyPrefix,
      config,
    })
    .returning()

  if (!inserted) {
    throw new HTTPException(500, { message: "Failed to create API key" })
  }

  c.status(201)
  return c.json({
    // Full plaintext key — shown to the user once. Never persisted server
    // side beyond the scrypt hash in apiKeys.key.
    key: plaintext,
    apiKey: toPublic(inserted),
  })
})

// DELETE /v2/api-keys/:id
router.delete("/:id", async (c) => {
  const idRaw = c.req.param("id")
  const id = Number.parseInt(idRaw, 10)
  if (!Number.isFinite(id) || id <= 0) {
    throw new HTTPException(400, { message: "Invalid key id" })
  }
  const { userExternalId, workspaceId } = await resolveCaller(c)
  // Soft delete — preserves audit trail and allows the row to keep
  // satisfying any FK referrer; verifyApiKey filters `deletedAt IS NULL`
  // so the key stops authing immediately.
  const deleted = await db
    .update(v2ApiKeys)
    .set({ deletedAt: sql`NOW()`, updatedAt: sql`NOW()` })
    .where(
      and(
        eq(v2ApiKeys.id, id),
        eq(v2ApiKeys.userId, userExternalId),
        eq(v2ApiKeys.workspaceId, workspaceId),
        isNull(v2ApiKeys.deletedAt),
      ),
    )
    .returning({ id: v2ApiKeys.id })
  if (deleted.length === 0) {
    throw new HTTPException(404, { message: "API key not found" })
  }
  return c.json({ ok: true })
})

export default router
