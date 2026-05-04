import { sql } from "drizzle-orm"
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { users } from "./users"
import { workspaces } from "./workspaces"

export type SyncControlScopeType =
  | "global"
  | "queue"
  | "worker_group"
  | "email"
  | "connector"
  | "collection"
  | "job"

export type SyncControlType = "pause" | "cancel"

export type SyncControlAuditAction =
  | "pause"
  | "resume"
  | "worker_pause"
  | "worker_resume"
  | "cancel"
  | "delete"
  | "clear"

export type SyncControlAuditResultStatus = "pending" | "success" | "failed"

export const syncQueueControls = pgTable("sync_queue_controls", {
  id: serial("id").notNull().primaryKey(),
  externalId: text("external_id").unique().notNull(),
  workspaceId: integer("workspace_id").references(() => workspaces.id),
  scopeType: text("scope_type").notNull().$type<SyncControlScopeType>(),
  scopeValue: text("scope_value").notNull(),
  queueName: text("queue_name"),
  controlType: text("control_type").notNull().$type<SyncControlType>(),
  reason: text("reason").notNull(),
  createdByUserId: integer("created_by_user_id")
    .notNull()
    .references(() => users.id),
  createdByEmail: text("created_by_email").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
})

export const syncQueueAuditLogs = pgTable("sync_queue_audit_logs", {
  id: serial("id").notNull().primaryKey(),
  externalId: text("external_id").unique().notNull(),
  requestId: text("request_id").notNull(),
  workspaceId: integer("workspace_id").references(() => workspaces.id),
  action: text("action").notNull().$type<SyncControlAuditAction>(),
  scopeType: text("scope_type").notNull().$type<SyncControlScopeType>(),
  scopeValue: text("scope_value").notNull(),
  queueName: text("queue_name"),
  filters: jsonb("filters").notNull().default(sql`'{}'::jsonb`),
  dryRun: boolean("dry_run").notNull().default(true),
  affectedJobCount: integer("affected_job_count").notNull().default(0),
  affectedWorkerCount: integer("affected_worker_count").notNull().default(0),
  reason: text("reason").notNull(),
  requestedByUserId: integer("requested_by_user_id")
    .notNull()
    .references(() => users.id),
  requestedByEmail: text("requested_by_email").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  workerResults: jsonb("worker_results"),
  resultStatus: text("result_status")
    .notNull()
    .$type<SyncControlAuditResultStatus>()
    .default("pending"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  completedAt: timestamp("completed_at", { withTimezone: true }),
})

export const insertSyncQueueControlSchema =
  createInsertSchema(syncQueueControls)
export const selectSyncQueueControlSchema =
  createSelectSchema(syncQueueControls)
export type InsertSyncQueueControl = z.infer<
  typeof insertSyncQueueControlSchema
>
export type SelectSyncQueueControl = z.infer<
  typeof selectSyncQueueControlSchema
>

export const insertSyncQueueAuditLogSchema =
  createInsertSchema(syncQueueAuditLogs)
export const selectSyncQueueAuditLogSchema =
  createSelectSchema(syncQueueAuditLogs)
export type InsertSyncQueueAuditLog = z.infer<
  typeof insertSyncQueueAuditLogSchema
>
export type SelectSyncQueueAuditLog = z.infer<
  typeof selectSyncQueueAuditLogSchema
>
