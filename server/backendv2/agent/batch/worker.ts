// Row worker — picks up `v2-batch-row` jobs, runs pi-mono on one question,
// writes the answer back to the DB, regenerates the result XLSX from the
// current row state.
//
// Lifecycle per job:
//   1. Load row + job. If job is cancelled or already terminal → no-op.
//   2. Per-batch concurrency guard: count rows currently `running` for the
//      same batch. If >= cap, defer (throw — pg-boss retries with backoff).
//      Cap defaults to 2 (env: BACKENDV2_BATCH_PER_BATCH_CONCURRENCY).
//   3. Flip row to `running`, set startedAt.
//   4. Load agentScope (if job has agentId) — owner used as actor email so
//      docs the owner can see are the docs the batch sees.
//   5. runQuestion() → answer / error / tokens.
//   6. Flip row to `done`/`error`, persist telemetry.
//   7. Inside an advisory-lock per batchId: select all rows, rebuildResult().
//   8. bumpJobAndMaybeFinish() — atomically updates counters + terminal
//      status. If this was the last row, sets finishedAt.

import { sql } from "drizzle-orm"

import { db } from "@/db/client"
import { getUserByEmail } from "@/db/user"

import { loadAgentScope } from "../agent-scope"
import { baseLogger } from "../log"
import {
  bumpJobAndMaybeFinish,
  getJob,
  getRow,
  listRowsByBatch,
  patchJob,
  patchRow,
  type BatchJob,
  countRunningRows,
} from "./repo"
import { rebuildResult, type RowState } from "./sheet"
import { runQuestion } from "./runQuestion"
import { startBatchQueue, workRows, type RowJobData } from "./queue"

const Logger = baseLogger("backendv2/batch/worker")

const PER_BATCH_CAP = Number.parseInt(
  process.env["BACKENDV2_BATCH_PER_BATCH_CONCURRENCY"] ?? "2",
  10,
)

class DeferRowError extends Error {
  public override readonly name = "DeferRowError"
}

const isTerminal = (status: BatchJob["status"]): boolean =>
  status === "completed" || status === "failed" || status === "cancelled"

/** Hash the batchId into a stable bigint for `pg_advisory_xact_lock`. Using
 *  `hashtextextended` (Postgres-internal, deterministic) keyed on a prefix
 *  so it can't collide with other modules that take advisory locks on the
 *  same DB. */
const acquireBatchLock = async (
  client: typeof db,
  batchId: string,
): Promise<void> => {
  await client.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"v2-batch-rebuild:" + batchId}, 0))`,
  )
}

/** Read all rows + job in one short transaction, take the per-batch advisory
 *  lock, then rebuild the result file. The lock serializes concurrent rebuilds
 *  from sibling row handlers; the rename inside `rebuildResult` makes the
 *  visible result file atomic from a reader's POV. */
const rebuildResultFile = async (batchId: string): Promise<void> => {
  const job = await getJob(batchId)
  if (!job) return
  const rows = await listRowsByBatch(batchId)
  const rowStates: RowState[] = rows.map((r) => ({
    ordinal: r.ordinal,
    originalColumns: r.originalColumns,
    answer: r.answer,
    status: r.status,
    error: r.error,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    durationMs: r.durationMs,
  }))
  // pg-boss advisory locks need to live in a transaction. Open a tiny tx
  // around the file write so the lock is held through the rename, then
  // released on commit.
  await db.transaction(async (tx) => {
    await acquireBatchLock(tx as unknown as typeof db, batchId)
    await rebuildResult({
      columnOrder: job.columnOrder,
      resultColumns: job.resultColumns,
      modelLabel: job.model ?? "",
      agentLabel: job.agentId ?? "",
      rows: rowStates,
      outPath: job.resultFilePath,
    })
  })
}

/** Resolve the owner's email for permission scoping. Stored on jobs as a
 *  text user-id, which matches the `viewer.userId` shape (== email) the
 *  chat service uses. */
const ownerEmailFor = (job: BatchJob): string => job.ownerId

export const handleRow = async (data: RowJobData): Promise<void> => {
  const log = Logger.child({ batchId: data.batchId, rowId: data.rowId })
  const job = await getJob(data.batchId)
  if (!job) {
    log.warn("row job: batch not found — dropping")
    return
  }
  // Cancelled / already terminal batches don't process new rows.
  if (isTerminal(job.status)) {
    log.info({ status: job.status }, "row job: batch is terminal — short-circuit")
    return
  }
  const row = await getRow(data.rowId)
  if (!row) {
    log.warn("row job: row not found — dropping")
    return
  }
  if (row.status === "done" || row.status === "error") {
    // Already processed (idempotent rerun after a worker restart / retry).
    return
  }

  // Per-batch concurrency guard. If too many sibling rows are running, throw
  // a transient error so pg-boss requeues with backoff.
  const running = await countRunningRows(job.id)
  if (running >= PER_BATCH_CAP) {
    log.debug({ running, cap: PER_BATCH_CAP }, "deferring row — per-batch cap reached")
    throw new DeferRowError(
      `batch ${job.id} at per-batch concurrency cap (${PER_BATCH_CAP})`,
    )
  }

  // First-row transition: flip job from queued → running and set startedAt.
  if (job.status === "queued") {
    await patchJob(job.id, { status: "running", startedAt: Date.now() })
  }

  await patchRow(row.id, { status: "running", startedAt: Date.now() })

  // Load agent scope (if any). Permission was checked at upload time, but
  // the scope itself is materialized fresh each row to pick up any DB
  // changes between upload and run.
  let agentScope:
    | Awaited<ReturnType<typeof loadAgentScope>>
    | undefined = undefined
  if (job.agentId) {
    const viewer = {
      userId: ownerEmailFor(job) as never,
      workspaceId: job.workspaceId as never,
    }
    try {
      const scope = await loadAgentScope(viewer, job.agentId)
      if (scope) agentScope = scope
    } catch (err) {
      log.warn({ err }, "loadAgentScope failed — falling back to KB-only")
    }
  }

  // Touch the user record so we know the email exists in v1. Not strictly
  // required — runQuestion will work without it — but a missing user usually
  // means a stale batch we shouldn't waste tokens on.
  const userRows = await getUserByEmail(db, ownerEmailFor(job))
  if (!userRows || userRows.length === 0) {
    const errorMessage = `owner ${ownerEmailFor(job)} not found`
    await patchRow(row.id, {
      status: "error",
      error: errorMessage,
      finishedAt: Date.now(),
    })
    await bumpJobAndMaybeFinish(job.id, { completedDelta: 0, erroredDelta: 1 })
    await rebuildResultFile(job.id).catch((err) => {
      log.error({ err }, "rebuildResultFile failed after owner-missing")
    })
    return
  }

  const result = await runQuestion({
    batchId: job.id,
    rowId: row.id,
    ordinal: row.ordinal,
    question: row.question,
    userEmail: ownerEmailFor(job),
    ...(job.model ? { modelLabel: job.model } : {}),
    ...(agentScope ? { agentScope } : {}),
    logger: log,
  })

  if (result.error) {
    await patchRow(row.id, {
      status: "error",
      answer: result.answer.length > 0 ? result.answer : null,
      error: result.error,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      durationMs: result.durationMs,
      finishedAt: Date.now(),
    })
    await bumpJobAndMaybeFinish(job.id, {
      completedDelta: 0,
      erroredDelta: 1,
    })
  } else {
    await patchRow(row.id, {
      status: "done",
      answer: result.answer,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      durationMs: result.durationMs,
      finishedAt: Date.now(),
    })
    await bumpJobAndMaybeFinish(job.id, {
      completedDelta: 1,
      erroredDelta: 0,
    })
  }

  // Rebuild the result file from the new state. Best-effort — we surface but
  // don't fail the job on a file error (next row's rebuild will heal).
  try {
    await rebuildResultFile(job.id)
  } catch (err) {
    log.error({ err }, "rebuildResultFile failed — will retry on next row")
  }
}

/** Connect pg-boss + create the queue, but do NOT register the row handler.
 *  Called from the API server when it's deployed without an embedded worker
 *  (BACKENDV2_BATCH_RUN_WORKER=false) — the API still needs an open connection
 *  to enqueue rows, but row processing happens on a separate pod via
 *  `startBatchWorker()`. */
export async function initBatchQueueOnly(): Promise<void> {
  await startBatchQueue()
}

/** Connect pg-boss, create the queue, AND register the row handler. The
 *  default for single-process deploys (server.ts on boot) and the entry point
 *  for the standalone worker pod (backendv2/batch-worker.ts). */
export async function startBatchWorker(): Promise<void> {
  await startBatchQueue()
  await workRows(handleRow)
}
