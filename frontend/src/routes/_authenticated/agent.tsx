import {
  createFileRoute,
  useRouterState,
  useNavigate,
} from "@tanstack/react-router"
import { z } from "zod"
import { Sidebar } from "@/components/Sidebar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu"
import { getIcon } from "@/lib/common"
import { getName } from "@/components/GroupFilter"
import {
  Apps,
  ChatSSEvents,
  DriveEntity,
  type SelectPublicMessage,
  type Citation,
  type SelectPublicAgent,
  type AttachmentMetadata,
  SlackEntity,
} from "shared/types"
import {
  ChevronDown,
  ChevronUp,
  X as LucideX,
  Check,
  RotateCcw,
  RefreshCw,
  PlusCircle,
  Plus,
  Copy,
  ArrowLeft,
  Edit3,
  Trash2,
  Search,
  UserPlus,
  Star,
  Users,
  Sparkles,
  ChevronLeft,
  ChevronRight,
} from "lucide-react"
import { useState, useMemo, useEffect, useRef } from "react"
import { useTheme } from "@/components/ThemeContext"
import MarkdownPreview from "@uiw/react-markdown-preview"
import { api } from "@/api"
import AssistantLogo from "@/assets/assistant-logo.svg"
import RetryAsset from "@/assets/retry.svg"
import { splitGroupedCitationsWithSpaces } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { toast, useToast } from "@/hooks/use-toast"
import { ChatBox } from "@/components/ChatBox"
import { Card, CardContent } from "@/components/ui/card"
import { ConfirmModal } from "@/components/ui/confirmModal"
import { AgentCard, AgentIconDisplay } from "@/components/AgentCard"
import { AttachmentGallery } from "@/components/AttachmentGallery"
import { createAuthEventSource } from "@/hooks/useChatStream"

type CurrentResp = {
  resp: string
  chatId?: string
  messageId?: string
  sources?: Citation[]
  citationMap?: Record<number, number>
  thinking?: string
}

const REASONING_STATE_KEY = "isAgentReasoningGlobalState"

export const Route = createFileRoute("/_authenticated/agent")({
  validateSearch: z.object({
    agentId: z.string().optional(),
  }),
  component: AgentComponent,
})

interface CustomBadgeProps {
  text: string
  onRemove: () => void
  icon?: React.ReactNode
}

interface FetchedDataSource {
  docId: string
  name: string
  app: string
  entity: string
}

const CustomBadge: React.FC<CustomBadgeProps> = ({ text, onRemove, icon }) => {
  return (
    <div className="flex items-center justify-center bg-slate-100 dark:bg-slate-600 text-slate-700 dark:text-slate-200 text-xs font-medium pl-2 pr-1 py-1 rounded-md border border-slate-200 dark:border-slate-500">
      {icon && <span className="mr-1 flex items-center">{icon}</span>}
      <span>{text}</span>
      <LucideX
        className="ml-1.5 h-3.5 w-3.5 cursor-pointer hover:text-red-500 dark:hover:text-red-400"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
      />
    </div>
  )
}

interface IntegrationSource {
  id: string
  name: string
  app: Apps | string
  entity: string
  icon: React.ReactNode
}

const availableIntegrationsList: IntegrationSource[] = [
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

const AGENT_ENTITY_SEARCH_EXCLUSIONS: { app: string; entity: string }[] = [
  { app: Apps.Slack, entity: SlackEntity.Message },
]

interface User {
  id: number
  name: string
  email: string
}

function AgentComponent() {
  const { agentId } = Route.useSearch()
  const navigate = useNavigate()
  const [viewMode, setViewMode] = useState<"list" | "create" | "edit">("list")
  const [allAgentsList, setAllAgentsList] = useState<SelectPublicAgent[]>([])
  const [madeByMeAgentsList, setMadeByMeAgentsList] = useState<
    SelectPublicAgent[]
  >([])
  const [sharedToMeAgentsList, setSharedToMeAgentsList] = useState<
    SelectPublicAgent[]
  >([])
  const [editingAgent, setEditingAgent] = useState<SelectPublicAgent | null>(
    null,
  )
  const [selectedChatAgentExternalId, setSelectedChatAgentExternalId] =
    useState<string | null>(null)
  const [initialChatAgent, setInitialChatAgent] =
    useState<SelectPublicAgent | null>(null)
  const [, setIsLoadingInitialAgent] = useState(false)

  const [selectedModel, setSelectedModel] = useState("Auto")

  const [agentName, setAgentName] = useState("")
  const [agentDescription, setAgentDescription] = useState("")
  const [agentPrompt, setAgentPrompt] = useState("")
  const [isPublic, setIsPublic] = useState(false)
  const [isRagOn, setIsRagOn] = useState(true)

  // Prompt generation states
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false)
  const [shouldHighlightPrompt, setShouldHighlightPrompt] = useState(false)
  const promptGenerationEventSourceRef = useRef<EventSource | null>(null)
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null)

  const [fetchedDataSources, setFetchedDataSources] = useState<
    FetchedDataSource[]
  >([])
  const [selectedIntegrations, setSelectedIntegrations] = useState<
    Record<string, boolean>
  >({})
  const [isIntegrationMenuOpen, setIsIntegrationMenuOpen] = useState(false)
  const [selectedEntities, setSelectedEntities] = useState<FetchedDataSource[]>(
    [],
  )
  const [entitySearchQuery, setEntitySearchQuery] = useState("")
  const [entitySearchResults, setEntitySearchResults] = useState<
    FetchedDataSource[]
  >([])
  const [showEntitySearchResults, setShowEntitySearchResults] = useState(false)

  const [query, setQuery] = useState("")
  const [messages, setMessages] = useState<SelectPublicMessage[]>([])
  const [chatId, setChatId] = useState<string | null>(null)
  const [currentResp, setCurrentResp] = useState<CurrentResp | null>(null)
  const [stopMsg, setStopMsg] = useState<boolean>(false)

  const currentRespRef = useRef<CurrentResp | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const [userHasScrolled, setUserHasScrolled] = useState(false)
  const [dots, setDots] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [allCitations, _] = useState<Map<string, Citation>>(new Map())
  const eventSourceRef = useRef<EventSource | null>(null)
  const [userStopped, setUserStopped] = useState<boolean>(false)

  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [confirmModalTitle, setConfirmModalTitle] = useState("")
  const [confirmModalMessage, setConfirmModalMessage] = useState("")
  const [confirmAction, setConfirmAction] = useState<
    (() => Promise<void>) | null
  >(null)

  const [isReasoningActive, setIsReasoningActive] = useState(() => {
    const storedValue = localStorage.getItem(REASONING_STATE_KEY)
    return storedValue ? JSON.parse(storedValue) : false
  })

  useEffect(() => {
    localStorage.setItem(REASONING_STATE_KEY, JSON.stringify(isReasoningActive))
  }, [isReasoningActive])

  const matches = useRouterState({ select: (s) => s.matches })
  const { user, agentWhiteList } = matches[matches.length - 1].context
  const { toast: showToast } = useToast()

  useEffect(() => {
    if (entitySearchQuery.trim() === "") {
      setEntitySearchResults([])
      setShowEntitySearchResults(false)
      return
    }

    const searchEntities = async () => {
      try {
        const response = await api.search.$get({
          query: {
            query: entitySearchQuery,
          },
        })

        if (response.ok) {
          console.log("Entity search response:")
          const data = await response.json()
          // @ts-ignore
          const results = (data.results || []) as FetchedDataSource[]

          const selectedEntityIds = new Set(
            selectedEntities.map((entity) => entity.docId),
          )

          const filteredResults = results.filter((r) => {
            const isAlreadySelected = selectedEntityIds.has(r.docId)

            const isExcluded = AGENT_ENTITY_SEARCH_EXCLUSIONS.some(
              (exclusion) =>
                exclusion.app === r.app && exclusion.entity === r.entity,
            )

            return !isAlreadySelected && !isExcluded
          })
          setEntitySearchResults(filteredResults)
          setShowEntitySearchResults(true)
        }
      } catch (error) {
        console.error("Failed to search entities", error)
      }
    }

    const debounceSearch = setTimeout(() => {
      searchEntities()
    }, 300)

    return () => clearTimeout(debounceSearch)
  }, [entitySearchQuery, selectedEntities])

  const [users, setUsers] = useState<User[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [filteredUsers, setFilteredUsers] = useState<User[]>([])
  const [selectedUsers, setSelectedUsers] = useState<User[]>([])
  const [showSearchResults, setShowSearchResults] = useState(false)
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(-1)
  const [isAgenticMode, setIsAgenticMode] = useState(Boolean(false))
  const searchResultsRef = useRef<HTMLDivElement>(null)
  const [listSearchQuery, setListSearchQuery] = useState("")
  const [testAgentIsRagOn, setTestAgentIsRagOn] = useState(true)
  const [activeTab, setActiveTab] = useState<
    "all" | "shared-to-me" | "made-by-me"
  >("all")
  const [showAllFavorites, setShowAllFavorites] = useState(false)
  const [isLoadingAgents, setIsLoadingAgents] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const agentsPerPage = 10

  const FAVORITE_AGENTS_STORAGE_KEY = "favoriteAgentsList"

  const [favoriteAgents, setFavoriteAgents] = useState<string[]>(() => {
    const storedFavorites = localStorage.getItem(FAVORITE_AGENTS_STORAGE_KEY)
    return storedFavorites ? JSON.parse(storedFavorites) : []
  })

  useEffect(() => {
    localStorage.setItem(
      FAVORITE_AGENTS_STORAGE_KEY,
      JSON.stringify(favoriteAgents),
    )
  }, [favoriteAgents])

  const handleTabChange = (tab: "all" | "shared-to-me" | "made-by-me") => {
    setActiveTab(tab)
    setCurrentPage(1)
  }

  const handleListSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setListSearchQuery(e.target.value)
    setCurrentPage(1)
  }

  const toggleFavorite = (agentExternalId: string) => {
    setFavoriteAgents((prevFavorites) =>
      prevFavorites.includes(agentExternalId)
        ? prevFavorites.filter((id) => id !== agentExternalId)
        : [...prevFavorites, agentExternalId],
    )
  }

  useEffect(() => {
    setSelectedSearchIndex(-1)
  }, [searchQuery])

  useEffect(() => {
    if (selectedSearchIndex >= 0 && searchResultsRef.current) {
      const container = searchResultsRef.current
      const selectedElement = container.children[
        selectedSearchIndex
      ] as HTMLElement

      if (selectedElement) {
        const containerRect = container.getBoundingClientRect()
        const elementRect = selectedElement.getBoundingClientRect()

        if (elementRect.bottom > containerRect.bottom) {
          selectedElement.scrollIntoView({ behavior: "smooth", block: "end" })
        } else if (elementRect.top < containerRect.top) {
          selectedElement.scrollIntoView({ behavior: "smooth", block: "start" })
        }
      }
    }
  }, [selectedSearchIndex])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (filteredUsers.length === 0) return

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        setSelectedSearchIndex((prev) =>
          prev >= filteredUsers.length - 1 ? 0 : prev + 1,
        )
        break
      case "ArrowUp":
        e.preventDefault()
        setSelectedSearchIndex((prev) =>
          prev <= 0 ? filteredUsers.length - 1 : prev - 1,
        )
        break
      case "Enter":
        e.preventDefault()
        if (selectedSearchIndex >= 0) {
          handleSelectUser(filteredUsers[selectedSearchIndex])
        } else if (filteredUsers.length > 0) {
          handleSelectUser(filteredUsers[0])
        }
        break
    }
  }

  useEffect(() => {
    if (searchQuery.trim() === "") {
      setFilteredUsers([])
      setShowSearchResults(false)
    } else {
      const filtered = users.filter(
        (user) =>
          !selectedUsers.some((selected) => selected.id === user.id) &&
          (user.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            user.email.toLowerCase().includes(searchQuery.toLowerCase())),
      )
      setFilteredUsers(filtered)
      setShowSearchResults(true)
    }
  }, [searchQuery, users, selectedUsers])

  useEffect(() => {
    const fetchInitialAgentForChat = async () => {
      if (agentId) {
        setIsLoadingInitialAgent(true)
        setInitialChatAgent(null)
        try {
          const response = await api.agent[":agentExternalId"].$get({
            param: { agentExternalId: agentId },
          })
          if (response.ok) {
            const agentData = (await response.json()) as SelectPublicAgent
            setInitialChatAgent(agentData)
          } else {
            showToast({
              title: "Error",
              description: `Failed to load agent ${agentId} for chat.`,
              variant: "destructive",
            })
          }
        } catch (error) {
          showToast({
            title: "Error",
            description: "An error occurred while loading agent for chat.",
            variant: "destructive",
          })
          console.error("Fetch initial agent for chat error:", error)
        } finally {
          setIsLoadingInitialAgent(false)
        }
      } else {
        setInitialChatAgent(null)
      }
    }

    fetchInitialAgentForChat()
  }, [agentId, showToast])

  // Cleanup EventSource on component unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      cleanupPromptGenerationEventSource()
    }
  }, [])

  type AgentFilter = "all" | "madeByMe" | "sharedToMe"

  const fetchAgents = async (filter: AgentFilter = "all") => {
    setIsLoadingAgents(true)
    try {
      const response = await api.agents.$get({ query: { filter } })
      if (response.ok) {
        const data = (await response.json()) as SelectPublicAgent[]
        if (filter === "all") {
          setAllAgentsList(data)
        } else if (filter === "madeByMe") {
          setMadeByMeAgentsList(data)
        } else if (filter === "sharedToMe") {
          setSharedToMeAgentsList(data)
        }
      } else {
        showToast({
          title: "Error",
          description: `Failed to fetch agents (${filter}).`,
          variant: "destructive",
        })
      }
    } catch (error) {
      showToast({
        title: "Error",
        description: `An error occurred while fetching agents (${filter}).`,
        variant: "destructive",
      })
      console.error(`Fetch agents error (${filter}):`, error)
    } finally {
      setIsLoadingAgents(false)
    }
  }

  const fetchAllAgentData = async () => {
    await Promise.all([
      fetchAgents("all"),
      fetchAgents("madeByMe"),
      fetchAgents("sharedToMe"),
    ])
  }

  useEffect(() => {
    if (viewMode === "list") {
      fetchAllAgentData()
    } else {
      // When switching to create/edit view, also fetch all agents for the dropdown
      fetchAgents("all")
    }
  }, [viewMode])

  useEffect(() => {
    const fetchDataSourcesAsync = async () => {
      if (viewMode === "create" || viewMode === "edit") {
        try {
          const response = await api.datasources.$get()
          if (response.ok) {
            const data = await response.json()
            setFetchedDataSources(data as FetchedDataSource[])
          } else {
            showToast({
              title: "Error",
              description: "Failed to fetch data sources.",
              variant: "destructive",
            })
            setFetchedDataSources([])
          }
        } catch (error) {
          showToast({
            title: "Error",
            description: "An error occurred while fetching data sources.",
            variant: "destructive",
          })
          console.error("Fetch data sources error:", error)
          setFetchedDataSources([])
        }
      } else {
        setFetchedDataSources([])
      }
    }
    fetchDataSourcesAsync()
  }, [viewMode, showToast])

  useEffect(() => {
    const loadUsers = async () => {
      try {
        const response = await api.workspace.users.$get()
        if (response.ok) {
          const data = await response.json()
          setUsers(data as User[])
        } else {
          showToast({
            title: "Error",
            description: "Failed to fetch workspace users.",
            variant: "destructive",
          })
        }
      } catch (error) {
        showToast({
          title: "Error",
          description: "An error occurred while fetching workspace users.",
          variant: "destructive",
        })
        console.error("Fetch workspace users error:", error)
      }
    }
    loadUsers()
  }, [showToast])

  const handleSelectUser = (user: User) => {
    setSelectedUsers((prev) => [...prev, user])
    setSearchQuery("")
    setShowSearchResults(false)
  }

  const handleRemoveUser = (userId: number) => {
    setSelectedUsers((prev) => prev.filter((user) => user.id !== userId))
  }

  // Helper function to properly cleanup EventSource
  const cleanupPromptGenerationEventSource = () => {
    if (promptGenerationEventSourceRef.current) {
      promptGenerationEventSourceRef.current.close()
      promptGenerationEventSourceRef.current = null
    }
  }

  const generatePromptFromRequirements = async (requirements: string) => {
    if (!requirements.trim()) {
      showToast({
        title: "Error",
        description: "Please enter requirements for prompt generation.",
        variant: "destructive",
      })
      return
    }

    // Prevent multiple simultaneous connections
    if (promptGenerationEventSourceRef.current) {
      cleanupPromptGenerationEventSource()
    }

    setIsGeneratingPrompt(true)
    let generatedPrompt = ""

    try {
      // Create the URL with query parameters for EventSource
      const url = new URL(
        "/api/v1/agent/generate-prompt",
        window.location.origin,
      )
      url.searchParams.set("requirements", requirements)

      // Create EventSource connection following the existing pattern
      try {
        promptGenerationEventSourceRef.current = await createAuthEventSource(
          url.toString(),
        )
      } catch (err) {
        console.error("Failed to create EventSource:", err)
        toast({
          title: "Failed to create EventSource",
          description: "Failed to create EventSource",
          variant: "destructive",
        })
        return
      }

      promptGenerationEventSourceRef?.current?.addEventListener(
        ChatSSEvents.ResponseUpdate,
        (event) => {
          generatedPrompt += event.data
          setAgentPrompt(generatedPrompt)

          // Auto-scroll the textarea to bottom as content is generated
          setTimeout(() => {
            if (promptTextareaRef.current) {
              promptTextareaRef.current.scrollTop =
                promptTextareaRef.current.scrollHeight
            }
          }, 0)
        },
      )

      promptGenerationEventSourceRef.current.addEventListener(
        ChatSSEvents.End,
        (event) => {
          try {
            const data = JSON.parse(event.data)
            setAgentPrompt(data.fullPrompt || generatedPrompt)
            showToast({
              title: "Success",
              description: "Prompt generated successfully!",
            })
          } catch (e) {
            console.warn("Could not parse end event data:", e)
            showToast({
              title: "Success",
              description: "Prompt generated successfully!",
            })
          }
          cleanupPromptGenerationEventSource()
          setIsGeneratingPrompt(false)
        },
      )

      promptGenerationEventSourceRef.current.addEventListener(
        ChatSSEvents.Error,
        (event) => {
          try {
            const data = JSON.parse(event.data)
            showToast({
              title: "Error",
              description: data.error || "Failed to generate prompt",
              variant: "destructive",
            })
          } catch (e) {
            showToast({
              title: "Error",
              description: "Failed to generate prompt",
              variant: "destructive",
            })
          }
          cleanupPromptGenerationEventSource()
          setIsGeneratingPrompt(false)
        },
      )

      promptGenerationEventSourceRef.current.onerror = (error) => {
        console.error("EventSource error:", error)
        showToast({
          title: "Error",
          description: "Connection error during prompt generation",
          variant: "destructive",
        })
        cleanupPromptGenerationEventSource()
        setIsGeneratingPrompt(false)
      }
    } catch (error) {
      console.error("Generate prompt error:", error)
      showToast({
        title: "Error",
        description: "Failed to generate prompt",
        variant: "destructive",
      })
      setIsGeneratingPrompt(false)
    }
  }

  const handleGeneratePrompt = () => {
    if (agentPrompt.trim()) {
      // If there's already a prompt, use it as requirements
      generatePromptFromRequirements(agentPrompt)
    } else {
      // If no prompt, highlight the prompt box and focus it
      setShouldHighlightPrompt(true)

      // Focus the textarea
      if (promptTextareaRef.current) {
        promptTextareaRef.current.focus()
      }

      // Remove highlight after a few seconds
      setTimeout(() => {
        setShouldHighlightPrompt(false)
      }, 3000)

      showToast({
        title: "Add some requirements first",
        description:
          "Please enter some text describing what you want your agent to do, then click generate.",
        variant: "default",
      })
    }
  }

  const resetForm = () => {
    setAgentName("")
    setAgentDescription("")
    setAgentPrompt("")
    setIsPublic(false)
    setIsRagOn(true)
    setSelectedModel("Auto")
    setSelectedIntegrations({})
    setEditingAgent(null)
    setSelectedUsers([])
    setSearchQuery("")
    setShowSearchResults(false)
    setIsGeneratingPrompt(false)
    setShouldHighlightPrompt(false)
    cleanupPromptGenerationEventSource()
    setSelectedEntities([])
  }

  const handleCreateNewAgent = () => {
    resetForm()
    setViewMode("create")
  }

  const handleEditAgent = (agent: SelectPublicAgent) => {
    resetForm()
    setEditingAgent(agent)
    setViewMode("create")
  }

  const allAvailableIntegrations = useMemo(() => {
    const dynamicDataSources: IntegrationSource[] = fetchedDataSources.map(
      (ds) => ({
        id: ds.docId,
        name: ds.name,
        app: Apps.DataSource,
        entity: "datasource",
        icon: getIcon(Apps.DataSource, "datasource", { w: 16, h: 16, mr: 8 }),
      }),
    )
    if (!isRagOn) {
      return dynamicDataSources
    }
    return [...availableIntegrationsList, ...dynamicDataSources]
  }, [fetchedDataSources, isRagOn])

  useEffect(() => {
    if (editingAgent && (viewMode === "create" || viewMode === "edit")) {
      const currentAgentIsRagOn = editingAgent.isRagOn === false ? false : true
      setIsRagOn(currentAgentIsRagOn)
      setTestAgentIsRagOn(currentAgentIsRagOn)
      setAgentName(editingAgent.name)
      setAgentDescription(editingAgent.description || "")
      setAgentPrompt(editingAgent.prompt || "")
      setIsPublic(editingAgent.isPublic || false)
      setSelectedModel(editingAgent.model)
    }
  }, [editingAgent, viewMode])

  useEffect(() => {
    if (
      editingAgent &&
      (viewMode === "create" || viewMode === "edit") &&
      allAvailableIntegrations.length > 0
    ) {
      const currentIntegrations: Record<string, boolean> = {}
      allAvailableIntegrations.forEach((int) => {
        currentIntegrations[int.id] =
          editingAgent.appIntegrations?.includes(int.id) || false
      })
      setSelectedIntegrations(currentIntegrations)
    }
  }, [editingAgent, viewMode, allAvailableIntegrations])

  useEffect(() => {
    if (editingAgent && (viewMode === "create" || viewMode === "edit")) {
      setSelectedEntities(editingAgent.docIds || [])
    }
  }, [editingAgent, viewMode])

  useEffect(() => {
    if (editingAgent && (viewMode === "create" || viewMode === "edit")) {
      // Load existing user permissions only for private agents
      const loadAgentPermissions = async () => {
        try {
          const response = await api.agent[":agentExternalId"].permissions.$get(
            {
              param: { agentExternalId: editingAgent.externalId },
            },
          )
          if (response.ok) {
            const data = await response.json()
            const existingUsers = users.filter((user) =>
              data.userEmails.includes(user.email),
            )
            setSelectedUsers(existingUsers)
          }
        } catch (error) {
          console.error("Failed to load agent permissions:", error)
        }
      }

      if (users.length > 0 && !editingAgent.isPublic) {
        loadAgentPermissions()
      } else if (editingAgent.isPublic) {
        setSelectedUsers([]) // Clear users for public agents
      }
    }
  }, [editingAgent, viewMode, users])

  const handleDeleteAgent = async (agentExternalId: string) => {
    setConfirmModalTitle("Delete Agent")
    setConfirmModalMessage(
      "Are you sure you want to delete this agent? This action cannot be undone.",
    )
    setConfirmAction(() => async () => {
      try {
        const response = await api.agent[":agentExternalId"].$delete({
          param: { agentExternalId },
        })
        if (response.ok) {
          showToast({
            title: "Success",
            description: "Agent deleted successfully.",
          })
          fetchAllAgentData()
        } else {
          let errorDetail = response.statusText
          try {
            const errorData = await response.json()
            errorDetail =
              errorData.message || errorData.detail || response.statusText
          } catch (e) {
            console.error("Failed to parse error response as JSON", e)
          }
          showToast({
            title: "Error",
            description: `Failed to delete agent: ${errorDetail}`,
            variant: "destructive",
          })
        }
      } catch (error) {
        showToast({
          title: "Error",
          description: "An error occurred while deleting the agent.",
          variant: "destructive",
        })
        console.error("Delete agent error:", error)
      }
    })
    setShowConfirmModal(true)
  }

  const handleSaveAgent = async () => {
    const enabledIntegrations = Object.entries(selectedIntegrations)
      .filter(([, isSelected]) => isSelected)
      .map(([id]) => id)

    const agentPayload = {
      name: agentName,
      description: agentDescription,
      prompt: agentPrompt,
      model: selectedModel,
      isPublic: isPublic,
      isRagOn: isRagOn,
      appIntegrations: enabledIntegrations,
      docIds: selectedEntities,
      // Only include userEmails for private agents
      userEmails: isPublic ? [] : selectedUsers.map((user) => user.email),
    }

    try {
      let response
      if (editingAgent && editingAgent.externalId) {
        response = await api.agent[":agentExternalId"].$put({
          param: { agentExternalId: editingAgent.externalId },
          json: agentPayload,
        })
        if (response.ok) {
          showToast({
            title: "Success",
            description: "Agent updated successfully.",
          })
          setViewMode("list")
          resetForm()
        } else {
          const errorData = await response.json()
          showToast({
            title: "Error",
            description: `Failed to update agent: ${errorData.message || response.statusText}`,
            variant: "destructive",
          })
        }
      } else {
        response = await api.agent.create.$post({ json: agentPayload })
        if (response.ok) {
          showToast({
            title: "Success",
            description: "Agent created successfully.",
          })
          setViewMode("list")
          resetForm()
        } else {
          const errorData = await response.json()
          showToast({
            title: "Error",
            description: `Failed to create agent: ${errorData.message || response.statusText}`,
            variant: "destructive",
          })
        }
      }
    } catch (error) {
      const action = editingAgent ? "updating" : "creating"
      showToast({
        title: "Error",
        description: `An error occurred while ${action} the agent.`,
        variant: "destructive",
      })
      console.error(`${action} agent error:`, error)
    }
  }

  const toggleIntegrationSelection = (integrationId: string) => {
    setSelectedIntegrations((prev) => ({
      ...prev,
      [integrationId]: !prev[integrationId],
    }))
  }

  const handleRemoveSelectedIntegration = (integrationId: string) => {
    setSelectedIntegrations((prev) => ({
      ...prev,
      [integrationId]: false,
    }))
  }

  const handleClearAllIntegrations = () => {
    const clearedSelection: Record<string, boolean> = {}
    allAvailableIntegrations.forEach(
      (int) => (clearedSelection[int.id] = false),
    )
    setSelectedIntegrations(clearedSelection)
  }

  const currentSelectedIntegrationObjects = useMemo(() => {
    return allAvailableIntegrations.filter(
      (integration) => selectedIntegrations[integration.id],
    )
  }, [selectedIntegrations, allAvailableIntegrations])

  useEffect(() => {
    if (!isRagOn) {
      setSelectedIntegrations((prev) => {
        const newSelections = { ...prev }
        availableIntegrationsList.forEach((int) => {
          newSelections[int.id] = false
        })
        return newSelections
      })
      setSelectedEntities([])
    }
    // Also update the test agent's RAG status when the form's RAG changes,
    // but only if we are testing the current form config.
    if (selectedChatAgentExternalId === null) {
      setTestAgentIsRagOn(isRagOn)
    }
  }, [isRagOn, selectedChatAgentExternalId])

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
    }
  }, [])

  useEffect(() => {
    if (isStreaming) {
      const interval = setInterval(() => {
        setDots((prev) => (prev.length >= 3 ? "" : prev + "."))
      }, 500)
      return () => clearInterval(interval)
    } else {
      setDots("")
    }
  }, [isStreaming])

  const handleSend = async (
    messageToSend: string,
    metadata?: AttachmentMetadata[],
  ) => {
    if (!messageToSend || isStreaming) return

    setUserHasScrolled(false)
    setQuery("")
    setMessages((prevMessages) => [
      ...prevMessages,
      {
        messageRole: "user",
        message: messageToSend,
        externalId: `user-${Date.now()}`,
      },
    ])

    setIsStreaming(true)
    setCurrentResp({ resp: "", thinking: "" })
    currentRespRef.current = { resp: "", sources: [], thinking: "" }

    const url = new URL(`/api/v1/message/create`, window.location.origin)

    let chatConfigAgent: SelectPublicAgent | null | undefined = null

    if (initialChatAgent) {
      chatConfigAgent = initialChatAgent
    } else if (selectedChatAgentExternalId) {
      // Try to find in any list, though ideally it should be in `allAgentsList` if selectable
      chatConfigAgent =
        allAgentsList.find(
          (agent) => agent.externalId === selectedChatAgentExternalId,
        ) ||
        madeByMeAgentsList.find(
          (agent) => agent.externalId === selectedChatAgentExternalId,
        ) ||
        sharedToMeAgentsList.find(
          (agent) => agent.externalId === selectedChatAgentExternalId,
        )
    }

    let finalAgentPrompt = agentPrompt
    let finalSelectedIntegrationNames = allAvailableIntegrations
      .filter((integration) => selectedIntegrations[integration.id])
      .map((integration) => integration.name)
    let finalModelForChat = selectedModel

    if (chatConfigAgent) {
      finalAgentPrompt = chatConfigAgent.prompt || ""
      finalSelectedIntegrationNames = allAvailableIntegrations
        .filter((integration) =>
          chatConfigAgent.appIntegrations?.includes(integration.id),
        )
        .map((integration) => integration.name)
      finalModelForChat = chatConfigAgent.model
    }

    const agentPromptPayload = {
      prompt: finalAgentPrompt,
      sources: finalSelectedIntegrationNames,
    }
    url.searchParams.append(
      "modelId",
      finalModelForChat === "Auto" ? "gpt-4o-mini" : finalModelForChat,
    )
    url.searchParams.append("message", encodeURIComponent(messageToSend))
    if (isReasoningActive) {
      url.searchParams.append("isReasoningEnabled", "true")
    }
    url.searchParams.append("agentPrompt", JSON.stringify(agentPromptPayload))

    if (metadata && metadata.length > 0) {
      url.searchParams.append("attachmentMetadata", JSON.stringify(metadata))
    }

    try {
      eventSourceRef.current = await createAuthEventSource(url.toString())
    } catch (err) {
      console.error("Failed to create EventSource:", err)
      toast({
        title: "Failed to create EventSource",
        description: "Failed to create EventSource",
        variant: "destructive",
      })
      return
    }

    eventSourceRef.current.addEventListener(
      ChatSSEvents.CitationsUpdate,
      (event) => {
        const { contextChunks, citationMap } = JSON.parse(event.data)
        if (currentRespRef.current) {
          currentRespRef.current.sources = contextChunks
          currentRespRef.current.citationMap = citationMap
          setCurrentResp((prevResp: CurrentResp | null) => ({
            ...(prevResp || { resp: "", thinking: "" }),
            resp: prevResp?.resp || "",
            sources: contextChunks,
            citationMap,
          }))
        }
      },
    )

    eventSourceRef.current.addEventListener(ChatSSEvents.Reasoning, (event) => {
      setCurrentResp((prevResp: CurrentResp | null) => ({
        ...(prevResp || { resp: "", thinking: event.data || "" }),
        thinking: (prevResp?.thinking || "") + event.data,
      }))
    })

    eventSourceRef.current.addEventListener(ChatSSEvents.Start, () => {})

    eventSourceRef.current.addEventListener(
      ChatSSEvents.ResponseUpdate,
      (event) => {
        setCurrentResp((prevResp: CurrentResp | null) => {
          const updatedResp = prevResp
            ? { ...prevResp, resp: prevResp.resp + event.data }
            : { resp: event.data, thinking: "", sources: [], citationMap: {} }
          currentRespRef.current = updatedResp
          return updatedResp
        })
      },
    )

    eventSourceRef.current.addEventListener(
      ChatSSEvents.ResponseMetadata,
      (event) => {
        const { chatId: newChatId, messageId } = JSON.parse(event.data)
        if (newChatId && !chatId) setChatId(newChatId)
        if (messageId) {
          if (currentRespRef.current) {
            setCurrentResp((resp: CurrentResp | null) => {
              const updatedResp = resp || { resp: "", thinking: "" }
              updatedResp.chatId = newChatId
              updatedResp.messageId = messageId
              currentRespRef.current = updatedResp
              return updatedResp
            })
          }
        }
        if (!stopMsg) setStopMsg(true)
      },
    )

    eventSourceRef.current.addEventListener(
      ChatSSEvents.AttachmentUpdate,
      (event) => {
        try {
          const { messageId, attachments } = JSON.parse(event.data)

          // Validate required fields
          if (!messageId) {
            console.error(
              "AttachmentUpdate: Missing messageId in event data",
              event.data,
            )
            return
          }

          if (!attachments || !Array.isArray(attachments)) {
            console.error(
              "AttachmentUpdate: Invalid attachments data",
              event.data,
            )
            return
          }

          // Store attachment metadata for the specific message using messageId
          setMessages((prevMessages) => {
            const messageIndex = prevMessages.findIndex(
              (msg) => msg.externalId === messageId,
            )

            if (messageIndex === -1) {
              console.warn(
                `AttachmentUpdate: Message with ID ${messageId} not found`,
              )
              return prevMessages
            }

            return prevMessages.map((msg, index) =>
              index === messageIndex ? { ...msg, attachments } : msg,
            )
          })
        } catch (error) {
          console.error("AttachmentUpdate: Failed to parse event data", {
            error,
            eventData: event.data,
          })
          // Don't crash the application, just log the error
        }
      },
    )

    eventSourceRef.current.addEventListener(ChatSSEvents.End, () => {
      const currentRespVal = currentRespRef.current
      if (currentRespVal) {
        setMessages((prevMessages) => [
          ...prevMessages,
          {
            messageRole: "assistant",
            message: currentRespVal.resp,
            externalId: currentRespVal.messageId,
            sources: currentRespVal.sources,
            citationMap: currentRespVal.citationMap,
            thinking: currentRespVal.thinking,
          },
        ])
      }
      setCurrentResp(null)
      currentRespRef.current = null
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      setStopMsg(false)
      setIsStreaming(false)
    })

    eventSourceRef.current.addEventListener(ChatSSEvents.Error, (event) => {
      console.error("Error with SSE:", event.data)
      const currentRespVal = currentRespRef.current
      setMessages((prevMessages) => [
        ...prevMessages,
        {
          messageRole: "assistant",
          message: `Error: ${event.data || "Unknown error"}`,
          externalId: currentRespVal?.messageId || `err-${Date.now()}`,
          sources: currentRespVal?.sources,
          citationMap: currentRespVal?.citationMap,
          thinking: currentRespVal?.thinking,
        },
      ])
      setCurrentResp(null)
      currentRespRef.current = null
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      setStopMsg(false)
      setIsStreaming(false)
    })

    eventSourceRef.current.onerror = (error) => {
      if (userStopped) {
        setUserStopped(false)
        setCurrentResp(null)
        currentRespRef.current = null
        setStopMsg(false)
        setIsStreaming(false)
        eventSourceRef.current?.close()
        eventSourceRef.current = null
        return
      }
      console.error("Error with SSE (onerror):", error)
      setMessages((prevMessages) => [
        ...prevMessages,
        {
          messageRole: "assistant",
          message:
            "An error occurred while streaming the response. Please try again.",
          externalId: `onerror-${Date.now()}`,
        },
      ])
      setCurrentResp(null)
      currentRespRef.current = null
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      setStopMsg(false)
      setIsStreaming(false)
    }
    setQuery("")
  }

  const handleStop = async () => {
    setUserStopped(true)
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    setIsStreaming(false)

    if (chatId && currentRespRef.current?.messageId) {
      try {
        await api.chat.stop.$post({
          json: { chatId: chatId },
        })
      } catch (error) {
        console.error("Failed to send stop request to backend:", error)
        toast({
          title: "Error",
          description: "Could not stop streaming on backend.",
          variant: "destructive",
          duration: 1000,
        })
      }
    }

    if (currentRespRef.current && currentRespRef.current.resp) {
      setMessages((prevMessages) => [
        ...prevMessages,
        {
          messageRole: "assistant",
          message: currentRespRef.current?.resp || " ",
          externalId: currentRespRef.current?.messageId,
          sources: currentRespRef.current?.sources,
          citationMap: currentRespRef.current?.citationMap,
          thinking: currentRespRef.current?.thinking,
        },
      ])
    }
    setCurrentResp(null)
    currentRespRef.current = null
    setStopMsg(false)
  }

  const handleRetry = async (messageIdToRetry: string) => {
    const assistantMessageIndex = messages.findIndex(
      (msg) =>
        msg.externalId === messageIdToRetry && msg.messageRole === "assistant",
    )
    if (assistantMessageIndex > 0) {
      const userMessageToResend = messages[assistantMessageIndex - 1]
      if (userMessageToResend && userMessageToResend.messageRole === "user") {
        const userMessageAttachments = userMessageToResend.attachments
        setMessages((prev) => prev.slice(0, assistantMessageIndex - 1))
        await handleSend(userMessageToResend.message, userMessageAttachments)
      } else {
        toast({
          title: "Retry Error",
          description: "Could not find original user message to retry.",
          variant: "destructive",
        })
      }
    } else {
      toast({
        title: "Retry Error",
        description: "Could not find message to retry.",
        variant: "destructive",
      })
    }
  }

  const isScrolledToBottom = () => {
    const container = messagesContainerRef.current
    if (!container) return true
    const threshold = 100
    return (
      container.scrollHeight - container.scrollTop - container.clientHeight <
      threshold
    )
  }

  const handleScroll = () => {
    setUserHasScrolled(!isScrolledToBottom())
  }

  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container || userHasScrolled) return
    container.scrollTop = container.scrollHeight
  }, [messages, currentResp?.resp])

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-white dark:bg-[#1E1E1E]">
      <Sidebar
        photoLink={user?.photoLink}
        role={user?.role}
        isAgentMode={agentWhiteList}
      />
      <ConfirmModal
        showModal={showConfirmModal}
        setShowModal={(val) =>
          setShowConfirmModal(val.open ?? showConfirmModal)
        }
        modalTitle={confirmModalTitle}
        modalMessage={confirmModalMessage}
        onConfirm={() => {
          if (confirmAction) {
            confirmAction()
          }
        }}
      />
      <div className="flex flex-col md:flex-row flex-1 h-full md:ml-[60px]">
        <div
          className={`p-4 md:py-4 md:px-8 bg-white dark:bg-[#1E1E1E] overflow-y-auto h-full relative ${viewMode === "list" ? "w-full" : "w-full md:w-[50%] border-r border-gray-200 dark:border-gray-700"}`}
        >
          {viewMode === "list" ? (
            <div className="mt-6">
              <div className="w-full max-w-3xl mx-auto px-4 pt-0 pb-6">
                <div className="flex flex-col space-y-6">
                  <div className="flex justify-between items-center">
                    <h1 className="text-4xl tracking-wider font-display text-gray-700 dark:text-gray-100">
                      AGENTS
                    </h1>
                    <div className="flex items-center gap-4 ">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-5 w-5" />
                        <input
                          type="text"
                          placeholder="Search agents.."
                          value={listSearchQuery}
                          onChange={handleListSearchChange}
                          className="pl-10 pr-4 py-2 rounded-full border border-gray-200 dark:border-slate-600 w-[300px] focus:outline-none focus:ring-2 focus:ring-gray-300 dark:focus:ring-slate-500 dark:bg-slate-700 dark:text-gray-100"
                        />
                      </div>
                      <Button
                        onClick={handleCreateNewAgent}
                        className="bg-slate-800 hover:bg-slate-700 text-white font-mono font-medium rounded-full px-6 py-2 flex items-center gap-2"
                      >
                        <Plus size={18} /> CREATE
                      </Button>
                    </div>
                  </div>

                  {(() => {
                    const favoriteAgentObjects = allAgentsList.filter((agent) =>
                      favoriteAgents.includes(agent.externalId),
                    )
                    if (favoriteAgentObjects.length === 0) return null

                    const displayedFavoriteAgents = showAllFavorites
                      ? favoriteAgentObjects
                      : favoriteAgentObjects.slice(0, 6)

                    return (
                      <div className="mb-6 pb-8">
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                          {displayedFavoriteAgents.map((agent) => (
                            <AgentCard
                              key={agent.externalId}
                              agent={agent}
                              isFavorite={true}
                              onToggleFavorite={toggleFavorite}
                              onClick={() =>
                                navigate({
                                  to: "/",
                                  search: { agentId: agent.externalId },
                                })
                              }
                            />
                          ))}
                        </div>
                        {favoriteAgentObjects.length > 6 && (
                          <div className="flex justify-end mt-4">
                            <Button
                              variant="ghost"
                              onClick={() =>
                                setShowAllFavorites(!showAllFavorites)
                              }
                              className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 px-3 py-1 h-auto"
                            >
                              {showAllFavorites ? "Show Less" : "Show More"}
                              {showAllFavorites ? (
                                <ChevronUp size={16} className="ml-2" />
                              ) : (
                                <ChevronDown size={16} className="ml-2" />
                              )}
                            </Button>
                          </div>
                        )}
                      </div>
                    )
                  })()}

                  {(allAgentsList.length > 0 ||
                    madeByMeAgentsList.length > 0 ||
                    sharedToMeAgentsList.length > 0) && ( // Only show tabs if there are agents in any list
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex space-x-2">
                        <TabButton
                          active={activeTab === "all"}
                          onClick={() => handleTabChange("all")}
                          icon="asterisk"
                          label="ALL"
                        />
                        <TabButton
                          active={activeTab === "shared-to-me"}
                          onClick={() => handleTabChange("shared-to-me")}
                          icon="users"
                          label="SHARED-WITH-ME"
                        />
                        <TabButton
                          active={activeTab === "made-by-me"}
                          onClick={() => handleTabChange("made-by-me")}
                          icon="user"
                          label="MADE-BY-ME"
                        />
                      </div>
                      <div>
                        <Button
                          onClick={fetchAllAgentData}
                          variant="outline"
                          size="sm"
                          className="text-xs flex items-center gap-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700"
                          disabled={isLoadingAgents}
                        >
                          <RefreshCw
                            size={14}
                            className={`${isLoadingAgents ? "animate-spin" : ""}`}
                          />
                        </Button>
                      </div>
                    </div>
                  )}

                  {(() => {
                    let currentListToDisplay: SelectPublicAgent[] = []
                    if (activeTab === "all") {
                      currentListToDisplay = allAgentsList
                    } else if (activeTab === "made-by-me") {
                      currentListToDisplay = madeByMeAgentsList
                    } else if (activeTab === "shared-to-me") {
                      currentListToDisplay = sharedToMeAgentsList
                    }

                    const filteredList = currentListToDisplay.filter(
                      (agent) =>
                        agent.name
                          .toLowerCase()
                          .includes(listSearchQuery.toLowerCase()) ||
                        (agent.description || "")
                          .toLowerCase()
                          .includes(listSearchQuery.toLowerCase()),
                    )

                    const totalPages = Math.ceil(
                      filteredList.length / agentsPerPage,
                    )
                    const paginatedList = filteredList.slice(
                      (currentPage - 1) * agentsPerPage,
                      currentPage * agentsPerPage,
                    )

                    if (
                      isLoadingAgents &&
                      filteredList.length === 0 &&
                      !listSearchQuery
                    ) {
                      return (
                        <div className="text-center py-10 text-gray-500 dark:text-gray-400">
                          Loading agents...
                        </div>
                      )
                    }

                    if (filteredList.length === 0 && listSearchQuery) {
                      return (
                        <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                          No agents found for your search.
                        </div>
                      )
                    }

                    if (currentListToDisplay.length === 0 && !listSearchQuery) {
                      return (
                        <div className="text-center py-10 text-gray-500 dark:text-gray-400">
                          <p className="text-lg mb-2">
                            No agents in this category yet.
                          </p>
                          {activeTab === "all" && (
                            <p>Click "CREATE" to get started.</p>
                          )}
                        </div>
                      )
                    }

                    return (
                      <>
                        <div className="space-y-0">
                          {paginatedList.map((agent) => (
                            <AgentListItem
                              key={agent.externalId}
                              agent={agent}
                              isFavorite={favoriteAgents.includes(
                                agent.externalId,
                              )}
                              isShared={
                                activeTab === "all" &&
                                sharedToMeAgentsList.some(
                                  (sharedAgent) =>
                                    sharedAgent.externalId === agent.externalId,
                                )
                              }
                              isMadeByMe={madeByMeAgentsList.some(
                                (madeByMeAgent) =>
                                  madeByMeAgent.externalId === agent.externalId,
                              )}
                              onToggleFavorite={toggleFavorite}
                              onEdit={() => handleEditAgent(agent)}
                              onDelete={() =>
                                handleDeleteAgent(agent.externalId)
                              }
                              onClick={() =>
                                navigate({
                                  to: "/",
                                  search: { agentId: agent.externalId },
                                })
                              }
                            />
                          ))}
                        </div>
                        {totalPages > 1 && (
                          <div className="flex justify-between items-center mt-6">
                            <Button
                              onClick={() =>
                                setCurrentPage((p) => Math.max(p - 1, 1))
                              }
                              disabled={currentPage === 1}
                              variant="outline"
                              className="flex items-center gap-2"
                            >
                              <ChevronLeft size={16} />
                              Previous
                            </Button>
                            <span className="text-sm text-gray-600 dark:text-gray-400">
                              Page {currentPage} of {totalPages}
                            </span>
                            <Button
                              onClick={() =>
                                setCurrentPage((p) =>
                                  Math.min(p + 1, totalPages),
                                )
                              }
                              disabled={currentPage === totalPages}
                              variant="outline"
                              className="flex items-center gap-2"
                            >
                              Next
                              <ChevronRight size={16} />
                            </Button>
                          </div>
                        )}
                      </>
                    )
                  })()}
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center mb-4 w-full max-w-xl">
                <Button
                  variant="ghost"
                  size="icon"
                  className="mr-2 text-gray-600 dark:text-gray-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                  onClick={() => {
                    resetForm()
                    setViewMode("list")
                  }}
                >
                  <ArrowLeft size={20} />
                </Button>
                <h1 className="text-2xl font-semibold text-gray-700 dark:text-gray-100">
                  {editingAgent ? "EDIT AGENT" : "CREATE AGENT"}
                </h1>
              </div>

              <div className="w-full max-w-2xl space-y-6">
                <div className="w-full">
                  <Label
                    htmlFor="agentName"
                    className="text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    Name
                  </Label>
                  <Input
                    id="agentName"
                    placeholder="e.g., Report Generator"
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    className="mt-1 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-lg w-full text-base h-11 px-3 dark:text-gray-100"
                  />
                </div>

                <div className="w-full">
                  <Label
                    htmlFor="agentDescription"
                    className="text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    Description
                  </Label>
                  <Textarea
                    id="agentDescription"
                    placeholder="e.g., Helps with generating quarterly financial reports..."
                    value={agentDescription}
                    onChange={(e) => setAgentDescription(e.target.value)}
                    className="mt-1 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-lg w-full h-24 p-3 text-base dark:text-gray-100"
                  />
                </div>

                <div className="w-full">
                  <div className="flex items-center justify-between mb-2">
                    <Label
                      htmlFor="agentPrompt"
                      className="text-sm font-medium text-gray-700 dark:text-gray-300"
                    >
                      Prompt
                    </Label>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={handleGeneratePrompt}
                            disabled={isGeneratingPrompt}
                            className="h-8 w-8 p-0"
                          >
                            <Sparkles
                              className={`h-4 w-4 ${
                                isGeneratingPrompt
                                  ? "animate-pulse text-blue-600 dark:text-blue-400"
                                  : ""
                              }`}
                            />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>
                            {isGeneratingPrompt
                              ? "Generating prompt..."
                              : "Generate prompt with AI"}
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <Textarea
                    ref={promptTextareaRef}
                    id="agentPrompt"
                    placeholder="e.g., You are a helpful assistant... or describe your requirements and use the AI button"
                    value={agentPrompt}
                    onChange={(e) => {
                      setAgentPrompt(e.target.value)
                      // Clear highlight when user starts typing
                      if (shouldHighlightPrompt) {
                        setShouldHighlightPrompt(false)
                      }
                    }}
                    className={`mt-1 bg-white dark:bg-slate-700 border rounded-lg w-full h-36 p-3 text-base dark:text-gray-100 transition-all duration-300 ${
                      shouldHighlightPrompt
                        ? "border-blue-400 ring-2 ring-blue-200 dark:border-blue-500 dark:ring-blue-900/50 shadow-lg"
                        : "border-gray-300 dark:border-slate-600"
                    }`}
                    disabled={isGeneratingPrompt}
                  />
                </div>

                <div className="w-full">
                  <Label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Visibility
                  </Label>
                  <div className="mt-3 space-y-3">
                    <div className="flex items-center space-x-3">
                      <input
                        type="radio"
                        id="private"
                        name="visibility"
                        checked={!isPublic}
                        onChange={() => setIsPublic(false)}
                        className="w-4 h-4 text-slate-600 border-gray-300 focus:ring-slate-500"
                      />
                      <Label
                        htmlFor="private"
                        className="text-sm text-gray-700 dark:text-gray-300 cursor-pointer"
                      >
                        Private (only shared users can access)
                      </Label>
                    </div>
                    <div className="flex items-center space-x-3">
                      <input
                        type="radio"
                        id="public"
                        name="visibility"
                        checked={isPublic}
                        onChange={() => setIsPublic(true)}
                        className="w-4 h-4 text-slate-600 border-gray-300 focus:ring-slate-500"
                      />
                      <Label
                        htmlFor="public"
                        className="text-sm text-gray-700 dark:text-gray-300 cursor-pointer"
                      >
                        Public (all workspace members can access)
                      </Label>
                    </div>
                  </div>
                </div>

                <div className="w-full">
                  <Label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    RAG
                  </Label>
                  <div className="mt-3 space-y-3">
                    <div className="flex items-center space-x-3">
                      <input
                        type="radio"
                        id="ragOn"
                        name="rag"
                        checked={isRagOn}
                        onChange={() => setIsRagOn(true)}
                        className="w-4 h-4 text-slate-600 border-gray-300 focus:ring-slate-500"
                      />
                      <Label
                        htmlFor="ragOn"
                        className="text-sm text-gray-700 dark:text-gray-300 cursor-pointer"
                      >
                        On
                      </Label>
                    </div>
                    <div className="flex items-center space-x-3">
                      <input
                        type="radio"
                        id="ragOff"
                        name="rag"
                        checked={!isRagOn}
                        onChange={() => setIsRagOn(false)}
                        className="w-4 h-4 text-slate-600 border-gray-300 focus:ring-slate-500"
                      />
                      <Label
                        htmlFor="ragOff"
                        className="text-sm text-gray-700 dark:text-gray-300 cursor-pointer"
                      >
                        Off
                      </Label>
                    </div>
                  </div>
                </div>

                <div>
                  <Label className="text-base font-medium text-gray-800 dark:text-gray-300">
                    App Integrations
                  </Label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 mb-3">
                    Select knowledge sources for your agent.
                  </p>
                  <div className="flex flex-wrap items-center gap-2 p-3 border border-gray-300 dark:border-gray-600 rounded-lg min-h-[48px] bg-white dark:bg-slate-700">
                    {currentSelectedIntegrationObjects.length === 0 && (
                      <span className="text-gray-400 dark:text-gray-400 text-sm">
                        Add integrations..
                      </span>
                    )}
                    {currentSelectedIntegrationObjects.map((integration) => (
                      <CustomBadge
                        key={integration.id}
                        text={integration.name}
                        icon={integration.icon}
                        onRemove={() =>
                          handleRemoveSelectedIntegration(integration.id)
                        }
                      />
                    ))}
                    <DropdownMenu
                      open={isIntegrationMenuOpen}
                      onOpenChange={setIsIntegrationMenuOpen}
                    >
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="ml-auto p-1 h-7 w-7 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                        >
                          <PlusCircle size={20} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        className="w-72 md:w-80 max-h-80 overflow-y-auto" /* Adapts via CSS vars */
                        align="start"
                      >
                        <div className="flex items-center justify-between px-2 py-1.5">
                          <DropdownMenuLabel className="p-0 text-sm font-medium">
                            Select Integrations
                          </DropdownMenuLabel>
                          {currentSelectedIntegrationObjects.length > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={handleClearAllIntegrations}
                              className="p-1 h-auto text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                            >
                              <RotateCcw size={14} className="mr-1" /> Clear all
                            </Button>
                          )}
                        </div>
                        <DropdownMenuSeparator /> {/* Adapts via CSS vars */}
                        {allAvailableIntegrations.map((integration) => (
                          <DropdownMenuItem
                            key={integration.id}
                            onSelect={() =>
                              toggleIntegrationSelection(integration.id)
                            }
                            className="flex items-center justify-between cursor-pointer text-sm py-2 px-2 hover:bg-slate-50 dark:hover:bg-slate-600"
                          >
                            <div className="flex items-center">
                              <span className="mr-2 flex items-center">
                                {integration.icon}
                              </span>
                              <span>{integration.name}</span>
                            </div>
                            {selectedIntegrations[integration.id] && (
                              <Check className="h-4 w-4 text-slate-700 dark:text-slate-200" />
                            )}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                {isRagOn && (
                  <div>
                    <Label className="text-base font-medium text-gray-800 dark:text-gray-300">
                      Specific Entites
                    </Label>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 mb-3">
                      Search for and select specific entities for your agent to
                      use.
                    </p>
                    <div className="flex flex-wrap items-center gap-2 p-3 border border-gray-300 dark:border-gray-600 rounded-lg min-h-[48px] bg-white dark:bg-slate-700">
                      {selectedEntities.length > 0 ? (
                        selectedEntities.map((entity) => (
                          <CustomBadge
                            key={entity.docId}
                            text={entity.name}
                            onRemove={() =>
                              setSelectedEntities((prev) =>
                                prev.filter((c) => c.docId !== entity.docId),
                              )
                            }
                          />
                        ))
                      ) : (
                        <span className="text-sm text-gray-500 dark:text-gray-300">
                          Selected entites will be shown here
                        </span>
                      )}
                    </div>
                    <div className="relative mt-2">
                      <Input
                        placeholder="Search for specific entities..."
                        value={entitySearchQuery}
                        onChange={(e) => setEntitySearchQuery(e.target.value)}
                        className="bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-lg w-full dark:text-gray-100"
                      />
                      {showEntitySearchResults && (
                        <Card className="absolute z-10 mt-1 shadow-lg w-full dark:bg-slate-800 dark:border-slate-700">
                          <CardContent className="p-0 max-h-[150px] overflow-y-auto w-full scrollbar-thin">
                            {entitySearchResults.length > 0 ? (
                              entitySearchResults.map((entity) => (
                                <div
                                  key={entity.docId}
                                  className="p-2 hover:bg-gray-100 dark:hover:bg-slate-700 cursor-pointer"
                                  onClick={() => {
                                    setSelectedEntities((prev) => [
                                      ...prev,
                                      entity,
                                    ])
                                    setEntitySearchQuery("")
                                  }}
                                >
                                  <p className="text-sm font-medium">
                                    {entity.name}
                                  </p>
                                </div>
                              ))
                            ) : (
                              <div className="p-3 text-center text-gray-500">
                                No entities found.
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      )}
                    </div>
                  </div>
                )}

                {!isPublic && (
                  <div>
                    <Label className="text-base font-medium text-gray-800 dark:text-gray-300">
                      Agent Users{" "}
                      {selectedUsers.length > 0 && (
                        <span className="text-sm text-gray-500 dark:text-gray-300 ml-1">
                          ({selectedUsers.length})
                        </span>
                      )}
                    </Label>
                    <div className="mt-3 dark:bg-slate-700 border-gray-300 dark:border-slate-600 dark:text-gray-100">
                      <div className="relative w-full ">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                        <Input
                          placeholder="Search users by name or email..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          onKeyDown={handleKeyDown}
                          className="pl-10 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-lg w-full dark:text-gray-100"
                        />
                        {showSearchResults && (
                          <Card className="absolute z-10 mt-1 shadow-lg w-full dark:bg-slate-800 dark:border-slate-700">
                            <CardContent
                              className="p-0 max-h-[125px] overflow-y-auto w-full scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-transparent hover:scrollbar-thumb-gray-400"
                              ref={searchResultsRef}
                              style={{
                                scrollbarWidth: "thin",
                                WebkitOverflowScrolling: "touch",
                                scrollbarColor: "#D1D5DB transparent",
                                overflowY: "auto",
                                display: "block",
                              }}
                            >
                              {filteredUsers.length > 0 ? (
                                filteredUsers.map((user, index) => (
                                  <div
                                    key={user.id}
                                    className={`flex items-center justify-between p-2 hover:bg-gray-100 dark:hover:bg-slate-700 cursor-pointer border-b dark:border-slate-700 last:border-b-0 ${
                                      index === selectedSearchIndex
                                        ? "bg-gray-100 dark:bg-slate-700"
                                        : ""
                                    }`}
                                    onClick={() => handleSelectUser(user)}
                                  >
                                    <div className="flex items-center space-x-2 min-w-0 flex-1 pr-2">
                                      <span className="text-sm text-gray-600 dark:text-white truncate">
                                        {user.name}
                                      </span>
                                      <span className="text-gray-50 flex-shrink-0">
                                        -
                                      </span>
                                      <span className="text-gray-500 truncate">
                                        {user.email}
                                      </span>
                                    </div>
                                    <UserPlus className="h-4 w-4 text-gray-400 flex-shrink-0" />
                                  </div>
                                ))
                              ) : (
                                <div className="p-3 text-center text-gray-500">
                                  No users found matching "{searchQuery}"
                                </div>
                              )}
                            </CardContent>
                          </Card>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Agent Users Section */}
                {!isPublic && (
                  <div>
                    <Card className="mt-3 bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-700">
                      <CardContent className="p-4">
                        <div className="space-y-1.5 h-[126px] overflow-y-auto">
                          {selectedUsers.length > 0 ? (
                            selectedUsers.map((user) => (
                              <div
                                key={user.id}
                                className="flex items-center justify-between p-1.5 bg-gray-100 dark:bg-slate-700 rounded-lg"
                              >
                                <div className="flex items-center space-x-2 min-w-0 flex-1 pr-2">
                                  <span className="text-sm text-gray-700 dark:text-slate-100 truncate">
                                    {user.name}
                                  </span>
                                  <span className="text-gray-500 dark:text-slate-400 flex-shrink-0">
                                    -
                                  </span>
                                  <span className="text-gray-500 dark:text-slate-400 truncate">
                                    {user.email}
                                  </span>
                                </div>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleRemoveUser(user.id)}
                                  className="text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200 dark:hover:bg-slate-600 h-6 w-6 p-0 flex-shrink-0"
                                >
                                  <LucideX className="h-3 w-3" />
                                </Button>
                              </div>
                            ))
                          ) : (
                            <div className="text-center py-4 text-gray-500 dark:text-gray-400">
                              <UserPlus className="h-8 w-8 mx-auto mb-2 text-gray-400 dark:text-gray-500" />
                              <p>No users added yet</p>
                              <p className="text-sm">
                                Search and select users to add them to this
                                agent
                              </p>
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                )}
                <div className="flex justify-end w-full mt-8 mb-4">
                  <Button
                    onClick={handleSaveAgent}
                    className="bg-slate-800 dark:bg-blue-600 hover:bg-slate-700 dark:hover:bg-blue-500 text-white rounded-lg px-8 py-3 text-sm font-medium"
                  >
                    {editingAgent ? "Save Changes" : "Create Agent"}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>

        {viewMode !== "list" && (
          <div className="w-full md:w-[50%] bg-gray-50 dark:bg-[#1E1E1E] flex flex-col h-full">
            <div className="p-4 md:px-8 md:py-6 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
              <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-100">
                TEST AGENT
              </h2>
              {allAgentsList.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto text-xs h-8"
                    >
                      {selectedChatAgentExternalId
                        ? allAgentsList.find(
                            (a) => a.externalId === selectedChatAgentExternalId,
                          )?.name || "Select Agent to Test"
                        : "Test Current Form Config"}
                      <ChevronDown className="ml-2 h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuItem
                      onSelect={() => {
                        setSelectedChatAgentExternalId(null)
                        setTestAgentIsRagOn(isRagOn) // When switching to form, use form's RAG
                      }}
                    >
                      Test Current Form Config
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>
                      Or select a saved agent
                    </DropdownMenuLabel>
                    {allAgentsList.map((agent) => (
                      <DropdownMenuItem
                        key={agent.externalId}
                        onSelect={() => {
                          setSelectedChatAgentExternalId(agent.externalId)
                          setTestAgentIsRagOn(agent.isRagOn) // Use selected agent's RAG
                        }}
                      >
                        {agent.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>

            <div
              className="flex flex-col flex-grow overflow-y-auto p-4 md:p-6 space-y-4 min-h-0 max-h-[calc(100vh-200px)] scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-transparent hover:scrollbar-thumb-gray-400"
              ref={messagesContainerRef}
              onScroll={handleScroll}
              style={{
                scrollbarWidth: "thin",
                WebkitOverflowScrolling: "touch",
                scrollbarColor: "#D1D5DB transparent",
              }}
            >
              {messages.map((message, index) => (
                <AgentChatMessage
                  key={message.externalId ?? index}
                  message={message.message}
                  isUser={message.messageRole === "user"}
                  thinking={message.thinking}
                  citations={message.sources}
                  messageId={message.externalId}
                  handleRetry={handleRetry}
                  citationMap={message.citationMap}
                  attachments={message.attachments || []}
                  dots={
                    isStreaming &&
                    index === messages.length - 1 &&
                    message.messageRole === "assistant"
                      ? dots
                      : ""
                  }
                  isStreaming={
                    isStreaming &&
                    index === messages.length - 1 &&
                    message.messageRole === "assistant"
                  }
                />
              ))}
              {currentResp && (
                <AgentChatMessage
                  message={currentResp.resp}
                  citations={currentResp.sources}
                  thinking={currentResp.thinking || ""}
                  isUser={false}
                  handleRetry={handleRetry}
                  dots={dots}
                  messageId={currentResp.messageId}
                  citationMap={currentResp.citationMap}
                  attachments={[]}
                  isStreaming={isStreaming}
                />
              )}
            </div>

            <div className="p-2 md:p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#1E1E1E] flex justify-center">
              <ChatBox
                role={user?.role}
                query={query}
                user={user}
                setQuery={setQuery}
                handleSend={handleSend}
                handleStop={handleStop}
                setIsAgenticMode={setIsAgenticMode}
                isAgenticMode={isAgenticMode}
                isStreaming={isStreaming}
                allCitations={allCitations}
                isReasoningActive={isReasoningActive}
                setIsReasoningActive={setIsReasoningActive}
                overrideIsRagOn={testAgentIsRagOn}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

interface AgentListItemProps {
  agent: SelectPublicAgent
  isFavorite: boolean
  onToggleFavorite: (id: string) => void
  onEdit: () => void
  onDelete: () => void
  onClick: () => void
  isShared?: boolean
  isMadeByMe?: boolean // New prop
}

function AgentListItem({
  agent,
  isFavorite,
  isShared,
  isMadeByMe, // Added
  onToggleFavorite,
  onEdit,
  onDelete,
  onClick,
}: AgentListItemProps): JSX.Element {
  return (
    <div
      className="flex items-center justify-between py-4 border-b-2 border-dotted border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800/50 px-2 rounded-none transition-colors cursor-pointer"
      onClick={onClick} // Make the whole item clickable to navigate
    >
      <div className="flex items-center gap-4 flex-grow min-w-0">
        {" "}
        {/* Added min-w-0 for truncation */}
        <AgentIconDisplay agentName={agent.name} size="small" />
        <div className="flex-grow min-w-0">
          {" "}
          {/* Added min-w-0 for truncation */}
          <h3
            className="font-medium text-base leading-tight text-gray-900 dark:text-gray-100 flex items-center"
            title={agent.name}
          >
            <span className="truncate">{agent.name}</span>
            {isShared && (
              <Users
                size={14}
                className="ml-3 text-gray-500 dark:text-gray-400 flex-shrink-0"
              />
            )}
          </h3>
          <p
            className="text-gray-500 dark:text-gray-400 text-sm mt-0.5 truncate"
            title={agent.description || ""}
          >
            {agent.description || (
              <span className="italic">No description</span>
            )}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 ml-4 flex-shrink-0">
        {isMadeByMe && (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation()
                onEdit()
              }}
              className="h-8 w-8 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-slate-100 dark:hover:bg-slate-700"
              title="Edit Agent"
            >
              <Edit3 size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
              className="h-8 w-8 text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30"
              title="Delete Agent"
            >
              <Trash2 size={16} />
            </Button>
          </>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation() // Prevent navigation when clicking star
            onToggleFavorite(agent.externalId)
          }}
          className="text-amber-400 hover:text-amber-500 p-1"
        >
          <Star fill={isFavorite ? "currentColor" : "none"} size={18} />
        </button>
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: string
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 text-sm font-mono font-medium rounded-full transition-colors ${
        active
          ? "bg-gray-200 text-gray-800 dark:bg-slate-700 dark:text-gray-100"
          : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800/60"
      }`}
    >
      {icon === "asterisk" && <span className="text-lg font-semibold">*</span>}
      {icon === "users" && <Users size={16} />}
      {icon === "user" && <UserPlus size={16} />}
      {label}
    </button>
  )
}

const textToCitationIndexPattern = /\[(\d+)\]/g

const renderMarkdownLink = ({
  node,
  ...linkProps
}: { node?: any; [key: string]: any }) => (
  <a
    {...linkProps}
    target="_blank"
    rel="noopener noreferrer"
    className="text-blue-600 hover:underline"
  />
)

const AgentChatMessage = ({
  message,
  thinking,
  isUser,
  isRetrying,
  citations = [],
  messageId,
  handleRetry,
  dots = "",
  citationMap,
  isStreaming = false,
  attachments = [],
}: {
  message: string
  thinking?: string
  isUser: boolean
  isRetrying?: boolean
  citations?: Citation[]
  messageId?: string
  dots?: string
  handleRetry: (messageId: string) => void
  citationMap?: Record<number, number>
  isStreaming?: boolean
  attachments?: AttachmentMetadata[]
}) => {
  const { theme } = useTheme()
  const [isCopied, setIsCopied] = useState(false)
  const { toast } = useToast()
  const citationUrls = citations?.map((c: Citation) => c.url)

  const processMessage = (text: string) => {
    if (!text) return ""
    text = splitGroupedCitationsWithSpaces(text)

    if (citationMap) {
      return text.replace(textToCitationIndexPattern, (match, num) => {
        const index = citationMap[num]
        const url = citationUrls[index]
        return typeof index === "number" && url
          ? `[[${index + 1}]](${url})`
          : ""
      })
    } else {
      return text.replace(textToCitationIndexPattern, (match, num) => {
        const url = citationUrls[num - 1]
        return url ? `[[${num}]](${url})` : ""
      })
    }
  }

  const rawTextForCopy = (text: string) => {
    if (!text) return ""
    text = splitGroupedCitationsWithSpaces(text)
    return text.replace(textToCitationIndexPattern, (match, num) => `[${num}]`)
  }

  return (
    <div className="max-w-full min-w-0 flex flex-col items-end space-y-3">
      {/* Render attachments above the message box for user messages */}
      {isUser && attachments && attachments.length > 0 && (
        <div className="w-full max-w-full">
          <AttachmentGallery attachments={attachments} />
        </div>
      )}

      <div
        className={`rounded-[16px] max-w-full min-w-0 ${isUser ? "bg-[#F0F2F4] dark:bg-slate-700 text-[#1C1D1F] dark:text-slate-100 text-[15px] leading-[25px] self-end pt-[14px] pb-[14px] pl-[20px] pr-[20px] break-words overflow-wrap-anywhere" : "text-[#1C1D1F] dark:text-[#F1F3F4] text-[15px] leading-[25px] self-start w-full max-w-full min-w-0"}`}
      >
        {isUser ? (
          <div
            className="break-words overflow-wrap-anywhere word-break-break-all max-w-full min-w-0"
            dangerouslySetInnerHTML={{ __html: message }}
          />
        ) : (
          <div
            className={`flex flex-col mt-[40px] w-full ${citationUrls && citationUrls.length ? "mb-[35px]" : ""}`} /* Added w-full */
          >
            <div className="flex flex-row w-full">
              {" "}
              {/* Added w-full */}
              <img
                className={"mr-[20px] w-[32px] self-start flex-shrink-0"}
                src={AssistantLogo}
                alt="Agent"
              />
              <div className="mt-[4px] markdown-content w-full">
                {thinking && (
                  <div className="border-l-2 border-[#E6EBF5] dark:border-gray-700 pl-2 mb-4 text-gray-600 dark:text-gray-400">
                    <MarkdownPreview
                      source={processMessage(thinking)}
                      wrapperElement={{
                        "data-color-mode": theme,
                      }}
                      style={{
                        padding: 0,
                        backgroundColor: "transparent",
                        color: theme === "dark" ? "#A0AEC0" : "#627384",
                        fontSize: "15px",
                        maxWidth: "100%",
                        overflowWrap: "break-word",
                      }}
                      components={{
                        a: renderMarkdownLink,
                      }}
                    />
                  </div>
                )}
                {message === "" && !thinking && isStreaming ? (
                  <div className="flex-grow text-[#1C1D1F] dark:text-[#F1F3F4]">
                    {isRetrying ? `Retrying${dots}` : `Thinking${dots}`}
                  </div>
                ) : (
                  <MarkdownPreview
                    source={processMessage(message)}
                    wrapperElement={{
                      "data-color-mode": theme,
                    }}
                    style={{
                      padding: 0,
                      backgroundColor: "transparent",
                      color: theme === "dark" ? "#F1F3F4" : "#1C1D1F",
                      fontSize: "15px",
                      maxWidth: "100%",
                      overflowWrap: "break-word",
                    }}
                    components={{
                      a: renderMarkdownLink,
                      table: ({ node, ...props }) => (
                        <div className="overflow-x-auto w-full my-2">
                          <table
                            style={{
                              borderCollapse: "collapse",
                              borderStyle: "hidden",
                              tableLayout: "auto",
                              width: "100%",
                            }}
                            className="min-w-full dark:bg-slate-800"
                            {...props}
                          />
                        </div>
                      ),
                      th: ({ node, ...props }) => (
                        <th
                          style={{
                            border: "none",
                            padding: "4px 8px",
                            textAlign: "left",
                            overflowWrap: "break-word",
                          }}
                          className="dark:text-gray-200"
                          {...props}
                        />
                      ),
                      td: ({ node, ...props }) => (
                        <td
                          style={{
                            border: "none",
                            borderTop: "1px solid #e5e7eb",
                            padding: "4px 8px",
                            overflowWrap: "break-word",
                          }}
                          className="dark:border-gray-700 dark:text-gray-300"
                          {...props}
                        />
                      ),
                      tr: ({ node, ...props }) => (
                        <tr
                          style={{ backgroundColor: "#ffffff", border: "none" }}
                          className="dark:bg-slate-800"
                          {...props}
                        />
                      ),
                      h1: ({ node, ...props }) => (
                        <h1
                          style={{
                            fontSize: "1.6em",
                            fontWeight: "600",
                            margin: "0.67em 0",
                          }}
                          className="dark:text-gray-100"
                          {...props}
                        />
                      ),
                      h2: ({ node, ...props }) => (
                        <h2
                          style={{
                            fontSize: "1.3em",
                            fontWeight: "600",
                            margin: "0.83em 0",
                          }}
                          className="dark:text-gray-100"
                          {...props}
                        />
                      ),
                      h3: ({ node, ...props }) => (
                        <h3
                          style={{
                            fontSize: "1.1em",
                            fontWeight: "600",
                            margin: "1em 0",
                          }}
                          className="dark:text-gray-100"
                          {...props}
                        />
                      ),
                    }}
                  />
                )}
              </div>
            </div>
            {!isStreaming && messageId && (
              <div className="flex flex-col">
                <div className="flex ml-[52px] mt-[12px] items-center">
                  <Copy
                    size={16}
                    stroke={`${isCopied ? (theme === "dark" ? "#A0AEC0" : "#4F535C") : theme === "dark" ? "#6B7280" : "#B2C3D4"}`}
                    className={`cursor-pointer`}
                    onMouseDown={() => setIsCopied(true)}
                    onMouseUp={() => setTimeout(() => setIsCopied(false), 200)}
                    onClick={() => {
                      navigator.clipboard.writeText(rawTextForCopy(message))
                      toast({
                        description: "Copied to clipboard!",
                        duration: 1500,
                      })
                    }}
                  />
                  <img
                    className={`ml-[18px] ${isStreaming ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                    src={RetryAsset}
                    onClick={() => !isStreaming && handleRetry(messageId!)}
                    alt="Retry"
                  />
                </div>

                {citations && citations.length > 0 && (
                  <div className="flex flex-row ml-[52px]">
                    <TooltipProvider>
                      <ul className={`flex flex-row mt-[24px]`}>
                        {citations
                          .slice(0, 3)
                          .map((citation: Citation, index: number) => (
                            <li
                              key={index}
                              className="border-[#E6EBF5] dark:border-gray-700 border-[1px] rounded-[10px] w-[196px] mr-[6px]"
                            >
                              <div className="flex pl-[12px] pt-[10px] pr-[12px]">
                                <div className="flex flex-col w-full">
                                  <p className="line-clamp-2 text-[13px] tracking-[0.01em] leading-[17px] text-ellipsis font-medium text-[#1C1D1F] dark:text-gray-100">
                                    {citation.title}
                                  </p>
                                  <div className="flex flex-col mt-[9px]">
                                    <div className="flex items-center pb-[12px]">
                                      {getIcon(citation.app, citation.entity, {
                                        w: 14,
                                        h: 14,
                                        mr: 8,
                                      })}
                                      <span
                                        style={{ fontWeight: 450 }}
                                        className="text-[#848DA1] dark:text-gray-400 text-[13px] tracking-[0.01em] leading-[16px] ml-1.5"
                                      >
                                        {getName(citation.app, citation.entity)}
                                      </span>
                                      <span className="flex ml-auto items-center p-[5px] h-[16px] bg-[#EBEEF5] dark:bg-slate-700 dark:text-gray-300 mt-[3px] rounded-full text-[9px] text-[#4A4F59] font-mono">
                                        {index + 1}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </li>
                          ))}
                      </ul>
                    </TooltipProvider>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
