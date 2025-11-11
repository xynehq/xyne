import { sql } from "drizzle-orm"
import {
  uuid,
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  pgEnum,
  customType,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import {
  WorkflowStatus,
  StepType,
  ToolType,
  ToolExecutionStatus,
} from "@/types/workflowTypes"
import { workspaces } from "./workspaces"
import { users } from "./users"

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
      return value.slice(1, -1).split(",").filter(Boolean)
    }

    return []
  },
})

export const workflowStatusEnum = pgEnum("workflow_status", Object.values(WorkflowStatus) as [string, ...string[]])

export const stepTypeEnum = pgEnum("step_type", Object.values(StepType) as [string, ...string[]])

export const toolTypeEnum = pgEnum("tool_type", Object.values(ToolType) as [string, ...string[]])

export const toolExecutionStatusEnum = pgEnum("tool_execution_status", Object.values(ToolExecutionStatus) as [string, ...string[]])

// 1. Workflow Templates Table (renamed from workflow_templates)
export const workflowTemplate = pgTable("workflow_template", {
  id: uuid("id").notNull().primaryKey().defaultRandom(),
  name: text("name").notNull(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  isPublic: boolean("is_public")
    .default(false)
    .notNull(),
  description: text("description"),
  version: text("version").notNull().default("1.0.0"),
  status: workflowStatusEnum("status").notNull().default(WorkflowStatus.DRAFT),
  config: jsonb("config").default({}),
  rootWorkflowStepTemplateId: uuid("root_workflow_step_template_id"), // UUID reference
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  // Removed: workspaceId, deletedAt
})

// 2. Workflow Step Templates Table (renamed from workflow_step_templates)
export const workflowStepTemplate = pgTable("workflow_step_template", {
  id: uuid("id").notNull().primaryKey().defaultRandom(),
  workflowTemplateId: uuid("workflow_template_id")
    .notNull()
    .references(() => workflowTemplate.id),
  name: text("name").notNull(),
  description: text("description"),
  type: stepTypeEnum("type").notNull().default(StepType.AUTOMATED),
  // Removed: status column
  parentStepId: uuid("parent_step_id"), // UUID reference
  prevStepIds: uuidArray("prev_step_ids").default([]), // Array of UUIDs
  nextStepIds: uuidArray("next_step_ids").default([]), // Array of UUIDs
  toolIds: uuidArray("tool_ids").default([]), // Array of UUIDs (only one for now)
  timeEstimate: integer("time_estimate").default(0), // in seconds
  metadata: jsonb("metadata").default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  // Removed: deletedAt
})

// 3. Workflow Tools Table (renamed from workflow_tools)
export const workflowTool = pgTable("workflow_tool", {
  id: uuid("id").notNull().primaryKey().defaultRandom(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  type: toolTypeEnum("type").notNull(),
  value: jsonb("value"), // Can store string, number, or object based on tool type
  config: jsonb("config").default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  // Removed: workspaceId, deletedAt, workflowTemplateId
})

// 4. Workflow Executions Table (renamed from workflow_executions)
export const workflowExecution = pgTable("workflow_execution", {
  id: uuid("id").notNull().primaryKey().defaultRandom(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  workflowTemplateId: uuid("workflow_template_id")
    .notNull()
    .references(() => workflowTemplate.id),
  name: text("name").notNull(),
  description: text("description"),
  status: workflowStatusEnum("status").notNull().default(WorkflowStatus.DRAFT),
  metadata: jsonb("metadata").default({}),
  rootWorkflowStepExeId: uuid("root_workflow_step_exe_id"), // UUID reference
  completedBy: text("completed_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // Removed: workspaceId, deletedAt
})

// 5. Workflow Step Executions Table (renamed from workflow_step_executions)
export const workflowStepExecution = pgTable("workflow_step_execution", {
  id: uuid("id").notNull().primaryKey().defaultRandom(),
  workflowExecutionId: uuid("workflow_execution_id")
    .notNull()
    .references(() => workflowExecution.id),
  workflowStepTemplateId: uuid("workflow_step_template_id")
    .notNull()
    .references(() => workflowStepTemplate.id),
  name: text("name").notNull(),
  type: stepTypeEnum("type").notNull().default(StepType.AUTOMATED),
  status: workflowStatusEnum("status").notNull().default(WorkflowStatus.DRAFT), // Using workflow status instead of step status
  parentStepId: uuid("parent_step_id"), // UUID reference
  prevStepIds: uuidArray("prev_step_ids").default([]), // Array of UUIDs
  nextStepIds: uuidArray("next_step_ids").default([]), // Array of UUIDs
  toolExecIds: uuidArray("tool_exec_ids").default([]), // Renamed from toolIds, array of UUIDs
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
  // Removed: deletedAt
})

// 6. Tool Executions Table (renamed from workflow_tool_executions)
export const toolExecution = pgTable("tool_execution", {
  id: uuid("id").notNull().primaryKey().defaultRandom(),
  workflowToolId: uuid("workflow_tool_id") // Renamed from toolId
    .notNull()
    .references(() => workflowTool.id),
  workflowExecutionId: uuid("workflow_execution_id").notNull(), // Renamed from stepId
  status: toolExecutionStatusEnum("status").notNull().default(ToolExecutionStatus.PENDING),
  result: jsonb("result"), // Execution result/output
  // Removed: errorMessage column
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
export const selectWorkflowTemplateSchema = createSelectSchema(workflowTemplate)
export const selectWorkflowStepTemplateSchema =
  createSelectSchema(workflowStepTemplate)
export const selectWorkflowToolSchema = createSelectSchema(workflowTool)
export const selectWorkflowExecutionSchema =
  createSelectSchema(workflowExecution)
export const selectWorkflowStepExecutionSchema = createSelectSchema(
  workflowStepExecution,
)
export const selectToolExecutionSchema = createSelectSchema(toolExecution)

export const insertWorkflowTemplateSchema = createInsertSchema(workflowTemplate)
export const insertWorkflowStepTemplateSchema =
  createInsertSchema(workflowStepTemplate)
export const insertWorkflowToolSchema = createInsertSchema(workflowTool)
export const insertWorkflowExecutionSchema =
  createInsertSchema(workflowExecution)
export const insertWorkflowStepExecutionSchema = createInsertSchema(
  workflowStepExecution,
)
export const insertToolExecutionSchema = createInsertSchema(toolExecution)

// Types
export type SelectWorkflowTemplate = z.infer<
  typeof selectWorkflowTemplateSchema
>
export type SelectWorkflowStepTemplate = z.infer<
  typeof selectWorkflowStepTemplateSchema
>
export type SelectWorkflowTool = z.infer<typeof selectWorkflowToolSchema>
export type SelectWorkflowExecution = z.infer<
  typeof selectWorkflowExecutionSchema
>
export type SelectWorkflowStepExecution = z.infer<
  typeof selectWorkflowStepExecutionSchema
>
export type SelectToolExecution = z.infer<typeof selectToolExecutionSchema>

export type InsertWorkflowTemplate = z.infer<
  typeof insertWorkflowTemplateSchema
>
export type InsertWorkflowStepTemplate = z.infer<
  typeof insertWorkflowStepTemplateSchema
>
export type InsertWorkflowTool = z.infer<typeof insertWorkflowToolSchema>
export type InsertWorkflowExecution = z.infer<
  typeof insertWorkflowExecutionSchema
>
export type InsertWorkflowStepExecution = z.infer<
  typeof insertWorkflowStepExecutionSchema
>
export type InsertToolExecution = z.infer<typeof insertToolExecutionSchema>

// Public schemas (for API responses)
export const publicWorkflowTemplateSchema = selectWorkflowTemplateSchema
  .omit({
    workspaceId: true,
    userId: true,
  })

export const publicWorkflowExecutionSchema = selectWorkflowExecutionSchema.omit(
  {
    completedBy: true,
  },
)
export const publicWorkflowToolSchema = selectWorkflowToolSchema

export type PublicWorkflowTemplate = z.infer<
  typeof publicWorkflowTemplateSchema
>
export type PublicWorkflowExecution = z.infer<
  typeof publicWorkflowExecutionSchema
>
export type PublicWorkflowTool = z.infer<typeof publicWorkflowToolSchema>

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
  workflowTemplateId: z.uuid(),
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
  createWorkflowTemplateSchema.partial().extend({
    isPublic: z.boolean().optional(),
    status: z.enum(WorkflowStatus).optional(),
    userEmails: z
      .array(z.email())
      .min(1)
      .transform((arr) => Array.from(new Set(arr.map((e) => e.toLowerCase()))))
      .optional(),
  })

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
  workflowTemplateId: z.uuid(),
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
