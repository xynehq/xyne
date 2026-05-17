// PDF viewer route. URL: /kb/file/:itemId?cl=:clId
//
// Trailing underscore on the parent segment ("kb_") opts out of nesting under
// kb.tsx so this renders as its own page within the _authenticated layout
// (sidebar still visible). Mirrors v1's basic PDF viewer in shape (react-pdf
// Document/Page) but pared down: paginated single-page mode + zoom + nav.

import { useEffect, useMemo, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Document, Page, pdfjs } from "react-pdf"
import "react-pdf/dist/Page/AnnotationLayer.css"
import "react-pdf/dist/Page/TextLayer.css"
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Minus,
  Plus,
} from "lucide-react"

import { fileContentUrl } from "@/lib/kb"
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url"

// Configure the worker once. Vite turns the `?url` import into a hashed
// public asset URL so the worker loads at runtime without manual copying.
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

function PdfViewerRoute(): JSX.Element {
  const { itemId } = Route.useParams()
  const { cl } = Route.useSearch()
  const navigate = useNavigate()
  const [numPages, setNumPages] = useState<number>(0)
  const [pageNum, setPageNum] = useState<number>(1)
  const [scale, setScale] = useState<number>(1.1)
  const [loadError, setLoadError] = useState<string | null>(null)

  const fileUrl = useMemo(
    () => (cl ? fileContentUrl(cl, itemId) : null),
    [cl, itemId],
  )

  // react-pdf options must be stable to avoid reloading on every render.
  const docOptions = useMemo(
    () => ({
      // Bake cookies (the JWT) into the worker fetch so the content endpoint
      // accepts the request. Same-origin via the Vite proxy in dev / nginx
      // in prod — withCredentials triggers credentialed fetches.
      withCredentials: true,
    }),
    [],
  )

  useEffect((): void => {
    setPageNum(1)
    setNumPages(0)
    setLoadError(null)
  }, [fileUrl])

  if (!cl || !fileUrl) {
    return (
      <ErrorPane
        title="Missing collection"
        body="This viewer link is missing the cl (collection) parameter."
      />
    )
  }

  const goBack = (): void => {
    void navigate({
      to: "/kb",
      search: { cl },
    })
  }

  const downloadHref = fileUrl

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-background/70 px-4 py-2 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            aria-label="Back to knowledge"
            onClick={goBack}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
          </button>
          <span className="truncate text-[13px] font-medium text-foreground">
            Document
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Previous page"
            disabled={pageNum <= 1}
            onClick={(): void => {
              setPageNum((p) => Math.max(1, p - 1))
            }}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <span className="min-w-[64px] text-center text-[12px] tabular-nums text-muted-foreground">
            {numPages > 0 ? `${String(pageNum)} / ${String(numPages)}` : "—"}
          </span>
          <button
            type="button"
            aria-label="Next page"
            disabled={numPages > 0 && pageNum >= numPages}
            onClick={(): void => {
              setPageNum((p) => (numPages > 0 ? Math.min(numPages, p + 1) : p))
            }}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} />
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
            to={downloadHref}
            reloadDocument
            aria-label="Download"
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Link>
        </div>
      </div>

      <main className="flex-1 overflow-auto bg-surface-muted/30 p-6">
        <div className="mx-auto flex w-fit flex-col items-center">
          {loadError ? (
            <ErrorPane
              title="Could not display this file"
              body={loadError}
            />
          ) : (
            <Document
              file={fileUrl}
              options={docOptions}
              onLoadSuccess={({ numPages: n }): void => {
                setNumPages(n)
              }}
              onLoadError={(err): void => {
                setLoadError(err.message)
              }}
              loading={
                <div className="flex items-center gap-2 py-16 text-[13px] text-muted-foreground">
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
              <Page
                pageNumber={pageNum}
                scale={scale}
                className="overflow-hidden rounded-md bg-white shadow-md ring-1 ring-border"
              />
            </Document>
          )}
        </div>
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
