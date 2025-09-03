import { and, eq, desc, isNull } from "drizzle-orm"
import { createId } from "@paralleldrive/cuid2"
import type { TxnOrClient } from "@/types"
import {
  workflowTools,
  workflowToolExecutions,
  type SelectWorkflowTool,
  type SelectWorkflowToolExecution,
  type InsertWorkflowTool,
  type InsertWorkflowToolExecution,
} from "@/db/schema"

// Tool Operations
export const createWorkflowTool = async (
  trx: TxnOrClient,
  data: {
    workspaceId: number
    createdBy: number
    type:
      | "delay"
      | "python_script"
      | "slack"
      | "gmail"
      | "agent"
      | "merged_node"
    value?: string | number | Record<string, any>
    config?: Record<string, any>
    workflowTemplateId?: number
  },
): Promise<SelectWorkflowTool> => {
  const externalId = createId()

  const [tool] = await trx
    .insert(workflowTools)
    .values({
      externalId,
      workspaceId: data.workspaceId,
      createdBy: data.createdBy,
      type: data.type,
      value: data.value,
      config: data.config || {},
      workflowTemplateId: data.workflowTemplateId,
    })
    .returning()

  return tool as SelectWorkflowTool
}

export const getWorkflowToolById = async (
  trx: TxnOrClient,
  externalId: string,
  workspaceId: number,
): Promise<SelectWorkflowTool | null> => {
  const [tool] = await trx
    .select()
    .from(workflowTools)
    .where(
      and(
        eq(workflowTools.externalId, externalId),
        eq(workflowTools.workspaceId, workspaceId),
        isNull(workflowTools.deletedAt),
      ),
    )
    .limit(1)

  return tool || null
}

export const getWorkflowToolsByWorkspace = async (
  trx: TxnOrClient,
  workspaceId: number,
): Promise<SelectWorkflowTool[]> => {
  return await trx
    .select()
    .from(workflowTools)
    .where(
      and(
        eq(workflowTools.workspaceId, workspaceId),
        isNull(workflowTools.deletedAt),
      ),
    )
    .orderBy(desc(workflowTools.createdAt))
}

export const getWorkflowToolsByTemplate = async (
  trx: TxnOrClient,
  workflowTemplateId: number,
  workspaceId: number,
): Promise<SelectWorkflowTool[]> => {
  return await trx
    .select()
    .from(workflowTools)
    .where(
      and(
        eq(workflowTools.workflowTemplateId, workflowTemplateId),
        eq(workflowTools.workspaceId, workspaceId),
        isNull(workflowTools.deletedAt),
      ),
    )
    .orderBy(desc(workflowTools.createdAt))
}

export const updateWorkflowTool = async (
  trx: TxnOrClient,
  externalId: string,
  workspaceId: number,
  data: Partial<InsertWorkflowTool>,
): Promise<SelectWorkflowTool | null> => {
  const [updated] = await trx
    .update(workflowTools)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workflowTools.externalId, externalId),
        eq(workflowTools.workspaceId, workspaceId),
        isNull(workflowTools.deletedAt),
      ),
    )
    .returning()

  return updated || null
}

export const deleteWorkflowTool = async (
  trx: TxnOrClient,
  externalId: string,
  workspaceId: number,
): Promise<boolean> => {
  const [deleted] = await trx
    .update(workflowTools)
    .set({
      deletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workflowTools.externalId, externalId),
        eq(workflowTools.workspaceId, workspaceId),
        isNull(workflowTools.deletedAt),
      ),
    )
    .returning()

  return !!deleted
}

// Tool Execution Operations
export const createWorkflowToolExecution = async (
  trx: TxnOrClient,
  data: {
    toolId: number
    stepId: string
    status?: "pending" | "running" | "completed" | "failed"
  },
): Promise<SelectWorkflowToolExecution> => {
  const externalId = createId()

  const [execution] = await trx
    .insert(workflowToolExecutions)
    .values({
      externalId,
      toolId: data.toolId,
      stepId: data.stepId,
      status: data.status || "pending",
    })
    .returning()

  return execution
}

export const getWorkflowToolExecutionById = async (
  trx: TxnOrClient,
  externalId: string,
): Promise<SelectWorkflowToolExecution | null> => {
  const [execution] = await trx
    .select()
    .from(workflowToolExecutions)
    .where(eq(workflowToolExecutions.externalId, externalId))
    .limit(1)

  return execution || null
}

export const getWorkflowToolExecutionsByStep = async (
  trx: TxnOrClient,
  stepId: string,
): Promise<SelectWorkflowToolExecution[]> => {
  return await trx
    .select()
    .from(workflowToolExecutions)
    .where(eq(workflowToolExecutions.stepId, stepId))
    .orderBy(desc(workflowToolExecutions.createdAt))
}

export const getWorkflowToolExecutionsByTool = async (
  trx: TxnOrClient,
  toolId: number,
): Promise<SelectWorkflowToolExecution[]> => {
  return await trx
    .select()
    .from(workflowToolExecutions)
    .where(eq(workflowToolExecutions.toolId, toolId))
    .orderBy(desc(workflowToolExecutions.createdAt))
}

export const updateWorkflowToolExecution = async (
  trx: TxnOrClient,
  id: number,
  data: Partial<InsertWorkflowToolExecution>,
): Promise<SelectWorkflowToolExecution | null> => {
  const [updated] = await trx
    .update(workflowToolExecutions)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(workflowToolExecutions.id, id))
    .returning()

  return updated || null
}

export const markWorkflowToolExecutionStarted = async (
  trx: TxnOrClient,
  id: number,
): Promise<SelectWorkflowToolExecution | null> => {
  return updateWorkflowToolExecution(trx, id, {
    status: "running",
    startedAt: new Date(),
  })
}

export const markWorkflowToolExecutionCompleted = async (
  trx: TxnOrClient,
  id: number,
  result: any,
): Promise<SelectWorkflowToolExecution | null> => {
  return updateWorkflowToolExecution(trx, id, {
    status: "completed",
    result,
    completedAt: new Date(),
  })
}

export const markWorkflowToolExecutionFailed = async (
  trx: TxnOrClient,
  id: number,
  errorMessage: string,
  result?: any,
): Promise<SelectWorkflowToolExecution | null> => {
  return updateWorkflowToolExecution(trx, id, {
    status: "failed",
    errorMessage,
    result,
    completedAt: new Date(),
  })
}
