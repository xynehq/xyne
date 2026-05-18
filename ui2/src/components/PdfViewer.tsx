// PDF viewer built on pdf.js's native `PDFViewer` component (the same
// renderer Firefox ships). Used by:
//
//   - `/_authenticated/kb_/file/$itemId` — full-page route, with a Back
//     button passed via `leading` and a Download link.
//   - `<CitationPanel>` — the citation slide-over, with `onClose` and
//     `hideDownload`.
//
// Why pdf.js's viewer (and not react-pdf): react-pdf gave us visible
// flicker on virtualized scroll because page heights were estimated
// up-front and remeasured on mount, plus pages unmounted on overscan
// (white flashes on scroll-back). pdf.js's PDFViewer pre-measures every
// page from the PDF's viewport, keeps a buffer of rendered pages, has
// built-in text-layer rendering, and ships its own findController that
// integrates cleanly with the buffered renderer.
//
// React's job here is just:
//   1. Mount the viewer once when the file URL changes.
//   2. Bridge our toolbar (page input, zoom, search) to viewer events.
//   3. Tear down on unmount.
//
// Imperative wiring is small but unavoidable because the viewer manages
// its own DOM; we don't try to fight that.

import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import * as pdfjsLib from "pdfjs-dist"
import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer as PdfjsViewer,
} from "pdfjs-dist/web/pdf_viewer.mjs"
import "pdfjs-dist/web/pdf_viewer.css"
import {
  ChevronUp,
  ChevronDown,
  Download,
  Loader2,
  Minus,
  Plus,
  Search,
  X,
} from "lucide-react"

import { fileContentUrl, getBreadcrumb } from "@/lib/kb"

// Worker is shipped from ui2/public/. The route-relative resolution
// fallback inside pdf.js' default workerSrc 404s into the SPA fallback,
// so we set an absolute path. Assigned at module import and re-asserted
// inside the component for bundler-tree-shaking safety.
const PDF_WORKER_URL = "/pdf.worker.mjs"
pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL

// pdf.js's getDocument options. withCredentials so the browser ships the
// same auth cookies as fetch().
type GetDocOpts = { url: string; withCredentials: boolean }

export type PdfViewerProps = {
  clId: string
  itemId: string
  /** 1-indexed page to scroll to on first load. */
  initialPage?: number | undefined
  /**
   * Bump this to re-jump to `initialPage` even when the value didn't
   * change — used by the citation panel so re-clicking the same chunk
   * pulls the user back to that page, and switching between chunks of
   * the same document updates the target without remounting the viewer.
   */
  navSeq?: number | undefined
  /** Filename pre-resolved by the caller; skips the breadcrumb round-trip. */
  docName?: string | undefined
  /** Leading slot in the toolbar (Back arrow on the route, nothing on panel). */
  leading?: React.ReactNode
  /** Extreme-right Close button — only when the host wants a dismiss affordance. */
  onClose?: () => void
  /** Hide the Download link. */
  hideDownload?: boolean
}

export function PdfViewer({
  clId,
  itemId,
  initialPage,
  navSeq,
  docName: docNameProp,
  leading,
  onClose,
  hideDownload = false,
}: PdfViewerProps): JSX.Element {
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL

  const containerRef = useRef<HTMLDivElement | null>(null)
  // pdf.js requires a separate inner div with class `pdfViewer` to hold
  // the page wrappers — the outer `containerRef` is the scroll element.
  const viewerInnerRef = useRef<HTMLDivElement | null>(null)
  // Holds the active viewer instance and the bag of things we need to
  // dispose with it (event bus, link service, find controller, the
  // current loading task, and the loaded document).
  const instanceRef = useRef<{
    viewer: PdfjsViewer
    eventBus: EventBus
    findController: PDFFindController
    loadingTask: { destroy: () => Promise<void> } | null
    pdfDoc: { destroy: () => Promise<void> } | null
  } | null>(null)
  // Last navSeq we honored for scroll-to-initialPage so re-renders don't
  // keep yanking the user back.
  const lastJumpRef = useRef<string | null>(null)

  const [numPages, setNumPages] = useState<number>(0)
  const [currentPage, setCurrentPage] = useState<number>(1)
  const [scalePct, setScalePct] = useState<number>(110)
  const [docName, setDocName] = useState<string>(docNameProp ?? "Document")
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  )
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pageInput, setPageInput] = useState<string>("1")
  const [pageInputFocused, setPageInputFocused] = useState<boolean>(false)
  useEffect((): void => {
    if (!pageInputFocused) setPageInput(String(currentPage))
  }, [currentPage, pageInputFocused])
  const [query, setQuery] = useState<string>("")

  const fileUrl = `${window.location.origin}${fileContentUrl(clId, itemId)}`

  // ── Breadcrumb-name fallback ────────────────────────────────────────
  useEffect((): (() => void) | undefined => {
    if (docNameProp) {
      setDocName(docNameProp)
      return undefined
    }
    let cancelled = false
    void getBreadcrumb(clId, itemId)
      .then((chain): void => {
        if (cancelled) return
        const last = chain[chain.length - 1]
        if (last?.name) setDocName(last.name)
      })
      .catch((): void => {
        /* keep fallback */
      })
    return (): void => {
      cancelled = true
    }
  }, [clId, itemId, docNameProp])

  // ── Viewer lifecycle ────────────────────────────────────────────────
  //
  // Construct once per (clId, itemId). The viewer owns its DOM subtree;
  // we just hand it the container + scroll element. Destroy on unmount
  // to release the worker-side document and any page render tasks.
  useEffect((): (() => void) | undefined => {
    const container = containerRef.current
    const viewerInner = viewerInnerRef.current
    if (!container || !viewerInner) return undefined

    setLoadState("loading")
    setLoadError(null)
    setNumPages(0)
    setCurrentPage(1)
    lastJumpRef.current = null

    const eventBus = new EventBus()
    const linkService = new PDFLinkService({ eventBus })
    const findController = new PDFFindController({ eventBus, linkService })
    const viewer = new PdfjsViewer({
      container,
      viewer: viewerInner,
      eventBus,
      linkService,
      findController,
      // Hidden text layer is required for search highlighting.
      textLayerMode: 2,
      // Disable annotation editing/forms — the citation viewer is read-only.
      annotationEditorMode: -1,
    })
    linkService.setViewer(viewer)

    eventBus.on("pagesinit", () => {
      // Default to a comfortable fit. Users can override via zoom controls.
      viewer.currentScaleValue = "page-width"
      setScalePct(Math.round((viewer.currentScale ?? 1) * 100))
    })
    eventBus.on("pagechanging", (evt: { pageNumber: number }) => {
      setCurrentPage(evt.pageNumber)
    })
    eventBus.on("scalechanging", (evt: { scale: number }) => {
      setScalePct(Math.round(evt.scale * 100))
    })

    const loadingTask = pdfjsLib.getDocument({
      url: fileUrl,
      withCredentials: true,
    } as GetDocOpts)

    let cancelled = false
    void loadingTask.promise
      .then((pdfDoc) => {
        if (cancelled) return
        viewer.setDocument(pdfDoc)
        linkService.setDocument(pdfDoc, null)
        setNumPages(pdfDoc.numPages)
        setLoadState("ready")
        instanceRef.current = {
          viewer,
          eventBus,
          findController,
          loadingTask: loadingTask as unknown as {
            destroy: () => Promise<void>
          },
          pdfDoc: pdfDoc as unknown as { destroy: () => Promise<void> },
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        setLoadError(msg)
        setLoadState("error")
      })

    return (): void => {
      cancelled = true
      const inst = instanceRef.current
      instanceRef.current = null
      // Best-effort cleanup — destroy() returns a promise but we don't
      // need to wait. Errors are ignored; the worker handles the rest.
      void inst?.loadingTask?.destroy().catch(() => undefined)
      void inst?.pdfDoc?.destroy().catch(() => undefined)
      try {
        viewer.cleanup()
      } catch {
        /* no-op */
      }
    }
  }, [fileUrl])

  // ── Initial / re-jump to a page ─────────────────────────────────────
  useEffect((): void => {
    if (loadState !== "ready" || !initialPage || numPages === 0) return
    const sig = `${String(initialPage)}#${String(navSeq ?? 0)}`
    if (lastJumpRef.current === sig) return
    if (initialPage > numPages) {
      lastJumpRef.current = sig
      return
    }
    const viewer = instanceRef.current?.viewer
    if (!viewer) return
    viewer.currentPageNumber = initialPage
    lastJumpRef.current = sig
  }, [loadState, initialPage, navSeq, numPages])

  // ── Trackpad pinch-to-zoom + Ctrl/Cmd-wheel zoom ────────────────────
  //
  // Browsers translate trackpad pinch gestures into `wheel` events with
  // `ctrlKey: true` (Chrome, Safari, Firefox on macOS, and Windows
  // touchpads). The same path works for Ctrl/Cmd + scroll wheel zoom on
  // a mouse. We swallow the default (page zoom / scroll) and apply the
  // delta to viewer.currentScale instead.
  //
  // Passive is `false` so preventDefault() actually fires — otherwise
  // Chrome treats the wheel handler as non-blocking and zooms the SPA
  // shell underneath.
  useEffect((): (() => void) | undefined => {
    const container = containerRef.current
    if (!container) return undefined
    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const viewer = instanceRef.current?.viewer
      if (!viewer) return
      // deltaY is positive when pinching closer (zoom-out gesture on
      // most trackpads). Negate so pinch-open zooms in. Scale step is
      // proportional to the gesture intensity but clamped so a fast
      // pinch doesn't fly past the bounds in a single frame.
      const current = viewer.currentScale ?? 1
      const step = Math.max(-0.5, Math.min(0.5, -e.deltaY * 0.01))
      const next = Math.max(0.25, Math.min(5, current + step))
      viewer.currentScaleValue = String(next)
    }
    container.addEventListener("wheel", onWheel, { passive: false })
    return (): void => {
      container.removeEventListener("wheel", onWheel)
    }
  }, [])

  // ── Find/search ─────────────────────────────────────────────────────
  //
  // pdf.js's findController consumes a `find` event with the query and
  // an `updatefindmatchescount`/`updatefindcontrolstate` event back.
  // Empty query triggers `findbarclose`-equivalent reset.
  useEffect((): void => {
    if (loadState !== "ready") return
    const eb = instanceRef.current?.eventBus
    if (!eb) return
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      eb.dispatch("find", { source: null, type: "", query: "", highlightAll: false, findPrevious: false, caseSensitive: false, entireWord: false })
      return
    }
    eb.dispatch("find", {
      source: null,
      type: "",
      query: trimmed,
      highlightAll: true,
      findPrevious: false,
      caseSensitive: false,
      entireWord: false,
    })
  }, [query, loadState])

  // ── Toolbar handlers ────────────────────────────────────────────────
  const goToPage = useCallback((n: number): void => {
    const viewer = instanceRef.current?.viewer
    if (!viewer) return
    viewer.currentPageNumber = Math.max(1, Math.min(viewer.pagesCount, n))
  }, [])

  const commitPageInput = useCallback((): void => {
    const n = Number(pageInput)
    if (Number.isInteger(n) && n >= 1 && numPages > 0 && n <= numPages) {
      goToPage(n)
    } else {
      setPageInput(String(currentPage))
    }
  }, [pageInput, numPages, goToPage, currentPage])

  const zoom = useCallback((delta: number): void => {
    const viewer = instanceRef.current?.viewer
    if (!viewer) return
    const next = Math.max(0.25, Math.min(5, (viewer.currentScale ?? 1) + delta))
    viewer.currentScaleValue = String(next)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-background/70 px-4 py-2 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2">
          {leading}
          <span
            className="truncate text-[13px] font-medium text-foreground"
            title={docName}
          >
            {docName}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {/* In-PDF search */}
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
              aria-hidden
              strokeWidth={1.75}
            />
            <input
              type="text"
              value={query}
              onChange={(e): void => {
                setQuery(e.target.value)
              }}
              placeholder="Find"
              aria-label="Find in document"
              className="h-7 w-[140px] rounded-md border border-border bg-background pl-6 pr-6 text-[12px] text-foreground placeholder:text-muted-foreground/70 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
            {query.length > 0 && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={(): void => {
                  setQuery("")
                }}
                className="absolute right-1 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X className="h-3 w-3" aria-hidden strokeWidth={1.75} />
              </button>
            )}
          </div>

          <span className="mx-1 h-4 w-px bg-border" aria-hidden />

          <button
            type="button"
            aria-label="Previous page"
            disabled={currentPage <= 1}
            onClick={(): void => {
              goToPage(currentPage - 1)
            }}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronUp className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <div className="flex items-center gap-1 text-[12px] tabular-nums text-muted-foreground">
            <input
              type="text"
              inputMode="numeric"
              value={pageInput}
              onChange={(e): void => {
                setPageInput(e.target.value.replace(/\D/g, ""))
              }}
              onFocus={(e): void => {
                setPageInputFocused(true)
                e.target.select()
              }}
              onBlur={(): void => {
                setPageInputFocused(false)
                commitPageInput()
              }}
              onKeyDown={(e): void => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  ;(e.currentTarget as HTMLInputElement).blur()
                } else if (e.key === "Escape") {
                  setPageInput(String(currentPage))
                  ;(e.currentTarget as HTMLInputElement).blur()
                }
              }}
              disabled={numPages === 0}
              aria-label="Go to page"
              className="h-7 w-10 rounded-md border border-border bg-background text-center text-[12px] tabular-nums text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-40"
            />
            <span aria-hidden>/</span>
            <span className="min-w-[20px] text-center">
              {numPages > 0 ? String(numPages) : "—"}
            </span>
          </div>
          <button
            type="button"
            aria-label="Next page"
            disabled={numPages > 0 && currentPage >= numPages}
            onClick={(): void => {
              goToPage(currentPage + 1)
            }}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>

          <span className="mx-2 h-4 w-px bg-border" aria-hidden />

          <button
            type="button"
            aria-label="Zoom out"
            onClick={(): void => {
              zoom(-0.1)
            }}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <Minus className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <span className="min-w-[44px] text-center text-[12px] tabular-nums text-muted-foreground">
            {`${String(scalePct)}%`}
          </span>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={(): void => {
              zoom(0.1)
            }}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>

          {!hideDownload && (
            <>
              <span className="mx-2 h-4 w-px bg-border" aria-hidden />
              <Link
                to={fileContentUrl(clId, itemId)}
                reloadDocument
                aria-label="Download"
                className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              >
                <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
              </Link>
            </>
          )}

          {onClose && (
            <>
              <span className="mx-2 h-4 w-px bg-border" aria-hidden />
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              >
                <X className="h-4 w-4" aria-hidden strokeWidth={1.75} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Scroll container — pdf.js requires absolute children, so we
          place the viewer div inside this scroll wrapper. The wrapper
          itself owns the scrollbar; the inner `.pdfViewer` div is what
          PDFViewer mutates. */}
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={containerRef}
          className="pdf-host absolute inset-0 overflow-auto bg-surface-muted/30"
        >
          <div ref={viewerInnerRef} className="pdfViewer" />
        </div>

        {loadState === "loading" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
            Loading document…
          </div>
        )}
        {loadState === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
            <p className="text-[14px] font-medium text-foreground">
              Could not display this file
            </p>
            <p className="text-[12.5px] text-muted-foreground">{loadError}</p>
          </div>
        )}
      </div>
    </div>
  )
}
