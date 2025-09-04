import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  integer,
  type AnyPgColumn,
  index,
} from "drizzle-orm/pg-core"
import {
  workflowStatusEnum,
  stepTypeEnum,
  stepStatusEnum,
} from "./workflowEnums"
import { workflowTemplate, workflowStepTemplate } from "./workflowTemplate"
import { users } from "./users"
import { workspaces } from "./workspaces"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

// Workflow instances (replaces flow)
export const workflowExe = pgTable(
  "workflow_exe",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rootWorkflowStepExeId: uuid("root_workflow_step_exe_id"), // reference to first step
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    workflowTemplateId: uuid("workflow_template_id")
      .references(() => workflowTemplate.id)
      .notNull(),
    workspaceId: integer("workspace_id")
      .references(() => workspaces.id)
      .notNull(),
    status: workflowStatusEnum("status").default("draft"),
    nextStepIds: uuid("next_step_ids").array(), // array of next step IDs
    prevStepIds: uuid("prev_step_ids").array(), // array of previous step IDs
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdBy: integer("created_by").references(() => users.id),
    completedBy: integer("completed_by").references(() => users.id),
  },
  (table) => ({
    templateIdx: index("workflow_exe_template_idx").on(
      table.workflowTemplateId,
    ),
    statusIdx: index("workflow_exe_status_idx").on(table.status),
  }),
)

// Individual steps in a workflow (replaces step)
export const workflowStepExe = pgTable(
  "workflow_step_exe",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowExeId: uuid("workflow_exe_id")
      .references(() => workflowExe.id)
      .notNull(),
    workflowStepTemplateId: uuid("workflow_step_template_id").references(
      () => workflowStepTemplate.id,
    ), // references template_step
    name: varchar("name", { length: 255 }).notNull(),
    type: stepTypeEnum("type").notNull(), // manual, automated, conditional, parallel
    status: stepStatusEnum("status").default("pending"), // pending, in_progress, completed, skipped
    parentStepId: uuid("parent_step_id").references(
      (): AnyPgColumn => workflowStepExe.id,
    ), // self-reference for hierarchy
    metadata: jsonb("metadata"),
    nextStepIds: uuid("next_step_ids").array(), // array of next step IDs
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: varchar("completed_by", { length: 255 }),
    timeEstimate: integer("time_estimate"), // ETA in seconds
    toolIds: uuid("tool_ids").array(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workflowStatusIdx: index("workflow_step_exe_workflow_status_idx").on(
      table.workflowExeId,
      table.status,
    ),
  }),
)

// Type exports for TypeScript
export const selectWorkflowExeSchema = createSelectSchema(workflowExe)
export const insertWorkflowExeSchema = createInsertSchema(workflowExe)
export type SelectWorkflowExe = z.infer<typeof selectWorkflowExeSchema>
export type InsertWorkflowExe = z.infer<typeof insertWorkflowExeSchema>

export const selectWorkflowStepExeSchema = createSelectSchema(workflowStepExe)
export const insertWorkflowStepExeSchema = createInsertSchema(workflowStepExe)
export type SelectWorkflowStepExe = z.infer<typeof selectWorkflowStepExeSchema>
export type InsertWorkflowStepExe = z.infer<typeof insertWorkflowStepExeSchema>

// Legacy exports for backward compatibility
export const workflow = workflowExe
export const workflowStep = workflowStepExe
