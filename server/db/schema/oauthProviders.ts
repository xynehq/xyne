import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { encryptedText } from "../customType"
import { Encryption } from "@/utils/encryption"
import { workspaces } from "./workspaces"
import { users } from "./users"
import { connectors, appTypeEnum } from "./connectors"

const encryptionKey = process.env.ENCRYPTION_KEY!
if (!encryptionKey) {
  throw new Error("ENCRYPTION_KEY environment variable is not set.")
}

const accesskeyEncryption = new Encryption(encryptionKey)

// anytime we make a oauth provider we make a corresponding
// connector with not connected status.
export const oauthProviders = pgTable("oauth_providers", {
  id: serial("id").notNull().primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  externalId: text("external_id").unique().notNull(),
  workspaceExternalId: text("workspace_external_id").notNull(),
  connectorId: integer("connector_id")
    .notNull()
    .references(() => connectors.id),
  clientId: text("client_id"),
  clientSecret: encryptedText(accesskeyEncryption)("client_secret"),
  oauthScopes: text("oauth_scopes")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  app: appTypeEnum("app_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  isGlobal: boolean("is_global").default(false),
})

export const insertProviderSchema = createInsertSchema(oauthProviders, {
  // added to prevent type error
  oauthScopes: z.array(z.string()),
  clientSecret: z.string().nullable().optional(),
}).omit({
  createdAt: true,
  updatedAt: true,
  id: true,
})
export type InsertOAuthProvider = z.infer<typeof insertProviderSchema>

export const selectProviderSchema = createSelectSchema(oauthProviders, {
  // added to prevent type error
  oauthScopes: z.array(z.string()),
})

export type SelectOAuthProvider = z.infer<typeof selectProviderSchema>
