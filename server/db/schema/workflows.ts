import { sql } from "drizzle-orm"
import {
  uuid,
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  pgEnum,
  customType,
  varchar,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import {
  WorkflowStatus,
  StepType,
  ToolType,
} from "@/types/workflowTypes"

// Custom UUID array type for PostgreSQL
export const uuidArray = customType<{
  data: string[]
  driverData: string[] | string
}>({
  dataType() {
    return "uuid[]"
  },
  toDriver(value: string[]): string {
    if (!value || value.length === 0) return "{}"
    return `{${value.join(",")}}`
  },
  fromDriver(value: string[] | string): string[] {
    if (!value) return []

    // PostgreSQL driver might return an array directly or a string
    if (Array.isArray(value)) {
      return value
    }

    // If it's a string in PostgreSQL array format: {uuid1,uuid2,uuid3}
    if (typeof value === "string") {
      if (value === "{}") return []
      // Remove surrounding braces and split by comma
      const cleaned = value.replace(/^\{|\}$/g, "")
      return cleaned.split(",").map(uuid => uuid.trim()).filter(Boolean)
    }

    return []
  },
})

// New schema ENUMs to match database
export const contentTypeEnum = pgEnum("content_type_enum", [
  'text', 'html', 'markdown', 'form', 'api_call', 'file_upload'
])

export const historyActionEnum = pgEnum("history_action_enum", [
  'created', 'updated', 'deleted', 'completed', 'started', 'paused', 'resumed', 'assigned', 'cancelled', 'failed'
])

export const httpMethodEnum = pgEnum("http_method_enum", [
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE'
])

export const integrationStatusEnum = pgEnum("integration_status_enum", [
  'pending', 'in_progress', 'completed', 'failed'
])

export const workspaceStatusEnum = pgEnum("workspace_status_enum", [
  'active', 'inactive', 'suspended', 'pending'
])

export const serviceConfigStatusEnum = pgEnum("service_config_status_enum", [
  'active', 'inactive', 'draft'
])

export const serviceInstanceStatusEnum = pgEnum("service_instance_status_enum", [
  'active', 'suspended', 'configured', 'pending'
])

export const stepStatusEnum = pgEnum("step_status_enum", [
  'pending', 'done', 'blocked'
])

export const stepTypeEnum = pgEnum("step_type_enum", [
  'manual', 'automated', 'conditional', 'parallel', 'approval'
])

export const workflowTemplateStatusEnum = pgEnum("workflow_template_status_enum", [
  'active', 'draft', 'deprecated'
])

export const userRoleEnum = pgEnum("user_role_enum", [
  'admin', 'manager', 'user', 'viewer'
])

export const userStatusEnum = pgEnum("user_status_enum", [
  'active', 'inactive', 'suspended'
])

export const workflowStatusEnum = pgEnum("workflow_status_enum", [
  'draft', 'active', 'completed'
])

export const toolTypeEnum = pgEnum("tool_type_enum", [
  'python_script', 'slack', 'gmail', 'agent', 'delay', 'merged_node', 'form', 'email', 'ai_agent'
])

export const relationTypeEnum = pgEnum("relation_type_enum", [
  'NEXT', 'PARENT', 'CHILD'
])

// Base tables for new schema
export const workspace = pgTable("workspace", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
})

export const user = pgTable("user", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
})

// Service config table
export const workflowServiceConfig = pgTable("workflow_service_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  activeWorkflowTemplateId: uuid("active_workflow_template_id"),
  category: varchar("category", { length: 100 }),
  subcategory: varchar("subcategory", { length: 100 }),
  selectionCriteria: jsonb("selection_criteria"),
  status: serviceConfigStatusEnum("status").default('active'),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
})

// Updated workflow template
export const workflowTemplate = pgTable("workflow_template", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowServiceConfigId: uuid("workflow_service_config_id"),
  rootWorkflowStepTemplateId: uuid("root_workflow_step_template_id"),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  version: varchar("version", { length: 50 }),
  status: workflowTemplateStatusEnum("status").default('draft'),
  config: jsonb("config"),
  workspaceId: integer("workspace_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  createdBy: integer("created_by"),
  updatedBy: integer("updated_by"),
})

// Updated workflow step template
export const workflowStepTemplate = pgTable("workflow_step_template", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowTemplateId: uuid("workflow_template_id").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  type: stepTypeEnum("type").notNull(),
  status: stepStatusEnum("status").default('pending'),
  toolIds: uuidArray("tool_ids").default([]),
  timeEstimate: integer("time_estimate"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
})

// Connection tables for step relationships
export const workflowStepTemplateConnection = pgTable("workflow_step_template_connection", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromStepId: uuid("from_step_id").notNull(),
  toStepId: uuid("to_step_id").notNull(),
  relationType: relationTypeEnum("relation_type").notNull(),
  connectionConfig: jsonb("connection_config"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
})

// Workflow tool templates and instances
export const workflowToolTemplate = pgTable("workflow_tool_template", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: toolTypeEnum("type"),
  name: varchar("name", { length: 255 }),
  description: text("description"),
  data: jsonb("data"),
  defaultConfig: jsonb("default_config"),
  workflowTemplateId: uuid("workflow_template_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
})

export const workflowTool = pgTable("workflow_tool", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: toolTypeEnum("type"),
  value: jsonb("value"),
  config: jsonb("config"),
  workflowTemplateId: uuid("workflow_template_id"),
  workflowId: uuid("workflow_id"),
  workflowToolTemplateId: uuid("workflow_tool_template_id"),
})

// Workflow instance tables
export const workflow = pgTable("workflow", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  workflowTemplateId: uuid("workflow_template_id"),
  status: serviceInstanceStatusEnum("status").default('pending'),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  completedAt: timestamp("completed_at", { withTimezone: true }),
})

export const workflowStep = pgTable("workflow_step", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowTemplateId: uuid("workflow_template_id").notNull(),
  workflowId: uuid("workflow_id"),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  type: stepTypeEnum("type").notNull(),
  status: stepStatusEnum("status").default('pending'),
  workflowToolIds: uuidArray("workflow_tool_ids"),
  timeEstimate: integer("time_estimate"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
})

// Workflow execution tables (renamed)
export const workflowExe = pgTable("workflow_exe", {
  id: uuid("id").primaryKey().defaultRandom(),
  rootWorkflowStepExeId: uuid("root_workflow_step_exe_id"),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  workflowTemplateId: uuid("workflow_template_id").notNull(),
  status: workflowStatusEnum("status").default('draft'),
  metadata: jsonb("metadata"),
  workspaceId: uuid("workspace_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  completedAt: timestamp("completed_at", { withTimezone: true }),
})

export const workflowStepExe = pgTable("workflow_step_exe", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowExeId: uuid("workflow_exe_id").notNull(),
  workflowStepTemplateId: uuid("workflow_step_template_id"),
  name: varchar("name", { length: 255 }).notNull(),
  type: stepTypeEnum("type").notNull(),
  status: stepStatusEnum("status").default('pending'),
  metadata: jsonb("metadata"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedBy: uuid("completed_by"),
  timeEstimate: integer("time_estimate"),
  toolIds: uuidArray("tool_ids"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
})

export const workflowStepExeConnection = pgTable("workflow_step_exe_connection", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromStepId: uuid("from_step_id").notNull(),
  toStepId: uuid("to_step_id").notNull(),
  relationType: relationTypeEnum("relation_type").notNull(),
  connectionConfig: jsonb("connection_config"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
})

export const workflowToolExe = pgTable("workflow_tool_exec", {
  id: uuid("id").primaryKey().defaultRandom(),
  result: jsonb("result"),
  toolId: uuid("tool_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  completedAt: timestamp("completed_at", { withTimezone: true }),
})

// Audit and history tables
export const workflowEventLog = pgTable("workflow_event_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  entityType: varchar("entity_type", { length: 100 }).notNull(),
  entityId: uuid("entity_id").notNull(),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  eventData: jsonb("event_data"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  workspaceId: uuid("workspace_id"),
})

export const workflowHistory = pgTable("workflow_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowExeId: uuid("workflow_exe_id"),
  workflowStepExeId: uuid("workflow_step_exe_id"),
  action: historyActionEnum("action").notNull(),
  oldData: jsonb("old_data"),
  newData: jsonb("new_data"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  workspaceId: uuid("workspace_id"),
})

// Schema exports for new structure
export const selectWorkflowTemplateSchema = createSelectSchema(workflowTemplate)
export const selectWorkflowStepTemplateSchema = createSelectSchema(workflowStepTemplate)
export const selectWorkflowToolTemplateSchema = createSelectSchema(workflowToolTemplate)
export const selectWorkflowToolSchema = createSelectSchema(workflowTool)
export const selectWorkflowSchema = createSelectSchema(workflow)
export const selectWorkflowStepSchema = createSelectSchema(workflowStep)
export const selectWorkflowExeSchema = createSelectSchema(workflowExe)
export const selectWorkflowStepExeSchema = createSelectSchema(workflowStepExe)
export const selectWorkflowToolExeSchema = createSelectSchema(workflowToolExe)
export const selectWorkflowServiceConfigSchema = createSelectSchema(workflowServiceConfig)

// Keep legacy aliases for compatibility
export const selectWorkflowExecutionSchema = selectWorkflowExeSchema
export const selectWorkflowStepExecutionSchema = selectWorkflowStepExeSchema
export const selectToolExecutionSchema = selectWorkflowToolExeSchema

// Insert schemas for new structure
export const insertWorkflowTemplateSchema = createInsertSchema(workflowTemplate)
export const insertWorkflowStepTemplateSchema = createInsertSchema(workflowStepTemplate)
export const insertWorkflowToolTemplateSchema = createInsertSchema(workflowToolTemplate)
export const insertWorkflowToolSchema = createInsertSchema(workflowTool)
export const insertWorkflowSchema = createInsertSchema(workflow)
export const insertWorkflowStepSchema = createInsertSchema(workflowStep)
export const insertWorkflowExeSchema = createInsertSchema(workflowExe)
export const insertWorkflowStepExeSchema = createInsertSchema(workflowStepExe)
export const insertWorkflowToolExeSchema = createInsertSchema(workflowToolExe)
export const insertWorkflowServiceConfigSchema = createInsertSchema(workflowServiceConfig)

// Keep legacy aliases for compatibility
export const insertWorkflowExecutionSchema = insertWorkflowExeSchema
export const insertWorkflowStepExecutionSchema = insertWorkflowStepExeSchema
export const insertToolExecutionSchema = insertWorkflowToolExeSchema

// Types for new structure
export type SelectWorkflowTemplate = z.infer<typeof selectWorkflowTemplateSchema>
export type SelectWorkflowStepTemplate = z.infer<typeof selectWorkflowStepTemplateSchema>
export type SelectWorkflowToolTemplate = z.infer<typeof selectWorkflowToolTemplateSchema>
export type SelectWorkflowTool = z.infer<typeof selectWorkflowToolSchema>
export type SelectWorkflow = z.infer<typeof selectWorkflowSchema>
export type SelectWorkflowStep = z.infer<typeof selectWorkflowStepSchema>
export type SelectWorkflowExe = z.infer<typeof selectWorkflowExeSchema>
export type SelectWorkflowStepExe = z.infer<typeof selectWorkflowStepExeSchema>
export type SelectWorkflowToolExe = z.infer<typeof selectWorkflowToolExeSchema>
export type SelectWorkflowServiceConfig = z.infer<typeof selectWorkflowServiceConfigSchema>

export type InsertWorkflowTemplate = z.infer<typeof insertWorkflowTemplateSchema>
export type InsertWorkflowStepTemplate = z.infer<typeof insertWorkflowStepTemplateSchema>
export type InsertWorkflowToolTemplate = z.infer<typeof insertWorkflowToolTemplateSchema>
export type InsertWorkflowTool = z.infer<typeof insertWorkflowToolSchema>
export type InsertWorkflow = z.infer<typeof insertWorkflowSchema>
export type InsertWorkflowStep = z.infer<typeof insertWorkflowStepSchema>
export type InsertWorkflowExe = z.infer<typeof insertWorkflowExeSchema>
export type InsertWorkflowStepExe = z.infer<typeof insertWorkflowStepExeSchema>
export type InsertWorkflowToolExe = z.infer<typeof insertWorkflowToolExeSchema>
export type InsertWorkflowServiceConfig = z.infer<typeof insertWorkflowServiceConfigSchema>

// Legacy type aliases for compatibility
export type SelectWorkflowExecution = SelectWorkflowExe
export type SelectWorkflowStepExecution = SelectWorkflowStepExe
export type SelectToolExecution = SelectWorkflowToolExe
export type InsertWorkflowExecution = InsertWorkflowExe
export type InsertWorkflowStepExecution = InsertWorkflowStepExe
export type InsertToolExecution = InsertWorkflowToolExe

// Public schemas (for API responses)
export const publicWorkflowTemplateSchema = selectWorkflowTemplateSchema.omit({
  createdBy: true,
  updatedBy: true,
})

export const publicWorkflowExeSchema = selectWorkflowExeSchema.omit({
  createdBy: true,
  updatedBy: true,
  completedBy: true,
})

// Legacy alias
export const publicWorkflowExecutionSchema = publicWorkflowExeSchema

export const publicWorkflowToolSchema = selectWorkflowToolSchema.omit({
  // No private fields to omit in the new tool schema
})

export type PublicWorkflowTemplate = z.infer<
  typeof publicWorkflowTemplateSchema
>
export type PublicWorkflowExe = z.infer<typeof publicWorkflowExeSchema>
export type PublicWorkflowTool = z.infer<typeof publicWorkflowToolSchema>

// Legacy alias
export type PublicWorkflowExecution = PublicWorkflowExe

// API request schemas
export const createWorkflowTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  version: z.string().default("1.0.0"),
  config: z.record(z.string(), z.any()).optional(),
})

export const createWorkflowToolSchema = z.object({
  type: z.enum(Object.values(ToolType) as [string, ...string[]]),
  value: z.union([z.string(), z.number(), z.record(z.string(), z.any())]).optional(),
  config: z.record(z.string(), z.any()).optional(),
})

export const updateWorkflowToolSchema = createWorkflowToolSchema
  .partial()
  .extend({
    stepName: z.string().min(1).max(255).optional(),
    stepDescription: z.string().optional(),
  })

export const createWorkflowStepTemplateSchema = z.object({
  workflowTemplateId: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  type: z.enum(Object.values(StepType) as [string, ...string[]]).default(StepType.AUTOMATED),
  parentStepId: z.string().uuid().optional(),
  prevStepIds: z.array(z.string().uuid()).default([]),
  nextStepIds: z.array(z.string().uuid()).default([]),
  toolIds: z.array(z.string().uuid()).default([]),
  timeEstimate: z.number().int().min(0).default(0),
  metadata: z.record(z.string(), z.any()).optional(),
})

export const executeWorkflowSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
})

// Additional schemas required by server.ts
export const updateWorkflowTemplateSchema =
  createWorkflowTemplateSchema.partial()

// Complex workflow template creation schema for frontend workflow builder
export const createComplexWorkflowTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  version: z.string().default("1.0.0"),
  config: z.object({
    ai_model: z.string().optional(),
    max_file_size: z.string().optional(),
    auto_execution: z.boolean().optional(),
    schema_version: z.string().optional(),
    allowed_file_types: z.array(z.string()).optional(),
    supports_file_upload: z.boolean().optional(),
  }).optional(),
  nodes: z.array(z.object({
    id: z.string(),
    type: z.string(),
    position: z.object({
      x: z.number(),
      y: z.number(),
    }),
    data: z.object({
      step: z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        type: z.string(),
        status: z.string().optional(),
        contents: z.array(z.any()).optional(),
        config: z.record(z.string(), z.any()).optional(),
      }),
      tools: z.array(z.object({
        id: z.string().optional(),
        type: z.string(),
        value: z.any().optional(),
        config: z.record(z.string(), z.any()).optional(),
      })).optional(),
      isActive: z.boolean().optional(),
      isCompleted: z.boolean().optional(),
      hasNext: z.boolean().optional(),
    }),
  })),
  edges: z.array(z.object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
    type: z.string().optional(),
    sourceHandle: z.string().optional(),
    targetHandle: z.string().optional(),
    style: z.record(z.string(), z.any()).optional(),
    markerEnd: z.record(z.string(), z.any()).optional(),
  })),
  metadata: z.object({
    nodeCount: z.number(),
    edgeCount: z.number(),
    createdAt: z.string(),
    workflowType: z.string(),
  }).optional(),
})

export const createWorkflowExecutionSchema = z.object({
  workflowTemplateId: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
})

export const updateWorkflowExecutionSchema =
  createWorkflowExecutionSchema.partial()

export const updateWorkflowStepExecutionSchema = z.object({
  status: z
    .enum(Object.values(WorkflowStatus) as [string, ...string[]])
    .optional(),
  completedBy: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
})

export const formSubmissionSchema = z.object({
  stepId: z.string().uuid(),
  formData: z.record(z.string(), z.any()),
})

export const addStepToWorkflowSchema = z.object({
  stepName: z.string().min(1).max(255),
  stepDescription: z.string().optional(),
  stepType: z.enum(Object.values(StepType) as [string, ...string[]]).default(StepType.AUTOMATED),
  timeEstimate: z.number().int().min(0).default(300),
  metadata: z.record(z.string(), z.any()).optional(),
  tool: z.object({
    type: z.enum(Object.values(ToolType) as [string, ...string[]]),
    value: z.union([z.string(), z.number(), z.record(z.string(), z.any())]).optional(),
    config: z.record(z.string(), z.any()).optional(),
  }),
})

export type CreateWorkflowTemplateRequest = z.infer<
  typeof createWorkflowTemplateSchema
>
export type CreateWorkflowToolRequest = z.infer<typeof createWorkflowToolSchema>
export type UpdateWorkflowToolRequest = z.infer<typeof updateWorkflowToolSchema>
export type CreateWorkflowStepTemplateRequest = z.infer<
  typeof createWorkflowStepTemplateSchema
>
export type ExecuteWorkflowRequest = z.infer<typeof executeWorkflowSchema>
export type UpdateWorkflowTemplateRequest = z.infer<
  typeof updateWorkflowTemplateSchema
>
export type CreateWorkflowExecutionRequest = z.infer<
  typeof createWorkflowExecutionSchema
>
export type UpdateWorkflowExecutionRequest = z.infer<
  typeof updateWorkflowExecutionSchema
>
export type UpdateWorkflowStepExecutionRequest = z.infer<
  typeof updateWorkflowStepExecutionSchema
>
export type FormSubmissionRequest = z.infer<typeof formSubmissionSchema>
export type AddStepToWorkflowRequest = z.infer<typeof addStepToWorkflowSchema>
