// Tabs for the "View Vespa document" inspector. These live in the
// same right-side panel as the Debug timeline (DebugDock multi-tab
// strip), keyed by docId so re-clicking the same PDF's button just
// re-activates the existing tab instead of duplicating it.

import { useSyncExternalStore } from "react"

export type VespaDocTab = {
  docId: string
  // Friendly display name (the PDF's file name when known) — used
  // for the tab strip label so users don't read raw doc ids.
  name: string
  // Optional KB linkage so the panel can show breadcrumb-style
  // metadata in the body.
  itemId?: string
  collectionId?: string
}

type State = {
  tabs: VespaDocTab[]
  activeDocId: string | null
}

let state: State = { tabs: [], activeDocId: null }
const listeners = new Set<() => void>()

const notify = (): void => {
  for (const l of listeners) l()
}

export const openVespaDoc = (tab: VespaDocTab): void => {
  const exists = state.tabs.find((t) => t.docId === tab.docId)
  if (exists) {
    state = { ...state, activeDocId: tab.docId }
  } else {
    state = {
      tabs: [...state.tabs, tab],
      activeDocId: tab.docId,
    }
  }
  notify()
}

export const setActiveVespaDoc = (docId: string): void => {
  if (state.activeDocId === docId) return
  if (!state.tabs.some((t) => t.docId === docId)) return
  state = { ...state, activeDocId: docId }
  notify()
}

export const closeVespaDoc = (docId: string): void => {
  const next = state.tabs.filter((t) => t.docId !== docId)
  let active = state.activeDocId
  if (active === docId) {
    active = next.length > 0 ? (next[next.length - 1]?.docId ?? null) : null
  }
  state = { tabs: next, activeDocId: active }
  notify()
}

export const closeAllVespaDocs = (): void => {
  if (state.tabs.length === 0 && state.activeDocId === null) return
  state = { tabs: [], activeDocId: null }
  notify()
}

export const useVespaDocs = (): State =>
  useSyncExternalStore(
    (cb): (() => void) => {
      listeners.add(cb)
      return (): void => {
        listeners.delete(cb)
      }
    },
    (): State => state,
    (): State => state,
  )
