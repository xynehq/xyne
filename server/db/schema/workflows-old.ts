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
import { workspaces } from "./workspaces"
import { users } from "./users"

// Workflow Status Enum
export const workflowStatusEnum = pgEnum("workflow_status", [
  "draft",
  "active",
  "paused",
  "completed",
  "failed",
])

// Step Status Enum
export const stepStatusEnum = pgEnum("step_status", [
  "pending",
  "running",
  "done",
  "failed",
  "blocked",
])

// Step Type Enum
export const stepTypeEnum = pgEnum("step_type", ["manual", "automated"])

// Tool Type Enum
export const toolTypeEnum = pgEnum("tool_type", [
  "delay",
  "python_script",
  "slack",
  "gmail",
  "agent",
  "merged_node",
  "form",
])

// Workflow Templates Table
export const workflowTemplates = pgTable("workflow_templates", {
  id: serial("id").notNull().primaryKey(),
  workspaceId: text("workspace_id"),
  name: text("name").notNull(),
  description: text("description"),
  version: text("version").notNull().default("1.0.0"),
  status: workflowStatusEnum("status").notNull().default("draft"),
  config: jsonb("config").default({}),
  createdBy: text("created_by"),
  rootWorkflowStepTemplateId: text("root_workflow_step_template_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
})

// Workflow Step Templates Table
export const workflowStepTemplates = pgTable("workflow_step_templates", {
  id: serial("id").notNull().primaryKey(),
  workflowTemplateId: integer("workflow_template_id")
    .notNull()
    .references(() => workflowTemplates.id),
  name: text("name").notNull(),
  description: text("description"),
  type: stepTypeEnum("type").notNull().default("automated"),
  status: stepStatusEnum("status").notNull().default("pending"),
  parentStepId: text("parent_step_id"),
  nextStepIds: jsonb("next_step_ids").default([]),
  toolIds: text("tool_ids"), // Reference to tools
  timeEstimate: integer("time_estimate").default(0), // in seconds
  metadata: jsonb("metadata").default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
})

// Workflow Executions Table
export const workflowExecutions = pgTable("workflow_executions", {
  id: serial("id").notNull().primaryKey(),
  workspaceId: text("workspace_id"),
  workflowTemplateId: integer("workflow_template_id")
    .notNull()
    .references(() => workflowTemplates.id),
  name: text("name").notNull(),
  description: text("description"),
  status: workflowStatusEnum("status").notNull().default("draft"),
  metadata: jsonb("metadata").default({}),
  rootWorkflowStepExeId: text("root_workflow_step_exe_id"),
  createdBy: text("created_by"),
  completedBy: text("completed_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
})

// Workflow Step Executions Table
export const workflowStepExecutions = pgTable("workflow_step_executions", {
  id: serial("id").notNull().primaryKey(),
  workflowExecutionId: integer("workflow_execution_id")
    .notNull()
    .references(() => workflowExecutions.id),
  workflowStepTemplateId: integer("workflow_step_template_id")
    .notNull()
    .references(() => workflowStepTemplates.id),
  name: text("name").notNull(),
  type: stepTypeEnum("type").notNull().default("automated"),
  status: stepStatusEnum("status").notNull().default("pending"),
  parentStepId: text("parent_step_id"),
  nextStepIds: jsonb("next_step_ids").default([]),
  toolIds: text("tool_ids"), // Reference to tools
  timeEstimate: integer("time_estimate").default(0),
  metadata: jsonb("metadata").default({}),
  completedBy: text("completed_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
})

// Schema exports
export const selectWorkflowTemplateSchema =
  createSelectSchema(workflowTemplates)
export const selectWorkflowStepTemplateSchema = createSelectSchema(
  workflowStepTemplates,
)
export const selectWorkflowExecutionSchema =
  createSelectSchema(workflowExecutions)
export const selectWorkflowStepExecutionSchema = createSelectSchema(
  workflowStepExecutions,
)

export const insertWorkflowTemplateSchema =
  createInsertSchema(workflowTemplates)
export const insertWorkflowStepTemplateSchema = createInsertSchema(
  workflowStepTemplates,
)
export const insertWorkflowExecutionSchema =
  createInsertSchema(workflowExecutions)
export const insertWorkflowStepExecutionSchema = createInsertSchema(
  workflowStepExecutions,
)

// Types
export type SelectWorkflowTemplate = z.infer<
  typeof selectWorkflowTemplateSchema
>
export type SelectWorkflowStepTemplate = z.infer<
  typeof selectWorkflowStepTemplateSchema
>
export type SelectWorkflowExecution = z.infer<
  typeof selectWorkflowExecutionSchema
>
export type SelectWorkflowStepExecution = z.infer<
  typeof selectWorkflowStepExecutionSchema
>

export type InsertWorkflowTemplate = z.infer<
  typeof insertWorkflowTemplateSchema
>
export type InsertWorkflowStepTemplate = z.infer<
  typeof insertWorkflowStepTemplateSchema
>
export type InsertWorkflowExecution = z.infer<
  typeof insertWorkflowExecutionSchema
>
export type InsertWorkflowStepExecution = z.infer<
  typeof insertWorkflowStepExecutionSchema
>

// Public schemas (for API responses)
export const publicWorkflowTemplateSchema = selectWorkflowTemplateSchema.omit({
  id: true,
  workspaceId: true,
  createdBy: true,
  deletedAt: true,
})

export const publicWorkflowExecutionSchema = selectWorkflowExecutionSchema.omit(
  {
    id: true,
    workspaceId: true,
    createdBy: true,
    completedBy: true,
    deletedAt: true,
  },
)

export type PublicWorkflowTemplate = z.infer<
  typeof publicWorkflowTemplateSchema
>
export type PublicWorkflowExecution = z.infer<
  typeof publicWorkflowExecutionSchema
>
