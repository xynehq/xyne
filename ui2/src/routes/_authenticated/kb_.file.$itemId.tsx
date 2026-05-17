// PDF viewer route. URL: /kb/file/:itemId?cl=:clId
//
// Continuous scroll + virtualized via @tanstack/react-virtual. Only pages
// near the viewport are rendered; everything else is reserved space inside
// a tall container so the scrollbar reflects the full document length.
//
// Topbar shows the real file name (fetched via the breadcrumb endpoint —
// its last segment is the file itself).

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual"
import { Document, Page, pdfjs } from "react-pdf"
import "react-pdf/dist/Page/AnnotationLayer.css"
import "react-pdf/dist/Page/TextLayer.css"
import {
  ArrowLeft,
  ChevronUp,
  ChevronDown,
  Download,
  Loader2,
  Minus,
  Plus,
} from "lucide-react"

import { fileContentUrl, getBreadcrumb } from "@/lib/kb"
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url"

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

type ViewerSearch = { cl?: string }

export const Route = createFileRoute("/_authenticated/kb_/file/$itemId")({
  validateSearch: (raw: Record<string, unknown>): ViewerSearch => {
    if (typeof raw["cl"] === "string" && raw["cl"] !== "") {
      return { cl: raw["cl"] }
    }
    return {}
  },
  component: PdfViewerRoute,
})

// Estimate before any page has rendered. Over-allocating is harmless (a
// little blank tail); under-allocating causes scroll jumps as canvases mount.
const INITIAL_PAGE_HEIGHT = 1100
// 16px gap between pages so virtualization math matches visual layout.
const PAGE_GAP = 16

function PdfViewerRoute(): JSX.Element {
  const { itemId } = Route.useParams()
  const { cl } = Route.useSearch()
  const navigate = useNavigate()

  const [numPages, setNumPages] = useState<number>(0)
  const [visiblePage, setVisiblePage] = useState<number>(1)
  const [scale, setScale] = useState<number>(1.1)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [docName, setDocName] = useState<string>("Document")

  const scrollRef = useRef<HTMLElement | null>(null)

  const fileUrl = useMemo(
    () => (cl ? fileContentUrl(cl, itemId) : null),
    [cl, itemId],
  )
  const docOptions = useMemo(() => ({ withCredentials: true }), [])

  // Filename for topbar — reuse breadcrumb endpoint (last segment = file).
  useEffect((): (() => void) | undefined => {
    if (!cl) {
      return undefined
    }
    let cancelled = false
    void getBreadcrumb(cl, itemId)
      .then((chain): void => {
        if (cancelled) {
          return
        }
        const last = chain[chain.length - 1]
        if (last?.name) {
          setDocName(last.name)
        }
      })
      .catch((): void => {
        // Silent — topbar keeps "Document" fallback.
      })
    return (): void => {
      cancelled = true
    }
  }, [cl, itemId])

  // Reset when file changes.
  useEffect((): void => {
    setVisiblePage(1)
    setNumPages(0)
    setLoadError(null)
  }, [fileUrl])

  const virtualizer = useVirtualizer({
    count: numPages,
    getScrollElement: () => scrollRef.current,
    // Re-estimate from scale so zoom adjusts placeholder height immediately;
    // measureElement then refines from the real DOM size as pages mount.
    estimateSize: () => Math.round(INITIAL_PAGE_HEIGHT * (scale / 1.1)) + PAGE_GAP,
    overscan: 2,
    measureElement: (el): number => el.getBoundingClientRect().height,
  })

  // Force a re-measure when scale changes — react-virtual caches sizes, and
  // a zoom should invalidate every cached page height.
  useEffect((): void => {
    virtualizer.measure()
  }, [scale, virtualizer])

  // Track which page is "current" for the indicator. Derive from the
  // virtualizer's items + scroll offset: the page whose top is closest to
  // (but not past) the viewport top, plus a small fudge.
  useEffect((): void => {
    if (numPages === 0) {
      return
    }
    const items = virtualizer.getVirtualItems()
    if (items.length === 0) {
      return
    }
    const offset = virtualizer.scrollOffset ?? 0
    // Treat "current" as the page whose top is just above the upper third.
    const root = scrollRef.current
    const threshold = offset + (root ? root.clientHeight * 0.25 : 200)
    let current = items[0]?.index ?? 0
    for (const it of items) {
      if (it.start <= threshold) {
        current = it.index
      } else {
        break
      }
    }
    setVisiblePage(current + 1)
  }, [
    numPages,
    virtualizer,
    // `useVirtualizer` updates on scroll; this dep keeps the effect in sync.
    virtualizer.scrollOffset,
  ])

  const scrollToPage = useCallback(
    (idx1: number): void => {
      virtualizer.scrollToIndex(idx1 - 1, { align: "start", behavior: "smooth" })
    },
    [virtualizer],
  )

  if (!cl || !fileUrl) {
    return (
      <ErrorPane
        title="Missing collection"
        body="This viewer link is missing the cl (collection) parameter."
      />
    )
  }

  const goBack = (): void => {
    void navigate({ to: "/kb", search: { cl } })
  }

  const items = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-background/70 px-4 py-2 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            aria-label="Back to knowledge"
            onClick={goBack}
            className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
          </button>
          <span
            className="truncate text-[13px] font-medium text-foreground"
            title={docName}
          >
            {docName}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Previous page"
            disabled={visiblePage <= 1}
            onClick={(): void => {
              scrollToPage(Math.max(1, visiblePage - 1))
            }}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronUp className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <span className="min-w-[64px] text-center text-[12px] tabular-nums text-muted-foreground">
            {numPages > 0 ? `${String(visiblePage)} / ${String(numPages)}` : "—"}
          </span>
          <button
            type="button"
            aria-label="Next page"
            disabled={numPages > 0 && visiblePage >= numPages}
            onClick={(): void => {
              if (numPages > 0) {
                scrollToPage(Math.min(numPages, visiblePage + 1))
              }
            }}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>

          <span className="mx-2 h-4 w-px bg-border" aria-hidden />

          <button
            type="button"
            aria-label="Zoom out"
            disabled={scale <= 0.5}
            onClick={(): void => {
              setScale((s) => Math.max(0.5, +(s - 0.1).toFixed(2)))
            }}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Minus className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <span className="min-w-[44px] text-center text-[12px] tabular-nums text-muted-foreground">
            {`${String(Math.round(scale * 100))}%`}
          </span>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={scale >= 3}
            onClick={(): void => {
              setScale((s) => Math.min(3, +(s + 0.1).toFixed(2)))
            }}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>

          <span className="mx-2 h-4 w-px bg-border" aria-hidden />

          <Link
            to={fileUrl}
            reloadDocument
            aria-label="Download"
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Link>
        </div>
      </div>

      <main
        ref={scrollRef}
        className="flex-1 overflow-auto bg-surface-muted/30 p-6"
      >
        {loadError ? (
          <ErrorPane title="Could not display this file" body={loadError} />
        ) : (
          <Document
            file={fileUrl}
            options={docOptions}
            onLoadSuccess={({ numPages: n }: { numPages: number }): void => {
              setNumPages(n)
            }}
            onLoadError={(err: Error): void => {
              setLoadError(err.message)
            }}
            loading={
              <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                Loading document…
              </div>
            }
            error={
              <ErrorPane
                title="Failed to load"
                body="The document could not be loaded."
              />
            }
          >
            {numPages > 0 ? (
              <div
                className="relative mx-auto"
                style={{ height: `${String(totalSize)}px` }}
              >
                {items.map((v: VirtualItem) => (
                  <div
                    key={v.key}
                    data-index={v.index}
                    ref={virtualizer.measureElement}
                    className="absolute inset-x-0 flex justify-center"
                    style={{
                      transform: `translateY(${String(v.start)}px)`,
                      paddingBottom: `${String(PAGE_GAP)}px`,
                    }}
                  >
                    <div className="overflow-hidden rounded-md bg-white shadow-md ring-1 ring-border">
                      <Page pageNumber={v.index + 1} scale={scale} />
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </Document>
        )}
      </main>
    </div>
  )
}

function ErrorPane({
  title,
  body,
}: {
  title: string
  body: string
}): JSX.Element {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-2 py-24 text-center">
      <p className="text-[14px] font-medium text-foreground">{title}</p>
      <p className="text-[12.5px] text-muted-foreground">{body}</p>
    </div>
  )
}
