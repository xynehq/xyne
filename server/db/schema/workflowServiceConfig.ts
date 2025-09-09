import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import {
  serviceConfigStatusEnum,
  serviceInstanceStatusEnum,
} from "./workflowEnums"
import { workspaces } from "./workspaces"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

// Service configurations (replaces product_info)
export const workflowServiceConfig = pgTable("workflow_service_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(), // e.g., "Payment Processing Workflow", "EU GDPR Onboarding"
  activeWorkflowTemplateId: uuid("active_workflow_template_id"), // which template to use
  category: varchar("category", { length: 100 }), // PP, EC_SDK
  subcategory: varchar("subcategory", { length: 100 }),
  selectionCriteria: jsonb("selection_criteria"), // flexible key-value pairs for matching, can keep empty for now
  status: serviceConfigStatusEnum("status").default("active"),
  metadata: jsonb("metadata"), // additional config data
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
})

// Organization's active service instances (replaces merchant_r_product_info)
// Using workspace_id instead of organization_id to match Xyne's existing structure
export const workspaceServiceConfig = pgTable(
  "workspace_service_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: integer("workspace_id")
      .references(() => workspaces.id)
      .notNull(),
    serviceConfigId: uuid("service_config_id")
      .references(() => workflowServiceConfig.id)
      .notNull(),
    instanceName: varchar("instance_name", { length: 255 }).notNull(), // e.g., "Acme Corp - PP F1 Onboarding"
    authorizedUsers: varchar("authorized_users").array(), // emails who can access this instance
    currentWorkflowExeId: uuid("current_workflow_exe_id"), // active workflow for this instance
    configurationData: jsonb("configuration_data"), // instance-specific settings -- optional
    integrationSettings: jsonb("integration_settings"), // API keys, webhooks, etc. -- optional fields
    status: serviceInstanceStatusEnum("status").default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    workspaceStatusIdx: index(
      "workspace_service_config_workspace_status_idx",
    ).on(table.workspaceId, table.status),
    workspaceSvcUnique: uniqueIndex("workspace_service_config_unique_idx")
      .on(table.workspaceId, table.serviceConfigId, table.instanceName),
  }),
)

// Type exports for TypeScript
export const selectWorkflowServiceConfigSchema = createSelectSchema(workflowServiceConfig)
export const insertWorkflowServiceConfigSchema = createInsertSchema(workflowServiceConfig)
export type SelectWorkflowServiceConfig = z.infer<typeof selectWorkflowServiceConfigSchema>
export type InsertWorkflowServiceConfig = z.infer<typeof insertWorkflowServiceConfigSchema>

export const selectWorkspaceServiceConfigSchema = createSelectSchema(
  workspaceServiceConfig,
)
export const insertWorkspaceServiceConfigSchema = createInsertSchema(
  workspaceServiceConfig,
)
export type SelectWorkspaceServiceConfig = z.infer<
  typeof selectWorkspaceServiceConfigSchema
>
export type InsertWorkspaceServiceConfig = z.infer<
  typeof insertWorkspaceServiceConfigSchema
>

// Legacy exports for backward compatibility
export const serviceConfig = workflowServiceConfig