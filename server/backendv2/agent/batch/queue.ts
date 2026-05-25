// Dedicated pg-boss instance for v2 batch processing.
//
// Lives entirely under backendv2. Doesn't touch v1's `server/queue/boss.ts`
// or `api-server-queue.ts` — those manage a separate set of queues for
// connector sync / file processing. Having two pg-boss instances against the
// same Postgres is fine: each instance only polls for queues it knows about.
// The cost is one extra polling worker per process, which is negligible.
//
// Public surface:
//   • V2_BATCH_ROW_QUEUE — the queue name.
//   • startBatchQueue()  — connect + create queue. Idempotent.
//   • enqueueRows(rows)  — bulk send N row jobs in one round-trip.
//   • workRows(handler)  — register the row handler with global concurrency.
//   • stopBatchQueue()   — graceful shutdown for process teardown.

import PgBoss from "pg-boss"
import config from "@/config"
import { baseLogger } from "../log"

const Logger = baseLogger("backendv2/batch/queue")

export const V2_BATCH_ROW_QUEUE = "v2-batch-row"

export type RowJobData = {
  batchId: string
  rowId: string
}

let boss: PgBoss | null = null

const buildBoss = (): PgBoss =>
  new PgBoss({
    connectionString: config.getDatabaseUrl(),
    max: Number.parseInt(
      process.env["BACKENDV2_BATCH_DB_POOL_MAX"] ?? "3",
      10,
    ),
    application_name:
      process.env["BACKENDV2_BATCH_APPLICATION_NAME"] ?? "backendv2-batch",
    monitorStateIntervalMinutes: 10,
  })

/** Start the dedicated pg-boss instance. Safe to call multiple times — second
 *  calls become no-ops. Throws if pg-boss can't connect. */
export async function startBatchQueue(): Promise<void> {
  if (boss) {
    Logger.info("batch queue already started")
    return
  }
  const instance = buildBoss()
  instance.on("error", (err) => {
    Logger.error({ err }, "batch pg-boss error")
  })
  await instance.start()
  await instance.createQueue(V2_BATCH_ROW_QUEUE)
  boss = instance
  Logger.info("batch queue started")
}

export async function stopBatchQueue(): Promise<void> {
  if (!boss) return
  try {
    await boss.stop({ graceful: true, wait: true })
  } catch (err) {
    Logger.warn({ err }, "batch queue stop threw")
  }
  boss = null
}

const requireBoss = (): PgBoss => {
  if (!boss) {
    throw new Error("batch queue not started — call startBatchQueue() first")
  }
  return boss
}

/** Bulk-enqueue row jobs in a single pg-boss call. Returns immediately; the
 *  worker (registered via workRows) drains them according to its concurrency
 *  settings. */
export async function enqueueRows(rows: RowJobData[]): Promise<void> {
  if (rows.length === 0) return
  const instance = requireBoss()
  // pg-boss `insert` API takes an array of job specs.
  await instance.insert(
    rows.map((r) => ({
      name: V2_BATCH_ROW_QUEUE,
      data: r,
      retryLimit: 3,
      retryBackoff: true,
      expireInHours: 24,
    })),
  )
}

export type WorkOpts = {
  /** Maximum row jobs in flight per process. In pg-boss v10 this is the
   *  `batchSize` — the worker fetches up to N jobs per poll and processes
   *  them in parallel inside one handler invocation. The handler call is
   *  atomic from pg-boss's POV: it does NOT poll for the next batch until
   *  the current one fully resolves, so N=2 means jobs run in lockstep
   *  pairs (the faster of the two waits for the slower before the next pair
   *  starts).
   *
   *  Default 1 — pick scale via replica count, not via this knob:
   *      kubectl scale deploy/batch-worker --replicas=N
   *  Bumping this above 1 only makes sense for single-process dev. */
  globalConcurrency?: number
  /** Optional polling interval override (seconds). pg-boss default is 2. */
  pollingIntervalSeconds?: number
}

/** Register the row handler. pg-boss v10 calls the work handler with an
 *  array of `batchSize` jobs; we fan them out in parallel through
 *  `handlePerJob` so failures isolate per-row instead of poisoning the whole
 *  batch. */
export async function workRows(
  handlePerJob: (data: RowJobData) => Promise<void>,
  opts: WorkOpts = {},
): Promise<void> {
  const instance = requireBoss()
  const globalConcurrency =
    opts.globalConcurrency ??
    Number.parseInt(
      process.env["BACKENDV2_BATCH_GLOBAL_CONCURRENCY"] ?? "1",
      10,
    )
  const workOpts: PgBoss.WorkOptions = {
    batchSize: globalConcurrency,
    ...(opts.pollingIntervalSeconds
      ? { pollingIntervalSeconds: opts.pollingIntervalSeconds }
      : {}),
  }
  await instance.work<RowJobData>(V2_BATCH_ROW_QUEUE, workOpts, async (jobs) => {
    // v10 always passes an array, even with batchSize=1.
    await Promise.all(
      jobs.map(async (j) => {
        try {
          await handlePerJob(j.data)
        } catch (err) {
          Logger.error(
            { err, jobId: j.id, batchId: j.data.batchId, rowId: j.data.rowId },
            "row handler threw — pg-boss will retry",
          )
          // Re-throw so pg-boss records the failure and applies its retry
          // policy (set on enqueue: retryLimit 3, backoff).
          throw err
        }
      }),
    )
  })
  Logger.info({ globalConcurrency }, "batch worker registered")
}
