import { db } from "@/db/client"
import { type SelectSyncQueueControl, syncQueueControls } from "@/db/schema"
import { createId } from "@paralleldrive/cuid2"
import { and, eq, gt, isNull, or, sql } from "drizzle-orm"
import { getQueueDefinition } from "./registry"
import type {
  Actor,
  JobIdentity,
  SyncControlScopeType,
  SyncQueueDefinition,
} from "./types"

type ControlInput = {
  workspaceId?: number | null
  scopeType: SyncControlScopeType
  scopeValue: string
  queueName?: string | null
  reason: string
  expiresAt?: Date | null
}

const activeControlConditions = () => [
  isNull(syncQueueControls.deletedAt),
  or(
    isNull(syncQueueControls.expiresAt),
    gt(syncQueueControls.expiresAt, new Date()),
  ),
]

export const createPauseControl = async (input: ControlInput, actor: Actor) => {
  const [control] = await db
    .insert(syncQueueControls)
    .values({
      externalId: createId(),
      workspaceId: input.workspaceId ?? null,
      scopeType: input.scopeType,
      scopeValue: input.scopeValue,
      queueName: input.queueName ?? null,
      controlType: "pause",
      reason: input.reason,
      createdByUserId: actor.userId,
      createdByEmail: actor.email,
      expiresAt: input.expiresAt ?? null,
    })
    .returning()

  return control
}

export const createCancelControl = async (
  input: ControlInput,
  actor: Actor,
) => {
  const [control] = await db
    .insert(syncQueueControls)
    .values({
      externalId: createId(),
      workspaceId: input.workspaceId ?? null,
      scopeType: input.scopeType,
      scopeValue: input.scopeValue,
      queueName: input.queueName ?? null,
      controlType: "cancel",
      reason: input.reason,
      createdByUserId: actor.userId,
      createdByEmail: actor.email,
      expiresAt: input.expiresAt ?? null,
    })
    .returning()

  return control
}

export const resumeControls = async (
  input: {
    workspaceId?: number | null
    scopeType: SyncControlScopeType
    scopeValue: string
    queueName?: string | null
  },
  actor: Actor,
) => {
  const conditions = [
    ...activeControlConditions(),
    eq(syncQueueControls.controlType, "pause" as const),
    eq(syncQueueControls.scopeType, input.scopeType),
    eq(syncQueueControls.scopeValue, input.scopeValue),
  ]

  if (input.queueName) {
    conditions.push(eq(syncQueueControls.queueName, input.queueName))
  }

  if (actor.isSuperAdmin) {
    if (input.workspaceId !== undefined) {
      conditions.push(
        input.workspaceId === null
          ? isNull(syncQueueControls.workspaceId)
          : eq(syncQueueControls.workspaceId, input.workspaceId),
      )
    }
  } else {
    conditions.push(eq(syncQueueControls.workspaceId, actor.workspaceId))
  }

  const rows = await db
    .update(syncQueueControls)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(...conditions))
    .returning()

  return rows.length
}

export const getActiveControls = async (actor?: Actor) => {
  const conditions = [...activeControlConditions()]
  if (actor && !actor.isSuperAdmin) {
    conditions.push(
      or(
        isNull(syncQueueControls.workspaceId),
        eq(syncQueueControls.workspaceId, actor.workspaceId),
      ),
    )
  }

  return db
    .select()
    .from(syncQueueControls)
    .where(and(...conditions))
}

const hydrateIdentity = async (
  definition: SyncQueueDefinition,
  identity: JobIdentity,
) => {
  if (
    identity.workspaceId === undefined &&
    identity.connectorId !== undefined
  ) {
    const result = await db.execute(sql`
      SELECT c.workspace_id AS "workspaceId"
      FROM connectors c
      WHERE c.id = ${identity.connectorId}
      LIMIT 1
    `)
    const rows = Array.isArray(result)
      ? (result as Array<{ workspaceId?: number }>)
      : result && typeof result === "object" && "rows" in result
        ? (result as { rows: Array<{ workspaceId?: number }> }).rows
        : []
    if (rows[0]?.workspaceId !== undefined) {
      return { ...identity, workspaceId: rows[0].workspaceId }
    }
  }

  if (definition.payloadKind !== "kb-file") return identity
  if (!identity.fileId && !identity.folderId && !identity.collectionId) {
    return identity
  }

  const result = await db.execute(sql`
    SELECT
      COALESCE(ci.collection_id::text, c.id::text) AS "collectionId",
      ci.uploaded_by_email AS email,
      COALESCE(ci.workspace_id, c.workspace_id) AS "workspaceId"
    FROM (SELECT 1) seed
    LEFT JOIN collection_items ci
      ON ci.id::text IN (${identity.fileId ?? ""}, ${identity.folderId ?? ""})
    LEFT JOIN collections c
      ON c.id::text = COALESCE(${identity.collectionId ?? null}, ci.collection_id::text)
    LIMIT 1
  `)

  const rows = Array.isArray(result)
    ? (result as Array<{
        collectionId?: string
        email?: string
        workspaceId?: number
      }>)
    : result && typeof result === "object" && "rows" in result
      ? (
          result as {
            rows: Array<{
              collectionId?: string
              email?: string
              workspaceId?: number
            }>
          }
        ).rows
      : []
  const row = rows[0]
  if (!row?.workspaceId) return identity

  return {
    ...identity,
    collectionId: identity.collectionId ?? row.collectionId,
    email: identity.email ?? row.email,
    workspaceId: identity.workspaceId ?? row.workspaceId,
  }
}

const controlAppliesToWorkspace = (
  control: SelectSyncQueueControl,
  identity: JobIdentity,
  actor?: Actor,
) => {
  if (actor && !actor.isSuperAdmin) {
    if (control.workspaceId === null) return true
    if (control.workspaceId !== actor.workspaceId) return false
    return (
      identity.workspaceId === undefined ||
      identity.workspaceId === actor.workspaceId
    )
  }

  if (control.workspaceId === null) return true
  if (identity.workspaceId === undefined) return true
  return control.workspaceId === identity.workspaceId
}

export const getMatchingControls = async ({
  queueName,
  jobData,
  jobId,
  actor,
}: {
  queueName: string
  jobData: unknown
  jobId?: string
  actor?: Actor
}) => {
  const definition = getQueueDefinition(queueName)
  const identity = await hydrateIdentity(definition, {
    ...definition.jobIdentityExtractor(jobData),
    jobId,
    queueName,
  })
  const controls = await getActiveControls(actor)

  return controls.filter((control) => {
    if (control.queueName && control.queueName !== queueName) return false
    if (!definition.allowedScopes.includes(control.scopeType)) return false
    if (!controlAppliesToWorkspace(control, identity, actor)) return false
    return definition.controlMatcher(control, identity, jobData, queueName)
  })
}

export const isQueuePaused = async (queueName: string, actor?: Actor) => {
  const controls = await getActiveControls(actor)
  return controls.some(
    (control) =>
      control.controlType === "pause" &&
      (control.scopeType === "global" ||
        (control.scopeType === "queue" &&
          (control.queueName ?? control.scopeValue) === queueName)),
  )
}

export const isWorkerGroupPaused = async (
  workerGroup: string,
  actor?: Actor,
) => {
  const controls = await getActiveControls(actor)
  return controls.some(
    (control) =>
      control.controlType === "pause" &&
      (control.scopeType === "global" ||
        (control.scopeType === "worker_group" &&
          control.scopeValue === workerGroup)),
  )
}

export const isJobPausedOrCancelled = async ({
  queueName,
  jobData,
  jobId,
  actor,
}: {
  queueName: string
  jobData: unknown
  jobId?: string
  actor?: Actor
}) => {
  const controls = await getMatchingControls({
    queueName,
    jobData,
    jobId,
    actor,
  })
  return {
    paused: controls.some((control) => control.controlType === "pause"),
    cancelled: controls.some((control) => control.controlType === "cancel"),
    controls,
  }
}
