import { and, eq, desc } from "drizzle-orm"
import type { TxnOrClient } from "@/types"
import {
  workflowTemplate,
  workflowStepTemplate,
  workflowExecution,
  workflowStepExecution,
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
import { StepType } from "@/types/workflowTypes"

// Workflow Template Operations
export const createWorkflowTemplate = async (
  trx: TxnOrClient,
  data: {
    name: string
    description?: string
    version?: string
    config?: any
    createdBy?: string
    rootWorkflowStepTemplateId?: string
  },
): Promise<SelectWorkflowTemplate> => {
  const [template] = await trx
    .insert(workflowTemplate)
    .values({
      name: data.name,
      description: data.description,
      version: data.version || "1.0.0",
      config: data.config || {},
      createdBy: data.createdBy,
      rootWorkflowStepTemplateId: data.rootWorkflowStepTemplateId,
    })
    .returning()

  return selectWorkflowTemplateSchema.parse(template)
}

export const getWorkflowTemplateById = async (
  trx: TxnOrClient,
  id: string,
): Promise<SelectWorkflowTemplate | null> => {
  const [template] = await trx
    .select()
    .from(workflowTemplate)
    .where(eq(workflowTemplate.id, id))
    .limit(1)

  return template ? selectWorkflowTemplateSchema.parse(template) : null
}

export const getAllWorkflowTemplates = async (
  trx: TxnOrClient,
): Promise<SelectWorkflowTemplate[]> => {
  const templates = await trx
    .select()
    .from(workflowTemplate)
    .orderBy(desc(workflowTemplate.createdAt))

  return templates as SelectWorkflowTemplate[]
}

export const updateWorkflowTemplate = async (
  trx: TxnOrClient,
  id: string,
  data: Partial<InsertWorkflowTemplate>,
): Promise<SelectWorkflowTemplate | null> => {
  const [updated] = await trx
    .update(workflowTemplate)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(workflowTemplate.id, id))
    .returning()

  return updated ? (updated as SelectWorkflowTemplate) : null
}

// Workflow Step Template Operations
export const createWorkflowStepTemplate = async (
  trx: TxnOrClient,
  data: {
    workflowTemplateId: string
    name: string
    description?: string
    type: StepType
    parentStepId?: string
    prevStepIds?: string[]
    nextStepIds?: string[]
    toolIds?: string[]
    timeEstimate?: number
    metadata?: any
  },
): Promise<SelectWorkflowStepTemplate> => {
  const [step] = await trx
    .insert(workflowStepTemplate)
    .values({
      workflowTemplateId: data.workflowTemplateId,
      name: data.name,
      description: data.description,
      type: data.type,
      parentStepId: data.parentStepId,
      prevStepIds: data.prevStepIds || [],
      nextStepIds: data.nextStepIds || [],
      toolIds: data.toolIds || [],
      timeEstimate: data.timeEstimate || 0,
      metadata: data.metadata || {},
    })
    .returning()

  return step as SelectWorkflowStepTemplate
}

export const getWorkflowStepTemplatesByTemplate = async (
  trx: TxnOrClient,
  workflowTemplateId: string,
): Promise<SelectWorkflowStepTemplate[]> => {
  const steps = await trx
    .select()
    .from(workflowStepTemplate)
    .where(eq(workflowStepTemplate.workflowTemplateId, workflowTemplateId))
    .orderBy(workflowStepTemplate.createdAt)

  return steps as SelectWorkflowStepTemplate[]
}

// Workflow Execution Operations
export const createWorkflowExecution = async (
  trx: TxnOrClient,
  data: {
    workflowTemplateId: string
    name: string
    description?: string
    createdBy?: string
    metadata?: any
  },
): Promise<SelectWorkflowExecution> => {
  const [execution] = await trx
    .insert(workflowExecution)
    .values({
      workflowTemplateId: data.workflowTemplateId,
      name: data.name,
      description: data.description,
      createdBy: data.createdBy,
      metadata: data.metadata || {},
    })
    .returning()

  return execution as SelectWorkflowExecution
}

export const getWorkflowExecutionById = async (
  trx: TxnOrClient,
  id: string,
): Promise<SelectWorkflowExecution | null> => {
  const [execution] = await trx
    .select()
    .from(workflowExecution)
    .where(eq(workflowExecution.id, id))
    .limit(1)

  return execution ? (execution as SelectWorkflowExecution) : null
}

export const getAllWorkflowExecutions = async (
  trx: TxnOrClient,
): Promise<SelectWorkflowExecution[]> => {
  const executions = await trx
    .select()
    .from(workflowExecution)
    .orderBy(desc(workflowExecution.createdAt))

  return executions as SelectWorkflowExecution[]
}

export const updateWorkflowExecution = async (
  trx: TxnOrClient,
  id: string,
  data: Partial<InsertWorkflowExecution>,
): Promise<SelectWorkflowExecution | null> => {
  const [updated] = await trx
    .update(workflowExecution)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(workflowExecution.id, id))
    .returning()

  return updated ? ({ ...updated, metadata: updated.metadata as any }) : null
}

// Workflow Step Execution Operations
export const createWorkflowStepExecution = async (
  trx: TxnOrClient,
  data: {
    workflowExecutionId: string
    workflowStepTemplateId: string
    name: string
    type: StepType
    parentStepId?: string
    prevStepIds?: string[]
    nextStepIds?: string[]
    toolExecIds?: string[]
    timeEstimate?: number
    metadata?: any
  },
): Promise<SelectWorkflowStepExecution> => {
  const [stepExecution] = await trx
    .insert(workflowStepExecution)
    .values({
      workflowExecutionId: data.workflowExecutionId,
      workflowStepTemplateId: data.workflowStepTemplateId,
      name: data.name,
      type: data.type,
      parentStepId: data.parentStepId,
      prevStepIds: data.prevStepIds || [],
      nextStepIds: data.nextStepIds || [],
      toolExecIds: data.toolExecIds || [],
      timeEstimate: data.timeEstimate || 0,
      metadata: data.metadata || {},
    })
    .returning()

  return stepExecution as SelectWorkflowStepExecution
}

export const getWorkflowStepExecutionsByExecution = async (
  trx: TxnOrClient,
  workflowExecutionId: string,
): Promise<SelectWorkflowStepExecution[]> => {
  const results = await trx
    .select()
    .from(workflowStepExecution)
    .where(eq(workflowStepExecution.workflowExecutionId, workflowExecutionId))
    .orderBy(workflowStepExecution.createdAt)
  
  return results.map(result => ({ ...result, metadata: result.metadata as any }))
}

export const getWorkflowStepExecutionById = async (
  trx: TxnOrClient,
  id: string,
): Promise<SelectWorkflowStepExecution | null> => {
  const [stepExecution] = await trx
    .select()
    .from(workflowStepExecution)
    .where(eq(workflowStepExecution.id, id))
    .limit(1)

  return stepExecution ? ({ ...stepExecution, metadata: stepExecution.metadata as any }) : null
}

export const updateWorkflowStepExecution = async (
  trx: TxnOrClient,
  id: string,
  data: Partial<InsertWorkflowStepExecution>,
): Promise<SelectWorkflowStepExecution | null> => {
  const [updated] = await trx
    .update(workflowStepExecution)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(workflowStepExecution.id, id))
    .returning()

  return updated ? ({ ...updated, metadata: updated.metadata as any }) : null
}
