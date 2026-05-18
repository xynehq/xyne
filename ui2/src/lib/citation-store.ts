// Per-conversation, persisted store for the citation panel.
//
// State shape:
//   scopes:        { [conversationId]: { tabs, activeItemId } }
//   currentScope:  the conversation currently being viewed by the chat
//                  route. Read from here so navigating away from a chat
//                  hides its tabs without losing them.
//   pendingId:     transient id while a resolveCitation() is in flight.
//
// Persistence:
//   The scopes map is mirrored to localStorage under a single key so a
//   reload restores every conversation's tabs. We omit pendingId/error —
//   transient state shouldn't survive.
//
// API:
//   useCitationStore()  — derived view: tabs + activeItemId for the
//                         current scope + pending* fields.
//   setScope(convId)    — called by the chat route on mount.
//   openCitation(...)   — adds/updates a tab in the current scope.
//   setActiveTab(id)    — switch tab.
//   closeTab(id)        — close a single tab.
//   closeCitation()     — close all tabs for the current scope.

import { useSyncExternalStore } from "react"

import { resolveCitation, type CitationTarget } from "@/lib/kb"

export type CitationTab = {
  itemId: string
  collectionId: string
  name: string
  docId: string
  chunkIndex: number | null
  pageNumber: number | null
  /** Short phrase fed into pdf.js's findController to highlight the
   *  cited passage on the page. Populated by the resolve endpoint. */
  chunkText: string | null
  // Monotonic counter bumped on every click landing on this tab. PdfViewer
  // re-scrolls to pageNumber and re-applies highlightQuery whenever this
  // changes (so re-clicking the same chunk also re-fires both).
  navSeq: number
}

type Scope = {
  tabs: CitationTab[]
  activeItemId: string | null
  /** When true, the panel renders as a thin collapsed strip and the chat
   *  takes the full width. Tabs and per-tab viewer state are preserved
   *  — the viewers stay mounted off-screen so re-expanding is instant. */
  collapsed?: boolean
}

type InternalState = {
  scopes: Record<string, Scope>
  currentScope: string | null
  pendingId: string | null
  pendingError: string | null
}

const STORAGE_KEY = "citationTabsByConv:v1"

const loadFromStorage = (): Record<string, Scope> => {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, Scope>
    }
    return {}
  } catch {
    return {}
  }
}

const persist = (scopes: Record<string, Scope>): void => {
  if (typeof window === "undefined") return
  try {
    // Drop empty scopes so the blob doesn't grow forever.
    const trimmed: Record<string, Scope> = {}
    for (const [k, v] of Object.entries(scopes)) {
      if (v.tabs.length > 0) trimmed[k] = v
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    // Quota / disabled storage — ignore; tabs simply won't persist.
  }
}

let state: InternalState = {
  scopes: loadFromStorage(),
  currentScope: null,
  pendingId: null,
  pendingError: null,
}
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const fn of listeners) fn()
}

const setState = (next: InternalState, options?: { persist?: boolean }): void => {
  state = next
  if (options?.persist !== false) persist(next.scopes)
  emit()
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

// Derived view consumed by the panel — flattens currentScope so the
// component doesn't have to keep doing the lookup itself.
export type CitationStoreView = {
  tabs: CitationTab[]
  activeItemId: string | null
  collapsed: boolean
  pendingId: string | null
  pendingError: string | null
}

const EMPTY_SCOPE: Scope = { tabs: [], activeItemId: null, collapsed: false }

// Cache the derived view per state object so identity is stable when the
// underlying scope hasn't changed — required for useSyncExternalStore to
// avoid an infinite re-render loop.
let lastViewState: InternalState | null = null
let lastView: CitationStoreView | null = null

const getView = (): CitationStoreView => {
  if (lastViewState === state && lastView) return lastView
  const scope = state.currentScope
    ? (state.scopes[state.currentScope] ?? EMPTY_SCOPE)
    : EMPTY_SCOPE
  lastView = {
    tabs: scope.tabs,
    activeItemId: scope.activeItemId,
    collapsed: scope.collapsed ?? false,
    pendingId: state.pendingId,
    pendingError: state.pendingError,
  }
  lastViewState = state
  return lastView
}

export const useCitationStore = (): CitationStoreView =>
  useSyncExternalStore(subscribe, getView, getView)

// ── Scope management ───────────────────────────────────────────────────

export const setScope = (conversationId: string | null): void => {
  if (state.currentScope === conversationId) return
  setState({
    ...state,
    currentScope: conversationId,
    pendingId: null,
    pendingError: null,
  })
}

// ── Mutations ──────────────────────────────────────────────────────────

const updateScope = (
  convId: string,
  fn: (s: Scope) => Scope,
): Record<string, Scope> => {
  const current = state.scopes[convId] ?? EMPTY_SCOPE
  const next = fn(current)
  return { ...state.scopes, [convId]: next }
}

export const closeCitation = (): void => {
  const convId = state.currentScope
  if (!convId) return
  const nextScopes = { ...state.scopes }
  delete nextScopes[convId]
  setState({
    ...state,
    scopes: nextScopes,
    pendingId: null,
    pendingError: null,
  })
}

export const closeTab = (itemId: string): void => {
  const convId = state.currentScope
  if (!convId) return
  setState({
    ...state,
    scopes: updateScope(convId, (s) => {
      const idx = s.tabs.findIndex((t) => t.itemId === itemId)
      if (idx === -1) return s
      const tabs = s.tabs.slice(0, idx).concat(s.tabs.slice(idx + 1))
      const wasActive = s.activeItemId === itemId
      const activeItemId = wasActive
        ? (tabs[idx]?.itemId ?? tabs[idx - 1]?.itemId ?? null)
        : s.activeItemId
      return { tabs, activeItemId }
    }),
  })
}

export const setCollapsed = (collapsed: boolean): void => {
  const convId = state.currentScope
  if (!convId) return
  setState({
    ...state,
    scopes: updateScope(convId, (s) => ({ ...s, collapsed })),
  })
}

export const setActiveTab = (itemId: string): void => {
  const convId = state.currentScope
  if (!convId) return
  setState({
    ...state,
    scopes: updateScope(convId, (s) =>
      s.tabs.some((t) => t.itemId === itemId)
        ? { ...s, activeItemId: itemId }
        : s,
    ),
  })
}

const upsertTab = (target: CitationTarget): void => {
  const convId = state.currentScope
  if (!convId) return
  setState({
    ...state,
    scopes: updateScope(convId, (s) => {
      const existing = s.tabs.find((t) => t.itemId === target.itemId)
      if (existing) {
        const tabs = s.tabs.map((t) =>
          t.itemId === target.itemId
            ? {
                ...t,
                docId: target.docId,
                chunkIndex: target.chunkIndex,
                pageNumber: target.pageNumber,
                chunkText: target.chunkText,
                navSeq: t.navSeq + 1,
              }
            : t,
        )
        return { tabs, activeItemId: target.itemId }
      }
      const tab: CitationTab = {
        itemId: target.itemId,
        collectionId: target.collectionId,
        name: target.name,
        docId: target.docId,
        chunkIndex: target.chunkIndex,
        pageNumber: target.pageNumber,
        chunkText: target.chunkText,
        navSeq: 1,
      }
      return { tabs: [...s.tabs, tab], activeItemId: target.itemId }
    }),
    pendingId: null,
    pendingError: null,
  })
}

export const openCitation = async (
  docId: string,
  chunkIndex: number | null,
): Promise<void> => {
  if (!state.currentScope) return
  const pendingId = `pending-${docId}#${String(chunkIndex ?? "")}`
  setState(
    { ...state, pendingId, pendingError: null },
    { persist: false },
  )
  try {
    const target = await resolveCitation(docId, chunkIndex)
    if (state.pendingId !== pendingId) return
    upsertTab(target)
  } catch (err) {
    if (state.pendingId !== pendingId) return
    const message = err instanceof Error ? err.message : String(err)
    setState(
      { ...state, pendingId: null, pendingError: message },
      { persist: false },
    )
  }
}
