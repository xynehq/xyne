// v2 personal API keys. Separate from v1's `api_keys` table so the two
// surfaces evolve independently — v2 can add fields (lastUsedAt, soft
// delete, lifecycle metadata) without disturbing the v1 consumer auth path.
//
// Key storage: same one-way scrypt hash as v1 via `oneWayEncryption`.
// Plaintext is returned exactly once on create; thereafter only the 4-char
// prefix is exposed. `eq()` lookups against plaintext work because the
// custom type re-hashes the parameter side too.

import { sql } from "drizzle-orm"
import { jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core"

import { Encryption } from "@/utils/encryption"

import { oneWayEncryption } from "../customType"
import { users } from "./users"
import { workspaces } from "./workspaces"

const v2ApiKeyEncryption = new Encryption(process.env.ENCRYPTION_KEY!)

export const v2ApiKeys = pgTable("v2_api_keys", {
  id: serial("id").primaryKey(),
  name: text("name").default("Untitled").notNull(),
  userId: text("user_id")
    .references(() => users.externalId, { onDelete: "cascade" })
    .notNull(),
  workspaceId: text("workspace_id")
    .references(() => workspaces.externalId, { onDelete: "cascade" })
    .notNull(),
  // scrypt-hashed on write; equality lookups hash the parameter too.
  key: oneWayEncryption(v2ApiKeyEncryption)("key").notNull(),
  // First 4 chars of the plaintext, kept in clear so the UI can label a key
  // ("the one starting 86f2…") without ever holding the secret.
  keyPrefix: text("key_prefix").default("").notNull(),
  // Per-key policy. `verifyApiKey` reads `allowedAgents: string[]` —
  // empty/absent means "any agent the owning user can reach".
  config: jsonb("config").default(sql`'{}'::jsonb`).notNull(),
  // Touched on each successful verifyApiKey hit. Nullable until first use.
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  // Soft delete — DELETE /v2/api-keys/:id sets this rather than hard-deleting.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
})
