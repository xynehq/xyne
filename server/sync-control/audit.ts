import { db } from "@/db/client"
import { syncQueueAuditLogs } from "@/db/schema"
import { createId } from "@paralleldrive/cuid2"
import { eq } from "drizzle-orm"
import type {
  Actor,
  SyncControlAuditAction,
  SyncControlScopeType,
  WorkerCommandResult,
} from "./types"

export type AuditInput = {
  action: SyncControlAuditAction
  scopeType: SyncControlScopeType
  scopeValue: string
  queueName?: string | null
  workspaceId?: number | null
  filters?: Record<string, unknown>
  dryRun?: boolean
  reason: string
  requestId?: string
  ipAddress?: string | null
  userAgent?: string | null
}

export const createAuditLog = async (input: AuditInput, actor: Actor) => {
  const [row] = await db
    .insert(syncQueueAuditLogs)
    .values({
      externalId: createId(),
      requestId: input.requestId ?? createId(),
      workspaceId: input.workspaceId ?? null,
      action: input.action,
      scopeType: input.scopeType,
      scopeValue: input.scopeValue,
      queueName: input.queueName ?? null,
      filters: input.filters ?? {},
      dryRun: input.dryRun ?? true,
      reason: input.reason,
      requestedByUserId: actor.userId,
      requestedByEmail: actor.email,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      resultStatus: "pending",
    })
    .returning()

  return row
}

export const completeAuditLog = async (
  auditId: number,
  input: {
    resultStatus: "success" | "failed"
    affectedJobCount?: number
    affectedWorkerCount?: number
    workerResults?: WorkerCommandResult | WorkerCommandResult[] | null
    errorMessage?: string | null
  },
) => {
  const [row] = await db
    .update(syncQueueAuditLogs)
    .set({
      resultStatus: input.resultStatus,
      affectedJobCount: input.affectedJobCount ?? 0,
      affectedWorkerCount: input.affectedWorkerCount ?? 0,
      workerResults: input.workerResults ?? null,
      errorMessage: input.errorMessage ?? null,
      completedAt: new Date(),
    })
    .where(eq(syncQueueAuditLogs.id, auditId))
    .returning()

  return row
}

export const failAuditLog = async (audit: { id: number }, error: unknown) =>
  completeAuditLog(audit.id, {
    resultStatus: "failed",
    errorMessage: error instanceof Error ? error.message : String(error),
  })
