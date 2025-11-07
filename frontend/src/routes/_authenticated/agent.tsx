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
// import { Switch } from "@/components/ui/switch"
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
  AgentPromptPayload,
  DEFAULT_TEST_AGENT_ID,
} from "shared/types"
import {
  ChevronDown,
  ChevronUp,
  X as LucideX,
  RotateCcw,
  RefreshCw,
  Plus,
  Copy,
  ArrowLeft,
  Edit3,
  Trash2,
  Search,
  UserPlus,
  Star,
  Users,
  User,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  BookOpen,
  Eye,
  SlidersHorizontal,
  CalendarDays
} from "lucide-react"
import React, { useState, useMemo, useEffect, useRef, useCallback } from "react"
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
import { useToast } from "@/hooks/use-toast"
import { ChatBox, ChatBoxRef } from "@/components/ChatBox"
import { Card, CardContent } from "@/components/ui/card"
import { ConfirmModal } from "@/components/ui/confirmModal"
import { AgentCard, AgentIconDisplay } from "@/components/AgentCard"
import { AttachmentGallery } from "@/components/AttachmentGallery"
import { createAuthEventSource } from "@/hooks/useChatStream"
import { textToCitationIndex } from "@/utils/chatUtils.tsx"
import { GoogleDriveNavigation } from "@/components/GoogleDriveNavigation"
import { CollectionNavigation } from "@/components/CollectionNavigation"
import ViewAgent from "@/components/ViewAgent"
import agentEmptyStateIcon from "@/assets/emptystateIcons/agent.png"
import { GmailPeopleFilter } from "@/components/agent/GmailPeopleFilter"
import { SlackPeopleFilter } from "@/components/agent/SlackPeopleFilter"
import { SlackChannelFilter } from "@/components/agent/SlackChannelFilter"
import { TimelineFilter } from "@/components/agent/TimelineFilter"
import { FilterBadge } from "@/components/agent/FilterBadge"

type CurrentResp = {
  resp: string
  chatId?: string
  messageId?: string
  sources?: Citation[]
  citationMap?: Record<number, number>
  thinking?: string
}

export const Route = createFileRoute("/_authenticated/agent")({
  validateSearch: z.object({
    agentId: z.string().optional(),
    mode: z.enum(['edit', 'view']).optional(),
  }),
  component: AgentComponent,
})

interface CustomBadgeProps {
  text: string
  onRemove: () => void
  icon?: React.ReactNode
  appId?: string
  filterValue?: string
  onFilterChange?: (value: string) => void
  filterIndex?: number
  slackIdToNameMap?: Record<string, string>
  onUpdateSlackNameMapping?: (id: string, name: string) => void
}

interface FetchedDataSource {
  docId: string
  name: string
  app: string
  entity: string
}

const CustomBadge: React.FC<CustomBadgeProps> = ({
  text, 
  onRemove, 
  icon, 
  appId,
  filterValue,
  onFilterChange,
  slackIdToNameMap,
  onUpdateSlackNameMapping,
}) => {
  // Only show filter input for Gmail and Slack
  const showFilterInput = appId === Apps.Gmail || appId === Apps.Slack

  // State for filter dropdown
  const [isFilterDropdownOpen, setIsFilterDropdownOpen] = useState(false)
  const [filterNavigationPath, setFilterNavigationPath] = useState<Array<{
    id: string
    name: string
    type: "filter-root" | "people" | "channels" | "timeline"
  }>>([])
  
  // State for tracking selected items (needed for Timeline filter)
  const [selectedPeople, setSelectedPeople] = useState<Set<string>>(new Set())
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set())
  
  // Parse selected people and channels from filterValue
  useEffect(() => {
    if (!filterValue) return
    
    const filters = filterValue.split(', ').filter(f => f.trim())

    if (appId === Apps.Slack) {
      // Parse people names (convert to IDs when needed)
      const peopleNames = filters.filter(f => f.startsWith('@')).map(f => f.substring(1))
      setSelectedPeople(new Set(peopleNames))
      
      // Parse channel IDs
      const channelIds = filters.filter(f => f.startsWith('#')).map(f => f.substring(1))
      setSelectedChannels(new Set(channelIds))
    }
  }, [filterValue, appId])
  
  // Define filter options based on app
  const getFilterOptions = () => {
    if (appId === Apps.Slack) {
      return [
        { label: 'People', value: '@people' },
        { label: 'Channels', value: '#channel' },
        { label: 'Timeline', value: '~timeline' }
      ]
    } else if (appId === Apps.Gmail) {
      return [
        { label: 'People', value: '@people' },
        { label: 'Timeline', value: '~timeline' }
      ]
    }
    return []
  }
  
  // Get icon for filter option
  const getFilterIcon = (label: string) => {
    switch (label) {
      case 'People':
        return <User className="w-4 h-4 text-gray-600 dark:text-gray-400" />
      case 'Channels':
        return <span className="text-gray-600 dark:text-gray-400">#</span>
      case 'Timeline':
        return <CalendarDays className="w-4 h-4 text-gray-600 dark:text-gray-400" />
      default:
        return null
    }
  }
  
  const handleFilterOptionSelect = (option: { label: string; value: string }) => {
    if (option.label === 'People') {
      setFilterNavigationPath([
        { id: 'people', name: 'People', type: 'people' }
      ])
    } else if (option.label === 'Channels') {
      setFilterNavigationPath([
        { id: 'channels', name: 'Channels', type: 'channels' }
      ])
    } else if (option.label === 'Timeline') {
      setFilterNavigationPath([
        { id: 'timeline', name: 'Timeline', type: 'timeline' }
      ])
    }
  }
  
  const handleRemoveFilter = (index: number) => {
    const parts = filterValue?.split(', ').filter(p => p.trim()) || []
    const part = parts[index]
    const newParts = parts.filter((_, i) => i !== index)
    onFilterChange?.(newParts.join(', '))
    
    // Update state based on filter type
    if (part?.startsWith('#')) {
      const channelId = part.substring(1)
      setSelectedChannels(prev => {
        const newSet = new Set(prev)
        newSet.delete(channelId)
        return newSet
      })
    } else if (part?.startsWith('@')) {
      const personId = part.substring(1)
      setSelectedPeople(prev => {
        const newSet = new Set(prev)
        newSet.delete(personId)
        return newSet
      })
    }
  }
  
  return (
    <div className="flex items-center gap-3 w-full">
      {/* Fixed width section for app icon, name, and trash */}
      <div className="flex items-center gap-3 text-slate-700 dark:text-slate-200 text-base font-normal w-[200px] flex-shrink-0">
        {icon && <span className="flex items-center flex-shrink-0">{icon}</span>}
        <span className="truncate flex-1">{text}</span>
        <Trash2
          className="h-4 w-4 cursor-pointer text-gray-400 hover:text-red-500 dark:hover:text-red-400 flex-shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        />
      </div>
      {/* Filter input takes remaining space */}
      {showFilterInput && (
        <div className="flex-1 relative">
          <div className="flex items-center gap-2 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-slate-700">
            <DropdownMenu
              open={isFilterDropdownOpen}
              onOpenChange={(open) => {
                setIsFilterDropdownOpen(open)
                if (!open) {
                  setFilterNavigationPath([])
                }
              }}
            >
              <DropdownMenuTrigger asChild>
                <SlidersHorizontal className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 flex-shrink-0 h-3.5 w-3.5 cursor-pointer" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-[440px] p-0 bg-gray-100 dark:bg-gray-800 rounded-xl"
                align="start"
              >
                <div className="flex items-center justify-between px-4 py-2">
                  <div className="flex items-center justify-between w-full">
                    <div className="flex items-center overflow-hidden max-w-[75%]">
                      {filterNavigationPath.length > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (filterNavigationPath.length === 1) {
                              setFilterNavigationPath([])
                            } else {
                              setFilterNavigationPath(prev => prev.slice(0, -1))
                            }
                          }}
                          className="p-0 h-auto w-auto text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 mr-2 flex-shrink-0"
                        >
                          <ChevronLeft size={12} />
                        </Button>
                      )}
                      {filterNavigationPath.length > 0 ? (
                        <div className="flex items-center text-xs text-gray-600 dark:text-gray-300 whitespace-nowrap overflow-hidden">
                          <span
                            className="cursor-pointer hover:text-gray-800 dark:hover:text-gray-100 text-xs whitespace-nowrap flex-shrink-0"
                            onClick={() => {
                              setFilterNavigationPath([])
                            }}
                          >
                            FILTERS
                          </span>
                          {filterNavigationPath.map((item, index) => (
                            <React.Fragment key={`${item.id}-${index}`}>
                              <span className="mx-2 flex-shrink-0">/</span>
                              <span
                                className={`max-w-[60px] truncate ${index < filterNavigationPath.length - 1 ? "cursor-pointer hover:text-gray-800 dark:hover:text-gray-100" : "font-medium"}`}
                                title={item.name}
                              >
                                {item.name}
                              </span>
                            </React.Fragment>
                          ))}
                        </div>
                      ) : (
                        <span className="p-0 text-xs text-gray-600 dark:text-gray-300">
                          FILTERS
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="bg-white dark:bg-gray-900 max-h-72 min-h-72 overflow-y-auto rounded-lg mx-1 mb-1">
                  {filterNavigationPath.length === 0 ? (
                    // Main filter menu
                    <>
                      {getFilterOptions().map((option) => (
                        <DropdownMenuItem
                          key={option.value}
                          onSelect={(e) => {
                            e.preventDefault()
                            handleFilterOptionSelect(option)
                          }}
                          className="flex items-center justify-between cursor-pointer text-sm py-2.5 px-4 hover:!bg-transparent focus:!bg-transparent data-[highlighted]:!bg-transparent"
                        >
                          <div className="flex items-center">
                            <span className="mr-2 flex items-center">
                              {getFilterIcon(option.label)}
                            </span>
                            <span className="text-gray-700 dark:text-gray-200">
                              {option.label}
                            </span>
                          </div>
                          <ChevronRight className="h-4 w-4 text-gray-400" />
                        </DropdownMenuItem>
                      ))}
                    </>
                  ) : filterNavigationPath[filterNavigationPath.length - 1]?.type === 'people' ? (
                    // People selection view - different for Gmail vs Slack
                    appId === 'gmail' ? (
                      <GmailPeopleFilter
                        filterValue={filterValue}
                        onFilterChange={onFilterChange || (() => {})}
                      />
                    ) : (
                      <SlackPeopleFilter
                        filterValue={filterValue}
                        onFilterChange={onFilterChange || (() => {})}
                        onUpdateNameMapping={onUpdateSlackNameMapping}
                      />
                    )
                  ) : filterNavigationPath[filterNavigationPath.length - 1]?.type === 'channels' ? (
                    <SlackChannelFilter
                      filterValue={filterValue}
                      onFilterChange={onFilterChange || (() => {})}
                      onUpdateNameMapping={onUpdateSlackNameMapping}
                    />
                  ) : filterNavigationPath[filterNavigationPath.length - 1]?.type === 'timeline' ? (
                    <TimelineFilter
                      filterValue={filterValue}
                      onFilterChange={onFilterChange || (() => {})}
                      selectedPeople={selectedPeople}
                      selectedChannels={selectedChannels}
                    />
                  ) : null}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="flex-1 flex flex-wrap items-center gap-1.5">
              <FilterBadge
                filters={filterValue?.split(', ').filter(f => f.trim()) || []}
                onRemoveFilter={handleRemoveFilter}
                idToNameMap={slackIdToNameMap}
              />
            </div>
          </div>
        </div>
      )}
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

export const availableIntegrationsList: IntegrationSource[] = [
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

interface User {
  id: number
  name: string
  email: string
}

export interface CollectionItem {
  id: string
  collectionId: string
  path?: string
  type?: "collection" | "folder" | "file"
  name?: string
}
// Icon components
export const FileIcon: React.FC<{ className?: string }> = ({
  className = "mr-2 text-blue-600",
}) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="mr-2 text-blue-600"
  >
    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
    <polyline points="13 2 13 9 20 9"></polyline>
  </svg>
)

export const FolderIcon: React.FC<{ className?: string }> = ({
  className = "mr-2 text-blue-600",
}) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="mr-2 text-blue-600"
  >
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
  </svg>
)

export const CollectionIcon: React.FC<{ className?: string }> = ({
  className = "mr-2 text-blue-600",
}) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="mr-2 text-blue-600"
  >
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
  </svg>
)
export const getItemIcon = (itemType: string): React.ReactNode => {
  switch (itemType) {
    case "folder":
      return <FolderIcon />
    case "collection":
      return <CollectionIcon />
    case "file":
    default:
      return <FileIcon />
  }
}

// Utility function to check if an item is selected either directly or through parent inheritance
function isItemSelectedWithInheritance(
  item: CollectionItem,
  selectedItemsInCollection: Record<string, Set<string>>,
  selectedIntegrations: Record<string, boolean>,
  selectedItemDetailsInCollection: Record<
    string,
    Record<string, CollectionItem>
  >,
): boolean {
  const collectionId = item.collectionId
  if (!collectionId) return false

  const selectedSet = selectedItemsInCollection[collectionId] || new Set()

  // Check if item is directly selected
  if (selectedSet.has(item.id)) {
    return true
  }

  // Check if collection is in selectAll mode
  const hasCollectionIntegrationSelected =
    !!selectedIntegrations[`cl_${collectionId}`]
  const isCollectionSelectAll =
    hasCollectionIntegrationSelected && selectedSet.size === 0
  if (isCollectionSelectAll) {
    return true
  }

  // Check if any parent folder is selected (inheritance)
  if (item.path && item.type !== "collection") {
    const itemDetails = selectedItemDetailsInCollection[collectionId] || {}

    // Check if any selected folder in this collection is a parent of this item
    for (const selectedId of selectedSet) {
      const selectedItemDetail = itemDetails[selectedId]
      if (selectedItemDetail && selectedItemDetail.type === "folder") {
        const folderPath = selectedItemDetail.path || ""
        const itemPath = item.path || ""

        // Normalize paths by removing leading/trailing slashes
        const normalizedFolderPath = folderPath.replace(/^\/+|\/+$/g, "")
        const normalizedItemPath = itemPath.replace(/^\/+|\/+$/g, "")

        // Check if this item's path starts with the selected folder's path
        if (
          normalizedItemPath.startsWith(normalizedFolderPath + "/") ||
          (normalizedFolderPath === "" && normalizedItemPath !== "") ||
          normalizedItemPath === normalizedFolderPath
        ) {
          return true
        }
      }
    }
  }

  return false
}

function AgentComponent() {
  const { agentId, mode } = Route.useSearch()
  const navigate = useNavigate()
  const [viewMode, setViewMode] = useState<
    "list" | "create" | "edit" | "viewAgent"
  >("list")
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
  const [viewingAgent, setViewingAgent] = useState<SelectPublicAgent | null>(
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
  const [fetchedCollections, setFetchedCollections] = useState<
    Array<{ id: string; name: string; description?: string }>
  >([])
  const [selectedIntegrations, setSelectedIntegrations] = useState<
    Record<string, boolean>
  >({})
  // State for managing multiple filters per app (Gmail and Slack)
  const [appFilters, setAppFilters] = useState<Record<string, string[]>>({})
  const [slackIdToNameMap, setSlackIdToNameMap] = useState<Record<string, string>>({})
  const [isIntegrationMenuOpen, setIsIntegrationMenuOpen] = useState(false)
  const [selectedItemsInCollection, setSelectedItemsInCollection] = useState<
    Record<string, Set<string>>
  >({})
  const [selectedItemDetailsInCollection, setSelectedItemDetailsInCollection] =
    useState<Record<string, Record<string, any>>>({})
  // Google Drive item selection state
  const [selectedItemsInGoogleDrive, setSelectedItemsInGoogleDrive] = useState<
    Set<string>
  >(new Set())
  const [
    selectedItemDetailsInGoogleDrive,
    setSelectedItemDetailsInGoogleDrive,
  ] = useState<Record<string, any>>({})
  // Store mapping of integration IDs to their names and types
  const [integrationIdToNameMap, setIntegrationIdToNameMap] = useState<
    Record<string, { name: string; type: string }>
  >({})
  const [navigationPath, setNavigationPath] = useState<
    Array<{
      id: string
      name: string
      type: "cl-root" | "cl" | "folder" | "drive-root" | "drive-folder"
    }>
  >([])
  const [currentItems, setCurrentItems] = useState<any[]>([])
  const [isLoadingItems, setIsLoadingItems] = useState(false)
  const [dropdownSearchQuery, setDropdownSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [isSearching, setIsSearching] = useState(false)

  // Function to get icon for Google Drive entity
  const getDriveEntityIcon = (entity: string) => {
    return getIcon(Apps.GoogleDrive, entity as any, { w: 16, h: 16, mr: 8 })
  }

  // Google Drive navigation functions
  const navigateToGoogleDrive = async () => {
    setNavigationPath([
      { id: "drive-root", name: "Google Drive", type: "drive-root" },
    ])
    setDropdownSearchQuery("")
    setIsLoadingItems(true)
    try {
      const response = await api.search.driveitem.$post({
        json: { parentId: "" },
      })
      if (response.ok) {
        const data = await response.json()
        // Extract the actual items from the Vespa response structure
        const items = data?.root?.children || []

        setCurrentItems(items)
      }
    } catch (error) {
      console.error("Failed to fetch Google Drive items:", error)
    } finally {
      setIsLoadingItems(false)
    }
  }

  const navigateToDriveFolder = async (
    folderId: string,
    folderName: string,
  ) => {
    setNavigationPath((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].id === folderId) {
        return prev
      }
      return [...prev, { id: folderId, name: folderName, type: "drive-folder" }]
    })

    setIsLoadingItems(true)
    try {
      const response = await api.search.driveitem.$post({
        json: { parentId: folderId },
      })
      if (response.ok) {
        const data = await response.json()
        // Extract the actual items from the Vespa response structure
        const items = data?.root?.children || []

        setCurrentItems(items)
      }
    } catch (error) {
      console.error("Failed to fetch Google Drive folder items:", error)
    } finally {
      setIsLoadingItems(false)
    }
  }

  const fetchGoogleDriveItemsByDocIds = async (
    docIds: string[],
  ): Promise<any[]> => {
    try {
      const response = await api.search.driveitemsbydocids.$post({
        json: { docIds },
      })
      if (response.ok) {
        const data = await response.json()
        // Extract the actual items from the Vespa response structure
        return data?.root?.children || []
      }
      return []
    } catch (error) {
      console.error("Failed to fetch Google Drive items by docIds:", error)
      return []
    }
  }

  // Collection navigation function
  const navigateToCl = async (clId: string, clName: string) => {
    // Update navigation path based on current context
    const newPath =
      navigationPath.length === 1 && navigationPath[0].type === "cl-root"
        ? [
          {
            id: "cl-root",
            name: "Collection",
            type: "cl-root" as const,
          },
          {
            id: clId,
            name: clName,
            type: "cl" as const,
          },
        ]
        : [
          {
            id: clId,
            name: clName,
            type: "cl" as const,
          },
        ]

    setNavigationPath(newPath)
    setIsLoadingItems(true)
    try {
      const response = await api.cl[":clId"].items.$get({
        param: { clId: clId },
      })
      if (response.ok) {
        const data = await response.json()
        setCurrentItems(data)
      }
    } catch (error) {
      console.error("Failed to fetch CL items:", error)
    } finally {
      setIsLoadingItems(false)
    }
  }

  // Global search effect for collection dropdown
  useEffect(() => {
    const performGlobalSearch = async () => {
      if (!dropdownSearchQuery.trim()) {
        setSearchResults([])
        return
      }
      setIsSearching(true)
      try {
        // Check if we're currently in Google Drive navigation context
        const isInGoogleDriveContext = navigationPath.some(
          (item) => item.type === "drive-root" || item.type === "drive-folder",
        )

        let response
        if (isInGoogleDriveContext) {
          response = await api.search.$get({
            query: {
              query: dropdownSearchQuery,
              app: Apps.GoogleDrive,
              isAgentIntegSearch: true,
              entity: Object.values(DriveEntity),
            },
          })
        } else {
          // Use the new Knowledge Base search API that searches PostgreSQL
          response = await api.cl.search.$get({
            query: {
              query: dropdownSearchQuery,
              type: "all", // Search collections, folders, and files
              limit: 20,
            },
          })
        }

        if (response.ok) {
          const data = await response.json()

          if (isInGoogleDriveContext) {
            // Handle Google Drive search results
            setSearchResults(data.results || [])
          } else {
            // Transform the knowledge base results to match the expected format
            const transformedResults = data.results.map((item: any) => ({
              id: item.id,
              name: item.name,
              type: item.type,
              docId: item.id,
              title: item.name,
              entity: item.type,
              collectionId: item.collectionId,
              collectionName: item.collectionName,
              path: item.path,
              mimeType: item.mimeType,
              fileSize: item.fileSize,
              description: item.description,
              metadata: item.metadata,
            }))
            setSearchResults(transformedResults)
          }
        } else {
          setSearchResults([])
        }
      } catch (error) {
        console.error("Global search failed:", error)
        setSearchResults([])
      } finally {
        setIsSearching(false)
      }
    }

    const debounceSearch = setTimeout(performGlobalSearch, 300)
    return () => clearTimeout(debounceSearch)
  }, [dropdownSearchQuery, navigationPath])

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

  const chatBoxRef = useRef<ChatBoxRef>(null)

  const matches = useRouterState({ select: (s) => s.matches })
  const { user, agentWhiteList } = matches[matches.length - 1].context
  const { toast } = useToast()

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

  const toggleFavorite = useCallback((agentExternalId: string) => {
    setFavoriteAgents((prevFavorites) =>
      prevFavorites.includes(agentExternalId)
        ? prevFavorites.filter((id) => id !== agentExternalId)
        : [...prevFavorites, agentExternalId],
    )
  }, [])

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
            toast.error({
              title: "Error",
              description: `Failed to load agent ${agentId} for chat.`,
            })
          }
        } catch (error) {
          toast.error({
            title: "Error",
            description: "An error occurred while loading agent for chat.",
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
  }, [agentId, toast])

  const handleEditAgent = useCallback((agent: SelectPublicAgent) => {
    resetForm()
    setEditingAgent(agent)
    setViewMode("create")
  }, [])// Empty deps because resetForm and setState functions are stable



  useEffect(() => {
    const abortController = new AbortController()  // ✅ Create abort controller

    const loadAgentForEdit = async () => {
      if (agentId && mode === 'edit') {
        try {
          const response = await api.agent[":agentExternalId"].$get({
            param: { agentExternalId: agentId },
          }, {
            signal: abortController.signal  // ✅ Pass abort signal to request
          })

          // ✅ No need to check cancelled flag - request is aborted
          if (response.ok) {
            const agentData = (await response.json()) as SelectPublicAgent
            handleEditAgent(agentData)
          } else {
            toast.error({
              title: "Error",
              description: `Failed to load agent ${agentId} for editing.`,
            })
          }
        } catch (error) {
          // ✅ AbortError is thrown when request is cancelled
          if (error instanceof Error && error.name === 'AbortError') {
            console.log('Agent fetch was cancelled')
            return  // Don't show error toast for intentional cancellation
          }

          toast.error({
            title: "Error",
            description: "An error occurred while loading agent for editing.",
          })
          console.error("Fetch agent for edit error:", error)
        }
      }
    }

    loadAgentForEdit()

    return () => {
      abortController.abort()  // ✅ Actually cancel the HTTP request
    }
  }, [agentId, mode, handleEditAgent])  // ✅ Include handleEditAgent in deps


  // Cleanup EventSource on component unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      cleanupPromptGenerationEventSource()
    }
  }, [])

  type AgentFilter = "all" | "madeByMe" | "sharedToMe"

  const fetchAgents = async (filter: AgentFilter = "all") => {
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
        toast.error({
          title: "Error",
          description: `Failed to fetch agents (${filter}).`,
        })
      }
    } catch (error) {
      toast.error({
        title: "Error",
        description: `An error occurred while fetching agents (${filter}).`,
      })
      console.error(`Fetch agents error (${filter}):`, error)
    } 
  }

  const fetchAllAgentData = async () => {
      setIsLoadingAgents(true)
    await Promise.all([
      fetchAgents("all"),
      fetchAgents("madeByMe"),
      fetchAgents("sharedToMe"),
    ])
     setIsLoadingAgents(false)
  }

  useEffect(() => {
    const run = async () => {
      if (viewMode === "list") {
        await fetchAllAgentData()
      } else {
        setIsLoadingAgents(true)
        try {
          await fetchAgents("all")
        } finally {
          setIsLoadingAgents(false)
        }
      }
    }
    run()
  }, [viewMode])

  useEffect(() => {
    const fetchDataSourcesAsync = async () => {
      if (viewMode === "create" || viewMode === "edit") {
        try {
          // Fetch both data sources and collections in parallel
          const [dsResponse, clResponse] = await Promise.all([
            api.datasources.$get(),
            api.cl.$get(),
          ])

          if (dsResponse.ok) {
            const data = await dsResponse.json()
            setFetchedDataSources(data as FetchedDataSource[])
          } else {
            toast.error({
              title: "Error",
              description: "Failed to fetch data sources.",
            })
            setFetchedDataSources([])
          }

          if (clResponse.ok) {
            const clData = await clResponse.json()
            setFetchedCollections(clData)
          } else {
            toast.error({
              title: "Error",
              description: "Failed to fetch collections.",
            })
            setFetchedCollections([])
          }
        } catch (error) {
          toast.error({
            title: "Error",
            description: "An error occurred while fetching data sources.",
          })
          console.error("Fetch data sources error:", error)
          setFetchedDataSources([])
          setFetchedCollections([])
        }
      } else {
        setFetchedDataSources([])
        setFetchedCollections([])
      }
    }
    fetchDataSourcesAsync()
  }, [viewMode, toast])

  useEffect(() => {
    const loadUsers = async () => {
      try {
        const response = await api.workspace.users.$get()
        if (response.ok) {
          const data = await response.json()
          setUsers(data as User[])
        } else {
          toast.error({
            title: "Error",
            description: "Failed to fetch workspace users.",
          })
        }
      } catch (error) {
        toast.error({
          title: "Error",
          description: "An error occurred while fetching workspace users.",
        })
        console.error("Fetch workspace users error:", error)
      }
    }
    loadUsers()
  }, [toast])

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
      toast.error({
        title: "Error",
        description: "Please enter requirements for prompt generation.",
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
          title: "Error",
          description: "Something went wrong. Please try again.",
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
            toast.success({
              title: "Success",
              description: "Prompt generated successfully!",
            })
          } catch (e) {
            console.warn("Could not parse end event data:", e)
            toast.success({
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
            toast.error({
              title: "Error",
              description: data.error || "Failed to generate prompt",
            })
          } catch (e) {
            toast.error({
              title: "Error",
              description: "Failed to generate prompt",
            })
          }
          cleanupPromptGenerationEventSource()
          setIsGeneratingPrompt(false)
        },
      )

      promptGenerationEventSourceRef.current.onerror = (error) => {
        console.error("EventSource error:", error)
        toast.error({
          title: "Error",
          description: "Connection error during prompt generation",
        })
        cleanupPromptGenerationEventSource()
        setIsGeneratingPrompt(false)
      }
    } catch (error) {
      console.error("Generate prompt error:", error)
      toast.error({
        title: "Error",
        description: "Failed to generate prompt",
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

      toast.warning({
        title: "Add some requirements first",
        description:
          "Please enter some text describing what you want your agent to do, then click generate.",
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
    setSelectedItemsInCollection({})
    setSelectedItemDetailsInCollection({})
    setSelectedItemsInGoogleDrive(new Set())
    setSelectedItemDetailsInGoogleDrive({})
    setEditingAgent(null)
    setSelectedUsers([])
    setSearchQuery("")
    setShowSearchResults(false)
    setIsGeneratingPrompt(false)
    setShouldHighlightPrompt(false)
    cleanupPromptGenerationEventSource()
    setAppFilters({})
  }

  const handleCreateNewAgent = () => {
    resetForm()
    setViewMode("create")
  }


  const handleViewAgent = (agent: SelectPublicAgent) => {
    setViewingAgent(agent)
    setViewMode("viewAgent")
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
    const collectionSources: IntegrationSource[] = fetchedCollections.map(
      (cl) => ({
        id: `cl_${cl.id}`,
        name: cl.name,
        app: "knowledge-base",
        entity: "cl",
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mr-2 text-blue-600"
          >
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
            <path d="M12 6v8"></path>
            <path d="M8 10h8"></path>
          </svg>
        ),
      }),
    )
    return [
      ...availableIntegrationsList,
      ...dynamicDataSources,
      ...collectionSources,
    ]
  }, [fetchedDataSources, isRagOn, fetchedCollections])

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

      // Fetch integration items for this agent
      const fetchAgentIntegrationItems = async () => {
        try {
          const response = await api.agent[":agentExternalId"][
            "integration-items"
          ].$get({
            param: { agentExternalId: editingAgent.externalId },
          })
          if (response.ok) {
            const data = await response.json()

            const idToNameMapping: Record<
              string,
              { name: string; type: string }
            > = {}

            // Extract items and build ID to name mapping
            if (
              data.integrationItems.collection &&
              data.integrationItems.collection.groups
            ) {
              for (const [clGroupId, items] of Object.entries(
                data.integrationItems.collection.groups,
              )) {
                if (Array.isArray(items)) {
                  // For knowledge-base items, use the data directly from the API response
                  items.forEach((item: any) => {
                    const itemType = item.type || "file"
                    idToNameMapping[item.id] = {
                      name: item.name || item.id || "Unnamed",
                      type: itemType,
                    }
                  })
                }

                // Also add CL group ID to name mapping if available
                if (clGroupId) {
                  // Try to find the CL name from the fetched collections
                  const cl = fetchedCollections.find(
                    (cl) => cl.id === clGroupId,
                  )
                  if (cl) {
                    idToNameMapping[clGroupId] = {
                      name: cl.name,
                      type: "collection",
                    }
                  }
                }
              }
            }
            // Update the ID to name mapping state
            setIntegrationIdToNameMap(idToNameMapping)

            // Process collection items if they exist
            if (
              data.integrationItems.collection &&
              data.integrationItems.collection.groups
            ) {
              const clSelections: Record<string, Set<string>> = {}
              const clDetails: Record<string, Record<string, any>> = {}

              // Process each collection group
              for (const [clId, items] of Object.entries(
                data.integrationItems.collection.groups,
              )) {
                if (Array.isArray(items) && items.length > 0) {
                  const selectedItems = new Set<string>()
                  const itemDetails: Record<string, any> = {}

                  // Check if this is a collection-level selection
                  const hasCollectionLevelSelection = items.some(
                    (item: any) => item.isCollectionLevel,
                  )

                  if (hasCollectionLevelSelection) {
                    // This is a collection-level selection (entire collection selected)
                    // Mark the Collection integration as selected but no specific items
                    setSelectedIntegrations((prev) => ({
                      ...prev,
                      [`cl_${clId}`]: true,
                    }))

                    // Add collection to name mapping
                    const collectionItem = items.find(
                      (item: any) => item.isCollectionLevel,
                    )
                    if (collectionItem) {
                      idToNameMapping[clId] = {
                        name: collectionItem.name,
                        type: "collection",
                      }
                    }
                  } else {
                    // These are specific file/folder selections
                    items.forEach((item: any) => {
                      if (!item.isCollectionLevel) {
                        selectedItems.add(item.id)
                        itemDetails[item.id] = {
                          id: item.id,
                          name: item.name || item.id || "Unnamed",
                          type: item.type || "file",
                          path: item.path,
                          collectionId: clId,
                        }

                        // Add to name mapping
                        idToNameMapping[item.id] = {
                          name: item.name || item.id || "Unnamed",
                          type: item.type || "file",
                        }
                      }
                    })

                    if (selectedItems.size > 0) {
                      clSelections[clId] = selectedItems
                      clDetails[clId] = itemDetails

                      // Mark the Collection integration as selected
                      setSelectedIntegrations((prev) => ({
                        ...prev,
                        [`cl_${clId}`]: true,
                      }))
                    }
                  }

                  // Add collection to name mapping if not already added
                  if (!idToNameMapping[clId]) {
                    const cl = fetchedCollections.find((cl) => cl.id === clId)
                    if (cl) {
                      idToNameMapping[clId] = {
                        name: cl.name,
                        type: "collection",
                      }
                    }
                  }
                }
              }

              setSelectedItemsInCollection(clSelections)
              setSelectedItemDetailsInCollection(clDetails)
            }

            // Update the ID to name mapping state
            setIntegrationIdToNameMap(idToNameMapping)
          } else {
            console.warn(
              "Failed to fetch agent integration items:",
              response.statusText,
            )
          }
        } catch (error) {
          console.error("Error fetching agent integration items:", error)
        }
      }

      fetchAgentIntegrationItems()
    }
  }, [editingAgent, viewMode, fetchedCollections])

  useEffect(() => {
    if (
      editingAgent &&
      (viewMode === "create" || viewMode === "edit") &&
      allAvailableIntegrations.length > 0
    ) {
      const currentIntegrations: Record<string, boolean> = {}
      const clSelections: Record<string, Set<string>> = {}
      const clDetails: Record<string, Record<string, any>> = {}

      allAvailableIntegrations.forEach((int) => {
        // Handle legacy array format
        if (Array.isArray(editingAgent.appIntegrations)) {
          currentIntegrations[int.id] =
            editingAgent.appIntegrations.includes(int.id) || false
        } else if (
          editingAgent.appIntegrations &&
          typeof editingAgent.appIntegrations === "object"
        ) {
          // Handle both old and new object formats
          const appIntegrations = editingAgent.appIntegrations as Record<
            string,
            any
          >

          // Check if it's a collection
          if (int.id.startsWith("cl_")) {
            const clId = int.id.replace("cl_", "")

            // Handle new format: knowledge_base key with itemIds array
            if (appIntegrations["knowledge_base"]) {
              const clConfig = appIntegrations["knowledge_base"]
              const itemIds = clConfig.itemIds || []

              // Check if this CL is referenced in the itemIds
              const isClSelected = itemIds.some(
                (id: string) =>
                  id === `cl-${clId}` || // Collection-level selection
                  id.startsWith(`clfd-${clId}`) || // Folder in this collection
                  id.startsWith(`clf-${clId}`), // File in this collection
              )

              if (isClSelected) {
                currentIntegrations[int.id] = true

                // Check if it's a collection-level selection
                const hasCollectionSelection = itemIds.includes(`cl-${clId}`)
                if (hasCollectionSelection) {
                  clSelections[clId] = new Set() // Empty set means selectAll
                } else {
                  // Filter itemIds that belong to this CL and extract the actual item IDs
                  const clItemIds = itemIds
                    .filter(
                      (itemId: string) =>
                        itemId.startsWith(`clfd-`) || itemId.startsWith(`clf-`),
                    )
                    .map((itemId: string) => {
                      // Extract the actual item ID by removing the prefix
                      if (itemId.startsWith(`clfd-`)) {
                        return itemId.substring(5) // Remove 'clfd-' prefix
                      } else if (itemId.startsWith(`clf-`)) {
                        return itemId.substring(4) // Remove 'clf-' prefix
                      }
                      return itemId
                    })

                  if (clItemIds.length > 0) {
                    const selectedItems = new Set<string>(clItemIds)
                    clSelections[clId] = selectedItems

                    // Create mock item details for display
                    const itemDetailsForCl: Record<string, any> = {}
                    clItemIds.forEach((itemId: string, index: number) => {
                      const originalId = itemIds.find((id: string) =>
                        id.endsWith(itemId),
                      )
                      const itemType = originalId?.startsWith(`clfd-`)
                        ? "folder"
                        : "file"
                      itemDetailsForCl[itemId] = {
                        id: itemId,
                        name: itemId, // Use itemId as name for now
                        type: itemType,
                      }
                    })
                    clDetails[clId] = itemDetailsForCl
                  }
                }
              }
            }
            // Handle legacy format: collection key with itemIds array
            else if (appIntegrations["collection"]) {
              const clConfig = appIntegrations["collection"]
              const itemIds = clConfig.itemIds || []

              // Check if this CL is referenced in the itemIds
              const isClSelected =
                itemIds.includes(int.name) || // CL name is in itemIds (selectAll case)
                itemIds.some((id: string) => id.startsWith(clId)) // Some items from this CL are selected

              if (isClSelected) {
                currentIntegrations[int.id] = true

                // If only CL name is in itemIds, it means selectAll
                if (itemIds.includes(int.name) && itemIds.length === 1) {
                  clSelections[clId] = new Set() // Empty set means selectAll
                } else {
                  // Filter itemIds that belong to this CL
                  const clItemIds = itemIds.filter(
                    (id: string) =>
                      id !== int.name &&
                      (id.startsWith(clId) || id.includes(clId)),
                  )

                  if (clItemIds.length > 0) {
                    const selectedItems = new Set<string>(clItemIds)
                    clSelections[clId] = selectedItems

                    // Create mock item details for display
                    const itemDetailsForCl: Record<string, any> = {}
                    clItemIds.forEach((itemId: string, index: number) => {
                      itemDetailsForCl[itemId] = {
                        id: itemId,
                        name: itemId, // Use itemId as name for now
                        type: "file", // Default to file type
                      }
                    })
                    clDetails[clId] = itemDetailsForCl
                  }
                }
              }
            }
            // Handle old format: collections key with nested structure
            else if (
              appIntegrations["collections"] &&
              appIntegrations["collections"][int.name]
            ) {
              const clConfig = appIntegrations["collections"][int.name]
              currentIntegrations[int.id] = true

              // Parse folders to recreate selections
              if (clConfig.folders && clConfig.folders.length > 0) {
                const selectedItems = new Set<string>()

                // For each item in folders array, determine if it's a file or folder
                // Files have extensions in their names, folders do not
                clConfig.folders.forEach((folder: any, index: number) => {
                  // Determine if this is a file or folder based on file extension in the name
                  const hasFileExtension = /\.[a-zA-Z0-9]+$/.test(folder.name)
                  const itemType = hasFileExtension ? "file" : "folder"
                  const itemId = `${itemType}_${folder.name}_${Date.now()}_${index}`
                  selectedItems.add(itemId)

                  if (!clDetails[clId]) {
                    clDetails[clId] = {}
                  }
                  clDetails[clId][itemId] = {
                    id: itemId,
                    name: folder.name,
                    type: itemType,
                    vespaIds: folder.ids, // Store the vespa IDs for reference
                  }
                })

                clSelections[clId] = selectedItems
              } else if (clConfig.selectAll) {
                // If selectAll is true, mark the CL as selected but no specific items
                clSelections[clId] = new Set()
              }
            }
          }
          // Handle DataSource key (new format for grouped data sources)
          else if (
            int.app === Apps.DataSource &&
            appIntegrations["DataSource"]
          ) {
            const dsConfig = appIntegrations["DataSource"]
            const itemIds = dsConfig.itemIds || []

            // Check if this data source is in the itemIds array
            if (itemIds.includes(int.id)) {
              currentIntegrations[int.id] = true
            }
          }
          // Handle Google Drive integration
          else if (int.id === "googledrive" && appIntegrations["googledrive"]) {
            const driveConfig = appIntegrations["googledrive"]
            currentIntegrations[int.id] = true

            // If specific items are selected (not selectedAll), fetch them by docIds
            if (
              !driveConfig.selectedAll &&
              driveConfig.itemIds &&
              driveConfig.itemIds.length > 0
            ) {
              // Fetch Google Drive items by their docIds
              fetchGoogleDriveItemsByDocIds(driveConfig.itemIds)
                .then((items) => {
                  if (items && items.length > 0) {
                    const driveSelections = new Set<string>()
                    const driveDetails: Record<string, any> = {}

                    items.forEach((item) => {
                      const itemId = item.id || item.fields?.docId
                      if (itemId) {
                        driveSelections.add(itemId)
                        driveDetails[itemId] = item
                      }
                    })

                    setSelectedItemsInGoogleDrive(driveSelections)
                    setSelectedItemDetailsInGoogleDrive(driveDetails)
                  }
                })
                .catch((error) => {
                  console.error("Failed to fetch Google Drive items:", error)
                })
            }
          } else {
            // Handle other integrations - check both new format (with selectedAll) and old format
            if (appIntegrations[int.id]) {
              if (
                typeof appIntegrations[int.id] === "object" &&
                appIntegrations[int.id].selectedAll !== undefined
              ) {
                // New format with selectedAll property
                currentIntegrations[int.id] =
                  appIntegrations[int.id].selectedAll ||
                  appIntegrations[int.id].itemIds?.length > 0
              } else {
                // Old format - just a boolean or truthy value
                currentIntegrations[int.id] = !!appIntegrations[int.id]
              }
            }
          }
        }
      })
      setSelectedIntegrations(currentIntegrations)
      setSelectedItemsInCollection(clSelections)
      setSelectedItemDetailsInCollection(clDetails)
    }
  }, [editingAgent, viewMode, allAvailableIntegrations])

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
      
      // Load existing filters from appIntegrations and fetch names for Slack IDs
      const loadFiltersWithNames = async () => {
        if (editingAgent.appIntegrations && typeof editingAgent.appIntegrations === 'object') {
          const appIntegrations = editingAgent.appIntegrations as Record<string, any>
          const loadedFilters: Record<string, string[]> = {}
          const slackIdsToFetch: string[] = []
          
          // Check for Gmail filters
          if (appIntegrations.gmail?.filters && Array.isArray(appIntegrations.gmail.filters)) {
            const gmailFilterStrings: string[] = []
            
            for (const filter of appIntegrations.gmail.filters) {
              const filterParts: string[] = []
              
              // Add from emails
              if (filter.from && Array.isArray(filter.from)) {
                filterParts.push(...filter.from.map((email: string) => `from:${email}`))
              }
              
              // Add to emails
              if (filter.to && Array.isArray(filter.to)) {
                filterParts.push(...filter.to.map((email: string) => `to:${email}`))
              }
              
              // Add cc emails
              if (filter.cc && Array.isArray(filter.cc)) {
                filterParts.push(...filter.cc.map((email: string) => `cc:${email}`))
              }
              
              // Add bcc emails
              if (filter.bcc && Array.isArray(filter.bcc)) {
                filterParts.push(...filter.bcc.map((email: string) => `bcc:${email}`))
              }
              
              // Add time range
              if (filter.timeRange) {
                const { startDate, endDate } = filter.timeRange
                const start = new Date(startDate * 1000)
                const end = new Date(endDate * 1000)
                const formatDate = (date: Date) => {
                  const day = String(date.getDate()).padStart(2, '0')
                  const month = String(date.getMonth() + 1).padStart(2, '0')
                  const year = date.getFullYear()
                  return `${day}/${month}/${year}`
                }
                filterParts.push(`~${formatDate(start)} → ${formatDate(end)}`)
              }
              
              if (filterParts.length > 0) {
                gmailFilterStrings.push(filterParts.join(', '))
              }
            }
            
            if (gmailFilterStrings.length > 0) {
              loadedFilters.gmail = gmailFilterStrings
            }
          }
          
          // Check for Slack filters - keep IDs and collect them for fetching names
          if (appIntegrations.slack?.filters && Array.isArray(appIntegrations.slack.filters)) {
            const slackFilterStrings: string[] = []
            
            for (const filter of appIntegrations.slack.filters) {
              const filterParts: string[] = []
              
              // Add sender IDs and collect for fetching
              if (filter.senderId && Array.isArray(filter.senderId)) {
                filterParts.push(...filter.senderId.map((id: string) => `@${id}`))
                slackIdsToFetch.push(...filter.senderId)
              }
              
              // Add channel IDs and collect for fetching
              if (filter.channelId && Array.isArray(filter.channelId)) {
                filterParts.push(...filter.channelId.map((id: string) => `#${id}`))
                slackIdsToFetch.push(...filter.channelId)
              }
              
              // Add time range
              if (filter.timeRange) {
                const { startDate, endDate } = filter.timeRange
                const start = new Date(startDate * 1000)
                const end = new Date(endDate * 1000)
                const formatDate = (date: Date) => {
                  const day = String(date.getDate()).padStart(2, '0')
                  const month = String(date.getMonth() + 1).padStart(2, '0')
                  const year = date.getFullYear()
                  return `${day}/${month}/${year}`
                }
                filterParts.push(`~${formatDate(start)} → ${formatDate(end)}`)
              }
              
              if (filterParts.length > 0) {
                slackFilterStrings.push(filterParts.join(', '))
              }
            }
            
            if (slackFilterStrings.length > 0) {
              loadedFilters.slack = slackFilterStrings
            }
          }
          
          setAppFilters(loadedFilters)
          
          // Fetch Slack names if we have IDs
          if (slackIdsToFetch.length > 0) {
            try {
              const response = await api.slack.documents.$get({
                query: { docids: slackIdsToFetch.join(',') }
              })
              
              if (response.ok) {
                const data = await response.json()
                if (data.success && data.documents) {
                  const mapping: Record<string, string> = {}
                  data.documents.forEach((doc: { docId: string; name: string }) => {
                    mapping[doc.docId] = doc.name
                  })
                  setSlackIdToNameMap(mapping)
                }
              }
            } catch (error) {
              console.error('Failed to fetch Slack document names:', error)
            }
          }
        }
      }
      
      loadFiltersWithNames()
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
          toast.success({
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
          toast.error({
            title: "Error",
            description: `Failed to delete agent: ${errorDetail}`,
          })
        }
      } catch (error) {
        toast.error({
          title: "Error",
          description: "An error occurred while deleting the agent.",
        })
        console.error("Delete agent error:", error)
      }
    })
    setShowConfirmModal(true)
  }

  const handleSaveAgent = async () => {
    // Helper function to parse timeline value into time range
    const parseTimelineValue = (timelineValue: string): { startDate: number; endDate: number } | null => {
      const now = Date.now()
      const dayInMs = 24 * 60 * 60 * 1000
      
      if (timelineValue === 'Last week') {
        return {
          startDate: Math.floor((now - 7 * dayInMs) / 1000),
          endDate: Math.floor(now / 1000)
        }
      } else if (timelineValue === 'Last month') {
        return {
          startDate: Math.floor((now - 30 * dayInMs) / 1000),
          endDate: Math.floor(now / 1000)
        }
      } else if (timelineValue === 'Last 7 days') {
        return {
          startDate: Math.floor((now - 7 * dayInMs) / 1000),
          endDate: Math.floor(now / 1000)
        }
      } else if (timelineValue === 'Last 14 days') {
        return {
          startDate: Math.floor((now - 14 * dayInMs) / 1000),
          endDate: Math.floor(now / 1000)
        }
      } else if (timelineValue.includes('→')) {
        // Custom date range format: "DD/MM/YYYY → DD/MM/YYYY"
        const [startStr, endStr] = timelineValue.split('→').map(s => s.trim())
        const parseDate = (dateStr: string) => {
          const [day, month, year] = dateStr.split('/').map(Number)
          return Math.floor(new Date(year, month - 1, day).getTime() / 1000)
        }
        return {
          startDate: parseDate(startStr),
          endDate: parseDate(endStr)
        }
      }
      
      return null
    }

    // Helper function to parse filter strings into structured filter objects
    const parseFilters = (filterStrings: string[], appId: string) => {
      const filters: any[] = []
      let filterId = 1
      
      for (const filterString of filterStrings) {
        if (!filterString || !filterString.trim()) continue
        
        const filterParts = filterString.split(', ').filter(p => p.trim())
        const filter: any = { id: filterId++ }
        
        // Parse Gmail people filters (from:, to:, cc:, bcc:)
        const fromEmails: string[] = []
        const toEmails: string[] = []
        const ccEmails: string[] = []
        const bccEmails: string[] = []
        
        // Parse Slack filters (people and channels) - store docIds
        const senderIds: string[] = []
        const channelIds: string[] = []
        
        // Single timeline filter (not an array anymore)
        let timeRange: { startDate: number; endDate: number } | null = null
        
        for (const part of filterParts) {
          if (part.startsWith('from:')) {
            fromEmails.push(part.substring(5))
          } else if (part.startsWith('to:')) {
            toEmails.push(part.substring(3))
          } else if (part.startsWith('cc:')) {
            ccEmails.push(part.substring(3))
          } else if (part.startsWith('bcc:')) {
            bccEmails.push(part.substring(4))
          } else if (part.startsWith('@')) {
            const personId = part.substring(1)
            senderIds.push(personId)
          } else if (part.startsWith('#')) {
            const channelId = part.substring(1)
            channelIds.push(channelId)
          } else if (part.startsWith('~')) {
            // Only parse the FIRST timeline filter found
            if (!timeRange) {
              const timelineValue = part.substring(1)
              timeRange = parseTimelineValue(timelineValue)
            }
            // Ignore any additional timeline filters in the same filter string
          }
        }
        
        // Add parsed fields to filter object
        if (fromEmails.length > 0) filter.from = fromEmails
        if (toEmails.length > 0) filter.to = toEmails
        if (ccEmails.length > 0) filter.cc = ccEmails
        if (bccEmails.length > 0) filter.bcc = bccEmails
        if (senderIds.length > 0) filter.senderId = senderIds
        if (channelIds.length > 0) filter.channelId = channelIds
        
        // Add single timeRange if found
        if (timeRange) {
          filter.timeRange = timeRange
        }
        
        // Add filter if it has at least one field (including timeRange-only filters)
        if (Object.keys(filter).length > 1) {
          filters.push(filter)
        }
      }
      
      return filters.length > 0 ? filters : undefined
    }
    
    // Build the new simplified appIntegrations structure
    const appIntegrationsObject: Record<
      string,
      {
        itemIds: string[]
        selectedAll: boolean
        filters?: any[]
      }
    > = {}

    // Collect collection item IDs
    const collectionItemIds: string[] = []
    let hasCollectionSelections = false

    // Collect data source IDs
    const dataSourceIds: string[] = []
    let hasDataSourceSelections = false

    // Process each selected integration
    for (const [integrationId, isSelected] of Object.entries(
      selectedIntegrations,
    )) {
      if (isSelected) {
        const integration = allAvailableIntegrations.find(
          (int) => int.id === integrationId,
        )
        if (!integration) continue

        // For collections, collect item IDs with appropriate prefixes
        if (integrationId.startsWith("cl_")) {
          const collectionId = integrationId.replace("cl_", "")
          const selectedItems =
            selectedItemsInCollection[collectionId] || new Set()
          const itemDetails =
            selectedItemDetailsInCollection[collectionId] || {}

          if (selectedItems.size === 0) {
            // If no specific items are selected, use the collection id with collection prefix
            const collectionId = integration.id.replace("cl_", "")
            collectionItemIds.push(`cl-${collectionId}`) // Collection prefix
          } else {
            // If specific items are selected, use their IDs with appropriate prefixes
            for (const itemId of selectedItems) {
              const itemDetail = itemDetails[itemId]
              if (itemDetail && itemDetail.type === "folder") {
                // This is a folder within the collection
                collectionItemIds.push(`clfd-${itemId}`) // Collection folder prefix
              } else {
                // For files or items without type info, use original ID
                collectionItemIds.push(`clf-${itemId}`)
              }
            }
          }
          hasCollectionSelections = true
        }
        // For data sources, collect their IDs
        else if (
          integrationId.startsWith("ds-") ||
          integration.app === Apps.DataSource
        ) {
          dataSourceIds.push(integrationId)
          hasDataSourceSelections = true
        }
        // Handle Google Drive integration
        else if (integrationId === "googledrive") {
          const selectedDocIds: string[] = []

          // Get the docIds from selectedItemDetailsInGoogleDrive
          for (const itemId of selectedItemsInGoogleDrive) {
            const itemDetail = selectedItemDetailsInGoogleDrive[itemId]

            if (itemDetail && itemDetail.fields?.docId) {
              selectedDocIds.push(itemDetail.fields.docId)
            } else if (itemDetail && itemDetail.docId) {
              selectedDocIds.push(itemDetail.docId)
            } else {
              console.warn(`No docId found for item ${itemId}:`, itemDetail)
            }
          }

          appIntegrationsObject[integrationId] = {
            itemIds: selectedDocIds,
            // selectedAll is true when no specific items are selected (whole Google Drive)
            // selectedAll is false when specific items are selected
            selectedAll: selectedItemsInGoogleDrive.size === 0,
          }
        }
        // For other integrations, use the integration ID as key
        else {
          const integrationConfig: {
            itemIds: string[]
            selectedAll: boolean
            filters?: any[]
          } = {
            itemIds: [],
            selectedAll: true,
          }
          
          // Add filters if they exist for this integration (Gmail or Slack)
          if (appFilters[integrationId] && appFilters[integrationId].length > 0) {
            const parsedFilters = parseFilters(appFilters[integrationId], integrationId)
            if (parsedFilters) {
              integrationConfig.filters = parsedFilters
            }
          }
          
          appIntegrationsObject[integrationId] = integrationConfig
        }
      }
    }

    // Add collection selections if any exist
    if (hasCollectionSelections) {
      appIntegrationsObject["knowledge_base"] = {
        itemIds: collectionItemIds,
        selectedAll: collectionItemIds.length === 0,
      }
    }

    // Add data source selections if any exist
    if (hasDataSourceSelections) {
      appIntegrationsObject["DataSource"] = {
        itemIds: dataSourceIds,
        selectedAll: dataSourceIds.length === 0,
      }
    }

    const agentPayload = {
      name: agentName,
      description: agentDescription,
      prompt: agentPrompt,
      model: selectedModel,
      isPublic: isPublic,
      isRagOn: isRagOn,
      appIntegrations: appIntegrationsObject,
      // Only include userEmails for private agents
      userEmails: isPublic ? [] : selectedUsers.map((user) => user.email),
    }


    console.log("Agent payload to be sent:", agentPayload)
    

    try {
      let response
      if (editingAgent && editingAgent.externalId) {
        response = await api.agent[":agentExternalId"].$put({
          param: { agentExternalId: editingAgent.externalId },
          json: agentPayload,
        })
        if (response.ok) {
          toast.success({
            title: "Success",
            description: "Agent updated successfully.",
          })
          setViewMode("list")
          resetForm()
        } else {
          const errorData = await response.json()
          toast.error({
            title: "Error",
            description: `Failed to update agent: ${errorData.message || response.statusText}`,
          })
        }
      } else {
        response = await api.agent.create.$post({ json: agentPayload })
        if (response.ok) {
          toast.success({
            title: "Success",
            description: "Agent created successfully.",
          })
          setViewMode("list")
          resetForm()
        } else {
          const errorData = await response.json()
          toast.error({
            title: "Error",
            description: `Failed to create agent: ${errorData.message || response.statusText}`,
          })
        }
      }
    } catch (error) {
      const action = editingAgent ? "updating" : "creating"
      toast.error({
        title: "Error",
        description: `An error occurred while ${action} the agent.`,
      })
      console.error(`${action} agent error:`, error)
    }
  }

  const toggleIntegrationSelection = (integrationId: string) => {
    setSelectedIntegrations((prev) => {
      const newValue = !prev[integrationId]
      if (integrationId === "googledrive" && !newValue) {
        setSelectedItemsInGoogleDrive(new Set())
        setSelectedItemDetailsInGoogleDrive({})
      }
      // If it's a collection integration and we're deselecting it, clear its items
      if (integrationId.startsWith("cl_") && !newValue) {
        const clId = integrationId.replace("cl_", "")
        setSelectedItemsInCollection((prevItems) => {
          const newState = { ...prevItems }
          delete newState[clId]
          return newState
        })
        setSelectedItemDetailsInCollection((prevDetails) => {
          const newState = { ...prevDetails }
          delete newState[clId]
          return newState
        })
      }

      return {
        ...prev,
        [integrationId]: newValue,
      }
    })
  }

  const handleRemoveSelectedIntegration = (integrationId: string) => {
    // Check if it's a CL item (format: clId_itemId where itemId can contain underscores)
    // We need to find the actual CL ID from the selected integrations
    let isClItem = false
    let clId = ""
    let itemId = ""

    // Check if this is a CL item by looking for a pattern where the ID starts with a CL ID
    for (const [integId] of Object.entries(selectedIntegrations)) {
      if (integId.startsWith("cl_") && selectedIntegrations[integId]) {
        const currentClId = integId.replace("cl_", "")
        if (integrationId.startsWith(currentClId + "_")) {
          isClItem = true
          clId = currentClId
          itemId = integrationId.substring(currentClId.length + 1) // Remove clId and the underscore
          break
        }
      }
    }

    if (isClItem && clId && itemId) {
      // Remove the specific item from the CL
      setSelectedItemsInCollection((prev) => {
        const newState = { ...prev }
        if (newState[clId]) {
          const newSet = new Set(newState[clId])
          newSet.delete(itemId)

          if (newSet.size === 0) {
            delete newState[clId]
            // Also deselect the CL integration if no items are selected
            setSelectedIntegrations((prevInt) => ({
              ...prevInt,
              [`cl_${clId}`]: false,
            }))
          } else {
            newState[clId] = newSet
          }
        }
        return newState
      })

      // Remove item details
      setSelectedItemDetailsInCollection((prev) => {
        const newState = { ...prev }
        if (newState[clId] && newState[clId][itemId]) {
          delete newState[clId][itemId]
          if (Object.keys(newState[clId]).length === 0) {
            delete newState[clId]
          }
        }
        return newState
      })
    } else if (integrationId.startsWith("googledrive_")) {
      // Handle Google Drive item removal
      const driveItemId = integrationId.replace("googledrive_", "")

      // Remove the specific Google Drive item
      setSelectedItemsInGoogleDrive((prev) => {
        const newSet = new Set(prev)
        newSet.delete(driveItemId)

        // If no items are selected, also deselect the Google Drive integration
        if (newSet.size === 0) {
          setSelectedIntegrations((prevInt) => ({
            ...prevInt,
            googledrive: false,
          }))
        }

        return newSet
      })

      // Remove item details
      setSelectedItemDetailsInGoogleDrive((prev) => {
        const newState = { ...prev }
        delete newState[driveItemId]
        return newState
      })
    } else {
      // Handle regular integrations
      setSelectedIntegrations((prev) => ({
        ...prev,
        [integrationId]: false,
      }))

      // If it's a collection integration, also clear its selections
      if (integrationId.startsWith("cl_")) {
        const clId = integrationId.replace("cl_", "")
        setSelectedItemsInCollection((prev) => {
          const newState = { ...prev }
          delete newState[clId]
          return newState
        })
        setSelectedItemDetailsInCollection((prev) => {
          const newState = { ...prev }
          delete newState[clId]
          return newState
        })
      }

      // If it's Google Drive integration, also clear its selections
      if (integrationId === "googledrive") {
        setSelectedItemsInGoogleDrive(new Set())
        setSelectedItemDetailsInGoogleDrive({})
      }
    }
  }

  const handleClearAllIntegrations = () => {
    const clearedSelection: Record<string, boolean> = {}
    allAvailableIntegrations.forEach(
      (int) => (clearedSelection[int.id] = false),
    )
    setSelectedIntegrations(clearedSelection)

    // Also clear selected items and their details for all Collections
    setSelectedItemsInCollection({})
    setSelectedItemDetailsInCollection({})
    // Also clear Google Drive selections
    setSelectedItemsInGoogleDrive(new Set())
    setSelectedItemDetailsInGoogleDrive({})
  }

  const currentSelectedIntegrationObjects = useMemo(() => {
    const result: Array<{
      id: string
      name: string
      icon: React.ReactNode
      type?: "file" | "folder" | "integration" | "cl" | "grouped-parent"
      clId?: string
      clName?: string
      children?: Array<{
        id: string
        name: string
        icon: React.ReactNode
        type?: "file" | "folder"
      }>
    }> = []

    // Add regular integrations (excluding Google Drive and Collections which are handled separately)
    for (const integration of allAvailableIntegrations) {
      if (
        selectedIntegrations[integration.id] &&
        !integration.id.startsWith("cl_") &&
        integration.id !== "googledrive"
      ) {
        result.push({
          ...integration,
          type: "integration",
        })
      }
    }

    // Handle Google Drive items - grouped display
    if (selectedIntegrations["googledrive"]) {
      const googleDriveIntegration = allAvailableIntegrations.find(
        (int) => int.id === "googledrive",
      )
      
      if (googleDriveIntegration) {
        if (selectedItemsInGoogleDrive.size === 0) {
          // No specific items selected, show just Google Drive
          result.push({
            ...googleDriveIntegration,
            type: "integration",
          })
        } else {
          // Specific items selected, show grouped display
          const children: Array<{
            id: string
            name: string
            icon: React.ReactNode
            type?: "file" | "folder"
          }> = []

          for (const itemId of selectedItemsInGoogleDrive) {
            const item = selectedItemDetailsInGoogleDrive[itemId]
            if (item) {
              const itemTitle =
                item.fields?.title ||
                item.fields?.name ||
                item.title ||
                item.name ||
                "Untitled"
              const itemEntity = item.fields?.entity || item.entity
              const isFolder = itemEntity === DriveEntity.Folder

              children.push({
                id: `googledrive_${itemId}`,
                name: itemTitle,
                icon: getDriveEntityIcon(itemEntity),
                type: isFolder ? "folder" : "file",
              })
            }
          }

          result.push({
            ...googleDriveIntegration,
            type: "grouped-parent",
            children,
          })
        }
      }
    }

    // Handle Collections - grouped display
    allAvailableIntegrations.forEach((integration) => {
      if (
        integration.id.startsWith("cl_") &&
        selectedIntegrations[integration.id]
      ) {
        const clId = integration.id.replace("cl_", "")
        const selectedItems = selectedItemsInCollection[clId] || new Set()

        if (selectedItems.size === 0) {
          // No specific items selected, show just the collection
          result.push({
            ...integration,
            type: "cl",
          })
        } else {
          // Specific items selected, show grouped display
          const itemDetails = selectedItemDetailsInCollection[clId] || {}
          const children: Array<{
            id: string
            name: string
            icon: React.ReactNode
            type?: "file" | "folder"
          }> = []

          selectedItems.forEach((itemId) => {
            const item = itemDetails[itemId]
            if (item) {
              const displayName =
                integrationIdToNameMap[itemId]?.name || item.name
              const itemType = integrationIdToNameMap[itemId]?.type || item.type
              const itemIcon = getItemIcon(itemType)
              
              children.push({
                id: `${clId}_${itemId}`,
                name: displayName,
                icon: itemIcon,
                type: item.type,
              })
            }
          })

          result.push({
            ...integration,
            type: "grouped-parent",
            children,
          })
        }
      }
    })

    return result
  }, [
    selectedIntegrations,
    allAvailableIntegrations,
    selectedItemsInCollection,
    selectedItemDetailsInCollection,
    integrationIdToNameMap,
    selectedItemsInGoogleDrive,
    selectedItemDetailsInGoogleDrive,
  ])

  useEffect(() => {
    if (!isRagOn) {
      setSelectedIntegrations((prev) => {
        const newSelections = { ...prev }
        availableIntegrationsList.forEach((int) => {
          newSelections[int.id] = false
        })
        return newSelections
      })
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

    let agentPromptPayload: AgentPromptPayload

    if (selectedChatAgentExternalId === null) {
      // Test Current Form Config - construct complete agent configuration

      const appIntegrationsObject: Record<
        string,
        {
          itemIds: string[]
          selectedAll: boolean
        }
      > = {}

      // Collect collection item IDs
      const collectionItemIds: string[] = []
      let hasCollectionSelections = false

      // Collect data source IDs
      const dataSourceIds: string[] = []
      let hasDataSourceSelections = false

      // Collect Google Drive docIds
      const googleDriveDocIds: string[] = []
      let hasGoogleDriveSelections = false

      // Process each selected integration
      for (const [integrationId, isSelected] of Object.entries(
        selectedIntegrations,
      )) {
        if (isSelected) {
          const integration = allAvailableIntegrations.find(
            (int) => int.id === integrationId,
          )
          if (!integration) continue

          // For collections, collect item IDs with appropriate prefixes
          if (integrationId.startsWith("cl_")) {
            const collectionId = integrationId.replace("cl_", "")
            const selectedItems =
              selectedItemsInCollection[collectionId] || new Set()
            const itemDetails =
              selectedItemDetailsInCollection[collectionId] || {}

            if (selectedItems.size === 0) {
              // If no specific items are selected, use the collection id with collection prefix
              const collectionId = integration.id.replace("cl_", "")
              collectionItemIds.push(`cl-${collectionId}`) // Collection prefix
            } else {
              // If specific items are selected, use their IDs with appropriate prefixes
              for (const itemId of selectedItems) {
                const itemDetail = itemDetails[itemId]
                if (itemDetail && itemDetail.type === "folder") {
                  // This is a folder within the collection
                  collectionItemIds.push(`clfd-${itemId}`) // Collection folder prefix
                } else {
                  // For files or items without type info, use original ID
                  collectionItemIds.push(`clf-${itemId}`)
                }
              }
            }
            hasCollectionSelections = true
          }
          // For data sources, collect their IDs
          else if (
            integrationId.startsWith("ds-") ||
            integration.app === Apps.DataSource
          ) {
            dataSourceIds.push(integrationId)
            hasDataSourceSelections = true
          }
          // For Google Drive, collect selected docIds
          else if (integrationId === "googledrive") {
            for (const itemId of selectedItemsInGoogleDrive) {
              const itemDetail = selectedItemDetailsInGoogleDrive[itemId]
              if (itemDetail && itemDetail.fields?.docId) {
                googleDriveDocIds.push(itemDetail.fields.docId)
              } else if (itemDetail && itemDetail.docId) {
                googleDriveDocIds.push(itemDetail.docId)
              }
            }
            hasGoogleDriveSelections = true
          }
          // For other integrations, use the integration ID as key
          else {
            appIntegrationsObject[integrationId] = {
              itemIds: [],
              selectedAll: true,
            }
          }
        }
      }

      // Add collection selections if any exist
      if (hasCollectionSelections) {
        appIntegrationsObject["knowledge_base"] = {
          itemIds: collectionItemIds,
          selectedAll: collectionItemIds.length === 0,
        }
      }

      // Add data source selections if any exist
      if (hasDataSourceSelections) {
        appIntegrationsObject["DataSource"] = {
          itemIds: dataSourceIds,
          selectedAll: dataSourceIds.length === 0,
        }
      }

      // Add Google Drive selections if any exist
      if (selectedIntegrations["googledrive"] || hasGoogleDriveSelections) {
        appIntegrationsObject["googledrive"] = {
          itemIds: googleDriveDocIds,
          selectedAll: googleDriveDocIds.length === 0,
        }
      }

      // Construct complete agent payload for current form config
      agentPromptPayload = {
        name: agentName,
        description: agentDescription,
        prompt: agentPrompt,
        model: selectedModel,
        isPublic: isPublic,
        isRagOn: isRagOn,
        appIntegrations: appIntegrationsObject,
        userEmails: isPublic ? [] : selectedUsers.map((user) => user.email),
        allowWebSearch: false, // Not supported in form config
      }
    }
    url.searchParams.append("message", encodeURIComponent(messageToSend))

    // Add agent ID to the request if using an agent
    if (chatConfigAgent?.externalId) {
      url.searchParams.append("agentId", chatConfigAgent.externalId)
    } else {
      // If no agent is used (the user is not authenticated), we can use the default agent
      url.searchParams.append(
        "agentPromptPayload",
        JSON.stringify(agentPromptPayload),
      )
      url.searchParams.append("agentId", DEFAULT_TEST_AGENT_ID)
    }

    // Get model configuration from ChatBox
    const modelConfig = chatBoxRef.current?.getCurrentModelConfig()

    url.searchParams.append("selectedModelConfig", JSON.stringify(modelConfig))

    if (metadata && metadata.length > 0) {
      url.searchParams.append("attachmentMetadata", JSON.stringify(metadata))
    }

    try {
      eventSourceRef.current = await createAuthEventSource(url.toString())
    } catch (err) {
      console.error("Failed to create EventSource:", err)
      toast({
        title: "Error",
        description: "Something went wrong. Please try again.",
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

    eventSourceRef.current.addEventListener(ChatSSEvents.Start, () => { })

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
                    <h1 className="text-[32px] tracking-wider font-display text-gray-700 dark:text-gray-100">
                      AGENTS
                    </h1>
                    <div className="flex items-center gap-4 ">
                      {(() => {
                        // Calculate whether current tab has agents
                        const agentLists: Record<string, SelectPublicAgent[]> = {
                          "all": allAgentsList,
                          "made-by-me": madeByMeAgentsList,
                          "shared-to-me": sharedToMeAgentsList,
                        }
                        const currentTabHasAgents = (agentLists[activeTab]?.length ?? 0) > 0

                        return currentTabHasAgents && (
                          <>
                            <div className="relative">
                              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-5 w-5" />
                              <input
                                type="text"
                                placeholder="Search agents.."
                                value={listSearchQuery}
                                onChange={handleListSearchChange}
                                className="pl-10 pr-4 py-2 rounded-full border border-gray-200 dark:border-slate-600 w-[300px] focus:outline-none focus:ring-2 focus:ring-gray-300 dark:focus:ring-slate-500 bg-white dark:bg-slate-700 dark:text-gray-100"
                              />
                            </div>
                            <Button
                              onClick={handleCreateNewAgent}
                              className="bg-slate-800 hover:bg-slate-700 text-white font-mono font-medium rounded-full px-6 py-2 flex items-center gap-2"
                            >
                              <Plus size={18} /> CREATE
                            </Button>
                          </>
                        )
                      })()}
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
                      const isSharedTab = activeTab === "shared-to-me"
                      const title = isSharedTab
                        ? "No agents shared with you yet"
                        : "No agents created yet"
                      const description = isSharedTab
                        ? null
                        : "Click 'Create Agent' to add your first agent"

                      return (
                        <div className="flex flex-col items-center justify-center min-h-[60vh]">
                          <img
                            src={agentEmptyStateIcon}
                            alt="No agents"
                            className="w-32 h-32 mb-6 opacity-60"
                          />
                          <p className="text-xl font-medium text-gray-700 dark:text-gray-300 mb-2">
                            {title}
                          </p>
                          {description && (
                            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                              {description}
                            </p>
                          )}
                          {!isSharedTab && (
                            <Button
                              onClick={handleCreateNewAgent}
                              className="bg-slate-800 hover:bg-slate-700 text-white font-mono font-medium rounded-full px-6 py-2 flex items-center gap-2"
                            >
                              <Plus size={18} /> CREATE AGENT
                            </Button>
                          )}
                        </div>
                      )
                    }

                    return (
                      <>
                        <div className="space-y-0">
                          {paginatedList.map((agent) => {
                            const isShared =
                              (activeTab === "all" ||
                                activeTab === "shared-to-me") &&
                              sharedToMeAgentsList.some(
                                (sharedAgent) =>
                                  sharedAgent.externalId === agent.externalId,
                              )

                            return (
                              <AgentListItem
                                key={agent.externalId}
                                agent={agent}
                                isFavorite={favoriteAgents.includes(
                                  agent.externalId,
                                )}
                                isAgentPublic={agent.isPublic}
                                isShared={isShared}
                                isMadeByMe={madeByMeAgentsList.some(
                                  (madeByMeAgent) =>
                                    madeByMeAgent.externalId ===
                                    agent.externalId,
                                )}
                                onToggleFavorite={toggleFavorite}
                                onEdit={() => handleEditAgent(agent)}
                                onView={() => handleViewAgent(agent)}
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
                            )
                          })}
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
          ) : viewMode === "viewAgent" && viewingAgent ? (
            <ViewAgent
              agent={viewingAgent}
              onBack={() => setViewMode("list")}
            />
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
                              className={`h-4 w-4 ${isGeneratingPrompt
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
                    className={`mt-1 bg-white dark:bg-slate-700 border rounded-lg w-full h-36 p-3 text-base dark:text-gray-100 transition-all duration-300 ${shouldHighlightPrompt
                      ? "border-blue-400 ring-2 ring-blue-200 dark:border-blue-500 dark:ring-blue-900/50 shadow-lg"
                      : "border-gray-300 dark:border-slate-600"
                      }`}
                    disabled={isGeneratingPrompt}
                  />
                </div>

                <div className="w-full">
                  <Label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-3">
                    Visibility
                  </Label>
                  <div className="inline-flex rounded-xl bg-gray-100 dark:bg-slate-700 p-1">
                    <button
                      type="button"
                      onClick={() => setIsPublic(false)}
                      className={`px-6 py-2 text-sm font-medium rounded-xl transition-colors ${
                        !isPublic
                          ? "bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 shadow-sm"
                          : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
                      }`}
                    >
                      Private
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsPublic(true)}
                      className={`px-6 py-2 text-sm font-medium rounded-xl transition-colors ${
                        isPublic
                          ? "bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 shadow-sm"
                          : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
                      }`}
                    >
                      Public
                    </button>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <Label className="text-base font-medium text-gray-800 dark:text-gray-300">
                        App Integrations
                      </Label>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        Select knowledge sources for your agent.
                      </p>
                    </div>
                    {/* <div className="flex items-center gap-3">
                        <Label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                          RAG
                        </Label>
                        <Switch
                          checked={isRagOn}
                          onCheckedChange={setIsRagOn}
                          id="rag-toggle"
                        />
                      </div> */}
                  </div>
                  {currentSelectedIntegrationObjects.length > 0 && (
                    <div className="flex flex-col gap-2 mt-3">
                      {currentSelectedIntegrationObjects.map((integration) => {
                        // Check if this is a grouped parent (Collections or Google Drive with children)
                        if (integration.type === "grouped-parent" && integration.children && integration.children.length > 0) {
                          return (
                            <div key={integration.id} className="flex flex-col gap-2">
                              {/* Parent header - fixed width section */}
                              <div className="flex items-center gap-3 w-full">
                                <div className="flex items-center gap-3 text-slate-700 dark:text-slate-200 text-base font-normal w-[200px] flex-shrink-0">
                                  {integration.icon && <span className="flex items-center flex-shrink-0">{integration.icon}</span>}
                                  <span className="truncate flex-1">{integration.name}</span>
                                  <Trash2
                                    className="h-4 w-4 cursor-pointer text-gray-400 hover:text-red-500 dark:hover:text-red-400 flex-shrink-0"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleRemoveSelectedIntegration(integration.id)
                                    }}
                                  />
                                </div>
                              </div>
                              {/* Children items - aligned with parent, one per row */}
                              <div className="flex flex-col gap-2 ml-[216px]">
                                {integration.children.map((child) => (
                                  <div key={child.id} className="flex items-center gap-2">
                                    {child.icon && <span className="flex items-center flex-shrink-0">{child.icon}</span>}
                                    <span className="text-sm text-gray-700 dark:text-gray-200 truncate">{child.name}</span>
                                    <Trash2
                                      className="h-3 w-3 cursor-pointer text-gray-400 hover:text-red-500 dark:hover:text-red-400 flex-shrink-0"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        handleRemoveSelectedIntegration(child.id)
                                      }}
                                    />
                                  </div>
                                ))}
                              </div>
                            </div>
                          )
                        }
                        
                        // Regular badge for non-grouped items
                        const filters = appFilters[integration.id] || ['']
                        const showFilterInput = integration.id === 'gmail' || integration.id === 'slack'
                        
                        return (
                          <div key={integration.id} className="flex flex-col gap-2 w-full">
                            {filters.map((filter, index) => (
                              <CustomBadge
                                key={`${integration.id}-${index}`}
                                text={index === 0 ? integration.name : ''}
                                icon={index === 0 ? integration.icon : undefined}
                                appId={integration.id}
                                filterValue={filter}
                                filterIndex={index}
                                slackIdToNameMap={slackIdToNameMap}
                                onUpdateSlackNameMapping={(id, name) => {
                                  setSlackIdToNameMap(prev => ({
                                    ...prev,
                                    [id]: name
                                  }))
                                }}
                                onFilterChange={(value) => {
                                  setAppFilters(prev => {
                                    const newFilters = [...(prev[integration.id] || [''])]
                                    newFilters[index] = value
                                    return {
                                      ...prev,
                                      [integration.id]: newFilters
                                    }
                                  })
                                }}
                                onRemove={() => {
                                  if (index === 0 && filters.length === 1) {
                                    // Remove the entire integration
                                    handleRemoveSelectedIntegration(integration.id)
                                  } else {
                                    // Remove just this filter
                                    setAppFilters(prev => {
                                      const newFilters = [...(prev[integration.id] || [''])]
                                      newFilters.splice(index, 1)
                                      return {
                                        ...prev,
                                        [integration.id]: newFilters.length > 0 ? newFilters : ['']
                                      }
                                    })
                                  }
                                }}
                              />
                            ))}
                            {/* Add Filter button - shown once per app after all filters */}
                            {showFilterInput && (
                              <div className="ml-[216px]">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setAppFilters(prev => ({
                                      ...prev,
                                      [integration.id]: [...(prev[integration.id] || ['']), '']
                                    }))
                                  }}
                                  className="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
                                >
                                  <Plus size={14} />
                                  <span>Add Filter</span>
                                </button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <DropdownMenu
                    open={isIntegrationMenuOpen}
                    onOpenChange={(open) => {
                      setIsIntegrationMenuOpen(open)
                      if (!open) {
                        setNavigationPath([])
                        setCurrentItems([])
                        setDropdownSearchQuery("") // Clear search when closing dropdown
                      }
                    }}
                  >
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        className="w-fit px-4 py-2 h-auto text-sm font-medium text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 rounded-3xl hover:bg-gray-50 dark:hover:bg-slate-700 mt-3"
                      >
                        <Plus size={16} className="mr-2" />
                        Add App
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                        className="w-[440px] p-0 bg-gray-100 dark:bg-gray-800 rounded-xl"
                        align="start"
                      >
                        <div className="flex items-center justify-between px-4 py-2">
                          <div className="flex items-center justify-between w-full">
                            <div className="flex items-center overflow-hidden max-w-[75%]">
                              {navigationPath.length > 0 && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    if (navigationPath.length === 1) {
                                      // Go back to main menu from CL listing or Google Drive root
                                      setNavigationPath([])
                                      setCurrentItems([])
                                      setDropdownSearchQuery("")
                                    } else {
                                      // Navigate back one level
                                      const newPath = navigationPath.slice(
                                        0,
                                        -1,
                                      )
                                      setNavigationPath(newPath)

                                      if (
                                        newPath.length === 1 &&
                                        newPath[0].type === "cl-root"
                                      ) {
                                        // Back to CL listing
                                        setCurrentItems([])
                                      } else if (
                                        newPath.length === 1 &&
                                        newPath[0].type === "drive-root"
                                      ) {
                                        // Back to Google Drive root
                                        setIsLoadingItems(true)
                                        api.search.driveitem
                                          .$post({
                                            json: { parentId: "" },
                                          })
                                          .then((response: Response) => {
                                            if (response.ok) {
                                              response
                                                .json()
                                                .then((data: any) => {
                                                  // Extract the actual items from the Vespa response structure
                                                  const items =
                                                    data?.root?.children || []
                                                  setCurrentItems(items)
                                                  setIsLoadingItems(false)
                                                })
                                            }
                                          })
                                          .catch(() => setIsLoadingItems(false))
                                      } else if (newPath.length > 1) {
                                        // Navigate to parent folder
                                        const clId = newPath.find(
                                          (item) => item.type === "cl",
                                        )?.id

                                        if (clId) {
                                          // Collections navigation
                                          const parentId =
                                            newPath[newPath.length - 1]?.id ===
                                              clId
                                              ? null
                                              : newPath[newPath.length - 1]?.id

                                          setIsLoadingItems(true)
                                          api.cl[":clId"].items
                                            .$get({
                                              param: { clId: clId },
                                              query: parentId
                                                ? { parentId }
                                                : {},
                                            })
                                            .then((response: Response) => {
                                              if (response.ok) {
                                                response
                                                  .json()
                                                  .then((data: any[]) => {
                                                    setCurrentItems(data)
                                                    setIsLoadingItems(false)
                                                  })
                                              }
                                            })
                                            .catch(() =>
                                              setIsLoadingItems(false),
                                            )
                                        } else if (
                                          newPath.some(
                                            (item) =>
                                              item.type === "drive-root" ||
                                              item.type === "drive-folder",
                                          )
                                        ) {
                                          // Google Drive navigation
                                          const parentFolderId =
                                            newPath[newPath.length - 1]?.id ===
                                              "drive-root"
                                              ? ""
                                              : newPath[newPath.length - 1]?.id

                                          setIsLoadingItems(true)
                                          api.search.driveitem
                                            .$post({
                                              json: {
                                                parentId: parentFolderId,
                                              },
                                            })
                                            .then((response: Response) => {
                                              if (response.ok) {
                                                response
                                                  .json()
                                                  .then((data: any) => {
                                                    // Extract the actual items from the Vespa response structure
                                                    const items =
                                                      data?.root?.children || []

                                                    setCurrentItems(items)
                                                    setIsLoadingItems(false)
                                                  })
                                              }
                                            })
                                            .catch(() =>
                                              setIsLoadingItems(false),
                                            )
                                        }
                                      }
                                    }
                                  }}
                                  className="p-0 h-auto w-auto text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 mr-2 flex-shrink-0"
                                >
                                  <ChevronLeft size={12} />
                                </Button>
                              )}
                              {navigationPath.length > 0 ? (
                                <div className="flex items-center text-xs text-gray-600 dark:text-gray-300 whitespace-nowrap overflow-hidden">
                                  <span
                                    className="cursor-pointer hover:text-gray-800 dark:hover:text-gray-100 text-xs whitespace-nowrap flex-shrink-0"
                                    onClick={() => {
                                      setNavigationPath([])
                                      setCurrentItems([])
                                      setDropdownSearchQuery("")
                                    }}
                                  >
                                    ADD SOURCE
                                  </span>
                                  {(() => {
                                    // Show up to 3 items in the breadcrumb
                                    if (navigationPath.length > 0) {
                                      // Get the last 3 items or all if less than 3
                                      const itemsToShow =
                                        navigationPath.length <= 3
                                          ? navigationPath
                                          : navigationPath.slice(
                                            navigationPath.length - 3,
                                          )

                                      return itemsToShow.map((item, index) => (
                                        <React.Fragment
                                          key={`${item.id}-${index}`}
                                        >
                                          <span className="mx-2 flex-shrink-0">
                                            /
                                          </span>
                                          <span
                                            className={`max-w-[60px] truncate ${index < itemsToShow.length - 1 ? "cursor-pointer hover:text-gray-800 dark:hover:text-gray-100" : "font-medium"}`}
                                            title={item.name}
                                            onClick={() => {
                                              if (
                                                index <
                                                itemsToShow.length - 1
                                              ) {
                                                // Navigate to this item
                                                const newPathIndex =
                                                  navigationPath.findIndex(
                                                    (p) => p.id === item.id,
                                                  )

                                                if (newPathIndex >= 0) {
                                                  const newPath =
                                                    navigationPath.slice(
                                                      0,
                                                      newPathIndex + 1,
                                                    )
                                                  setNavigationPath(newPath)

                                                  if (
                                                    newPath.length === 1 &&
                                                    newPath[0].type ===
                                                    "cl-root"
                                                  ) {
                                                    setCurrentItems([])
                                                  } else if (
                                                    newPath.length > 1 &&
                                                    newPath[0].type ===
                                                    "cl-root"
                                                  ) {
                                                    const clId = newPath.find(
                                                      (item) =>
                                                        item.type === "cl",
                                                    )?.id
                                                    const parentId =
                                                      newPath[
                                                        newPath.length - 1
                                                      ]?.id === clId
                                                        ? null
                                                        : newPath[
                                                          newPath.length - 1
                                                        ]?.id

                                                    if (clId) {
                                                      setIsLoadingItems(true)
                                                      api.cl[":clId"].items
                                                        .$get({
                                                          param: { clId: clId },
                                                          query: parentId
                                                            ? { parentId }
                                                            : {},
                                                        })
                                                        .then(
                                                          (
                                                            response: Response,
                                                          ) => {
                                                            if (response.ok) {
                                                              response
                                                                .json()
                                                                .then(
                                                                  (
                                                                    data: any[],
                                                                  ) => {
                                                                    setCurrentItems(
                                                                      data,
                                                                    )
                                                                    setIsLoadingItems(
                                                                      false,
                                                                    )
                                                                  },
                                                                )
                                                            }
                                                          },
                                                        )
                                                        .catch(() =>
                                                          setIsLoadingItems(
                                                            false,
                                                          ),
                                                        )
                                                    }
                                                  } else if (
                                                    newPath.length === 1 &&
                                                    newPath[0].type ===
                                                    "drive-root"
                                                  ) {
                                                    navigateToGoogleDrive()
                                                  } else if (
                                                    newPath.length > 1 &&
                                                    newPath[0].type ===
                                                    "drive-root"
                                                  ) {
                                                    if (
                                                      newPath[
                                                        newPath.length - 1
                                                      ].type === "drive-folder"
                                                    ) {
                                                      const FolderId =
                                                        newPath[
                                                          newPath.length - 1
                                                        ].id
                                                      const FolderName =
                                                        newPath[
                                                          newPath.length - 1
                                                        ].name
                                                      navigateToDriveFolder(
                                                        FolderId,
                                                        FolderName,
                                                      )
                                                    }
                                                  }
                                                }
                                              }
                                            }}
                                          >
                                            {item.name}
                                          </span>
                                        </React.Fragment>
                                      ))
                                    }
                                    return null
                                  })()}
                                </div>
                              ) : (
                                <span className="p-0 text-xs text-gray-600 dark:text-gray-300">
                                  ADD SOURCE
                                </span>
                              )}
                            </div>
                          </div>
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
                        <div className="bg-white dark:bg-gray-900 max-h-72 min-h-72 overflow-y-auto rounded-lg mx-1 mb-1">
                          {navigationPath.length === 0
                            ? // Main menu
                            (() => {
                              const collections =
                                allAvailableIntegrations.filter(
                                  (integration) =>
                                    integration.id.startsWith("cl_"),
                                )
                              const otherIntegrations =
                                allAvailableIntegrations.filter(
                                  (integration) =>
                                    !integration.id.startsWith("cl_"),
                                )

                                return (
                                  <>
                                    {collections.length > 0 && (
                                      <DropdownMenuItem
                                        onSelect={(e) => {
                                          e.preventDefault()
                                          setNavigationPath([
                                            {
                                              id: "cl-root",
                                              name: "Collections",
                                              type: "cl-root",
                                            },
                                          ])
                                          setDropdownSearchQuery("")
                                        }}
                                        className="flex items-center justify-between cursor-pointer text-sm py-2.5 px-4 hover:!bg-transparent focus:!bg-transparent data-[highlighted]:!bg-transparent"
                                      >
                                        <div className="flex items-center">
                                          <div className="w-4 h-4 mr-3"> </div>
                                          <span className="mr-2 flex items-center">
                                            <BookOpen className="w-4 h-4 mr-2 text-blue-600" />
                                          </span>
                                          <span className="text-gray-700 dark:text-gray-200">
                                            Collections
                                          </span>
                                        </div>
                                        <ChevronRight className="h-4 w-4 text-gray-400" />
                                      </DropdownMenuItem>
                                    )}

                                    {otherIntegrations.map((integration) => {
                                      const isGoogleDrive =
                                        integration.app === Apps.GoogleDrive &&
                                        integration.entity === "file"
                                      const showChevron = isGoogleDrive

                                      return (
                                        <DropdownMenuItem
                                          key={integration.id}
                                          onSelect={(e) => {
                                            e.preventDefault()
                                            toggleIntegrationSelection(
                                              integration.id,
                                            )
                                          }}
                                          className="flex items-center justify-between cursor-pointer text-sm py-2.5 px-4 hover:!bg-transparent focus:!bg-transparent data-[highlighted]:!bg-transparent"
                                        >
                                          <div className="flex items-center">
                                            <input
                                              type="checkbox"
                                              checked={
                                                selectedIntegrations[
                                                  integration.id
                                                ] || false
                                              }
                                              onChange={() => {}}
                                              className="w-4 h-4 mr-3"
                                            />
                                            <span className="mr-2 flex items-center">
                                              {integration.icon}
                                            </span>
                                            <span className="text-gray-700 dark:text-gray-200">
                                              {integration.name}
                                            </span>
                                          </div>
                                          {showChevron && (
                                            <Button
                                              variant="ghost"
                                              size="sm"
                                              onClick={(e) => {
                                                e.stopPropagation()
                                                e.preventDefault()
                                                navigateToGoogleDrive()
                                              }}
                                              className="p-0 h-auto w-auto hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
                                            >
                                              <ChevronRight className="h-4 w-4 text-gray-400" />
                                            </Button>
                                          )}
                                        </DropdownMenuItem>
                                      )
                                    })}
                                  </>
                                )
                              })()
                            : // Unified Collections section - handles both CL listing and file/folder navigation
                            (() => {
                              // const knowledgeBases = allAvailableIntegrations.filter(integration =>
                              //   integration.id.startsWith('cl_')
                              // )

                              // Determine if we're showing Collection list or Collection contents
                              const isShowingKbList =
                                navigationPath.length === 1 &&
                                navigationPath[0].type === "cl-root"
                              const isShowingKbContents =
                                navigationPath.length > 1 ||
                                (navigationPath.length === 1 &&
                                  navigationPath[0].type === "cl")
                              const isShowingDriveContents =
                                navigationPath.length > 0 &&
                                (navigationPath[0].type === "drive-root" ||
                                  navigationPath.some(
                                    (item) => item.type === "drive-folder",
                                  ))

                              return (
                                <>
                                  {/* Single unified search input */}
                                  {(isShowingKbList ||
                                    isShowingKbContents ||
                                    isShowingDriveContents) && (
                                      <div className="border-b border-gray-200 dark:border-gray-700">
                                        <div className="relative">
                                          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                                          <input
                                            type="text"
                                            placeholder={
                                              isShowingDriveContents
                                                ? "Search Google Drive..."
                                                : "Search collections..."
                                            }
                                            value={dropdownSearchQuery}
                                            onChange={(e) =>
                                              setDropdownSearchQuery(
                                                e.target.value,
                                              )
                                            }
                                            className="w-full pl-10 pr-10 py-2 text-sm bg-white dark:bg-gray-800 border-0 focus:outline-none text-gray-700 dark:text-gray-200 placeholder-gray-400"
                                            onClick={(e) => e.stopPropagation()}
                                          />
                                          {dropdownSearchQuery && (
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation()
                                                setDropdownSearchQuery("")
                                              }}
                                              className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                                            >
                                              <LucideX className="h-4 w-4" />
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                    )}

                                    {/* Content area - unified global search */}
                                    {(() => {
                                      // If there's a search query, always show global search results
                                      if (dropdownSearchQuery.trim()) {
                                        const isInGoogleDriveContext =
                                          navigationPath.some(
                                            (item) =>
                                              item.type === "drive-root" ||
                                              item.type === "drive-folder",
                                          )
                                        return (
                                          <div className="max-h-60 overflow-y-auto">
                                            {isSearching ? (
                                              <div className="px-4 py-8 text-sm text-gray-500 dark:text-gray-400 text-center">
                                                Searching...
                                              </div>
                                            ) : searchResults.length > 0 ? (
                                              isInGoogleDriveContext ? (
                                                <GoogleDriveNavigation
                                                  navigationPath={
                                                    navigationPath
                                                  }
                                                  setNavigationPath={
                                                    setNavigationPath
                                                  }
                                                  currentItems={currentItems}
                                                  setCurrentItems={
                                                    setCurrentItems
                                                  }
                                                  isLoadingItems={
                                                    isLoadingItems
                                                  }
                                                  setIsLoadingItems={
                                                    setIsLoadingItems
                                                  }
                                                  dropdownSearchQuery={
                                                    dropdownSearchQuery
                                                  }
                                                  setDropdownSearchQuery={
                                                    setDropdownSearchQuery
                                                  }
                                                  searchResults={searchResults}
                                                  isSearching={isSearching}
                                                  selectedItemsInGoogleDrive={
                                                    selectedItemsInGoogleDrive
                                                  }
                                                  setSelectedItemsInGoogleDrive={
                                                    setSelectedItemsInGoogleDrive
                                                  }
                                                  selectedItemDetailsInGoogleDrive={
                                                    selectedItemDetailsInGoogleDrive
                                                  }
                                                  setSelectedItemDetailsInGoogleDrive={
                                                    setSelectedItemDetailsInGoogleDrive
                                                  }
                                                  selectedIntegrations={
                                                    selectedIntegrations
                                                  }
                                                  setSelectedIntegrations={
                                                    setSelectedIntegrations
                                                  }
                                                />
                                              ) : (
                                                searchResults.map(
                                                  (result: any) => {
                                                    // Check if we're in Google Drive context for proper handling

                                                    // Handle regular search results (knowledge-base, etc.)
                                                    // Check if the item is directly selected vs inherited from parent
                                                    const isDirectlySelected =
                                                      result.type ===
                                                      "collection"
                                                      ? selectedIntegrations[
                                                      `cl_${result.id}`
                                                      ]
                                                      : selectedItemsInCollection[
                                                        result.collectionId
                                                      ]?.has(result.id)

                                                  const isSelected =
                                                    result.type ===
                                                      "collection"
                                                      ? selectedIntegrations[
                                                      `cl_${result.id}`
                                                      ]
                                                      : isItemSelectedWithInheritance(
                                                        result,
                                                        selectedItemsInCollection,
                                                        selectedIntegrations,
                                                        selectedItemDetailsInCollection,
                                                      )

                                                  const isInherited =
                                                    isSelected &&
                                                    !isDirectlySelected

                                                  const handleResultSelect =
                                                    () => {
                                                      // Don't allow selection changes for inherited items
                                                      if (isInherited) return

                                                      if (
                                                        result.type ===
                                                        "collection"
                                                      ) {
                                                        // Toggle collection selection
                                                        const integrationId = `cl_${result.id}`
                                                        toggleIntegrationSelection(
                                                          integrationId,
                                                        )
                                                      } else if (
                                                        result.type ===
                                                        "folder" ||
                                                        result.type === "file"
                                                      ) {
                                                        // For folders and files, first make sure the collection is selected
                                                        const collectionIntegrationId = `cl_${result.collectionId}`

                                                        // Ensure collection is selected
                                                        if (
                                                          !selectedIntegrations[
                                                          collectionIntegrationId
                                                          ]
                                                        ) {
                                                          toggleIntegrationSelection(
                                                            collectionIntegrationId,
                                                          )
                                                        }

                                                        // Then handle the specific item selection
                                                        const clId =
                                                          result.collectionId
                                                        const itemId =
                                                          result.id

                                                        setSelectedItemsInCollection(
                                                          (prev) => {
                                                            const currentSelection =
                                                              prev[clId] ||
                                                              new Set()
                                                            const newSelection =
                                                              new Set(
                                                                currentSelection,
                                                              )

                                                            if (
                                                              newSelection.has(
                                                                itemId,
                                                              )
                                                            ) {
                                                              newSelection.delete(
                                                                itemId,
                                                              )
                                                            } else {
                                                              newSelection.add(
                                                                itemId,
                                                              )
                                                            }

                                                            return {
                                                              ...prev,
                                                              [clId]:
                                                                newSelection,
                                                            }
                                                          },
                                                        )

                                                        setSelectedItemDetailsInCollection(
                                                          (prev) => {
                                                            const newDetails =
                                                            {
                                                              ...prev,
                                                            }
                                                            if (
                                                              !newDetails[
                                                              clId
                                                              ]
                                                            ) {
                                                              newDetails[
                                                                clId
                                                              ] = {}
                                                            }
                                                            newDetails[clId][
                                                              itemId
                                                            ] = {
                                                              id: itemId,
                                                              name: result.name,
                                                              type: result.type,
                                                              path: result.path,
                                                              collectionName:
                                                                result.collectionName,
                                                            }
                                                            return newDetails
                                                          },
                                                        )
                                                      }

                                                      // Close search and clear query
                                                      setDropdownSearchQuery(
                                                        "",
                                                      )
                                                      setSearchResults([])
                                                    }

                                                    return (
                                                      <div
                                                        key={result.id}
                                                        onClick={
                                                          isInherited
                                                            ? undefined
                                                            : handleResultSelect
                                                        }
                                                        className={`flex items-center px-4 py-2 text-sm ${isInherited ? "cursor-default opacity-75" : "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800"}`}
                                                      >
                                                        <input
                                                          type="checkbox"
                                                          checked={
                                                            isSelected || false
                                                          }
                                                          disabled={isInherited}
                                                          onChange={() => {}}
                                                          className={`w-4 h-4 mr-3 ${isInherited ? "opacity-60" : ""}`}
                                                        />
                                                        <div className="flex-1 min-w-0">
                                                          <div className="flex items-center">
                                                            <span className="text-gray-700 dark:text-gray-200 truncate">
                                                              {result.name}
                                                            </span>
                                                            <span className="text-xs text-gray-500 dark:text-gray-400 ml-2 px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded">
                                                              {result.type}
                                                            </span>
                                                            {isInherited && (
                                                              <span className="text-xs text-blue-600 dark:text-blue-400 ml-2 px-2 py-1 bg-blue-50 dark:bg-blue-900/30 rounded">
                                                                Selected
                                                              </span>
                                                            )}
                                                          </div>
                                                          {result.collectionName &&
                                                            result.type !==
                                                              "collection" && (
                                                              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                                                                in{" "}
                                                                {
                                                                  result.collectionName
                                                                }
                                                                {result.path &&
                                                                  ` / ${result.path}`}
                                                              </div>
                                                            )}
                                                          {result.description && (
                                                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                                                              {
                                                                result.description
                                                              }
                                                            </div>
                                                          )}
                                                        </div>
                                                      </div>
                                                    )
                                                  },
                                                )
                                              )
                                            ) : (
                                              <div className="px-4 py-8 text-sm text-gray-500 dark:text-gray-400 text-center">
                                                No results found for "
                                                {dropdownSearchQuery}"
                                              </div>
                                            )}
                                          </div>
                                        )
                                      }

                                    // If no search query, show navigation-based content
                                    if (navigationPath.length === 0) {
                                      // Main menu - show regular integrations and Collections option
                                      const knowledgeBases =
                                        allAvailableIntegrations.filter(
                                          (integration) =>
                                            integration.id.startsWith("cl_"),
                                        )
                                      const otherIntegrations =
                                        allAvailableIntegrations.filter(
                                          (integration) =>
                                            !integration.id.startsWith("cl_"),
                                        )
                                      const hasSelectedKB =
                                        knowledgeBases.some(
                                          (cl) => selectedIntegrations[cl.id],
                                        )

                                      return (
                                        <>
                                          {/* Regular integrations */}
                                          {otherIntegrations.map(
                                            (integration) => {
                                              const isGoogleDrive =
                                                integration.app ===
                                                Apps.GoogleDrive &&
                                                integration.entity === "file"
                                              const showChevron =
                                                isGoogleDrive

                                              return (
                                                <DropdownMenuItem
                                                  key={integration.id}
                                                  onSelect={(e) => {
                                                    e.preventDefault()
                                                    toggleIntegrationSelection(
                                                      integration.id,
                                                    )
                                                  }}
                                                  className="flex items-center justify-between cursor-pointer text-sm py-2.5 px-4 hover:!bg-transparent focus:!bg-transparent data-[highlighted]:!bg-transparent"
                                                >
                                                  <div className="flex items-center">
                                                    <input
                                                      type="checkbox"
                                                      checked={
                                                        selectedIntegrations[
                                                        integration.id
                                                        ] || false
                                                      }
                                                      onChange={() => { }}
                                                      className="w-4 h-4 mr-3"
                                                    />
                                                    <span className="mr-2 flex items-center">
                                                      {integration.icon}
                                                    </span>
                                                    <span className="text-gray-700 dark:text-gray-200">
                                                      {integration.name}
                                                    </span>
                                                  </div>
                                                  {showChevron && (
                                                    <ChevronRight className="h-4 w-4 text-gray-400" />
                                                  )}
                                                </DropdownMenuItem>
                                              )
                                            },
                                          )}

                                          {/* Collections item */}
                                          {knowledgeBases.length > 0 && (
                                            <DropdownMenuItem
                                              onSelect={(e) => {
                                                e.preventDefault()
                                                setNavigationPath([
                                                  {
                                                    id: "cl-root",
                                                    name: "Collections",
                                                    type: "cl-root",
                                                  },
                                                ])
                                                setDropdownSearchQuery("")
                                              }}
                                              className="flex items-center justify-between cursor-pointer text-sm py-2.5 px-4 hover:!bg-transparent focus:!bg-transparent data-[highlighted]:!bg-transparent"
                                            >
                                              <div className="flex items-center">
                                                <input
                                                  type="checkbox"
                                                  checked={hasSelectedKB}
                                                  onChange={() => { }}
                                                  className="w-4 h-4 mr-3"
                                                />
                                                <BookOpen className="w-4 h-4 mr-2 text-blue-600" />
                                                <span className="text-gray-700 dark:text-gray-200">
                                                  Collections
                                                </span>
                                              </div>
                                              <ChevronRight className="h-4 w-4 text-gray-400" />
                                            </DropdownMenuItem>
                                          )}
                                        </>
                                      )
                                    } else if (
                                      navigationPath.length === 1 &&
                                      navigationPath[0].type === "cl-root"
                                    ) {
                                      // Show collections list
                                      const knowledgeBases =
                                        allAvailableIntegrations.filter(
                                          (integration) =>
                                            integration.id.startsWith("cl_"),
                                        )

                                      return knowledgeBases.map(
                                        (integration) => {
                                          const clId = integration.id.replace(
                                            "cl_",
                                            "",
                                          )

                                            return (
                                              <DropdownMenuItem
                                                key={integration.id}
                                                onSelect={(e) => {
                                                  e.preventDefault()
                                                  // Don't navigate when clicking the checkbox area
                                                }}
                                                className="flex items-center justify-between cursor-pointer text-sm py-2.5 px-4 hover:!bg-transparent focus:!bg-transparent data-[highlighted]:!bg-transparent"
                                              >
                                                <div className="flex items-center flex-1">
                                                  <input
                                                    type="checkbox"
                                                    checked={
                                                      !!selectedIntegrations[
                                                        integration.id
                                                      ]
                                                    }
                                                    onChange={(e) => {
                                                      e.stopPropagation()
                                                      toggleIntegrationSelection(
                                                        integration.id,
                                                      )
                                                    }}
                                                    className="w-4 h-4 mr-3"
                                                    onClick={(e) =>
                                                      e.stopPropagation()
                                                    }
                                                  />
                                                  <span className="mr-2 flex items-center">
                                                    {integration.icon}
                                                  </span>
                                                  <span
                                                    className="text-gray-700 dark:text-gray-200 cursor-pointer"
                                                    onClick={(e) => {
                                                      e.stopPropagation()
                                                      navigateToCl(
                                                        clId,
                                                        integration.name,
                                                      )
                                                    }}
                                                  >
                                                    {integration.name}
                                                  </span>
                                                </div>
                                                <ChevronRight
                                                  className="h-4 w-4 text-gray-400 cursor-pointer"
                                                  onClick={(e) => {
                                                    e.stopPropagation()
                                                    navigateToCl(
                                                      clId,
                                                      integration.name,
                                                    )
                                                  }}
                                                />
                                              </DropdownMenuItem>
                                            )
                                          },
                                        )
                                      } else if (
                                        navigationPath.some(
                                          (item) =>
                                            item.type === "drive-root" ||
                                            item.type === "drive-folder",
                                        )
                                      ) {
                                        // Show Google Drive contents (files/folders)
                                        return (
                                          <GoogleDriveNavigation
                                            navigationPath={navigationPath}
                                            setNavigationPath={
                                              setNavigationPath
                                            }
                                            currentItems={currentItems}
                                            setCurrentItems={setCurrentItems}
                                            isLoadingItems={isLoadingItems}
                                            setIsLoadingItems={
                                              setIsLoadingItems
                                            }
                                            dropdownSearchQuery={
                                              dropdownSearchQuery
                                            }
                                            setDropdownSearchQuery={
                                              setDropdownSearchQuery
                                            }
                                            searchResults={searchResults}
                                            isSearching={isSearching}
                                            selectedItemsInGoogleDrive={
                                              selectedItemsInGoogleDrive
                                            }
                                            setSelectedItemsInGoogleDrive={
                                              setSelectedItemsInGoogleDrive
                                            }
                                            selectedItemDetailsInGoogleDrive={
                                              selectedItemDetailsInGoogleDrive
                                            }
                                            setSelectedItemDetailsInGoogleDrive={
                                              setSelectedItemDetailsInGoogleDrive
                                            }
                                            setSelectedIntegrations={
                                              setSelectedIntegrations
                                            }
                                            selectedIntegrations={
                                              selectedIntegrations
                                            }
                                          />
                                        )
                                      } else {
                                        // Show Collection contents (files/folders)
                                        return (
                                          <CollectionNavigation
                                            navigationPath={navigationPath}
                                            setNavigationPath={
                                              setNavigationPath
                                            }
                                            currentItems={currentItems}
                                            setCurrentItems={setCurrentItems}
                                            isLoadingItems={isLoadingItems}
                                            setIsLoadingItems={
                                              setIsLoadingItems
                                            }
                                            dropdownSearchQuery={
                                              dropdownSearchQuery
                                            }
                                            setDropdownSearchQuery={
                                              setDropdownSearchQuery
                                            }
                                            searchResults={searchResults}
                                            isSearching={isSearching}
                                            selectedIntegrations={
                                              selectedIntegrations
                                            }
                                            setSelectedIntegrations={
                                              setSelectedIntegrations
                                            }
                                            selectedItemsInCollection={
                                              selectedItemsInCollection
                                            }
                                            setSelectedItemsInCollection={
                                              setSelectedItemsInCollection
                                            }
                                            selectedItemDetailsInCollection={
                                              selectedItemDetailsInCollection
                                            }
                                            setSelectedItemDetailsInCollection={
                                              setSelectedItemDetailsInCollection
                                            }
                                            allAvailableIntegrations={
                                              allAvailableIntegrations
                                            }
                                            toggleIntegrationSelection={
                                              toggleIntegrationSelection
                                            }
                                            navigateToCl={navigateToCl}
                                          />
                                        )
                                      }

                                    return null
                                  })()}
                                </>
                              )
                            })()}
                        </div>
                      </DropdownMenuContent>
                    </DropdownMenu>
                </div>

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
                                    className={`flex items-center justify-between p-2 hover:bg-gray-100 dark:hover:bg-slate-700 cursor-pointer border-b dark:border-slate-700 last:border-b-0 ${index === selectedSearchIndex
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
                ref={chatBoxRef}
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
                overrideIsRagOn={testAgentIsRagOn}
                agentIdFromChatData={selectedChatAgentExternalId}
                chatId={chatId}
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
  onView: () => void
  onDelete: () => void
  onClick: () => void
  isShared?: boolean
  isMadeByMe?: boolean // New prop
  isAgentPublic?: boolean
}

function AgentListItem({
  agent,
  isFavorite,
  isShared,
  isMadeByMe, // Added
  onToggleFavorite,
  onEdit,
  onView,
  onDelete,
  onClick,
  isAgentPublic,
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
        {(isShared || (isAgentPublic && !isMadeByMe)) && (
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation()
              onView()
            }}
            className="h-8 w-8 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-slate-100 dark:hover:bg-slate-700"
            title="View Agent"
          >
            <Eye size={16} />
          </Button>
        )}
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
      className={`flex items-center gap-2 px-4 py-2 text-sm font-mono font-medium rounded-full transition-colors ${active
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

const textToCitationIndexPattern = textToCitationIndex

const renderMarkdownLink = ({
  node,
  ...linkProps
}: { node?: any;[key: string]: any }) => (
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
      let localCitationMap: Record<number, number> = {}
      let localIndex = 0
      return text.replace(textToCitationIndex, (match, num) => {
        const citationindex = parseInt(num, 10)
        if (localCitationMap[citationindex] === undefined) {
          localCitationMap[citationindex] = localIndex
          localIndex++
        }
        const url = citationUrls[localCitationMap[citationindex]]
        return typeof localCitationMap[citationindex] === "number" && url
        ? `[${localCitationMap[citationindex] + 1}](${url})`
        : ""
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
