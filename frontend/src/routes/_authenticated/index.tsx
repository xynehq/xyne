import { createFileRoute } from "@tanstack/react-router"
import { useState, useEffect, useRef } from "react"
import { Sidebar } from "@/components/Sidebar"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { Search as SearchIcon } from "lucide-react"
import { SearchBar } from "@/components/SearchBar"
import {
  AutocompleteResults,
  AutocompleteResultsSchema,
  Autocomplete,
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

enum Tabs {
  Search = "search",
  Ask = "ask",
}

const Index = () => {
  const [activeTab, setActiveTab] = useState<Tabs>(Tabs.Ask)
  const [query, setQuery] = useState("")

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
  const { user } = matches[matches.length - 1].context

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
        search: { query: encodeURIComponent(decodeURIComponent(query.trim())) },
      })
    }
  }

  const handleAsk = (messageToSend: string) => {
    if (query.trim()) {
      navigate({
        to: "/chat",
        search: { q: encodeURIComponent(messageToSend.trim()) },
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
      <div className="h-full w-full flex flex-row bg-white">
        <Sidebar photoLink={user?.photoLink ?? ""} role={user?.role} />
        <div className="flex flex-col flex-grow justify-center items-center ml-[52px]">
          <div className="flex flex-col min-h-36 w-full max-w-3xl">
            <div className="flex mb-[14px] w-full justify-start">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className={`flex items-center pr-[12px] rounded-[20px] ${
                      activeTab === Tabs.Ask
                        ? "bg-[#EDF2F7] text-[#33383D]"
                        : "text-[#728395]"
                    }`}
                    onClick={() => setActiveTab(Tabs.Ask)}
                  >
                    <Sparkle
                      stroke={activeTab === Tabs.Ask ? "#33383D" : "#728395"}
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
                    className={`flex items-center text-[#33383D] pr-[12px] rounded-[20px] ${
                      activeTab === Tabs.Search
                        ? "bg-[#EDF2F7] text-[#33383D]"
                        : "text-[#728395]"
                    }`}
                    onClick={() => setActiveTab(Tabs.Search)}
                  >
                    <SearchIcon
                      size={16}
                      stroke={activeTab === Tabs.Search ? "#33383D" : "#728395"}
                      className="ml-[12px] mr-[6px] mt-[6px] mb-[6px]"
                    />
                    Search
                  </button>
                </TooltipTrigger>
                <Tip info="Use `tab` key to switch between Ask & Search" />
              </Tooltip>
            </div>
            {activeTab === "search" && (
              <div className="w-full">
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
                  autocompleteRef={autocompleteRef}
                />
              </div>
            )}
            {activeTab === "ask" && (
              <div className="w-full max-w-3xl">
                <ChatBox
                  query={query}
                  setQuery={setQuery}
                  handleSend={handleAsk}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}

export const Route = createFileRoute("/_authenticated/")({
  component: () => {
    return <Index />
  },
  errorComponent: errorComponent,
})
