// Right-side slide-over that shows the document for the active citation.
//
// Loading and rendering reuses the existing /kb/file viewer route via an
// iframe, with `?cl=<cid>&page=<n>` query params. The iframe is recreated
// (keyed on docId+chunk) whenever the citation changes so the viewer
// remounts cleanly at the new page.
//
// We use an iframe rather than mounting the route inline because the
// viewer route owns its own auth guard, breadcrumb fetch, and PDF.js
// worker bootstrap — embedding it here would duplicate that wiring.

import { useEffect } from "react"
import { Loader2, X } from "lucide-react"

import { useActiveCitation, closeCitation } from "@/lib/citation-store"

export function CitationPanel(): JSX.Element | null {
  const active = useActiveCitation()

  // ESC closes the panel — convenient when the user is keyboard-driven.
  useEffect((): (() => void) | undefined => {
    if (!active) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeCitation()
    }
    window.addEventListener("keydown", onKey)
    return (): void => {
      window.removeEventListener("keydown", onKey)
    }
  }, [active])

  if (!active) return null

  return (
    <>
      {/* Backdrop — click anywhere outside the panel to close. Translucent
          rather than opaque so the chat stays visible behind it. */}
      <div
        className="fixed inset-0 z-40 bg-background/30 backdrop-blur-[1px]"
        onClick={closeCitation}
        aria-hidden
      />
      <aside
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[60vw] flex-col border-l border-border bg-background shadow-xl"
        role="dialog"
        aria-label="Source document"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <p
              className="truncate text-[13px] font-medium text-foreground"
              title={active.target?.name ?? active.docId}
            >
              {active.target?.name ?? active.docId}
            </p>
            {active.chunkIndex !== null && (
              <p className="truncate text-[11px] text-muted-foreground">
                chunk {active.chunkIndex}
                {active.target?.pageNumber !== undefined &&
                active.target?.pageNumber !== null
                  ? ` · page ${String(active.target.pageNumber)}`
                  : ""}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label="Close source"
            onClick={closeCitation}
            className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex-1 overflow-hidden">
          {active.status === "loading" && (
            <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden strokeWidth={1.75} />
              Resolving citation…
            </div>
          )}
          {active.status === "error" && (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
              <p className="text-[14px] font-medium text-foreground">
                Could not open this source
              </p>
              <p className="text-[12.5px] text-muted-foreground">{active.error}</p>
            </div>
          )}
          {active.status === "ready" && active.target && (
            <iframe
              // Key the iframe on docId+chunk so navigating between citations
              // remounts the viewer at the new page rather than relying on
              // it to react to a URL-prop change.
              key={`${active.target.itemId}#${String(active.chunkIndex ?? "")}`}
              src={buildViewerUrl(active.target)}
              title={active.target.name}
              className="h-full w-full border-0"
            />
          )}
        </div>
      </aside>
    </>
  )
}

const buildViewerUrl = (t: {
  itemId: string
  collectionId: string
  pageNumber: number | null
}): string => {
  const base = `/kb/file/${t.itemId}?cl=${encodeURIComponent(t.collectionId)}`
  return t.pageNumber !== null ? `${base}&page=${String(t.pageNumber)}` : base
}
