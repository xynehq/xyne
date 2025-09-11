import React, { useEffect, useRef, useState, useMemo } from "react"
import * as docx from "docx-preview"
import { authFetch } from "@/utils/authFetch"

interface DocxViewerProps {
  /** Either a URL or File object */
  source: string | File
  /** Additional CSS class names */
  className?: string
  /** Show loading spinner */
  showLoading?: boolean
  /** Custom styles for the container */
  style?: React.CSSProperties
  /** Render options for docx-preview */
  options?: Partial<docx.Options>
}

export const DocxViewer: React.FC<DocxViewerProps> = ({
  source,
  className = "",
  showLoading = true,
  style = {},
  options = {},
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  // Memoize options to prevent unnecessary re-renders
  const renderOptions = useMemo<Partial<docx.Options>>(
    () => ({
      className: "docx-preview",
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderComments: false,
      renderChanges: false,
      debug: false,
      ...options,
    }),
    [options],
  )

  // Use a stable key for the source to avoid unnecessary re-renders
  const sourceKey = useMemo(() => {
    if (source instanceof File) {
      return `file-${source.name}-${source.size}-${source.lastModified}`
    }
    return source
  }, [source])

  useEffect(() => {
    let mounted = true
    let retryCount = 0
    const maxRetries = 10

    const tryLoadDocument = () => {
      if (!mounted) return

      if (containerRef.current) {
        loadDocument()
      } else if (retryCount < maxRetries) {
        retryCount++
        setTimeout(tryLoadDocument, 100)
      } else {
        setError("Failed to initialize document viewer")
        setLoading(false)
      }
    }

    tryLoadDocument()

    return () => {
      mounted = false
    }
  }, [sourceKey])

  const loadDocument = async () => {
    if (!containerRef.current) {
      setError("Container not ready")
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      setError(null)

      containerRef.current.innerHTML = ""

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
        const res = await authFetch(source, {
          headers: {
            Accept:
              "application/octet-stream, application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        })

        if (!res.ok) {
          if (res.status === 401) {
            throw new Error(
              "Authentication required. Please log in to view this document.",
            )
          } else if (res.status === 403) {
            throw new Error("You don't have permission to view this document.")
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

      const view = new Uint8Array(data.slice(0, 2))
      if (view[0] !== 0x50 || view[1] !== 0x4b) {
        throw new Error("Invalid document format")
      }

      if (!containerRef.current) {
        throw new Error("Container ref lost during processing")
      }

      await docx.renderAsync(
        data,
        containerRef.current,
        undefined,
        renderOptions,
      )

      // After rendering, remove any inline width constraints and make it responsive
      if (containerRef.current) {
        // Remove width constraints from all sections
        const sections = containerRef.current.querySelectorAll(
          "section.docx-preview, section.docx-viewer",
        )
        sections.forEach((el) => {
          const section = el as HTMLElement
          section.style.removeProperty("width")
          section.style.removeProperty("max-width")
          section.style.removeProperty("min-width")
          section.style.width = "100%"
          section.style.maxWidth = "100%"
          section.style.minWidth = "auto"
        })

        // Remove width constraints from all wrappers
        const wrappers = containerRef.current.querySelectorAll(
          '.docx, .docx-wrapper, .docx-preview-wrapper, .docx-preview'
        );
        wrappers.forEach((el) => {
          const wrapper = el as HTMLElement;
          wrapper.style.removeProperty('width');
          wrapper.style.removeProperty('max-width');
          wrapper.style.removeProperty('min-width');
          wrapper.style.removeProperty('padding');
          wrapper.style.width = '100%';
          wrapper.style.maxWidth = '100%';
          wrapper.style.minWidth = 'auto';
          wrapper.style.padding = '12%';
        });

        // Make tables responsive
        const tables = containerRef.current.querySelectorAll("table")
        tables.forEach((table) => {
          const tableEl = table as HTMLElement
          tableEl.style.width = "100%"
          tableEl.style.maxWidth = "100%"
          tableEl.style.minWidth = "auto"
          tableEl.style.tableLayout = "fixed" // Better for responsive tables

          // Make all cells wrap content properly
          const cells = tableEl.querySelectorAll("td, th")
          cells.forEach((cell) => {
            const cellEl = cell as HTMLElement;
            cellEl.style.overflowWrap = 'break-word';
            cellEl.style.whiteSpace = 'normal';
            cellEl.style.maxWidth = '100px';
            cellEl.style.minWidth = '0';
            cellEl.style.boxSizing = 'border-box';
            cellEl.style.padding = '5px';
          });
        });

        // Make images responsive
        const images = containerRef.current.querySelectorAll("img")
        images.forEach((img) => {
          const imgEl = img as HTMLElement
          imgEl.style.maxWidth = "100%"
          imgEl.style.height = "auto"
          imgEl.style.width = "auto"
        })
      }
    } catch (e) {
      const errorMessage =
        e instanceof Error ? e.message : "Failed to load document"
      setError(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  // Always render the container div
  return (
    <div
      className={`enhanced-docx-viewer ${className}`}
      style={{
        backgroundColor: "white",
        minHeight: "100vh",
        ...style,
      }}
    >
      {loading && showLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/90 dark:bg-[#1E1E1E]/90 z-10">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-600 dark:border-gray-300 mx-auto mb-4"></div>
            <p className="text-gray-600 dark:text-gray-300">
              Loading document...
            </p>
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white z-10">
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 max-w-md">
            <p className="text-red-800 font-semibold">Error loading document</p>
            <p className="text-red-600 text-sm mt-1">{error}</p>
            <button
              onClick={loadDocument}
              className="mt-2 px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700"
            >
              Retry
            </button>
          </div>
        </div>
      )}
      
      <div ref={containerRef} />
    </div>
  )
}

export default DocxViewer
