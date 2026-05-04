import crypto from "node:crypto"
import { getLogger } from "@/logger"
import { boss } from "@/queue/boss"
import { Subsystem } from "@/types"
import type PgBoss from "pg-boss"
import type { Worker } from "worker_threads"
import { checkSyncControl } from "./checkpoint"
import { isWorkerGroupPaused } from "./controlState"
import { deferActiveJob } from "./queueStore"
import type { WorkerCommandResult } from "./types"

const Logger = getLogger(Subsystem.Queue).child({ module: "worker-control" })

type BossHandler<T> = PgBoss.WorkHandler<T>

type LocalWorkerRecord = {
  targetId: string
  queueName: string
  workerGroup: string
  workOptions?: PgBoss.WorkOptions
  handler: BossHandler<any>
  wrappedHandler: BossHandler<any>
  bossWorkerId: string
  status: "running" | "paused"
  startedAt: Date
  updatedAt: Date
}

type ThreadWorkerRecord = {
  childId: string
  workerGroup: string
  thread: Worker
  currentBossWorkerId?: string
  lastKnownStatus: "starting" | "running" | "paused" | "error" | "exited"
  startedAt: Date
  lastAckAt?: Date
}

type PendingCommand = {
  resolve: (value: WorkerCommandResult["results"][number]) => void
  timeout: ReturnType<typeof setTimeout>
}

let localWorkerCounter = 0
const localWorkers = new Map<string, LocalWorkerRecord>()
const threadWorkers = new Map<string, ThreadWorkerRecord>()
const pendingCommands = new Map<string, PendingCommand>()

const makeTargetId = (queueName: string) => {
  localWorkerCounter += 1
  return `local:${queueName}:${localWorkerCounter}`
}

const wrapHandler = <T>(
  queueName: string,
  handler: BossHandler<T>,
): BossHandler<T> => {
  return async (jobs) => {
    const decisions = await Promise.all(
      jobs.map(async (job) => ({
        job,
        decision: await checkSyncControl({
          queueName,
          jobId: job.id,
          jobData: job.data,
          checkpoint: "before_start",
        }),
      })),
    )

    const blockedJobs = decisions.filter(
      ({ decision }) => decision !== "allowed",
    )
    if (!blockedJobs.length) {
      return handler(jobs)
    }

    const allowedJobs = decisions
      .filter(({ decision }) => decision === "allowed")
      .map(({ job }) => job)

    Logger.info(
      {
        queueName,
        blockedJobCount: blockedJobs.length,
        allowedJobCount: allowedJobs.length,
      },
      "Filtered pg-boss batch because sync-control blocked one or more jobs",
    )
    return allowedJobs.length ? handler(allowedJobs) : undefined
  }
}

export const registerBossWorker = async <T>({
  queueName,
  workerGroup,
  workOptions,
  handler,
}: {
  queueName: string
  workerGroup: string
  workOptions?: PgBoss.WorkOptions
  handler: BossHandler<T>
}) => {
  const wrappedHandler = wrapHandler(queueName, handler)
  const targetId = makeTargetId(queueName)
  const startPaused = await isWorkerGroupPaused(workerGroup)
  const bossWorkerId = startPaused
    ? ""
    : workOptions
      ? await boss.work(queueName, workOptions, wrappedHandler)
      : await boss.work(queueName, wrappedHandler)

  localWorkers.set(targetId, {
    targetId,
    queueName,
    workerGroup,
    workOptions,
    handler,
    wrappedHandler,
    bossWorkerId,
    status: startPaused ? "paused" : "running",
    startedAt: new Date(),
    updatedAt: new Date(),
  })

  return bossWorkerId
}

const selectLocalWorkers = (
  workerGroup: string,
  action: "pause" | "resume",
  count?: number,
) => {
  const eligible = [...localWorkers.values()].filter(
    (worker) =>
      worker.workerGroup === workerGroup &&
      (action === "pause"
        ? worker.status === "running"
        : worker.status === "paused"),
  )
  return typeof count === "number" ? eligible.slice(0, count) : eligible
}

const sendThreadCommand = (
  record: ThreadWorkerRecord,
  type: "pause-worker" | "resume-worker",
) => {
  const requestId = crypto.randomUUID()
  return new Promise<WorkerCommandResult["results"][number]>((resolve) => {
    const timeout = setTimeout(() => {
      pendingCommands.delete(requestId)
      resolve({
        targetId: record.childId,
        status: "failed",
        error: "Timed out waiting for worker thread ack",
      })
    }, 10_000)

    pendingCommands.set(requestId, { resolve, timeout })
    record.thread.postMessage({
      type,
      requestId,
      childId: record.childId,
      workerGroup: record.workerGroup,
    })
  })
}

const selectThreadWorkers = (
  workerGroup: string,
  action: "pause" | "resume",
  count?: number,
) => {
  const eligible = [...threadWorkers.values()].filter(
    (worker) =>
      worker.workerGroup === workerGroup &&
      (action === "pause"
        ? worker.lastKnownStatus === "running"
        : worker.lastKnownStatus === "paused"),
  )
  return typeof count === "number" ? eligible.slice(0, count) : eligible
}

export const pauseWorkerGroup = async (
  workerGroup: string,
  count?: number,
): Promise<WorkerCommandResult> => {
  const localTargets = selectLocalWorkers(workerGroup, "pause", count)
  const remaining =
    typeof count === "number"
      ? Math.max(count - localTargets.length, 0)
      : undefined
  const threadTargets = selectThreadWorkers(workerGroup, "pause", remaining)
  const results: WorkerCommandResult["results"] = []

  for (const worker of localTargets) {
    try {
      await boss.offWork({ id: worker.bossWorkerId })
      worker.status = "paused"
      worker.updatedAt = new Date()
      results.push({
        targetId: worker.targetId,
        status: "paused",
        workerId: worker.bossWorkerId,
      })
    } catch (error) {
      results.push({
        targetId: worker.targetId,
        status: "failed",
        workerId: worker.bossWorkerId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const threadResults = await Promise.all(
    threadTargets.map((worker) => sendThreadCommand(worker, "pause-worker")),
  )
  results.push(...threadResults)

  return {
    workerGroup,
    requested: count ?? localTargets.length + threadTargets.length,
    affected: results.filter((result) => result.status === "paused").length,
    results,
  }
}

export const resumeWorkerGroup = async (
  workerGroup: string,
  count?: number,
): Promise<WorkerCommandResult> => {
  const localTargets = selectLocalWorkers(workerGroup, "resume", count)
  const remaining =
    typeof count === "number"
      ? Math.max(count - localTargets.length, 0)
      : undefined
  const threadTargets = selectThreadWorkers(workerGroup, "resume", remaining)
  const results: WorkerCommandResult["results"] = []

  for (const worker of localTargets) {
    try {
      const bossWorkerId = worker.workOptions
        ? await boss.work(
            worker.queueName,
            worker.workOptions,
            worker.wrappedHandler,
          )
        : await boss.work(worker.queueName, worker.wrappedHandler)
      worker.bossWorkerId = bossWorkerId
      worker.status = "running"
      worker.updatedAt = new Date()
      results.push({
        targetId: worker.targetId,
        status: "resumed",
        workerId: bossWorkerId,
      })
    } catch (error) {
      results.push({
        targetId: worker.targetId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const threadResults = await Promise.all(
    threadTargets.map((worker) => sendThreadCommand(worker, "resume-worker")),
  )
  results.push(...threadResults)

  return {
    workerGroup,
    requested: count ?? localTargets.length + threadTargets.length,
    affected: results.filter((result) => result.status === "resumed").length,
    results,
  }
}

export const registerThreadWorker = ({
  childId,
  workerGroup,
  thread,
}: {
  childId: string
  workerGroup: string
  thread: Worker
}) => {
  threadWorkers.set(childId, {
    childId,
    workerGroup,
    thread,
    lastKnownStatus: "starting",
    startedAt: new Date(),
  })
}

export const markThreadWorkerExited = (childId: string) => {
  const record = threadWorkers.get(childId)
  if (record) {
    record.lastKnownStatus = "exited"
    record.lastAckAt = new Date()
  }
}

export const handleThreadWorkerMessage = (message: any) => {
  if (!message || typeof message !== "object") return false

  if (message.status === "initialized" && message.childId) {
    const record = threadWorkers.get(message.childId)
    if (record) {
      record.lastKnownStatus =
        message.workerStatus === "paused" ? "paused" : "running"
      record.currentBossWorkerId = message.bossWorkerId
      record.lastAckAt = new Date()
    }
    return true
  }

  if (message.status === "error" && message.childId) {
    const record = threadWorkers.get(message.childId)
    if (record) {
      record.lastKnownStatus = "error"
      record.lastAckAt = new Date()
    }
    return true
  }

  if (
    !["worker-paused", "worker-resumed", "worker-command-failed"].includes(
      message.type,
    )
  ) {
    return false
  }

  const record = threadWorkers.get(message.childId)
  if (record) {
    record.lastAckAt = new Date()
    if (message.type === "worker-paused") record.lastKnownStatus = "paused"
    if (message.type === "worker-resumed") record.lastKnownStatus = "running"
    if (message.bossWorkerId) record.currentBossWorkerId = message.bossWorkerId
  }

  const pending = pendingCommands.get(message.requestId)
  if (!pending) return true

  clearTimeout(pending.timeout)
  pendingCommands.delete(message.requestId)
  pending.resolve({
    targetId: message.childId,
    status:
      message.type === "worker-paused"
        ? "paused"
        : message.type === "worker-resumed"
          ? "resumed"
          : "failed",
    workerId: message.bossWorkerId,
    error: message.error,
  })

  return true
}

export const getWorkerState = () => ({
  workers: [
    ...[...localWorkers.values()].map((worker) => ({
      targetId: worker.targetId,
      queueName: worker.queueName,
      workerGroup: worker.workerGroup,
      bossWorkerId: worker.bossWorkerId,
      status: worker.status,
      startedAt: worker.startedAt,
      updatedAt: worker.updatedAt,
      type: "local" as const,
    })),
    ...[...threadWorkers.values()].map((worker) => ({
      targetId: worker.childId,
      workerGroup: worker.workerGroup,
      bossWorkerId: worker.currentBossWorkerId,
      status: worker.lastKnownStatus,
      startedAt: worker.startedAt,
      updatedAt: worker.lastAckAt,
      type: "thread" as const,
    })),
  ],
})

export const handleWorkerThreadCommand = async (message: any) => {
  if (!message || typeof message !== "object") return false
  if (message.type !== "pause-worker" && message.type !== "resume-worker") {
    return false
  }

  try {
    const result =
      message.type === "pause-worker"
        ? await pauseWorkerGroup(message.workerGroup, 1)
        : await resumeWorkerGroup(message.workerGroup, 1)
    const first = result.results[0]
    if (
      !first ||
      (message.type === "pause-worker" && first.status !== "paused") ||
      (message.type === "resume-worker" && first.status !== "resumed")
    ) {
      return {
        type: "worker-command-failed",
        requestId: message.requestId,
        childId: message.childId,
        error: first?.error ?? "No matching worker in child process",
      }
    }

    return {
      type:
        message.type === "pause-worker" ? "worker-paused" : "worker-resumed",
      requestId: message.requestId,
      childId: message.childId,
      bossWorkerId: first?.workerId,
    }
  } catch (error) {
    Logger.error(error, "Worker thread command failed")
    return {
      type: "worker-command-failed",
      requestId: message.requestId,
      childId: message.childId,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
