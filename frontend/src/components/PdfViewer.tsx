import React, { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { Document, Page, pdfjs } from "react-pdf"
import "react-pdf/dist/Page/TextLayer.css"
import "react-pdf/dist/Page/AnnotationLayer.css"
import "pdfjs-dist/web/pdf_viewer.css"
import { getPdfWorkerSrc, getPdfDocumentOptions } from "@/utils/pdfBunCompat"
import { DocumentOperations } from "@/contexts/DocumentOperationsContext"

// Set up the worker and WASM directory with Bun compatibility
pdfjs.GlobalWorkerOptions.workerSrc = getPdfWorkerSrc()
;(globalThis as any).pdfjsWasmDir = `/pdfjs/wasm/`

interface PdfViewerProps {
  /** Either a URL or File object */
  source: string | File
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
  /** Enable zoom controls */
  enableZoom?: boolean
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
  enableZoom = true,
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
  const containerRef = useRef<HTMLDivElement>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)

  // Calculate optimal scale based on page dimensions and container size
  const calculateOptimalScale = useCallback(
    (pageWidth: number, pageHeight: number) => {
      if (!containerRef.current) return initialScale

      const container = containerRef.current
      const containerWidth = container.clientWidth - 32 // Account for padding
      const containerHeight = container.clientHeight - 32 // Account for padding

      // Calculate scale to fit width and height
      const scaleToFitWidth = containerWidth / pageWidth
      const scaleToFitHeight = containerHeight / pageHeight

      // Use the smaller scale to ensure the page fits completely
      const fitScale = Math.min(scaleToFitWidth, scaleToFitHeight)

      // Apply some constraints
      const minScale = 0.5
      const maxScale = 2.0

      // For very large pages (like PPT slides), use a more conservative scale
      if (pageWidth > 1000 || pageHeight > 1000) {
        return Math.max(minScale, Math.min(fitScale * 0.8, maxScale))
      }

      // For standard A4-like pages, use the calculated fit scale
      return Math.max(minScale, Math.min(fitScale, maxScale))
    },
    [initialScale],
  )

  function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
    setNumPages(numPages)
    setLoading(false)
    setError(null)
    const validInitialPage = Math.min(initialPage, numPages)
    setPageNumber(validInitialPage)
    setCurrentVisiblePage(validInitialPage)
  }

  // Handle page load success to get page dimensions
  const onPageLoadSuccess = useCallback(
    (page: { width: number; height: number; originalWidth?: number; originalHeight?: number }) => {
      if (page && !pageDimensions) {
        const { width, height } = page.originalWidth && page.originalHeight
          ? { width: page.originalWidth, height: page.originalHeight }
          : { width: page.width, height: page.height }

        setPageDimensions({ width, height })

        // Calculate and set optimal scale
        const optimalScale = calculateOptimalScale(width, height)
        setScale(optimalScale)
      }
    },
    [pageDimensions, calculateOptimalScale],
  )

  function onDocumentLoadError(error: Error) {
    console.error("PDF load error:", error)
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
      source: source,
      sourceType: source ? typeof source : "null",
      sourceConstructor: source ? source.constructor.name : "null",
    })

    // Handle specific ArrayBuffer errors
    if (
      error.message.includes("ArrayBuffer") ||
      error.message.includes("detached")
    ) {
      setError(
        "PDF data error: The document may be corrupted or in use by another process. Please try refreshing the page.",
      )
    } else {
      setError(error.message)
    }

    setLoading(false)
  }

  // Debounced page update to prevent flickering
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const currentVisiblePageRef = useRef(currentVisiblePage)

  // Keep ref in sync with state
  useEffect(() => {
    currentVisiblePageRef.current = currentVisiblePage
  }, [currentVisiblePage])

  const debouncedSetCurrentPage = useCallback((newPage: number) => {
    if (newPage === currentVisiblePageRef.current) return

    // Clear any pending update
    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current)
    }

    // Debounce the actual update
    updateTimeoutRef.current = setTimeout(() => {
      setCurrentVisiblePage(newPage)
    }, 100) // 100ms debounce
  }, []) // No dependencies to keep it stable

  // Setup IntersectionObserver for page tracking in continuous mode
  useEffect(() => {
    if (!numPages || displayMode !== "continuous" || !containerRef.current)
      return

    // Cleanup previous observer
    if (observerRef.current) {
      observerRef.current.disconnect()
    }

    const observer = new IntersectionObserver(
      (entries) => {
        // Find the page with the highest intersection ratio
        let mostVisiblePage = currentVisiblePage
        let maxRatio = 0

        entries.forEach((entry) => {
          const pageAttr = entry.target.getAttribute("data-page-num") || "0"
          const pageNum = parseInt(pageAttr)

          if (entry.isIntersecting && pageNum > 0) {
            // Use intersection ratio to determine the most visible page
            if (entry.intersectionRatio > maxRatio) {
              maxRatio = entry.intersectionRatio
              mostVisiblePage = pageNum
            }
          }
        })

        // Only update if we found a more visible page with significant visibility
        if (mostVisiblePage !== currentVisiblePage && maxRatio > 0.3) {
          debouncedSetCurrentPage(mostVisiblePage)
        }
      },
      {
        root: containerRef.current,
        rootMargin: "-20% 0px -20% 0px", // Only trigger when page is significantly visible
        threshold: [0, 0.1, 0.3, 0.5, 0.7, 1.0],
      },
    )

    observerRef.current = observer

    // Observe pages after they're rendered
    const observePages = () => {
      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const pageElement = document.querySelector(
          `[data-page-num="${pageNum}"]`,
        )
        if (pageElement) {
          observer.observe(pageElement)
        }
      }
    }

    // Small delay to ensure DOM is ready
    setTimeout(observePages, 100)

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect()
      }
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current)
      }
    }
  }, [numPages, displayMode])

  // Add scroll event listener for better page tracking (only as fallback)
  useEffect(() => {
    if (displayMode !== "continuous" || !containerRef.current) return

    let scrollTimeout: NodeJS.Timeout | null = null

    const handleScroll = () => {
      // Clear previous timeout
      if (scrollTimeout) {
        clearTimeout(scrollTimeout)
      }

      // Debounce scroll handling
      scrollTimeout = setTimeout(() => {
        if (!containerRef.current || !numPages) return

        const container = containerRef.current
        const containerRect = container.getBoundingClientRect()
        const containerCenter = containerRect.top + containerRect.height / 2

        let closestPage = 1
        let minDistance = Infinity

        // Find the page closest to the center of the viewport
        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
          const pageElement = document.querySelector(
            `[data-page-num="${pageNum}"]`,
          )
          if (pageElement) {
            const pageRect = pageElement.getBoundingClientRect()
            const pageCenter = pageRect.top + pageRect.height / 2
            const distance = Math.abs(pageCenter - containerCenter)

            if (distance < minDistance) {
              minDistance = distance
              closestPage = pageNum
            }
          }
        }

        // Only update if the closest page is different and significantly visible
        // Use a higher threshold to avoid conflicts with IntersectionObserver
        if (
          closestPage !== currentVisiblePage &&
          minDistance < containerRect.height / 3
        ) {
          debouncedSetCurrentPage(closestPage)
        }
      }, 150) // Longer debounce for scroll events
    }

    const container = containerRef.current
    container.addEventListener("scroll", handleScroll, { passive: true })

    return () => {
      container.removeEventListener("scroll", handleScroll)
      if (scrollTimeout) {
        clearTimeout(scrollTimeout)
      }
    }
  }, [displayMode, numPages])

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

  const goToPage = useCallback((page: number) => {
    if (!numPages || page < 1 || page > numPages) return

    if (displayMode === "paginated") {
      setPageNumber(page)
    } else {
      // Clear any pending updates to prevent conflicts
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current)
        updateTimeoutRef.current = null
      }

      // Scroll to page in continuous mode
      const pageElement = document.querySelector(`[data-page-num="${page}"]`)
      if (pageElement && containerRef.current) {
        // Temporarily disable intersection observer to prevent conflicts
        if (observerRef.current) {
          observerRef.current.disconnect()
        }

        pageElement.scrollIntoView({ behavior: "smooth", block: "start" })
        setCurrentVisiblePage(page)

        // Re-enable intersection observer after a delay
        setTimeout(() => {
          if (observerRef.current && containerRef.current) {
            // Re-observe all pages
            for (let pageNum = 1; pageNum <= numPages; pageNum++) {
              const element = document.querySelector(
                `[data-page-num="${pageNum}"]`,
              )
              if (element) {
                observerRef.current.observe(element)
              }
            }
          }
        }, 500)
      }
    }
  }, [numPages, displayMode])

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

  // Zoom controls
  const zoomIn = () => {
    setScale((prev) => Math.min(prev * 1.2, 3.0))
  }

  const zoomOut = () => {
    setScale((prev) => Math.max(prev / 1.2, 0.5))
  }

  const resetZoom = () => {
    setScale(initialScale)
  }

  const fitToWidth = () => {
    if (pageDimensions && containerRef.current) {
      const container = containerRef.current
      const containerWidth = container.clientWidth - 32 // Account for padding
      const fitScale = containerWidth / pageDimensions.width
      setScale(Math.max(0.5, Math.min(fitScale, 2.0)))
    }
  }

  const fitToPage = () => {
    if (pageDimensions && containerRef.current) {
      const container = containerRef.current
      const containerWidth = container.clientWidth - 32
      const containerHeight = container.clientHeight - 32

      const scaleToFitWidth = containerWidth / pageDimensions.width
      const scaleToFitHeight = containerHeight / pageDimensions.height
      const fitScale = Math.min(scaleToFitWidth, scaleToFitHeight)

      setScale(Math.max(0.5, Math.min(fitScale, 2.0)))
    }
  }

  // Render all pages for highlighting (for documentOperationsRef)
  const renderAllPagesForHighlighting = useCallback(async () => {
    if (!numPages || displayMode !== "continuous") return

    // In continuous mode, all pages are already rendered lazily
    // This function is mainly for compatibility with the existing interface
    console.log("All pages rendered for highlighting")
  }, [numPages, displayMode])

  useEffect(() => {
    if (documentOperationsRef?.current) {
      documentOperationsRef.current.renderAllPagesForHighlighting =
        renderAllPagesForHighlighting
    }
  }, [documentOperationsRef, renderAllPagesForHighlighting])

  const currentPageForDisplay =
    displayMode === "continuous" ? currentVisiblePage : pageNumber

  // Create stable options object to prevent unnecessary reloads
  const documentOptions = useMemo(() => {
    const options = getPdfDocumentOptions({
      enableXfa: true,
    })

    // Freeze the object to prevent any modifications
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

      // If source is a Blob, convert to ArrayBuffer
      if (source instanceof Blob) {
        // Return the blob as-is, PDF.js can handle it
        return source
      }

      // For other types (URL, File, etc.), return as-is
      return source
    } catch (error) {
      console.error("Error stabilizing PDF source:", error)
      return source // Fallback to original source
    }
  }, [source])

  // Create a simple, readable key for the Document component
  const documentKey = useMemo(() => {
    // If docId is provided, use it as the primary key (most stable)
    if (docId) {
      return `doc-${docId}`
    }
    
    if (!source) return "no-source"
    
    if (typeof source === "string") {
      // For URLs, use the URL as the key
      return `url-${source}`
    }
    
    if (source instanceof File) {
      // For files, use name and size
      return `file-${source.name}-${source.size}`
    }
    
    // Use type assertion to avoid TypeScript narrowing issues
    const sourceAny = source as any
    
    if (sourceAny instanceof ArrayBuffer) {
      // For ArrayBuffers, use size
      return `buffer-${sourceAny.byteLength}`
    }
    
    if (sourceAny instanceof Uint8Array) {
      // For Uint8Arrays, use length
      return `uint8-${sourceAny.length}`
    }
    
    if (sourceAny instanceof Blob) {
      // For Blobs, use size and type
      return `blob-${sourceAny.size}-${sourceAny.type}`
    }
    
    // Fallback for any other type
    return `unknown-${Date.now()}`
  }, [docId, source])

  return (
    <div
      className={`simple-pdf-viewer ${className}`}
      style={{
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
        <div className="sticky top-0 bg-white dark:bg-gray-800 shadow-md z-20 p-4 border-b border-gray-200 dark:border-gray-700 w-full">
          <div className="flex items-center justify-between">
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
                  className="w-16 px-2 py-1 text-sm text-center bg-white dark:bg-gray-600 border border-gray-300 dark:border-gray-500 rounded text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
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

            {/* Zoom Controls */}
            {enableZoom && (
              <div className="flex items-center bg-gray-100 dark:bg-gray-700 rounded-lg px-4 py-2 shadow-sm">
                <button
                  onClick={zoomOut}
                  className="flex items-center gap-1 px-2 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                  title="Zoom out"
                >
                  <span className="text-lg">−</span>
                </button>

                <div className="w-px h-4 bg-gray-300 dark:bg-gray-600 mx-2"></div>

                <button
                  onClick={resetZoom}
                  className="px-2 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                  title="Reset zoom"
                >
                  {Math.round(scale * 100)}%
                </button>

                <div className="w-px h-4 bg-gray-300 dark:bg-gray-600 mx-2"></div>

                <button
                  onClick={zoomIn}
                  className="flex items-center gap-1 px-2 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                  title="Zoom in"
                >
                  <span className="text-lg">+</span>
                </button>

                <div className="w-px h-4 bg-gray-300 dark:bg-gray-600 mx-2"></div>

                <button
                  onClick={fitToWidth}
                  className="px-2 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                  title="Fit to width"
                >
                  Fit Width
                </button>

                <button
                  onClick={fitToPage}
                  className="px-2 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                  title="Fit to page"
                >
                  Fit Page
                </button>
              </div>
            )}
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
            file={stableSource}
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
              displayMode === "continuous"
                ? "flex flex-col items-center gap-4"
                : "flex justify-center"
            }
          >
            {displayMode === "paginated" ? (
              // Paginated view - single page
              <Page
                key={`page_${pageNumber}`}
                pageNumber={pageNumber}
                scale={scale}
                renderTextLayer
                renderAnnotationLayer
                onLoadSuccess={onPageLoadSuccess}
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
                className="shadow-lg"
              />
            ) : (
              // Continuous view - all pages
              Array.from({ length: numPages || 0 }, (_, index) => {
                const pageNum = index + 1
                return (
                  <div
                    key={`page_${pageNum}`}
                    data-page-num={pageNum}
                    className="relative"
                  >
                    <div className="absolute top-2 right-2 bg-black bg-opacity-60 text-white px-2 py-1 rounded text-sm z-10">
                      Page {pageNum}
                    </div>
                    <Page
                      pageNumber={pageNum}
                      scale={scale}
                      renderTextLayer
                      renderAnnotationLayer
                      onLoadSuccess={
                        pageNum === 1 ? onPageLoadSuccess : undefined
                      }
                      loading={
                        <div className="flex items-center justify-center p-8 min-h-[600px]">
                          <div className="text-center">
                            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto mb-2"></div>
                            <p className="text-sm text-gray-500">
                              Loading page {pageNum}...
                            </p>
                          </div>
                        </div>
                      }
                      error={
                        <div className="flex items-center justify-center p-8 min-h-[600px]">
                          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                            <p className="text-red-800 dark:text-red-200 font-semibold">
                              Failed to load page {pageNum}
                            </p>
                          </div>
                        </div>
                      }
                      className="shadow-lg"
                    />
                  </div>
                )
              })
            )}
          </Document>
        </div>
      )}
    </div>
  )
}

export default PdfViewer
