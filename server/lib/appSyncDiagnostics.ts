import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { threadId, workerData } from "node:worker_threads"

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

type DiagnosticDetails = Record<string, unknown>

const enabled = process.env.APP_SYNC_DIAGNOSTICS_ENABLED !== "false"
const diagnosticsDir =
  process.env.APP_SYNC_DIAGNOSTICS_DIR ||
  path.join(process.cwd(), "logs", "app-sync-diagnostics")
const resourceSampleIntervalMs = Number.parseInt(
  process.env.APP_SYNC_RESOURCE_SAMPLE_INTERVAL_MS || "5000",
  10,
)

let resourceSamplerStarted = false

const getWorkerLabel = () => {
  const data = (workerData || {}) as {
    workerType?: string
    workerIndex?: number
  }
  const type = data.workerType || "main"
  const index =
    typeof data.workerIndex === "number" ? String(data.workerIndex) : "0"

  return `${type.replace(/[^a-zA-Z0-9_-]/g, "_")}-${index}-t${threadId}`
}

const ensureDiagnosticsDir = () => {
  if (!enabled) return false

  try {
    fs.mkdirSync(diagnosticsDir, { recursive: true })
    return true
  } catch {
    return false
  }
}

const safeJson = (value: unknown): JsonValue => {
  if (value === null || value === undefined) return null

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value
  }

  if (typeof value === "bigint") {
    return value.toString()
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack || null,
    }
  }

  if (Array.isArray(value)) {
    return value.slice(0, 100).map(safeJson)
  }

  if (typeof value === "object") {
    const output: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = safeJson(item)
    }
    return output
  }

  return String(value)
}

const readNumberFile = (filePath: string): number | null => {
  try {
    const value = fs.readFileSync(filePath, "utf8").trim()
    if (!value || value === "max") return null
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

const readTextFile = (filePath: string): string | null => {
  try {
    return fs.readFileSync(filePath, "utf8").trim()
  } catch {
    return null
  }
}

const countDirEntries = (dirPath: string): number | null => {
  try {
    return fs.readdirSync(dirPath).length
  } catch {
    return null
  }
}

const collectResourceSnapshot = () => ({
  memoryUsage: process.memoryUsage(),
  resourceUsage:
    typeof process.resourceUsage === "function" ? process.resourceUsage() : null,
  uptimeSeconds: process.uptime(),
  loadavg: os.loadavg(),
  fdCount: countDirEntries("/proc/self/fd"),
  threadCount: countDirEntries("/proc/self/task"),
  cgroup: {
    memoryCurrent: readNumberFile("/sys/fs/cgroup/memory.current"),
    memoryPeak: readNumberFile("/sys/fs/cgroup/memory.peak"),
    memoryMax: readTextFile("/sys/fs/cgroup/memory.max"),
    memoryEvents: readTextFile("/sys/fs/cgroup/memory.events"),
    cpuStat: readTextFile("/sys/fs/cgroup/cpu.stat"),
    pidsCurrent: readNumberFile("/sys/fs/cgroup/pids.current"),
    pidsMax: readTextFile("/sys/fs/cgroup/pids.max"),
  },
  pressure: {
    cpu: readTextFile("/proc/pressure/cpu"),
    memory: readTextFile("/proc/pressure/memory"),
    io: readTextFile("/proc/pressure/io"),
  },
})

const atomicWriteJson = (fileName: string, payload: unknown) => {
  if (!ensureDiagnosticsDir()) return

  const targetPath = path.join(diagnosticsDir, fileName)
  const tempPath = `${targetPath}.${process.pid}.${threadId}.tmp`

  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(payload)}\n`)
    fs.renameSync(tempPath, targetPath)
  } catch {
    try {
      fs.rmSync(tempPath, { force: true })
    } catch {
      // best-effort diagnostics only
    }
  }
}

const appendJsonLine = (fileName: string, payload: unknown) => {
  if (!ensureDiagnosticsDir()) return

  try {
    fs.appendFileSync(path.join(diagnosticsDir, fileName), `${JSON.stringify(payload)}\n`)
  } catch {
    // best-effort diagnostics only
  }
}

export const recordAppSyncDiagnosticEvent = (
  event: string,
  details: DiagnosticDetails = {},
) => {
  if (!enabled) return

  appendJsonLine("events.jsonl", {
    ts: new Date().toISOString(),
    pid: process.pid,
    threadId,
    event,
    details: safeJson(details),
  })
}

export const recordAppSyncSemaphoreState = (
  state: DiagnosticDetails = {},
) => {
  if (!enabled) return

  const safeState = safeJson(state) as Record<string, JsonValue>
  atomicWriteJson("semaphore-state.json", {
    ts: new Date().toISOString(),
    pid: process.pid,
    threadId,
    ...safeState,
  })
}

export const recordWorkerPhase = (
  phase: string,
  details: DiagnosticDetails = {},
) => {
  if (!enabled) return

  const data = (workerData || {}) as {
    workerType?: string
    workerIndex?: number
  }
  const payload = {
    ts: new Date().toISOString(),
    pid: process.pid,
    threadId,
    workerType: data.workerType || "main",
    workerIndex: data.workerIndex ?? null,
    phase,
    details: safeJson(details),
    memoryUsage: process.memoryUsage(),
  }

  atomicWriteJson(`worker-${getWorkerLabel()}.json`, payload)
  appendJsonLine("worker-events.jsonl", payload)
}

export const clearWorkerPhase = (details: DiagnosticDetails = {}) => {
  recordWorkerPhase("idle", details)
}

export const startAppSyncResourceSampler = () => {
  if (!enabled || resourceSamplerStarted) return
  if (!Number.isFinite(resourceSampleIntervalMs) || resourceSampleIntervalMs <= 0) {
    return
  }

  resourceSamplerStarted = true
  recordAppSyncDiagnosticEvent("resource_sampler_started", {
    diagnosticsDir,
    resourceSampleIntervalMs,
  })

  const writeSample = () => {
    const payload = {
      ts: new Date().toISOString(),
      pid: process.pid,
      threadId,
      sample: collectResourceSnapshot(),
    }
    atomicWriteJson("resource-latest.json", payload)
    appendJsonLine("resource-samples.jsonl", payload)
  }

  writeSample()
  const timer = setInterval(writeSample, resourceSampleIntervalMs)
  timer.unref?.()
}
