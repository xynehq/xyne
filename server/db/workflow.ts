import { and, eq, desc, isNull } from "drizzle-orm"
import { createId } from "@paralleldrive/cuid2"
import type { TxnOrClient } from "@/types"
import {
  workflowTemplates,
  workflowStepTemplates,
  workflowExecutions,
  workflowStepExecutions,
  users,
  selectWorkflowTemplateSchema,
  selectWorkflowStepTemplateSchema,
  selectWorkflowExecutionSchema,
  selectWorkflowStepExecutionSchema,
  type SelectWorkflowTemplate,
  type SelectWorkflowStepTemplate,
  type SelectWorkflowExecution,
  type SelectWorkflowStepExecution,
  type InsertWorkflowTemplate,
  type InsertWorkflowStepTemplate,
  type InsertWorkflowExecution,
  type InsertWorkflowStepExecution,
} from "@/db/schema"

// Workflow Template Operations
export const createWorkflowTemplate = async (
  trx: TxnOrClient,
  workspaceId: number,
  createdBy: number,
  data: {
    name: string
    description?: string
    version?: string
    config?: any
  },
): Promise<SelectWorkflowTemplate> => {
  const externalId = createId()

  const [template] = await trx
    .insert(workflowTemplates)
    .values({
      externalId,
      workspaceId,
      createdBy,
      name: data.name,
      description: data.description,
      version: data.version || "1.0.0",
      config: data.config || {},
    })
    .returning()

  return selectWorkflowTemplateSchema.parse(template)
}

export const getWorkflowTemplateById = async (
  trx: TxnOrClient,
  externalId: string,
  workspaceId: number,
): Promise<SelectWorkflowTemplate | null> => {
  const [template] = await trx
    .select()
    .from(workflowTemplates)
    .where(
      and(
        eq(workflowTemplates.externalId, externalId),
        eq(workflowTemplates.workspaceId, workspaceId),
        isNull(workflowTemplates.deletedAt),
      ),
    )
    .limit(1)

  return template ? selectWorkflowTemplateSchema.parse(template) : null
}

export const getWorkflowTemplatesByWorkspace = async (
  trx: TxnOrClient,
  workspaceId: number,
): Promise<SelectWorkflowTemplate[]> => {
  const templates = await trx
    .select()
    .from(workflowTemplates)
    .where(
      and(
        eq(workflowTemplates.workspaceId, workspaceId),
        isNull(workflowTemplates.deletedAt),
      ),
    )
    .orderBy(desc(workflowTemplates.createdAt))

  return templates as SelectWorkflowTemplate[]
}

export const updateWorkflowTemplate = async (
  trx: TxnOrClient,
  externalId: string,
  workspaceId: number,
  data: Partial<InsertWorkflowTemplate>,
): Promise<SelectWorkflowTemplate | null> => {
  const [updated] = await trx
    .update(workflowTemplates)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workflowTemplates.externalId, externalId),
        eq(workflowTemplates.workspaceId, workspaceId),
        isNull(workflowTemplates.deletedAt),
      ),
    )
    .returning()

  return updated ? (updated as SelectWorkflowTemplate) : null
}

// Workflow Step Template Operations
export const createWorkflowStepTemplate = async (
  trx: TxnOrClient,
  data: {
    workflowTemplateId: number
    name: string
    description?: string
    type: "manual" | "automated"
    parentStepId?: string
    nextStepIds?: string[]
    toolIds?: string
    timeEstimate?: number
    metadata?: any
  },
): Promise<SelectWorkflowStepTemplate> => {
  const externalId = createId()

  const [step] = await trx
    .insert(workflowStepTemplates)
    .values({
      externalId,
      workflowTemplateId: data.workflowTemplateId,
      name: data.name,
      description: data.description,
      type: data.type,
      parentStepId: data.parentStepId,
      nextStepIds: data.nextStepIds || [],
      toolIds: data.toolIds,
      timeEstimate: data.timeEstimate || 0,
      metadata: data.metadata || {},
    })
    .returning()

  return step as SelectWorkflowStepTemplate
}

export const getWorkflowStepTemplatesByTemplate = async (
  trx: TxnOrClient,
  workflowTemplateId: number,
): Promise<SelectWorkflowStepTemplate[]> => {
  const steps = await trx
    .select()
    .from(workflowStepTemplates)
    .where(
      and(
        eq(workflowStepTemplates.workflowTemplateId, workflowTemplateId),
        isNull(workflowStepTemplates.deletedAt),
      ),
    )
    .orderBy(workflowStepTemplates.createdAt)

  return steps as SelectWorkflowStepTemplate[]
}

// Workflow Execution Operations
export const createWorkflowExecution = async (
  trx: TxnOrClient,
  data: {
    workspaceId: number
    workflowTemplateId: number
    createdBy: number
    name: string
    description?: string
    metadata?: any
  },
): Promise<SelectWorkflowExecution> => {
  const externalId = createId()

  const [execution] = await trx
    .insert(workflowExecutions)
    .values({
      externalId,
      workspaceId: data.workspaceId,
      workflowTemplateId: data.workflowTemplateId,
      createdBy: data.createdBy,
      name: data.name,
      description: data.description,
      metadata: data.metadata || {},
    })
    .returning()

  return execution as SelectWorkflowExecution
}

export const getWorkflowExecutionById = async (
  trx: TxnOrClient,
  externalId: string,
  workspaceId: number,
): Promise<SelectWorkflowExecution | null> => {
  const [execution] = await trx
    .select()
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.externalId, externalId),
        eq(workflowExecutions.workspaceId, workspaceId),
        isNull(workflowExecutions.deletedAt),
      ),
    )
    .limit(1)

  return execution ? (execution as SelectWorkflowExecution) : null
}

export const getWorkflowExecutionsByWorkspace = async (
  trx: TxnOrClient,
  workspaceId: number,
): Promise<SelectWorkflowExecution[]> => {
  const executions = await trx
    .select()
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.workspaceId, workspaceId),
        isNull(workflowExecutions.deletedAt),
      ),
    )
    .orderBy(desc(workflowExecutions.createdAt))

  return executions as SelectWorkflowExecution[]
}

export const updateWorkflowExecution = async (
  trx: TxnOrClient,
  externalId: string,
  workspaceId: number,
  data: Partial<InsertWorkflowExecution>,
): Promise<SelectWorkflowExecution | null> => {
  const [updated] = await trx
    .update(workflowExecutions)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workflowExecutions.externalId, externalId),
        eq(workflowExecutions.workspaceId, workspaceId),
        isNull(workflowExecutions.deletedAt),
      ),
    )
    .returning()

  return updated || null
}

// Workflow Step Execution Operations
export const createWorkflowStepExecution = async (
  trx: TxnOrClient,
  data: {
    workflowExecutionId: number
    workflowStepTemplateId: number
    name: string
    type: "manual" | "automated"
    parentStepId?: string
    nextStepIds?: string[]
    toolIds?: string
    timeEstimate?: number
    metadata?: any
  },
): Promise<SelectWorkflowStepExecution> => {
  const externalId = createId()

  const [stepExecution] = await trx
    .insert(workflowStepExecutions)
    .values({
      externalId,
      workflowExecutionId: data.workflowExecutionId,
      workflowStepTemplateId: data.workflowStepTemplateId,
      name: data.name,
      type: data.type,
      parentStepId: data.parentStepId,
      nextStepIds: data.nextStepIds || [],
      toolIds: data.toolIds,
      timeEstimate: data.timeEstimate || 0,
      metadata: data.metadata || {},
    })
    .returning()

  return stepExecution
}

export const getWorkflowStepExecutionsByExecution = async (
  trx: TxnOrClient,
  workflowExecutionId: number,
): Promise<SelectWorkflowStepExecution[]> => {
  return await trx
    .select()
    .from(workflowStepExecutions)
    .where(
      and(
        eq(workflowStepExecutions.workflowExecutionId, workflowExecutionId),
        isNull(workflowStepExecutions.deletedAt),
      ),
    )
    .orderBy(workflowStepExecutions.createdAt)
}

export const getWorkflowStepExecutionById = async (
  trx: TxnOrClient,
  externalId: string,
): Promise<SelectWorkflowStepExecution | null> => {
  const [stepExecution] = await trx
    .select()
    .from(workflowStepExecutions)
    .where(
      and(
        eq(workflowStepExecutions.externalId, externalId),
        isNull(workflowStepExecutions.deletedAt),
      ),
    )
    .limit(1)

  return stepExecution || null
}

export const updateWorkflowStepExecution = async (
  trx: TxnOrClient,
  externalId: string,
  data: Partial<InsertWorkflowStepExecution>,
): Promise<SelectWorkflowStepExecution | null> => {
  const [updated] = await trx
    .update(workflowStepExecutions)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workflowStepExecutions.externalId, externalId),
        isNull(workflowStepExecutions.deletedAt),
      ),
    )
    .returning()

  return updated || null
}
