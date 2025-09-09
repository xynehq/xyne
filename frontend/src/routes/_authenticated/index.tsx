import { createFileRoute } from "@tanstack/react-router"
import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { useTheme } from "@/components/ThemeContext"
import { Sidebar } from "@/components/Sidebar"
import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router"
import { Bot, Search as SearchIcon } from "lucide-react"
import { SearchBar } from "@/components/SearchBar"
import {
  AutocompleteResults,
  AutocompleteResultsSchema,
  Autocomplete,
  SelectPublicAgent,
  AttachmentMetadata,
} from "shared/types"
import { api } from "@/api"
import { ChatBox } from "@/components/ChatBox"
import Sparkle from "@/assets/singleSparkle.svg?react"
import { errorComponent } from "@/components/error"
import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Tip } from "@/components/Tooltip"
import { ToolsListItem, indexSearchParamsSchema } from "@/types"
import { AgentCard } from "@/components/AgentCard"

enum Tabs {
  Search = "search",
  Ask = "ask",
}

const Index = () => {
  const { theme } = useTheme()
  const [activeTab, setActiveTab] = useState<Tabs>(Tabs.Ask)
  const [query, setQuery] = useState("")
  const AGENTIC_STATE = "agenticState"
  const [isAgenticMode, setIsAgenticMode] = useState(() => {
    const storedValue = localStorage.getItem(AGENTIC_STATE)
    return storedValue ? JSON.parse(storedValue) : false
  })
  const [persistedAgentId, setPersistedAgentId] = useState<string | null>(null)
  const [agent, setAgent] = useState<SelectPublicAgent | null>(null)
  const [allAgents, setAllAgents] = useState<SelectPublicAgent[]>([])
  const FAVORITE_AGENTS_STORAGE_KEY = "favoriteAgentsList"

  const [favoriteAgents, setFavoriteAgents] = useState<string[]>(() => {
    try {
      const storedFavorites = localStorage.getItem(FAVORITE_AGENTS_STORAGE_KEY)
      return storedFavorites ? JSON.parse(storedFavorites) : []
    } catch (error) {
      console.error("Error parsing favorite agents from localStorage", error)
      return []
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(
        FAVORITE_AGENTS_STORAGE_KEY,
        JSON.stringify(favoriteAgents),
      )
    } catch (error) {
      console.error("Error saving favorite agents to localStorage", error)
    }
  }, [favoriteAgents])

  const toggleFavorite = useCallback((agentExternalId: string) => {
    setFavoriteAgents((prevFavorites) =>
      prevFavorites.includes(agentExternalId)
        ? prevFavorites.filter((id) => id !== agentExternalId)
        : [...prevFavorites, agentExternalId],
    )
  }, [])

  useEffect(() => {
    const fetchAgents = async () => {
      try {
        const response = await api.agents.$get({ query: { filter: "all" } })
        if (response.ok) {
          const data = (await response.json()) as SelectPublicAgent[]
          setAllAgents(data)
        } else {
          console.error("Failed to fetch agents.")
          setAllAgents([])
        }
      } catch (error) {
        console.error("An error occurred while fetching agents:", error)
        setAllAgents([])
      }
    }
    fetchAgents()
  }, [])

  const favoriteAgentObjects = useMemo(() => {
    const favoriteIdSet = new Set(favoriteAgents)
    return allAgents.filter((agent) => favoriteIdSet.has(agent.externalId))
  }, [allAgents, favoriteAgents])

  useEffect(() => {
    const fetchAgentDetails = async () => {
      if (persistedAgentId) {
        try {
          const response = await api.agent[":agentExternalId"].$get({
            param: { agentExternalId: persistedAgentId },
          })
          if (response.ok) {
            const currentAgent = (await response.json()) as SelectPublicAgent
            setAgent(currentAgent)
          } else {
            setAgent(null)
          }
        } catch (error) {
          setAgent(null)
        }
      } else {
        setAgent(null) // Clear display name if no persistedAgentId
      }
    }

    fetchAgentDetails()
  }, [persistedAgentId]) // Depend on persistedAgentId

  useEffect(() => {
    localStorage.setItem(AGENTIC_STATE, JSON.stringify(isAgenticMode))
  }, [isAgenticMode])

  const [autocompleteResults, setAutocompleteResults] = useState<
    Autocomplete[]
  >([])
  const [autocompleteQuery, setAutocompleteQuery] = useState("")
  const autocompleteRef = useRef<HTMLDivElement | null>(null)
  const debounceTimeout = useRef<number | null>(null)

  const [_, setOffset] = useState(0)
  const [filter, setFilter] = useState({})

  const navigate = useNavigate({ from: "/" })
  const matches = useRouterState({ select: (s) => s.matches })
  const { user, agentWhiteList } = matches[matches.length - 1].context
  const searchParams = useSearch({ from: "/_authenticated/" })

  useEffect(() => {
    setPersistedAgentId(searchParams.agentId || null)
  }, [searchParams.agentId])

  useEffect(() => {
    if (!autocompleteQuery) {
      return
    }
    if (autocompleteQuery.length < 2) {
      setAutocompleteResults([])
      return
    }
    if (debounceTimeout.current) {
      clearTimeout(debounceTimeout.current)
    }
    debounceTimeout.current = window.setTimeout(() => {
      ;(async () => {
        try {
          const response = await api.autocomplete.$post({
            json: {
              query: autocompleteQuery,
            },
          })
          let data: AutocompleteResults = await response.json()
          data = AutocompleteResultsSchema.parse(data)
          setAutocompleteResults(data.results)
        } catch (error) {
          console.error(`Error fetching autocomplete results:`, error)
        }
      })()
    }, 300)

    return () => {
      if (debounceTimeout.current) {
        clearTimeout(debounceTimeout.current)
      }
    }
  }, [autocompleteQuery])

  // Close autocomplete if clicked outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        autocompleteRef.current &&
        !autocompleteRef.current.contains(event.target as Node)
      ) {
        setAutocompleteResults([])
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [])

  const handleSearch = () => {
    if (query.trim()) {
      navigate({
        to: "/search",
        search: {
          query: encodeURIComponent(decodeURIComponent(query.trim())),
          debug: false,
        },
      })
    }
  }

  const handleAsk = (
    messageToSend: string,
    metadata?: AttachmentMetadata[],
    selectedSources?: string[],
    agentId?: string | null,
    toolsList?: ToolsListItem[],
    selectedModel?: string,
  ) => {
    if (messageToSend.trim()) {
      const searchParams: {
        q: string
        sources?: string
        agentId?: string
        toolsList?: ToolsListItem[]
        agentic?: boolean
        metadata?: AttachmentMetadata[]
        selectedModel?: string
      } = {
        q: encodeURIComponent(messageToSend.trim()),
      }

      if (selectedSources && selectedSources.length > 0) {
        searchParams.sources = selectedSources.join(",")
      }
      // If agentId is provided, use it, otherwise use the persisted agent ID from the URL
      if (agentId || persistedAgentId) {
        searchParams.agentId = agentId || (persistedAgentId as string)
      }
      if (isAgenticMode) {
        searchParams.agentic = true
      }

      if (metadata && metadata.length > 0) {
        searchParams.metadata = metadata
      }

      // Use toolsList as array instead of JSON string
      if (toolsList && toolsList.length > 0) {
        searchParams.toolsList = toolsList
      }

      if (selectedModel) {
        searchParams.selectedModel = selectedModel
      }

      navigate({
        to: "/chat",
        search: searchParams,
      })
    }
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        setActiveTab((prevTab) =>
          prevTab === Tabs.Search ? Tabs.Ask : Tabs.Search,
        )
        e.preventDefault()
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [])

  return (
    <TooltipProvider>
      <div className="h-full w-full flex flex-row bg-white dark:bg-[#1E1E1E]">
        <Sidebar
          photoLink={user?.photoLink ?? ""}
          role={user?.role}
          isAgentMode={agentWhiteList}
        />
        <div className="flex flex-col flex-grow ml-[52px] relative">
          {agent && (
            <div className="flex w-full max-w-3xl items-center justify-between pt-12 self-center">
              <div>
                <h1 className="font-display text-3xl dark:text-white">
                  {agent.name}
                </h1>
              </div>
              <div className="w-1/2 pl-5">
                <p className="text-gray-500 dark:text-gray-400 text-right line-clamp-2">
                  {agent.description}
                </p>
              </div>
            </div>
          )}
          <div className="flex flex-col flex-grow justify-center items-center w-full">
            <div className="flex flex-col min-h-36 w-full max-w-3xl z-10">
              {" "}
              {/* Ensure content is above the text logo */}
              <div className="flex mb-[14px] w-full justify-start">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className={`flex items-center pr-[12px] rounded-[20px] ${
                        activeTab === Tabs.Ask
                          ? "bg-[#EDF2F7] dark:bg-slate-700 text-[#33383D] dark:text-gray-100"
                          : "text-[#728395] dark:text-gray-400"
                      }`}
                      onClick={() => setActiveTab(Tabs.Ask)}
                    >
                      <Sparkle
                        stroke={
                          activeTab === Tabs.Ask
                            ? theme === "dark"
                              ? "#F3F4F6"
                              : "#33383D"
                            : theme === "dark"
                              ? "#9CA3AF"
                              : "#728395"
                        }
                        className={`w-[14px] h-[14px] ml-[12px] mr-[6px] mt-[6px] mb-[6px]`}
                      />
                      Ask
                    </button>
                  </TooltipTrigger>
                  <Tip info="Use `tab` key to switch between Ask & Search" />
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className={`flex items-center pr-[12px] rounded-[20px] ${
                        activeTab === Tabs.Search
                          ? "bg-[#EDF2F7] dark:bg-slate-700 text-[#33383D] dark:text-gray-100"
                          : "text-[#728395] dark:text-gray-400"
                      }`}
                      onClick={() => setActiveTab(Tabs.Search)}
                    >
                      <SearchIcon
                        size={16}
                        stroke={
                          activeTab === Tabs.Search
                            ? theme === "dark"
                              ? "#F3F4F6"
                              : "#33383D"
                            : theme === "dark"
                              ? "#9CA3AF"
                              : "#728395"
                        }
                        className="ml-[12px] mr-[6px] mt-[6px] mb-[6px]"
                      />
                      Search
                    </button>
                  </TooltipTrigger>
                  <Tip info="Use `tab` key to switch between Ask & Search" />
                </Tooltip>
              </div>
              {activeTab === "search" && (
                <div className="w-full h-72">
                  <SearchBar
                    query={query}
                    setQuery={setQuery}
                    handleSearch={handleSearch}
                    autocompleteResults={autocompleteResults}
                    setAutocompleteResults={setAutocompleteResults}
                    setAutocompleteQuery={setAutocompleteQuery}
                    setOffset={setOffset}
                    setFilter={setFilter}
                    handleAnswer={() => {}}
                    ref={autocompleteRef}
                    hasSearched={false}
                    filter={filter}
                  />
                </div>
              )}
              {activeTab === "ask" && (
                <div className="w-full h-72">
                  <ChatBox
                    role={user?.role}
                    query={query}
                    user={user}
                    setQuery={setQuery}
                    handleSend={handleAsk}
                    allCitations={new Map()} // Change this line
                    isAgenticMode={isAgenticMode}
                    setIsAgenticMode={setIsAgenticMode}
                    agentIdFromChatData={persistedAgentId}
                  />
                </div>
              )}
            </div>
          </div>
          {/* Favorite Agents Section */}
          {favoriteAgentObjects.length > 0 && (
            <div className="absolute bottom-0 left-0 right-0 p-4 bg-white dark:bg-[#1E1E1E]">
              <div className="max-w-full mx-auto">
                <h2 className="text-sm text-center font-mono font-bold text-gray-700 dark:text-gray-400 mb-4 flex items-center justify-center">
                  <Bot className="w-5 h-5 mr-2 mb-1" />
                  YOUR AGENTS
                </h2>
                <div className="flex overflow-x-auto space-x-4 pb-2 favorite-agents-container">
                  {favoriteAgentObjects.map((agent) => (
                    <div key={agent.externalId} className="flex-shrink-0 w-64">
                      <AgentCard
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
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}

export const Route = createFileRoute("/_authenticated/")({
  component: () => {
    return <Index />
  },
  validateSearch: (search) => indexSearchParamsSchema.parse(search),
  errorComponent: errorComponent,
})
