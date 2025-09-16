import React, { useEffect, useState } from "react"
import { X, FileText, ExternalLink, ArrowLeft } from "lucide-react"
import { Citation } from "shared/types"
import PdfViewer from "./PdfViewer"
import DocxViewer from "./DocxViewer"
import ReadmeViewer from "./ReadmeViewer"
import { api } from "@/api"
import { authFetch } from "@/utils/authFetch"

interface CitationPreviewProps {
  citation: Citation | null
  isOpen: boolean
  onClose: () => void
  onBackToSources?: () => void
  showBackButton?: boolean
}

export const CitationPreview: React.FC<CitationPreviewProps> = React.memo(
  ({ citation, isOpen, onClose, onBackToSources, showBackButton = false }) => {
    const [documentContent, setDocumentContent] = useState<Blob | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
      if (!citation || !isOpen) {
        setDocumentContent(null)
        setError(null)
        return
      }

      const loadDocument = async () => {
        setLoading(true)
        setError(null)
        try {
          if (
            citation.app === "KnowledgeBase" &&
            citation.itemId &&
            citation.clId
          ) {
            const response =
              await api.cl[citation.clId].files[citation.itemId].content.$get()

            if (!response.ok) {
              throw new Error(
                `Failed to fetch document: ${response.statusText}`,
              )
            }

            const blob = await response.blob()
            setDocumentContent(blob)
          } else if (citation.url) {
            // For external documents, try to fetch directly
            const response = await authFetch(citation.url, {
              method: "GET",
            })

            if (!response.ok) {
              throw new Error(
                `Failed to fetch document: ${response.statusText}`,
              )
            }

            const blob = await response.blob()
            setDocumentContent(blob)
          } else {
            throw new Error("No document source available")
          }
        } catch (err) {
          console.error("Error loading document:", err)
          setError(
            err instanceof Error ? err.message : "Failed to load document",
          )
        } finally {
          setLoading(false)
        }
      }

      loadDocument()
    }, [citation, isOpen])

    const getFileExtension = (filename: string): string => {
      return filename.toLowerCase().split(".").pop() || ""
    }

    const renderViewer = () => {
      if (!documentContent || !citation) return null

      const fileName = citation.title || ""
      const extension = getFileExtension(fileName)

      // Create a File object from the blob
      const file = new File([documentContent], fileName, {
        type: documentContent.type || getDefaultMimeType(extension),
      })

      switch (extension) {
        case "pdf":
          return (
            <PdfViewer
              key={citation.docId}
              source={file}
              className="h-full"
              style={{ height: "100%", overflow: "auto" }}
              scale={1.0}
              showNavigation={true}
              displayMode="continuous"
            />
          )
        case "md":
        case "markdown":
          return (
            <ReadmeViewer
              source={file}
              className="h-full"
              style={{ height: "100%", overflow: "auto", padding: "16px" }}
            />
          )
        case "docx":
        case "doc":
          return (
            <DocxViewer
              key={citation.docId}
              source={file}
              className="h-full"
              style={{ overflow: "visible" }}
              options={{
                renderHeaders: true,
                renderFooters: true,
                renderFootnotes: true,
                renderEndnotes: true,
                breakPages: true,
              }}
            />
          )
        default:
          // For other file types, try to display as text or show a generic message
          return (
            <div className="h-full p-4 flex flex-col items-center justify-center text-gray-500 dark:text-gray-400">
              <FileText size={48} className="mb-4" />
              <p className="text-center">
                Preview not available for this file type.
              </p>
              {citation.url && (
                <a
                  href={citation.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 flex items-center text-blue-600 dark:text-blue-400 hover:underline"
                >
                  <ExternalLink size={16} className="mr-2" />
                  Open in new tab
                </a>
              )}
            </div>
          )
      }
    }

    const getDefaultMimeType = (extension: string): string => {
      switch (extension) {
        case "pdf":
          return "application/pdf"
        case "docx":
          return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        case "doc":
          return "application/msword"
        case "md":
        case "markdown":
          return "text/markdown"
        case "txt":
          return "text/plain"
        default:
          return "application/octet-stream"
      }
    }

    if (!isOpen) return null

    return (
      <div className="fixed top-0 right-0 bottom-0 w-[47.5%] border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-[#1E1E1E] flex flex-col z-50 shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center flex-1 min-w-0">
            {showBackButton && onBackToSources && (
              <button
                onClick={onBackToSources}
                className="mr-4 p-2 text-gray-600 dark:text-gray-300 transition-colors rounded-md"
              >
                <ArrowLeft size={20} />
              </button>
            )}
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white truncate">
                {citation.title.split("/").pop() || "Document Preview"}
              </h3>
              {citation?.app && (
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  Source:{" "}
                  {citation.title.replace(/\/[^/]*$/, "") || "Unknown Source"}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-4 p-2 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"
            title="Close preview"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {loading && (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
                <p className="text-gray-600 dark:text-gray-400">
                  Loading document...
                </p>
              </div>
            </div>
          )}

          {error && (
            <div className="h-full flex items-center justify-center p-6">
              <div className="text-center">
                <div className="text-red-500 mb-4">
                  <FileText size={48} />
                </div>
                <p className="text-red-600 dark:text-red-400 mb-4">{error}</p>
                {citation?.url && (
                  <a
                    href={citation.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    <ExternalLink size={16} className="mr-2" />
                    Try opening in new tab
                  </a>
                )}
              </div>
            </div>
          )}

          {!loading && !error && documentContent && (
            <div className="h-full overflow-auto">{renderViewer()}</div>
          )}
        </div>
      </div>
    )
  },
)

CitationPreview.displayName = "CitationPreview"

export default CitationPreview
