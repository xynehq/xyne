// Tiny store for the citation slide-over.
//
// The active citation is whatever was clicked most recently in a MessageBubble.
// The chat route subscribes via `useActiveCitation` and renders
// <CitationPanel> when set. Clearing it closes the panel.

import { useSyncExternalStore } from "react"

import { resolveCitation, type CitationTarget } from "@/lib/kb"

export type ActiveCitation = {
  status: "loading" | "ready" | "error"
  // Echoed back from the click so we can preserve a "[1]" label etc. when
  // numbering needs to survive across re-resolves.
  docId: string
  chunkIndex: number | null
  target?: CitationTarget
  error?: string
}

let active: ActiveCitation | null = null
const listeners = new Set<() => void>()

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

const emit = (): void => {
  for (const fn of listeners) fn()
}

const getSnapshot = (): ActiveCitation | null => active

export const useActiveCitation = (): ActiveCitation | null =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

export const closeCitation = (): void => {
  active = null
  emit()
}

export const openCitation = async (
  docId: string,
  chunkIndex: number | null,
): Promise<void> => {
  active = { status: "loading", docId, chunkIndex }
  emit()
  try {
    const target = await resolveCitation(docId, chunkIndex)
    // If user has clicked another citation while we were resolving, skip.
    if (active?.docId !== docId || active.chunkIndex !== chunkIndex) {
      return
    }
    active = { status: "ready", docId, chunkIndex, target }
    emit()
  } catch (err) {
    if (active?.docId !== docId || active.chunkIndex !== chunkIndex) {
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    active = { status: "error", docId, chunkIndex, error: message }
    emit()
  }
}
