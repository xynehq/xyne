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
import { toolTypeEnum, workflowTemplate } from "./workflows"

// Tool Execution Status Enum
export const toolExecutionStatusEnum = pgEnum("tool_execution_status", [
  "pending",
  "running",
  "completed",
  "failed",
])

// Workflow Tools Table - distinct from MCP tools
export const workflowTools = pgTable("workflow_tools", {
  id: serial("id").notNull().primaryKey(),
  workspaceId: text("workspace_id"),
  type: toolTypeEnum("type").notNull(),
  value: jsonb("value"), // Can store string, number, or object based on tool type
  config: jsonb("config").default({}),
  workflowTemplateId: integer("workflow_template_id").references(
    () => workflowTemplate.id,
  ),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
})

// Workflow Tool Executions Table - tracks each time a workflow tool is executed
export const workflowToolExecutions = pgTable("workflow_tool_executions", {
  id: serial("id").notNull().primaryKey(),
  toolId: integer("tool_id")
    .notNull()
    .references(() => workflowTools.id),
  stepId: text("step_id").notNull(), // Reference to workflow step execution
  status: toolExecutionStatusEnum("status").notNull().default("pending"),
  result: jsonb("result"), // Execution result/output
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
})

// Schema exports
export const selectWorkflowToolSchema = createSelectSchema(workflowTools)
export const selectWorkflowToolExecutionSchema = createSelectSchema(
  workflowToolExecutions,
)

export const insertWorkflowToolSchema = createInsertSchema(workflowTools)
export const insertWorkflowToolExecutionSchema = createInsertSchema(
  workflowToolExecutions,
)

// Types
export type SelectWorkflowTool = z.infer<typeof selectWorkflowToolSchema>
export type SelectWorkflowToolExecution = z.infer<
  typeof selectWorkflowToolExecutionSchema
>

export type InsertWorkflowTool = z.infer<typeof insertWorkflowToolSchema>
export type InsertWorkflowToolExecution = z.infer<
  typeof insertWorkflowToolExecutionSchema
>

// Public schemas (for API responses)
export const publicWorkflowToolSchema = selectWorkflowToolSchema.omit({
  id: true,
  workspaceId: true,
  createdBy: true,
  deletedAt: true,
})

export const publicWorkflowToolExecutionSchema =
  selectWorkflowToolExecutionSchema.omit({
    id: true,
  })

export type PublicWorkflowTool = z.infer<typeof publicWorkflowToolSchema>
export type PublicWorkflowToolExecution = z.infer<
  typeof publicWorkflowToolExecutionSchema
>

// API request schemas
export const createToolSchema = z.object({
  type: z.enum([
    "delay",
    "python_script",
    "slack",
    "gmail",
    "agent",
    "merged_node",
  ]),
  value: z.union([z.string(), z.number(), z.record(z.any())]).optional(),
  config: z.record(z.any()).optional(),
  workflowTemplateId: z.string().optional(),
})

export const updateToolSchema = createToolSchema.partial()

export type CreateToolRequest = z.infer<typeof createToolSchema>
export type UpdateToolRequest = z.infer<typeof updateToolSchema>
