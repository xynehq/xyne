import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  memo,
} from "react"
import { Document, Page, pdfjs } from "react-pdf"
import "react-pdf/dist/Page/TextLayer.css"
import "react-pdf/dist/Page/AnnotationLayer.css"
import { useVirtualizer } from "@tanstack/react-virtual"
import { getPdfWorkerSrc, getPdfDocumentOptions } from "@/utils/pdfBunCompat"
import type { DocumentOperations } from "@/contexts/DocumentOperationsContext"
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api"

// Set up the worker and WASM directory with Bun compatibility
pdfjs.GlobalWorkerOptions.workerSrc = getPdfWorkerSrc()
;(globalThis as any).pdfjsWasmDir = `/pdfjs/wasm/`

const PageWrapper = memo(
  ({
    pageNumber,
    scale,
    loading,
    error,
    onRenderSuccess,
    onRenderTextLayerSuccess,
    onRenderAnnotationLayerSuccess,
  }: {
    pageNumber: number
    scale: number
    loading: React.ReactNode
    error: React.ReactNode
    onRenderSuccess?: () => void
    onRenderTextLayerSuccess?: () => void
    onRenderAnnotationLayerSuccess?: () => void
  }) => (
    <div className="relative">
      <Page
        pageNumber={pageNumber}
        scale={scale}
        renderTextLayer
        renderAnnotationLayer
        onRenderSuccess={onRenderSuccess}
        onRenderTextLayerSuccess={onRenderTextLayerSuccess}
        onRenderAnnotationLayerSuccess={onRenderAnnotationLayerSuccess}
        loading={loading}
        error={error}
        className="shadow-lg"
      />
    </div>
  ),
  (prev, next) =>
    prev.pageNumber === next.pageNumber && prev.scale === next.scale,
)

interface PdfViewerProps {
  /** Either a URL or File object */
  source: string | File | Blob | ArrayBuffer | Uint8Array
  /** Document ID for stable component key */
  docId?: string
  /** Additional CSS class names */
  className?: string
  /** Show loading spinner */
  showLoading?: boolean
  /** Custom styles for the container */
  style?: React.CSSProperties
  /** Initial page number (1-indexed) */
  initialPage?: number
  /** Scale of the PDF (default: 1.2) */
  scale?: number
  /** Display mode: 'paginated' or 'continuous' */
  displayMode?: "paginated" | "continuous"
  /** Show page navigation controls */
  showNavigation?: boolean
  /** Ref to expose document operations */
  documentOperationsRef?: React.RefObject<DocumentOperations>
}

export const PdfViewer: React.FC<PdfViewerProps> = ({
  source,
  docId,
  className = "",
  showLoading = true,
  style = {},
  initialPage = 1,
  scale: initialScale = 1.2,
  displayMode = "continuous",
  showNavigation = true,
  documentOperationsRef,
}) => {
  const [numPages, setNumPages] = useState<number | null>(null)
  const [pageNumber, setPageNumber] = useState<number>(initialPage)
  const [currentVisiblePage, setCurrentVisiblePage] =
    useState<number>(initialPage)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [scale, setScale] = useState<number>(initialScale)
  const [pageInput, setPageInput] = useState<string | null>(null)
  const [pageDimensions, setPageDimensions] = useState<{
    width: number
    height: number
  } | null>(null)
  const [retryCount, setRetryCount] = useState<number>(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // Height map: precomputed heights for all pages at current scale
  const [heightMap, setHeightMap] = useState<number[]>([])
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null)

  // Page readiness tracking for all layers using ref for real-time access
  const pageReadyRef = useRef<
    Record<number, { canvas?: boolean; text?: boolean; anno?: boolean }>
  >({})

  // Track component mount status to prevent operations on unmounted components
  const isMountedRef = useRef<boolean>(true)

  // Track active async operations to cancel them on unmount
  const activeOperationsRef = useRef<Set<() => void>>(new Set())

  // Helper functions for page readiness tracking
  const mark = (page: number, key: "canvas" | "text" | "anno") => {
    const current = pageReadyRef.current[page] ?? {}
    pageReadyRef.current[page] = { ...current, [key]: true }
  }

  const isFullyReady = (page: number) => {
    const state = pageReadyRef.current[page]
    const ready = !!state?.canvas && !!state?.text && !!state?.anno
    return ready
  }

  // Create a simple, readable key for the Document component
  const documentKey = useMemo(() => {
    let baseKey = ""

    if (docId) {
      baseKey = `doc-${docId}`
    } else if (!source) {
      baseKey = "no-source"
    } else if (typeof source === "string") {
      baseKey = `url-${source}`
    } else if (source instanceof File) {
      baseKey = `file-${source.name}-${source.size}`
    } else {
      const sourceAny = source as any

      if (sourceAny instanceof ArrayBuffer) {
        baseKey = `buffer-${sourceAny.byteLength}`
      } else if (sourceAny instanceof Uint8Array) {
        baseKey = `uint8-${sourceAny.length}`
      } else if (sourceAny instanceof Blob) {
        baseKey = `blob-${sourceAny.size}-${sourceAny.type}`
      } else {
        baseKey = `unknown-${Date.now()}`
      }
    }

    return `${baseKey}-retry-${retryCount}`
  }, [docId, source, retryCount])

  // Precompute height map from PDF metadata (two-pass layout)
  const computeHeightMap = useCallback(
    async (doc: PDFDocumentProxy, currentScale: number) => {
      if (!doc || !isMountedRef.current) return []

      const pages: number = doc.numPages ?? 0
      const heights: number[] = []

      // Process pages sequentially to avoid overwhelming the worker
      for (let idx = 0; idx < pages; idx++) {
        if (!isMountedRef.current) break

        try {
          const page = await doc.getPage(idx + 1)
          if (!isMountedRef.current) {
            // Clean up the page if component unmounted
            page.cleanup?.()
            break
          }
          const vp = page.getViewport({ scale: currentScale })
          heights[idx] = vp.height
          // Clean up the page after getting dimensions
          page.cleanup?.()
        } catch (error) {
          console.warn(`Failed to get page ${idx + 1} dimensions:`, error)
          // Only set fallback height if still mounted
          if (isMountedRef.current) {
            heights[idx] = Math.round(792 * currentScale)
          }
        }
      }

      return heights
    },
    [],
  )

  // Get precomputed height for virtualizer
  const getEstimatedHeight = useCallback(
    (index: number) => {
      return heightMap[index] ?? Math.round(792 * scale)
    },
    [heightMap, scale],
  )

  // Setup virtualizer for continuous mode
  const rowVirtualizer = useVirtualizer({
    count: numPages || 0,
    getScrollElement: () => containerRef.current,
    estimateSize: getEstimatedHeight,
    overscan: 6,
    enabled: displayMode === "continuous" && !!numPages,
  })

  // Compute current page using virtualizer state (no DOM queries)
  useEffect(() => {
    if (displayMode !== "continuous" || !containerRef.current) return
    const el = containerRef.current

    const onScroll = () => {
      const viewportCenter = el.scrollTop + el.clientHeight / 2
      const items = rowVirtualizer.getVirtualItems()
      if (!items.length) return

      let best = items[0]
      let bestDist = Infinity
      for (const it of items) {
        const center = it.start + it.size / 2
        const dist = Math.abs(center - viewportCenter)
        if (dist < bestDist) {
          bestDist = dist
          best = it
        }
      }
      const page = best.index + 1
      setCurrentVisiblePage((prev) => (prev === page ? prev : page))
    }

    el.addEventListener("scroll", onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener("scroll", onScroll)
  }, [displayMode, rowVirtualizer])

  // Calculate optimal scale based on page dimensions and container size - FIT TO WIDTH
  const calculateOptimalScale = useCallback(
    (pageWidth: number, pageHeight: number) => {
      if (!containerRef.current) return initialScale

      const container = containerRef.current
      const containerWidth = container.clientWidth - 32 // Account for padding

      // Calculate scale to fit width only (not height)
      const scaleToFitWidth = containerWidth / pageWidth

      // Apply some constraints
      const minScale = 0.5
      const maxScale = 2.0

      // For very large pages (like PPT slides), use a more conservative scale
      if (pageWidth > 1000 || pageHeight > 1000) {
        return Math.max(minScale, Math.min(scaleToFitWidth * 0.8, maxScale))
      }

      // For standard pages, use the calculated fit-to-width scale
      return Math.max(minScale, Math.min(scaleToFitWidth, maxScale))
    },
    [initialScale],
  )

  const onDocumentLoadSuccess = useCallback(
    async (pdfDoc: PDFDocumentProxy) => {
      if (!isMountedRef.current) return

      const { numPages } = pdfDoc
      setNumPages(numPages)
      setPdfDocument(pdfDoc)
      setError(null)

      // Get first page to calculate optimal scale BEFORE computing height map
      let finalScale = scale
      try {
        if (!isMountedRef.current) return

        const firstPage = await pdfDoc.getPage(1)
        if (!isMountedRef.current) {
          firstPage.cleanup?.()
          return
        }

        const vp = firstPage.getViewport({ scale: 1 })
        const width = vp.width
        const height = vp.height

        // Clean up the page after getting dimensions
        firstPage.cleanup?.()

        if (!isMountedRef.current) return

        // Set page dimensions for window resize calculations
        setPageDimensions({ width, height })

        const optimalScale = calculateOptimalScale(width, height)
        setScale(optimalScale)
        finalScale = optimalScale
      } catch (error) {
        console.warn("Failed to get first page for scale calculation:", error)
        // Don't return early on error - continue with default scale
      }

      if (!isMountedRef.current) return

      // Compute height map with the final scale
      try {
        const heights = await computeHeightMap(pdfDoc, finalScale)
        if (!isMountedRef.current) return
        setHeightMap(heights)
      } catch (error) {
        console.warn("Failed to compute height map:", error)
        // Continue with empty height map
      }

      if (!isMountedRef.current) return

      // Only set loading to false after height map is computed
      setLoading(false)
      const validInitialPage = Math.min(initialPage, numPages)
      setPageNumber(validInitialPage)
      setCurrentVisiblePage(validInitialPage)

      if (displayMode === "continuous" && validInitialPage > 1) {
        // Wait for height map to be set before scrolling
        setTimeout(() => {
          if (isMountedRef.current) {
            rowVirtualizer.scrollToIndex(validInitialPage - 1, {
              align: "start",
            })
          }
        }, 0)
      }
    },
    [
      computeHeightMap,
      scale,
      initialPage,
      displayMode,
      rowVirtualizer,
      calculateOptimalScale,
    ],
  )

  function onDocumentLoadError(error: Error) {
    if (!isMountedRef.current) return

    console.error("PDF load error:", error)
    const srcMeta =
      typeof source === "string"
        ? { urlPrefix: source.slice(0, 256) }
        : source instanceof File
          ? {
              file: { name: source.name, size: source.size, type: source.type },
            }
          : source instanceof Blob
            ? { blob: { size: source.size, type: source.type } }
            : source instanceof ArrayBuffer
              ? { arrayBuffer: { byteLength: source.byteLength } }
              : source instanceof Uint8Array
                ? { uint8Array: { length: source.length } }
                : { kind: source ? typeof source : "null" }

    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
      source: srcMeta,
    })

    // Handle specific errors
    if (
      error.message.includes("ArrayBuffer") ||
      error.message.includes("detached")
    ) {
      setError(
        "PDF data error: The document may be corrupted or in use by another process. Please try refreshing the page.",
      )
    } else if (
      error.message.includes("sendWithPromise") ||
      error.message.includes("Worker") ||
      error.message.includes("terminated")
    ) {
      setError(
        "PDF worker error: The PDF viewer encountered an internal error. Please try again.",
      )
    } else {
      setError(error.message)
    }

    setLoading(false)
  }

  // Handle window resize to recalculate optimal scale
  useEffect(() => {
    if (!pageDimensions) return

    const handleResize = () => {
      const optimalScale = calculateOptimalScale(
        pageDimensions.width,
        pageDimensions.height,
      )
      setScale(optimalScale)
    }

    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [pageDimensions, calculateOptimalScale])

  // Track if we're in the initial load cycle to prevent redundant computation
  const isInitialLoadRef = useRef(true)

  // Recompute height map when scale changes (synchronous)
  useEffect(() => {
    if (
      displayMode === "continuous" &&
      pdfDocument &&
      numPages &&
      isMountedRef.current
    ) {
      // Skip recomputation during initial load - it's already computed in onDocumentLoadSuccess
      if (isInitialLoadRef.current) {
        isInitialLoadRef.current = false
        return
      }

      const recomputeHeights = async () => {
        try {
          const newHeights = await computeHeightMap(pdfDocument, scale)
          if (isMountedRef.current) {
            setHeightMap(newHeights)
          }
        } catch (error) {
          console.warn("Failed to recompute height map:", error)
        }
      }
      recomputeHeights()
    }
  }, [scale, displayMode, pdfDocument, numPages, computeHeightMap])

  // Navigation handlers
  const goToPreviousPage = () => {
    if (displayMode === "paginated") {
      if (pageNumber > 1) {
        setPageNumber(pageNumber - 1)
      }
    } else {
      const prevPage = Math.max(1, currentVisiblePage - 1)
      goToPage(prevPage)
    }
  }

  const goToNextPage = () => {
    if (displayMode === "paginated") {
      if (numPages && pageNumber < numPages) {
        setPageNumber(pageNumber + 1)
      }
    } else {
      const nextPage = Math.min(numPages || 1, currentVisiblePage + 1)
      goToPage(nextPage)
    }
  }

  const goToPage = useCallback(
    (page: number) => {
      if (!numPages || page < 1 || page > numPages) return

      if (displayMode === "paginated") {
        setPageNumber(page)
      } else {
        // Use virtualizer's scrollToIndex for navigation (instant for dynamic sizing)
        const index = page - 1 // Convert to 0-indexed
        rowVirtualizer.scrollToIndex(index, { align: "start" })
        setCurrentVisiblePage(page)
      }
    },
    [numPages, displayMode, rowVirtualizer],
  )

  // Register the goToPage function with the DocumentOperations ref
  useEffect(() => {
    if (documentOperationsRef?.current) {
      documentOperationsRef.current.goToPage = async (pageIndex?: number) => {
        if (!isMountedRef.current || pageIndex === undefined || pageIndex < 0) {
          return
        }
        // Convert 0-based index to 1-based page number
        const pageNumber = pageIndex + 1
        if (currentVisiblePage !== pageNumber) {
          goToPage(pageNumber)
        }

        // Wait for the specific page to be ready
        let attempts = 0
        const maxAttempts = 100 // 5 seconds max wait
        while (
          isMountedRef.current &&
          !isFullyReady(pageNumber) &&
          attempts < maxAttempts
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          attempts++
        }
      }
    }

    // Cleanup function to remove the goToPage function when component unmounts
    return () => {
      if (documentOperationsRef?.current) {
        documentOperationsRef.current.goToPage = undefined
      }
    }
  }, [documentOperationsRef, goToPage])

  const commitPageInput = useCallback(() => {
    if (pageInput === null) return
    const num = parseInt(pageInput, 10)
    if (!Number.isNaN(num) && num >= 1) {
      const clamped = Math.min(num, numPages || 1)
      goToPage(clamped)
      setTimeout(() => {
        setPageInput(null)
      }, 0)
    } else {
      setPageInput(null)
    }
  }, [pageInput, numPages, goToPage])

  const currentPageForDisplay =
    displayMode === "continuous" ? currentVisiblePage : pageNumber

  // Create stable options object to prevent unnecessary reloads
  const documentOptions = useMemo(() => {
    const options = getPdfDocumentOptions({
      enableXfa: true,
    })
    return Object.freeze(options)
  }, [])

  // Validate and stabilize PDF source data
  const stableSource = useMemo(() => {
    if (!source) return null

    try {
      // If source is an ArrayBuffer, create a deep copy to prevent detachment issues
      if (source instanceof ArrayBuffer) {
        const copy = new ArrayBuffer(source.byteLength)
        new Uint8Array(copy).set(new Uint8Array(source))
        return copy
      }

      // If source is a Uint8Array, create a new ArrayBuffer copy
      if (source instanceof Uint8Array) {
        const copy = new ArrayBuffer(source.byteLength)
        new Uint8Array(copy).set(source)
        return copy
      }

      // If source is a Blob, pass through (react-pdf supports Blob inputs)
      if (source instanceof Blob) {
        return source
      }

      // For other types (URL, File, etc.), return as-is
      return source
    } catch (error) {
      console.error("Error stabilizing PDF source:", error)
      return source // Fallback to original source
    }
  }, [source])

  // Reset state when the document changes
  useEffect(() => {
    setNumPages(null)
    setPageNumber(initialPage)
    setCurrentVisiblePage(initialPage)
    setError(null)
    setLoading(true)
    setPageDimensions(null)
    setHeightMap([])
    setPdfDocument(null)
    pageReadyRef.current = {} // Reset page readiness tracking
    isInitialLoadRef.current = true // Reset initial load flag
  }, [documentKey, initialPage])

  // Component lifecycle management
  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false

      // Cancel any active operations
      activeOperationsRef.current.forEach((cancel) => {
        try {
          cancel()
        } catch (error) {
          console.warn("Error canceling operation:", error)
        }
      })
      activeOperationsRef.current.clear()

      // Clean up PDF document if it exists
      if (pdfDocument) {
        try {
          pdfDocument.destroy?.()
        } catch (error) {
          console.warn("Error destroying PDF document:", error)
        }
      }
    }
  }, [pdfDocument])

  return (
    <div
      className={`simple-pdf-viewer ${className}`}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        minHeight: "100%",
        backgroundColor: "#f5f5f5",
        ...style,
      }}
    >
      {/* Loading State */}
      {loading && showLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/90 dark:bg-gray-900/90 z-10">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
            <p className="text-gray-600 dark:text-gray-300">Loading PDF...</p>
          </div>
        </div>
      )}

      {/* Error State */}
      {error && !loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white dark:bg-gray-900 z-10">
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 max-w-md">
            <p className="text-red-800 dark:text-red-200 font-semibold">
              Error loading PDF
            </p>
            <p className="text-red-600 dark:text-red-300 text-sm mt-1">
              {error}
            </p>
            <button
              onClick={() => {
                setError(null)
                setLoading(true)
                setPageNumber(initialPage)
                setRetryCount((prev) => prev + 1)
              }}
              className="mt-2 px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Navigation Controls */}
      {!loading && !error && numPages && showNavigation && (
        <div className="sticky top-0 bg-white dark:bg-[#1E1E1E] shadow-md z-10 p-4 border-b border-gray-200 dark:border-gray-700 w-full">
          <div className="flex items-center justify-center">
            <div className="flex items-center bg-gray-100 dark:bg-gray-700 rounded-lg px-4 py-2 shadow-sm">
              {/* Previous Page Button */}
              <button
                onClick={goToPreviousPage}
                disabled={currentPageForDisplay <= 1}
                className="flex items-center gap-1 px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white disabled:text-gray-400 dark:disabled:text-gray-600 disabled:cursor-not-allowed transition-colors"
                title="Previous page"
              >
                <span className="text-lg">‹</span>
                <span>Previous</span>
              </button>

              <div className="w-px h-4 bg-gray-300 dark:bg-gray-600 mx-3"></div>

              {/* Page Display */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  Page
                </span>
                <input
                  type="number"
                  min="1"
                  max={numPages}
                  value={
                    pageInput !== null
                      ? pageInput
                      : String(currentPageForDisplay)
                  }
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === "" || /^[0-9]+$/.test(v)) {
                      const num = parseInt(v, 10)
                      if (v === "" || (num >= 1 && num <= (numPages || 1))) {
                        setPageInput(v)
                      }
                    }
                  }}
                  onFocus={(e) => {
                    e.currentTarget.select()
                    setPageInput(String(currentPageForDisplay))
                  }}
                  onClick={(e) => e.currentTarget.select()}
                  onBlur={commitPageInput}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      commitPageInput()
                    } else if (e.key === "Escape") {
                      e.preventDefault()
                      setPageInput(null)
                    }
                  }}
                  className="w-16 px-2 py-1 text-sm text-center bg-white dark:bg-gray-600 border border-gray-300 dark:border-gray-500 rounded text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  of {numPages}
                </span>
              </div>

              <div className="w-px h-4 bg-gray-300 dark:bg-gray-600 mx-3"></div>

              {/* Next Page Button */}
              <button
                onClick={goToNextPage}
                disabled={currentPageForDisplay >= numPages}
                className="flex items-center gap-1 px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white disabled:text-gray-400 dark:disabled:text-gray-600 disabled:cursor-not-allowed transition-colors"
                title="Next page"
              >
                <span>Next</span>
                <span className="text-lg">›</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PDF Content */}
      {!error && (
        <div
          ref={containerRef}
          className={`flex-1 ${displayMode === "continuous" ? "overflow-auto" : "flex justify-center items-start"} p-4`}
          style={{
            height: showNavigation ? "calc(100vh - 80px)" : "100vh",
          }}
        >
          <Document
            key={documentKey}
            file={stableSource as any}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            options={documentOptions}
            imageResourcesPath="/pdfjs/images/"
            loading={
              showLoading ? (
                <div className="flex items-center justify-center p-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                </div>
              ) : null
            }
            error={
              <div className="flex items-center justify-center p-8">
                <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                  <p className="text-red-800 dark:text-red-200 font-semibold">
                    Failed to load PDF
                  </p>
                  <p className="text-red-600 dark:text-red-300 text-sm mt-1">
                    Please check if the file is a valid PDF document.
                  </p>
                </div>
              </div>
            }
            className={
              displayMode === "continuous" ? "w-full" : "flex justify-center"
            }
          >
            {displayMode === "paginated" ? (
              // Paginated view - single page
              <PageWrapper
                key={`page_${pageNumber}`}
                pageNumber={pageNumber}
                scale={scale}
                onRenderSuccess={() => mark(pageNumber, "canvas")}
                onRenderTextLayerSuccess={() => {
                  // ensure it's actually painted:
                  requestAnimationFrame(() => mark(pageNumber, "text"))
                }}
                onRenderAnnotationLayerSuccess={() => {
                  requestAnimationFrame(() => mark(pageNumber, "anno"))
                }}
                loading={
                  <div className="flex items-center justify-center p-8">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                  </div>
                }
                error={
                  <div className="flex items-center justify-center p-8">
                    <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                      <p className="text-red-800 dark:text-red-200 font-semibold">
                        Failed to load page
                      </p>
                    </div>
                  </div>
                }
              />
            ) : (
              // Continuous view - virtualized rendering
              <div
                style={{
                  height: rowVirtualizer.getTotalSize(),
                  position: "relative",
                }}
                className="flex justify-center"
              >
                {rowVirtualizer.getVirtualItems().map((vi) => {
                  const pageNum = vi.index + 1
                  return (
                    <div
                      key={vi.key}
                      ref={rowVirtualizer.measureElement}
                      data-index={vi.index}
                      style={{
                        position: "absolute",
                        top: vi.start,
                        left: 0,
                        width: "100%",
                        padding: "8px 0",
                        boxSizing: "border-box",
                      }}
                    >
                      <div className="relative flex justify-center">
                        <div
                          style={{
                            height: getEstimatedHeight(vi.index),
                            position: "relative",
                            containIntrinsicSize: `auto ${getEstimatedHeight(vi.index)}px`,
                            contentVisibility: "auto",
                          }}
                        >
                          <PageWrapper
                            pageNumber={pageNum}
                            scale={scale}
                            onRenderSuccess={() => mark(pageNum, "canvas")}
                            onRenderTextLayerSuccess={() => {
                              // ensure it's actually painted:
                              requestAnimationFrame(() => mark(pageNum, "text"))
                            }}
                            onRenderAnnotationLayerSuccess={() => {
                              requestAnimationFrame(() => mark(pageNum, "anno"))
                            }}
                            loading={
                              <div className="flex items-center justify-center h-full">
                                <div className="text-center">
                                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto mb-2"></div>
                                  <p className="text-sm text-gray-500">
                                    Loading page {pageNum}...
                                  </p>
                                </div>
                              </div>
                            }
                            error={
                              <div className="flex items-center justify-center h-full">
                                <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                                  <p className="text-red-800 dark:text-red-200 font-semibold">
                                    Failed to load page {pageNum}
                                  </p>
                                </div>
                              </div>
                            }
                          />
                        </div>
                        <div className="absolute top-2 right-2 bg-black bg-opacity-60 text-white px-2 py-1 rounded text-sm z-10 pointer-events-none">
                          Page {pageNum}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </Document>
        </div>
      )}
    </div>
  )
}

export default PdfViewer
