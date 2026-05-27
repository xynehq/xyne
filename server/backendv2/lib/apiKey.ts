// Verifies an inbound API key against the v2-only `v2_api_keys` Postgres
// table. Returns a synthesised JwtPayload so downstream /v2/* routers run
// with the owning user's identity exactly as if the request had come through
// the cookie-based AuthMiddleware.
//
// `v2ApiKeys.key` is stored via the `oneWayEncryption` custom type, which
// hashes inputs with a fixed-salt scrypt on write. The same hash runs on the
// parameter side of `eq()` queries, so equality lookups against the
// plaintext value work without us doing any hashing here.

import { and, eq, isNull, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { users, v2ApiKeys } from "@/db/schema"
import type { JwtPayload } from "./tokens"

export type ApiKeyContext = {
  jwtPayload: JwtPayload
  /** Optional agent allowlist from the key's stored config. Empty/absent
   *  means the key can hit any agent the owning user can reach. */
  allowedAgents: string[]
}

export const verifyApiKey = async (
  rawKey: string,
): Promise<ApiKeyContext | null> => {
  const trimmed = rawKey.trim()
  if (!trimmed) {
    return null
  }
  const rows = await db
    .select({
      id: v2ApiKeys.id,
      userId: v2ApiKeys.userId,
      workspaceId: v2ApiKeys.workspaceId,
      config: v2ApiKeys.config,
      userEmail: users.email,
      userRole: users.role,
    })
    .from(v2ApiKeys)
    .leftJoin(users, eq(v2ApiKeys.userId, users.externalId))
    .where(and(eq(v2ApiKeys.key, trimmed), isNull(v2ApiKeys.deletedAt)))
    .limit(1)
  const row = rows[0]
  if (!row || !row.userEmail) {
    return null
  }
  // Best-effort lastUsedAt touch. Don't await — keep verification path
  // off the write path; a transient PG hiccup must not fail auth.
  void db
    .update(v2ApiKeys)
    .set({ lastUsedAt: sql`NOW()` })
    .where(eq(v2ApiKeys.id, row.id))
    .catch(() => {
      /* swallow */
    })
  const cfg = (row.config ?? {}) as { allowedAgents?: unknown }
  const allowedAgents = Array.isArray(cfg.allowedAgents)
    ? cfg.allowedAgents.filter((v): v is string => typeof v === "string")
    : []
  // `users.role` is NOT NULL in schema but typed nullable through the
  // leftJoin. Fall back to "user" — never observed in practice given we
  // already null-checked userEmail from the same row.
  const jwtPayload: JwtPayload = {
    sub: row.userEmail,
    role: row.userRole ?? "user",
    workspaceId: row.workspaceId,
    tokenType: "access",
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return { jwtPayload, allowedAgents }
}
