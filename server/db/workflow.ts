import { eq, desc, and, or } from "drizzle-orm"
import type { TxnOrClient } from "@/types"
import {
  workflowTemplate,
  workflowStepTemplate,
  workflowExecution,
  workflowStepExecution,
  selectWorkflowTemplateSchema,
  type SelectWorkflowTemplate,
  type SelectWorkflowStepTemplate,
  type SelectWorkflowExecution,
  type SelectWorkflowStepExecution,
  type InsertWorkflowTemplate,
  type InsertWorkflowExecution,
  type InsertWorkflowStepExecution,
  insertWorkflowStepTemplateSchema,
  selectWorkflowStepTemplateSchema,
  type InsertWorkflowStepTemplate,
  insertWorkflowExecutionSchema,
  selectWorkflowExecutionSchema,
  selectWorkflowStepExecutionSchema,
} from "@/db/schema"
import { StepType, WorkflowStatus } from "@/types/workflowTypes"
import z from "zod"

// Workflow Template Operations
export const createWorkflowTemplate = async (
  trx: TxnOrClient,
  data: {
    name: string
    userId: number
    workspaceId: number
    isPublic?: boolean
    description?: string
    version?: string
    config?: any
    rootWorkflowStepTemplateId?: string
  },
): Promise<SelectWorkflowTemplate> => {
  const [template] = await trx
    .insert(workflowTemplate)
    .values({
      name: data.name,
      userId: data.userId,
      workspaceId: data.workspaceId,
      isPublic: data.isPublic,
      description: data.description,
      version: data.version || "1.0.0",
      config: data.config || {},
      rootWorkflowStepTemplateId: data.rootWorkflowStepTemplateId,
    })
    .returning()

  return selectWorkflowTemplateSchema.parse(template)
}

// Get template and validate (allow access to user's own or public templates)
export const getWorkflowTemplateByIdWithPublicCheck = async (
  trx: TxnOrClient,
  id: string,
  workspaceId: number,
  userId: number
): Promise<SelectWorkflowTemplate | null> => {
  const [template] = await trx
    .select()
    .from(workflowTemplate)
    .where(and(
      eq(workflowTemplate.id, id),
      eq(workflowTemplate.workspaceId, workspaceId),
      or(
        eq(workflowTemplate.isPublic, true),
        eq(workflowTemplate.userId, userId),
      )
    ))
    .limit(1)

  return template ? selectWorkflowTemplateSchema.parse(template) : null
}

export const getAccessibleWorkflowTemplates = async (
  trx: TxnOrClient,
  workspaceId: number,
  userId: number,
): Promise<SelectWorkflowTemplate[]> => {
  const templates = await trx
    .select()
    .from(workflowTemplate)
    .where(and(
      eq(workflowTemplate.workspaceId, workspaceId),
      or(
        eq(workflowTemplate.isPublic, true),
        eq(workflowTemplate.userId, userId),
      )
    ))
    .orderBy(desc(workflowTemplate.createdAt))

  return z.array(selectWorkflowTemplateSchema).parse(templates)
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

  return selectWorkflowTemplateSchema.parse(updated)
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
): Promise<InsertWorkflowStepTemplate> => {
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

  return insertWorkflowStepTemplateSchema.parse(step)
}

export const getWorkflowStepTemplateById = async(
  trx: TxnOrClient,
  id: string,
): Promise<SelectWorkflowStepTemplate | null> => {
  const [step] = await trx
    .select()
    .from(workflowStepTemplate)
    .where(eq(workflowStepTemplate.id, id))
    .limit(1)

  return selectWorkflowStepTemplateSchema.parse(step)
}

export const getWorkflowStepTemplatesByTemplateId = async (
  trx: TxnOrClient,
  workflowTemplateId: string,
): Promise<SelectWorkflowStepTemplate[]> => {
  const steps = await trx
    .select()
    .from(workflowStepTemplate)
    .where(eq(workflowStepTemplate.workflowTemplateId, workflowTemplateId))
    .orderBy(workflowStepTemplate.createdAt)

  return z.array(selectWorkflowStepTemplateSchema).parse(steps)
}

// Workflow Execution Operations
export const createWorkflowExecution = async (
  trx: TxnOrClient,
  data: {
    workflowTemplateId: string
    workspaceId: number
    userId: number
    name: string
    description?: string
    metadata?: any
    status?: WorkflowStatus
  },
): Promise<SelectWorkflowExecution> => {
  const [execution] = await trx
    .insert(workflowExecution)
    .values({
      workflowTemplateId: data.workflowTemplateId,
      userId: data.userId,
      workspaceId: data.workspaceId,
      name: data.name,
      description: data.description,
      metadata: data.metadata || {},
      status: data.status,
    })
    .returning()

  return selectWorkflowExecutionSchema.parse(execution)
}

export const getWorkflowExecutionByIdWithChecks = async (
  trx: TxnOrClient,
  id: string,
  workspaceId: number,
  userId: number,
): Promise<SelectWorkflowExecution | null> => {
  const [execution] = await trx
    .select()
    .from(workflowExecution)
    .where(and(
      eq(workflowExecution.workspaceId, workspaceId),
      eq(workflowExecution.userId, userId),
      eq(workflowExecution.id, id),
    ))
    .limit(1)

  return selectWorkflowExecutionSchema.parse(execution)
}

export const getWorkflowExecutionById = async (
  trx: TxnOrClient,
  id: string,
): Promise<SelectWorkflowExecution | null> => {
  const [execution] = await trx
    .select()
    .from(workflowExecution)
    .where(and(
      eq(workflowExecution.id, id),
    ))
    .limit(1)

  return selectWorkflowExecutionSchema.parse(execution)
}

export const getAccessibleWorkflowExecutions = async (
  trx: TxnOrClient,
  workspaceId: number,
  userId: number,
): Promise<SelectWorkflowExecution[]> => {
  const executions = await trx
    .select()
    .from(workflowExecution)
    .where(and(
      eq(workflowExecution.workspaceId, workspaceId),
      eq(workflowExecution.userId, userId),
    ))
    .orderBy(desc(workflowExecution.createdAt))

  return z.array(selectWorkflowExecutionSchema).parse(executions)
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

  return selectWorkflowExecutionSchema.parse(updated)
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

  return selectWorkflowStepExecutionSchema.parse(stepExecution)
}

export const createWorkflowStepExecutions = async (
  trx: TxnOrClient,
  stepExecutionsData: Array<{
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
  }>,
): Promise<SelectWorkflowStepExecution[]> => {
  if (stepExecutionsData.length === 0) return []

  const insertValues = stepExecutionsData.map((data) => ({
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
  }))

  const stepExecutions = await trx
    .insert(workflowStepExecution)
    .values(insertValues)
    .returning()

  return z.array(selectWorkflowStepExecutionSchema).parse(stepExecutions)
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
  
  return z.array(selectWorkflowStepExecutionSchema).parse(results)
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

  return selectWorkflowStepExecutionSchema.parse(stepExecution)
}

export const updateWorkflowStepExecution = async (
  trx: TxnOrClient,
  id: string,
  data: Partial<InsertWorkflowStepExecution>,
): Promise<SelectWorkflowStepExecution | null> => {
  const updateData: any = {
    ...data,
    updatedAt: new Date(),
  }

  // Ensure array fields are properly typed
  if (data.prevStepIds) {
    updateData.prevStepIds = Array.from(data.prevStepIds)
  }
  if (data.nextStepIds) {
    updateData.nextStepIds = Array.from(data.nextStepIds)
  }
  if (data.toolExecIds) {
    updateData.toolExecIds = Array.from(data.toolExecIds)
  }

  const [updated] = await trx
    .update(workflowStepExecution)
    .set(updateData)
    .where(eq(workflowStepExecution.id, id))
    .returning()

  return selectWorkflowStepExecutionSchema.parse(updated)
}
