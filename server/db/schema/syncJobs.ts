import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { SyncConfigSchema, SyncCron } from "@/types"
import { SyncJobStatus } from "@/shared/types"
import { workspaces } from "./workspaces"
import { connectors, appTypeEnum, authTypeEnum } from "./connectors"

export const syncJobEnum = pgEnum(
  "type",
  Object.values(SyncCron) as [string, ...string[]],
)
export const syncJobStatusEnum = pgEnum(
  "sync_status",
  Object.values(SyncJobStatus) as [string, ...string[]],
)

export const syncJobs = pgTable("sync_jobs", {
  id: serial("id").notNull().primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  externalId: text("external_id").unique().notNull(),
  workspaceExternalId: text("workspace_external_id").notNull(),

  // this is the user for whom this sync job will run
  // It's very helpful for service account where we
  // create a sync job per user
  email: text("email").notNull(),
  connectorId: integer("connector_id")
    .notNull()
    .references(() => connectors.id),
  type: syncJobEnum("type").notNull(),
  status: syncJobStatusEnum("status")
    .notNull()
    .default(SyncJobStatus.NotStarted),
  app: appTypeEnum("app_type").notNull(),
  authType: authTypeEnum("auth_type").notNull(),
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

export const insertSyncJob = createInsertSchema(syncJobs).omit({
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  id: true,
  lastRanOn: true,
})
export type InsertSyncJob = z.infer<typeof insertSyncJob>

export const selectSyncJobSchema = createSelectSchema(syncJobs, {
  config: SyncConfigSchema,
})
export type SelectSyncJob = z.infer<typeof selectSyncJobSchema>
