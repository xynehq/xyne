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
import type {
  Collection as CollectionType,
  CollectionItem,
} from "@/types/knowledgeBase"
import { api } from "@/api"
import DocxViewer from "@/components/DocxViewer"
import PdfViewer from "@/components/PdfViewer"
import ReadmeViewer from "@/components/ReadmeViewer"
import { DocumentChat } from "@/components/DocumentChat"
import { authFetch } from "@/utils/authFetch"
import { generateUUID } from "@/utils/chatUtils"
import { useScopedFind } from "@/hooks/useScopedFind"
import { PersistentMap } from "@/utils/chatUtils"
import { DocumentOperationsProvider, useDocumentOperations } from "@/contexts/DocumentOperationsContext"
import ExcelViewer from "@/components/ExcelViewer"
import CsvViewer from "@/components/CsvViewer"

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

// Helper functions for localStorage
const UPLOAD_STATE_KEY = "knowledgeManagement_uploadState"

const saveUploadState = (state: {
  isUploading: boolean
  batchProgress: {
    total: number
    current: number
    batch: number
    totalBatches: number
  }
  uploadingCollectionName: string
}) => {
  try {
    localStorage.setItem(UPLOAD_STATE_KEY, JSON.stringify(state))
  } catch (error) {
    console.error("Failed to save upload state:", error)
  }
}

const loadUploadState = () => {
  try {
    const saved = localStorage.getItem(UPLOAD_STATE_KEY)
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (error) {
    console.error("Failed to load upload state:", error)
  }
  return {
    isUploading: false,
    batchProgress: { total: 0, current: 0, batch: 0, totalBatches: 0 },
    uploadingCollectionName: "",
  }
}

const clearUploadState = () => {
  try {
    localStorage.removeItem(UPLOAD_STATE_KEY)
  } catch (error) {
    console.error("Failed to clear upload state:", error)
  }
}

// Memoized Document Viewer Container to prevent re-renders on sidebar resize
const DocumentViewerContainer = memo(
  ({
    selectedDocument,
    loadingDocument,
  }: {
    selectedDocument: {
      file: FileNode
      collection: Collection
      content?: Blob
    }
    loadingDocument: boolean
  }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const { documentOperationsRef } = useDocumentOperations();

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
      if(name.endsWith(".xlsx") || name.endsWith(".xls") ){
           return (
             <div ref={containerRef} data-container-ref="true" className="h-full">
               <ExcelViewer
                 source={
                   new File(
                     [selectedDocument.content],
                     selectedDocument.file.name,
                     { type: selectedDocument.content.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
                   )
                 }
                 className="h-full"
                 style={{ height: "100%", overflow: "auto" }}
               />
             </div>
           )
      }

      if(name.endsWith(".csv")){
        return (
          <div ref={containerRef} data-container-ref="true" className="h-full">
               <CsvViewer
                 source={
                   new File(
                     [selectedDocument.content],
                     selectedDocument.file.name,
                     { type: selectedDocument.content.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
                   )
                 }
                 className="h-full"
                 style={{ height: "100%", overflow: "auto" }}
               />
             </div>
        )
      }
    
      return (
        <div ref={containerRef} data-container-ref="true" className="h-full p-6 overflow-auto">
          <DocxViewer
            source={
              new File(
                [selectedDocument.content],
                selectedDocument.file.name,
                {
                  type:
                    selectedDocument.content.type ||
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                },
              )
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
    }, [selectedDocument?.file.id, selectedDocument?.file.name, selectedDocument?.content])
    
    const {
      highlightText,
      clearHighlights,
      scrollToMatch,
    } = useScopedFind(containerRef);

    // Expose the highlight functions via the document operations ref
    useEffect(() => {
      if (documentOperationsRef?.current) {
        documentOperationsRef.current.highlightText = async (text: string) => {
          if (!containerRef.current) {
            const container = document.querySelector('[data-container-ref="true"]');
            if (container) {
              (containerRef as any).current = container;
            } else {
              return false;
            }
          }

          try {
            const success = await highlightText(text);
            return success;
          } catch (error) {
            console.error('Error calling highlightText:', error);
            return false;
          }
        };
        
        documentOperationsRef.current.clearHighlights = clearHighlights;
        documentOperationsRef.current.scrollToMatch = scrollToMatch;
      }
    }, [documentOperationsRef, highlightText, clearHighlights, scrollToMatch]);

    useEffect(() => {
      clearHighlights();
    }, [selectedDocument?.file.id, clearHighlights]);

    useEffect(() => {
      return () => {
        clearHighlights();
      };
    }, [clearHighlights]);

    return (
      <div className="h-full bg-white dark:bg-[#1E1E1E] relative">
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
          <div className="h-full">
            {viewerElement}
          </div>
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
  const [showNewCollection, setShowNewCollection] = useState(false)
  const [collectionName, setCollectionName] = useState("")
  const [collections, setCollections] = useState<Collection[]>([])
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

  // Load upload state from localStorage on mount
  const savedState = loadUploadState()
  const [isUploading, setIsUploading] = useState(savedState.isUploading)
  const [batchProgress, setBatchProgress] = useState(savedState.batchProgress)
  const [uploadingCollectionName, setUploadingCollectionName] = useState(
    savedState.uploadingCollectionName,
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

  // Save upload state to localStorage whenever it changes
  useEffect(() => {
    saveUploadState({
      isUploading,
      batchProgress,
      uploadingCollectionName,
    })
  }, [isUploading, batchProgress, uploadingCollectionName])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      // Only clear if upload is not active
      if (!isUploading) {
        clearUploadState()
      }
    }
  }, [isUploading])

  // Fallback: Clear upload state if it's been "uploading" for too long
  useEffect(() => {
    if (!isUploading) return

    // If upload state has been active for more than 10 minutes, clear it
    const timeout = setTimeout(
      () => {
        setIsUploading(false)
        setBatchProgress({ total: 0, current: 0, batch: 0, totalBatches: 0 })
        setUploadingCollectionName("")
        clearUploadState()
      },
      10 * 60 * 1000,
    ) // 10 minutes

    return () => clearTimeout(timeout)
  }, [isUploading])

  const showToast = useCallback(
    (title: string, description: string, isError = false) => {
      const { dismiss } = toast({
        title,
        description,
        variant: isError ? "destructive" : "default",
        duration: 2000,
        action: (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.preventDefault()
              dismiss()
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        ),
      })
    },
    [toast],
  )

  // Check for ongoing uploads on component mount
  useEffect(() => {
    const checkForOngoingUploads = async () => {
      const savedState = loadUploadState()
      if (savedState.isUploading && savedState.uploadingCollectionName) {
        // If there's an ongoing upload, check if it's actually complete

        // Check if the collection exists and has files
        try {
          const response = await api.cl.$get({
            query: { includeItems: "true" },
          })
          if (response.ok) {
            const data = await response.json()
            const existingCollection = data.find(
              (collection: CollectionType) =>
                collection.name.toLowerCase() ===
                savedState.uploadingCollectionName.toLowerCase(),
            )

            if (
              existingCollection &&
              existingCollection.totalItems >= savedState.batchProgress.total
            ) {
              // Upload appears to be complete, clear the state
              setIsUploading(false)
              setBatchProgress({
                total: 0,
                current: 0,
                batch: 0,
                totalBatches: 0,
              })
              setUploadingCollectionName("")
              clearUploadState()

              // Show completion toast
              showToast(
                "Upload Complete",
                `Upload of ${savedState.batchProgress.total} files to "${savedState.uploadingCollectionName}" completed while you were away.`,
              )
            }
          }
        } catch (error) {
          console.error("Error checking upload status:", error)
          // If we can't check, clear the state after a timeout to avoid infinite skeleton
          setTimeout(() => {
            setIsUploading(false)
            setBatchProgress({
              total: 0,
              current: 0,
              batch: 0,
              totalBatches: 0,
            })
            setUploadingCollectionName("")
            clearUploadState()
          }, 5000)
        }
      }
    }

    checkForOngoingUploads()
  }, [showToast])

  // Periodic check for upload completion while on the page
  useEffect(() => {
    if (!isUploading || !uploadingCollectionName) return

    const checkUploadProgress = async () => {
      try {
        const response = await api.cl.$get({
          query: { includeItems: "true" },
        })
        if (response.ok) {
          const data = await response.json()
          const existingCollection = data.find(
            (collection: CollectionType) =>
              collection.name.toLowerCase() ===
              uploadingCollectionName.toLowerCase(),
          )

          if (
            existingCollection &&
            existingCollection.totalItems >= batchProgress.total
          ) {
            // Upload is complete, clear the state
            setIsUploading(false)
            setBatchProgress({
              total: 0,
              current: 0,
              batch: 0,
              totalBatches: 0,
            })
            setUploadingCollectionName("")
            clearUploadState()

            // Refresh collections to show the new one

            const updatedCollections = data.map(
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
                  })),
                ),
                isOpen: collection.name.toLowerCase() === uploadingCollectionName.toLowerCase() 
                  ? true // Open the newly uploaded collection
                  : (collection.items || []).length > 0,
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
            )

            setCollections(updatedCollections)

            showToast(
              "Upload Complete",
              `Successfully uploaded ${batchProgress.total} files to "${uploadingCollectionName}".`,
            )
          }
        }
      } catch (error) {
        console.error("Error checking upload progress:", error)
      }
    }

    // Check every 3 seconds while upload is active
    const interval = setInterval(checkUploadProgress, 3000)

    return () => clearInterval(interval)
  }, [isUploading, uploadingCollectionName, batchProgress.total, showToast])

  useEffect(() => {
    const fetchCollections = async () => {
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
          showToast("Error", "Failed to fetch knowledge bases.", true)
        }
      } catch (error) {
        showToast(
          "Error",
          "An error occurred while fetching knowledge bases.",
          true,
        )
      }
    }

    fetchCollections()
  }, [showToast, user?.email])

  const handleCloseModal = () => {
    setShowNewCollection(false)
    setAddingToCollection(null)
    setTargetFolder(null)
    setCollectionName("")
    setSelectedFiles([])
    setOpenDropdown(null)
  }

  const handleUpload = async () => {
    if (selectedFiles.length === 0) {
      showToast("Upload Error", "Please select files to upload.", true)
      return
    }

    if (
      collections.some(
        (c) => c.name.toLowerCase() === collectionName.trim().toLowerCase(),
      )
    ) {
      showToast(
        "Upload Error",
        "Collection name already exists. Please choose a different name.",
        true,
      )
      return
    }

    setIsUploading(true)
    setUploadingCollectionName(collectionName.trim())
    setBatchProgress({
      total: selectedFiles.length,
      current: 0,
      batch: 0,
      totalBatches: 0,
    })

    // Close the modal immediately after starting upload
    handleCloseModal()

    try {
      // First create the collection
      const cl = await createCollection(collectionName.trim(), "")

      // Then upload files in batches
      const batches = createBatches(selectedFiles, collectionName.trim())
      setBatchProgress((prev: typeof batchProgress) => ({
        ...prev,
        totalBatches: batches.length,
      }))

      for (let i = 0; i < batches.length; i++) {
        setBatchProgress((prev: typeof batchProgress) => ({
          ...prev,
          batch: i + 1,
        }))
        const batchFiles = batches[i].map((f) => f.file)
       await uploadFileBatch(batchFiles, cl.id)
        setBatchProgress((prev: typeof batchProgress) => ({
          ...prev,
          current: prev.current + batchFiles.length,
        }))
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
        files: updatedCl.totalCount || selectedFiles.length,
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
            updatedBy:
              item.lastUpdatedByEmail || user?.email || "Unknown",
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
      showToast(
        "Knowledge Base Created",
        `Successfully created knowledge base "${collectionName.trim()}" with ${selectedFiles.length} files.`,
      )
    } catch (error) {
      console.error("Upload failed:", error)
      showToast(
        "Upload Failed",
        "Failed to create collection. Please try again.",
        true,
      )
    } finally {
      setIsUploading(false)
      setBatchProgress({ total: 0, current: 0, batch: 0, totalBatches: 0 })
      setUploadingCollectionName("")
      clearUploadState()
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
      showToast("Upload Error", "Please select files to upload.", true)
      return
    }

    setIsUploading(true)
    setUploadingCollectionName(addingToCollection.name)
    setBatchProgress({
      total: selectedFiles.length,
      current: 0,
      batch: 0,
      totalBatches: 0,
    })

    // Close the modal immediately after starting upload
    handleCloseModal()

    try {
      // Upload files in batches
      let successfullyUploadedFiles = 0;
      const batches = createBatches(selectedFiles, addingToCollection.name)
      setBatchProgress((prev: typeof batchProgress) => ({
        ...prev,
        totalBatches: batches.length,
      }))

      for (let i = 0; i < batches.length; i++) {
        setBatchProgress((prev: typeof batchProgress) => ({
          ...prev,
          batch: i + 1,
        }))
        const batchFiles = batches[i].map((f) => f.file)
      const uploadedResult = await uploadFileBatch(
          batchFiles,
          addingToCollection.id,
          targetFolder?.id,
        )
        successfullyUploadedFiles += uploadedResult.summary.successful;
        
        setBatchProgress((prev: typeof batchProgress) => ({
          ...prev,
          current: prev.current + batchFiles.length,
        }))
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
      successfullyUploadedFiles? showToast(
        "Files Added",
        `Successfully added ${successfullyUploadedFiles} out of ${selectedFiles.length} files to collection "${addingToCollection.name}".`,
      ):
      showToast(
        "Add Files Failed",
        "Failed to add files to collection. Please try again.",
        true,
      )
      handleCloseModal()
    } catch (error) {
      console.error("Add files failed:", error)
      showToast(
        "Add Files Failed",
        "Failed to add files to collection. Please try again.",
        true,
      )
    } finally {
      setIsUploading(false)
      setBatchProgress({ total: 0, current: 0, batch: 0, totalBatches: 0 })
      setUploadingCollectionName("")
      clearUploadState()
    }
  }

  const handleDeleteItem = async () => {
    if (!deletingItem) return

    setIsUploading(true)
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

      showToast(
        "Item Deleted",
        `Successfully deleted "${deletingItem.node.name}".`,
      )
    } catch (error) {
      console.error("Delete failed:", error)
      showToast(
        "Delete Failed",
        "Failed to delete item. Please try again.",
        true,
      )
    } finally {
      setDeletingItem(null)
      setIsUploading(false)
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
        showToast("Collection Updated", "Successfully updated collection name.")
      } else {
        const errorText = await response.text()
        showToast(
          "Update Failed",
          `Failed to update collection name: ${errorText}`,
          true,
        )
      }
    } catch (error) {
      console.error("Update failed:", error)
      showToast("Update Failed", "Failed to update collection name.", true)
    }
  }

  const handleDeleteCollection = async () => {
    if (!deletingCollection) return

    setIsUploading(true)

    try {
      // Delete the collection
      await deleteCollection(deletingCollection.id)

      // Remove from state
      setCollections((prev) =>
        prev.filter((c) => c.id !== deletingCollection.id),
      )
      setDeletingCollection(null)
      showToast(
        "Collection Deleted",
        "Successfully deleted collection and all associated files.",
      )
    } catch (error) {
      console.error("Delete failed:", error)
      showToast(
        "Delete Failed",
        "Failed to delete collection. Please try again.",
        true,
      )
    } finally {
      setIsUploading(false)
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
        !fileName.endsWith(".csv") && !fileName.endsWith(".xlsx") && !fileName.endsWith(".xls")
    )
    ) {
      showToast(
        "Preview Not Available",
        "Preview is only available for .docx, .pdf, and .md files.",
        false,
      )
      return
    }

    setIsFileTreeCollapsed(true)

    // Don't reload if it's the same file
    if (selectedDocument && selectedDocument.file.id === file.id) {
      return
    }

    setLoadingDocument(true)
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
        showToast("Preview Not Available", errorMessage, false)
        return
      }

      // If preview is supported, fetch the file content with cache-busting
      const fileName = file.name.toLowerCase()
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

        showToast("Document Error", errorMessage, true)
        throw new Error(errorMessage)
      }

      const blob = await contentResponse.blob()

      setSelectedDocument({
        file,
        collection,
        content: blob,
      })
    } catch (error) {
      console.error("Error loading document:", error)
      showToast("Error", "Failed to load document", true)
    } finally {
      setLoadingDocument(false)
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
      loadChatForDocument(selectedDocument.file.id)
    }
  }, [selectedDocument?.file.id, loadChatForDocument])

  const handleBackToCollections = () => {
    setSelectedDocument(null)
    setCurrentInitialChatId(null)
    setIsFileTreeCollapsed(true) // Reset file tree state when going back
    setIsChatOverlayOpen(false) // Reset chat overlay state when going back
  }

  // Handle chunk index changes from DocumentChat
  const handleChunkIndexChange = async (newChunkIndex: number | null, documentId: string) => {
    if (!documentId) {
      console.error('handleChunkIndexChange called without documentId');
      return;
    }
    
    if (newChunkIndex !== null && selectedDocument?.file.id === documentId) {
      try {
        const chunkContentResponse = await api.chunk[":cId"].files[":itemId"].content.$get({
          param: { cId: newChunkIndex.toString(), itemId: documentId },
        })
        
        if (!chunkContentResponse.ok) {
          console.error('Failed to fetch chunk content:', chunkContentResponse.status);
          showToast('Error', 'Failed to load chunk content', true);
          return;
        }
        
        const chunkContent = await chunkContentResponse.json()

        // Ensure we are still on the same document before mutating UI
        if (selectedDocument?.file.id !== documentId) {
          return;
        }
        
        if (chunkContent && chunkContent.chunkContent) {
          if (documentOperationsRef?.current?.clearHighlights) {
            documentOperationsRef.current.clearHighlights()
          }
          
          if (documentOperationsRef?.current?.highlightText) {
            try {
              await documentOperationsRef.current.highlightText(chunkContent.chunkContent);
            } catch (error) {
              console.error('Error highlighting chunk text:', chunkContent.chunkContent, error);
            }
          }
        }
      } catch (error) {
        console.error('Error in handleChunkIndexChange:', error);
        showToast('Error', 'Failed to process chunk navigation', true);
      }
    }
  }

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
              <div className="flex-1 flex flex-col bg-white h-full">
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
                  <div className="ml-auto">
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
                <div className="flex-1 overflow-hidden">
                  <DocumentViewerContainer
                    selectedDocument={selectedDocument}
                    loadingDocument={loadingDocument}
                  />
                </div>
              </div>

              {/* Right pane - Chat component (sticky) or overlay toggle */}
              {!isChatHidden ? (
                <div className="flex flex-col bg-white dark:bg-[#1E1E1E] sticky top-0 border-l border-gray-200 dark:border-gray-700 w-[40%]">
                  <DocumentChat
                    key={currentInitialChatId}
                    user={user}
                    documentId={selectedDocument.file.id || ""}
                    documentName={selectedDocument.file.name}
                    initialChatId={currentInitialChatId}
                    onChatCreated={handleChatCreated}
                    onChunkIndexChange={handleChunkIndexChange}
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
                <div className="relative bg-white dark:bg-[#1E1E1E] w-[50%] max-w-[50%] max-w-[90vw] h-full shadow-2xl transform transition-transform duration-300 ease-in-out">
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
                                    showToast(
                                      "Error",
                                      `Failed to load folder contents`,
                                      true,
                                    )
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
                <h1 className="text-[26px] font-display text-gray-700 dark:text-gray-100 tracking-wider">
                  KNOWLEDGE MANAGEMENT
                </h1>
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
              </div>
              <div className="mt-12">
                {/* Show skeleton loader when uploading */}
                {isUploading && batchProgress.total > 0 && (
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
                        {batchProgress.current} / {batchProgress.total} files
                        processed
                      </div>
                    </div>
                    <FileUploadSkeleton
                      totalFiles={batchProgress.total}
                      processedFiles={batchProgress.current}
                      currentBatch={batchProgress.batch}
                      totalBatches={batchProgress.totalBatches}
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
                                for (let i = 0; i < updatedNodes.length; i++) {
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
                                        showToast(
                                          "Error",
                                          `Failed to load folder contents`,
                                          true,
                                        )
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
                      </>
                    )}
                  </div>
                ))}
              </div>
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
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-100 dark:bg-gray-700 rounded-2xl w-[90%] max-w-4xl max-h-[90vh] overflow-hidden flex flex-col p-2">
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
                      : "Collection title"}
                  </label>
                  <Input
                    id="collectionName"
                    type="text"
                    placeholder="Enter collection title"
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
    MAX_PAYLOAD_SIZE: 45 * 1024 * 1024,
    MAX_FILES_PER_BATCH: 50,
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