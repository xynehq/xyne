import { pgTable, serial, integer, timestamp, text } from "drizzle-orm/pg-core"
import { agents } from "./agents" // your existing agents table
import { oneWayEncryption } from "../customType"
import { Encryption } from "@/utils/encryption"
import { users } from "./users"
import { workspaces } from "./workspaces"

const apiKeyEncryption = new Encryption(process.env.ENCRYPTION_KEY!)

export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  userId: text("user_id")
    .references(() => users.externalId, { onDelete: "cascade" })
    .notNull(),
  workspaceId: text("workspace_id")
    .references(() => workspaces.externalId, { onDelete: "cascade" })
    .notNull(),
  key: oneWayEncryption(apiKeyEncryption)("key").notNull(), // encrypted key

  createdAt: timestamp("created_at").defaultNow().notNull(),
})
