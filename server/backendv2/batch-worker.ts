// Standalone entry point for the v2 batch row worker.
//
// Use this when you want to scale the worker independently of the API — one
// pod (or several replicas) running this entry, another pod running
// `server.ts` with BACKENDV2_BATCH_RUN_WORKER=false.
//
// Both processes connect to the same Postgres; pg-boss is the coordination
// substrate. The API enqueues; this process drains. Multiple worker replicas
// are safe — pg-boss leases each job exclusively, so a row is processed by
// at most one worker at a time.
//
// Run with:
//   bun server/backendv2/batch-worker.ts
//
// Useful env knobs:
//   BACKENDV2_BATCH_GLOBAL_CONCURRENCY (default 1) — jobs in flight per
//     replica. Keep at 1; scale by running more pods (see below) — pg-boss
//     v10's batchSize > 1 runs jobs in lockstep pairs which is rarely what
//     you want for paid LLM calls of uneven duration.
//   BACKENDV2_BATCH_PER_BATCH_CONCURRENCY (default 2) — soft cap on rows
//     processed simultaneously for the same batch_id across all replicas.
//   BACKENDV2_BATCH_DB_POOL_MAX (default 3) — pg-boss's own pool size per
//     replica. Total DB connections = replicas × pool_max + 2-ish.
//   BACKENDV2_BATCH_APPLICATION_NAME — shows up in pg_stat_activity for
//     ops visibility (default "backendv2-batch"; override per pod if you
//     want to distinguish replicas)
//
// Scaling:
//   kubectl scale deploy/batch-worker --replicas=N
//   Each replica drains one job at a time; pg-boss leases each job
//   exclusively so two replicas never grab the same job.

import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

import { stopBatchQueue } from "./agent/batch/queue"
import { startBatchWorker } from "./agent/batch/worker"

const Logger = getLogger(Subsystem.Api).child({
  module: "backendv2/batch-worker",
})

const main = async (): Promise<void> => {
  Logger.info("batch worker: starting")
  await startBatchWorker()
  Logger.info("batch worker: ready — draining v2-batch-row")
}

main().catch((err) => {
  Logger.error({ err }, "batch worker: failed to start")
  process.exit(1)
})

const shutdown = (signal: NodeJS.Signals): void => {
  Logger.info({ signal }, "batch worker: shutdown requested")
  stopBatchQueue()
    .catch((err) => {
      Logger.warn({ err }, "batch worker: stopBatchQueue threw on shutdown")
    })
    .finally(() => {
      process.exit(0)
    })
}

// pg-boss waits for in-flight jobs to finish (graceful: true, wait: true)
// before resolving. Two-replica rollouts are safe — the new pod can start
// processing as soon as the old pod begins draining.
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
