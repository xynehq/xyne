// Server-side persistence for the chat agent's debug events.
//
// The DebugCapture sink (capture.ts) fans every event onto the
// conversation's SSE stream so the live DebugPanel can render it. That
// stream is ephemeral: a page refresh drops the client-side debug-store
// and the captured timeline is gone. This module tees the same events
// to disk so the panel can re-seed itself after a reload AND across
// redeploys.
//
// Layout: one JSONL file per runId — `${DEBUG_DIR}/${runId}.jsonl`.
// Each line is one serialized DebugEvent. We chose append-only JSONL
// (over a single JSON array) so the hot path is a cheap append with no
// read-modify-write, and a crash mid-run still leaves a valid file
// (every complete line parses; a torn last line is just skipped on
// read).
//
// Durability across redeploys: DEBUG_DIR lives under
// `pi-mono-sessions`, which the deployment bind-mounts to the host —
// so these files outlive container replacement the same way the
// pi-mono session files do.
//
// Failure policy: this is a best-effort observability sidecar. A disk
// error here must NEVER propagate into the SSE publish path (that would
// break the user's live answer). Every write is wrapped so it can only
// log-and-drop, and the caller treats appendPersistedEvent as
// fire-and-forget.

import { promises as fs } from "node:fs"
import path from "node:path"

import { baseLogger } from "../../log"
import type { DebugEvent } from "./types"

const Logger = baseLogger("backendv2/pi-mono/debug-persist")

// Resolve the debug-events directory once. Precedence:
//   1. DEBUG_EVENTS_DIR — explicit override (tests / ops).
//   2. <XYNE_DATA_DIR>/pi-mono-sessions/debug-events — the default,
//      nested under the bind-mounted sessions dir so it survives
//      redeploys. XYNE_DATA_DIR defaults to "./data" (server cwd is
//      the `server/` dir), matching the rest of the data layout.
const DEBUG_DIR =
  process.env.DEBUG_EVENTS_DIR ??
  path.join(
    process.env.XYNE_DATA_DIR ?? "./data",
    "pi-mono-sessions",
    "debug-events",
  )

// mkdir -p the directory exactly once. We cache the in-flight (then
// resolved) promise so concurrent first-writers all await the same
// creation instead of racing N mkdir calls. recursive:true makes a
// pre-existing dir a no-op, so this is also safe to re-await forever.
let dirReady: Promise<void> | null = null
const ensureDir = (): Promise<void> => {
  if (!dirReady) {
    dirReady = fs.mkdir(DEBUG_DIR, { recursive: true }).then(() => undefined)
  }
  return dirReady
}

// Per-runId append serialization. Bun/Node fs.appendFile calls are not
// guaranteed to be atomic with respect to each other, so two appends
// racing for the same file could interleave bytes and corrupt a line.
// We thread each runId's appends through a promise chain so line N+1's
// write only starts after line N's resolves. Keyed by runId so distinct
// runs still write concurrently. The chain link logs and swallows its own
// errors so one failed write can't poison every subsequent append for that run.
const appendChains = new Map<string, Promise<void>>()

const filePathFor = (runId: string): string =>
  path.join(DEBUG_DIR, `${runId}.jsonl`)

/** Append one debug event to the run's JSONL file. Fire-and-forget:
 *  returns void synchronously, queues the actual write on the runId's
 *  serialized chain, and can never throw into (or reject onto) the
 *  caller — a disk failure is logged-and-dropped so it cannot break the
 *  live SSE stream the same event was just published to. */
export const appendPersistedEvent = (
  runId: string,
  event: DebugEvent,
): void => {
  // Serialize to a single line up front. JSON.stringify can throw on a
  // circular payload (shouldn't happen — events are scrubbed plain
  // data — but be defensive); if it does, drop this one event silently
  // rather than wedging the chain.
  let line: string
  try {
    line = JSON.stringify(event) + "\n"
  } catch (err) {
    // Non-serializable event (e.g. a circular payload that slipped past
    // scrubbing). Drop just this event rather than wedging the chain —
    // but log it: in debug mode a lost event should never be invisible.
    Logger.warn(
      { err, runId, kind: (event as { kind?: string }).kind },
      "debug-persist: failed to serialize event — dropping it",
    )
    return
  }
  const prev = appendChains.get(runId) ?? Promise.resolve()
  const next = prev
    .then(() => ensureDir())
    .then(() => fs.appendFile(filePathFor(runId), line, "utf8"))
    .catch((err) => {
      // Never rethrow into the SSE publish path — a logging side-channel
      // must not break the live run. But surface the failure in the
      // server logs; a silent drop would leave an empty Debug panel after
      // reload with no clue why. The next append in the chain still runs.
      Logger.warn(
        { err, runId },
        "debug-persist: append failed — debug event not persisted",
      )
    })
  appendChains.set(runId, next)
}

/** Read back every persisted event for a run, in append order. Returns
 *  [] when the file doesn't exist (ENOENT — e.g. debug was never on for
 *  this run, or the run predates this feature). Malformed lines (a torn
 *  final line after a crash, or a future format we can't parse) are
 *  skipped individually rather than failing the whole read. */
export const readPersistedEvents = async (
  runId: string,
): Promise<DebugEvent[]> => {
  let raw: string
  try {
    raw = await fs.readFile(filePathFor(runId), "utf8")
  } catch (err) {
    // Missing file is the common, expected case — return empty silently.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    // A real read error (permissions, IO) — degrade to empty rather than
    // throwing into the route handler, but log it so the failure is
    // observable instead of masquerading as "this run had no events".
    Logger.warn(
      { err, runId },
      "debug-persist: read failed — returning empty event list",
    )
    return []
  }
  const events: DebugEvent[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      events.push(JSON.parse(trimmed) as DebugEvent)
    } catch {
      // Skip the bad line — keep whatever else parsed.
    }
  }
  return events
}
