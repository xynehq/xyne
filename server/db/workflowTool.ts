import { and, eq, desc, inArray } from "drizzle-orm"
import type { TxnOrClient } from "@/types"
import {
  workflowTool,
  toolExecution,
  type SelectWorkflowTool,
  type SelectToolExecution,
  type InsertWorkflowTool,
  type InsertToolExecution,
} from "@/db/schema"
import { ToolType, ToolExecutionStatus } from "@/types/workflowTypes"

// Tool Operations
export const createWorkflowTool = async (
  trx: TxnOrClient,
  data: {
    type: ToolType
    workspaceId: number,
    userId: number,
    value?: string | number | Record<string, any>
    config?: Record<string, any>
  },
): Promise<SelectWorkflowTool> => {
  const [tool] = await trx
    .insert(workflowTool)
    .values({
      type: data.type,
      workspaceId: data.workspaceId,
      userId: data.userId,
      value: data.value,
      config: data.config || {},
    })
    .returning()

  return tool as SelectWorkflowTool
}

export const getWorkflowToolById = async (
  trx: TxnOrClient,
  id: string,
): Promise<SelectWorkflowTool | null> => {
  const [tool] = await trx
    .select()
    .from(workflowTool)
    .where(eq(workflowTool.id, id))
    .limit(1)

  return tool ? ({ ...tool, value: tool.value as any, config: tool.config as any }) : null
}

export const getWorkflowToolByIdWithChecks = async (
  trx: TxnOrClient,
  id: string,
  workspaceId: number,
  userId: number,
): Promise<SelectWorkflowTool | null> => {
  const [tool] = await trx
    .select()
    .from(workflowTool)
    .where(and(
      eq(workflowTool.id, id),
      eq(workflowTool.workspaceId, workspaceId),
      eq(workflowTool.userId, userId),
    ))
    .limit(1)

  return tool ? ({ ...tool, value: tool.value as any, config: tool.config as any }) : null
}

export const getAccessibleWorkflowTools = async (
  trx: TxnOrClient,
  workspaceId: number,
  userId: number,
): Promise<SelectWorkflowTool[]> => {
  const results = await trx
    .select()
    .from(workflowTool)
    .where(and(
      eq(workflowTool.workspaceId, workspaceId),
      eq(workflowTool.userId, userId),
    ))
    .orderBy(desc(workflowTool.createdAt))
  
  return results.map(result => ({ ...result, value: result.value as any, config: result.config as any }))
}


export const getAllWorkflowTools = async (
  trx: TxnOrClient,
): Promise<SelectWorkflowTool[]> => {
  const results = await trx
    .select()
    .from(workflowTool)
    .orderBy(desc(workflowTool.createdAt))
  
  return results.map(result => ({ ...result, value: result.value as any, config: result.config as any }))
}

export const getWorkflowToolsByIds = async (
  trx: TxnOrClient,
  toolIds: string[],
): Promise<SelectWorkflowTool[]> => {
  if (toolIds.length === 0) return []
  
  const results = await trx
    .select()
    .from(workflowTool)
    .where(inArray(workflowTool.id, toolIds))
    .orderBy(desc(workflowTool.createdAt))
  
  return results.map(result => ({ ...result, value: result.value as any, config: result.config as any }))
}

export const updateWorkflowTool = async (
  trx: TxnOrClient,
  id: string,
  data: Partial<InsertWorkflowTool>,
): Promise<SelectWorkflowTool | null> => {
  const [updated] = await trx
    .update(workflowTool)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(workflowTool.id, id))
    .returning()

  return updated ? ({ ...updated, value: updated.value as any, config: updated.config as any }) : null
}

// Note: The new schema doesn't have soft deletes (deletedAt field)
// This function now performs hard delete
export const deleteWorkflowTool = async (
  trx: TxnOrClient,
  id: string,
): Promise<boolean> => {
  const deleted = await trx
    .delete(workflowTool)
    .where(eq(workflowTool.id, id))
    .returning()

  return deleted.length > 0
}

// Tool Execution Operations  
export const createToolExecution = async (
  trx: TxnOrClient,
  data: {
    workflowToolId: string
    workflowExecutionId: string
    status?: ToolExecutionStatus
    result?: any
  },
): Promise<SelectToolExecution> => {
  const [execution] = await trx
    .insert(toolExecution)
    .values({
      workflowToolId: data.workflowToolId,
      workflowExecutionId: data.workflowExecutionId,
      status: data.status || ToolExecutionStatus.PENDING,
      result: data.result,
    })
    .returning()

  return execution as SelectToolExecution
}

export const getToolExecutionById = async (
  trx: TxnOrClient,
  id: string,
): Promise<SelectToolExecution | null> => {
  const [execution] = await trx
    .select()
    .from(toolExecution)
    .where(eq(toolExecution.id, id))
    .limit(1)

  return execution ? ({ ...execution, result: execution.result as any }) : null
}

export const getToolExecutionsByWorkflowExecution = async (
  trx: TxnOrClient,
  workflowExecutionId: string,
): Promise<SelectToolExecution[]> => {
  const results = await trx
    .select()
    .from(toolExecution)
    .where(eq(toolExecution.workflowExecutionId, workflowExecutionId))
    .orderBy(desc(toolExecution.createdAt))
  
  return results.map(result => ({ ...result, result: result.result as any }))
}

export const getToolExecutionsByTool = async (
  trx: TxnOrClient,
  workflowToolId: string,
): Promise<SelectToolExecution[]> => {
  const results = await trx
    .select()
    .from(toolExecution)
    .where(eq(toolExecution.workflowToolId, workflowToolId))
    .orderBy(desc(toolExecution.createdAt))
  
  return results.map(result => ({ ...result, result: result.result as any }))
}

export const updateToolExecution = async (
  trx: TxnOrClient,
  id: string,
  data: Partial<InsertToolExecution>,
): Promise<SelectToolExecution | null> => {
  const [updated] = await trx
    .update(toolExecution)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(toolExecution.id, id))
    .returning()

  return updated ? ({ ...updated, result: updated.result as any }) : null
}

export const markToolExecutionStarted = async (
  trx: TxnOrClient,
  id: string,
): Promise<SelectToolExecution | null> => {
  return updateToolExecution(trx, id, {
    status: ToolExecutionStatus.RUNNING,
    startedAt: new Date(),
  })
}

export const markToolExecutionCompleted = async (
  trx: TxnOrClient,
  id: string,
  result: any,
): Promise<SelectToolExecution | null> => {
  return updateToolExecution(trx, id, {
    status: ToolExecutionStatus.COMPLETED,
    result,
    completedAt: new Date(),
  })
}

export const markToolExecutionFailed = async (
  trx: TxnOrClient,
  id: string,
  result?: any,
): Promise<SelectToolExecution | null> => {
  return updateToolExecution(trx, id, {
    status: ToolExecutionStatus.FAILED,
    result,
    completedAt: new Date(),
  })
}
