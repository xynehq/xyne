import { eq, desc, and, or } from "drizzle-orm"
import type { TxnOrClient } from "@/types"
import {
  workflowTemplate,
  workflowStepTemplate,
  workflowExecution,
  workflowStepExecution,
  selectWorkflowTemplateSchema,
  userWorkflowPermissions,
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
import { UserWorkflowRole } from "@/shared/types"
import { grantUserWorkflowPermission } from "@/db/userWorkflowPermissions"
import { z } from "zod"

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

  // grant permission for the creator
  await grantUserWorkflowPermission(trx, {
    userId: data.userId,
    workflowId: template.id,
    role: UserWorkflowRole.Owner,
  })

  return selectWorkflowTemplateSchema.parse(template)
}

// Get template and validate (allow access to user's own, public templates, or shared via permissions)
export const getWorkflowTemplateByIdWithPermissionCheck = async (
  trx: TxnOrClient,
  id: string,
  workspaceId: number,
  userId: number,
): Promise<SelectWorkflowTemplate | null> => {
  const [template] = await trx
    .selectDistinct({
      id: workflowTemplate.id,
      name: workflowTemplate.name,
      workspaceId: workflowTemplate.workspaceId,
      userId: workflowTemplate.userId,
      isPublic: workflowTemplate.isPublic,
      description: workflowTemplate.description,
      version: workflowTemplate.version,
      status: workflowTemplate.status,
      config: workflowTemplate.config,
      rootWorkflowStepTemplateId: workflowTemplate.rootWorkflowStepTemplateId,
      createdAt: workflowTemplate.createdAt,
      updatedAt: workflowTemplate.updatedAt,
    })
    .from(workflowTemplate)
    .leftJoin(
      userWorkflowPermissions,
      eq(workflowTemplate.id, userWorkflowPermissions.workflowId),
    )
    .where(
      and(
        eq(workflowTemplate.id, id),
        eq(workflowTemplate.workspaceId, workspaceId),
        or(
          eq(workflowTemplate.isPublic, true),
          eq(userWorkflowPermissions.userId, userId),
        ),
      ),
    )
    .limit(1)

  return template ? selectWorkflowTemplateSchema.parse(template) : null
}

// gets workflow templates along with the queried user's role for each
export const getAccessibleWorkflowTemplatesWithRole = async (
  trx: TxnOrClient,
  workspaceId: number,
  userId: number,
): Promise<(
  SelectWorkflowTemplate & {
    role: string
  })[]> => {
  const templates = await trx
    .selectDistinct({
      id: workflowTemplate.id,
      name: workflowTemplate.name,
      workspaceId: workflowTemplate.workspaceId,
      userId: workflowTemplate.userId,
      isPublic: workflowTemplate.isPublic,
      description: workflowTemplate.description,
      version: workflowTemplate.version,
      status: workflowTemplate.status,
      config: workflowTemplate.config,
      rootWorkflowStepTemplateId: workflowTemplate.rootWorkflowStepTemplateId,
      createdAt: workflowTemplate.createdAt,
      updatedAt: workflowTemplate.updatedAt,
      role: userWorkflowPermissions.role,
    })
    .from(workflowTemplate)
    .leftJoin(
      userWorkflowPermissions,
      eq(workflowTemplate.id, userWorkflowPermissions.workflowId),
    )
    .where(
      and(
        eq(workflowTemplate.workspaceId, workspaceId),
        or(
          eq(workflowTemplate.isPublic, true),
          eq(userWorkflowPermissions.userId, userId),
        ),
      ),
    )
  
  if (!templates || templates.length === 0) {
    return []
  }

  // Add role field based on ownership and permissions
  return templates.map(template => ({
    ...selectWorkflowTemplateSchema.parse(template),
    role: template.role || UserWorkflowRole.Viewer //default user role for public workflow
  }))
}

export const updateWorkflowTemplateById = async (
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

  return updated ? selectWorkflowTemplateSchema.parse(updated) : null
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

export const getWorkflowStepTemplateById = async (
  trx: TxnOrClient,
  id: string,
): Promise<SelectWorkflowStepTemplate | null> => {
  const [step] = await trx
    .select()
    .from(workflowStepTemplate)
    .where(eq(workflowStepTemplate.id, id))
    .limit(1)

  return step ? selectWorkflowStepTemplateSchema.parse(step) : null
}

export const getWorkflowStepTemplatesByTemplateId = async (
  trx: TxnOrClient,
  workflowTemplateId: string,
): Promise<SelectWorkflowStepTemplate[]> => {
  const steps = await trx
    .select()
    .from(workflowStepTemplate)
    .where(eq(workflowStepTemplate.workflowTemplateId, workflowTemplateId))

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
  userId: number
): Promise<SelectWorkflowExecution | null> => {
  const [execution] = await trx
    .select()
    .from(workflowExecution)
    .where(
      and(
        eq(workflowExecution.workspaceId, workspaceId),
        eq(workflowExecution.userId, userId),
        eq(workflowExecution.id, id),
      ),
    )
    .limit(1)

  return execution ? selectWorkflowExecutionSchema.parse(execution) : null
}

export const getWorkflowExecutionById = async (
  trx: TxnOrClient,
  id: string,
): Promise<SelectWorkflowExecution | null> => {
  const [execution] = await trx
    .select()
    .from(workflowExecution)
    .where(and(eq(workflowExecution.id, id)))
    .limit(1)

  return execution ? selectWorkflowExecutionSchema.parse(execution) : null
}

export const getAccessibleWorkflowExecutions = async (
  trx: TxnOrClient,
  workspaceId: number,
  userId: number,
): Promise<SelectWorkflowExecution[]> => {
  const executions = await trx
    .select()
    .from(workflowExecution)
    .where(
      and(
        eq(workflowExecution.workspaceId, workspaceId),
        eq(workflowExecution.userId, userId),
      ),
    )

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

  return updated ? selectWorkflowExecutionSchema.parse(updated) : null
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

export const createWorkflowStepExecutionsFromSteps = async (
  trx: TxnOrClient,
  workflowExecutionId: string,
  stepTemplates: SelectWorkflowStepTemplate[],
): Promise<SelectWorkflowStepExecution[]> => {
  if (stepTemplates.length === 0) return []

  const insertValues = stepTemplates.map((step) => ({
    workflowExecutionId,
    workflowStepTemplateId: step.id,
    name: step.name,
    type: step.type,
    status: WorkflowStatus.DRAFT, // Default status from table schema
    parentStepId: step.parentStepId,
    prevStepIds: (step.prevStepIds as string[]) || [],
    nextStepIds: (step.nextStepIds as string[]) || [],
    toolExecIds: [], // updated when tools execute
    timeEstimate: step.timeEstimate || 0,
    metadata: step.metadata || {},
    completedBy: null, // No one has completed it yet
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

  return z.array(selectWorkflowStepExecutionSchema).parse(results)
}

export const getWorkflowStepExecutionByIdWithChecks = async (
  trx: TxnOrClient,
  id: string,
  workspaceId: number,
  userId: number,
): Promise<SelectWorkflowStepExecution | null> => {
  const result = await trx
    .select({
      stepExecution: workflowStepExecution,
    })
    .from(workflowStepExecution)
    .innerJoin(
      workflowExecution,
      eq(workflowStepExecution.workflowExecutionId, workflowExecution.id)
    )
    .where(
      and(
        eq(workflowStepExecution.id, id),
        eq(workflowExecution.userId, userId),
        eq(workflowExecution.workspaceId, workspaceId)
      )
    )
    .limit(1)
  
  if (!result || result.length === 0) {
    return null
  }

  const stepExecution = result[0].stepExecution

  return stepExecution
    ? selectWorkflowStepExecutionSchema.parse(stepExecution)
    : null
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

  return updated ? selectWorkflowStepExecutionSchema.parse(updated) : null
}
