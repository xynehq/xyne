import React, { useEffect, useState, useMemo } from "react"
import MarkdownPreview from "@uiw/react-markdown-preview"
import "@uiw/react-markdown-preview/markdown.css"
import { authFetch } from "@/utils/authFetch"
import { useTheme } from "@/components/ThemeContext"

interface ReadmeViewerProps {
  /** Either a URL or File object */
  source: string | File
  /** Additional CSS class names */
  className?: string
  /** Show loading spinner */
  showLoading?: boolean
  /** Custom styles for the container */
  style?: React.CSSProperties
}

export const ReadmeViewer: React.FC<ReadmeViewerProps> = ({
  source,
  className = "",
  showLoading = true,
  style = {},
}) => {
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [markdownContent, setMarkdownContent] = useState<string>("")
  const { theme } = useTheme()

  // Use a stable key for the source to avoid unnecessary re-renders
  const sourceKey = useMemo(() => {
    if (source instanceof File) {
      return `file-${source.name}-${source.size}-${source.lastModified}`
    }
    return source
  }, [source])

  useEffect(() => {
    let mounted = true

    const loadDocument = async () => {
      try {
        setLoading(true)
        setError(null)

        if (!source) {
          throw new Error("No document source provided")
        }

        let content: string
        if (source instanceof File) {
          if (source.size === 0) {
            throw new Error("File is empty")
          }

          content = await source.text()
        } else {
          const res = await authFetch(source, {
            headers: {
              Accept: "text/plain, text/markdown",
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

          content = await res.text()
        }

        if (!content || content.length === 0) {
          throw new Error("Document content is empty")
        }

        if (mounted) {
          setMarkdownContent(content)
        }
      } catch (e) {
        const errorMessage =
          e instanceof Error ? e.message : "Failed to load document"
        if (mounted) {
          setError(errorMessage)
        }
      } finally {
        if (mounted) {
          setLoading(false)
        }
      }
    }

    loadDocument()

    return () => {
      mounted = false
    }
  }, [sourceKey, source])

  return (
    <div
      className={`readme-viewer relative min-h-full bg-white dark:bg-[#1E1E1E] ${className}`}
      style={style}
      data-color-mode={theme}
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
        <div className="absolute inset-0 flex items-center justify-center bg-white dark:bg-[#1E1E1E] z-10">
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 max-w-md">
            <p className="text-red-800 dark:text-red-200 font-semibold">
              Error loading document
            </p>
            <p className="text-red-600 dark:text-red-300 text-sm mt-1">
              {error}
            </p>
          </div>
        </div>
      )}

      {!loading && !error && markdownContent && (
        <div className="markdown-preview-wrapper">
          <MarkdownPreview
            source={markdownContent}
            style={{
              padding: "40px 60px",
              maxWidth: "850px",
              margin: "0 auto",
              backgroundColor: "transparent",
            }}
            wrapperElement={{
              "data-color-mode": theme,
            }}
            rehypeRewrite={(node: any, index: any, parent: any) => {
              // Remove header anchor links if needed
              if (
                node.tagName === "a" &&
                parent &&
                /^h(1|2|3|4|5|6)/.test(parent.tagName)
              ) {
                parent.children = parent.children.slice(1)
              }
            }}
          />
        </div>
      )}

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .readme-viewer {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
        }
        
        .markdown-preview-wrapper {
          min-height: 100vh;
        }
        
        /* Override some default styles for better integration */
        .wmde-markdown {
          background-color: transparent !important;
          color: inherit !important;
        }
        
        .wmde-markdown pre {
          background-color: ${theme === "dark" ? "#2d2d2d" : "#f6f8fa"} !important;
          border: 1px solid ${theme === "dark" ? "#404040" : "#e1e4e8"} !important;
        }
        
        .wmde-markdown code {
          background-color: ${theme === "dark" ? "#2d2d2d" : "rgba(175, 184, 193, 0.2)"} !important;
          color: ${theme === "dark" ? "#e1e4e8" : "#24292e"} !important;
          border: 1px solid ${theme === "dark" ? "#404040" : "#e1e4e8"} !important;
        }
        
        /* Ensure proper text color in dark mode */
        [data-color-mode="dark"] .wmde-markdown {
          color: #c9d1d9 !important;
        }
        
        [data-color-mode="dark"] .wmde-markdown h1,
        [data-color-mode="dark"] .wmde-markdown h2,
        [data-color-mode="dark"] .wmde-markdown h3,
        [data-color-mode="dark"] .wmde-markdown h4,
        [data-color-mode="dark"] .wmde-markdown h5,
        [data-color-mode="dark"] .wmde-markdown h6 {
          color: #c9d1d9 !important;
          border-bottom-color: #404040 !important;
        }
        
        [data-color-mode="dark"] .wmde-markdown a {
          color: #58a6ff !important;
        }
        
        [data-color-mode="dark"] .wmde-markdown a:hover {
          color: #79c0ff !important;
        }
        
        [data-color-mode="dark"] .wmde-markdown blockquote {
          border-left-color: #404040 !important;
          color: #8b949e !important;
        }
        
        [data-color-mode="dark"] .wmde-markdown table {
          border-color: #404040 !important;
        }
        
        [data-color-mode="dark"] .wmde-markdown table th,
        [data-color-mode="dark"] .wmde-markdown table td {
          border-color: #404040 !important;
        }
        
        [data-color-mode="dark"] .wmde-markdown table tr:nth-child(2n) {
          background-color: #2d2d2d !important;
        }
        
        [data-color-mode="dark"] .wmde-markdown hr {
          border-color: #404040 !important;
        }
        
        [data-color-mode="dark"] .wmde-markdown ul,
        [data-color-mode="dark"] .wmde-markdown ol {
          color: #c9d1d9 !important;
        }
        
        [data-color-mode="dark"] .wmde-markdown li {
          color: #c9d1d9 !important;
        }
        
        [data-color-mode="dark"] .wmde-markdown strong {
          color: #f0f6fc !important;
        }
        
        [data-color-mode="dark"] .wmde-markdown em {
          color: #c9d1d9 !important;
        }
        
        @media print {
          .readme-viewer {
            background: white !important;
          }
          
          .markdown-preview-wrapper {
            padding: 0 !important;
          }
        }
      `,
        }}
      />
    </div>
  )
}

export default ReadmeViewer
