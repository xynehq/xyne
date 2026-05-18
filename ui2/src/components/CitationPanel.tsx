// Right-side document viewer that lives in-flow next to the chat column.
//
// Multi-tab: every unique source file (keyed on itemId) is a tab.
// - Clicking a citation for a new file opens a tab and activates it.
// - Clicking a citation for an already-open file just switches to that
//   tab and jumps to the new chunk's page (the viewer doesn't reload).
// - Tabs can be closed individually with their X; the panel closes when
//   the last tab is closed.

import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown, Loader2, PanelRightClose, X } from "lucide-react"

import { PdfViewer } from "@/components/PdfViewer"
import {
  closeCitation,
  closeTab,
  setActiveTab,
  setCollapsed,
  useCitationStore,
} from "@/lib/citation-store"

// Pixel bounds for the resize. We clamp at both ends so the panel can't
// vanish or eat the whole chat surface; the chat column always keeps at
// least ~360px breathing room.
const MIN_WIDTH = 360
const MAX_WIDTH_VIEWPORT_FRACTION = 0.75
const DEFAULT_WIDTH = 560
const STORAGE_KEY = "citationPanelWidthPx"

const readStoredWidth = (): number => {
  if (typeof window === "undefined") return DEFAULT_WIDTH
  const raw = window.localStorage.getItem(STORAGE_KEY)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n >= MIN_WIDTH ? n : DEFAULT_WIDTH
}

export function CitationPanel(): JSX.Element | null {
  const { tabs, activeItemId, collapsed, pendingId, pendingError } =
    useCitationStore()
  const [width, setWidth] = useState<number>(readStoredWidth)
  const [tabListOpen, setTabListOpen] = useState<boolean>(false)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const tabListRef = useRef<HTMLDivElement | null>(null)

  // Close the tab-list popup on outside click + Esc.
  useEffect((): (() => void) | undefined => {
    if (!tabListOpen) return undefined
    const onDocClick = (e: MouseEvent): void => {
      if (
        tabListRef.current &&
        !tabListRef.current.contains(e.target as Node)
      ) {
        setTabListOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setTabListOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    window.addEventListener("keydown", onKey)
    return (): void => {
      document.removeEventListener("mousedown", onDocClick)
      window.removeEventListener("keydown", onKey)
    }
  }, [tabListOpen])

  // ESC closes the panel — convenient when the user is keyboard-driven.
  useEffect((): (() => void) | undefined => {
    if (tabs.length === 0 && !pendingId) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeCitation()
    }
    window.addEventListener("keydown", onKey)
    return (): void => {
      window.removeEventListener("keydown", onKey)
    }
  }, [tabs.length, pendingId])

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
      const clamped = Math.min(maxWidth, Math.max(MIN_WIDTH, next))
      setWidth(clamped)
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

  // Panel is empty — render nothing.
  if (tabs.length === 0 && !pendingId && !pendingError) return null
  // Hidden by the user. The chat Topbar surfaces a "Show panel" button
  // that flips this flag back; tabs stay alive in the store meanwhile.
  if (collapsed) return null

  return (
    <aside
      className="relative flex h-full flex-shrink-0 flex-col border-l border-border bg-background"
      style={{ width: `${String(width)}px` }}
      role="complementary"
      aria-label="Source document"
    >
      {/* Drag handle — thin invisible strip on the panel's left edge. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize source panel"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize select-none after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-transparent hover:after:bg-primary/40"
      />

      {/* Tab strip — one chip per open document. Active chip is highlighted
          and shows a close button. Inactive chips switch on click. The
          strip is horizontally scrollable; a leading "all tabs" button
          opens a popover listing every open document so the user can
          jump to a tab even when its chip is scrolled out of view. */}
      {tabs.length > 0 && (
        <div className="flex h-9 items-stretch gap-1 border-b border-border bg-surface-muted/40 px-1.5 py-1">
          <div ref={tabListRef} className="relative flex-shrink-0">
            <button
              type="button"
              aria-label="Show all open tabs"
              aria-expanded={tabListOpen}
              onClick={(): void => {
                setTabListOpen((v) => !v)
              }}
              className="flex h-full items-center gap-0.5 rounded-md border border-transparent px-1 text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground"
              title="All open tabs"
            >
              <span className="text-[11px] font-medium tabular-nums">
                {String(tabs.length)}
              </span>
              <ChevronDown className="h-3 w-3" aria-hidden strokeWidth={1.75} />
            </button>
            {tabListOpen && (
              <div
                role="menu"
                className="absolute left-0 top-full z-20 mt-1 max-h-[60vh] w-[280px] overflow-y-auto rounded-md border border-border bg-background py-1 shadow-lg"
              >
                {tabs.map((t) => {
                  const isActive = t.itemId === activeItemId
                  return (
                    <button
                      key={t.itemId}
                      type="button"
                      role="menuitem"
                      onClick={(): void => {
                        setActiveTab(t.itemId)
                        setTabListOpen(false)
                      }}
                      className={`flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-[12px] transition ${
                        isActive
                          ? "bg-secondary text-foreground"
                          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                      }`}
                      title={t.name}
                    >
                      <span className="line-clamp-2 flex-1">{t.name}</span>
                      {t.chunkIndex !== null && (
                        <span className="flex-shrink-0 text-[10.5px] text-muted-foreground/70 tabular-nums">
                          ch {t.chunkIndex}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          <div className="flex flex-1 items-stretch gap-1 overflow-x-auto">
          {tabs.map((t) => {
            const isActive = t.itemId === activeItemId
            return (
              <div
                key={t.itemId}
                className={`group flex max-w-[200px] flex-shrink-0 items-center gap-1.5 rounded-md border px-2 text-[12px] transition ${
                  isActive
                    ? "border-border bg-background text-foreground"
                    : "cursor-pointer border-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                }`}
                onClick={(): void => {
                  if (!isActive) setActiveTab(t.itemId)
                }}
              >
                <span
                  className="truncate"
                  title={t.name}
                >
                  {t.name}
                </span>
                <button
                  type="button"
                  aria-label={`Close ${t.name}`}
                  onClick={(e): void => {
                    e.stopPropagation()
                    closeTab(t.itemId)
                  }}
                  className="grid h-4 w-4 flex-shrink-0 place-items-center rounded text-muted-foreground/70 transition hover:bg-secondary hover:text-foreground"
                >
                  <X className="h-3 w-3" aria-hidden strokeWidth={1.75} />
                </button>
              </div>
            )
          })}
          {pendingId && (
            <div className="flex items-center gap-1 px-2 text-[12px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden strokeWidth={1.75} />
              Resolving…
            </div>
          )}
          </div>

          {/* Extreme-right controls: minimize the whole panel (keeps tabs
              in the store; chat Topbar surfaces a "Show panel" button to
              bring it back) and close-all (drops every tab for this
              conversation). */}
          <div className="flex flex-shrink-0 items-center gap-0.5 border-l border-border pl-1">
            <button
              type="button"
              aria-label="Hide source panel"
              title="Hide panel"
              onClick={(): void => {
                setCollapsed(true)
              }}
              className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <PanelRightClose
                className="h-3.5 w-3.5"
                aria-hidden
                strokeWidth={1.75}
              />
            </button>
            <button
              type="button"
              aria-label="Close all sources"
              title="Close all tabs"
              onClick={closeCitation}
              className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
            </button>
          </div>
        </div>
      )}

      {/* Body — first-citation loading, error, or the active viewer. */}
      {tabs.length === 0 && pendingId && (
        <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden strokeWidth={1.75} />
          Resolving citation…
        </div>
      )}
      {tabs.length === 0 && pendingError && (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="text-[14px] font-medium text-foreground">
            Could not open this source
          </p>
          <p className="text-[12.5px] text-muted-foreground">{pendingError}</p>
        </div>
      )}
      {/* Every tab stays mounted, stacked at `position: absolute inset-0`.
          Inactive tabs use `visibility: hidden` + `pointer-events: none`
          rather than `display: none` — display:none resets the scroll
          container's scrollTop to 0 on re-show, which kills our
          per-tab scroll memory. visibility:hidden keeps the layout (and
          scroll position) intact while hiding the pixels. We also drop
          interaction-blocking on inactive tabs so stray text-layer
          clicks don't land on the hidden viewer. */}
      {tabs.length > 0 && (
        <div className="relative min-h-0 flex-1">
          {tabs.map((t) => {
            const isActive = t.itemId === activeItemId
            return (
              <div
                key={t.itemId}
                aria-hidden={!isActive}
                style={{
                  visibility: isActive ? "visible" : "hidden",
                  pointerEvents: isActive ? "auto" : "none",
                }}
                className="absolute inset-0 flex flex-col"
              >
                <PdfViewer
                  clId={t.collectionId}
                  itemId={t.itemId}
                  {...(t.pageNumber !== null
                    ? { initialPage: t.pageNumber }
                    : {})}
                  navSeq={t.navSeq}
                  docName={t.name}
                  hideDownload
                  // Close *just this tab* from the viewer's toolbar X.
                  // The panel-level close-all lives at the extreme right
                  // of the tab strip.
                  onClose={(): void => {
                    closeTab(t.itemId)
                  }}
                />
              </div>
            )
          })}
        </div>
      )}
    </aside>
  )
}
