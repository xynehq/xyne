import {
  createFileRoute,
  useNavigate,
  useRouterState,
  useSearch,
} from "@tanstack/react-router"
import MarkdownPreview from "@uiw/react-markdown-preview"

const page = 8

import { Sidebar } from "@/components/Sidebar"

import { useEffect, useRef, useState } from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { api } from "@/api"
import {
  AnswerSSEvents,
  Apps,
  Autocomplete,
  AutocompleteResults,
  AutocompleteResultsSchema,
  SearchResponse,
  SearchResultDiscriminatedUnion,
} from "shared/types"
import { Filter, Groups } from "@/types"
import { SearchResult } from "@/components/SearchResult"
import answerSparkle from "@/assets/answerSparkle.svg"
import { GroupFilter } from "@/components/GroupFilter"
import { SearchBar } from "@/components/SearchBar"
import { Button } from "@/components/ui/button"
import { z } from "zod"
import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Info, // Import Info icon for the button
  MessageSquareShare,
} from "lucide-react"
import { LastUpdated } from "@/components/SearchFilter"
import { PublicUser, PublicWorkspace } from "shared/types"
import { errorComponent } from "@/components/error"

const logger = console

export function SearchInfo({ info }: { info: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            className="p-0 m-0 rounded-full h-[20px] w-[20px] text-xs text-gray-500"
          >
            i
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{info}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

type SearchMeta = {
  totalCount: number
}

interface IndexProps {
  user: PublicUser
  workspace: PublicWorkspace
}

export const Search = ({ user, workspace }: IndexProps) => {
  let search: XyneSearch = useSearch({
    from: "/_authenticated/search",
  })
  const navigate = useNavigate({ from: "/search" })
  // TODO: debug the react warning
  // Cannot update a component (`MatchesInner`)
  if (!search.query) {
    navigate({
      to: "/",
    })
  }

  const QueryTyped = useRouterState({
    select: (s) => s.location.state.isQueryTyped,
  })

  const [query, setQuery] = useState(decodeURIComponent(search.query || "")) // State to hold the search query
  const [offset, setOffset] = useState(0)
  const [results, setResults] = useState<SearchResultDiscriminatedUnion[]>([]) // State to hold the search results
  const [groups, setGroups] = useState<Groups | null>(null)
  const [filter, setFilter] = useState<Filter>({
    lastUpdated: (search.lastUpdated as LastUpdated) || "anytime",
  })
  const [searchMeta, setSearchMeta] = useState<SearchMeta | null>(null)
  const [answer, setAnswer] = useState<string | null>(null)
  const [isExpanded, setIsExpanded] = useState<boolean>(false)
  const [showDebugInfo, setShowDebugInfo] = useState(import.meta.env.VITE_SHOW_DEBUG_INFO === 'true') // State for debug info visibility, initialized from env var
  // close autocomplete if clicked outside
  const autocompleteRef = useRef<HTMLDivElement | null>(null)
  const [autocompleteQuery, setAutocompleteQuery] = useState("")

  // for autocomplete
  const debounceTimeout = useRef<number | null>(null) // Debounce timer
  const [autocompleteResults, setAutocompleteResults] = useState<
    Autocomplete[]
  >([])

  // Click outside handler
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      // If click is outside the autocomplete box, hide the autocomplete results
      if (
        autocompleteRef.current &&
        !autocompleteRef.current.contains(event.target as Node)
      ) {
        setAutocompleteResults([]) // Hide autocomplete by clearing results
      }
    }

    // Attach the event listener to detect clicks outside
    document.addEventListener("mousedown", handleClickOutside)

    // Cleanup listener on component unmount
    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [autocompleteRef])

  useEffect(() => {
    if (!autocompleteQuery) {
      return
    }
    if (query.length < 2) {
      setAutocompleteResults([])
      return
    }
    // Debounce logic
    if (debounceTimeout.current) {
      clearTimeout(debounceTimeout.current)
    }
    debounceTimeout.current = window.setTimeout(async () => {
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
        logger.error(error, `Error fetching autocomplete results:', ${error}`)
      }
    }, 300) // 300ms debounce

    // Cleanup function to clear the timeout when component unmounts or new call starts
    return () => {
      if (debounceTimeout.current) {
        clearTimeout(debounceTimeout.current)
      }
    }
  }, [autocompleteQuery])

  useEffect(() => {
    if (search && search.query) {
      const decodedQuery = decodeURIComponent(search.query)
      setQuery(decodedQuery)
    }
  }, [])

  useEffect(() => {
    handleSearch()
  }, [filter, offset])

  const handleAnswer = async (newFilter = filter) => {
    if (!query) return // If the query is empty, do nothing

    setAnswer(null)

    const url = new URL(`/api/answer`, window.location.origin)
    url.searchParams.append("query", encodeURIComponent(query))
    if (newFilter && newFilter.app && newFilter.entity) {
      url.searchParams.append("app", newFilter.app)
      url.searchParams.append("entity", newFilter.entity)
    }
    if (newFilter.lastUpdated) {
      url.searchParams.append("lastUpdated", newFilter.lastUpdated)
    }

    const eventSource = new EventSource(url.toString(), {
      withCredentials: true,
    })

    eventSource.addEventListener(AnswerSSEvents.AnswerUpdate, (event) => {
      const chunk = event.data
      setAnswer((prevAnswer) => (prevAnswer ? prevAnswer + chunk : chunk))
    })

    eventSource.addEventListener(AnswerSSEvents.Start, (event) => {
      // Handle start event if needed
    })

    eventSource.addEventListener(AnswerSSEvents.End, (event) => {
      // Handle end event
      eventSource.close()
    })

    // Listen for incoming messages from the server
    eventSource.onmessage = (event) => {
      const chunk = event.data // Assuming data is just text
      setAnswer((prevAnswer) => (prevAnswer ? prevAnswer + chunk : chunk)) // Append chunk to the answer
    }

    // Handle error events
    eventSource.onerror = (error) => {
      // console.error("Error with SSE:", error, error.stack, error.message)
      eventSource.close() // Close the connection on error
    }
  }

  const handleSearch = async (newOffset = offset) => {
    if (!query) return
    setAutocompleteResults([])
    try {
      // TODO: figure out when lastUpdated changes and only
      // then make it true or when app,entity is not present
      const groupCount = true
      let params: any = {
        page: page,
        offset: newOffset,
        query: encodeURIComponent(query),
        groupCount,
        lastUpdated: filter.lastUpdated || "anytime",
        isQueryTyped: QueryTyped,
      }

      let pageCount = page
      if (filter.app && filter.entity) {
        params.app = filter.app
        params.entity = filter.entity
        // TODO: there seems to be a bug where if we don't
        // even if group count value is lower than the page
        // if we ask for sending the page size it actually
        // finds that many even though as per groups it had less than page size
        if (groups) {
          pageCount = groups[filter.app][filter.entity]
          params.page = page < pageCount ? page : pageCount
        }
      }

      navigate({
        to: "/search",
        search: (prev) => ({
          ...prev,
          query: encodeURIComponent(query),
          page,
          offset: newOffset,
          app: params.app,
          entity: params.entity,
          lastUpdated: params.lastUpdated,
        }),
        state: { isQueryTyped: QueryTyped },
        replace: true,
        resetScroll: false, // Prevent scroll jump on pagination
      })

      // Send a GET request to the backend with the search query
      const response = await api.search.$get({
        query: params,
      })
      if (response.ok) {
        const data: SearchResponse = await response.json()

        if (newOffset > 0) {
          setResults((prevResults) => [...prevResults, ...data.results])
        } else {
          setResults(data.results)
        }

        setAutocompleteResults([])
        // ensure even if autocomplete results came a little later we don't show right after we show
        // first set of results after a search
        // one short
        setTimeout(() => {
          setAutocompleteResults([])
        }, 300)
        // one long
        setTimeout(() => {
          setAutocompleteResults([])
        }, 1000)

        // updating querytyped state to false
        navigate({
          to: "/search",
          search: (prev: any) => ({
            ...prev,
          }),
          state: { isQueryTyped: false },
          replace: true,
          resetScroll: false
        })

        if (groupCount) {
          // TODO: temp solution until we resolve groupCount from
          // not always being true
          if (!filter.app && !filter.entity) {
            setSearchMeta({ totalCount: data.count })
          }
          setGroups(data.groupCount)
        }
      } else {
        const errorText = await response.text()
        if (!response.ok) {
          // If unauthorized or status code is 401, navigate to '/auth'
          if (response.status === 401) {
            navigate({ to: "/auth" })
            throw new Error("Unauthorized")
          }
        }
        throw new Error(
          `Failed to delete documents: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }
    } catch (error) {
      logger.error(error, `Error fetching search results:', ${error}`)
      setResults([]) // Clear results on error
    }
  }

  const handleNext = () => {
    const newOffset = offset + page
    setOffset(newOffset)
  }

  const handleFilterChange = (appEntity: Filter) => {
    // Check if appEntity.app and appEntity.entity are defined
    if (!appEntity.app || !appEntity.entity) {
      const updatedFilter: Filter = {
        lastUpdated: filter.lastUpdated || "anytime",
      }
      setFilter(updatedFilter)
      setOffset(0)
      return
    }

    const { app, entity } = appEntity

    if (filter.app === app && filter.entity === entity) {
      const updatedFilter: Filter = {
        lastUpdated: filter.lastUpdated || "anytime",
      }
      setFilter(updatedFilter)
      setOffset(0)
    } else {
      const updatedFilter: Filter = {
        app,
        entity,
        lastUpdated: filter.lastUpdated || "anytime",
      }
      setFilter(updatedFilter)
      setOffset(0)
    }
  }
  const totalCount = searchMeta?.totalCount || 0
  // if filter is selected we should keep it's count to prevent showing button for pagination
  const filterPageSize =
    filter.app && filter.entity
      ? groups
        ? groups[filter.app][filter.entity]
        : totalCount
      : totalCount

  return (
    <div className="h-full w-full flex">
      <Sidebar photoLink={user?.photoLink ?? ""} role={user?.role} />
      <div className={`flex flex-col flex-grow h-full "ml-[52px]"`}>
        <SearchBar
          ref={autocompleteRef}
          autocompleteResults={autocompleteResults}
          setQuery={setQuery}
          setAutocompleteResults={setAutocompleteResults}
          setAutocompleteQuery={setAutocompleteQuery}
          setOffset={setOffset}
          setFilter={setFilter}
          filter={filter}
          query={query}
          handleSearch={handleSearch}
          hasSearched={true}
          handleAnswer={handleAnswer}
          onLastUpdated={(value: LastUpdated) => {
            const updatedFilter = { ...filter, lastUpdated: value }
            setFilter(updatedFilter)
          }}
        />

        <div className="flex flex-row ml-[186px] h-full">
          <div className="flex flex-col w-full max-w-3xl border-r-[1px] border-[#E6EBF5]">
            {answer && answer.length > 0 && (
              <div className="flex mt-[24px]">
                <img
                  className="mr-[20px] w-[24px] h-[24px]"
                  src={answerSparkle}
                />
                <div className="flex-grow max-w-2xl">
                  <div
                    className={`relative transition-max-height duration-200 ease-in-out ${
                      !isExpanded ? "max-h-[200px] overflow-hidden" : ""
                    }`}
                  >
                    <MarkdownPreview
                      source={answer}
                      style={{
                        padding: 0,
                        backgroundColor: "#ffffff",
                        color: "#464B53",
                      }}
                    />
                    {/* Gradient overlay when not expanded */}
                    {!isExpanded && (
                      <div className="absolute bottom-0 left-0 w-full h-4 bg-gradient-to-t from-white to-transparent pointer-events-none"></div>
                    )}
                  </div>

                  {/* Toggle Buttons */}
                  <div className="flex flex-row mt-2">
                    <button
                      className="pl-5 pr-5 pb-2 pt-2 text-[16px] text-[#707F9F] rounded-full flex items-center bg-[#F0F4F7]"
                      onClick={() => setIsExpanded(!isExpanded)}
                    >
                      {!isExpanded ? (
                        <ChevronsUpDown size={16} stroke="#707F9F" />
                      ) : (
                        <ChevronsDownUp size={16} stroke="#707F9F" />
                      )}
                      {isExpanded ? (
                        <span className="ml-2">Show less</span>
                      ) : (
                        <span className="ml-2">Show more</span>
                      )}
                    </button>
                    <button
                      className="ml-3 pl-5 pr-5 pb-2 pt-2 text-[16px] text-[#707F9F] rounded-full flex items-center bg-[#F0F4F7]"
                      onClick={() => {
                        // Your code here
                      }}
                    >
                      <MessageSquareShare size={16} stroke="#707F9F" />
                      <span className="ml-3">Turn into Chat</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
            {!!results?.length && (
              <div className="flex flex-col w-full max-w-3xl mb-[52px]">
                <div className="w-full max-w-3xl">
                  {results.map((result, index) => (
                    <SearchResult
                      key={index}
                      result={result}
                      index={index}
                      showDebugInfo={showDebugInfo} // Pass state down
                    />
                  ))}
                </div>
              </div>
            )}

            {results.length > 0 &&
              filterPageSize > page &&
              results.length < filterPageSize && (
                <button
                  className="flex flex-row text-[#464B53] mr-[60px] items-center justify-center pb-[17px] mt-[auto] mb-[16px] pt-[17px] border-[1px] border-[#DDE3F0] rounded-[40px]"
                  onClick={handleNext}
                >
                  <ChevronDown
                    className="mr-[7px]"
                    size={18}
                    stroke="#464B53"
                  />
                  <span>More Results</span>
                </button>
              )}
          </div>
          {groups && (
            <GroupFilter
              groups={groups}
              handleFilterChange={handleFilterChange}
              filter={filter}
              total={totalCount}
            />
          )}
        </div>
      </div>
    </div>
  )
}

const searchParams = z
  .object({
    page: z.coerce.number().optional(),
    offset: z.coerce.number().optional(),
    query: z.string().optional(),
    app: z.nativeEnum(Apps).optional(),
    entity: z.string().optional(),
    lastUpdated: z.string().optional(),
  })
  .refine((data) => (data.app && data.entity) || (!data.app && !data.entity), {
    message: "app and entity must be provided together",
    path: ["app", "entity"],
  })

type XyneSearch = z.infer<typeof searchParams>

export const Route = createFileRoute("/_authenticated/search")({
  // component: Index,
  component: () => {
    const matches = useRouterState({ select: (s) => s.matches })
    const { user, workspace } = matches[matches.length - 1].context
    return <Search user={user} workspace={workspace} />
  },
  validateSearch: (search) => searchParams.parse(search),
  errorComponent: errorComponent,
})
