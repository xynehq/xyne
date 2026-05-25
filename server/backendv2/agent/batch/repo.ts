// DB access for batch jobs + rows. Pure data — no business logic, no
// permission checks (the service enforces those).
//
// All writes go through drizzle on the shared `db` client. The repo speaks
// in the public DTOs defined here, not in raw drizzle rows — callers don't
// need to know which columns are `numeric` (string) vs `bigint` (number) at
// the driver layer.

import { and, asc, desc, eq, lt, sql } from "drizzle-orm"

import { db } from "@/db/client"
import { v2BatchJobs, v2BatchRows } from "@/db/schema/v2Batch"

import type { ResultColumns } from "./sheet"

// ─── Public types ──────────────────────────────────────────────────────────

export type BatchJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

export type BatchRowStatus = "pending" | "running" | "done" | "error"

export type BatchJob = {
  id: string
  ownerId: string
  workspaceId: string
  name: string
  model: string | null
  agentId: string | null
  status: BatchJobStatus
  totalRows: number
  completedRows: number
  erroredRows: number
  questionColumn: string
  resultColumns: ResultColumns
  sourceFilePath: string
  sourceMime: string
  resultFilePath: string
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  archivedAt: number | null
  error: string | null
  /** Source column order. Persisted on `result_columns` so the worker can
   *  rebuild the sheet with the original column ordering. Embedded under
   *  resultColumns to avoid another DB column for one-off metadata. */
  columnOrder: string[]
}

export type BatchRow = {
  id: string
  batchId: string
  ordinal: number
  question: string
  originalColumns: Record<string, unknown>
  answer: string | null
  status: BatchRowStatus
  error: string | null
  tokensIn: number | null
  tokensOut: number | null
  durationMs: number | null
  startedAt: number | null
  finishedAt: number | null
}

export type CreateJobInput = {
  id: string
  ownerId: string
  workspaceId: string
  name: string
  model: string | null
  agentId: string | null
  questionColumn: string
  columnOrder: string[]
  resultColumns: ResultColumns
  sourceFilePath: string
  sourceMime: string
  resultFilePath: string
  totalRows: number
}

export type CreateRowInput = {
  id: string
  batchId: string
  ordinal: number
  question: string
  originalColumns: Record<string, unknown>
}

// ─── ID helpers ─────────────────────────────────────────────────────────────

const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`
export const newBatchId = (): string => newId("bat")
export const newRowId = (): string => newId("brow")

// ─── Jobs ───────────────────────────────────────────────────────────────────

const stripJsonbColumnOrder = (
  resultColumns: ResultColumns & { _columnOrder?: string[] },
): { resultColumns: ResultColumns; columnOrder: string[] } => {
  const { _columnOrder, ...rc } = resultColumns
  return { resultColumns: rc as ResultColumns, columnOrder: _columnOrder ?? [] }
}

const mapJob = (row: typeof v2BatchJobs.$inferSelect): BatchJob => {
  const rc = row.resultColumns as ResultColumns & { _columnOrder?: string[] }
  const { resultColumns, columnOrder } = stripJsonbColumnOrder(rc)
  return {
    id: row.id,
    ownerId: row.ownerId,
    workspaceId: row.workspaceId,
    name: row.name,
    model: row.model,
    agentId: row.agentId,
    status: row.status as BatchJobStatus,
    totalRows: row.totalRows,
    completedRows: row.completedRows,
    erroredRows: row.erroredRows,
    questionColumn: row.questionColumn,
    resultColumns,
    sourceFilePath: row.sourceFilePath,
    sourceMime: row.sourceMime,
    resultFilePath: row.resultFilePath,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    archivedAt: row.archivedAt,
    error: row.error,
    columnOrder,
  }
}

const mapRow = (row: typeof v2BatchRows.$inferSelect): BatchRow => ({
  id: row.id,
  batchId: row.batchId,
  ordinal: row.ordinal,
  question: row.question,
  originalColumns: row.originalColumns as Record<string, unknown>,
  answer: row.answer,
  status: row.status as BatchRowStatus,
  error: row.error,
  tokensIn: row.tokensIn,
  tokensOut: row.tokensOut,
  durationMs: row.durationMs,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
})

export async function createJob(input: CreateJobInput): Promise<BatchJob> {
  // Pack column order into the resultColumns jsonb so we don't add another
  // schema column. The repo strips it back out on read.
  const resultColumnsBlob = {
    ...input.resultColumns,
    _columnOrder: input.columnOrder,
  }
  const now = Date.now()
  const [row] = await db
    .insert(v2BatchJobs)
    .values({
      id: input.id,
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      name: input.name,
      model: input.model,
      agentId: input.agentId,
      status: "queued",
      totalRows: input.totalRows,
      completedRows: 0,
      erroredRows: 0,
      questionColumn: input.questionColumn,
      resultColumns: resultColumnsBlob,
      sourceFilePath: input.sourceFilePath,
      sourceMime: input.sourceMime,
      resultFilePath: input.resultFilePath,
      createdAt: now,
    })
    .returning()
  if (!row) throw new Error("createJob: insert returned no row")
  return mapJob(row)
}

export async function getJob(id: string): Promise<BatchJob | null> {
  const rows = await db.select().from(v2BatchJobs).where(eq(v2BatchJobs.id, id))
  const row = rows[0]
  return row ? mapJob(row) : null
}

export async function listJobsByOwner(
  ownerId: string,
  opts: { limit: number; before?: number },
): Promise<BatchJob[]> {
  const conds = [eq(v2BatchJobs.ownerId, ownerId)]
  if (opts.before) {
    conds.push(lt(v2BatchJobs.createdAt, opts.before))
  }
  const rows = await db
    .select()
    .from(v2BatchJobs)
    .where(and(...conds))
    .orderBy(desc(v2BatchJobs.createdAt))
    .limit(opts.limit)
  return rows.map(mapJob)
}

export type JobPatch = {
  status?: BatchJobStatus
  startedAt?: number
  finishedAt?: number
  archivedAt?: number
  error?: string
  completedRows?: number
  erroredRows?: number
}

export async function patchJob(id: string, patch: JobPatch): Promise<void> {
  await db.update(v2BatchJobs).set(patch).where(eq(v2BatchJobs.id, id))
}

/** Atomically bump completed/errored counters and (when known) flip status to
 *  the terminal value if all rows are accounted for. The status flip is done
 *  in the same UPDATE so two concurrent row handlers can't both observe an
 *  "almost done" counter and skip the transition. */
export async function bumpJobAndMaybeFinish(
  id: string,
  bump: { completedDelta: number; erroredDelta: number },
): Promise<{ status: BatchJobStatus; completedRows: number; erroredRows: number; totalRows: number }> {
  const now = Date.now()
  const rows = await db
    .update(v2BatchJobs)
    .set({
      completedRows: sql`${v2BatchJobs.completedRows} + ${bump.completedDelta}`,
      erroredRows: sql`${v2BatchJobs.erroredRows} + ${bump.erroredDelta}`,
      // Switch to terminal status when (completedRows + completedDelta +
      // erroredRows + erroredDelta) >= totalRows AND not already terminal/
      // cancelled. CASE inside SET so the transition is atomic with the bump.
      status: sql`CASE
        WHEN ${v2BatchJobs.status} IN ('completed','failed','cancelled') THEN ${v2BatchJobs.status}
        WHEN (${v2BatchJobs.completedRows} + ${bump.completedDelta} + ${v2BatchJobs.erroredRows} + ${bump.erroredDelta}) >= ${v2BatchJobs.totalRows}
          THEN CASE WHEN (${v2BatchJobs.erroredRows} + ${bump.erroredDelta}) >= ${v2BatchJobs.totalRows} THEN 'failed'::v2_batch_job_status
                    ELSE 'completed'::v2_batch_job_status END
        ELSE ${v2BatchJobs.status}
      END`,
      finishedAt: sql`CASE
        WHEN ${v2BatchJobs.status} IN ('completed','failed','cancelled') THEN ${v2BatchJobs.finishedAt}
        WHEN (${v2BatchJobs.completedRows} + ${bump.completedDelta} + ${v2BatchJobs.erroredRows} + ${bump.erroredDelta}) >= ${v2BatchJobs.totalRows}
          THEN ${now}::bigint
        ELSE ${v2BatchJobs.finishedAt}
      END`,
    })
    .where(eq(v2BatchJobs.id, id))
    .returning({
      status: v2BatchJobs.status,
      completedRows: v2BatchJobs.completedRows,
      erroredRows: v2BatchJobs.erroredRows,
      totalRows: v2BatchJobs.totalRows,
    })
  if (!rows[0]) throw new Error("bumpJobAndMaybeFinish: job missing")
  return {
    status: rows[0].status as BatchJobStatus,
    completedRows: rows[0].completedRows,
    erroredRows: rows[0].erroredRows,
    totalRows: rows[0].totalRows,
  }
}

// ─── Rows ───────────────────────────────────────────────────────────────────

export async function bulkInsertRows(rows: CreateRowInput[]): Promise<void> {
  if (rows.length === 0) return
  // Drizzle handles multi-value insert in one round trip.
  await db.insert(v2BatchRows).values(
    rows.map((r) => ({
      id: r.id,
      batchId: r.batchId,
      ordinal: r.ordinal,
      question: r.question,
      originalColumns: r.originalColumns,
      status: "pending" as const,
    })),
  )
}

export async function getRow(id: string): Promise<BatchRow | null> {
  const rows = await db.select().from(v2BatchRows).where(eq(v2BatchRows.id, id))
  return rows[0] ? mapRow(rows[0]) : null
}

export async function listRowsByBatch(
  batchId: string,
  opts?: { limit?: number; afterOrdinal?: number },
): Promise<BatchRow[]> {
  const conds = [eq(v2BatchRows.batchId, batchId)]
  if (opts?.afterOrdinal !== undefined) {
    conds.push(sql`${v2BatchRows.ordinal} > ${opts.afterOrdinal}`)
  }
  const q = db
    .select()
    .from(v2BatchRows)
    .where(and(...conds))
    .orderBy(asc(v2BatchRows.ordinal))
  const rows = opts?.limit ? await q.limit(opts.limit) : await q
  return rows.map(mapRow)
}

export type RowPatch = {
  status?: BatchRowStatus
  answer?: string | null
  error?: string | null
  tokensIn?: number | null
  tokensOut?: number | null
  durationMs?: number | null
  startedAt?: number | null
  finishedAt?: number | null
}

export async function patchRow(id: string, patch: RowPatch): Promise<void> {
  await db.update(v2BatchRows).set(patch).where(eq(v2BatchRows.id, id))
}

/** Per-batch concurrency guard. Counts rows that are currently running. The
 *  worker compares this to a configurable cap before picking up a job. */
export async function countRunningRows(batchId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(v2BatchRows)
    .where(and(eq(v2BatchRows.batchId, batchId), eq(v2BatchRows.status, "running")))
  return rows[0]?.n ?? 0
}
