// Right-side debug + Vespa-document dock. Sits to the right of the
// CitationPanel so the PDF viewer (left of this) and the agent
// timeline / Vespa inspector (right of this) can both be open.
//
// Tabs:
//   • Debug — pinned first, no close button. Shows the
//     DebugTimeline for the currently-selected run. Present
//     whenever a debug runId is active.
//   • Vespa document tabs — one per docId opened via the "View
//     Vespa document" button in the PDF viewer toolbar.
//     Closable individually with their X.
//
// The dock is visible whenever EITHER Debug is active OR at
// least one Vespa-doc tab is open. Width + collapse state are
// persisted to localStorage.

import { useCallback, useEffect, useRef, useState } from "react"
import { Bug, Database, PanelRightClose, X } from "lucide-react"

import { DebugTimeline } from "@/components/DebugPanel"
import { VespaDocView } from "@/components/VespaDocView"
import {
  closeDebugDock,
  setDebugDockCollapsed,
  useDebugDock,
} from "@/lib/debug-dock-store"
import {
  closeAllVespaDocs,
  closeVespaDoc,
  setActiveVespaDoc,
  useVespaDocs,
} from "@/lib/vespa-doc-store"

const MIN_WIDTH = 360
const MAX_WIDTH_VIEWPORT_FRACTION = 0.6
const DEFAULT_WIDTH = 480
const STORAGE_KEY = "debugDockWidthPx"

const DEBUG_TAB = "__debug__"

const readStoredWidth = (): number => {
  if (typeof window === "undefined") return DEFAULT_WIDTH
  const raw = window.localStorage.getItem(STORAGE_KEY)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n >= MIN_WIDTH ? n : DEFAULT_WIDTH
}

export function DebugDock(): JSX.Element | null {
  const { runId, conversationId, collapsed } = useDebugDock()
  const vespa = useVespaDocs()
  const [width, setWidth] = useState<number>(readStoredWidth)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const debugAvailable = !!runId
  // The active tab id is either "__debug__" or a Vespa docId.
  // Default to debug whenever it's available; otherwise follow
  // the vespa store's activeDocId. User clicks override.
  const [activeKey, setActiveKey] = useState<string | null>(() => {
    if (debugAvailable) return DEBUG_TAB
    return vespa.activeDocId
  })

  // When a new vespa doc opens, follow it (the user just clicked
  // "View Vespa document"). When Debug becomes newly available,
  // jump to it.
  const lastRunIdRef = useRef<string | null>(runId)
  useEffect((): void => {
    if (runId && runId !== lastRunIdRef.current) {
      lastRunIdRef.current = runId
      setActiveKey(DEBUG_TAB)
    } else if (!runId) {
      lastRunIdRef.current = null
    }
  }, [runId])
  useEffect((): void => {
    if (
      vespa.activeDocId &&
      activeKey !== vespa.activeDocId &&
      activeKey !== DEBUG_TAB
    ) {
      setActiveKey(vespa.activeDocId)
    }
  }, [vespa.activeDocId, activeKey])

  // Reconcile when the current active key disappears.
  useEffect((): void => {
    if (activeKey === DEBUG_TAB && !debugAvailable) {
      setActiveKey(vespa.activeDocId)
      return
    }
    if (
      activeKey &&
      activeKey !== DEBUG_TAB &&
      !vespa.tabs.some((t) => t.docId === activeKey)
    ) {
      if (debugAvailable) {
        setActiveKey(DEBUG_TAB)
      } else if (vespa.tabs.length > 0) {
        setActiveKey(vespa.tabs[vespa.tabs.length - 1]?.docId ?? null)
      } else {
        setActiveKey(null)
      }
    }
  }, [activeKey, debugAvailable, vespa.tabs, vespa.activeDocId])

  useEffect((): (() => void) | undefined => {
    if (collapsed) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setDebugDockCollapsed(true)
    }
    window.addEventListener("keydown", onKey)
    return (): void => {
      window.removeEventListener("keydown", onKey)
    }
  }, [collapsed])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      e.preventDefault()
      ;(e.target as Element).setPointerCapture(e.pointerId)
      dragRef.current = { startX: e.clientX, startWidth: width }
    },
    [width],
  )
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!dragRef.current) return
      const dx = e.clientX - dragRef.current.startX
      const next = dragRef.current.startWidth - dx
      const maxWidth = Math.max(
        MIN_WIDTH + 80,
        Math.floor(window.innerWidth * MAX_WIDTH_VIEWPORT_FRACTION),
      )
      setWidth(Math.min(maxWidth, Math.max(MIN_WIDTH, next)))
    },
    [],
  )
  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!dragRef.current) return
      ;(e.target as Element).releasePointerCapture(e.pointerId)
      dragRef.current = null
      window.localStorage.setItem(STORAGE_KEY, String(width))
    },
    [width],
  )

  if (collapsed) return null
  if (!debugAvailable && vespa.tabs.length === 0) return null

  const onCloseActive = (): void => {
    if (activeKey === DEBUG_TAB) {
      closeDebugDock()
    } else if (activeKey) {
      closeVespaDoc(activeKey)
    }
  }

  return (
    <aside
      className="relative flex h-full flex-shrink-0 flex-col border-l border-border bg-background"
      style={{ width: `${String(width)}px` }}
      role="complementary"
      aria-label="Agent debug + Vespa document inspector"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize debug panel"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize select-none after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-transparent hover:after:bg-primary/40"
      />

      <div className="flex h-9 items-stretch gap-1 border-b border-border bg-surface-muted/40 px-1.5 py-1">
        <div className="flex flex-1 items-stretch gap-1 overflow-x-auto">
          {debugAvailable && (
            <div
              role="tab"
              aria-selected={activeKey === DEBUG_TAB}
              onClick={(): void => {
                if (activeKey !== DEBUG_TAB) setActiveKey(DEBUG_TAB)
              }}
              className={`flex flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[12px] transition ${
                activeKey === DEBUG_TAB
                  ? "border-border bg-background text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              }`}
              title="Debug timeline (pinned)"
            >
              <Bug className="h-3 w-3 flex-shrink-0" aria-hidden strokeWidth={1.75} />
              <span>Debug</span>
              {/* No X — debug tab is pinned. The dock-level Close X
                  in the right-side controls tears down the run. */}
            </div>
          )}
          {vespa.tabs.map((t) => (
            <div
              key={t.docId}
              role="tab"
              aria-selected={activeKey === t.docId}
              onClick={(): void => {
                if (activeKey !== t.docId) {
                  setActiveVespaDoc(t.docId)
                  setActiveKey(t.docId)
                }
              }}
              className={`group flex max-w-[200px] flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[12px] transition ${
                activeKey === t.docId
                  ? "border-border bg-background text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              }`}
              title={`${t.name} · ${t.docId}`}
            >
              <Database className="h-3 w-3 flex-shrink-0" aria-hidden strokeWidth={1.75} />
              <span className="truncate">{t.name}</span>
              <button
                type="button"
                aria-label={`Close ${t.name}`}
                onClick={(e): void => {
                  e.stopPropagation()
                  closeVespaDoc(t.docId)
                }}
                className="grid h-4 w-4 flex-shrink-0 place-items-center rounded text-muted-foreground/70 transition hover:bg-secondary hover:text-foreground"
              >
                <X className="h-3 w-3" aria-hidden strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>

        <div className="flex flex-shrink-0 items-center gap-0.5 border-l border-border pl-1">
          <button
            type="button"
            aria-label="Hide debug panel"
            title="Hide panel"
            onClick={(): void => {
              setDebugDockCollapsed(true)
            }}
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <PanelRightClose className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
          </button>
          {(activeKey === DEBUG_TAB || activeKey) && (
            <button
              type="button"
              aria-label={activeKey === DEBUG_TAB ? "Close debug" : "Close tab"}
              title={activeKey === DEBUG_TAB ? "Close debug" : "Close tab"}
              onClick={onCloseActive}
              className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
            </button>
          )}
          {vespa.tabs.length > 1 && (
            <button
              type="button"
              aria-label="Close all Vespa docs"
              title="Close all Vespa tabs"
              onClick={closeAllVespaDocs}
              className="hidden"
            >
              <X className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
            </button>
          )}
        </div>
      </div>

      {/* Body. Debug timeline mounts only when active (its store is
          module-level; nothing visual to preserve). Vespa-doc tabs
          stay mounted to preserve their scroll position + raw-fields
          expansion state across tab switches. */}
      <div className="relative min-h-0 flex-1">
        {debugAvailable && runId && (
          <div
            aria-hidden={activeKey !== DEBUG_TAB}
            style={{
              visibility: activeKey === DEBUG_TAB ? "visible" : "hidden",
              pointerEvents: activeKey === DEBUG_TAB ? "auto" : "none",
            }}
            className="absolute inset-0 flex flex-col"
          >
            <DebugTimeline
              runId={runId}
              {...(conversationId ? { conversationId } : {})}
            />
          </div>
        )}
        {vespa.tabs.map((t) => (
          <div
            key={t.docId}
            aria-hidden={activeKey !== t.docId}
            style={{
              visibility: activeKey === t.docId ? "visible" : "hidden",
              pointerEvents: activeKey === t.docId ? "auto" : "none",
            }}
            className="absolute inset-0 flex flex-col"
          >
            <VespaDocView docId={t.docId} name={t.name} />
          </div>
        ))}
      </div>
    </aside>
  )
}
