import config from "@/config"
import { db } from "@/db/client"
import { syncQueueAuditLogs, workspaces } from "@/db/schema"
import { getUserByEmail } from "@/db/user"
import { UserRole } from "@/shared/types"
import {
  completeAuditLog,
  createAuditLog,
  failAuditLog,
} from "@/sync-control/audit"
import {
  createCancelControl,
  createPauseControl,
  resumeControls,
} from "@/sync-control/controlState"
import {
  cancelQueuedJobs,
  countJobs,
  deleteJobs,
  filterJobsByStates,
  getQueueStateCounts,
  groupCountsByState,
  listClearCandidates,
  listJobs,
} from "@/sync-control/queueStore"
import {
  getQueueDefinition,
  listRegisteredQueues,
} from "@/sync-control/registry"
import type {
  Actor,
  PgBossJobState,
  SyncControlScopeType,
  WorkerCommandResult,
} from "@/sync-control/types"
import { getErrorMessage } from "@/utils"
import { and, desc, eq, sql } from "drizzle-orm"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"

const { JwtPayloadKey } = config

const scopeTypeSchema = z.enum([
  "global",
  "queue",
  "worker_group",
  "email",
  "connector",
  "collection",
  "job",
])

const pgBossStateSchema = z.enum([
  "created",
  "retry",
  "active",
  "completed",
  "cancelled",
  "failed",
])

const workspaceIdSchema = z.union([z.string(), z.number()]).optional()

export const syncStatusQuerySchema = z.object({
  queueName: z.string().optional(),
})

export const syncJobsQuerySchema = z.object({
  queueName: z.string().optional(),
  state: pgBossStateSchema.optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  cursor: z.string().optional(),
  email: z.string().optional(),
  collectionId: z.string().optional(),
  connectorId: z.string().optional(),
  fileId: z.string().optional(),
  ticketId: z.string().optional(),
  attachmentId: z.string().optional(),
})

export const syncAuditLogsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  resultStatus: z.enum(["pending", "success", "failed"]).optional(),
  action: z
    .enum([
      "pause",
      "resume",
      "worker_pause",
      "worker_resume",
      "cancel",
      "delete",
      "clear",
    ])
    .optional(),
})

export const syncPauseResumeSchema = z.object({
  scopeType: scopeTypeSchema,
  scopeValue: z.string().min(1),
  queueName: z.string().optional(),
  workspaceId: workspaceIdSchema,
  reason: z.string().min(1),
  expiresAt: z.string().datetime().optional(),
})

export const syncWorkerCommandSchema = z.object({
  workerGroup: z.string().min(1),
  count: z.number().int().nonnegative().optional(),
  reason: z.string().min(1),
})

export const syncJobsCancelSchema = z.object({
  queueName: z.string().min(1),
  filters: z.record(z.string(), z.unknown()).default({}),
  dryRun: z.boolean().optional(),
  reason: z.string().min(1),
})

export const syncJobsDeleteSchema = z.object({
  queueName: z.string().min(1),
  filters: z.record(z.string(), z.unknown()).default({}),
  states: z
    .array(z.enum(["created", "retry", "cancelled", "failed"]))
    .optional(),
  dryRun: z.boolean().optional(),
  reason: z.string().min(1),
})

export const syncClearSchema = z.object({
  queues: z.array(z.string()).optional(),
  includeFailed: z.boolean().optional(),
  includeCompleted: z.boolean().optional(),
  confirmation: z.literal("CLEAR_SYNC_SERVER_QUEUE"),
  dryRun: z.boolean().optional(),
  reason: z.string().min(1),
})

const getActor = async (c: Context): Promise<Actor> => {
  const payload = c.get(JwtPayloadKey) as { sub?: string }
  const email = payload.sub
  if (!email) throw new HTTPException(401, { message: "Invalid token" })

  const [user] = await getUserByEmail(db, email)
  if (!user) throw new HTTPException(404, { message: "User not found" })
  if (user.role !== UserRole.Admin && user.role !== UserRole.SuperAdmin) {
    throw new HTTPException(403, { message: "Admin access required" })
  }

  return {
    userId: user.id,
    email: user.email,
    workspaceId: user.workspaceId,
    workspaceExternalId: user.workspaceExternalId,
    role: user.role,
    isSuperAdmin: user.role === UserRole.SuperAdmin,
  }
}

const requestMeta = (c: Context) => ({
  requestId: c.req.header("x-request-id") ?? undefined,
  ipAddress:
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    null,
  userAgent: c.req.header("user-agent") ?? null,
})

const resolveWorkspaceId = async (
  workspaceId: string | number | undefined,
  actor: Actor,
  scopeType: SyncControlScopeType,
) => {
  if (!workspaceId) {
    if (
      actor.isSuperAdmin &&
      (scopeType === "global" || scopeType === "queue")
    ) {
      return null
    }
    return actor.workspaceId
  }

  const numeric =
    typeof workspaceId === "number"
      ? workspaceId
      : /^\d+$/.test(workspaceId)
        ? Number(workspaceId)
        : null

  if (numeric !== null) {
    if (!actor.isSuperAdmin && numeric !== actor.workspaceId) {
      throw new HTTPException(403, { message: "Workspace scope is forbidden" })
    }
    return numeric
  }

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.externalId, String(workspaceId)))
    .limit(1)

  if (!workspace)
    throw new HTTPException(404, { message: "Workspace not found" })
  if (!actor.isSuperAdmin && workspace.id !== actor.workspaceId) {
    throw new HTTPException(403, { message: "Workspace scope is forbidden" })
  }
  return workspace.id
}

const requireSuperAdmin = (actor: Actor, message = "SuperAdmin required") => {
  if (!actor.isSuperAdmin) throw new HTTPException(403, { message })
}

const assertPauseScopeAllowed = (
  actor: Actor,
  scopeType: SyncControlScopeType,
) => {
  if (["global", "queue", "worker_group"].includes(scopeType)) {
    requireSuperAdmin(actor)
  }
}

const validateQueueName = (queueName?: string | null) => {
  if (!queueName) return
  getQueueDefinition(queueName)
}

const filtersFromQuery = (query: z.infer<typeof syncJobsQuerySchema>) => {
  const filters: Record<string, unknown> = {}
  for (const key of [
    "email",
    "collectionId",
    "connectorId",
    "fileId",
    "ticketId",
    "attachmentId",
  ] as const) {
    if (query[key]) filters[key] = query[key]
  }
  return filters
}

const isBroadMutation = (filters: Record<string, unknown>) =>
  !Object.values(filters).some(
    (value) => value !== undefined && value !== null && value !== "",
  )

const callSyncServerWorkerApi = async (
  action: "pause" | "resume",
  body: { workerGroup: string; count?: number },
) => {
  const secret = process.env.METRICS_SECRET
  if (!secret) {
    throw new HTTPException(500, {
      message: "METRICS_SECRET is required for sync-server worker commands",
    })
  }

  const response = await fetch(
    `http://${config.syncServerHost}:${config.syncServerPort}/internal/sync-control/workers/${action}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(body),
    },
  )

  const responseBody = await response.json().catch(() => null)
  if (!response.ok) {
    throw new HTTPException(response.status as any, {
      message: responseBody?.message ?? "Sync-server worker command failed",
    })
  }
  return responseBody as WorkerCommandResult
}

const getSyncServerWorkerState = async () => {
  const secret = process.env.METRICS_SECRET
  if (!secret) return { error: "METRICS_SECRET is not configured" }

  try {
    const response = await fetch(
      `http://${config.syncServerHost}:${config.syncServerPort}/internal/sync-control/workers/state`,
      { headers: { Authorization: `Bearer ${secret}` } },
    )
    if (!response.ok) {
      return { error: `sync-server returned ${response.status}` }
    }
    return await response.json()
  } catch (error) {
    return { error: getErrorMessage(error) }
  }
}

export const GetSyncServerStatus = async (c: Context) => {
  const actor = await getActor(c)
  // @ts-ignore - validated by zValidator
  const query = c.req.valid("query") as z.infer<typeof syncStatusQuerySchema>
  if (query.queueName) validateQueueName(query.queueName)

  const [counts, workerState] = await Promise.all([
    getQueueStateCounts(query.queueName, actor),
    getSyncServerWorkerState(),
  ])

  return c.json({
    queues: listRegisteredQueues().map((definition) => ({
      queueName: definition.queueName,
      workerGroup: definition.workerGroup,
      payloadKind: definition.payloadKind,
      counts: counts
        .filter((count) => count.queueName === definition.queueName)
        .reduce<Record<string, number>>((acc, count) => {
          acc[count.state] = count.count
          return acc
        }, {}),
    })),
    workerState,
  })
}

export const GetSyncServerQueues = async (c: Context) => {
  await getActor(c)
  return c.json({
    queues: listRegisteredQueues().map((definition) => ({
      queueName: definition.queueName,
      workerGroup: definition.workerGroup,
      defaultConcurrency: definition.defaultConcurrency,
      payloadKind: definition.payloadKind,
      allowedScopes: definition.allowedScopes,
      filterKeys: Object.keys(definition.filterBuilders),
      mutationPolicy: definition.mutationPolicy,
      pauseBehavior: definition.pauseBehavior,
    })),
  })
}

export const ListSyncServerJobs = async (c: Context) => {
  const actor = await getActor(c)
  // @ts-ignore - validated by zValidator
  const query = c.req.valid("query") as z.infer<typeof syncJobsQuerySchema>
  if (query.queueName) validateQueueName(query.queueName)

  const jobs = await listJobs({
    queueName: query.queueName,
    state: query.state,
    filters: filtersFromQuery(query),
    actor,
    limit: query.limit,
    cursor: query.cursor,
  })

  return c.json({ jobs })
}

export const ListSyncQueueAuditLogs = async (c: Context) => {
  const actor = await getActor(c)
  // @ts-ignore - validated by zValidator
  const query = c.req.valid("query") as z.infer<typeof syncAuditLogsQuerySchema>
  const conditions = []
  if (query.action) conditions.push(eq(syncQueueAuditLogs.action, query.action))
  if (query.resultStatus) {
    conditions.push(eq(syncQueueAuditLogs.resultStatus, query.resultStatus))
  }
  if (!actor.isSuperAdmin) {
    conditions.push(eq(syncQueueAuditLogs.workspaceId, actor.workspaceId))
  }

  const rows = await db
    .select()
    .from(syncQueueAuditLogs)
    .where(conditions.length ? and(...conditions) : sql`true`)
    .orderBy(desc(syncQueueAuditLogs.createdAt))
    .limit(query.limit ?? 100)

  return c.json({ auditLogs: rows })
}

export const PauseSyncControl = async (c: Context) => {
  const actor = await getActor(c)
  // @ts-ignore - validated by zValidator
  const body = c.req.valid("json") as z.infer<typeof syncPauseResumeSchema>
  assertPauseScopeAllowed(actor, body.scopeType)
  validateQueueName(body.queueName)
  const scopeValue = body.scopeType === "global" ? "*" : body.scopeValue
  const queueName =
    body.scopeType === "queue"
      ? (body.queueName ?? body.scopeValue)
      : body.queueName
  validateQueueName(queueName)
  if (
    queueName &&
    !["global", "queue", "worker_group", "job"].includes(body.scopeType) &&
    !getQueueDefinition(queueName).mutationPolicy.canPauseScoped
  ) {
    throw new HTTPException(400, {
      message: `Queue '${queueName}' does not support scoped pause controls`,
    })
  }
  const workspaceId = await resolveWorkspaceId(
    body.workspaceId,
    actor,
    body.scopeType,
  )
  const audit = await createAuditLog(
    {
      action: "pause",
      scopeType: body.scopeType,
      scopeValue,
      queueName,
      workspaceId,
      dryRun: false,
      reason: body.reason,
      ...requestMeta(c),
    },
    actor,
  )

  try {
    const control = await createPauseControl(
      {
        workspaceId,
        scopeType: body.scopeType,
        scopeValue,
        queueName,
        reason: body.reason,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
      actor,
    )
    await completeAuditLog(audit.id, { resultStatus: "success" })
    return c.json({ control })
  } catch (error) {
    await failAuditLog(audit, error)
    throw error
  }
}

export const ResumeSyncControl = async (c: Context) => {
  const actor = await getActor(c)
  // @ts-ignore - validated by zValidator
  const body = c.req.valid("json") as z.infer<typeof syncPauseResumeSchema>
  assertPauseScopeAllowed(actor, body.scopeType)
  const scopeValue = body.scopeType === "global" ? "*" : body.scopeValue
  const queueName =
    body.scopeType === "queue"
      ? (body.queueName ?? body.scopeValue)
      : body.queueName
  validateQueueName(queueName)
  const workspaceId = await resolveWorkspaceId(
    body.workspaceId,
    actor,
    body.scopeType,
  )
  const audit = await createAuditLog(
    {
      action: "resume",
      scopeType: body.scopeType,
      scopeValue,
      queueName,
      workspaceId,
      dryRun: false,
      reason: body.reason,
      ...requestMeta(c),
    },
    actor,
  )

  try {
    const resumedCount = await resumeControls(
      {
        workspaceId,
        scopeType: body.scopeType,
        scopeValue,
        queueName,
      },
      actor,
    )
    await completeAuditLog(audit.id, {
      resultStatus: "success",
      affectedJobCount: resumedCount,
    })
    return c.json({ resumedCount })
  } catch (error) {
    await failAuditLog(audit, error)
    throw error
  }
}

export const PauseSyncWorkers = async (c: Context) => {
  const actor = await getActor(c)
  requireSuperAdmin(actor)
  // @ts-ignore - validated by zValidator
  const body = c.req.valid("json") as z.infer<typeof syncWorkerCommandSchema>
  const audit = await createAuditLog(
    {
      action: "worker_pause",
      scopeType: "worker_group",
      scopeValue: body.workerGroup,
      dryRun: false,
      reason: body.reason,
      ...requestMeta(c),
    },
    actor,
  )

  try {
    const result = await callSyncServerWorkerApi("pause", {
      workerGroup: body.workerGroup,
      count: body.count,
    })
    const failedResults = result.results.filter(
      (workerResult) => workerResult.status !== "paused",
    )
    if (failedResults.length) {
      await completeAuditLog(audit.id, {
        resultStatus: "failed",
        affectedWorkerCount: result.affected,
        workerResults: result,
        errorMessage: "One or more workers failed to pause",
      })
      return c.json(
        { message: "One or more workers failed to pause", result },
        502,
      )
    }
    if (body.count === undefined && result.affected > 0) {
      await createPauseControl(
        {
          workspaceId: null,
          scopeType: "worker_group",
          scopeValue: body.workerGroup,
          reason: body.reason,
        },
        actor,
      )
    }
    await completeAuditLog(audit.id, {
      resultStatus: "success",
      affectedWorkerCount: result.affected,
      workerResults: result,
    })
    return c.json(result)
  } catch (error) {
    await failAuditLog(audit, error)
    throw error
  }
}

export const ResumeSyncWorkers = async (c: Context) => {
  const actor = await getActor(c)
  requireSuperAdmin(actor)
  // @ts-ignore - validated by zValidator
  const body = c.req.valid("json") as z.infer<typeof syncWorkerCommandSchema>
  const audit = await createAuditLog(
    {
      action: "worker_resume",
      scopeType: "worker_group",
      scopeValue: body.workerGroup,
      dryRun: false,
      reason: body.reason,
      ...requestMeta(c),
    },
    actor,
  )

  try {
    const result = await callSyncServerWorkerApi("resume", {
      workerGroup: body.workerGroup,
      count: body.count,
    })
    const failedResults = result.results.filter(
      (workerResult) => workerResult.status !== "resumed",
    )
    if (failedResults.length) {
      await completeAuditLog(audit.id, {
        resultStatus: "failed",
        affectedWorkerCount: result.affected,
        workerResults: result,
        errorMessage: "One or more workers failed to resume",
      })
      return c.json(
        { message: "One or more workers failed to resume", result },
        502,
      )
    }
    const resumedControls =
      body.count === undefined
        ? await resumeControls(
            {
              workspaceId: null,
              scopeType: "worker_group",
              scopeValue: body.workerGroup,
            },
            actor,
          )
        : 0
    await completeAuditLog(audit.id, {
      resultStatus: "success",
      affectedWorkerCount: result.affected,
      affectedJobCount: resumedControls,
      workerResults: result,
    })
    return c.json(result)
  } catch (error) {
    await failAuditLog(audit, error)
    throw error
  }
}

export const CancelSyncJobs = async (c: Context) => {
  const actor = await getActor(c)
  // @ts-ignore - validated by zValidator
  const body = c.req.valid("json") as z.infer<typeof syncJobsCancelSchema>
  validateQueueName(body.queueName)
  const dryRun = body.dryRun ?? true
  if (isBroadMutation(body.filters))
    requireSuperAdmin(actor, "Broad cancel requires SuperAdmin")

  const workspaceId = actor.isSuperAdmin ? null : actor.workspaceId
  const audit = await createAuditLog(
    {
      action: "cancel",
      scopeType: "queue",
      scopeValue: body.queueName,
      queueName: body.queueName,
      workspaceId,
      filters: body.filters,
      dryRun,
      reason: body.reason,
      ...requestMeta(c),
    },
    actor,
  )

  try {
    const matchedCount = await countJobs({
      queueName: body.queueName,
      filters: body.filters,
      actor,
    })
    if (!dryRun && matchedCount > 1000) {
      throw new HTTPException(400, {
        message: "Cancel is capped at 1000 matched jobs; refine filters first",
      })
    }

    const jobs = await listJobs({
      queueName: body.queueName,
      filters: body.filters,
      actor,
      limit: 1000,
    })
    const definition = getQueueDefinition(body.queueName)
    if (!definition.mutationPolicy.canCancelQueued) {
      throw new HTTPException(400, {
        message: `Queue '${body.queueName}' does not support queued cancellation`,
      })
    }
    const queuedJobs = filterJobsByStates(
      jobs,
      definition.mutationPolicy.allowedCancelStates.filter(
        (state) => state !== "active",
      ),
    )
    const activeJobs = jobs.filter((job) => job.state === "active")
    const affectedJobCount = queuedJobs.length + activeJobs.length

    if (dryRun) {
      await completeAuditLog(audit.id, {
        resultStatus: "success",
        affectedJobCount,
      })
      return c.json({
        dryRun,
        matchedCount,
        stateCounts: groupCountsByState(jobs),
        cancellableQueuedCount: queuedJobs.length,
        activeJobControlCount: activeJobs.length,
      })
    }

    const cancelledQueued = await cancelQueuedJobs(
      body.queueName,
      queuedJobs.map((job) => job.id),
    )
    for (const job of activeJobs) {
      await createCancelControl(
        {
          workspaceId,
          scopeType: "job",
          scopeValue: job.id,
          queueName: body.queueName,
          reason: body.reason,
        },
        actor,
      )
    }

    await completeAuditLog(audit.id, {
      resultStatus: "success",
      affectedJobCount: cancelledQueued + activeJobs.length,
    })
    return c.json({
      dryRun,
      matchedCount,
      cancelledQueued,
      activeJobControlsCreated: activeJobs.length,
      terminalNoopCount: jobs.length - queuedJobs.length - activeJobs.length,
    })
  } catch (error) {
    await failAuditLog(audit, error)
    throw error
  }
}

export const DeleteSyncJobs = async (c: Context) => {
  const actor = await getActor(c)
  // @ts-ignore - validated by zValidator
  const body = c.req.valid("json") as z.infer<typeof syncJobsDeleteSchema>
  validateQueueName(body.queueName)
  const dryRun = body.dryRun ?? true
  if (isBroadMutation(body.filters))
    requireSuperAdmin(actor, "Broad delete requires SuperAdmin")

  const states = (body.states ?? [
    "created",
    "retry",
    "cancelled",
    "failed",
  ]) as PgBossJobState[]
  const workspaceId = actor.isSuperAdmin ? null : actor.workspaceId
  const audit = await createAuditLog(
    {
      action: "delete",
      scopeType: "queue",
      scopeValue: body.queueName,
      queueName: body.queueName,
      workspaceId,
      filters: body.filters,
      dryRun,
      reason: body.reason,
      ...requestMeta(c),
    },
    actor,
  )

  try {
    const matchedCount = await countJobs({
      queueName: body.queueName,
      filters: body.filters,
      actor,
    })
    if (!dryRun && matchedCount > 1000) {
      throw new HTTPException(400, {
        message: "Delete is capped at 1000 matched jobs; refine filters first",
      })
    }

    const jobs = await listJobs({
      queueName: body.queueName,
      filters: body.filters,
      actor,
      limit: 1000,
    })
    const activeJobs = jobs.filter((job) => job.state === "active")
    const definition = getQueueDefinition(body.queueName)
    if (!definition.mutationPolicy.canDelete) {
      throw new HTTPException(400, {
        message: `Queue '${body.queueName}' does not support deletion`,
      })
    }
    const allowedStates = states.filter((state) =>
      definition.mutationPolicy.allowedDeleteStates.includes(state),
    )
    const eligibleJobs = filterJobsByStates(jobs, allowedStates)

    if (!dryRun && activeJobs.length) {
      throw new HTTPException(409, {
        message: "Active jobs are not deleted by the control plane",
      })
    }

    if (dryRun) {
      await completeAuditLog(audit.id, {
        resultStatus: "success",
        affectedJobCount: eligibleJobs.length,
      })
      return c.json({
        dryRun,
        matchedCount,
        stateCounts: groupCountsByState(jobs),
        deletableCount: eligibleJobs.length,
        activeNotTouched: activeJobs.length,
      })
    }

    const deleted = await deleteJobs(
      body.queueName,
      eligibleJobs.map((job) => job.id),
      allowedStates,
    )
    await completeAuditLog(audit.id, {
      resultStatus: "success",
      affectedJobCount: deleted,
    })
    return c.json({
      dryRun,
      matchedCount,
      deleted,
      activeNotTouched: activeJobs.length,
    })
  } catch (error) {
    await failAuditLog(audit, error)
    throw error
  }
}

export const ClearSyncQueues = async (c: Context) => {
  const actor = await getActor(c)
  requireSuperAdmin(actor)
  // @ts-ignore - validated by zValidator
  const body = c.req.valid("json") as z.infer<typeof syncClearSchema>
  const dryRun = body.dryRun ?? true
  const queueNames =
    body.queues ?? listRegisteredQueues().map((queue) => queue.queueName)
  queueNames.forEach(validateQueueName)
  const states: PgBossJobState[] = ["created", "retry", "cancelled"]
  if (body.includeFailed ?? true) states.push("failed")
  if (body.includeCompleted ?? false) states.push("completed")

  const audit = await createAuditLog(
    {
      action: "clear",
      scopeType: "global",
      scopeValue: "*",
      filters: {
        queues: queueNames,
        includeFailed: body.includeFailed ?? true,
        includeCompleted: body.includeCompleted ?? false,
      },
      dryRun,
      reason: body.reason,
      ...requestMeta(c),
    },
    actor,
  )

  try {
    const perQueue: Record<string, unknown> = {}
    let affectedJobCount = 0
    for (const queueName of queueNames) {
      const counts = await getQueueStateCounts(queueName)
      const activeNotTouched =
        counts.find((count) => count.state === "active")?.count ?? 0
      const eligibleCount = counts
        .filter((count) => states.includes(count.state))
        .reduce((sum, count) => sum + count.count, 0)

      if (dryRun) {
        perQueue[queueName] = { eligibleCount, activeNotTouched }
        affectedJobCount += eligibleCount
        continue
      }

      let deleted = 0
      while (true) {
        const batch = await listClearCandidates({
          queueName,
          states,
          limit: 1000,
        })
        if (!batch.length) break
        deleted += await deleteJobs(
          queueName,
          batch.map((job) => job.id),
          states,
        )
        if (batch.length < 1000) break
      }
      perQueue[queueName] = { deleted, activeNotTouched }
      affectedJobCount += deleted
    }

    await completeAuditLog(audit.id, {
      resultStatus: "success",
      affectedJobCount,
    })
    return c.json({ dryRun, affectedJobCount, perQueue })
  } catch (error) {
    await failAuditLog(audit, error)
    throw error
  }
}
