import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  integer,
  type AnyPgColumn,
} from "drizzle-orm/pg-core"
import {
  templateWorkflowStatusEnum,
  stepTypeEnum,
  contentTypeEnum,
} from "./workflowEnums"
import { workflowServiceConfig } from "./workflowServiceConfig"
import { users } from "./users"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

// Template workflows
export const workflowTemplate = pgTable("workflow_template", {
  id: uuid("id").primaryKey().defaultRandom(),
  serviceConfigId: uuid("service_config_id").references(() => workflowServiceConfig.id),
  rootWorkflowStepTemplateId: uuid("root_workflow_step_template_id")
    .references((): AnyPgColumn => workflowStepTemplate.id, { onDelete: "set null" }), // reference to first step
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  version: varchar("version", { length: 50 }),
  status: templateWorkflowStatusEnum("status").default("draft"),
  config: jsonb("config"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  createdBy: integer("created_by").references(() => users.id),
})

// Template workflow steps
export const workflowStepTemplate = pgTable("workflow_step_template", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowTemplateId: uuid("workflow_template_id")
    .references(() => workflowTemplate.id)
    .notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  type: stepTypeEnum("type").notNull(),
  parentStepId: uuid("parent_step_id").references(
    (): AnyPgColumn => workflowStepTemplate.id,
  ), // self-reference for hierarchy
  nextStepIds: uuid("next_step_ids").array(),
  prevStepIds: uuid("prev_step_ids").array(),
  toolIds: uuid("tool_ids").array(),
  timeEstimate: integer("time_estimate"), // time estimate in seconds
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
})

// Content table - more generic, can be for any entity like workflow or step
export const workflowContent = pgTable("workflow_content", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowStepTemplateId: uuid("workflow_step_template_id").references(
    () => workflowStepTemplate.id,
  ),
  type: contentTypeEnum("type").notNull(),
  title: varchar("title", { length: 255 }),
  body: jsonb("body"), // body can be json
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
})

// Type exports for TypeScript
export const selectWorkflowTemplateSchema = createSelectSchema(workflowTemplate)
export const insertWorkflowTemplateSchema = createInsertSchema(workflowTemplate)
export type SelectWorkflowTemplate = z.infer<
  typeof selectWorkflowTemplateSchema
>
export type InsertWorkflowTemplate = z.infer<
  typeof insertWorkflowTemplateSchema
>

export const selectWorkflowStepTemplateSchema =
  createSelectSchema(workflowStepTemplate)
export const insertWorkflowStepTemplateSchema =
  createInsertSchema(workflowStepTemplate)
export type SelectWorkflowStepTemplate = z.infer<
  typeof selectWorkflowStepTemplateSchema
>
export type InsertWorkflowStepTemplate = z.infer<
  typeof insertWorkflowStepTemplateSchema
>

export const selectWorkflowContentSchema = createSelectSchema(workflowContent)
export const insertWorkflowContentSchema = createInsertSchema(workflowContent)
export type SelectWorkflowContent = z.infer<typeof selectWorkflowContentSchema>
export type InsertWorkflowContent = z.infer<typeof insertWorkflowContentSchema>

// Legacy exports for backward compatibility
export const templateWorkflow = workflowTemplate
export const templateWorkflowStep = workflowStepTemplate
export const content = workflowContent
