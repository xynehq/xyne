// Live debug-event store. Mirrors the `nested-trace.ts` pattern —
// module-level Map keyed by runId, useSyncExternalStore hook for
// React components, listener fan-out per key. Append-only: events
// arrive over the conversation's SSE stream and accumulate here for
// as long as the tab is open. Nothing is persisted server-side, so
// refreshing loses the captured data — that's by design.

import { useSyncExternalStore } from "react"

// Discriminated union matching the server's DebugEvent. Kept in lock-
// step with server/backendv2/agent/pi-mono/debug/types.ts. The wire
// shape passes through `event` as `unknown`, so the store narrows it
// here at the boundary — anything that doesn't match the expected
// `kind` strings is still kept (we render it as raw JSON), the type
// just stops being safely narrowable downstream.
export type DebugVerbosity = "summary" | "detailed"

export type DebugTokenUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type DebugEvent =
  | {
      kind: "request"
      llmCall: number
      sentAt: number
      model: string
      sampler: { temperature?: number; topP?: number; maxTokens?: number }
      systemPromptChars: number
      payload?: unknown
    }
  | {
      kind: "response"
      llmCall: number
      receivedAt: number
      stopReason?: string
      text?: string
      thinking?: string
      tokenUsage?: DebugTokenUsage
    }
  | {
      kind: "tool_call_start"
      toolName: string
      toolCallId: string
      args: unknown
      startedAt: number
    }
  | {
      kind: "tool_call_end"
      toolName: string
      toolCallId: string
      durationMs: number
      isError: boolean
      result?: unknown
    }
  | {
      kind: "compaction_start"
      reason: string
      tokensBefore?: number
      at: number
    }
  | {
      kind: "compaction_end"
      tokensAfter?: number
      at: number
      aborted: boolean
    }
  | {
      kind: "agent_end"
      stopReason: string
      tokenUsage: DebugTokenUsage
      durationMs: number
    }
  | { kind: "error"; message: string; llmCall?: number; toolName?: string }
  // Fires when our `shouldStopAfterTurn` halted the loop mid-turn
  // because context usage crossed the compaction threshold.
  | {
      kind: "mid_turn_stop"
      reason: "threshold"
      contextTokens: number
      contextWindow: number
      reserveTokens: number
      at: number
    }
  // Pi-mono retry lifecycle (auto_retry_start / auto_retry_end).
  | {
      kind: "retry_attempt"
      phase: "start" | "end"
      attempt: number
      maxAttempts?: number
      success?: boolean
      errorMessage?: string
      at: number
    }

// One slot per runId. Empty array = run is debug-enabled but no
// events have arrived yet (header still renders). Missing key =
// no debug on this run at all (panel is skipped).
const store = new Map<string, DebugEvent[]>()
const listeners = new Map<string, Set<() => void>>()

// Snapshot identities — useSyncExternalStore needs stable references
// across re-renders so it can short-circuit when nothing changed.
const snapshots = new Map<string, DebugEvent[]>()
const EMPTY: DebugEvent[] = []

const notify = (runId: string): void => {
  const set = listeners.get(runId)
  if (!set) return
  for (const fn of set) fn()
}

/** Push an event into the bucket for the given runId. New keys are
 *  created lazily so the panel renders the moment the first event
 *  lands. The snapshot reference is invalidated so the next read
 *  produces a fresh array. */
export const appendDebugEvent = (runId: string, event: DebugEvent): void => {
  const list = store.get(runId)
  if (list) {
    list.push(event)
  } else {
    store.set(runId, [event])
  }
  snapshots.delete(runId)
  notify(runId)
}

/** Seed a run's bucket from the server-persisted events (fetched once
 *  on DebugPanel mount after a reload). Only seeds when the store has
 *  NO entry for the runId yet — if live SSE events have already started
 *  landing for this run we must not clobber them with a stale snapshot
 *  (the live stream is authoritative for an in-flight run; the persisted
 *  copy could be behind by a few events). The presence of a key (even
 *  an empty array) means "this run is already tracked" — we leave it. */
export const seedDebugEvents = (
  runId: string,
  events: DebugEvent[],
): void => {
  if (store.has(runId)) return
  // Copy the incoming array so the caller can't mutate our slot, and so
  // future appends produce a fresh reference for useSyncExternalStore.
  store.set(runId, events.slice())
  snapshots.delete(runId)
  notify(runId)
}

/** Drop a run's events. Not called today; provided so a future
 *  "clear" affordance can wipe a single panel without reloading. */
export const clearDebugEvents = (runId: string): void => {
  store.delete(runId)
  snapshots.delete(runId)
  notify(runId)
}

/** Read-only snapshot for non-React callers (e.g. the download
 *  handler in DebugPanel). Returns a frozen array so the caller
 *  can't mutate the store. */
export const getDebugEvents = (runId: string): ReadonlyArray<DebugEvent> => {
  return store.get(runId) ?? EMPTY
}

const getSnapshot = (runId: string): DebugEvent[] => {
  const cached = snapshots.get(runId)
  if (cached) return cached
  const list = store.get(runId) ?? EMPTY
  // Freeze the array reference so future appends produce a fresh
  // array and useSyncExternalStore detects the change. We don't
  // freeze contents — JSON.stringify needs to walk them.
  snapshots.set(runId, list.slice())
  return snapshots.get(runId)!
}

/** Subscribe to a single run's debug events. Returns the current
 *  array; useSyncExternalStore re-renders the component when a new
 *  event lands. */
export const useDebugEvents = (runId: string): DebugEvent[] => {
  return useSyncExternalStore(
    (cb) => {
      let set = listeners.get(runId)
      if (!set) {
        set = new Set()
        listeners.set(runId, set)
      }
      set.add(cb)
      return (): void => {
        set?.delete(cb)
        if (set && set.size === 0) listeners.delete(runId)
      }
    },
    () => getSnapshot(runId),
    () => getSnapshot(runId),
  )
}
