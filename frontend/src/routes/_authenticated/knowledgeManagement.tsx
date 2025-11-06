import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import {
  Plus,
  X,
  MoreHorizontal,
  Edit,
  Trash2,
  ArrowLeft,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronRight,
  ChevronDown,
} from "lucide-react"
import { Sidebar } from "@/components/Sidebar"
import { useState, useCallback, useEffect, memo, useRef, useMemo } from "react"
import { Input } from "@/components/ui/input"
import CollectionFileUpload, {
  SelectedFile as FileUploadSelectedFile,
} from "@/components/ClFileUpload"
import FileUploadSkeleton from "@/components/FileUploadSkeleton"
import { useToast } from "@/hooks/use-toast"
import FileTree from "@/components/FileTree"
import SimpleFileTree from "@/components/SimpleFileTree"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ConfirmModal } from "@/components/ui/confirmModal"
import {
  buildFileTree,
  type FileNode,
  uploadFileBatch,
  createCollection,
  deleteCollection,
  deleteItem,
} from "@/utils/fileUtils"
import { isValidFile } from "shared/fileUtils"
import type {
  Collection as CollectionType,
  CollectionItem,
} from "@/types/knowledgeBase"
import { api } from "@/api"
import { UploadStatus, UserRole } from "shared/types"
import DocxViewer from "@/components/DocxViewer"
import PdfViewer from "@/components/PdfViewer"
import ReadmeViewer from "@/components/ReadmeViewer"
import { DocumentChat } from "@/components/DocumentChat"
import { authFetch } from "@/utils/authFetch"
import { generateUUID } from "@/utils/chatUtils.tsx"
import { useScopedFind } from "@/hooks/useScopedFind"
import { PersistentMap } from "@/utils/chatUtils.tsx"
import {
  DocumentOperationsProvider,
  useDocumentOperations,
} from "@/contexts/DocumentOperationsContext"
import ExcelViewer from "@/components/ExcelViewer"
import CsvViewer from "@/components/CsvViewer"
import TxtViewer from "@/components/TxtViewer"
import { useUploadProgress } from "@/store/useUploadProgressStore"
import { DebugDocModal } from "@/components/DebugDocModal"
import kbEmptyStateIcon from "@/assets/emptystateIcons/kb.png"

// Persistent storage for documentId -> tempChatId mapping using sessionStorage
const DOCUMENT_CHAT_MAP_KEY = "documentToTempChatMap"
const documentToTempChatMap = new PersistentMap(DOCUMENT_CHAT_MAP_KEY)

export const Route = createFileRoute("/_authenticated/knowledgeManagement")({
  component: RouteComponent,
})

interface Collection {
  id: string
  name: string
  description?: string | null
  files: number
  lastUpdated: string
  updatedBy: string
  items: FileNode[]
  isOpen?: boolean
  // For compatibility with KnowledgeBase
  totalCount?: number
  isPrivate?: boolean
}

// Memoized Document Viewer Container to prevent re-renders on sidebar resize
const DocumentViewerContainer = memo(
  ({
    selectedDocument,
    loadingDocument,
    setCurrentSheetIndex,
  }: {
    selectedDocument: {
      file: FileNode
      collection: Collection
      content?: Blob
    }
    loadingDocument: boolean
    setCurrentSheetIndex: (index: number) => void
  }) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const { documentOperationsRef } = useDocumentOperations()

    const viewerElement = useMemo(() => {
      if (!selectedDocument?.content) return null

      const name = selectedDocument.file.name.toLowerCase()

      if (name.endsWith(".pdf")) {
        return (
          <div ref={containerRef} data-container-ref="true" className="h-full">
            <PdfViewer
              source={
                new File(
                  [selectedDocument.content],
                  selectedDocument.file.name,
                  { type: selectedDocument.content.type || "application/pdf" },
                )
              }
              docId={selectedDocument.file.id}
              className="h-full"
              style={{ height: "100%", overflow: "auto" }}
              scale={1.2}
              showNavigation
              displayMode="continuous"
              documentOperationsRef={documentOperationsRef}
            />
          </div>
        )
      }

      if (name.endsWith(".md")) {
        return (
          <div ref={containerRef} data-container-ref="true" className="h-full">
            <ReadmeViewer
              source={
                new File(
                  [selectedDocument.content],
                  selectedDocument.file.name,
                  { type: selectedDocument.content.type || "text/markdown" },
                )
              }
              className="h-full"
              style={{ height: "100%", overflow: "auto" }}
            />
          </div>
        )
      }
      if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
        return (
          <div ref={containerRef} data-container-ref="true" className="h-full">
            <ExcelViewer
              source={
                new File(
                  [selectedDocument.content],
                  selectedDocument.file.name,
                  {
                    type:
                      selectedDocument.content.type ||
                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                  },
                )
              }
              className="h-full"
              style={{ height: "100%", overflow: "auto" }}
              documentOperationsRef={documentOperationsRef}
              onSheetChange={setCurrentSheetIndex}
            />
          </div>
        )
      }

      if (name.endsWith(".csv") || name.endsWith(".tsv")) {
        return (
          <div ref={containerRef} data-container-ref="true" className="h-full">
            <CsvViewer
              source={
                new File(
                  [selectedDocument.content],
                  selectedDocument.file.name,
                  {
                    type:
                      selectedDocument.content.type ||
                      (name.endsWith(".tsv")
                        ? "text/tab-separated-values"
                        : "text/csv"),
                  },
                )
              }
              className="h-full"
              style={{ height: "100%", overflow: "auto" }}
            />
          </div>
        )
      }
      if (name.endsWith(".txt") || name.endsWith(".text")) {
        return (
          <div ref={containerRef} data-container-ref="true" className="h-full">
            <TxtViewer
              source={
                new File(
                  [selectedDocument.content],
                  selectedDocument.file.name,
                  { type: selectedDocument.content.type || "text/plain" },
                )
              }
              className="h-full"
              style={{ height: "100%", overflow: "auto" }}
            />
          </div>
        )
      }

      return (
        <div
          ref={containerRef}
          data-container-ref="true"
          className="h-full p-6 overflow-auto"
        >
          <DocxViewer
            source={
              new File([selectedDocument.content], selectedDocument.file.name, {
                type:
                  selectedDocument.content.type ||
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              })
            }
            className="h-full max-w-4xl mx-auto"
            style={{ height: "100%" }}
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
    }, [
      selectedDocument?.file.id,
      selectedDocument?.file.name,
      selectedDocument?.content,
    ])

    const { highlightText, clearHighlights, scrollToMatch } = useScopedFind(
      containerRef,
      {
        documentId: selectedDocument?.file.id,
      },
    )

    // Expose the highlight functions via the document operations ref
    useEffect(() => {
      if (documentOperationsRef?.current) {
        documentOperationsRef.current.highlightText = async (
          text: string,
          chunkIndex: number,
          pageIndex?: number,
        ) => {
          if (!containerRef.current) {
            const container = document.querySelector(
              '[data-container-ref="true"]',
            )
            if (container) {
              ;(containerRef as any).current = container
            } else {
              return false
            }
          }

          try {
            const success = await highlightText(text, chunkIndex, pageIndex)
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
    }, [selectedDocument?.file.id, clearHighlights])

    useEffect(() => {
      return () => {
        clearHighlights()
      }
    }, [clearHighlights])

    return (
      <div className="h-full bg-white dark:bg-[#1E1E1E] relative overflow-auto">
        {loadingDocument && (
          <div className="absolute inset-0 bg-white/90 dark:bg-[#1E1E1E]/90 z-10 flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-600 dark:border-gray-300 mx-auto mb-4"></div>
              <p className="text-gray-600 dark:text-gray-300">
                Loading document...
              </p>
            </div>
          </div>
        )}
        {selectedDocument.content ? (
          <div className="h-full min-w-fit">{viewerElement}</div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-gray-500 dark:text-gray-400">
              Select a document to view
            </p>
          </div>
        )}
      </div>
    )
  },
  (prevProps, nextProps) => {
    // Custom comparison - only re-render if document or loading state changes
    return (
      prevProps.selectedDocument?.file.id ===
        nextProps.selectedDocument?.file.id &&
      prevProps.selectedDocument?.content ===
        nextProps.selectedDocument?.content &&
      prevProps.loadingDocument === nextProps.loadingDocument
    )
  },
)

DocumentViewerContainer.displayName = "DocumentViewerContainer"

function RouteComponent() {
  return (
    <DocumentOperationsProvider>
      <KnowledgeManagementContent />
    </DocumentOperationsProvider>
  )
}

function KnowledgeManagementContent() {
  const matches = useRouterState({ select: (s) => s.matches })
  const { user, agentWhiteList } = matches[matches.length - 1].context
  const { toast } = useToast()
  const { documentOperationsRef } = useDocumentOperations()
  const [currentSheetIndex, setCurrentSheetIndex] = useState<number>(0)
  const [showNewCollection, setShowNewCollection] = useState(false)
  const [collectionName, setCollectionName] = useState("")
  const [collections, setCollections] = useState<Collection[]>([])
  const [loadingCollections, setLoadingCollections] = useState(true)
  const [editingCollection, setEditingCollection] = useState<Collection | null>(
    null,
  )
  const [deletingCollection, setDeletingCollection] =
    useState<Collection | null>(null)
  const [deletingItem, setDeletingItem] = useState<{
    collection: Collection
    node: FileNode
    path: string
  } | null>(null)
  const [addingToCollection, setAddingToCollection] =
    useState<Collection | null>(null)
  const [targetFolder, setTargetFolder] = useState<FileNode | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<FileUploadSelectedFile[]>(
    [],
  )
  // Document viewer state
  const [selectedDocument, setSelectedDocument] = useState<{
    file: FileNode
    collection: Collection
    content?: Blob
  } | null>(null)
  const [loadingDocument, setLoadingDocument] = useState(false)

  // Chat management state
  const [currentInitialChatId, setCurrentInitialChatId] = useState<
    string | null
  >(null)

  // File tree visibility state
  const [isFileTreeCollapsed, setIsFileTreeCollapsed] = useState(true)

  // Chat visibility state based on zoom level
  const [isChatHidden, setIsChatHidden] = useState(false)

  // Chat overlay state - only used when isChatHidden is true
  const [isChatOverlayOpen, setIsChatOverlayOpen] = useState(false)

  // Vespa data modal state
  const [isVespaModalOpen, setIsVespaModalOpen] = useState(false)

  // Use global upload progress context with selectors
  const startUpload = useUploadProgress((state) => state.startUpload)
  const updateProgress = useUploadProgress((state) => state.updateProgress)
  const updateFileStatus = useUploadProgress((state) => state.updateFileStatus)
  const finishUpload = useUploadProgress((state) => state.finishUpload)
  const defaultBatchProgress = {
    total: 0,
    current: 0,
    batch: 0,
    totalBatches: 0,
  }

  // Derived state from global context - select only what we need
  const isUploading = useUploadProgress(
    (state) => state.currentUpload?.isUploading ?? false,
  )
  const batchProgress = useUploadProgress(
    (state) => state.currentUpload?.batchProgress ?? defaultBatchProgress,
  )
  const uploadingCollectionName = useUploadProgress(
    (state) => state.currentUpload?.collectionName ?? "",
  )
  const isNewCollectionUpload = useUploadProgress(
    (state) => state.currentUpload?.isNewCollection ?? false,
  )
  const targetCollectionId = useUploadProgress(
    (state) => state.currentUpload?.targetCollectionId,
  )

  // Zoom detection for chat component
  useEffect(() => {
    // Guard for SSR
    if (typeof window === "undefined") return

    const measureZoom = () => {
      // Method 1: Using window dimensions ratio
      const zoomLevel1 = window.outerWidth / window.innerWidth

      // Method 3: Using screen width vs window width
      const zoomLevel2 = screen.width / window.innerWidth

      // Use devicePixelRatio as primary method, with fallbacks
      let zoom = zoomLevel1

      // Fallback to window dimensions ratio if devicePixelRatio seems unreliable
      if (zoom < 0.5 || zoom > 5) {
        zoom = zoomLevel2
      }

      // Hide chat if zoom is 150% or higher
      setIsChatHidden(zoom >= 1.5 || window.innerWidth < 1133)
    }

    // Initial check
    measureZoom()

    // Recalculate on viewport-affecting events
    const onResize = () => measureZoom()
    window.addEventListener("resize", onResize)
    window.addEventListener("orientationchange", onResize)

    // Some browsers expose visualViewport events that fire on zoom
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", onResize)
    }

    return () => {
      window.removeEventListener("resize", onResize)
      window.removeEventListener("orientationchange", onResize)
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", onResize)
      }
    }
  }, [])

  const [openDropdown, setOpenDropdown] = useState<string | null>(null)

  useEffect(() => {
    const fetchCollections = async () => {
      setLoadingCollections(true)
      try {
        const response = await api.cl.$get({
          query: { includeItems: "true" },
        })
        if (response.ok) {
          const data = await response.json()

          setCollections(
            data.map(
              (collection: CollectionType & { items?: CollectionItem[] }) => ({
                id: collection.id,
                name: collection.name,
                description: collection.description,
                files: collection.totalItems || 0,
                items: buildFileTree(
                  (collection.items || []).map((item: CollectionItem) => ({
                    name: item.name,
                    type: item.type as "file" | "folder",
                    totalFileCount: item.totalFileCount,
                    updatedAt: item.updatedAt,
                    id: item.id,
                    updatedBy:
                      item.lastUpdatedByEmail || user?.email || "Unknown",
                    uploadStatus: item.uploadStatus as UploadStatus,
                    statusMessage: item.statusMessage,
                    retryCount: item.retryCount,
                  })),
                ),
                isOpen: (collection.items || []).length > 0, // Open if has items
                lastUpdated: new Date(collection.updatedAt).toLocaleString(
                  "en-GB",
                  {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  },
                ),
                updatedBy: collection.lastUpdatedByEmail || "Unknown",
                totalCount: collection.totalItems,
                isPrivate: collection.isPrivate,
              }),
            ),
          )
        } else {
          toast.error({
            title: "Error",
            description: "Failed to fetch knowledge bases.",
          })
        }
      } catch (error) {
        toast.error({
          title: "Error",
          description: "An error occurred while fetching knowledge bases.",
        })
      } finally {
        setLoadingCollections(false)
      }
    }

    fetchCollections()
  }, [toast, user?.email])

  // Poll for upload status updates
  const [isPolling, setIsPolling] = useState(false)

  useEffect(() => {
    if (collections.length === 0) return

    const pollInterval = 5000

    const pollStatuses = async () => {
      try {
        const collectionIds = collections.map((c) => c.id)
        const response = await api.cl["poll-status"].$post({
          json: { collectionIds },
        })

        if (response.ok) {
          const data = (await response.json()) as {
            items: Array<{
              id: string
              uploadStatus: UploadStatus
              statusMessage: string | null
              retryCount: number
              collectionId: string
            }>
          }
          const statusMap = new Map(
            data.items.map((item) => [
              item.id,
              {
                uploadStatus: item.uploadStatus,
                statusMessage: item.statusMessage,
                retryCount: item.retryCount,
              },
            ]),
          )

          // Check if any files are still processing or pending
          const hasProcessingFiles = data.items.some(
            (item) =>
              item.uploadStatus === UploadStatus.PROCESSING ||
              item.uploadStatus === UploadStatus.PENDING,
          )

          // Update collections with new statuses
          setCollections((prevCollections) =>
            prevCollections.map((collection) => {
              // Recursively update file tree with new statuses
              const updateItemStatuses = (items: FileNode[]): FileNode[] => {
                return items.map((item) => {
                  const statusUpdate = item.id ? statusMap.get(item.id) : null
                  return {
                    ...item,
                    uploadStatus:
                      statusUpdate?.uploadStatus ?? item.uploadStatus,
                    statusMessage:
                      statusUpdate?.statusMessage ?? item.statusMessage,
                    retryCount: statusUpdate?.retryCount ?? item.retryCount,
                    children: item.children
                      ? updateItemStatuses(item.children)
                      : undefined,
                  }
                })
              }

              return {
                ...collection,
                items: updateItemStatuses(collection.items),
              }
            }),
          )

          // Stop polling if no files are processing or pending
          if (!hasProcessingFiles) {
            setIsPolling(false)
          }
        }
      } catch (error) {
        // Silently fail polling - don't show errors to user
        console.error("Failed to poll collection statuses:", error)
      }
    }

    if (isPolling) {
      console.log("Polling active")
      const intervalId = setInterval(pollStatuses, pollInterval)
      pollStatuses() // Poll immediately

      return () => {
        clearInterval(intervalId)
      }
    }
  }, [isPolling, collections.length])

  // Start polling when collections change and have processing files
  useEffect(() => {
    if (collections.length === 0) return

    const hasProcessingFiles = collections.some((collection) => {
      const checkItems = (items: FileNode[]): boolean => {
        return items.some((item) => {
          console.log(
            `Checking file: ${item.name}, status: ${item.uploadStatus}`,
          )
          return (
            item.uploadStatus === UploadStatus.PROCESSING ||
            item.uploadStatus === UploadStatus.PENDING ||
            (item.children && checkItems(item.children))
          )
        })
      }
      return checkItems(collection.items)
    })

    console.log(
      `hasProcessingFiles: ${hasProcessingFiles}, isPolling: ${isPolling}`,
    )

    if (hasProcessingFiles && !isPolling) {
      console.log("Starting polling: Files in processing state detected")
      setIsPolling(true)
    }
  }, [collections, isPolling])

  const handleCloseModal = () => {
    setShowNewCollection(false)
    setAddingToCollection(null)
    setTargetFolder(null)
    setCollectionName("")
    setSelectedFiles([])
    setOpenDropdown(null)
  }

  // Utility function to filter valid files and show error if none are valid
  const getValidFilesOrShowError = (files: FileUploadSelectedFile[]) => {
    const validFiles = files.filter((f) => isValidFile(f.file))

    if (validFiles.length === 0) {
      toast.error({
        title: "Unsupported Files",
        description:
          "No valid files to upload. All selected files are unsupported.",
      })
      return null
    }

    return validFiles
  }

  const handleUpload = async () => {
    if (selectedFiles.length === 0) {
      toast.error({
        title: "Upload Error",
        description: "Please select files to upload.",
      })
      return
    }

    if (
      collections.some(
        (c) => c.name.toLowerCase() === collectionName.trim().toLowerCase(),
      )
    ) {
      toast.error({
        title: "Upload Error",
        description:
          "Collection name already exists. Please choose a different name.",
      })
      return
    }

    // Filter out unsupported files before upload
    const validFiles = getValidFilesOrShowError(selectedFiles)
    if (!validFiles) return

    // Start the global upload progress with only valid files
    const batches = createBatches(validFiles, collectionName.trim())
    const files = validFiles.map((f) => ({ file: f.file, id: f.id }))
    const { uploadId, abortController } = startUpload(
      collectionName.trim(),
      files,
      batches.length,
      true,
    )

    // Close the modal immediately after starting upload
    handleCloseModal()

    try {
      // First create the collection
      const cl = await createCollection(collectionName.trim(), "")

      let totalSuccessful = 0
      let totalSkipped = 0
      let totalFailed = 0
      let processed = 0

      for (let i = 0; i < batches.length; i++) {
        const batchFiles = batches[i].map((f) => ({ file: f.file, id: f.id }))

        // Mark batch files as uploading
        batchFiles.forEach((file) => {
          updateFileStatus(uploadId, file.file.name, file.id, "uploading")
        })

        const uploadResult = await uploadFileBatch(
          batchFiles.map((f) => f.file),
          cl.id,
          null,
          abortController.signal,
        )

        // Update individual file statuses based on results
        if (uploadResult.results) {
          uploadResult.results.forEach((result: any, index: number) => {
            const file = batchFiles[index]
            if (result.success) {
              updateFileStatus(uploadId, file.file.name, file.id, "uploaded")
            } else {
              updateFileStatus(
                uploadId,
                file.file.name,
                file.id,
                "failed",
                result.error || "Upload failed",
              )
            }
          })
        } else {
          // Fallback: mark all as uploaded if no individual results available
          batchFiles.forEach((file) => {
            updateFileStatus(uploadId, file.file.name, file.id, "uploaded")
          })
        }

        // Accumulate results from each batch
        if (uploadResult.summary) {
          totalSuccessful += uploadResult.summary.successful || 0
          totalSkipped += uploadResult.summary.skipped || 0
          totalFailed += uploadResult.summary.failed || 0
        }

        // Update progress
        processed += batchFiles.length
        updateProgress(uploadId, processed, i + 1)
      }

      // Fetch the updated Collection data from the backend
      const clResponse = await api.cl[":id"].$get({ param: { id: cl.id } })
      const updatedCl = await clResponse.json()

      // Also fetch the collection items to build the file tree
      const itemsResponse = await api.cl[":id"].items.$get({
        param: { id: cl.id },
      })
      const items = await itemsResponse.json()

      const newCollection: Collection = {
        id: updatedCl.id,
        name: updatedCl.name,
        description: updatedCl.description,
        files: updatedCl.totalCount || validFiles.length,
        lastUpdated: new Date(updatedCl.updatedAt).toLocaleString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
        updatedBy: updatedCl.lastUpdatedByEmail || user?.email || "Unknown",
        items: buildFileTree(
          items.map((item: CollectionItem) => ({
            name: item.name,
            type: item.type as "file" | "folder",
            totalFileCount: item.totalFileCount,
            updatedAt: item.updatedAt,
            id: item.id,
            updatedBy: item.lastUpdatedByEmail || user?.email || "Unknown",
            uploadStatus: item.uploadStatus as UploadStatus,
            statusMessage: item.statusMessage,
            retryCount: item.retryCount,
          })),
        ),
        isOpen: true,
        totalCount: updatedCl.totalCount,
        isPrivate: updatedCl.isPrivate,
      }

      // Use Set-based approach to prevent duplicates
      setCollections((prev) => {
        const collectionsMap = new Map()

        // Add existing collections
        prev.forEach((col) => collectionsMap.set(col.id, col))

        // Add/update new collection
        collectionsMap.set(newCollection.id, newCollection)

        return Array.from(collectionsMap.values())
      })

      handleCloseModal()

      // Create detailed success message based on actual upload results
      let description = `Successfully created knowledge base "${collectionName.trim()}"`
      const details = []
      if (totalSuccessful > 0) {
        details.push(
          `${totalSuccessful} file${totalSuccessful !== 1 ? "s" : ""} uploaded`,
        )
      }
      if (totalSkipped > 0) {
        details.push(
          `${totalSkipped} duplicate${totalSkipped !== 1 ? "s" : ""} skipped`,
        )
      }
      if (totalFailed > 0) {
        details.push(`${totalFailed} failed`)
      }

      if (details.length > 0) {
        description += `: ${details.join(", ")}`
      }
      description += "."

      toast.success({
        title: "Knowledge Base Created",
        description,
      })
    } catch (error) {
      console.error("Upload failed:", error)

      // Check if the error is due to cancellation
      if (error instanceof Error && error.name === "AbortError") {
        toast({
          title: "Upload Cancelled",
          description: "File upload was cancelled by user.",
        })
      } else {
        toast.error({
          title: "Upload Failed",
          description: "Failed to create collection. Please try again.",
        })
      }
    } finally {
      finishUpload(uploadId)
    }
  }

  const handleFilesSelect = (files: File[]) => {
    const newFiles: FileUploadSelectedFile[] = files.map((file) => ({
      file,
      id: Math.random().toString(),
      preview: URL.createObjectURL(file),
    }))
    setSelectedFiles((prev) => [...prev, ...newFiles])
  }

  const handleRemoveFile = (id: string) => {
    setSelectedFiles((prev) => prev.filter((f) => f.id !== id))
  }

  const handleRemoveAllFiles = () => {
    setSelectedFiles([])
  }

  const handleOpenAddFilesModal = (
    collection: Collection,
    folder?: FileNode,
  ) => {
    setAddingToCollection(collection)
    setTargetFolder(folder || null)
    setCollectionName(collection.name)
    setShowNewCollection(true)
  }

  const handleAddFilesToCollection = async () => {
    if (!addingToCollection) return

    if (selectedFiles.length === 0) {
      toast.error({
        title: "Upload Error",
        description: "Please select files to upload.",
      })
      return
    }

    // Filter out unsupported files before upload
    const validFiles = getValidFilesOrShowError(selectedFiles)
    if (!validFiles) return

    // Start the global upload progress with only valid files
    const batches = createBatches(validFiles, addingToCollection.name)
    const files = validFiles.map((f) => ({ file: f.file, id: f.id }))
    const { uploadId, abortController } = startUpload(
      addingToCollection.name,
      files,
      batches.length,
      false,
      addingToCollection.id,
    )

    // Close the modal immediately after starting upload
    handleCloseModal()

    try {
      // Upload files in batches
      let totalSuccessful = 0
      let totalSkipped = 0
      let totalFailed = 0
      let processed = 0

      for (let i = 0; i < batches.length; i++) {
        const batchFiles = batches[i].map((f) => ({ file: f.file, id: f.id }))

        // Mark batch files as uploading
        batchFiles.forEach((file) => {
          updateFileStatus(uploadId, file.file.name, file.id, "uploading")
        })

        const uploadedResult = await uploadFileBatch(
          batchFiles.map((f) => f.file),
          addingToCollection.id,
          targetFolder?.id,
          abortController.signal,
        )

        // Update individual file statuses based on results
        if (uploadedResult.results) {
          uploadedResult.results.forEach((result: any, index: number) => {
            const file = batchFiles[index]
            if (result.success) {
              updateFileStatus(uploadId, file.file.name, file.id, "uploaded")
            } else {
              updateFileStatus(
                uploadId,
                file.file.name,
                file.id,
                "failed",
                result.error || "Upload failed",
              )
            }
          })
        } else {
          // Fallback: mark all as uploaded if no individual results available
          batchFiles.forEach((file) => {
            updateFileStatus(uploadId, file.file.name, file.id, "uploaded")
          })
        }

        // Accumulate results from each batch
        if (uploadedResult.summary) {
          totalSuccessful += uploadedResult.summary.successful || 0
          totalSkipped += uploadedResult.summary.skipped || 0
          totalFailed += uploadedResult.summary.failed || 0
        }

        // Update progress
        processed += batchFiles.length
        updateProgress(uploadId, processed, i + 1)
      }

      // Refresh the collection by fetching updated data from backend
      const clResponse = await api.cl[":id"].$get({
        param: { id: addingToCollection.id },
      })
      const updatedCl = await clResponse.json()

      const itemsResponse = await api.cl[":id"].items.$get({
        param: { id: addingToCollection.id },
      })
      const items = await itemsResponse.json()

      setCollections((prev) => {
        const collectionsMap = new Map()

        // Add existing collections
        prev.forEach((col) => collectionsMap.set(col.id, col))

        // Update the specific collection
        const updatedCollection = {
          ...collectionsMap.get(addingToCollection.id),
          files: updatedCl.totalCount || 0,
          items: buildFileTree(
            items.map((item: CollectionItem) => ({
              name: item.name,
              type: item.type as "file" | "folder",
              totalFileCount: item.totalFileCount,
              updatedAt: item.updatedAt,
              id: item.id,
              updatedBy: item.lastUpdatedByEmail || user?.email || "Unknown",
              uploadStatus: item.uploadStatus as UploadStatus,
              statusMessage: item.statusMessage,
              retryCount: item.retryCount,
            })),
          ),
          lastUpdated: new Date(updatedCl.updatedAt).toLocaleString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
          updatedBy: updatedCl.lastUpdatedByEmail || "Unknown",
        }

        collectionsMap.set(addingToCollection.id, updatedCollection)

        return Array.from(collectionsMap.values())
      })
      // Create detailed success message based on actual upload results
      if (totalSuccessful > 0 || totalSkipped > 0) {
        let description = `Successfully processed files for collection "${addingToCollection.name}": `
        const parts = []

        if (totalSuccessful > 0) {
          parts.push(`${totalSuccessful} uploaded`)
        }
        if (totalSkipped > 0) {
          parts.push(
            `${totalSkipped} duplicate${totalSkipped !== 1 ? "s" : ""} skipped`,
          )
        }
        if (totalFailed > 0) {
          parts.push(`${totalFailed} failed`)
        }

        description += parts.join(", ") + "."

        toast.success({
          title: "Files Added",
          description,
        })
      } else if (totalFailed > 0) {
        toast.error({
          title: "Add Files Failed",
          description: `${totalFailed} file${totalFailed !== 1 ? "s" : ""} failed to upload. Please try again.`,
        })
      } else {
        toast.error({
          title: "Add Files Failed",
          description: "Failed to add files to collection. Please try again.",
        })
      }
      handleCloseModal()
    } catch (error) {
      console.error("Add files failed:", error)

      // Check if the error is due to cancellation
      if (error instanceof Error && error.name === "AbortError") {
        toast({
          title: "Upload Cancelled",
          description: "File upload was cancelled by user.",
        })
      } else {
        toast.error({
          title: "Add Files Failed",
          description: "Failed to add files to collection. Please try again.",
        })
      }
    } finally {
      finishUpload(uploadId)
    }
  }

  const handleDeleteItem = async () => {
    if (!deletingItem) return

    try {
      // Find the item to delete based on the path
      const itemToDelete = findItemByPath(
        deletingItem.collection.items,
        deletingItem.path,
      )
      if (itemToDelete) {
        await deleteItem(deletingItem.collection.id, itemToDelete.id)
      }

      // Refresh the collection data from backend
      const clResponse = await api.cl[":id"].$get({
        param: { id: deletingItem.collection.id },
      })
      const updatedCl = await clResponse.json()

      const itemsResponse = await api.cl[":id"].items.$get({
        param: { id: deletingItem.collection.id },
      })
      const items = await itemsResponse.json()

      setCollections((prev) =>
        prev.map((c) => {
          if (c.id === deletingItem.collection.id) {
            return {
              ...c,
              files: updatedCl.totalCount || 0,
              items: buildFileTree(
                items.map((item: CollectionItem) => ({
                  name: item.name,
                  type: item.type as "file" | "folder",
                  totalFileCount: item.totalFileCount,
                  updatedAt: item.updatedAt,
                  id: item.id,
                  updatedBy:
                    item.lastUpdatedByEmail || user?.email || "Unknown",
                  uploadStatus: item.uploadStatus as UploadStatus,
                  statusMessage: item.statusMessage,
                  retryCount: item.retryCount,
                })),
              ),
              lastUpdated: new Date(updatedCl.updatedAt).toLocaleString(
                "en-GB",
                {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                },
              ),
            }
          }
          return c
        }),
      )

      toast.success({
        title: "Item Deleted",
        description: `Successfully deleted "${deletingItem.node.name}".`,
      })
    } catch (error) {
      console.error("Delete failed:", error)
      toast.error({
        title: "Delete Failed",
        description: "Failed to delete item. Please try again.",
      })
    } finally {
      setDeletingItem(null)
    }
  }

  const handleEditCollection = (collection: Collection) => {
    setEditingCollection(collection)
    setCollectionName(collection.name)
  }

  const handleUpdateCollection = async () => {
    if (!editingCollection || !collectionName.trim()) return

    try {
      const response = await api.cl[":id"].$put({
        param: { id: editingCollection.id },
        json: { name: collectionName.trim() },
      })

      if (response.ok) {
        const updatedCl = await response.json()

        // Use Map-based approach to prevent duplicates during update
        setCollections((prev) => {
          const collectionsMap = new Map()

          // Add existing collections
          prev.forEach((col) => collectionsMap.set(col.id, col))

          // Update the specific collection
          const existingCollection = collectionsMap.get(editingCollection.id)
          if (existingCollection) {
            collectionsMap.set(editingCollection.id, {
              ...existingCollection,
              name: updatedCl.name,
              lastUpdated: new Date(updatedCl.updatedAt).toLocaleString(
                "en-GB",
                {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                },
              ),
            })
          }

          return Array.from(collectionsMap.values())
        })

        setEditingCollection(null)
        setCollectionName("")
        toast.success({
          title: "Collection Updated",
          description: "Successfully updated collection name.",
        })
      } else {
        const errorText = await response.text()
        toast.error({
          title: "Update Failed",
          description: `Failed to update collection name: ${errorText}`,
        })
      }
    } catch (error) {
      console.error("Update failed:", error)
      toast.error({
        title: "Update Failed",
        description: "Failed to update collection name.",
      })
    }
  }

  const handleDeleteCollection = async () => {
    if (!deletingCollection) return

    try {
      // Delete the collection
      await deleteCollection(deletingCollection.id)

      // Remove from state
      setCollections((prev) =>
        prev.filter((c) => c.id !== deletingCollection.id),
      )
      setDeletingCollection(null)
      toast.success({
        title: "Collection Deleted",
        description:
          "Successfully deleted collection and all associated files.",
      })
    } catch (error) {
      console.error("Delete failed:", error)
      toast.error({
        title: "Delete Failed",
        description: "Failed to delete collection. Please try again.",
      })
    }
  }

  const handleFileClick = async (file: FileNode, collection: Collection) => {
    // Handle .docx, .pdf, and .md files
    const fileName = file.name.toLowerCase()
    if (
      file.type !== "file" ||
      (!fileName.endsWith(".docx") &&
        !fileName.endsWith(".pdf") &&
        !fileName.endsWith(".md") &&
        !fileName.endsWith(".csv") &&
        !fileName.endsWith(".xlsx") &&
        !fileName.endsWith(".xls") &&
        !fileName.endsWith(".text") &&
        !fileName.endsWith(".txt") &&
        !fileName.endsWith(".tsv"))
    ) {
      toast.warning({
        title: "Preview Not Available",
        description:
          "Preview is only available for .docx, .pdf, .csv, .xlsx, .xls,.txt,.tsv and .md files.",
      })
      return
    }

    setIsFileTreeCollapsed(true)

    // Don't reload if it's the same file
    if (selectedDocument && selectedDocument.file.id === file.id) {
      return
    }

    // Prevent rapid double-clicks by checking if already loading
    if (loadingDocument) {
      return
    }

    setLoadingDocument(true)

    // Clear current document first to prevent issues with previous content
    setSelectedDocument(null)

    try {
      // First check if the file supports preview
      const previewResponse = await authFetch(
        `/api/v1/cl/${collection.id}/files/${file.id}/preview`,
        {
          method: "GET",
          credentials: "include",
        },
      )

      if (!previewResponse.ok) {
        let errorMessage = "Failed to preview file download the file instead."
        try {
          const errorData = await previewResponse.json()
          errorMessage = errorData.message || errorMessage
        } catch {
          // If JSON parsing fails, try to get text
          try {
            errorMessage = await previewResponse.text()
          } catch {
            // If both fail, use default message
          }
        }
        toast.warning({
          title: "Preview Not Available",
          description: errorMessage,
        })
        return
      }

      // If preview is supported, fetch the file content with cache-busting
      const contentResponse = await authFetch(
        `/api/v1/cl/${collection.id}/files/${file.id}/content`,
        {
          method: "GET",
          credentials: "include",
          headers: {
            Accept: fileName.endsWith(".md")
              ? "text/plain, text/markdown"
              : "application/octet-stream",
          },
        },
      )

      if (!contentResponse.ok) {
        let errorMessage = "Failed to fetch document"
        try {
          // Try to get detailed error message from response
          const errorData = await contentResponse.json()
          errorMessage =
            errorData.message ||
            `${errorMessage}: ${contentResponse.statusText}`
        } catch {
          // If JSON parsing fails, use status text
          errorMessage = `${errorMessage}: ${contentResponse.statusText}`
        }

        toast.error({
          title: "Document Error",
          description: errorMessage,
        })
        throw new Error(errorMessage)
      }

      const blob = await contentResponse.blob()

      // Set the document after successful loading
      setSelectedDocument({
        file,
        collection,
        content: blob,
      })
    } catch (error) {
      console.error("Error loading document:", error)
      // Only show error if this request is still active
      if (loadingDocument) {
        toast.error({
          title: "Error",
          description: "Failed to load document",
        })
      }
    } finally {
      setLoadingDocument(false)
    }
  }

  const handleDownload = async (file: FileNode, collection: Collection) => {
    if (file.type !== "file") return

    try {
      // Use hidden iframe approach to trigger download without opening new tab
      // This preserves authentication cookies and lets the browser handle the download directly
      const downloadUrl = `/api/v1/cl/${collection.id}/files/${file.id}/download`

      // Create a hidden iframe to trigger the download
      const iframe = document.createElement("iframe")
      iframe.style.display = "none"
      iframe.src = downloadUrl

      document.body.appendChild(iframe)

      // Clean up iframe after a short delay
      setTimeout(() => {
        if (iframe.parentNode) {
          document.body.removeChild(iframe)
        }
      }, 1000)

      toast.success({
        title: "Download Started",
        description: `"${file.name}" download started.`,
      })
    } catch (error) {
      console.error("Error downloading file:", error)
      toast.error({
        title: "Download Failed",
        description: "Failed to download file",
      })
    }
  }

  // Chat management functions
  const handleChatCreated = useCallback(
    (chatId: string) => {
      if (
        selectedDocument &&
        selectedDocument.file.id &&
        currentInitialChatId
      ) {
        // Store the mapping from documentId to tempChatId
        documentToTempChatMap.set(
          selectedDocument.file.id,
          currentInitialChatId,
        )
      }
    },
    [selectedDocument, currentInitialChatId],
  )

  const loadChatForDocument = useCallback(async (documentId: string) => {
    const existingTempChatId = documentToTempChatMap.get(documentId)

    if (existingTempChatId) {
      // We have an existing tempChatId for this document
      setCurrentInitialChatId(existingTempChatId)
    } else {
      // No existing chat, generate a new tempChatId for new chat
      const newTempChatId = generateUUID()
      setCurrentInitialChatId(newTempChatId)
      documentToTempChatMap.set(documentId, newTempChatId)
    }
  }, [])

  // Reset chat state when document changes
  useEffect(() => {
    if (selectedDocument && selectedDocument.file.id) {
      setCurrentSheetIndex(0)
      loadChatForDocument(selectedDocument.file.id)
    }
  }, [selectedDocument?.file.id, loadChatForDocument, setCurrentSheetIndex])

  const handleBackToCollections = () => {
    setSelectedDocument(null)
    setCurrentInitialChatId(null)
    setIsFileTreeCollapsed(true) // Reset file tree state when going back
    setIsChatOverlayOpen(false) // Reset chat overlay state when going back
  }

  // Handle chunk index changes from DocumentChat
  const handleChunkIndexChange = async (
    newChunkIndex: number | null,
    documentId: string,
    docId: string,
  ) => {
    if (!documentId) {
      console.error("handleChunkIndexChange called without documentId")
      return
    }

    if (newChunkIndex !== null && selectedDocument?.file.id === documentId) {
      try {
        const chunkContentResponse = await api.chunk[":cId"].files[
          ":docId"
        ].content.$get({
          param: { cId: newChunkIndex.toString(), docId: docId },
        })

        if (!chunkContentResponse.ok) {
          console.error(
            "Failed to fetch chunk content:",
            chunkContentResponse.status,
          )
          toast.error({
            title: "Error",
            description: "Failed to load chunk content",
          })
          return
        }

        const chunkContent = await chunkContentResponse.json()

        // Ensure we are still on the same document before mutating UI
        if (selectedDocument?.file.id !== documentId) {
          return
        }

        if (chunkContent && chunkContent.chunkContent) {
          if (documentOperationsRef?.current?.clearHighlights) {
            documentOperationsRef.current.clearHighlights()
          }

          if (documentOperationsRef?.current?.highlightText) {
            try {
              await documentOperationsRef.current.highlightText(
                chunkContent.chunkContent,
                newChunkIndex,
                chunkContent.pageIndex,
              )
            } catch (error) {
              console.error(
                "Error highlighting chunk text:",
                chunkContent.chunkContent,
                error,
              )
            }
          }
        }
      } catch (error) {
        console.error("Error in handleChunkIndexChange:", error)
        toast.error({
          title: "Error",
          description: "Failed to process chunk navigation",
        })
      }
    }
  }

  // Handle Vespa data modal opening
  const handleViewVespaData = () => {
    setIsVespaModalOpen(true)
  }

  // Derive the current upload status from collections state
  const currentUploadStatus = useMemo(() => {
    if (!selectedDocument) return undefined

    const currentCollection = collections.find(
      (c) => c.id === selectedDocument.collection.id,
    )

    if (!currentCollection) return undefined

    // Iteratively find the file's current status
    const stack: FileNode[] = [...currentCollection.items]
    while (stack.length > 0) {
      const item = stack.pop()
      if (!item) continue

      if (item.id === selectedDocument.file.id) {
        return item.uploadStatus
      }

      if (item.children) {
        stack.push(...item.children)
      }
    }

    return undefined
  }, [selectedDocument, collections])

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-white dark:bg-[#1E1E1E]">
      <Sidebar
        photoLink={user?.photoLink}
        role={user?.role}
        isAgentMode={agentWhiteList}
      />
      <div className="flex-1 flex flex-col h-full md:ml-[52px] ml-0">
        {selectedDocument ? (
          // Document viewer layout with flex column
          <div className="flex flex-col h-full lg:flex-row">
            {/* Top section - File tree and Document viewer */}
            <div className="flex flex-1 h-full overflow-hidden">
              {/* Center pane - Document viewer (scrollable) */}
              <div
                className={`flex-1 flex flex-col bg-white h-full overflow-hidden min-w-0 ${isChatHidden ? "" : "max-w-[calc(100vw-652px)]"}`}
              >
                {/* Document header (sticky) */}
                <div className="h-12 bg-white dark:bg-[#1E1E1E] flex items-center px-6 border-b border-gray-200 dark:border-gray-700 sticky top-0 z-10">
                  <div className="flex items-center gap-4">
                    <Button
                      onClick={handleBackToCollections}
                      variant="ghost"
                      size="sm"
                      className="flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 px-2 py-1 h-auto"
                    >
                      <ArrowLeft size={16} />
                    </Button>
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
                        {selectedDocument.file.name}
                      </span>
                    </div>
                  </div>
                  <div className="ml-auto flex items-center">
                    {(user?.role === UserRole.Admin ||
                      user?.role === UserRole.SuperAdmin) && (
                      <Button
                        onClick={handleViewVespaData}
                        variant="ghost"
                        size="sm"
                        className="flex items-center gap-6 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 px-2 py-1 h-auto border-2"
                      >
                        Raw view
                      </Button>
                    )}
                    <Button
                      onClick={() =>
                        setIsFileTreeCollapsed(!isFileTreeCollapsed)
                      }
                      variant="ghost"
                      size="sm"
                      className="flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 px-2 py-1 h-auto"
                      title={
                        isFileTreeCollapsed
                          ? "Show file tree"
                          : "Hide file tree"
                      }
                    >
                      {isFileTreeCollapsed ? (
                        <PanelLeftOpen className="z-50" size={16} />
                      ) : (
                        <PanelLeftClose className="z-50" size={16} />
                      )}
                    </Button>
                  </div>
                </div>

                {/* Document content (scrollable) */}
                <div className="flex-1 overflow-auto">
                  <DocumentViewerContainer
                    selectedDocument={selectedDocument}
                    loadingDocument={loadingDocument}
                    setCurrentSheetIndex={setCurrentSheetIndex}
                  />
                </div>
              </div>

              {/* Right pane - Chat component (fixed width, no scroll) */}
              {!isChatHidden ? (
                <div className="w-[600px] min-w-[600px] max-w-[600px] flex-shrink-0 flex flex-col bg-white dark:bg-[#1E1E1E] border-l border-gray-200 dark:border-gray-700 h-full">
                  <DocumentChat
                    key={currentInitialChatId}
                    user={user}
                    documentId={selectedDocument.file.id || ""}
                    documentName={selectedDocument.file.name}
                    initialChatId={currentInitialChatId}
                    onChatCreated={handleChatCreated}
                    onChunkIndexChange={handleChunkIndexChange}
                    uploadStatus={currentUploadStatus}
                    isKnowledgeBaseChat={true}
                  />
                </div>
              ) : (
                /* Chat overlay toggle button when hidden */
                <div className="fixed bottom-4 right-4 z-40 transform -translate-y-1/2">
                  <Button
                    onClick={() => setIsChatOverlayOpen(true)}
                    className="bg-red-500 hover:bg-red-600 text-white rounded-full p-3 shadow-lg transition-all duration-200 hover:scale-105 hover:animate-none"
                    title="Open chat overlay"
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                  </Button>
                </div>
              )}
            </div>

            {/* Chat overlay when isChatHidden is true */}
            {isChatHidden && isChatOverlayOpen && (
              <div className="fixed inset-0 z-50 flex justify-end">
                {/* Backdrop */}
                <div
                  className="absolute inset-0 bg-black bg-opacity-30"
                  onClick={() => setIsChatOverlayOpen(false)}
                />

                {/* Chat overlay panel */}
                <div className="relative bg-white dark:bg-[#1E1E1E] w-[50%] max-w-[90vw] h-full shadow-2xl transform transition-transform duration-300 ease-in-out">
                  {/* Close button */}
                  <div className="absolute top-2 right-4 z-10">
                    <Button
                      onClick={() => setIsChatOverlayOpen(false)}
                      variant="ghost"
                      size="sm"
                      className="rounded-full p-2 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors"
                      title="Close chat"
                    >
                      <X size={16} />
                    </Button>
                  </div>

                  {/* Chat component */}
                  <div className="h-full">
                    <DocumentChat
                      key={currentInitialChatId}
                      user={user}
                      documentId={selectedDocument.file.id || ""}
                      documentName={selectedDocument.file.name}
                      initialChatId={currentInitialChatId}
                      onChatCreated={handleChatCreated}
                      onChunkIndexChange={handleChunkIndexChange}
                      uploadStatus={currentUploadStatus}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* File tree overlay */}
            {!isFileTreeCollapsed && (
              <div className="fixed inset-0 bg-black bg-opacity-50 z-40 flex">
                <div className="bg-gray-100 flex flex-col border-r border-gray-200 w-[30%] max-w-[400px] min-w-[250px] dark:bg-[#1E1E1E] dark:border-gray-700 lg:w-[300px] lg:min-w-[250px] lg:max-w-[400px] h-64 lg:h-full">
                  {/* Collection Header */}
                  <div className="px-4 py-4 h-12 bg-gray-50 dark:bg-[#1E1E1E] flex items-center justify-between sticky top-0 z-20">
                    <h2 className="text-sm font-bold font-mono text-gray-400 dark:text-gray-500 uppercase tracking-wider truncate">
                      {selectedDocument.collection.name}
                    </h2>
                    <Button
                      onClick={() => setIsFileTreeCollapsed(true)}
                      variant="ghost"
                      size="sm"
                      className="p-1 rounded-full text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors"
                    >
                      <X size={16} />
                    </Button>
                  </div>

                  {/* File tree */}
                  <div className="flex-1 overflow-y-auto">
                    <SimpleFileTree
                      items={selectedDocument.collection.items}
                      collection={selectedDocument.collection}
                      onFileClick={(file) => {
                        handleFileClick(file, selectedDocument.collection)
                      }}
                      selectedFile={selectedDocument.file}
                      onToggle={async (node) => {
                        if (node.type !== "folder") return

                        const updatedCollections = [...collections]
                        const coll = updatedCollections.find(
                          (c) => c.id === selectedDocument.collection.id,
                        )
                        if (coll) {
                          const toggleNode = async (
                            nodes: FileNode[],
                          ): Promise<FileNode[]> => {
                            const updatedNodes = [...nodes]
                            for (let i = 0; i < updatedNodes.length; i++) {
                              const n = updatedNodes[i]
                              if (n === node) {
                                n.isOpen = !n.isOpen

                                if (n.isOpen && n.id) {
                                  try {
                                    const response = await api.cl[
                                      ":id"
                                    ].items.$get({
                                      param: {
                                        id: selectedDocument.collection.id,
                                      },
                                      query: { parentId: n.id },
                                    })
                                    if (response.ok) {
                                      const items = await response.json()

                                      n.children = items.map(
                                        (item: CollectionItem) => ({
                                          id: item.id,
                                          name: item.name,
                                          type: item.type as "file" | "folder",
                                          lastUpdated: item.updatedAt,
                                          updatedBy:
                                            item.lastUpdatedByEmail ||
                                            user?.email ||
                                            "Unknown",
                                          uploadStatus:
                                            item.uploadStatus as UploadStatus,
                                          statusMessage: item.statusMessage,
                                          retryCount: item.retryCount,
                                          isOpen: false,
                                          children:
                                            item.type === "folder"
                                              ? []
                                              : undefined,
                                        }),
                                      )
                                    }
                                  } catch (error) {
                                    console.error(
                                      `Failed to fetch folder contents for ${n.name}:`,
                                      error,
                                    )
                                    toast.error({
                                      title: "Error",
                                      description: `Failed to load folder contents`,
                                    })
                                  }
                                }
                              } else if (n.children) {
                                n.children = await toggleNode(n.children)
                              }
                            }
                            return updatedNodes
                          }

                          coll.items = await toggleNode(coll.items)
                          setCollections(updatedCollections)

                          // Update the selected document's collection items
                          setSelectedDocument((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  collection: {
                                    ...prev.collection,
                                    items: coll.items,
                                  },
                                }
                              : null,
                          )
                        }
                      }}
                    />
                  </div>
                </div>
                {/* Click outside to close */}
                <div
                  className="flex-1"
                  onClick={() => setIsFileTreeCollapsed(true)}
                />
              </div>
            )}
          </div>
        ) : (
          // Collections list view
          <div className="p-4 md:py-4 md:px-8">
            <div className="w-full max-w-7xl mx-auto">
              <div className="flex justify-between items-center mt-6">
                <h1 className="text-[32px] font-display text-gray-700 dark:text-gray-100 tracking-wider">
                  KNOWLEDGE MANAGEMENT
                </h1>
                {(collections.length > 0 || isUploading) && (
                  <div className="flex items-center gap-4">
                    {/* <Search className="text-gray-400 dark:text-gray-500 h-6 w-6" /> */}
                    <Button
                      onClick={() => setShowNewCollection(true)}
                      disabled={isUploading}
                      className="bg-slate-800 hover:bg-slate-700 dark:bg-[#2d2d2d] dark:hover:bg-[#404040] text-white rounded-full px-4 py-2 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Plus size={16} />
                      <span className="font-mono text-[12px] font-medium">
                        NEW COLLECTION
                      </span>
                    </Button>
                  </div>
                )}
              </div>

              {loadingCollections ? (
                // Loading state
                <div className="flex flex-col items-center justify-center min-h-[70vh]">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-600 dark:border-gray-300 mb-4"></div>
                  <p className="text-gray-600 dark:text-gray-300">
                    Loading collections...
                  </p>
                </div>
              ) : collections.length === 0 && !isUploading ? (
                // Empty state - centered layout
                <div className="flex flex-col items-center justify-center min-h-[70vh]">
                  <img
                    src={kbEmptyStateIcon}
                    alt="No collections"
                    className="w-32 h-32 mb-6 opacity-60"
                  />
                  <h2 className="text-xl font-semibold text-gray-700 dark:text-gray-300 mb-2">
                    No collections available yet
                  </h2>
                  <p className="text-gray-500 dark:text-gray-400 mb-8 text-center ">
                    Add your first collection to structure and manage
                    information
                  </p>
                  <Button
                    onClick={() => setShowNewCollection(true)}
                    disabled={isUploading}
                    className="bg-slate-800 hover:bg-slate-700 dark:bg-[#2d2d2d] dark:hover:bg-[#404040] text-white rounded-full px-6 py-3 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Plus size={16} />
                    <span className="font-mono text-[12px] font-medium">
                      ADD COLLECTION
                    </span>
                  </Button>
                </div>
              ) : (
                <div className="mt-12">
                  {/* Show skeleton loader when uploading to NEW collection */}
                  {isUploading &&
                    batchProgress.total > 0 &&
                    isNewCollectionUpload && (
                      <div className="mb-8">
                        <div className="flex justify-between items-center mb-4">
                          <div className="flex items-center gap-2">
                            <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-200">
                              {uploadingCollectionName}
                            </h2>
                            <span className="text-sm text-gray-500 dark:text-gray-400">
                              uploading files...
                            </span>
                          </div>
                          <div className="text-sm text-gray-600 dark:text-gray-400">
                            {batchProgress.current} / {batchProgress.total}{" "}
                            files processed
                          </div>
                        </div>
                        <FileUploadSkeleton
                          totalFiles={batchProgress.total}
                          processedFiles={batchProgress.current}
                          currentBatch={batchProgress.batch}
                          totalBatches={batchProgress.totalBatches}
                          showHeaders={true}
                        />
                      </div>
                    )}

                  {collections.map((collection) => (
                    <div key={collection.id} className="mb-8">
                      <div
                        className="sticky mb-2 cursor-pointer top-0 bg-white dark:bg-[#1E1E1E] py-1"
                        onClick={async () => {
                          const updatedCollections = [...collections]
                          const coll = updatedCollections.find(
                            (c) => c.id === collection.id,
                          )
                          if (coll) {
                            coll.isOpen = !coll.isOpen
                            if (coll.isOpen) {
                              const response = await api.cl[":id"].items.$get({
                                param: { id: collection.id },
                              })
                              const data = await response.json()
                              coll.items = buildFileTree(
                                data.map((item: CollectionItem) => ({
                                  name: item.name,
                                  type: item.type as "file" | "folder",
                                  totalFileCount: item.totalFileCount,
                                  updatedAt: item.updatedAt,
                                  id: item.id,
                                  updatedBy:
                                    item.lastUpdatedByEmail ||
                                    user?.email ||
                                    "Unknown",
                                  uploadStatus:
                                    item.uploadStatus as UploadStatus,
                                  statusMessage: item.statusMessage,
                                  retryCount: item.retryCount,
                                })),
                              )
                            } else {
                              // coll.items = []; // This would clear the items, maybe not desired
                            }
                            setCollections(updatedCollections)
                          }
                        }}
                      >
                        <div className="absolute left-[-24px] top-1/2 transform -translate-y-1/2">
                          {collection.isOpen ? (
                            <ChevronDown
                              size={16}
                              className="text-gray-600 dark:text-gray-400"
                            />
                          ) : (
                            <ChevronRight
                              size={16}
                              className="text-gray-600 dark:text-gray-400"
                            />
                          )}
                        </div>

                        {/* Collection header aligned with table grid */}
                        <div className="grid grid-cols-12 gap-4 items-center">
                          <div className="col-span-5">
                            <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">
                              {collection.name}
                            </h2>
                          </div>
                          <div className="col-span-7 flex justify-end items-center gap-4">
                            <Plus
                              size={16}
                              className={`cursor-pointer text-gray-600 dark:text-gray-400 ${isUploading ? "opacity-50 cursor-not-allowed" : ""}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                !isUploading &&
                                  handleOpenAddFilesModal(collection)
                              }}
                            />
                            <DropdownMenu
                              open={openDropdown === collection.id}
                              onOpenChange={(open) =>
                                setOpenDropdown(open ? collection.id : null)
                              }
                            >
                              <DropdownMenuTrigger asChild>
                                <MoreHorizontal
                                  size={16}
                                  className={`cursor-pointer text-gray-600 dark:text-gray-400 ${isUploading ? "opacity-50 cursor-not-allowed" : ""}`}
                                  onClick={(e) => e.stopPropagation()}
                                />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent>
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    !isUploading &&
                                      handleEditCollection(collection)
                                  }}
                                  disabled={isUploading}
                                >
                                  <Edit className="mr-2 h-4 w-4" />
                                  <span>Edit</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    if (!isUploading) {
                                      setDeletingCollection(collection)
                                      setOpenDropdown(null)
                                    }
                                  }}
                                  disabled={isUploading}
                                >
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  <span>Delete</span>
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </div>
                      </div>
                      {collection.isOpen && (
                        <>
                          <div className="grid grid-cols-12 gap-4 text-sm font-mono text-gray-500 dark:text-gray-400 pb-2 border-b border-gray-200 dark:border-gray-700">
                            <div className="col-span-5">FOLDER</div>
                            <div className="col-span-2"></div>
                            <div className="col-span-1 text-center">FILES</div>
                            <div className="col-span-2">LAST UPDATED</div>
                            <div className="col-span-2">UPDATED&nbsp;BY</div>
                          </div>
                          <FileTree
                            items={collection.items}
                            onFileClick={(file: FileNode) =>
                              handleFileClick(file, collection)
                            }
                            onDownload={(file: FileNode, path: string) =>
                              handleDownload(file, collection)
                            }
                            onAddFiles={(node, path) => {
                              const collection = collections.find((c) =>
                                c.items.some((item) => findNode(item, node)),
                              )
                              if (collection) {
                                handleOpenAddFilesModal(collection, node)
                              }
                            }}
                            onDelete={(node, path) => {
                              const collection = collections.find((c) =>
                                c.items.some((item) => findNode(item, node)),
                              )
                              if (collection) {
                                if (
                                  node.type === "folder" &&
                                  node.name === collection.name
                                ) {
                                  setDeletingCollection(collection)
                                } else {
                                  setDeletingItem({ collection, node, path })
                                }
                              }
                            }}
                            onRetry={(node, path) => {
                              // TODO: Implement retry logic here
                            }}
                            onToggle={async (node) => {
                              if (node.type !== "folder") return

                              const updatedCollections = [...collections]
                              const coll = updatedCollections.find(
                                (c) => c.id === collection.id,
                              )
                              if (coll) {
                                // Toggle the folder state
                                const toggleNode = async (
                                  nodes: FileNode[],
                                ): Promise<FileNode[]> => {
                                  const updatedNodes = [...nodes]
                                  for (
                                    let i = 0;
                                    i < updatedNodes.length;
                                    i++
                                  ) {
                                    const n = updatedNodes[i]
                                    if (n === node) {
                                      n.isOpen = !n.isOpen

                                      // If opening the folder and it has an ID, fetch its contents
                                      if (n.isOpen && n.id) {
                                        try {
                                          const response = await api.cl[
                                            ":id"
                                          ].items.$get({
                                            param: { id: collection.id },
                                            query: { parentId: n.id },
                                          })
                                          if (response.ok) {
                                            const items = await response.json()

                                            // Build the children structure
                                            n.children = items.map(
                                              (item: CollectionItem) => ({
                                                id: item.id,
                                                name: item.name,
                                                type: item.type as
                                                  | "file"
                                                  | "folder",
                                                files: item.totalFileCount,
                                                lastUpdated: item.updatedAt,
                                                updatedBy:
                                                  item.lastUpdatedByEmail ||
                                                  user?.email ||
                                                  "Unknown",
                                                uploadStatus:
                                                  item.uploadStatus as UploadStatus,
                                                statusMessage:
                                                  item.statusMessage,
                                                retryCount: item.retryCount,
                                                isOpen: false,
                                                children:
                                                  item.type === "folder"
                                                    ? []
                                                    : undefined,
                                              }),
                                            )
                                          }
                                        } catch (error) {
                                          console.error(
                                            `Failed to fetch folder contents for ${n.name}:`,
                                            error,
                                          )
                                          toast.error({
                                            title: "Error",
                                            description: `Failed to load folder contents`,
                                          })
                                        }
                                      } else if (!n.isOpen) {
                                        // Optionally clear children when closing
                                        // n.children = [];
                                      }
                                    } else if (n.children) {
                                      n.children = await toggleNode(n.children)
                                    }
                                  }
                                  return updatedNodes
                                }

                                coll.items = await toggleNode(coll.items)
                                setCollections(updatedCollections)
                              }
                            }}
                          />
                          {/* Show skeleton for existing collection uploads */}
                          {isUploading &&
                            !isNewCollectionUpload &&
                            targetCollectionId === collection.id &&
                            batchProgress.total > 0 && (
                              <FileUploadSkeleton
                                totalFiles={batchProgress.total}
                                processedFiles={batchProgress.current}
                                currentBatch={batchProgress.batch}
                                totalBatches={batchProgress.totalBatches}
                                showHeaders={false}
                              />
                            )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {deletingCollection && (
        <ConfirmModal
          showModal={!!deletingCollection}
          setShowModal={(val) => {
            if (!val.open) {
              setDeletingCollection(null)
            }
          }}
          modalTitle="Delete Collection"
          modalMessage={`Are you sure you want to delete the collection "${deletingCollection.name}"? This action cannot be undone.`}
          onConfirm={handleDeleteCollection}
        />
      )}
      {deletingItem && (
        <ConfirmModal
          showModal={!!deletingItem}
          setShowModal={(val) => {
            if (!val.open) {
              setDeletingItem(null)
            }
          }}
          modalTitle={`Delete ${deletingItem.node.type}`}
          modalMessage={`Are you sure you want to delete "${deletingItem.node.name}"? This action cannot be undone.`}
          onConfirm={handleDeleteItem}
        />
      )}
      {editingCollection && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-100 dark:bg-gray-700 rounded-2xl w-[90%] max-w-md max-h-[90vh] overflow-hidden flex flex-col p-2">
            <div className="pb-1">
              <div className="flex justify-between items-center">
                <h2 className="pl-2 font-medium text-gray-400 dark:text-gray-200 font-mono">
                  EDIT COLLECTION NAME
                </h2>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditingCollection(null)
                    setCollectionName("")
                  }}
                  className="p-1"
                >
                  <X className="h-5 w-5 text-gray-400" />
                </Button>
              </div>
            </div>
            <div className="overflow-y-auto flex-1">
              <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-6 bg-white dark:bg-gray-800">
                <div className="mb-6">
                  <label
                    htmlFor="editCollectionName"
                    className="block text-sm text-gray-700 dark:text-gray-300 mb-2"
                  >
                    Collection title
                  </label>
                  <Input
                    id="editCollectionName"
                    type="text"
                    placeholder="Enter collection title"
                    value={collectionName}
                    onChange={(e) => setCollectionName(e.target.value)}
                    className="w-full text-xl placeholder:text-gray-400 placeholder:opacity-60 dark:placeholder:text-gray-500 dark:placeholder:opacity-50 !outline-none !focus:outline-none !focus:ring-0 !focus:shadow-none !bg-transparent !px-0 !shadow-none !ring-0 border-0 border-b border-gray-300 dark:border-gray-600 focus:border-b focus:border-gray-400 dark:focus:border-gray-500 !rounded-none"
                    autoComplete="off"
                  />
                  <div className="h-2 mt-1">
                    {collections.some(
                      (c) =>
                        c.name.toLowerCase() ===
                          collectionName.trim().toLowerCase() &&
                        c.id !== editingCollection?.id,
                    ) && (
                      <p className="text-sm text-gray-500">
                        Collection name already exists
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex justify-end gap-4 mt-4">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditingCollection(null)
                      setCollectionName("")
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleUpdateCollection}
                    disabled={
                      !collectionName.trim() ||
                      collections.some(
                        (c) =>
                          c.name.toLowerCase() ===
                            collectionName.trim().toLowerCase() &&
                          c.id !== editingCollection?.id,
                      )
                    }
                  >
                    Update
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {(showNewCollection || addingToCollection) && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-end pt-24 pr-24 z-50">
          <div className="bg-gray-100 dark:bg-gray-700 rounded-2xl w-[90%] max-w-2xl max-h-[90vh] overflow-hidden flex flex-col p-2">
            <div className="pb-1">
              <div className="flex justify-between items-center">
                <h2 className="pl-2  font-medium text-gray-400 dark:text-gray-200 font-mono">
                  {addingToCollection
                    ? `Add files to ${addingToCollection.name}${targetFolder ? ` / ${targetFolder.name}` : ""}`
                    : "CREATE NEW COLLECTION"}
                </h2>
                <Button
                  variant="ghost"
                  onClick={handleCloseModal}
                  className="p-1"
                >
                  <X className="h-5 w-5 text-gray-400" />
                </Button>
              </div>
            </div>
            <div className="overflow-y-auto flex-1">
              <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-6 bg-white dark:bg-gray-800">
                <div className="mb-6">
                  <label
                    htmlFor="collectionName"
                    className="block text-sm text-gray-700 dark:text-gray-300 mb-2"
                  >
                    {addingToCollection
                      ? "Adding to collection"
                      : "Collection name"}
                  </label>
                  <Input
                    id="collectionName"
                    type="text"
                    placeholder="Enter collection name"
                    value={collectionName}
                    onChange={(e) => setCollectionName(e.target.value)}
                    className="w-full text-xl placeholder:text-gray-400 placeholder:opacity-60 dark:placeholder:text-gray-500 dark:placeholder:opacity-50 !outline-none !focus:outline-none !focus:ring-0 !focus:shadow-none !bg-transparent !px-0 !shadow-none !ring-0 border-0 border-b border-gray-300 dark:border-gray-600 focus:border-b focus:border-gray-400 dark:focus:border-gray-500 !rounded-none"
                    disabled={isUploading || !!addingToCollection}
                    autoComplete="off"
                  />
                  <div className="h-2 mt-1">
                    {collections.some(
                      (c) =>
                        c.name.toLowerCase() ===
                          collectionName.trim().toLowerCase() &&
                        !addingToCollection,
                    ) && (
                      <p className="text-sm text-gray-500">
                        Collection name already exists
                      </p>
                    )}
                  </div>
                </div>
                <CollectionFileUpload
                  onFilesSelect={handleFilesSelect}
                  onRemoveFile={handleRemoveFile}
                  onRemoveAllFiles={handleRemoveAllFiles}
                  selectedFiles={selectedFiles}
                  onUpload={
                    addingToCollection
                      ? handleAddFilesToCollection
                      : handleUpload
                  }
                  isUploading={isUploading}
                  collectionName={collectionName}
                  batchProgress={batchProgress}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Debug Document Modal */}
      <DebugDocModal
        documentId={selectedDocument?.file.id || null}
        documentName={selectedDocument?.file.name || null}
        isOpen={isVespaModalOpen}
        onClose={() => setIsVespaModalOpen(false)}
        currentSheetIndex={currentSheetIndex}
      />
    </div>
  )
}

function findNode(root: FileNode, target: FileNode): boolean {
  if (root === target) {
    return true
  }
  if (root.children) {
    for (const child of root.children) {
      if (findNode(child, target)) {
        return true
      }
    }
  }
  return false
}

function findItemByPath(items: FileNode[], targetPath: string): any | null {
  const findInNodes = (nodes: FileNode[], currentPath: string): any | null => {
    for (const node of nodes) {
      const nodePath = currentPath ? `${currentPath}/${node.name}` : node.name
      if (nodePath === targetPath) {
        return node
      }
      if (node.children) {
        const found = findInNodes(node.children, nodePath)
        if (found) return found
      }
    }
    return null
  }

  return findInNodes(items, "")
}

const estimateFormDataSize = (
  files: File[],
  collectionName: string,
): number => {
  let size = 0
  size += new TextEncoder().encode(collectionName).length + 100
  files.forEach((file) => {
    size += file.size
    size += file.name.length * 2
    size += 200
  })
  return size
}

const createBatches = (
  files: FileUploadSelectedFile[],
  collectionName: string,
): FileUploadSelectedFile[][] => {
  const BATCH_CONFIG = {
    MAX_PAYLOAD_SIZE: 5 * 1024 * 1024,
    MAX_FILES_PER_BATCH: 5,
  }
  const batches: FileUploadSelectedFile[][] = []
  let currentBatch: FileUploadSelectedFile[] = []
  let currentBatchSize = 0

  const baseOverhead = estimateFormDataSize([], collectionName)

  for (const selectedFile of files) {
    const fileOverhead =
      selectedFile.file.size + selectedFile.file.name.length * 2 + 200
    const newBatchSize = currentBatchSize + fileOverhead

    if (
      currentBatch.length > 0 &&
      (baseOverhead + newBatchSize > BATCH_CONFIG.MAX_PAYLOAD_SIZE ||
        currentBatch.length >= BATCH_CONFIG.MAX_FILES_PER_BATCH)
    ) {
      batches.push([...currentBatch])
      currentBatch = [selectedFile]
      currentBatchSize = fileOverhead
    } else {
      currentBatch.push(selectedFile)
      currentBatchSize = newBatchSize
    }
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch)
  }

  return batches
}
