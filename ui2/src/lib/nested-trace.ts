// Cache + loader for sub-agent nested traces (M8).
//
// The chat view renders dispatchSubagent tool chips that can expand
// into the full sub-agent execution timeline. Fetching that nested
// trace is per-(conversation, parent-run) and idempotent, so we keep
// a tiny module-level cache keyed by `${convId}/${parentRunId}` —
// every dispatch chip in the same parent run shares one fetch.
//
// Each entry tracks `loading | loaded | error` so the chip can show
// a spinner, the timeline, or a retry button. useNestedTrace is a
// React hook that subscribes to a single entry via
// useSyncExternalStore.

import { useSyncExternalStore } from "react"

import { apiFetch } from "./api"
import type { Block, MessageStats } from "./chat-store"

// The shape the backend returns from
// GET /v2/chat/conversations/:id/runs/:parentRunId/nested
export type NestedRun = {
  id: string
  conversationId: string
  turnId: string
  agentId: string
  model: string
  status: string
  startedAt: number
  parentRunId: string
  subAgentId?: string
  endedAt?: number
  tokensIn?: number
  tokensOut?: number
  error?: string
}

export type NestedMessage = {
  id: string
  conversationId: string
  turnId: string
  role: "user" | "assistant" | "system"
  ordinal: number
  createdAt: number
  runId: string
  blocks: Block[]
  stats?: MessageStats
}

export type NestedRunEntry = {
  run: NestedRun
  messages: NestedMessage[]
}

export type NestedTraceCacheState =
  | { status: "loading" }
  | { status: "loaded"; nestedRuns: NestedRunEntry[] }
  | { status: "error"; error: string }

const cache = new Map<string, NestedTraceCacheState>()
const listeners = new Map<string, Set<() => void>>()
// Outstanding load promises — second / Nth concurrent reads piggyback
// on the same fetch rather than racing duplicate requests.
const inflight = new Map<string, Promise<void>>()

const keyOf = (convId: string, parentRunId: string): string =>
  `${convId}|${parentRunId}`

const notify = (key: string): void => {
  const ls = listeners.get(key)
  if (!ls) return
  for (const fn of ls) fn()
}

const setState = (key: string, state: NestedTraceCacheState): void => {
  cache.set(key, state)
  notify(key)
}

/** Idempotent loader. Subsequent calls during an in-flight fetch
 *  resolve to the same promise so the network roundtrip happens
 *  exactly once per (conv, parentRun). */
export const loadNestedTrace = (
  convId: string,
  parentRunId: string,
): Promise<void> => {
  const key = keyOf(convId, parentRunId)
  const existing = inflight.get(key)
  if (existing) return existing
  const current = cache.get(key)
  if (current && current.status === "loaded") return Promise.resolve()
  setState(key, { status: "loading" })
  const p = (async (): Promise<void> => {
    try {
      const res = await apiFetch<{ nestedRuns: NestedRunEntry[] }>(
        `/v2/chat/conversations/${encodeURIComponent(
          convId,
        )}/runs/${encodeURIComponent(parentRunId)}/nested`,
      )
      setState(key, { status: "loaded", nestedRuns: res.nestedRuns })
    } catch (err) {
      setState(key, {
        status: "error",
        error: err instanceof Error ? err.message : "failed to load",
      })
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}

/** Drop a cached entry — used when a turn re-runs and the previous
 *  nested-runs are no longer relevant. Not called from M8's first
 *  cut; reserved for future replay-from-scratch scenarios. */
export const evictNestedTrace = (convId: string, parentRunId: string): void => {
  const key = keyOf(convId, parentRunId)
  cache.delete(key)
  inflight.delete(key)
  notify(key)
}

/** Subscribe to a (conv, parent-run) entry. Returns the current
 *  state synchronously; the chip can render a `loading` UI while
 *  the fetch is in flight. */
export const useNestedTrace = (
  convId: string,
  parentRunId: string,
): NestedTraceCacheState | undefined => {
  const key = keyOf(convId, parentRunId)
  return useSyncExternalStore(
    (cb) => {
      let set = listeners.get(key)
      if (!set) {
        set = new Set()
        listeners.set(key, set)
      }
      set.add(cb)
      return () => {
        set?.delete(cb)
        if (set && set.size === 0) listeners.delete(key)
      }
    },
    () => cache.get(key),
    () => cache.get(key),
  )
}
