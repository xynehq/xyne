import { createFileRoute, useNavigate } from "@tanstack/react-router"

const page = 8

import { ArrowRight, Search } from "lucide-react"
import { Sidebar } from "@/components/Sidebar"

import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { api } from "@/api"
import {
  AnswerSSEEvents,
  Apps,
  Autocomplete,
  AutocompleteResults,
  AutocompleteResultsSchema,
  Entity,
  SearchResponse,
  SearchResultDiscriminatedUnion,
} from "shared/types"
import { Groups } from "@/types"
import { AutocompleteElement } from "@/components/Autocomplete"
import { getIcon } from "@/lib/common"
import { SearchResult } from "@/components/SearchResult"

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

const flattenGroups = (groups: Groups) => {
  return Object.keys(groups || {}).flatMap((app) =>
    Object.keys(groups[app as Apps] || {}).map((entity) => ({
      app: app as Apps,
      entity: entity as Entity,
      count: groups[app as Apps][entity as Entity],
    })),
  )
}

type Filter = {
  app: Apps
  entity: Entity
}

type SearchMeta = {
  totalCount: number
}

export const Index = () => {
  const [query, setQuery] = useState("") // State to hold the search query
  const [offset, setOffset] = useState(0)
  const [results, setResults] = useState<SearchResultDiscriminatedUnion[]>([]) // State to hold the search results
  const [groups, setGroups] = useState<Groups | null>(null)
  const [filter, setFilter] = useState<Filter | null>(null)
  const [searchMeta, setSearchMeta] = useState<SearchMeta | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [answer, setAnswer] = useState<string | null>(null)

  const navigate = useNavigate({ from: "/search" })

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
    if (query.length < 2) {
      setAutocompleteResults([])
      return
    }
    // Debounce logic
    if (debounceTimeout.current) {
      clearTimeout(debounceTimeout.current)
    }
    debounceTimeout.current = window.setTimeout(() => {
      ;(async () => {
        try {
          const response = await api.api.autocomplete.$post({
            json: {
              query: autocompleteQuery,
            },
          })
          let data: AutocompleteResults = await response.json()
          data = AutocompleteResultsSchema.parse(data)
          setAutocompleteResults(data.results)
        } catch (error) {
          logger.error(`Error fetching autocomplete results:', ${error}`)
        }
      })()
    }, 300) // 300ms debounce

    // Cleanup function to clear the timeout when component unmounts or new call starts
    return () => {
      if (debounceTimeout.current) {
        clearTimeout(debounceTimeout.current)
      }
    }
  }, [autocompleteQuery])

  const handleAnswer = async (newFilter = filter) => {
    if (!query) return // If the query is empty, do nothing

    setAnswer(null)

    const url = new URL(`/api/answer`, window.location.origin)
    if (newFilter) {
      url.searchParams.append("query", encodeURIComponent(query))
      url.searchParams.append("app", newFilter.app)
      url.searchParams.append("entity", newFilter.entity)
    } else {
      url.searchParams.append("query", encodeURIComponent(query))
    }

    const eventSource = new EventSource(url.toString(), {
      withCredentials: true,
    })

    eventSource.addEventListener(AnswerSSEEvents.AnswerUpdate, (event) => {
      const chunk = event.data
      setAnswer((prevAnswer) => (prevAnswer ? prevAnswer + chunk : chunk))
    })

    eventSource.addEventListener(AnswerSSEEvents.Start, (event) => {
      // Handle start event if needed
    })

    eventSource.addEventListener(AnswerSSEEvents.End, (event) => {
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

  const handleSearch = async (newOffset = offset, newFilter = filter) => {
    if (!query) return // If the query is empty, do nothing

    // setAutocompleteResults([])
    try {
      let params = {}
      let groupCount
      if (newFilter && groups) {
        groupCount = false
        let pageSize =
          page > groups[newFilter.app][newFilter.entity]
            ? groups[newFilter.app][newFilter.entity]
            : page
        params = {
          page: pageSize,
          offset: newOffset,
          query: encodeURIComponent(query),
          groupCount,
          app: newFilter.app,
          entity: newFilter.entity,
        }
        navigate({
          to: "/search",
          search: (prev) => ({
            ...prev,
            query: encodeURIComponent(query),
            page: pageSize,
            offset: newOffset,
            app: newFilter.app,
            entity: newFilter.entity,
          }),
          replace: true,
        })
      } else {
        groupCount = true
        params = {
          page: page,
          offset: newOffset,
          query: encodeURIComponent(query),
          groupCount,
        }
        navigate({
          to: "/search",
          search: (prev) => ({
            ...prev,
            query: query,
            page: page,
            offset: newOffset,
          }),
          replace: true,
        })
      }

      // Send a GET request to the backend with the search query
      const response = await api.api.search.$get({
        query: params,
      })
      if (response.ok) {
        const data: SearchResponse = await response.json()

        setResults(data.results)
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

        if (groupCount) {
          setSearchMeta({ totalCount: data.count })
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
      logger.error(`Error fetching search results:', ${error}`)
      setResults([]) // Clear results on error
    }
  }

  const handleNext = () => {
    const newOffset = offset + page
    setOffset(newOffset)
    handleSearch(newOffset) // Trigger search with the updated offset
  }

  const goToPage = (pageNumber: number) => {
    const newOffset = pageNumber * page
    setOffset(newOffset)
    handleSearch(newOffset) // Trigger search with the updated offset
  }

  const handlePrev = () => {
    const newOffset = Math.max(0, offset - page)
    setOffset(newOffset)
    handleSearch(newOffset) // Trigger search with the updated offset
  }

  const handleFilterChange = (appEntity: Filter | null) => {
    setPageNumber(0)
    if (!appEntity) {
      setFilter(null)
      setOffset(0)
      handleSearch(0, null)
      return
    }
    const { app, entity } = appEntity
    if (filter && filter.app === app && filter.entity === entity) {
      setFilter(null)
      setOffset(0)
      handleSearch(0, null)
    } else {
      setFilter({ app, entity })
      setOffset(0)
      handleSearch(0, { app, entity })
    }
  }

  return (
    <div className="h-screen w-full flex">
      <Sidebar />
      <div className="p-4 flex flex-grow h-full items-center justify-center">
        <div className="flex flex-col items-center w-full max-w-4xl mb-[300px]">
          <div className="flex space-x-2 w-full items-center justify-center">
            <div className="relative w-full">
              <div
                className={`flex items-center w-full bg-white ${autocompleteResults.length > 0 ? "rounded-t-lg border-b-0" : "rounded-full"} border border-[#AEBAD3] h-[52px] shadow-sm`}
              >
                <Search className="text-[#AEBAD3] ml-4 mr-2" size={18} />
                <input
                  placeholder="Search workspace"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setAutocompleteQuery(e.target.value)
                    setOffset(0)
                  }}
                  className="w-full border- focus-visible:ring-0 placeholder-[#BDC6D8] font-[450] text-[16px] leading-[24px] focus:outline-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleSearch()
                      handleAnswer()
                    }
                  }}
                />
                <Button
                  onClick={(e) => handleSearch()}
                  className="mr-2 bg-[#464B53] text-white p-2 hover:bg-[#5a5f66] rounded-full"
                >
                  <ArrowRight className="text-white" size={20} />
                </Button>
                {!!autocompleteResults?.length && (
                  <div
                    ref={autocompleteRef}
                    className="absolute top-full left-0 w-full bg-white rounded-b-lg border border-t-0 border-[#AEBAD3] shadow-md"
                  >
                    {autocompleteResults.map((result, index) => (
                      <AutocompleteElement
                        key={index}
                        onClick={() => {
                          if (result.type === "file") {
                            setQuery(result.title)
                          }
                          setAutocompleteResults([])
                        }}
                        result={result}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        {answer && (
          <div className="mt-4 p-4 bg-gray-100 border border-gray-200 rounded-lg">
            <h2 className="text-lg font-semibold">Answer</h2>
            <p>{answer}</p>
          </div>
        )}

        {!!results?.length && (
          <div className="flex flex-row">
            <div className="mt-4 w-full pr-10 space-y-3">
              {results?.length > 0 ? (
                results.map((result, index) => (
                  <SearchResult result={result} index={index} />
                ))
              ) : (
                <p></p>
              )}
            </div>
            {groups && (
              <div className="bg-slate-100 rounded-md mt-4 mr-20 max-h-fit h-fit border border-gray-100">
                <div
                  onClick={(e) => {
                    handleFilterChange(null)
                  }}
                  className={`${filter == null ? "bg-white" : ""} flex flex-row items-center justify-between cursor-pointer hover:bg-white p-3 pr-5`}
                >
                  <div className="flex items-center">
                    <p>All</p>
                  </div>
                  {searchMeta && (
                    <p className="text-blue-500 ml-7">
                      {searchMeta.totalCount}
                    </p>
                  )}
                </div>
                {flattenGroups(groups).map(({ app, entity, count }, index) => {
                  return (
                    <div
                      key={index}
                      onClick={(e) => {
                        handleFilterChange({ app, entity })
                      }}
                      className={`${filter && filter.app === app && filter.entity === entity ? "bg-white" : ""} flex flex-row items-center justify-between cursor-pointer hover:bg-white p-3 pr-5`}
                    >
                      <div className="flex items-center">
                        {getIcon(app, entity)}
                        <p>{entity}</p>
                      </div>
                      <p className="text-blue-500 ml-7">
                        {groups[app][entity]}
                      </p>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
        {/* <div className="mt-auto flex space-x-2 items-center justify-center w-full">
          {offset > 0 && (
            <Button
              className="bg-transparent border border-gray-100 text-black hover:bg-gray-100 shadow-none"
              onClick={(e) => {
                handlePrev()
                setPageNumber((prev) => prev - 1)
              }}
            >
              <ChevronLeft />
            </Button>

          {searchMeta && (
            <div className="flex space-x-2 items-center">
              {Array(
                Math.round(
                  (filter && groups
                    ? groups[filter.app][filter.entity]
                    : searchMeta.totalCount) / page,
                ) || 1,
              )
                .fill(0)
                .map((count, index) => {
                  return (
                    <p
                      key={index}
                      className={`cursor-pointer hover:text-sky-700 ${index + 1 === pageNumber ? "text-blue-500" : "text-gray-700"}`}
                      onClick={(e) => {
                        goToPage(index)
                        setPageNumber(index + 1)
                      }}
                    >
                      {index + 1}
                    </p>
                  )
                })}
            </div>
          {searchMeta &&
            results?.length > 0 &&
            pageNumber * page < searchMeta.totalCount && (
              <Button
                className="bg-transparent border border-gray-100 text-black hover:bg-gray-100 shadow-none"
                onClick={(e) => {
                  handleNext()
                  setPageNumber((prev) => prev + 1)
                }}
              >
                <ChevronRight />
              </Button>
            )} */}

        {/* </div>
        )} */}
      </div>
    </div>
  )
}

export const Route = createFileRoute("/_authenticated/")({
  component: Index,
})
