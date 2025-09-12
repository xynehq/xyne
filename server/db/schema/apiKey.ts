import {
  pgTable,
  serial,
  timestamp,
  text,
  json,
  jsonb,
} from "drizzle-orm/pg-core"
import { oneWayEncryption } from "../customType"
import { Encryption } from "@/utils/encryption"
import { users } from "./users"
import { workspaces } from "./workspaces"
import { sql } from "drizzle-orm"

const apiKeyEncryption = new Encryption(process.env.ENCRYPTION_KEY!)

export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  name: text("name").default("Untitled").notNull(),
  userId: text("user_id")
    .references(() => users.externalId, { onDelete: "cascade" })
    .notNull(),
  workspaceId: text("workspace_id")
    .references(() => workspaces.externalId, { onDelete: "cascade" })
    .notNull(),
  key: oneWayEncryption(apiKeyEncryption)("key").notNull(), // encrypted key
  keyPrefix: text("key_prefix").default("").notNull(), // first 4 characters for display
  createdAt: timestamp("created_at").defaultNow().notNull(),
  config: jsonb("config").default(sql`'{}'::jsonb`).notNull(),
})
