// Tracks which assistant run's debug timeline is open in the right-side
// DebugDock. Mirrors citation-store's shape so the dock behaves like
// CitationPanel: opening selects a target, the user can collapse the
// panel, and closing fully clears state.

import { useSyncExternalStore } from "react"

type DebugDockState = {
  runId: string | null
  conversationId: string | null
  collapsed: boolean
}

let state: DebugDockState = {
  runId: null,
  conversationId: null,
  collapsed: false,
}

const listeners = new Set<() => void>()

const notify = (): void => {
  for (const l of listeners) l()
}

export const openDebugDock = (
  runId: string,
  conversationId: string | null,
): void => {
  state = { runId, conversationId, collapsed: false }
  notify()
}

export const closeDebugDock = (): void => {
  state = { runId: null, conversationId: null, collapsed: false }
  notify()
}

export const setDebugDockCollapsed = (collapsed: boolean): void => {
  if (state.collapsed === collapsed) return
  state = { ...state, collapsed }
  notify()
}

export const useDebugDock = (): DebugDockState =>
  useSyncExternalStore(
    (cb): (() => void) => {
      listeners.add(cb)
      return (): void => {
        listeners.delete(cb)
      }
    },
    (): DebugDockState => state,
    (): DebugDockState => state,
  )
