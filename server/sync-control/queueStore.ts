import { db } from "@/db/client"
import { type SQL, sql } from "drizzle-orm"
import {
  getQueueDefinition,
  listRegisteredQueues,
  workspaceGuardForQueue,
} from "./registry"
import type { Actor, PgBossJobState, QueueJobRow } from "./types"

const STATE_VALUES: PgBossJobState[] = [
  "created",
  "retry",
  "active",
  "completed",
  "cancelled",
  "failed",
]

const DEFAULT_ALLOWED_DELETE_STATES: PgBossJobState[] = [
  "created",
  "retry",
  "cancelled",
  "failed",
]

const rowsFromResult = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[]
  if (result && typeof result === "object" && "rows" in result) {
    return (result as { rows: T[] }).rows
  }
  return []
}

const whereClause = (conditions: SQL[]) =>
  conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``

const stateList = (states: PgBossJobState[]) =>
  sql.join(
    states.map((state) => sql`${state}`),
    sql`, `,
  )

const normalizeLimit = (limit: number | undefined, fallback = 100) =>
  Math.min(Math.max(limit ?? fallback, 1), 1000)

const buildFilterConditions = (
  queueName: string | undefined,
  filters: Record<string, unknown> | undefined,
  actor: Actor,
) => {
  const conditions: SQL[] = []

  if (queueName) {
    const definition = getQueueDefinition(queueName)
    conditions.push(sql`j.name = ${queueName}`)

    for (const [key, value] of Object.entries(filters ?? {})) {
      if (value === undefined || value === null || value === "") continue
      const builder = definition.filterBuilders[key]
      if (!builder) {
        throw new Error(`Unsupported filter '${key}' for queue '${queueName}'`)
      }
      const condition = builder(value, { actor, queueName })
      if (condition) conditions.push(condition)
    }

    const workspaceGuard = workspaceGuardForQueue(definition, actor)
    if (workspaceGuard) conditions.push(workspaceGuard)
    return conditions
  }

  if (filters && Object.keys(filters).length) {
    throw new Error("queueName is required when filters are supplied")
  }

  if (!actor.isSuperAdmin) {
    const queueConditions = listRegisteredQueues()
      .map((definition) => {
        const guard = workspaceGuardForQueue(definition, actor)
        if (!guard) return sql`j.name = ${definition.queueName}`
        return sql`(j.name = ${definition.queueName} AND ${guard})`
      })
      .filter(Boolean)

    conditions.push(sql`(${sql.join(queueConditions, sql` OR `)})`)
  }

  return conditions
}

export const getQueueStateCounts = async (
  queueName?: string,
  actor?: Actor,
) => {
  const conditions = actor
    ? buildFilterConditions(queueName, undefined, actor)
    : queueName
      ? [sql`j.name = ${queueName}`]
      : []
  const result = await db.execute(sql`
    SELECT
      j.name AS "queueName",
      j.state::text AS state,
      COUNT(*)::int AS count
    FROM pgboss.job j
    ${whereClause(conditions)}
    GROUP BY j.name, j.state
    ORDER BY j.name, j.state
  `)

  return rowsFromResult<{
    queueName: string
    state: PgBossJobState
    count: number
  }>(result)
}

export const listJobs = async ({
  queueName,
  state,
  filters,
  actor,
  limit,
  cursor,
}: {
  queueName?: string
  state?: PgBossJobState
  filters?: Record<string, unknown>
  actor: Actor
  limit?: number
  cursor?: string
}): Promise<QueueJobRow[]> => {
  const conditions = buildFilterConditions(queueName, filters, actor)
  if (state) conditions.push(sql`j.state = ${state}::pgboss.job_state`)
  if (cursor) conditions.push(sql`j.created_on < ${new Date(cursor)}`)

  const result = await db.execute(sql`
    SELECT
      j.id::text AS id,
      j.name AS "queueName",
      j.state::text AS state,
      j.priority,
      j.data,
      j.retry_limit AS "retryLimit",
      j.retry_count AS "retryCount",
      j.start_after AS "startAfter",
      j.started_on AS "startedOn",
      j.created_on AS "createdOn",
      j.completed_on AS "completedOn",
      j.singleton_key AS "singletonKey"
    FROM pgboss.job j
    ${whereClause(conditions)}
    ORDER BY j.created_on DESC, j.id DESC
    LIMIT ${normalizeLimit(limit)}
  `)

  return rowsFromResult<QueueJobRow>(result)
}

export const countJobs = async ({
  queueName,
  state,
  filters,
  actor,
}: {
  queueName?: string
  state?: PgBossJobState
  filters?: Record<string, unknown>
  actor: Actor
}) => {
  const conditions = buildFilterConditions(queueName, filters, actor)
  if (state) conditions.push(sql`j.state = ${state}::pgboss.job_state`)

  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM pgboss.job j
    ${whereClause(conditions)}
  `)
  return rowsFromResult<{ count: number }>(result)[0]?.count ?? 0
}

export const getOldestPendingJobs = async (queueName: string, limit = 10) => {
  const result = await db.execute(sql`
    SELECT
      j.id::text AS id,
      j.name AS "queueName",
      j.state::text AS state,
      j.priority,
      j.data,
      j.retry_limit AS "retryLimit",
      j.retry_count AS "retryCount",
      j.start_after AS "startAfter",
      j.started_on AS "startedOn",
      j.created_on AS "createdOn",
      j.completed_on AS "completedOn",
      j.singleton_key AS "singletonKey"
    FROM pgboss.job j
    WHERE j.name = ${queueName}
      AND j.state IN ('created'::pgboss.job_state, 'retry'::pgboss.job_state)
    ORDER BY j.created_on ASC, j.id ASC
    LIMIT ${normalizeLimit(limit, 10)}
  `)
  return rowsFromResult<QueueJobRow>(result)
}

export const getRecentFailures = async (queueName: string, limit = 10) => {
  const result = await db.execute(sql`
    SELECT
      j.id::text AS id,
      j.name AS "queueName",
      j.state::text AS state,
      j.priority,
      j.data,
      j.retry_limit AS "retryLimit",
      j.retry_count AS "retryCount",
      j.start_after AS "startAfter",
      j.started_on AS "startedOn",
      j.created_on AS "createdOn",
      j.completed_on AS "completedOn",
      j.singleton_key AS "singletonKey"
    FROM pgboss.job j
    WHERE j.name = ${queueName}
      AND j.state = 'failed'::pgboss.job_state
    ORDER BY j.completed_on DESC NULLS LAST, j.created_on DESC
    LIMIT ${normalizeLimit(limit, 10)}
  `)
  return rowsFromResult<QueueJobRow>(result)
}

export const getJobsByIds = async (queueName: string, ids: string[]) => {
  if (!ids.length) return []
  const result = await db.execute(sql`
    SELECT
      j.id::text AS id,
      j.name AS "queueName",
      j.state::text AS state,
      j.priority,
      j.data,
      j.retry_limit AS "retryLimit",
      j.retry_count AS "retryCount",
      j.start_after AS "startAfter",
      j.started_on AS "startedOn",
      j.created_on AS "createdOn",
      j.completed_on AS "completedOn",
      j.singleton_key AS "singletonKey"
    FROM pgboss.job j
    WHERE j.name = ${queueName}
      AND j.id = ANY(${ids}::uuid[])
  `)
  return rowsFromResult<QueueJobRow>(result)
}

export const splitJobsByState = async (queueName: string, ids: string[]) => {
  const jobs = await getJobsByIds(queueName, ids)
  const split = Object.fromEntries(
    STATE_VALUES.map((state) => [state, [] as QueueJobRow[]]),
  ) as Record<PgBossJobState, QueueJobRow[]>

  for (const job of jobs) {
    split[job.state].push(job)
  }

  return split
}

export const deferActiveJob = async ({
  queueName,
  jobId,
  delaySeconds,
  reason,
}: {
  queueName: string
  jobId: string
  delaySeconds: number
  reason: string
}) => {
  const result = await db.execute(sql`
    UPDATE pgboss.job
    SET
      state = 'created'::pgboss.job_state,
      start_after = NOW() + (${delaySeconds}::int * INTERVAL '1 second'),
      started_on = NULL,
      output = jsonb_build_object('value', jsonb_build_object('message', ${reason}::text))
    WHERE name = ${queueName}
      AND id = ${jobId}::uuid
      AND state = 'active'::pgboss.job_state
    RETURNING id::text
  `)
  return rowsFromResult<{ id: string }>(result).length === 1
}

export const cancelQueuedJobs = async (queueName: string, ids: string[]) => {
  if (!ids.length) return 0
  const result = await db.execute(sql`
    UPDATE pgboss.job
    SET
      state = 'cancelled'::pgboss.job_state,
      completed_on = NOW()
    WHERE name = ${queueName}
      AND id = ANY(${ids}::uuid[])
      AND state IN ('created'::pgboss.job_state, 'retry'::pgboss.job_state)
    RETURNING id::text
  `)
  return rowsFromResult<{ id: string }>(result).length
}

export const deleteJobs = async (
  queueName: string,
  ids: string[],
  states: PgBossJobState[] = DEFAULT_ALLOWED_DELETE_STATES,
) => {
  if (!ids.length || !states.length) return 0
  const result = await db.execute(sql`
    DELETE FROM pgboss.job
    WHERE name = ${queueName}
      AND id = ANY(${ids}::uuid[])
      AND state::text IN (${stateList(states)})
    RETURNING id::text
  `)
  return rowsFromResult<{ id: string }>(result).length
}

export const groupCountsByState = (jobs: QueueJobRow[]) =>
  STATE_VALUES.reduce(
    (acc, state) => {
      acc[state] = jobs.filter((job) => job.state === state).length
      return acc
    },
    {} as Record<PgBossJobState, number>,
  )

export const filterJobsByStates = (
  jobs: QueueJobRow[],
  states: PgBossJobState[],
) => jobs.filter((job) => states.includes(job.state))

export const listClearCandidates = async ({
  queueName,
  states,
  limit,
}: {
  queueName: string
  states: PgBossJobState[]
  limit?: number
}) => {
  if (!states.length) return []
  const result = await db.execute(sql`
    SELECT
      j.id::text AS id,
      j.name AS "queueName",
      j.state::text AS state,
      j.priority,
      j.data,
      j.retry_limit AS "retryLimit",
      j.retry_count AS "retryCount",
      j.start_after AS "startAfter",
      j.started_on AS "startedOn",
      j.created_on AS "createdOn",
      j.completed_on AS "completedOn",
      j.singleton_key AS "singletonKey"
    FROM pgboss.job j
    WHERE j.name = ${queueName}
      AND j.state::text IN (${stateList(states)})
    ORDER BY j.created_on ASC, j.id ASC
    LIMIT ${normalizeLimit(limit, 1000)}
  `)
  return rowsFromResult<QueueJobRow>(result)
}
