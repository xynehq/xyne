import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { encryptedText } from "../customType"
import { Encryption } from "@/utils/encryption"
import { workspaces } from "./workspaces"

const sdkEncryption = new Encryption(process.env.ENCRYPTION_KEY!)

export const sdkConfigs = pgTable("sdk_configs", {
  id: serial("id").primaryKey(),
  workspaceId: text("workspace_id")
    .references(() => workspaces.externalId, { onDelete: "cascade" })
    .unique()
    .notNull(),
  tokenSecret: encryptedText(sdkEncryption)("token_secret").notNull(),
  tokenExpirySeconds: integer("token_expiry_seconds").default(3600).notNull(),
  allowedOrigins: jsonb("allowed_origins")
    .default(sql`'[]'::jsonb`)
    .notNull()
    .$type<string[]>(),
  enabled: boolean("enabled").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
})

export type SdkConfig = typeof sdkConfigs.$inferSelect
export type NewSdkConfig = typeof sdkConfigs.$inferInsert
