import React, { useEffect, useState, useRef, useMemo } from "react"
import { X, FileText, ExternalLink, ArrowLeft, Bot } from "lucide-react"
import { z } from "zod"
import { Citation } from "shared/types"
import AgentDocumentPreviewContent, {
  type AgentDocumentPayload,
} from "./AgentDocumentPreviewContent"
import PdfViewer from "./PdfViewer"
import DocxViewer from "./DocxViewer"
import ReadmeViewer from "./ReadmeViewer"
import { api } from "@/api"
import { authFetch } from "@/utils/authFetch"
import ExcelViewer from "./ExcelViewer"
import CsvViewer from "./CsvViewer"
import { DocumentOperations } from "@/contexts/DocumentOperationsContext"
import TxtViewer from "./TxtViewer"
import { useScopedFind } from "@/hooks/useScopedFind"
import JsonViewer from "./JsonViewer"

interface CitationPreviewProps {
  citation: Citation | null
  isOpen: boolean
  onClose: () => void
  onBackToSources?: () => void
  showBackButton?: boolean
  documentOperationsRef?: React.RefObject<DocumentOperations>
  onDocumentLoaded?: () => void
  /** 0-based page/sheet index to open at (from chunk API). PDF uses as initialPage (1-based), Excel as initial sheet. */
  initialPageIndex?: number | null
}

function isAgentDocumentCitation(c: Citation | null): boolean {
  return !!c && c.docId.startsWith("delegated_agent:") && !!c.url
}

// Zod schema for validating AgentDocumentPayload
const AgentSourceCitationSchema = z.object({
  docId: z.string(),
  title: z.string(),
  url: z.string().optional(),
  app: z.string(),
  entity: z.string(),
  chunkContent: z.string().optional(),
})

const AgentDocumentPayloadSchema = z.object({
  externalId: z.string().optional(),
  title: z.string().optional(),
  agentName: z.string(),
  content: z.string(),
  summary: z.string().nullable().optional(),
  reasoning: z.string().nullable().optional(),
  citations: z.array(AgentSourceCitationSchema).optional(),
  confidence: z.number().nullable().optional(),
  createdAt: z.string(),
})

// Inner component that has access to DocumentOperations context
const CitationPreview: React.FC<CitationPreviewProps> = ({
  citation,
  isOpen,
  onClose,
  onBackToSources,
  showBackButton = false,
  documentOperationsRef,
  onDocumentLoaded,
  initialPageIndex,
}) => {
  const [documentContent, setDocumentContent] = useState<Blob | null>(null)
  const [agentDocument, setAgentDocument] = useState<AgentDocumentPayload | null>(
    null,
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!citation || !isOpen) {
      setDocumentContent(null)
      setAgentDocument(null)
      setError(null)
      return
    }

    const abortController = new AbortController()
    const { signal } = abortController

    if (isAgentDocumentCitation(citation)) {
      const loadAgentJson = async () => {
        if (signal.aborted) return
        setLoading(true)
        setError(null)
        setDocumentContent(null)
        setAgentDocument(null)
        try {
          const response = await authFetch(citation.url, {
            method: "GET",
            signal,
          })
          if (signal.aborted) return
          if (!response.ok) {
            throw new Error(`Failed to fetch document: ${response.statusText}`)
          }
          const jsonData = await response.json()
          if (signal.aborted) return
          const validationResult = AgentDocumentPayloadSchema.safeParse(jsonData)
          if (!validationResult.success) {
            console.error("API response validation error:", validationResult.error)
            throw new Error("Invalid document data received from server.")
          }
          if (signal.aborted) return
          setAgentDocument(validationResult.data)
        } catch (err) {
          if (signal.aborted) return
          console.error("Error loading agent document:", err)
          setError(
            err instanceof Error ? err.message : "Failed to load document",
          )
        } finally {
          if (!signal.aborted) {
            setLoading(false)
          }
        }
      }
      void loadAgentJson()
      return () => {
        abortController.abort()
      }
    }

    const loadDocument = async () => {
      if (signal.aborted) return
      setLoading(true)
      setError(null)
      setAgentDocument(null)
      try {
        if (
          citation.app === "KnowledgeBase" &&
          citation.itemId &&
          citation.clId
        ) {
          const response =
            await api.cl[citation.clId].files[citation.itemId].content.$get()

          if (signal.aborted) return
          if (!response.ok) {
            throw new Error(`Failed to fetch document: ${response.statusText}`)
          }

          const blob = await response.blob()
          if (signal.aborted) return
          setDocumentContent(blob)
        } else if (citation.url) {
          const response = await authFetch(citation.url, {
            method: "GET",
            signal,
          })

          if (signal.aborted) return
          if (!response.ok) {
            throw new Error(`Failed to fetch document: ${response.statusText}`)
          }

          const blob = await response.blob()
          if (signal.aborted) return
          setDocumentContent(blob)
        } else {
          throw new Error("No document source available")
        }
      } catch (err) {
        if (signal.aborted) return
        console.error("Error loading document:", err)
        setError(err instanceof Error ? err.message : "Failed to load document")
      } finally {
        if (!signal.aborted) {
          setLoading(false)
        }
      }
    }

    void loadDocument()
    return () => {
      abortController.abort()
    }
  }, [citation, isOpen])

  const { highlightText, clearHighlights, scrollToMatch } = useScopedFind(
    containerRef,
    {
      documentId: citation?.itemId ?? citation?.docId ?? "",
    },
  )

  // Expose the highlight functions via the document operations ref
  useEffect(() => {
    if (documentOperationsRef?.current) {
      documentOperationsRef.current.highlightText = async (
        text: string,
        chunkIndex: number,
        pageIndex?: number,
        waitForTextLayer: boolean = false,
      ) => {
        if (!containerRef.current) {
          return false
        }

        try {
          const success = await highlightText(
            text,
            chunkIndex,
            pageIndex,
            waitForTextLayer,
          )
          return success
        } catch (error) {
          console.error("Error calling highlightText:", error)
          return false
        }
      }

      documentOperationsRef.current.clearHighlights = clearHighlights
      documentOperationsRef.current.scrollToMatch = scrollToMatch
    }
  }, [documentOperationsRef, highlightText, clearHighlights, scrollToMatch])

  useEffect(() => {
    clearHighlights()
  }, [citation?.itemId, citation?.docId, clearHighlights])

  const getFileExtension = (mimeType: string, filename: string): string => {
    if (mimeType === "application/pdf") {
      return "pdf"
    }
    if (
      mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      return "docx"
    }
    if (mimeType === "application/msword") {
      return "doc"
    }
    if (mimeType === "text/markdown") {
      return "md"
    }
    if (mimeType === "text/plain") {
      return "txt"
    }
    if (mimeType === "application/vnd.ms-excel") {
      return "xls"
    }
    if (
      mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      return "xlsx"
    }
    if (mimeType === "text/csv") {
      return "csv"
    }
    if (mimeType === "text/tsv") {
      return "tsv"
    }
    return filename.toLowerCase().split(".").pop() || ""
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

  const viewerElement = useMemo(() => {
    if (!documentContent || !citation || isAgentDocumentCitation(citation))
      return null

    const fileName = citation.title || ""
    const extension = getFileExtension(documentContent.type, fileName)

    // Create a File object from the blob
    const file = new File([documentContent], fileName, {
      type: documentContent.type || getDefaultMimeType(extension),
    })

    const initialPageOrSheetIndex =
      initialPageIndex != null && initialPageIndex >= 0
        ? initialPageIndex
        : 0

    switch (extension) {
      case "pdf":
        return (
          <div ref={containerRef} data-container-ref="true" className="h-full">
            <PdfViewer
              key={citation.docId}
              source={file}
              className="h-full"
              style={{ height: "100%", overflow: "auto" }}
              scale={1.0}
              showNavigation={true}
              displayMode="continuous"
              documentOperationsRef={documentOperationsRef}
              initialPage={initialPageOrSheetIndex}
            />
          </div>
        )
      case "md":
      case "markdown":
        return (
          <div ref={containerRef} data-container-ref="true" className="h-full">
            <ReadmeViewer
              key={citation.docId}
              source={file}
              className="h-full"
              style={{ height: "100%", overflow: "auto", padding: "16px" }}
            />
          </div>
        )
      case "docx":
      case "doc":
        return (
          <div ref={containerRef} data-container-ref="true" className="h-full">
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
                renderComments: false,
                renderChanges: false,
                breakPages: true,
                ignoreLastRenderedPageBreak: true,
                inWrapper: true,
                ignoreWidth: false,
                ignoreHeight: false,
                ignoreFonts: false,
              }}
            />
          </div>
        )
      case "xlsx":
      case "xls":
        return (
          <div ref={containerRef} data-container-ref="true" className="h-full">
            <ExcelViewer
              key={citation.docId}
              source={file}
              className="h-full"
              style={{ overflow: "visible" }}
              documentOperationsRef={documentOperationsRef}
              initialSheetIndex={initialPageOrSheetIndex}
            />
          </div>
        )
      case "csv":
      case "tsv":
        return (
          <div ref={containerRef} data-container-ref="true" className="h-full">
            <CsvViewer
              key={citation.docId}
              source={file}
              className="h-full"
              style={{ overflow: "visible" }}
            />
          </div>
        )
      case "txt":
      case "text":
        return (
          <div ref={containerRef} data-container-ref="true" className="h-full">
            <TxtViewer
              key={citation.docId}
              source={file}
              className="h-full"
              style={{ overflow: "visible" }}
            />
          </div>
        )
      case "json":
        return (
          <div ref={containerRef} data-container-ref="true" className="h-full">
            <JsonViewer
              key={citation.docId}
              source={file}
              className="h-full"
              style={{ overflow: "visible" }}
            />
          </div>
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
  }, [citation, documentContent, initialPageIndex])

  // Notify parent when document is loaded and ready
  useEffect(() => {
    if (!onDocumentLoaded || loading || error) return
    if (citation && isAgentDocumentCitation(citation)) {
      if (agentDocument) onDocumentLoaded()
      return
    }
    if (documentContent && viewerElement) {
      onDocumentLoaded()
    }
  }, [
    loading,
    error,
    documentContent,
    agentDocument,
    onDocumentLoaded,
    viewerElement,
    citation,
  ])

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
          <div className="flex-1 min-w-0 flex items-start gap-3">
            {citation && isAgentDocumentCitation(citation) && (
              <div className="p-2 bg-blue-100 dark:bg-blue-900 rounded-lg shrink-0">
                <Bot className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white truncate">
                {isAgentDocumentCitation(citation) && agentDocument?.agentName
                  ? agentDocument.agentName
                  : citation?.title?.split("/").pop() || "Document Preview"}
              </h3>
              {citation && isAgentDocumentCitation(citation) && agentDocument ? (
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  {new Date(agentDocument.createdAt).toLocaleString()}
                </p>
              ) : citation?.app ? (
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  Source:{" "}
                  {citation.title.replace(/\/[^/]*$/, "") || "Unknown Source"}
                </p>
              ) : null}
            </div>
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

        {!loading &&
          !error &&
          citation &&
          isAgentDocumentCitation(citation) &&
          agentDocument && (
            <div className="h-full min-h-0 flex flex-col">
              <AgentDocumentPreviewContent
                key={agentDocument.externalId || agentDocument.createdAt}
                document={agentDocument}
              />
            </div>
          )}

        {!loading &&
          !error &&
          (!citation || !isAgentDocumentCitation(citation)) &&
          documentContent && (
            <div className="h-full overflow-auto">{viewerElement}</div>
          )}
      </div>
    </div>
  )
}

CitationPreview.displayName = "CitationPreview"

export default CitationPreview
