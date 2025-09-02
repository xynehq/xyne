import React, {
  Dispatch,
  SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react" // Ensure React is imported
import { useNavigate } from "@tanstack/react-router"
import { renderToStaticMarkup } from "react-dom/server" // For rendering ReactNode to HTML string
import {
  ArrowRight,
  Globe,
  AtSign,
  Layers,
  Square,
  ChevronDown,
  Infinity,
  Check,
  Link,
  Search,
  RotateCcw,
  Atom,
  Bot, // Import Bot icon
  PlusCircle,
  Gavel, // For MCP connector tools
  X,
  File,
  Loader2,
} from "lucide-react"
import Attach from "@/assets/attach.svg?react"
import {
  Citation,
  Apps,
  SelectPublicAgent,
  PublicUser,
  ConnectorType,
  AuthType,
  ConnectorStatus,
  UserRole,
  DataSourceEntity,
  AttachmentMetadata,
} from "shared/types" // Add SelectPublicAgent, PublicUser
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { getIcon } from "@/lib/common"
import { CLASS_NAMES, SELECTORS } from "../lib/constants"
import { DriveEntity } from "shared/types"
import { api } from "@/api"
import { Input } from "@/components/ui/input"
import { Pill } from "./Pill"
import { Reference, ToolsListItem } from "@/types"
import { useToast } from "@/hooks/use-toast"
import {
  generateFileId,
  createDragHandlers,
  createFileSelectionHandlers,
  validateAndDeduplicateFiles,
  createToastNotifier,
  createImagePreview,
  cleanupPreviewUrls,
} from "@/utils/fileUtils"
import { authFetch } from "@/utils/authFetch"

interface SelectedFile {
  file: File
  id: string
  metadata?: AttachmentMetadata
  uploading?: boolean
  uploadError?: string
  preview?: string // URL for image preview
}

// Add attachment limit constant
const MAX_ATTACHMENTS = 5
import { HighlightedTextForAtMention } from "./Highlight"

interface SourceItem {
  id: string
  name: string
  app: Apps | string
  entity: string
  icon: React.ReactNode
}

interface SearchResult {
  docId: string
  threadId: string
  app: string
  entity: string
  subject?: string
  name?: string
  title?: string
  filename?: string
  mailId?: string
  from?: string
  timestamp?: number
  updatedAt?: number
  relevance: number
  url?: string
  type?: string
  email?: string
  photoLink?: string
  userMap?: Record<string, string>
  text?: string
  domain?: string
  createdAt?: string
  channelId?: string
}

function slackTs(ts: any) {
  if (typeof ts === "number") ts = ts.toString()
  return ts.replace(".", "").padEnd(16, "0")
}

interface ChatBoxProps {
  role: UserRole
  query: string
  setQuery: (query: string) => void
  setIsAgenticMode: Dispatch<SetStateAction<boolean>>
  isAgenticMode: boolean
  handleSend: (
    messageToSend: string,
    metadata?: AttachmentMetadata[],
    selectedSources?: string[],
    agentId?: string | null,
    toolsList?: ToolsListItem[],
    enableWebSearch?: boolean,
  ) => void // Expects agentId string and optional fileIds
  isStreaming?: boolean
  retryIsStreaming?: boolean
  handleStop?: () => void
  chatId?: string | null // Current chat ID
  agentIdFromChatData?: string | null // New prop for agentId from chat data
  allCitations: Map<string, Citation>
  isReasoningActive: boolean
  setIsReasoningActive: (
    value: boolean | ((prevState: boolean) => boolean),
  ) => void
  user: PublicUser // Added user prop
  overrideIsRagOn?: boolean
}

const availableSources: SourceItem[] = [
  {
    id: "googledrive",
    name: "Google Drive",
    app: Apps.GoogleDrive,
    entity: "file",
    icon: getIcon(Apps.GoogleDrive, "file", { w: 16, h: 16, mr: 8 }),
  },
  {
    id: "googledocs",
    name: "Google Docs",
    app: Apps.GoogleDrive,
    entity: DriveEntity.Docs,
    icon: getIcon(Apps.GoogleDrive, DriveEntity.Docs, { w: 16, h: 16, mr: 8 }),
  },
  {
    id: "googlesheets",
    name: "Google Sheets",
    app: Apps.GoogleDrive,
    entity: DriveEntity.Sheets,
    icon: getIcon(Apps.GoogleDrive, DriveEntity.Sheets, {
      w: 16,
      h: 16,
      mr: 8,
    }),
  },
  {
    id: "slack",
    name: "Slack",
    app: Apps.Slack,
    entity: "message",
    icon: getIcon(Apps.Slack, "message", { w: 16, h: 16, mr: 8 }),
  },
  {
    id: "gmail",
    name: "Gmail",
    app: Apps.Gmail,
    entity: "mail",
    icon: getIcon(Apps.Gmail, "mail", { w: 16, h: 16, mr: 8 }),
  },
  {
    id: "googlecalendar",
    name: "Calendar",
    app: Apps.GoogleCalendar,
    entity: "event",
    icon: getIcon(Apps.GoogleCalendar, "event", { w: 16, h: 16, mr: 8 }),
  },
  {
    id: "pdf",
    name: "PDF",
    app: "pdf",
    entity: "pdf_default",
    icon: getIcon("pdf", "pdf_default", { w: 16, h: 16, mr: 8 }),
  },
]

const getCaretCharacterOffsetWithin = (element: Node) => {
  let caretOffset = 0
  const doc = element.ownerDocument || (element as any).document
  if (doc.getSelection) {
    const selection = doc.getSelection()
    if (selection && selection.rangeCount) {
      const range = selection.getRangeAt(0)
      const preCaretRange = range.cloneRange()
      preCaretRange.selectNodeContents(element)
      preCaretRange.setEnd(range.endContainer, range.endOffset)
      caretOffset = preCaretRange.toString().length
    }
  }
  return caretOffset
}

const setCaretPosition = (element: Node, position: number) => {
  const range = document.createRange()
  const sel = window.getSelection()!
  let currentPosition = 0
  let targetNode: Node | null = null
  let targetOffset = 0

  const traverseNodes = (node: Node) => {
    if (currentPosition >= position) return
    if (node.nodeType === Node.TEXT_NODE) {
      const textLength = node.textContent?.length || 0
      if (currentPosition + textLength >= position) {
        targetNode = node
        targetOffset = position - currentPosition
      }
      currentPosition += textLength
    } else {
      for (const child of node.childNodes) {
        traverseNodes(child)
        if (targetNode) break
      }
    }
  }

  traverseNodes(element)
  if (targetNode) {
    range.setStart(targetNode, targetOffset)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }
}

export interface ChatBoxRef {
  sendMessage: (message: string) => void
}

export const ChatBox = React.forwardRef<ChatBoxRef, ChatBoxProps>(
  (props, ref) => {
    const {
      role,
      query,
      setQuery,
      handleSend,
      isStreaming = false,
      retryIsStreaming = false,
      allCitations,
      handleStop,
      chatId,
      agentIdFromChatData, // Destructure new prop
      isReasoningActive,
      setIsReasoningActive,
      user, // Destructure user prop
      setIsAgenticMode,
      isAgenticMode = false,
      overrideIsRagOn,
    } = props
    // Interface for fetched tools
    interface FetchedTool {
      id: number
      workspaceId: number
      connectorId: number
      toolName: string
      toolSchema: string // Assuming schema is a JSON string
      description: string | null
      enabled: boolean // Added enabled field
      createdAt: string
      updatedAt: string
      externalId: string // This is the externalId from the backend
    }

    // Interface for fetched connectors
    interface FetchedConnector {
      id: string // externalId from backend
      app: Apps | string
      authType: AuthType | string
      type: ConnectorType | string
      status: ConnectorStatus | string
      createdAt: string // Assuming ISO string date
      config: Record<string, any>
      connectorId: number // internal DB id
      displayName?: string // For UI
    }

    const { toast } = useToast()
    const inputRef = useRef<HTMLDivElement | null>(null)
    const referenceBoxRef = useRef<HTMLDivElement | null>(null)
    const referenceItemsRef = useRef<
      (HTMLDivElement | HTMLButtonElement | null)[]
    >([])
    const scrollContainerRef = useRef<HTMLDivElement | null>(null)
    const referenceSearchInputRef = useRef<HTMLInputElement | null>(null)
    const debounceTimeout = useRef<NodeJS.Timeout | null>(null)
    const scrollPositionRef = useRef<number>(0)
    const navigate = useNavigate()
    const fileInputRef = useRef<HTMLInputElement | null>(null)

    const [showReferenceBox, setShowReferenceBox] = useState(false)
    const [searchMode, setSearchMode] = useState<"citations" | "global">(
      "citations",
    )
    const [globalResults, setGlobalResults] = useState<SearchResult[]>([])

    // Unified function to enhance Google Sheets items with dummy "whole sheet" options
    const enhanceGoogleSheetsResults = useCallback(
      <
        T extends {
          app?: string
          entity?: string
          docId: string
          title?: string
          name?: string
          subject?: string
          filename?: string
        },
      >(
        items: T[],
      ): (T & { isWholeSheetDummy?: boolean })[] => {
        const enhanced: (T & { isWholeSheetDummy?: boolean })[] = []
        const seenWholeSheets = new Set<string>()

        items.forEach((item) => {
          // If this is a Google Sheet with a specific tab (contains " / " in title)
          const isGoogleSheet =
            item.app === Apps.GoogleDrive && item.entity === DriveEntity.Sheets
          if (isGoogleSheet) {
            const displayTitle =
              item.title ||
              item.name ||
              item.subject ||
              item.filename ||
              "Untitled"
            const isSpecificSheetTab = displayTitle.includes(" / ")

            if (isSpecificSheetTab) {
              // Extract the spreadsheet name (before " / ")
              const sheetName = displayTitle.split(" / ")[0]

              // Extract the base docId (remove the "_X" suffix)
              const baseDocId = item.docId.replace(/_\d+$/, "")

              // Only add the whole sheet dummy if we haven't seen this spreadsheet yet
              if (!seenWholeSheets.has(baseDocId)) {
                seenWholeSheets.add(baseDocId)

                // Create a dummy item for the whole sheet and add it BEFORE the specific tab
                const wholeSheetItem: T & { isWholeSheetDummy?: boolean } = {
                  ...item,
                  docId: baseDocId,
                  title: sheetName,
                  ...(item.name !== undefined && { name: sheetName }),
                  isWholeSheetDummy: true,
                }

                // Insert the whole sheet option BEFORE the current item
                enhanced.push(wholeSheetItem)
              }
            }
          }

          // Add the original item after checking for whole sheet
          enhanced.push(item)
        })

        return enhanced
      },
      [],
    )

    // Create enhanced results that include dummy "whole sheet" options for specific sheet tabs
    const enhancedGlobalResults: (SearchResult & {
      isWholeSheetDummy?: boolean
    })[] = useMemo(() => {
      return enhanceGoogleSheetsResults(globalResults)
    }, [globalResults, enhanceGoogleSheetsResults])

    const [selectedRefIndex, setSelectedRefIndex] = useState(-1)
    const [selectedSources, setSelectedSources] = useState<
      Record<string, boolean>
    >({})
    const [isSourceMenuOpen, setIsSourceMenuOpen] = useState(false)
    const [isGlobalLoading, setIsGlobalLoading] = useState(false)
    const [globalError, setGlobalError] = useState<string | null>(null)
    const [page, setPage] = useState(1)
    const [totalCount, setTotalCount] = useState(0)
    const [activeAtMentionIndex, setActiveAtMentionIndex] = useState(-1)
    const [referenceSearchTerm, setReferenceSearchTerm] = useState("")
    const [referenceBoxLeft, setReferenceBoxLeft] = useState(0)
    const [isPlaceholderVisible, setIsPlaceholderVisible] = useState(true)
    const [showSourcesButton, _] = useState(false) // Added this line
    const [persistedAgentId, setPersistedAgentId] = useState<string | null>(
      null,
    )
    const [displayAgentName, setDisplayAgentName] = useState<string | null>(
      null,
    )
    const [selectedAgent, setSelectedAgent] =
      useState<SelectPublicAgent | null>(null)
    const [allConnectors, setAllConnectors] = useState<FetchedConnector[]>([])
    const [selectedConnectorIds, setSelectedConnectorIds] = useState<
      Set<string>
    >(new Set())
    const [isConnectorsMenuOpen, setIsConnectorsMenuOpen] = useState(false)
    const [connectorTools, setConnectorTools] = useState<FetchedTool[]>([])
    const [isLoadingTools, setIsLoadingTools] = useState(false)
    const [isToolSelectionModalOpen, setIsToolSelectionModalOpen] =
      useState(false)
    const [toolSearchTerm, setToolSearchTerm] = useState("")
    const [activeToolConnectorId, setActiveToolConnectorId] = useState<
      string | null
    >(null) // Track which connector's tools are being shown
    const connectorsDropdownTriggerRef = useRef<HTMLButtonElement | null>(null)
    const toolModalRef = useRef<HTMLDivElement | null>(null) // Ref for the tool modal itself
    const [toolModalPosition, setToolModalPosition] = useState<{
      top: number
      left: number
    } | null>(null)
    const [initialLoadComplete, setInitialLoadComplete] = useState(false)
    const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([])
    const [isUploadingFiles, setIsUploadingFiles] = useState(false)
    const [enableWebSearch, setEnableWebSearch] = useState(() => {
      const saved = localStorage.getItem("enableWebSearch")
      return saved !== null ? JSON.parse(saved) : false
    })
    const showAdvancedOptions =
      overrideIsRagOn ??
      (!selectedAgent || (selectedAgent && selectedAgent.isRagOn))

    // Persist enableWebSearch state to localStorage when it changes
    useEffect(() => {
      localStorage.setItem("enableWebSearch", JSON.stringify(enableWebSearch))
    }, [enableWebSearch])

    // localStorage keys for tool selection persistence
    const SELECTED_CONNECTOR_TOOLS_KEY = "selectedConnectorTools"
    const SELECTED_MCP_CONNECTOR_ID_KEY = "selectedMcpConnectorId"

    // File upload utility functions
    const showToast = createToastNotifier(toast)

    const processFiles = useCallback(
      (files: FileList | File[]) => {
        // Check attachment limit
        if (selectedFiles.length >= MAX_ATTACHMENTS) {
          showToast(
            "Attachment limit reached",
            `You can only attach up to ${MAX_ATTACHMENTS} files at a time.`,
            true,
          )
          return
        }

        const validFiles = validateAndDeduplicateFiles(files, showToast)
        if (validFiles.length === 0) return

        // Check if adding these files would exceed the limit
        const remainingSlots = MAX_ATTACHMENTS - selectedFiles.length
        const filesToAdd = validFiles.slice(0, remainingSlots)

        if (filesToAdd.length < validFiles.length) {
          showToast(
            "Some files skipped",
            `Only ${filesToAdd.length} of ${validFiles.length} files were added due to attachment limit.`,
            false,
          )
        }

        const newFiles: SelectedFile[] = filesToAdd.map((file) => ({
          file,
          id: generateFileId(),
          uploading: false,
          preview: createImagePreview(file),
        }))

        setSelectedFiles((prev) => {
          const existingFileNames = new Set(prev.map((f) => f.file.name))
          const filteredNewFiles = newFiles.filter(
            (f) => !existingFileNames.has(f.file.name),
          )

          const filteredCount = newFiles.length - filteredNewFiles.length
          if (filteredCount > 0) {
            showToast(
              "Files already selected",
              `${filteredCount} file(s) were already selected and skipped.`,
              false,
            )
          }

          return [...prev, ...filteredNewFiles]
        })
      },
      [showToast, selectedFiles.length],
    )

    const uploadFiles = useCallback(
      async (files: SelectedFile[]) => {
        if (files.length === 0) return []

        setIsUploadingFiles(true)
        const uploadedMetadata: AttachmentMetadata[] = []

        // Set all files to uploading state
        setSelectedFiles((prev) =>
          prev.map((f) =>
            files.some((file) => file.id === f.id)
              ? { ...f, uploading: true, uploadError: undefined }
              : f,
          ),
        )

        const uploadPromises = files.map(async (selectedFile) => {
          try {
            const formData = new FormData()
            formData.append("attachment", selectedFile.file)

            // Use the new attachment upload endpoint
            const response = await authFetch(
              "/api/v1/files/upload-attachment",
              {
                method: "POST",
                body: formData,
              },
            )

            if (!response.ok) {
              const error = await response.json()
              throw new Error(error.message || "Upload failed")
            }

            const result = await response.json()
            const metadata = result.attachments?.[0]

            if (metadata) {
              setSelectedFiles((prev) =>
                prev.map((f) =>
                  f.id === selectedFile.id
                    ? { ...f, uploading: false, metadata }
                    : f,
                ),
              )
              return metadata
            } else {
              throw new Error("No document ID returned from upload")
            }
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Upload failed"
            setSelectedFiles((prev) =>
              prev.map((f) =>
                f.id === selectedFile.id
                  ? { ...f, uploading: false, uploadError: errorMessage }
                  : f,
              ),
            )
            showToast(
              "Upload failed",
              `Failed to upload ${selectedFile.file.name}: ${errorMessage}`,
              true,
            )
            return null
          }
        })

        const results = await Promise.all(uploadPromises)
        uploadedMetadata.push(
          ...results.filter(
            (metadata): metadata is AttachmentMetadata => metadata !== null,
          ),
        )

        setIsUploadingFiles(false)
        return uploadedMetadata
      },
      [showToast],
    )

    const getExtension = (file: File) => {
      const name = file.name
      const ext = name.includes(".")
        ? name.split(".").pop()?.toLowerCase()
        : null
      return ext || "file"
    }

    const removeFile = useCallback((id: string) => {
      setSelectedFiles((prev) => {
        const fileToRemove = prev.find((f) => f.id === id)
        if (fileToRemove?.preview) {
          URL.revokeObjectURL(fileToRemove.preview)
        }
        return prev.filter((f) => f.id !== id)
      })
    }, [])

    const { handleFileSelect, handleFileChange } = createFileSelectionHandlers(
      fileInputRef,
      processFiles,
    )

    const { handleDragOver, handleDragLeave } = createDragHandlers()

    const handleDrop = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault()
        const files = Array.from(e.dataTransfer.files)
        if (files.length > 0) {
          // Check attachment limit before processing
          if (selectedFiles.length >= MAX_ATTACHMENTS) {
            showToast(
              "Attachment limit reached",
              `You can only attach up to ${MAX_ATTACHMENTS} files at a time.`,
              true,
            )
            return
          }
          processFiles(files)
        }
      },
      [processFiles, selectedFiles.length, showToast],
    )

    // Effect to initialize and update persistedAgentId
    useEffect(() => {
      const searchParams = new URLSearchParams(window.location.search)
      const agentIdFromUrl = searchParams.get("agentId")

      if (agentIdFromUrl) {
        setPersistedAgentId(agentIdFromUrl)
      } else if (agentIdFromChatData) {
        setPersistedAgentId(agentIdFromChatData)
      } else {
        setPersistedAgentId(null)
      }
      // This effect should run when chatId changes (indicating a new chat context),
      // when agentIdFromChatData changes (new chat data loaded),
      // or when the component initially loads.
    }, [chatId, agentIdFromChatData])

    // Effect to fetch agent details for display when persistedAgentId is set
    useEffect(() => {
      const fetchAgentDetails = async () => {
        if (persistedAgentId) {
          try {
            const response = await api.agents.$get() // Fetch all agents
            if (response.ok) {
              const allAgents = (await response.json()) as SelectPublicAgent[]
              const currentAgent = allAgents.find(
                (agent) => agent.externalId === persistedAgentId,
              )
              if (currentAgent) {
                setDisplayAgentName(currentAgent.name)
                setSelectedAgent(currentAgent)
              } else {
                console.error(
                  `Agent with ID ${persistedAgentId} not found for display.`,
                )
                setDisplayAgentName(null)
                setSelectedAgent(null)
              }
            } else {
              console.error("Failed to load agents for display.")
              setDisplayAgentName(null)
              setSelectedAgent(null)
            }
          } catch (error) {
            console.error("Error fetching agent details for display:", error)
            setDisplayAgentName(null)
            setSelectedAgent(null)
          }
        } else {
          setDisplayAgentName(null) // Clear display name if no persistedAgentId
          setSelectedAgent(null)
        }
      }

      fetchAgentDetails()
    }, [persistedAgentId]) // Depend on persistedAgentId

    const loadToolSelectionsFromStorage = (): Record<string, Set<string>> => {
      try {
        const stored = localStorage.getItem(SELECTED_CONNECTOR_TOOLS_KEY)
        if (stored) {
          const parsed = JSON.parse(stored)
          // Convert arrays back to Sets
          const result: Record<string, Set<string>> = {}
          for (const [connectorId, toolNames] of Object.entries(parsed)) {
            if (Array.isArray(toolNames)) {
              result[connectorId] = new Set(toolNames as string[])
            }
          }
          return result
        }
      } catch (error) {
        console.warn("Failed to load tool selections from localStorage:", error)
      }
      return {}
    }

    const saveToolSelectionsToStorage = (
      selections: Record<string, Set<string>>,
    ) => {
      try {
        // Convert Sets to arrays for JSON serialization
        const serializable: Record<string, string[]> = {}
        for (const [connectorId, toolNames] of Object.entries(selections)) {
          serializable[connectorId] = Array.from(toolNames)
        }
        localStorage.setItem(
          SELECTED_CONNECTOR_TOOLS_KEY,
          JSON.stringify(serializable),
        )
      } catch (error) {
        console.warn("Failed to save tool selections to localStorage:", error)
      }
    }

    // Initialize selectedConnectorTools with data from localStorage
    const [selectedConnectorTools, setSelectedConnectorTools] = useState<
      Record<string, Set<string>>
    >(loadToolSelectionsFromStorage)

    // Persist tool selections to localStorage whenever they change
    useEffect(() => {
      saveToolSelectionsToStorage(selectedConnectorTools)
    }, [selectedConnectorTools])

    // Local state for isReasoningActive and its localStorage effect are removed. Props will be used.

    useEffect(() => {
      // Effect to adjust tool modal position based on its height
      if (
        isToolSelectionModalOpen &&
        toolModalRef.current &&
        connectorsDropdownTriggerRef.current
      ) {
        const modalHeight = toolModalRef.current.offsetHeight

        const triggerRect =
          connectorsDropdownTriggerRef.current.getBoundingClientRect()
        const chatBoxContainer = inputRef.current?.closest(
          ".relative.flex.flex-col.w-full",
        ) as HTMLElement | null
        const connectorDropdownWidth = 288 // Based on w-72 class (18rem * 16px/rem)
        const gap = 8 // 8px gap

        let newLeftCalculation: number
        let topReferenceForModalBottom: number

        if (chatBoxContainer) {
          const containerRect = chatBoxContainer.getBoundingClientRect()
          newLeftCalculation =
            triggerRect.left - containerRect.left + connectorDropdownWidth + gap
          topReferenceForModalBottom = triggerRect.top - containerRect.top
        } else {
          // Fallback if chatBoxContainer is not found (less likely but good for robustness)
          newLeftCalculation = triggerRect.left + connectorDropdownWidth + gap
          topReferenceForModalBottom = triggerRect.top
        }

        const newModalTop = topReferenceForModalBottom - modalHeight

        setToolModalPosition((currentPosition) => {
          // Check if the position actually needs updating to prevent infinite loops
          if (
            currentPosition &&
            currentPosition.top === newModalTop &&
            currentPosition.left === newLeftCalculation
          ) {
            return currentPosition
          }
          return { top: newModalTop, left: newLeftCalculation }
        })
      }
    }, [
      isToolSelectionModalOpen,
      isLoadingTools,
      connectorTools,
      toolSearchTerm,
      // Intentionally not including toolModalPosition here to avoid loops,
      // as this effect is responsible for calculating the definitive position.
      // It re-runs when factors affecting modal height change.
    ])

    useEffect(() => {
      const loadInitialData = async () => {
        let processedConnectors: FetchedConnector[] = []
        try {
          // Role-based API routing
          const isAdmin =
            role === UserRole.Admin || role === UserRole.SuperAdmin

          const response = isAdmin
            ? await api.admin.connectors.all.$get(undefined, {
                credentials: "include",
              })
            : await api.connectors.all.$get(undefined, {
                credentials: "include",
              })
          const data = await response.json()
          if (Array.isArray(data)) {
            processedConnectors = data.map((conn: any) => ({
              ...conn,
              displayName:
                conn.name || conn.config?.name || conn.app || conn.id,
            }))
          } else {
            console.error("Fetched connectors data is not an array:", data)
          }
        } catch (error) {
          console.error("Error fetching connectors:", error)
        }

        setAllConnectors(processedConnectors)

        const storedMcpId = localStorage.getItem(SELECTED_MCP_CONNECTOR_ID_KEY)
        if (storedMcpId && processedConnectors.length > 0) {
          const connectorExists = processedConnectors.find(
            (c) => c.id === storedMcpId && c.type === ConnectorType.MCP,
          )
          if (connectorExists) {
            setSelectedConnectorIds(new Set([storedMcpId]))
          } else {
            // If stored ID is invalid (not found or not MCP), remove it.
            localStorage.removeItem(SELECTED_MCP_CONNECTOR_ID_KEY)
          }
        }
        setInitialLoadComplete(true) // Mark initial load as complete
      }

      loadInitialData()
    }, [role]) // Added role dependency

    // useEffect to save selected MCP connector ID
    useEffect(() => {
      if (!initialLoadComplete) {
        // Don't run save logic during initial load phase
        return
      }

      // Find any MCP connector in the selected set
      const mcpConnectorId = Array.from(selectedConnectorIds).find(
        (connectorId) => {
          if (allConnectors.length > 0) {
            const connector = allConnectors.find((c) => c.id === connectorId)
            return connector && connector.type === ConnectorType.MCP
          }
          return false
        },
      )

      if (mcpConnectorId) {
        localStorage.setItem(SELECTED_MCP_CONNECTOR_ID_KEY, mcpConnectorId)
      } else {
        // If no MCP connector is selected
        localStorage.removeItem(SELECTED_MCP_CONNECTOR_ID_KEY)
      }
    }, [selectedConnectorIds, allConnectors, initialLoadComplete])

    const adjustInputHeight = useCallback(() => {
      if (inputRef.current) {
        inputRef.current.style.height = "auto"
        const scrollHeight = inputRef.current.scrollHeight
        const minHeight = 52
        const maxHeight = 320
        const newHeight = Math.max(minHeight, Math.min(scrollHeight, maxHeight))
        inputRef.current.style.height = `${newHeight}px`
      }
    }, [])

    const updateReferenceBoxPosition = (atIndex: number) => {
      const inputElement = inputRef.current
      if (!inputElement || atIndex < 0) {
        const parentRect = inputElement
          ?.closest(
            `.${CLASS_NAMES.SEARCH_CONTAINER} > .relative.flex.flex-col`,
          )
          ?.getBoundingClientRect()
        const inputRect = inputElement?.getBoundingClientRect()
        if (parentRect && inputRect) {
          setReferenceBoxLeft(inputRect.left - parentRect.left)
        } else {
          setReferenceBoxLeft(0)
        }
        return
      }

      const range = document.createRange()
      let currentPos = 0
      let targetNode: Node | null = null
      let targetOffsetInNode = 0

      function findDomPosition(node: Node, charIndex: number): boolean {
        if (node.nodeType === Node.TEXT_NODE) {
          const textLength = node.textContent?.length || 0
          if (currentPos <= charIndex && charIndex < currentPos + textLength) {
            targetNode = node
            targetOffsetInNode = charIndex - currentPos
            return true
          }
          currentPos += textLength
        } else {
          for (const child of node.childNodes) {
            if (findDomPosition(child, charIndex)) return true
          }
        }
        return false
      }

      if (findDomPosition(inputElement, atIndex)) {
        range.setStart(targetNode!, targetOffsetInNode)
        range.setEnd(targetNode!, targetOffsetInNode + 1)
        const rect = range.getBoundingClientRect()
        const parentRect = inputElement
          .closest(`.${CLASS_NAMES.SEARCH_CONTAINER} > .relative.flex.flex-col`)
          ?.getBoundingClientRect()

        if (parentRect) {
          setReferenceBoxLeft(rect.left - parentRect.left)
        } else {
          const inputRect = inputElement.getBoundingClientRect()
          setReferenceBoxLeft(rect.left - inputRect.left)
        }
      } else {
        const inputRect = inputElement.getBoundingClientRect()
        const parentRect = inputElement
          .closest(`.${CLASS_NAMES.SEARCH_CONTAINER} > .relative.flex.flex-col`)
          ?.getBoundingClientRect()
        if (parentRect) {
          setReferenceBoxLeft(inputRect.left - parentRect.left)
        } else {
          setReferenceBoxLeft(0)
        }
      }
    }

    const derivedReferenceSearch = useMemo(() => {
      if (activeAtMentionIndex === -1 || !showReferenceBox) {
        return ""
      }
      if (
        activeAtMentionIndex >= query.length ||
        query[activeAtMentionIndex] !== "@"
      ) {
        return ""
      }
      return query.substring(activeAtMentionIndex + 1).trimStart()
    }, [query, showReferenceBox, activeAtMentionIndex])

    const currentSearchTerm = useMemo(() => {
      if (activeAtMentionIndex === -1 && showReferenceBox) {
        return referenceSearchTerm
      }
      return derivedReferenceSearch
    }, [
      activeAtMentionIndex,
      showReferenceBox,
      referenceSearchTerm,
      derivedReferenceSearch,
    ])

    useEffect(() => {
      if (showReferenceBox && activeAtMentionIndex !== -1) {
        const newMode =
          derivedReferenceSearch.length > 0 ? "global" : "citations"
        if (newMode !== searchMode) {
          setSearchMode(newMode)
          setSelectedRefIndex(-1)
          if (newMode === "citations") {
            setGlobalResults([])
            setGlobalError(null)
            setPage(1)
            setTotalCount(0)
          }
        }
      } else if (!showReferenceBox) {
        setSelectedRefIndex(-1)
      }
    }, [
      derivedReferenceSearch,
      showReferenceBox,
      searchMode,
      activeAtMentionIndex,
    ])

    const selectedSourceItems = useMemo(() => {
      return availableSources.filter((source) => selectedSources[source.id])
    }, [selectedSources])

    const selectedSourcesCount = selectedSourceItems.length

    const formatTimestamp = (time: number | undefined) => {
      if (!time) return "Unknown Date"
      return new Date(time).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    }

    const displayedCitations = useMemo(() => {
      if (
        !allCitations ||
        !showReferenceBox ||
        searchMode !== "citations" ||
        activeAtMentionIndex === -1
      ) {
        return []
      }
      const searchValue = derivedReferenceSearch.toLowerCase()
      return Array.from(allCitations.values()).filter((citation) =>
        citation.title.toLowerCase().includes(searchValue),
      )
    }, [
      allCitations,
      derivedReferenceSearch,
      searchMode,
      showReferenceBox,
      activeAtMentionIndex,
    ])

    // Create enhanced citations that include dummy "whole sheet" options for specific sheet tabs
    const enhancedDisplayedCitations: (Citation & {
      isWholeSheetDummy?: boolean
    })[] = useMemo(() => {
      return enhanceGoogleSheetsResults(displayedCitations)
    }, [displayedCitations, enhanceGoogleSheetsResults])

    const fetchResults = async (
      searchTermForFetch: string,
      pageToFetch: number,
      append: boolean = false,
    ) => {
      if (!searchTermForFetch || searchTermForFetch.length < 1) return
      if (
        isGlobalLoading ||
        (append && globalResults.length >= totalCount && totalCount > 0)
      )
        return

      setIsGlobalLoading(true)
      if (!append) {
        setGlobalError(null)
      }

      try {
        const limit = 10
        const offset = (pageToFetch - 1) * limit
        const params: Record<string, string | string[]> = {
          query: searchTermForFetch,
          limit: limit.toString(),
          offset: offset.toString(),
        }

        if (persistedAgentId) {
          params.agentId = persistedAgentId
        }

        const response = await api.search.$get({
          query: params,
          credentials: "include",
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(
            `API request failed with status ${response.status}: ${errorText}`,
          )
        }

        const data = await response.json()

        const fetchedTotalCount = data.count || 0
        setTotalCount(fetchedTotalCount)

        const results: SearchResult[] = data.results || []
        setGlobalResults((prev) => {
          if (currentSearchTerm !== searchTermForFetch) {
            return append ? prev : []
          }
          const existingIds = new Set(prev.map((r) => r.docId))
          const newResults = results.filter((r) => !existingIds.has(r.docId))
          const updatedResults = append ? [...prev, ...newResults] : newResults

          if (
            !append &&
            updatedResults.length < 5 &&
            updatedResults.length < fetchedTotalCount
          ) {
            setTimeout(() => {
              fetchResults(searchTermForFetch, pageToFetch + 1, true)
            }, 0)
          }

          return updatedResults
        })

        setPage(pageToFetch)
        setGlobalError(null)
      } catch (error) {
        if (currentSearchTerm === searchTermForFetch) {
          setGlobalError("Failed to fetch global results. Please try again.")
          if (!append) setGlobalResults([])
        }
      } finally {
        if (currentSearchTerm === searchTermForFetch) {
          setIsGlobalLoading(false)
        }
      }
    }

    useEffect(() => {
      if (
        searchMode !== "global" ||
        !currentSearchTerm ||
        currentSearchTerm.length < 1
      ) {
        if (!isGlobalLoading) {
          setGlobalResults([])
          setGlobalError(null)
          setPage(1)
          setTotalCount(0)
        }
        return
      }

      if (debounceTimeout.current) clearTimeout(debounceTimeout.current)

      const termToFetch = currentSearchTerm
      debounceTimeout.current = setTimeout(() => {
        setPage(1)
        setGlobalResults([])
        fetchResults(termToFetch, 1, false)
      }, 300)

      return () => {
        if (debounceTimeout.current) clearTimeout(debounceTimeout.current)
      }
    }, [currentSearchTerm, searchMode])

    useEffect(() => {
      if (scrollContainerRef.current && scrollPositionRef.current > 0) {
        scrollContainerRef.current.scrollTop = scrollPositionRef.current
        scrollPositionRef.current = 0
      }
    }, [globalResults])

    useEffect(() => {
      if (!showReferenceBox) {
        setSelectedRefIndex(-1)
        return
      }

      const items =
        searchMode === "citations" ? enhancedDisplayedCitations : globalResults
      const canLoadMore =
        searchMode === "global" &&
        globalResults.length < totalCount &&
        !isGlobalLoading
      if (selectedRefIndex === -1) {
        setSelectedRefIndex(items.length > 0 ? 0 : -1)
      } else {
        const currentMaxIndex =
          searchMode === "citations"
            ? enhancedDisplayedCitations.length - 1
            : canLoadMore
              ? globalResults.length
              : globalResults.length - 1
        if (selectedRefIndex > currentMaxIndex) {
          setSelectedRefIndex(currentMaxIndex)
        }
      }
    }, [
      searchMode,
      enhancedDisplayedCitations,
      globalResults,
      showReferenceBox,
      totalCount,
      isGlobalLoading,
    ])

    // Helper to find DOM node and offset from a character offset in textContent
    const findBoundaryPosition = (
      root: Node,
      charOffset: number,
    ): { container: Node; offset: number } | null => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
      let currentAccumulatedOffset = 0
      let node
      while ((node = walker.nextNode())) {
        const textNode = node as Text
        const len = textNode.textContent?.length || 0
        if (currentAccumulatedOffset + len >= charOffset) {
          return {
            container: textNode,
            offset: charOffset - currentAccumulatedOffset,
          }
        }
        currentAccumulatedOffset += len
      }
      // If charOffset is at the very end of the content (after all text nodes)
      if (charOffset === currentAccumulatedOffset) {
        // Find the last child of the root, or root itself, to place the cursor
        let containerNode: Node = root
        let containerOffset = root.childNodes.length
        if (root.childNodes.length > 0) {
          let lastChild = root.lastChild
          while (
            lastChild &&
            lastChild.nodeType !== Node.TEXT_NODE &&
            lastChild.lastChild
          ) {
            lastChild = lastChild.lastChild
          }
          if (lastChild && lastChild.nodeType === Node.TEXT_NODE) {
            containerNode = lastChild
            containerOffset = lastChild.textContent?.length || 0
          } else if (root.lastChild) {
            // If last child is an element, place cursor after it in parent
            containerNode = root
            // Find index of lastChild + 1 for offset
            containerOffset =
              Array.from(root.childNodes).indexOf(root.lastChild) + 1
          }
        }
        return { container: containerNode, offset: containerOffset }
      }
      return null
    }

    // Helper function to parse content and preserve existing pills as spans - THIS WILL BE REPLACED/REMOVED
    // For now, keeping its signature for context, but its usage will be removed from handleAddReference/handleSelectGlobalResult

    const handleAddReference = (
      citation: Citation & { isWholeSheetDummy?: boolean },
    ) => {
      // Handle DataSource navigation
      if (
        citation.app === Apps.DataSource &&
        citation.entity === DataSourceEntity.DataSourceFile
      ) {
        navigate({ to: `/dataSource/${citation.docId}` })
        setShowReferenceBox(false)
        return
      }

      const docId = citation.docId

      // Check if this is a Google Sheet and determine wholeSheet property
      const isGoogleSheet =
        citation.app === Apps.GoogleDrive &&
        citation.entity === DriveEntity.Sheets
      let wholeSheet: boolean | undefined = undefined

      if (isGoogleSheet) {
        if (citation.isWholeSheetDummy) {
          wholeSheet = true
        } else if (citation.title.includes(" / ")) {
          wholeSheet = false
        } else {
          wholeSheet = true // Default for regular sheets
        }
      }

      const newRef: Reference = {
        id: docId,
        docId: docId,
        title: citation.title,
        url: citation.url,
        app: citation.app,
        entity: citation.entity,
        type: "citation",
        wholeSheet: wholeSheet,
        threadId: (citation as any).threadId, // Add threadId if available
      }

      const input = inputRef.current
      if (!input || activeAtMentionIndex === -1) {
        setShowReferenceBox(false)
        return
      }

      const selection = window.getSelection()
      if (!selection) {
        setShowReferenceBox(false)
        return
      }

      const mentionStartCharOffset = activeAtMentionIndex
      // The @mention text effectively goes from activeAtMentionIndex up to the current caret position.
      // When clicking a reference, getCaretCharacterOffsetWithin(input) might be unreliable if focus changes.
      // Assuming the active mention always extends to the end of the current query content.
      const mentionEndCharOffset = query.length

      const startPos = findBoundaryPosition(input, mentionStartCharOffset)
      const endPos = findBoundaryPosition(input, mentionEndCharOffset)

      if (startPos && endPos) {
        const range = document.createRange()
        range.setStart(startPos.container, startPos.offset)
        range.setEnd(endPos.container, endPos.offset)
        range.deleteContents()

        const pillHtmlString = renderToStaticMarkup(<Pill newRef={newRef} />)
        const tempDiv = document.createElement("div")
        tempDiv.innerHTML = pillHtmlString
        // Find the actual <a> tag, as renderToStaticMarkup might prepend other tags like <link>
        const pillElement = tempDiv.querySelector(
          `a.${CLASS_NAMES.REFERENCE_PILL}`,
        )

        if (pillElement) {
          const clonedPill = pillElement.cloneNode(true)
          range.insertNode(clonedPill)
          const space = document.createTextNode("\u00A0")

          // Insert space after pill and set caret
          range.setStartAfter(clonedPill)
          range.insertNode(space)
          range.setStart(space, space.length)
          range.collapse(true)
          selection.removeAllRanges()
          selection.addRange(range)
        }
        setQuery(input.textContent || "")
      } else {
        console.error(
          "Could not determine range for @mention replacement in handleAddReference.",
        )
        // Fallback or error handling if positions can't be found
      }

      setShowReferenceBox(false)
      setActiveAtMentionIndex(-1)
      setReferenceSearchTerm("")
      setGlobalResults([])
      setGlobalError(null)
      setPage(1)
      setTotalCount(0)
      setSelectedRefIndex(-1)
    }

    const handleSelectGlobalResult = (
      result: SearchResult & { isWholeSheetDummy?: boolean },
    ) => {
      let resultUrl = result.url
      if (!resultUrl && result.app === Apps.Gmail) {
        const identifier = result.threadId || result.docId
        if (identifier) {
          resultUrl = `https://mail.google.com/mail/u/0/#inbox/${identifier}`
        }
      }
      if (result.app === Apps.Slack) {
        if (result.threadId) {
          // Thread message format
          resultUrl = `https://${result.domain}.slack.com/archives/${result.channelId}/p${slackTs(result.createdAt)}?thread_ts=${result.threadId}&cid=${result.channelId}`
        } else {
          // Normal message format
          resultUrl = `https://${result.domain}.slack.com/archives/${result.channelId}/p${slackTs(result.createdAt)}`
        }
      }

      const displayTitle =
        result.text ||
        result.name ||
        result.subject ||
        result.title ||
        result.filename ||
        (result.type === "user" && result.email) ||
        "Untitled"
      const refId =
        result.docId || (result.type === "user" && result.email) || ""

      if (!refId) {
        console.error("Cannot add reference without a valid ID.", result)
        setShowReferenceBox(false)
        setActiveAtMentionIndex(-1)
        setReferenceSearchTerm("")
        return
      }

      // Check if this is a Google Sheet with a specific tab (contains " / " in title)
      const isGoogleSheet =
        result.app === Apps.GoogleDrive && result.entity === DriveEntity.Sheets
      const isSpecificSheetTab =
        isGoogleSheet &&
        displayTitle.includes(" / ") &&
        !result.isWholeSheetDummy
      const isWholeSheetDummy = result.isWholeSheetDummy || false

      let newRef: Reference

      if (isSpecificSheetTab) {
        // For specific sheet tabs, create the reference with wholeSheet: false
        newRef = {
          id: refId,
          title: displayTitle,
          url: resultUrl,
          docId: result.docId,
          mailId: result.mailId,
          app: result.app,
          entity: result.entity,
          type: "global",
          photoLink: result.photoLink,
          userMap: result.userMap,
          wholeSheet: false,
        }
      } else if (isWholeSheetDummy) {
        // For whole sheet dummy results, create reference with wholeSheet: true
        newRef = {
          id: refId,
          title: displayTitle,
          url: resultUrl,
          docId: result.docId,
          mailId: result.mailId,
          app: result.app,
          entity: result.entity,
          type: "global",
          photoLink: result.photoLink,
          userMap: result.userMap,
          wholeSheet: true,
        }
      } else {
        // For all other types, create normal reference
        newRef = {
          id: refId,
          title: displayTitle,
          url: resultUrl,
          docId: result.docId,
          mailId: result.mailId,
          threadId: result.threadId, // Add threadId from result
          app: result.app,
          entity: result.entity,
          type: "global",
          photoLink: result.photoLink,
          userMap: result.userMap,
          wholeSheet: isGoogleSheet ? true : undefined,
        }
      }

      const input = inputRef.current
      if (!input || activeAtMentionIndex === -1) {
        setShowReferenceBox(false)
        return
      }

      const selection = window.getSelection()
      if (!selection) {
        setShowReferenceBox(false)
        return
      }

      const mentionStartCharOffset = activeAtMentionIndex
      // When clicking a reference, getCaretCharacterOffsetWithin(input) might be unreliable if focus changes.
      // Assuming the active mention always extends to the end of the current query content.
      const mentionEndCharOffset = query.length

      const startPos = findBoundaryPosition(input, mentionStartCharOffset)
      const endPos = findBoundaryPosition(input, mentionEndCharOffset)

      if (startPos && endPos) {
        const range = document.createRange()
        range.setStart(startPos.container, startPos.offset)
        range.setEnd(endPos.container, endPos.offset)
        range.deleteContents()

        const pillHtmlString = renderToStaticMarkup(<Pill newRef={newRef} />)
        const tempDiv = document.createElement("div")
        tempDiv.innerHTML = pillHtmlString
        // Find the actual <a> tag, as renderToStaticMarkup might prepend other tags like <link>
        const pillElement = tempDiv.querySelector("a.reference-pill")

        if (pillElement) {
          const clonedPill = pillElement.cloneNode(true)
          range.insertNode(clonedPill)
          const space = document.createTextNode("\u00A0")

          range.setStartAfter(clonedPill)
          range.insertNode(space)
          range.setStart(space, space.length)
          range.collapse(true)
          selection.removeAllRanges()
          selection.addRange(range)
        }
        setQuery(input.textContent || "")
      } else {
        console.error(
          "Could not determine range for @mention replacement in handleSelectGlobalResult.",
        )
      }

      setShowReferenceBox(false)
      setActiveAtMentionIndex(-1)
      setReferenceSearchTerm("")
      setGlobalResults([])
      setGlobalError(null)
      setPage(1)
      setTotalCount(0)
      setSelectedRefIndex(-1)
    }

    const handleReferenceKeyDown = (
      e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
    ) => {
      if (!showReferenceBox) return

      const items =
        searchMode === "citations"
          ? enhancedDisplayedCitations
          : enhancedGlobalResults
      const totalItemsCount = items.length
      const canLoadMore =
        searchMode === "global" &&
        globalResults.length < totalCount &&
        !isGlobalLoading
      const loadMoreIndex = enhancedGlobalResults.length

      if (e.key === "ArrowDown") {
        e.preventDefault()
        const maxIndex = canLoadMore ? loadMoreIndex : totalItemsCount - 1
        setSelectedRefIndex((prev) => {
          const nextIndex = Math.min(prev + 1, maxIndex)
          if (prev === -1 && items.length > 0) return 0
          return nextIndex
        })
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelectedRefIndex((prev) => {
          const nextIndex = Math.max(prev - 1, 0)
          return nextIndex
        })
      } else if (e.key === "Enter") {
        e.preventDefault()
        if (selectedRefIndex >= 0 && selectedRefIndex < totalItemsCount) {
          if (searchMode === "citations") {
            if (enhancedDisplayedCitations[selectedRefIndex]) {
              handleAddReference(enhancedDisplayedCitations[selectedRefIndex])
            }
          } else {
            if (enhancedGlobalResults[selectedRefIndex]) {
              handleSelectGlobalResult(enhancedGlobalResults[selectedRefIndex])
            }
          }
        } else if (
          searchMode === "global" &&
          selectedRefIndex === loadMoreIndex &&
          canLoadMore
        ) {
          handleLoadMore()
        }
      } else if (e.key === "Escape") {
        e.preventDefault()
        setShowReferenceBox(false)
        setActiveAtMentionIndex(-1)
        setReferenceSearchTerm("")
        setSelectedRefIndex(-1)
      }
    }

    useEffect(() => {
      if (
        selectedRefIndex >= 0 &&
        referenceItemsRef.current[selectedRefIndex]
      ) {
        referenceItemsRef.current[selectedRefIndex]?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        })
      }
    }, [selectedRefIndex])

    useEffect(() => {
      const handleOutsideClick = (event: MouseEvent) => {
        const target = event.target as Node
        if (
          showReferenceBox &&
          referenceBoxRef.current &&
          !referenceBoxRef.current.contains(target) &&
          inputRef.current &&
          !inputRef.current.contains(target) &&
          !(event.target as HTMLElement).closest(
            `.${CLASS_NAMES.REFERENCE_TRIGGER}`,
          )
        ) {
          setShowReferenceBox(false)
          setActiveAtMentionIndex(-1)
          setReferenceSearchTerm("")
        }
      }

      document.addEventListener("mousedown", handleOutsideClick)
      return () => document.removeEventListener("mousedown", handleOutsideClick)
    }, [showReferenceBox])

    const handleSendMessage = useCallback(async () => {
      const activeSourceIds = Object.entries(selectedSources)
        .filter(([, isSelected]) => isSelected)
        .map(([id]) => id)

      let htmlMessage = inputRef.current?.innerHTML || ""
      htmlMessage = htmlMessage.replace(/(&nbsp;|\s)+$/g, "")
      htmlMessage = htmlMessage.replace(/(<br\s*\/?>\s*)+$/gi, "")
      htmlMessage = htmlMessage.replace(/(&nbsp;|\s)+$/g, "")

      let toolsListToSend: ToolsListItem[] | undefined = undefined

      // Build toolsList from all selected connectors
      if (selectedConnectorIds.size > 0) {
        const toolsListArray: ToolsListItem[] = []

        // Include tools from all selected connectors
        selectedConnectorIds.forEach((connectorId) => {
          const toolsSet = selectedConnectorTools[connectorId]

          if (toolsSet && toolsSet.size > 0) {
            // Find the connector to get its internal connectorId
            const connector = allConnectors.find((c) => c.id === connectorId)
            if (connector) {
              const toolsArray = Array.from(toolsSet)
              toolsListArray.push({
                connectorId: connector.connectorId.toString(), // Use internal DB id
                tools: toolsArray,
              })
            }
          }
        })

        // Only send toolsList if we actually have tools selected
        if (
          toolsListArray.length > 0 &&
          toolsListArray.some((item) => item.tools.length > 0)
        ) {
          toolsListToSend = toolsListArray
        }
      }

      // Handle Attachments Metadata
      let attachmentsMetadata: AttachmentMetadata[] = []
      if (selectedFiles.length > 0) {
        const filesToUpload = selectedFiles.filter(
          (f) => !f.metadata && !f.uploading,
        )
        const alreadyUploadedMetadata = selectedFiles
          .map((f) => f.metadata)
          .filter((m): m is AttachmentMetadata => !!m)

        if (filesToUpload.length > 0) {
          const newUploadedMetadata = await uploadFiles(filesToUpload)
          attachmentsMetadata = [
            ...alreadyUploadedMetadata,
            ...newUploadedMetadata,
          ]
        } else {
          attachmentsMetadata = alreadyUploadedMetadata
        }
      }

      // Replace data-doc-id and data-reference-id with mailId
      const tempDiv = document.createElement("div")
      tempDiv.innerHTML = htmlMessage
      const pills = tempDiv.querySelectorAll("a.reference-pill")

      pills.forEach((pill) => {
        const mailId = pill.getAttribute("data-mail-id")
        const userMap = pill.getAttribute("user-map")
        const threadId = pill.getAttribute("data-thread-id")
        const docId =
          pill.getAttribute("data-doc-id") ||
          pill.getAttribute("data-reference-id")
        if (userMap) {
          try {
            const parsedUserMap = JSON.parse(userMap)
            if (user?.email && parsedUserMap[user.email]) {
              pill.setAttribute(
                "href",
                `https://mail.google.com/mail/u/0/#inbox/${parsedUserMap[user.email]}`,
              )
            } else {
              console.warn(
                `No mapping found for user email: ${user?.email} in userMap.`,
              )
            }
          } catch (error) {
            console.error("Failed to parse userMap:", error)
          }
        }

        if (mailId) {
          pill.setAttribute("data-doc-id", mailId)
          pill.setAttribute("data-reference-id", mailId)
          pill.setAttribute("data-thread-id", threadId || "")
        } else {
          console.warn(
            `No mailId found for pill with docId: ${docId}. Skipping replacement.`,
          )
        }
      })

      htmlMessage = tempDiv.innerHTML

      handleSend(
        htmlMessage,
        attachmentsMetadata,
        activeSourceIds.length > 0 ? activeSourceIds : undefined,
        persistedAgentId,
        toolsListToSend,
        enableWebSearch,
      )

      // Clear the input and attached files after sending
      if (inputRef.current) {
        inputRef.current.innerHTML = ""
      }
      setQuery("")

      // Cleanup preview URLs before clearing files
      const previewUrls = selectedFiles
        .map((f) => f.preview)
        .filter(Boolean) as string[]
      cleanupPreviewUrls(previewUrls)
      setSelectedFiles([])
    }, [
      selectedSources,
      selectedConnectorIds,
      selectedConnectorTools,
      allConnectors,
      selectedFiles,
      persistedAgentId,
      handleSend,
      uploadFiles,
      user,
      setQuery,
      setSelectedFiles,
      cleanupPreviewUrls,
      enableWebSearch,
    ])

    const handleSourceSelectionChange = (
      sourceId: string,
      checked: boolean,
    ) => {
      setSelectedSources((prev) => ({
        ...prev,
        [sourceId]: checked,
      }))
      setPage(1)
      setGlobalResults([])
    }

    const handleClearAllSources = () => {
      const clearedSources: Record<string, boolean> = {}
      availableSources.forEach((source) => {
        clearedSources[source.id] = false
      })
      setSelectedSources(clearedSources)
      setPage(1)
      setGlobalResults([])
    }

    const handleLoadMore = () => {
      if (scrollContainerRef.current) {
        scrollPositionRef.current = scrollContainerRef.current.scrollTop
      }
      const nextPage = page + 1
      fetchResults(currentSearchTerm, nextPage, true)
    }

    useEffect(() => {
      if (
        showReferenceBox &&
        activeAtMentionIndex === -1 &&
        referenceSearchInputRef.current
      ) {
        referenceSearchInputRef.current.focus()
      }
    }, [showReferenceBox, activeAtMentionIndex])

    useEffect(() => {
      adjustInputHeight()
    }, [query, adjustInputHeight])

    // Cleanup preview URLs when component unmounts
    const selectedFilesRef = useRef(selectedFiles)
    selectedFilesRef.current = selectedFiles

    useEffect(() => {
      return () => {
        const previewUrls = selectedFilesRef.current
          .map((f) => f.preview)
          .filter(Boolean) as string[]
        cleanupPreviewUrls(previewUrls)
      }
    }, [])

    // Add imperative handle to expose sendMessage method
    React.useImperativeHandle(
      ref,
      () => ({
        sendMessage: (message: string) => {
          // Set the query first
          setQuery(message)
          // Update the input content
          if (inputRef.current) {
            inputRef.current.textContent = message
            setIsPlaceholderVisible(false)
          }
          // Then trigger the send message with all the internal state
          // Use setTimeout to ensure state updates are applied
          setTimeout(() => {
            // Call handleSendMessage which will use the current state values
            // for agents, tools, connectors, etc.
            handleSendMessage()
          }, 0)
        },
      }),
      [
        // Include dependencies that affect what gets sent
        selectedConnectorIds,
        selectedConnectorTools,
        persistedAgentId,
        selectedSources,
        selectedFiles,
        handleSendMessage,
      ],
    )

    return (
      <div className="relative flex flex-col w-full max-w-3xl pb-5">
        {persistedAgentId && displayAgentName && (
          <div className="flex items-center justify-between gap-2 px-4 py-3 bg-blue-50 dark:bg-blue-900/20 rounded-t-[20px] border-x border-t border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-2">
              <Bot size={18} className="text-blue-600 dark:text-blue-400" />
              <span className="text-sm font-mono tracking-wider uppercase text-blue-600 dark:text-blue-400">
                {displayAgentName}
              </span>
            </div>
            <span className="text-sm font-mono tracking-wider uppercase text-blue-600 dark:text-blue-400">
              ASK AGENT
            </span>
          </div>
        )}
        {showReferenceBox && (
          <div
            ref={referenceBoxRef}
            className={`absolute bottom-[calc(80%+8px)] bg-white dark:bg-[#1E1E1E] rounded-md w-[400px] max-w-full z-10 border border-gray-200 dark:border-gray-700 rounded-xl flex flex-col ${CLASS_NAMES.REFERENCE_BOX}`}
            style={{
              left:
                activeAtMentionIndex !== -1 ? `${referenceBoxLeft}px` : "0px",
            }}
          >
            {activeAtMentionIndex === -1 && (
              <div className="p-2 border-b border-gray-200 dark:border-gray-700 relative">
                <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
                <Input
                  ref={referenceSearchInputRef}
                  type="text"
                  placeholder="Search globally..."
                  value={referenceSearchTerm}
                  onChange={(e) => setReferenceSearchTerm(e.target.value)}
                  onKeyDown={handleReferenceKeyDown}
                  className="w-full pl-8 pr-2 py-1.5 text-sm border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            )}
            <div
              ref={scrollContainerRef}
              className="min-h-[40px] max-h-[250px] overflow-y-auto p-1"
            >
              {searchMode === "citations" && activeAtMentionIndex !== -1 && (
                <>
                  {enhancedDisplayedCitations.length > 0 ? (
                    <>
                      {enhancedDisplayedCitations.map(
                        (
                          citation: Citation & { isWholeSheetDummy?: boolean },
                          index,
                        ) => {
                          const citationApp = (citation as any).app
                          const citationEntity = (citation as any).entity
                          return (
                            <div
                              key={citation?.docId}
                              ref={(el) =>
                                (referenceItemsRef.current[index] = el)
                              }
                              className={`p-2 cursor-pointer hover:bg-[#EDF2F7] dark:hover:bg-slate-700 rounded-md ${
                                index === selectedRefIndex
                                  ? "bg-[#EDF2F7] dark:bg-slate-700"
                                  : ""
                              }`}
                              onClick={() => handleAddReference(citation)}
                              onMouseEnter={() => setSelectedRefIndex(index)}
                            >
                              <div className="flex items-center gap-2">
                                {citationApp && citationEntity ? (
                                  getIcon(citationApp, citationEntity, {
                                    w: 16,
                                    h: 16,
                                    mr: 0,
                                  })
                                ) : (
                                  <Link
                                    size={16}
                                    className="text-gray-400 dark:text-gray-500"
                                  />
                                )}
                                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                                  {citation.title || citation.name}
                                </p>
                              </div>
                              <p className="text-xs text-gray-500 dark:text-gray-400 truncate ml-6">
                                {citation.url}
                              </p>
                            </div>
                          )
                        },
                      )}
                    </>
                  ) : derivedReferenceSearch.length > 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400 px-2 py-1 text-center">
                      No citations found for "{derivedReferenceSearch}".
                    </p>
                  ) : (
                    <p className="text-sm text-gray-500 dark:text-gray-400 px-2 py-1 text-center">
                      Start typing to search citations from this chat.
                    </p>
                  )}
                </>
              )}
              {searchMode === "global" && (
                <>
                  {isGlobalLoading &&
                    globalResults.length === 0 &&
                    !globalError && (
                      <p className="text-sm text-gray-500 dark:text-gray-400 px-2 py-1 text-center">
                        {currentSearchTerm
                          ? `Searching for "${currentSearchTerm}"...`
                          : "Searching..."}
                      </p>
                    )}
                  {globalError && (
                    <p className="text-sm text-red-500 dark:text-red-400 px-2 py-1 text-center">
                      {globalError}
                    </p>
                  )}
                  {!isGlobalLoading &&
                    !globalError &&
                    globalResults.length === 0 &&
                    currentSearchTerm &&
                    currentSearchTerm.length > 0 && (
                      <p className="text-sm text-gray-500 dark:text-gray-400 px-2 py-1 text-center">
                        No results found for "{currentSearchTerm}".
                      </p>
                    )}
                  {!isGlobalLoading &&
                    !globalError &&
                    globalResults.length === 0 &&
                    (!currentSearchTerm || currentSearchTerm.length === 0) && (
                      <p className="text-sm text-gray-500 dark:text-gray-400 px-2 py-1 text-center">
                        Type to search for documents, messages, and more.
                      </p>
                    )}
                  {globalResults.length > 0 &&
                    enhancedGlobalResults.map((result, index) => {
                      const displayTitle =
                        result.text ||
                        result.name ||
                        result.subject ||
                        result.title ||
                        result.filename ||
                        (result.type === "user" && result.email) ||
                        "Untitled"
                      return (
                        <div
                          key={result.docId || result.email || index}
                          ref={(el) => (referenceItemsRef.current[index] = el)}
                          className={`p-2 cursor-pointer hover:bg-[#EDF2F7] dark:hover:bg-slate-700 rounded-md ${
                            index === selectedRefIndex
                              ? "bg-[#EDF2F7] dark:bg-slate-700"
                              : ""
                          }`}
                          onClick={() => handleSelectGlobalResult(result)}
                          onMouseEnter={() => setSelectedRefIndex(index)}
                        >
                          <div className="flex items-center gap-2">
                            {result.type === "user" && result.photoLink ? (
                              <img
                                src={result.photoLink}
                                alt={displayTitle}
                                className="w-4 h-4 rounded-full object-cover flex-shrink-0"
                              />
                            ) : (
                              getIcon(result.app, result.entity, {
                                w: 16,
                                h: 16,
                                mr: 0,
                              })
                            )}
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                              <HighlightedTextForAtMention
                                chunk_summary={displayTitle}
                              />
                            </p>
                          </div>
                          {result.type !== "user" && (
                            <p className="text-xs text-gray-500 dark:text-gray-400 truncate ml-6">
                              {result.from
                                ? `From: ${result.from} | `
                                : result.name
                                  ? `From: ${result.name} |`
                                  : ""}
                              {formatTimestamp(
                                result.timestamp || result.updatedAt,
                              )}
                            </p>
                          )}
                        </div>
                      )
                    })}
                  {!globalError &&
                    globalResults.length > 0 &&
                    globalResults.length < totalCount && (
                      <button
                        ref={(el) =>
                          (referenceItemsRef.current[
                            enhancedGlobalResults.length
                          ] = el)
                        }
                        onClick={handleLoadMore}
                        className={`mt-1 w-full px-3 py-1.5 text-sm text-center text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-slate-800 hover:bg-[#EDF2F7] dark:hover:bg-slate-700 rounded-md border border-gray-200 dark:border-slate-600 ${selectedRefIndex === enhancedGlobalResults.length ? "bg-[#EDF2F7] dark:bg-slate-700 ring-1 ring-blue-300 dark:ring-blue-600" : ""}`}
                        disabled={isGlobalLoading}
                        onMouseEnter={() =>
                          setSelectedRefIndex(enhancedGlobalResults.length)
                        }
                      >
                        {isGlobalLoading
                          ? "Loading..."
                          : `Load More (${totalCount - globalResults.length} remaining)`}
                      </button>
                    )}
                </>
              )}
            </div>
          </div>
        )}
        <div
          className={`flex flex-col w-full border dark:border-gray-700 ${persistedAgentId && displayAgentName ? "rounded-b-[20px] rounded-t-none !border-t-0" : "rounded-[20px]"} bg-white dark:bg-[#1E1E1E] ${
            selectedFiles.length >= MAX_ATTACHMENTS
              ? "border-amber-300 dark:border-amber-600"
              : ""
          } ${CLASS_NAMES.SEARCH_CONTAINER}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="relative flex items-center">
            {isPlaceholderVisible && (
              <div className="absolute left-4 top-1/2 transform -translate-y-1/2 text-[#ACBCCC] dark:text-gray-500 pointer-events-none">
                Ask anything across apps...
              </div>
            )}
            <div
              ref={inputRef}
              contentEditable
              data-at-mention // Using the attribute directly as per SELECTORS.AT_MENTION_AREA
              className="flex-grow resize-none bg-transparent outline-none text-[15px] font-[450] leading-[24px] text-[#1C1D1F] dark:text-[#F1F3F4] placeholder-[#ACBCCC] dark:placeholder-gray-500 pl-[16px] pt-[14px] pb-[14px] pr-[16px] overflow-y-auto"
              onPaste={(e: React.ClipboardEvent<HTMLDivElement>) => {
                e.preventDefault()

                const items = e.clipboardData?.items
                if (items) {
                  // Handle image paste
                  for (let i = 0; i < items.length; i++) {
                    const item = items[i]
                    if (item.type.indexOf("image") !== -1) {
                      // Check attachment limit before processing
                      if (selectedFiles.length >= MAX_ATTACHMENTS) {
                        showToast(
                          "Attachment limit reached",
                          `You can only attach up to ${MAX_ATTACHMENTS} files at a time.`,
                          true,
                        )
                        return
                      }

                      const file = item.getAsFile()
                      if (file) {
                        // Process the pasted image file directly
                        // The file will be processed with a default name by the processFiles function
                        processFiles([file])
                        showToast(
                          "Image pasted",
                          "Image has been added to your message.",
                          false,
                        )
                        return // Exit early since we handled the image
                      }
                    }
                  }
                }

                // Handle text paste (existing logic)
                const pastedText = e.clipboardData?.getData("text/plain")
                const currentInput = inputRef.current

                if (pastedText && currentInput) {
                  const selection = window.getSelection()
                  if (!selection || !selection.rangeCount) return

                  const range = selection.getRangeAt(0)
                  range.deleteContents() // Clear existing selection or cursor position

                  const segments = pastedText.split(/(\s+)/)
                  let lastNode: Node | null = null

                  segments.forEach((segment) => {
                    if (segment.length === 0) return

                    let nodeToInsert: Node
                    let isLinkNode = false

                    if (segment.match(/^\s+$/)) {
                      // If the segment is just whitespace
                      nodeToInsert = document.createTextNode(segment)
                    } else {
                      // Logic for non-whitespace segments
                      let isPotentiallyLinkCandidate = false
                      let urlToParseAttempt = segment

                      if (segment.startsWith("www.")) {
                        urlToParseAttempt = "http://" + segment
                        isPotentiallyLinkCandidate = true
                      } else if (
                        segment.startsWith("http://") ||
                        segment.startsWith("https://")
                      ) {
                        isPotentiallyLinkCandidate = true
                      }

                      if (isPotentiallyLinkCandidate) {
                        try {
                          const url = new URL(urlToParseAttempt)
                          // Ensure it's an http or https link.
                          if (
                            url.protocol === "http:" ||
                            url.protocol === "https:"
                          ) {
                            const anchor = document.createElement("a")
                            anchor.href = url.href // Use the (potentially modified) href
                            anchor.textContent = segment // Display the original segment
                            anchor.target = "_blank"
                            anchor.rel = "noopener noreferrer"
                            anchor.className =
                              "text-blue-600 dark:text-blue-400 underline hover:text-blue-800 dark:hover:text-blue-300 cursor-pointer"
                            nodeToInsert = anchor
                            isLinkNode = true
                          } else {
                            // Parsed by new URL(), but not http/https. Treat as text.
                            nodeToInsert = document.createTextNode(segment)
                          }
                        } catch (_) {
                          // Failed to parse with new URL(). Treat as text.
                          nodeToInsert = document.createTextNode(segment)
                        }
                      } else {
                        // Not considered a potential link candidate. Treat as text.
                        nodeToInsert = document.createTextNode(segment)
                      }
                    }

                    range.insertNode(nodeToInsert)
                    lastNode = nodeToInsert

                    if (isLinkNode) {
                      // If a link was just inserted, add a space after it
                      const spaceNode = document.createTextNode("\u00A0")
                      range.setStartAfter(nodeToInsert)
                      range.insertNode(spaceNode)
                      lastNode = spaceNode
                    }

                    // Always move the range to be after the last inserted node (content or space)
                    if (lastNode) {
                      // Ensure lastNode is not null
                      range.setStartAfter(lastNode)
                      range.collapse(true)
                    }
                  })

                  // Ensure the cursor is at the very end of all pasted content.
                  if (lastNode) {
                    range.setStartAfter(lastNode)
                    range.collapse(true)
                  }

                  selection.removeAllRanges()
                  selection.addRange(range)

                  // Dispatch an 'input' event to trigger the onInput handler
                  currentInput.dispatchEvent(
                    new Event("input", { bubbles: true, cancelable: true }),
                  )
                }
              }}
              onInput={(e) => {
                const currentInput = inputRef.current
                if (!currentInput) return

                const newValue = currentInput.textContent || ""
                setQuery(newValue)
                setIsPlaceholderVisible(newValue.length === 0)

                // The 'references' state and its update logic have been removed.
                // Pill management is now primarily through direct DOM interaction
                // and parsing the innerHTML when sending the message.

                const cursorPosition = getCaretCharacterOffsetWithin(
                  currentInput as Node,
                )

                let shouldTriggerBox = false
                let newActiveMentionIndex = -1

                // Check if the character right before the cursor is an '@' and if it's validly placed
                const atCharIndex = cursorPosition - 1
                if (atCharIndex >= 0 && newValue[atCharIndex] === "@") {
                  const isFirstCharacter = atCharIndex === 0
                  const isPrecededBySpace =
                    atCharIndex > 0 &&
                    (newValue[atCharIndex - 1] === " " ||
                      newValue[atCharIndex - 1] === "\u00A0")
                  if (isFirstCharacter || isPrecededBySpace) {
                    shouldTriggerBox = true
                    newActiveMentionIndex = atCharIndex
                  }
                }

                if (shouldTriggerBox) {
                  // A validly placed '@' is at the cursor. Open or keep the box open for this '@'.
                  if (
                    activeAtMentionIndex !== newActiveMentionIndex ||
                    !showReferenceBox
                  ) {
                    // It's a new trigger point or the box was closed. Activate for this '@'.
                    setActiveAtMentionIndex(newActiveMentionIndex)
                    setShowReferenceBox(true)
                    updateReferenceBoxPosition(newActiveMentionIndex)
                    setReferenceSearchTerm("") // Clear search for new mention context
                    setGlobalResults([])
                    setGlobalError(null)
                    setPage(1)
                    setTotalCount(0)
                    setSelectedRefIndex(-1)
                    setSearchMode("citations") // Default to citations
                  }
                  // If activeAtMentionIndex === newActiveMentionIndex and showReferenceBox is true,
                  // the box is already open for this exact '@'. derivedReferenceSearch will handle query updates.
                } else {
                  // No valid '@' trigger at the current cursor position.
                  // If a reference box was open, determine if it should be closed.
                  if (showReferenceBox && activeAtMentionIndex !== -1) {
                    // Check if the previously active mention (at activeAtMentionIndex) is still valid
                    // and if the cursor is still actively engaged with it (i.e., after it).
                    const charAtOldActiveMention =
                      newValue[activeAtMentionIndex]
                    const oldActiveMentionStillIsAt =
                      charAtOldActiveMention === "@"
                    const oldActiveMentionIsFirst = activeAtMentionIndex === 0
                    const oldActiveMentionPrecededBySpace =
                      activeAtMentionIndex > 0 &&
                      (newValue[activeAtMentionIndex - 1] === " " ||
                        newValue[activeAtMentionIndex - 1] === "\u00A0")
                    const oldActiveMentionStillValidlyPlaced =
                      oldActiveMentionIsFirst || oldActiveMentionPrecededBySpace

                    // Close the box if:
                    // 1. Cursor has moved to or before the previously active '@'.
                    // 2. The character at the old activeAtMentionIndex is no longer an '@'.
                    // 3. The placement of the old active '@' is no longer valid (e.g., preceding space removed).
                    if (
                      cursorPosition <= activeAtMentionIndex ||
                      !oldActiveMentionStillIsAt ||
                      !oldActiveMentionStillValidlyPlaced
                    ) {
                      setShowReferenceBox(false)
                      setActiveAtMentionIndex(-1)
                      setReferenceSearchTerm("") // Clear search term when box closes
                    }
                    // Otherwise, the box remains open (e.g., user is typing after a valid '@').
                  }
                }
                adjustInputHeight()
              }}
              onKeyDown={(e) => {
                if (showReferenceBox) {
                  handleReferenceKeyDown(
                    e as React.KeyboardEvent<
                      HTMLTextAreaElement | HTMLInputElement
                    >,
                  )
                  if (e.defaultPrevented) return
                }

                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  query.trim().length > 0
                ) {
                  e.preventDefault()
                  handleSendMessage()
                }
              }}
              style={{
                minHeight: "52px",
                maxHeight: "320px",
              }}
              onFocus={(e) => {
                const target = e.target
                setTimeout(() => {
                  if (document.activeElement === target) {
                    const len = target.textContent?.length || 0
                    setCaretPosition(inputRef.current as Node, len)
                  }
                }, 0)
              }}
              onClick={(e) => {
                const target = e.target as HTMLElement
                const anchor = target.closest("a")

                if (
                  anchor &&
                  anchor.href &&
                  anchor.closest(SELECTORS.CHAT_INPUT) === inputRef.current
                ) {
                  // If it's an anchor with an href *inside our contentEditable div*
                  e.preventDefault() // Prevent default contentEditable behavior first

                  // Check if the clicked anchor is an "OtherContacts" pill
                  if (anchor.dataset.entity === "OtherContacts") {
                    // For "OtherContacts" pills, do nothing further (link should not open)
                    return
                  }

                  // For other pills or regular links, open the link in a new tab
                  window.open(anchor.href, "_blank", "noopener,noreferrer")
                  // Stop further processing to avoid @mention box logic if a link was clicked
                  return
                }

                // Original onClick logic for @mention box (if no link was clicked and handled)
                // This part was the first onClick handler's body
                const cursorPosition = getCaretCharacterOffsetWithin(
                  inputRef.current as Node,
                )
                if (
                  showReferenceBox &&
                  activeAtMentionIndex !== -1 &&
                  cursorPosition <= activeAtMentionIndex
                ) {
                  setShowReferenceBox(false)
                  setActiveAtMentionIndex(-1)
                  setReferenceSearchTerm("")
                }
              }}
            />
          </div>

          {/* File Attachments Preview */}
          {selectedFiles.length > 0 && (
            <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-600">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  Attachments ({selectedFiles.length}/{MAX_ATTACHMENTS})
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {selectedFiles.map((selectedFile) => (
                  <div key={selectedFile.id} className="relative group">
                    {selectedFile.preview ? (
                      <div
                        className="relative w-20 h-20 rounded-lg overflow-hidden bg-center bg-cover border border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500 transition-colors"
                        style={{
                          backgroundImage: `url(${selectedFile.preview})`,
                        }}
                      >
                        <div className="absolute top-1 left-1 flex gap-1">
                          {selectedFile.uploading && (
                            <div className="bg-black bg-opacity-60 rounded-full p-1">
                              <Loader2
                                size={10}
                                className="text-white animate-spin"
                              />
                            </div>
                          )}
                          {selectedFile.uploadError && (
                            <div
                              className="bg-red-500 bg-opacity-80 rounded-full p-1"
                              title={selectedFile.uploadError}
                            >
                              <span className="text-white text-xs">⚠</span>
                            </div>
                          )}
                          {selectedFile.metadata?.fileId && (
                            <div className="bg-green-500 bg-opacity-80 rounded-full p-1">
                              <Check size={10} className="text-white" />
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => removeFile(selectedFile.id)}
                          className="absolute top-1 right-1 bg-black bg-opacity-60 text-white rounded-full p-1 hover:bg-opacity-80 transition-opacity"
                          disabled={selectedFile.uploading}
                        >
                          <X size={10} />
                        </button>
                        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-1">
                          <span
                            className="text-white text-xs truncate block"
                            title={selectedFile.file.name}
                          >
                            {selectedFile.file.name.length > 12
                              ? `${selectedFile.file.name.substring(0, 9)}...`
                              : selectedFile.file.name}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-700 rounded-lg border border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500 transition-colors min-w-0">
                        <File
                          size={24}
                          className="text-gray-500 dark:text-gray-400 flex-shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <span
                            className="text-sm text-gray-700 dark:text-gray-300 truncate block max-w-[120px]"
                            title={selectedFile.file.name}
                          >
                            {selectedFile.file.name}
                          </span>
                          <span
                            className="text-xs text-gray-500 dark:text-gray-400 truncate block max-w-[120px]"
                            title={getExtension(selectedFile.file)}
                          >
                            {getExtension(selectedFile.file)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {selectedFile.uploading && (
                            <Loader2
                              size={12}
                              className="text-blue-500 animate-spin"
                            />
                          )}
                          {selectedFile.uploadError && (
                            <span
                              className="text-xs text-red-500"
                              title={selectedFile.uploadError}
                            >
                              ⚠️
                            </span>
                          )}
                          {selectedFile.metadata?.fileId && (
                            <Check size={12} className="text-green-500" />
                          )}
                          <button
                            onClick={() => removeFile(selectedFile.id)}
                            className="text-gray-400 hover:text-red-500 transition-colors p-1"
                            disabled={selectedFile.uploading}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {isUploadingFiles && (
                <div className="mt-2 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
                  <Loader2 size={12} className="animate-spin" />
                  Uploading files...
                </div>
              )}
              {selectedFiles.length >= MAX_ATTACHMENTS && (
                <div className="mt-2 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                  <span>⚠️</span>
                  Maximum attachments reached ({MAX_ATTACHMENTS})
                </div>
              )}
            </div>
          )}

          <div className="flex ml-[16px] mr-[6px] mb-[6px] items-center space-x-3 pt-1 pb-1">
            <Attach
              className={`${
                selectedFiles.length >= MAX_ATTACHMENTS
                  ? "text-gray-300 dark:text-gray-600 cursor-not-allowed"
                  : "text-[#464D53] dark:text-gray-400 cursor-pointer hover:text-[#2563eb] dark:hover:text-blue-400"
              } transition-colors`}
              onClick={
                selectedFiles.length >= MAX_ATTACHMENTS
                  ? undefined
                  : handleFileSelect
              }
              title={
                selectedFiles.length >= MAX_ATTACHMENTS
                  ? `Maximum ${MAX_ATTACHMENTS} attachments allowed`
                  : "Attach files"
              }
            />
            {showAdvancedOptions && (
              <>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Globe
                        size={16}
                        className={`cursor-pointer transition-colors ${
                          enableWebSearch
                            ? "text-blue-600 dark:text-blue-400"
                            : "text-[#464D53] dark:text-gray-400"
                        }`}
                        onClick={() => setEnableWebSearch(!enableWebSearch)}
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        {enableWebSearch
                          ? "Disable web search"
                          : "Enable web search"}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <AtSign
                  size={16}
                  className={`text-[#464D53] dark:text-gray-400 cursor-pointer ${CLASS_NAMES.REFERENCE_TRIGGER}`}
                  onClick={() => {
                    const input = inputRef.current
                    if (!input) return

                    const textContentBeforeAt = input.textContent || ""

                    const textToAppend =
                      textContentBeforeAt.length === 0 ||
                      textContentBeforeAt.endsWith(" ") ||
                      textContentBeforeAt.endsWith("\n") ||
                      textContentBeforeAt.endsWith("\u00A0")
                        ? "@"
                        : " @"

                    const atTextNode = document.createTextNode(textToAppend)

                    input.appendChild(atTextNode)

                    const newTextContent = input.textContent || ""
                    setQuery(newTextContent)
                    setIsPlaceholderVisible(newTextContent.length === 0)

                    const newAtSymbolIndex =
                      textContentBeforeAt.length +
                      (textToAppend === " @" ? 1 : 0)
                    setCaretPosition(input, newTextContent.length)

                    setActiveAtMentionIndex(newAtSymbolIndex)
                    setReferenceSearchTerm("")
                    setShowReferenceBox(true)
                    updateReferenceBoxPosition(newAtSymbolIndex)
                    setSearchMode("citations")
                    setGlobalResults([])
                    setGlobalError(null)
                    setPage(1)
                    setTotalCount(0)
                    setSelectedRefIndex(-1)

                    input.focus()
                  }}
                />
              </>
            )}
            {/* Dropdown for All Connectors */}
            {showAdvancedOptions &&
              (role === UserRole.SuperAdmin || role === UserRole.Admin) && (
                <DropdownMenu
                  open={isConnectorsMenuOpen && isAgenticMode}
                  onOpenChange={(open) => {
                    if (isAgenticMode) {
                      setIsConnectorsMenuOpen(open)
                    }
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <button
                      ref={connectorsDropdownTriggerRef}
                      disabled={!isAgenticMode}
                      className={`flex items-center gap-1 px-3 py-1 rounded-full text-sm ${
                        isAgenticMode
                          ? "bg-gray-100 hover:bg-gray-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-gray-700 dark:text-slate-300 cursor-pointer"
                          : "bg-gray-50 dark:bg-slate-800 text-gray-400 dark:text-slate-500 cursor-not-allowed opacity-60"
                      }`}
                      title={
                        !isAgenticMode
                          ? "Enable Agent mode to use MCP connectors"
                          : ""
                      }
                    >
                      {selectedConnectorIds.size > 0 ? (
                        selectedConnectorIds.size === 1 ? (
                          // Single connector selected - show its icon
                          (() => {
                            const selectedConnector = allConnectors.find((c) =>
                              selectedConnectorIds.has(c.id),
                            )
                            return selectedConnector ? (
                              <>
                                {getIcon(
                                  selectedConnector.app,
                                  selectedConnector.type,
                                  { w: 14, h: 14, mr: 0 },
                                )}
                                <span>
                                  {selectedConnector.displayName || "Connector"}
                                </span>
                              </>
                            ) : (
                              <>
                                <Gavel
                                  size={14}
                                  className={
                                    isAgenticMode
                                      ? "text-[#464D53] dark:text-slate-400"
                                      : "text-gray-400 dark:text-slate-500"
                                  }
                                />
                                <span>Mcp</span>
                              </>
                            )
                          })()
                        ) : (
                          // Multiple connectors selected
                          <>
                            <Gavel
                              size={14}
                              className={
                                isAgenticMode
                                  ? "text-[#464D53] dark:text-slate-400"
                                  : "text-gray-400 dark:text-slate-500"
                              }
                            />
                            <span>{selectedConnectorIds.size} Mcps</span>
                          </>
                        )
                      ) : (
                        // No connectors selected
                        <>
                          <Gavel
                            size={14}
                            className={
                              isAgenticMode
                                ? "text-[#464D53] dark:text-slate-400"
                                : "text-gray-400 dark:text-slate-500"
                            }
                          />
                          <span>Mcp</span>
                        </>
                      )}
                      <ChevronDown
                        size={16}
                        className={`ml-1 ${isAgenticMode ? "text-gray-500 dark:text-slate-400" : "text-gray-400 dark:text-slate-500"}`}
                      />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    className="w-72 relative rounded-xl bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700" // Increased width, added dark mode bg and border
                    align="start"
                    side="top"
                  >
                    <DropdownMenuLabel className="p-2 text-gray-700 dark:text-slate-300">
                      Select a Connector
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator className="bg-gray-200 dark:bg-slate-700" />
                    {allConnectors.length > 0 ? (
                      allConnectors
                        .filter((c) => c.type === ConnectorType.MCP)
                        .map((connector) => {
                          const isMCP = connector.type === ConnectorType.MCP

                          return (
                            <DropdownMenuItem
                              key={connector.id}
                              onSelect={(e) => e.preventDefault()} // Prevent closing on item click if it has a sub-menu
                              className="p-0" // Remove padding for full-width item
                            >
                              <div
                                className="flex items-center justify-between w-full px-2 py-1.5 cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                                onClick={() => {
                                  const isCurrentlySelected =
                                    selectedConnectorIds.has(connector.id)

                                  if (isCurrentlySelected) {
                                    // If clicking the already selected connector, deselect it
                                    setSelectedConnectorIds((prev) => {
                                      const newSet = new Set(prev)
                                      newSet.delete(connector.id)
                                      return newSet
                                    })
                                    setConnectorTools([]) // Clear any tools
                                    // Close the tool selection modal if it's open for this connector
                                    if (
                                      isToolSelectionModalOpen &&
                                      activeToolConnectorId === connector.id
                                    ) {
                                      setIsToolSelectionModalOpen(false)
                                      setActiveToolConnectorId(null)
                                    }
                                    // Keep the main dropdown open or close it based on desired UX for deselection.
                                    // For now, let's assume it stays open.
                                  } else {
                                    // Clicking a new connector to add it to selection
                                    setSelectedConnectorIds((prev) => {
                                      const newSet = new Set(prev)
                                      newSet.add(connector.id)
                                      return newSet
                                    })
                                    if (!isMCP) {
                                      // For non-MCP connectors, preserve existing selections or initialize empty
                                      setConnectorTools([])
                                      // Don't override existing selections, they should be preserved from localStorage
                                      if (
                                        !selectedConnectorTools[connector.id]
                                      ) {
                                        setSelectedConnectorTools((prev) => ({
                                          ...prev,
                                          [connector.id]: new Set(),
                                        }))
                                      }
                                      // Don't close dropdown for multiple selections
                                    } else {
                                      // For MCP connectors, clear tools from any previously selected MCP.
                                      setConnectorTools([])
                                      // Tool fetching for this MCP connector is handled by PlusCircle click.
                                      // Dropdown stays open.
                                    }
                                  }
                                }}
                              >
                                <div className="flex items-center gap-2 flex-grow">
                                  {getIcon(connector.app, connector.type, {
                                    w: 14,
                                    h: 14,
                                    mr: 0,
                                  })}
                                  <span className="truncate text-gray-900 dark:text-slate-100">
                                    {connector.displayName}
                                  </span>
                                </div>

                                {/* Icons container - aligned to the right */}
                                <div className="flex items-center ml-auto">
                                  {selectedConnectorIds.has(connector.id) && (
                                    <Check
                                      className={`h-4 w-4 text-green-500 dark:text-green-400 flex-shrink-0 ${isMCP ? "mr-1.5" : ""}`}
                                    />
                                  )}
                                  {isMCP && (
                                    <PlusCircle
                                      size={18}
                                      className="text-blue-500 dark:text-blue-400 cursor-pointer flex-shrink-0" // Margin is handled by Check or lack thereof
                                      onClick={async (e) => {
                                        e.stopPropagation() // IMPORTANT: Prevent main item click handler

                                        // Ensure this connector is marked as active if not already
                                        if (
                                          !selectedConnectorIds.has(
                                            connector.id,
                                          )
                                        ) {
                                          setSelectedConnectorIds((prev) => {
                                            const newSet = new Set(prev)
                                            newSet.add(connector.id)
                                            return newSet
                                          })
                                          setConnectorTools([]) // Clear tools if switching to this MCP
                                        } else if (
                                          !connectorTools.length &&
                                          selectedConnectorIds.has(connector.id)
                                        ) {
                                          // If it's already selected but tools aren't loaded (e.g. re-opening modal)
                                          // proceed to load them.
                                        }

                                        // Set this connector as the active one for tool selection
                                        setActiveToolConnectorId(connector.id)

                                        if (
                                          connectorsDropdownTriggerRef.current
                                        ) {
                                          const rect =
                                            connectorsDropdownTriggerRef.current.getBoundingClientRect()
                                          const chatBoxContainer =
                                            inputRef.current?.closest(
                                              ".relative.flex.flex-col.w-full",
                                            ) as HTMLElement | null
                                          const connectorDropdownWidth = 288 // w-72
                                          const gap = 8

                                          let preliminaryLeftCalc: number
                                          let preliminaryTopReference: number

                                          if (chatBoxContainer) {
                                            const containerRect =
                                              chatBoxContainer.getBoundingClientRect()
                                            preliminaryLeftCalc =
                                              rect.left -
                                              containerRect.left +
                                              connectorDropdownWidth +
                                              gap
                                            preliminaryTopReference =
                                              rect.top - containerRect.top
                                          } else {
                                            preliminaryLeftCalc =
                                              rect.left +
                                              connectorDropdownWidth +
                                              gap
                                            preliminaryTopReference = rect.top
                                          }
                                          setToolModalPosition({
                                            top: preliminaryTopReference,
                                            left: preliminaryLeftCalc,
                                          })
                                        }

                                        setIsLoadingTools(true)
                                        setToolSearchTerm("")
                                        try {
                                          const response: Response =
                                            await api.admin.connector[
                                              connector.id
                                            ].tools.$get(undefined, {
                                              credentials: "include",
                                            })
                                          const toolsData: FetchedTool[] | any =
                                            await response.json()
                                          if (Array.isArray(toolsData)) {
                                            const enabledTools =
                                              toolsData.filter(
                                                (tool) => tool.enabled,
                                              )
                                            setConnectorTools(enabledTools)

                                            // Check if we have existing selections from localStorage for this connector
                                            const existingSelections =
                                              selectedConnectorTools[
                                                connector.id
                                              ]

                                            if (
                                              existingSelections &&
                                              existingSelections.size > 0
                                            ) {
                                              // Use existing selections from localStorage, but only for enabled tools
                                              const enabledToolExternalIds =
                                                new Set(
                                                  enabledTools.map(
                                                    (t) => t.externalId,
                                                  ),
                                                )
                                              const validSelections = new Set(
                                                Array.from(
                                                  existingSelections,
                                                ).filter((toolExternalId) =>
                                                  enabledToolExternalIds.has(
                                                    toolExternalId,
                                                  ),
                                                ),
                                              )

                                              setSelectedConnectorTools(
                                                (prev) => ({
                                                  ...prev,
                                                  [connector.id]:
                                                    validSelections,
                                                }),
                                              )
                                            } else {
                                              // No existing selections, default to all enabled tools being selected
                                              const initiallySelectedEnabledTools =
                                                new Set(
                                                  enabledTools.map(
                                                    (t) => t.externalId,
                                                  ),
                                                )
                                              setSelectedConnectorTools(
                                                (prev) => ({
                                                  ...prev,
                                                  [connector.id]:
                                                    initiallySelectedEnabledTools,
                                                }),
                                              )
                                            }
                                          } else {
                                            setConnectorTools([])
                                            // Ensure no selections if tools aren't loaded correctly or if data is not an array
                                            setSelectedConnectorTools(
                                              (prev) => ({
                                                ...prev,
                                                [connector.id]: new Set(),
                                              }),
                                            )
                                          }
                                        } catch (error) {
                                          console.error(
                                            `Error fetching tools for ${connector.id}:`,
                                            error,
                                          )
                                          setConnectorTools([])
                                          // Clear selections for this connector on error
                                          setSelectedConnectorTools((prev) => ({
                                            ...prev,
                                            [connector.id]: new Set(),
                                          }))
                                        } finally {
                                          setIsLoadingTools(false)
                                          setIsToolSelectionModalOpen(true)
                                          // Main dropdown (isConnectorsMenuOpen) should remain open
                                        }
                                      }}
                                    />
                                  )}
                                </div>
                              </div>
                            </DropdownMenuItem>
                          )
                        })
                    ) : (
                      <DropdownMenuItem
                        disabled
                        className="text-center text-gray-500 dark:text-slate-400"
                      >
                        No connectors available
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

            {/* Tool Selection Modal / Popover */}
            {showAdvancedOptions &&
              isToolSelectionModalOpen &&
              activeToolConnectorId &&
              toolModalPosition &&
              allConnectors.find((c) => c.id === activeToolConnectorId)
                ?.type === ConnectorType.MCP && (
                <div
                  ref={toolModalRef}
                  className="absolute bg-white dark:bg-slate-800 rounded-lg shadow-xl p-4 z-50 border border-gray-200 dark:border-slate-700"
                  style={{
                    top: `${toolModalPosition.top}px`,
                    left: `${toolModalPosition.left}px`,
                    width: "280px", // Smaller width
                    maxHeight: "300px", // Max height for scroll
                  }}
                  onClick={(e) => e.stopPropagation()} // Prevent clicks inside from closing it if it's part of a larger clickable area
                >
                  <div className="flex flex-col h-full">
                    <div className="flex justify-between items-center mb-2">
                      <h3 className="text-md font-semibold text-gray-900 dark:text-slate-100">
                        Tools for{" "}
                        {
                          allConnectors.find(
                            (c) => c.id === activeToolConnectorId,
                          )?.displayName
                        }
                      </h3>
                      <button
                        onClick={() => setIsToolSelectionModalOpen(false)}
                        className="text-gray-500 hover:text-gray-700 dark:text-slate-400 dark:hover:text-slate-200"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          fill="none"
                          viewBox="0 0 24 24"
                          strokeWidth={1.5}
                          stroke="currentColor"
                          className="w-5 h-5"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </div>
                    <Input
                      type="text"
                      placeholder="Search tools..."
                      value={toolSearchTerm}
                      onChange={(e) => setToolSearchTerm(e.target.value)}
                      className="mb-2 text-sm"
                    />
                    {isLoadingTools ? (
                      <p className="text-sm text-gray-500 dark:text-slate-400 text-center py-4">
                        Loading tools...
                      </p>
                    ) : (
                      <div
                        className="overflow-y-auto"
                        style={{ maxHeight: "180px" }}
                      >
                        {" "}
                        {/* Explicit max-height for scrolling */}
                        {connectorTools.filter((tool) =>
                          tool.toolName
                            .toLowerCase()
                            .includes(toolSearchTerm.toLowerCase()),
                        ).length > 0 ? (
                          connectorTools
                            .filter((tool) =>
                              tool.toolName
                                .toLowerCase()
                                .includes(toolSearchTerm.toLowerCase()),
                            )
                            .map((tool) => (
                              <div
                                key={tool.id}
                                className="flex items-center justify-between py-1.5 hover:bg-gray-50 dark:hover:bg-slate-700 rounded px-1 cursor-pointer"
                                onClick={() => {
                                  setSelectedConnectorTools((prev) => {
                                    const newSelected = new Set(
                                      prev[activeToolConnectorId!] || [],
                                    )
                                    if (newSelected.has(tool.externalId)) {
                                      newSelected.delete(tool.externalId)
                                    } else {
                                      newSelected.add(tool.externalId)
                                    }
                                    return {
                                      ...prev,
                                      [activeToolConnectorId!]: newSelected,
                                    }
                                  })
                                }}
                              >
                                <span
                                  className="text-sm flex-grow mr-2 truncate text-gray-800 dark:text-slate-200"
                                  title={tool.description || tool.toolName}
                                >
                                  {tool.toolName}
                                </span>
                                <div className="h-4 w-4 flex items-center justify-center">
                                  {(
                                    selectedConnectorTools[
                                      activeToolConnectorId!
                                    ] || new Set()
                                  ).has(tool.externalId) && (
                                    <Check className="h-4 w-4 text-green-500 dark:text-green-400" />
                                  )}
                                </div>
                              </div>
                            ))
                        ) : (
                          <p className="text-sm text-gray-500 dark:text-slate-400 text-center py-4">
                            No tools found
                            {toolSearchTerm ? ` for "${toolSearchTerm}"` : ""}.
                          </p>
                        )}
                      </div>
                    )}
                    {/* "Done" button can be removed if selection is immediate, or kept for explicit confirmation */}
                    {/* <button
                  onClick={() => setIsToolSelectionModalOpen(false)}
                  className="mt-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold py-1.5 px-3 rounded text-sm self-end"
                >
                  Done
                </button> */}
                  </div>
                </div>
              )}

            {showSourcesButton && ( // Added this condition because currently it's backend is not ready therefore we are not showing it
              <DropdownMenu
                open={isSourceMenuOpen}
                onOpenChange={setIsSourceMenuOpen}
              >
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-1 px-3 py-1 rounded-full bg-[#EDF2F7] dark:bg-slate-700 hover:bg-gray-200 dark:hover:bg-slate-600 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                    {selectedSourcesCount === 0 ? (
                      <>
                        <Layers
                          size={14}
                          className="text-[#464D53] dark:text-gray-400"
                        />
                        <span>Sources</span>
                      </>
                    ) : (
                      <>
                        {selectedSourceItems.map((item) => (
                          <span key={item.id} className="flex items-center">
                            {getIcon(item.app, item.entity, {
                              w: 14,
                              h: 14,
                              mr: 0,
                            })}
                          </span>
                        ))}
                        <span>
                          {selectedSourcesCount} source
                          {selectedSourcesCount > 1 ? "s" : ""}
                        </span>
                      </>
                    )}
                    <ChevronDown
                      size={16}
                      className="ml-1 text-gray-500 dark:text-gray-400"
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="w-56 relative rounded-xl"
                  align="start"
                  side="top"
                >
                  <div className="flex items-center justify-between px-2 py-1.5">
                    <DropdownMenuLabel className="p-0">
                      Filter Sources
                    </DropdownMenuLabel>
                    {selectedSourcesCount > 0 ? (
                      <TooltipProvider delayDuration={100}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={handleClearAllSources}
                              className="p-1 rounded-full hover:bg-[#EDF2F7] dark:hover:bg-slate-600 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                              aria-label="Clear all selected sources"
                            >
                              <RotateCcw size={16} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent
                            side="bottom"
                            className="bg-black text-white text-xs rounded-sm"
                          >
                            <p>Clear all</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <button
                        className="p-1 rounded-full text-transparent"
                        aria-label="No sources to clear"
                        disabled
                      >
                        <RotateCcw size={16} />
                      </button>
                    )}
                  </div>
                  <DropdownMenuSeparator />
                  {availableSources.map((source) => {
                    const isChecked = selectedSources[source.id] || false
                    return (
                      <DropdownMenuItem
                        key={source.id}
                        onClick={() =>
                          handleSourceSelectionChange(source.id, !isChecked)
                        }
                        onSelect={(e) => e.preventDefault()}
                        className="relative flex items-center pl-2 pr-2 gap-2 cursor-pointer"
                      >
                        <div className="flex itemsbinoculars flex items-center gap-2">
                          {getIcon(source.app, source.entity, {
                            w: 16,
                            h: 16,
                            mr: 0,
                          })}
                          <span>{source.name}</span>
                        </div>
                        <div
                          className={`ml-auto h-5 w-5 border rounded flex items-center justify-center ${
                            isChecked
                              ? "bg-green-500 border-green-500"
                              : "border-gray-400 dark:border-gray-500"
                          }`}
                        >
                          {isChecked && (
                            <Check className="h-4 w-4 text-white" />
                          )}
                        </div>
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {/* Closing tag for the conditional render */}
            <div className="flex items-center">
              <button
                onClick={() => setIsReasoningActive(!isReasoningActive)}
                className={`flex items-center space-x-1 px-2 py-1 rounded-md text-[15px] ${
                  isReasoningActive
                    ? "text-green-600 dark:text-green-400"
                    : "text-[#464D53] dark:text-gray-400"
                }`}
              >
                <Atom
                  size={16}
                  className={
                    isReasoningActive
                      ? "text-green-600 dark:text-green-400"
                      : "dark:text-gray-400"
                  }
                />
                <span className={isReasoningActive ? "" : "dark:text-gray-300"}>
                  Reasoning
                </span>
              </button>
            </div>
            {showAdvancedOptions && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setIsAgenticMode(!isAgenticMode)
                }}
                disabled={selectedAgent ? !selectedAgent.isRagOn : false}
                className={`flex items-center justify-center rounded-full cursor-pointer mr-[18px] disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <Infinity
                  size={14}
                  strokeWidth={2.4}
                  className={`${isAgenticMode ? "text-blue-500" : "text-[#464D53]"} ${isAgenticMode ? "font-medium" : ""}`}
                />
                <span
                  className={`text-[14px] leading-[16px] ml-[4px] select-none font-medium ${isAgenticMode ? "text-blue-500" : "text-[#464D53]"}`}
                >
                  Agent
                </span>
              </button>
            )}
            {(isStreaming || retryIsStreaming) && chatId ? (
              <button
                onClick={handleStop}
                style={{ marginLeft: "auto" }}
                className="flex mr-6 bg-[#464B53] dark:bg-gray-700 text-white dark:text-gray-200 hover:bg-[#5a5f66] dark:hover:bg-gray-600 rounded-full w-[32px] h-[32px] items-center justify-center"
              >
                <Square className="text-white dark:text-gray-200" size={16} />
              </button>
            ) : (
              <button
                disabled={isStreaming || retryIsStreaming || isUploadingFiles}
                onClick={() => handleSendMessage()}
                style={{ marginLeft: "auto" }}
                className="flex mr-6 bg-[#464B53] dark:bg-slate-700 text-white dark:text-slate-200 hover:bg-[#5a5f66] dark:hover:bg-slate-600 rounded-full w-[32px] h-[32px] items-center justify-center disabled:opacity-50"
              >
                {isUploadingFiles ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <ArrowRight
                    className="text-white dark:text-slate-200"
                    size={16}
                  />
                )}
              </button>
            )}
          </div>
        </div>

        {/* Hidden File Input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileChange}
          accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
        />
      </div>
    )
  },
)
