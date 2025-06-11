import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { SyncConfigSchema } from "@/types"
import { workspaces } from "./workspaces"
import { syncJobEnum, syncJobStatusEnum } from "./syncJobs"
import { authTypeEnum, appTypeEnum } from "./connectors"

// can be helpful as an audit log
// snapshot of sync jobs
// or to know how much got synced when
export const syncHistory = pgTable("sync_history", {
  id: serial("id").notNull().primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  externalId: text("external_id").unique().notNull(),
  workspaceExternalId: text("workspace_external_id").notNull(),
  // providerId: integer("provider_id")
  //     .notNull()
  //     .references(() => oauthProviders.id),
  dataAdded: integer("data_added").notNull().default(0),
  dataUpdated: integer("data_updated").notNull().default(0),
  dataDeleted: integer("data_deleted").notNull().default(0),
  summary: jsonb("summary").notNull(), // JSON summary of the sync (could store metadata like sync duration, etc.)
  errorMessage: text("error_message").default(""), // Error message in case the sync fails
  type: syncJobEnum("type").notNull(),
  status: syncJobStatusEnum("status").notNull(),
  authType: authTypeEnum("auth_type").notNull(),
  app: appTypeEnum("app_type").notNull(),
  config: jsonb("config").notNull(),
  lastRanOn: timestamp("last_ran_on", { withTimezone: true }).default(
    sql`NOW()`,
  ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
})

export const insertSyncHistorySchema = createInsertSchema(syncHistory).omit({
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  id: true,
})
export type InsertSyncHistory = z.infer<typeof insertSyncHistorySchema>

export const selectSyncHistorySchema = createSelectSchema(syncHistory, {
  config: SyncConfigSchema,
})
export type SelectSyncHistory = z.infer<typeof selectSyncHistorySchema>
