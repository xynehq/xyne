import React, { useEffect, useRef, useState, useMemo, useCallback } from "react"
import * as pdfjsLib from "pdfjs-dist"
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist"
import "pdfjs-dist/web/pdf_viewer.css"
import { authFetch } from "@/utils/authFetch"
import { useTheme } from "@/components/ThemeContext"

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js"

interface PdfViewerProps {
  /** Either a URL or File object */
  source: string | File
  /** Additional CSS class names */
  className?: string
  /** Show loading spinner */
  showLoading?: boolean
  /** Custom styles for the container */
  style?: React.CSSProperties
  /** Initial page number (1-indexed) */
  initialPage?: number
  /** Scale of the PDF (default: 1.5) */
  scale?: number
  /** Display mode: 'paginated' or 'continuous' */
  displayMode?: "paginated" | "continuous"
  /** Show page navigation controls (only applies to paginated mode) */
  showNavigation?: boolean
}

export const PdfViewer: React.FC<PdfViewerProps> = ({
  source,
  className = "",
  showLoading = true,
  style = {},
  initialPage = 1,
  scale = 1.5,
  displayMode = "continuous",
  showNavigation = false,
}) => {
  const { theme } = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const pagesContainerRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [currentPage, setCurrentPage] = useState<number>(initialPage)
  const [totalPages, setTotalPages] = useState<number>(0)
  const [pageRendering, setPageRendering] = useState<boolean>(false)
  const [renderedPages, setRenderedPages] = useState<Set<number>>(new Set())
  const [currentVisiblePage, setCurrentVisiblePage] = useState<number>(1)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const [allPagesRendered, setAllPagesRendered] = useState<boolean>(false)

  // Use a stable key for the source to avoid unnecessary re-renders
  const sourceKey = useMemo(() => {
    if (source instanceof File) {
      return `file-${source.name}-${source.size}-${source.lastModified}`
    }
    return source
  }, [source])

  // Load the PDF document
  useEffect(() => {
    let mounted = true
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null

    const loadDocument = async () => {
      try {
        setLoading(true)
        setError(null)
        setPdf(null)
        setTotalPages(0)
        setRenderedPages(new Set())
        setAllPagesRendered(false)

        if (!source) {
          throw new Error("No document source provided")
        }

        let data: ArrayBuffer
        if (source instanceof File) {
          if (source.size === 0) {
            throw new Error("File is empty")
          }
          data = await source.arrayBuffer()
        } else {
          // For URL sources, fetch and convert to ArrayBuffer
          const res = await authFetch(source, {
            headers: {
              Accept: "application/pdf, application/octet-stream",
            },
          })

          if (!res.ok) {
            if (res.status === 401) {
              throw new Error(
                "Authentication required. Please log in to view this document.",
              )
            } else if (res.status === 403) {
              throw new Error(
                "You don't have permission to view this document.",
              )
            } else if (res.status === 404) {
              throw new Error("Document not found.")
            } else {
              throw new Error(
                `Failed to fetch document: ${res.status} ${res.statusText}`,
              )
            }
          }

          data = await res.arrayBuffer()
        }

        if (data.byteLength === 0) {
          throw new Error("Document data is empty")
        }

        // Check if it's a valid PDF by checking the header
        const view = new Uint8Array(data.slice(0, 4))
        const header = String.fromCharCode(...view)
        if (!header.startsWith("%PDF")) {
          throw new Error("Invalid PDF format")
        }

        loadingTask = pdfjsLib.getDocument({
          data: data,
          cMapUrl: `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/cmaps/`,
          cMapPacked: true,
        })

        const pdfDoc = await loadingTask.promise

        if (!mounted) return

        setPdf(pdfDoc)
        setTotalPages(pdfDoc.numPages)
        setCurrentPage(Math.min(initialPage, pdfDoc.numPages))
      } catch (e) {
        if (!mounted) return

        const errorMessage =
          e instanceof Error ? e.message : "Failed to load PDF"
        setError(errorMessage)
      } finally {
        if (mounted) {
          setLoading(false)
        }
      }
    }

    loadDocument()

    return () => {
      mounted = false
      if (loadingTask) {
        loadingTask.destroy()
      }
    }
  }, [sourceKey, initialPage])

  // Render text layer for a page
  const renderTextLayer = async (
    page: PDFPageProxy,
    container: HTMLDivElement,
    viewport: any,
  ) => {
    // Clear existing text layer
    container.innerHTML = ""

    try {
      // Get text content
      const textContent = await page.getTextContent()

      // Create text layer elements manually
      const textLayerFrag = document.createDocumentFragment()

      textContent.items.forEach((item: any) => {
        if ("str" in item && item.str) {
          const span = document.createElement("span")
          span.textContent = item.str
          span.style.position = "absolute"
          span.style.color = "transparent"
          span.style.whiteSpace = "pre"
          span.style.cursor = "text"
          span.style.transformOrigin = "0% 0%"

          // Calculate position and size
          const tx = pdfjsLib.Util.transform(viewport.transform, item.transform)
          const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1])
          const fontAscent = fontSize

          span.style.left = `${tx[4]}px`
          span.style.top = `${tx[5] - fontAscent}px`
          span.style.fontSize = `${fontSize}px`
          span.style.fontFamily = item.fontName || "sans-serif"

          // Apply rotation if needed
          if (tx[1] !== 0) {
            const angle = Math.atan2(tx[1], tx[0]) * (180 / Math.PI)
            span.style.transform = `rotate(${angle}deg)`
          }

          textLayerFrag.appendChild(span)
        }
      })

      container.appendChild(textLayerFrag)

      // Ensure the text layer is properly styled
      container.style.opacity = "1"
      container.style.lineHeight = "1.0"

      // Add end of content marker
      const endOfContent = document.createElement("div")
      endOfContent.className = "endOfContent"
      container.appendChild(endOfContent)
    } catch (error) {
      console.error("Error rendering text layer:", error)
    }
  }

  // Render a specific page for paginated mode
  const renderPage = async (pageNum: number) => {
    if (!pdf || !canvasRef.current || pageRendering) return

    setPageRendering(true)

    try {
      const page: PDFPageProxy = await pdf.getPage(pageNum)
      const viewport = page.getViewport({ scale })

      const canvas = canvasRef.current
      const context = canvas.getContext("2d")
      if (!context) {
        throw new Error("Failed to get canvas context")
      }

      // Set canvas dimensions
      canvas.height = viewport.height
      canvas.width = viewport.width

      // Render PDF page into canvas context
      const renderContext = {
        canvasContext: context,
        viewport: viewport,
        canvas: canvas,
      }

      await page.render(renderContext).promise

      // Render text layer
      if (textLayerRef.current) {
        await renderTextLayer(page, textLayerRef.current, viewport)
      }
    } catch (e) {
      const errorMessage =
        e instanceof Error ? e.message : "Failed to render page"
      setError(errorMessage)
    } finally {
      setPageRendering(false)
    }
  }

  // Render a specific page for continuous mode
  const renderPageToContinuousCanvas = async (pageNum: number) => {
    if (!pdf || renderedPages.has(pageNum)) return

    try {
      const page: PDFPageProxy = await pdf.getPage(pageNum)
      const viewport = page.getViewport({ scale })

      // Find the canvas for this page
      const canvas = document.getElementById(
        `pdf-page-${pageNum}`,
      ) as HTMLCanvasElement
      if (!canvas) return

      const context = canvas.getContext("2d")
      if (!context) return

      // Set canvas dimensions
      canvas.height = viewport.height
      canvas.width = viewport.width

      // Render PDF page into canvas context
      const renderContext = {
        canvasContext: context,
        viewport: viewport,
        canvas: canvas,
      }

      await page.render(renderContext).promise

      // Render text layer
      const textLayerDiv = document.getElementById(
        `pdf-text-layer-${pageNum}`,
      ) as HTMLDivElement
      if (textLayerDiv) {
        await renderTextLayer(page, textLayerDiv, viewport)
      }

      setRenderedPages((prev) => new Set([...prev, pageNum]))
    } catch (e) {
      console.error(`Failed to render page ${pageNum}:`, e)
    }
  }

  // Render all pages for highlighting purposes
  const renderAllPagesForHighlighting = useCallback(async () => {
    if (!pdf || allPagesRendered || displayMode !== "continuous") return
    
    try {
      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        if (!renderedPages.has(pageNum)) {
          await renderPageToContinuousCanvas(pageNum)
        }
      }
      
      setAllPagesRendered(true)
    } catch (e) {
      console.error('Failed to render all pages for highlighting:', e)
    }
  }, [pdf, allPagesRendered, displayMode, totalPages, renderedPages])

  // Setup IntersectionObserver for lazy loading in continuous mode
  useEffect(() => {
    if (!pdf || displayMode !== "continuous") return

    // Cleanup previous observer
    if (observerRef.current) {
      observerRef.current.disconnect()
    }

    // Create new observer
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const pageNum = parseInt(
              entry.target.getAttribute("data-page-num") || "0",
            )
            if (pageNum > 0 && !renderedPages.has(pageNum)) {
              renderPageToContinuousCanvas(pageNum)
            }
          }
        })
      },
      {
        root: pagesContainerRef.current,
        rootMargin: "100px",
        threshold: 0.01,
      },
    )

    observerRef.current = observer

    // Observe all page wrappers
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const pageWrapper = document.getElementById(`pdf-page-wrapper-${pageNum}`)
      if (pageWrapper) {
        observer.observe(pageWrapper)
      }
    }

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect()
      }
    }
  }, [pdf, displayMode, totalPages, renderedPages])

  // Effect for paginated mode
  useEffect(() => {
    if (
      pdf &&
      displayMode === "paginated" &&
      currentPage > 0 &&
      currentPage <= totalPages
    ) {
      renderPage(currentPage)
    }
  }, [pdf, currentPage, scale, displayMode])

  // Scroll handler for continuous mode to track current visible page
  const handleScroll = useCallback(() => {
    if (displayMode !== "continuous" || !pagesContainerRef.current) return

    const container = pagesContainerRef.current

    // Find which page is most visible
    let maxVisibleArea = 0
    let mostVisiblePage = 1

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const pageElement = document.getElementById(`pdf-page-wrapper-${pageNum}`)
      if (!pageElement) continue

      const rect = pageElement.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()

      const visibleTop = Math.max(rect.top, containerRect.top)
      const visibleBottom = Math.min(rect.bottom, containerRect.bottom)
      const visibleHeight = Math.max(0, visibleBottom - visibleTop)

      if (visibleHeight > maxVisibleArea) {
        maxVisibleArea = visibleHeight
        mostVisiblePage = pageNum
      }
    }

    setCurrentVisiblePage(mostVisiblePage)
  }, [displayMode, totalPages])

  // Add scroll listener for continuous mode
  useEffect(() => {
    if (displayMode === "continuous" && pagesContainerRef.current) {
      const container = pagesContainerRef.current
      container.addEventListener("scroll", handleScroll)
      return () => container.removeEventListener("scroll", handleScroll)
    }
  }, [displayMode, handleScroll])

  // Navigation handlers for paginated mode
  const goToPreviousPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1)
    }
  }

  const goToNextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage(currentPage + 1)
    }
  }

  const goToPage = (pageNum: number) => {
    if (pageNum >= 1 && pageNum <= totalPages) {
      if (displayMode === "paginated") {
        setCurrentPage(pageNum)
      } else {
        // Scroll to page in continuous mode
        const pageElement = document.getElementById(
          `pdf-page-wrapper-${pageNum}`,
        )
        if (pageElement && pagesContainerRef.current) {
          pageElement.scrollIntoView({ behavior: "smooth", block: "start" })
        }
      }
    }
  }

  // Expose the renderAllPagesForHighlighting function globally for highlighting system
  useEffect(() => {
    if (displayMode === "continuous") {
      (window as any).__renderAllPdfPages = renderAllPagesForHighlighting;
      
      return () => {
        delete (window as any).__renderAllPdfPages;
      };
    }
  }, [displayMode, renderAllPagesForHighlighting]);

  return (
    <div
      className={`enhanced-pdf-viewer ${className}`}
      style={{
        backgroundColor: theme === "dark" ? "#1E1E1E" : "#f5f5f5",
        minHeight: "100%",
        position: "relative",
        ...style,
      }}
    >
      {loading && showLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/90 dark:bg-[#1E1E1E]/90 z-10">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-600 dark:border-gray-300 mx-auto mb-4"></div>
            <p className="text-gray-600 dark:text-gray-300">Loading PDF...</p>
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white dark:bg-[#1E1E1E] z-10">
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
                // Re-trigger the effect by changing a dependency
                setCurrentPage(initialPage)
              }}
              className="mt-2 px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {!loading && !error && pdf && (
        <>
          {/* Navigation bar */}
          {showNavigation && totalPages > 1 && (
            <div className="sticky top-0 bg-white dark:bg-[#1E1E1E] shadow-md z-20 p-4 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-center gap-4">
                {displayMode === "paginated" && (
                  <>
                    <button
                      onClick={goToPreviousPage}
                      disabled={currentPage <= 1}
                      className="px-4 py-2 bg-gray-600 dark:bg-gray-700 text-white rounded hover:bg-gray-700 dark:hover:bg-gray-600 disabled:bg-gray-300 dark:disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors"
                    >
                      Previous
                    </button>
                  </>
                )}

                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-600 dark:text-gray-300">
                    Page
                  </span>
                  <input
                    type="number"
                    min="1"
                    max={totalPages}
                    value={
                      displayMode === "continuous"
                        ? currentVisiblePage
                        : currentPage
                    }
                    onChange={(e) => goToPage(parseInt(e.target.value) || 1)}
                    className="w-16 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-center bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200"
                  />
                  <span className="text-sm text-gray-600 dark:text-gray-300">
                    of {totalPages}
                  </span>
                </div>

                {displayMode === "paginated" && (
                  <button
                    onClick={goToNextPage}
                    disabled={currentPage >= totalPages}
                    className="px-4 py-2 bg-gray-600 dark:bg-gray-700 text-white rounded hover:bg-gray-700 dark:hover:bg-gray-600 disabled:bg-gray-300 dark:disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors"
                  >
                    Next
                  </button>
                )}
              </div>
            </div>
          )}

          {/* PDF Content */}
          {displayMode === "paginated" ? (
            // Paginated view
            <div
              ref={containerRef}
              className="pdf-container flex justify-center items-start p-4"
              style={{
                minHeight: showNavigation ? "calc(100vh - 80px)" : "100vh",
              }}
            >
              <div className="pdf-page-container bg-white dark:bg-[#2d2d2d] shadow-lg relative">
                <canvas
                  ref={canvasRef}
                  className="pdf-canvas"
                  style={{ display: "block" }}
                />
                <div
                  ref={textLayerRef}
                  className="textLayer"
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                    overflow: "hidden",
                    lineHeight: 1,
                  }}
                />
                {pageRendering && (
                  <div className="absolute inset-0 flex items-center justify-center bg-white dark:bg-[#2d2d2d] bg-opacity-75">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-600 dark:border-gray-300"></div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            // Continuous view
            <div
              ref={pagesContainerRef}
              className="pdf-continuous-container overflow-auto"
              style={{
                height: showNavigation ? "calc(100vh - 80px)" : "100vh",
                padding: "20px",
              }}
            >
              <div className="flex flex-col items-center gap-4">
                {Array.from({ length: totalPages }, (_, index) => {
                  const pageNum = index + 1
                  return (
                    <div
                      key={pageNum}
                      id={`pdf-page-wrapper-${pageNum}`}
                      data-page-num={pageNum}
                      className="pdf-page-container bg-white dark:bg-[#2d2d2d] shadow-lg relative"
                    >
                      <canvas
                        id={`pdf-page-${pageNum}`}
                        className="pdf-canvas block"
                      />
                      <div
                        id={`pdf-text-layer-${pageNum}`}
                        className="textLayer"
                        style={{
                          position: "absolute",
                          left: 0,
                          top: 0,
                          right: 0,
                          bottom: 0,
                          overflow: "hidden",
                          lineHeight: 1,
                        }}
                      />
                      <div className="absolute top-2 right-2 bg-black dark:bg-[#404040] bg-opacity-60 dark:bg-opacity-80 text-white dark:text-gray-200 px-2 py-1 rounded text-sm">
                        Page {pageNum}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}

      <style
        dangerouslySetInnerHTML={{
          __html: `
            .enhanced-pdf-viewer {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            }
            
            .pdf-container {
              overflow: auto;
              height: 100%;
            }
            
            .pdf-continuous-container {
              scroll-behavior: smooth;
              height: 100%;
            }
            
            .pdf-canvas {
              max-width: 100%;
              height: auto;
            }
            
            .pdf-page-container {
              position: relative;
            }
            
            /* Text layer styles for text selection */
            .textLayer {
              position: absolute;
              text-align: initial;
              left: 0;
              top: 0;
              right: 0;
              bottom: 0;
              overflow: hidden;
              line-height: 1;
              -webkit-text-size-adjust: none;
              -moz-text-size-adjust: none;
              text-size-adjust: none;
              forced-color-adjust: none;
              transform-origin: 0 0;
              z-index: 2;
            }
            
            .textLayer span {
              color: transparent;
              position: absolute;
              white-space: pre;
              cursor: text;
              transform-origin: 0% 0%;
              line-height: 1;
              -webkit-user-select: text;
              -moz-user-select: text;
              user-select: text;
            }
            
            .textLayer br {
              color: transparent;
              position: absolute;
            }
            
            /* PDF.js text layer specific styles */
            .textLayer .endOfContent {
              display: block;
              position: absolute;
              left: 0;
              top: 100%;
              right: 0;
              bottom: 0;
              z-index: -1;
              cursor: default;
              user-select: none;
            }
            
            .textLayer .endOfContent.active {
              top: 0;
            }
            
            /* Show text selection */
            .textLayer ::selection {
              background: rgba(0, 0, 255, 0.3);
              color: transparent;
            }
            
            .textLayer ::-moz-selection {
              background: rgba(0, 0, 255, 0.3);
              color: transparent;
            }
            
            /* Ensure text layer is interactive */
            .textLayer .highlight {
              margin: -1px;
              padding: 1px;
              background-color: rgba(180, 0, 170, 0.2);
              border-radius: 4px;
            }
            
            .textLayer .highlight.appended {
              position: initial;
            }
            
            .textLayer .highlight.begin {
              border-radius: 4px 0 0 4px;
            }
            
            .textLayer .highlight.end {
              border-radius: 0 4px 4px 0;
            }
            
            .textLayer .highlight.middle {
              border-radius: 0;
            }
            
            .textLayer .highlight.selected {
              background-color: rgba(0, 100, 0, 0.2);
            }
            
            /* Remove mix-blend-mode as it can interfere with text selection */
            .textLayer {
              pointer-events: auto;
            }
            
            .pdf-canvas {
              z-index: 1;
            }
            
            /* Ensure proper text selection behavior */
            .pdf-page-container {
              -webkit-user-select: none;
              -moz-user-select: none;
              user-select: none;
            }
            
            .pdf-page-container .textLayer {
              -webkit-user-select: text;
              -moz-user-select: text;
              user-select: text;
            }
            
            @media print {
              .enhanced-pdf-viewer .sticky {
                display: none !important;
              }
              
              .pdf-container, .pdf-continuous-container {
                padding: 0 !important;
                background: white !important;
                height: auto !important;
                overflow: visible !important;
              }
              
              .pdf-container > div, .pdf-continuous-container > div > div {
                box-shadow: none !important;
              }
              
              .textLayer {
                display: none !important;
              }
            }
          `,
        }}
      />
    </div>
  )
}

export default PdfViewer
