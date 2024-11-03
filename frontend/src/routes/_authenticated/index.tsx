import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router"
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

export const Index = () => {
  let search: XyneSearch = useSearch({
    from: "/_authenticated",
  })
  const [query, setQuery] = useState(search.query || "") // State to hold the search query
  const [offset, setOffset] = useState(0)
  const [results, setResults] = useState<SearchResultDiscriminatedUnion[]>([]) // State to hold the search results
  const [groups, setGroups] = useState<Groups | null>(null)
  const [filter, setFilter] = useState<Filter | null>(null)
  const [searchMeta, setSearchMeta] = useState<SearchMeta | null>(null)
  const [_, setPageNumber] = useState(1)
  const [answer, setAnswer] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState<boolean>(false)

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

  useEffect(() => {
    if (search && search.query) {
      const decodedQuery = decodeURIComponent(search.query)
      setQuery(decodedQuery)
      handleSearch(0, filter)
    }
  }, [])

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

  const handleSearch = async (newOffset = offset, newFilter: Filter | null) => {
    if (!query) return // If the query is empty, do nothing
    setHasSearched(true)

    setAutocompleteResults([])
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

        // we went directly via the url hence
        // groups does not exist
      } else if (filter && !groups) {
        groupCount = true
        params = {
          page: page,
          offset: newOffset,
          query: encodeURIComponent(query),
          groupCount,
          app: filter.app,
          entity: filter.entity,
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
      const response = await api.search.$get({
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

  // const handleNext = () => {
  //   const newOffset = offset + page
  //   setOffset(newOffset)
  //   handleSearch(newOffset) // Trigger search with the updated offset
  // }

  // const goToPage = (pageNumber: number) => {
  //   const newOffset = pageNumber * page
  //   setOffset(newOffset)
  //   handleSearch(newOffset) // Trigger search with the updated offset
  // }

  // const handlePrev = () => {
  //   const newOffset = Math.max(0, offset - page)
  //   setOffset(newOffset)
  //   handleSearch(newOffset) // Trigger search with the updated offset
  // }

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
    <div className="h-full w-full flex">
      <Sidebar />
      <div
        className={`flex flex-col flex-grow h-full ${hasSearched ? "ml-[52px]" : "justify-center"}`}
      >
        <SearchBar
          ref={autocompleteRef}
          hasSearched={hasSearched}
          autocompleteResults={autocompleteResults}
          setQuery={setQuery}
          setAutocompleteResults={setAutocompleteResults}
          setAutocompleteQuery={setAutocompleteQuery}
          setOffset={setOffset}
          setFilter={setFilter}
          query={query}
          handleSearch={handleSearch}
          handleAnswer={handleAnswer}
        />

        {hasSearched && (
          <div className="h-full flex flex-row ml-[186px]">
            <div className="h-full flex flex-col w-full max-w-3xl">
              {answer && answer.length > 0 && (
                <div className="flex-grow flex mt-[24px] max-h-[242px]">
                  <img
                    className="mr-[20px] w-[24px] h-[24px]"
                    src={answerSparkle}
                  />
                  <div className="flex-grow overflow-hidden text-ellipsis whitespace-nowrap max-w-2xl">
                    <MarkdownPreview
                      source={answer}
                      style={{
                        padding: 0,
                        backgroundColor: "#ffffff",
                        color: "#464B53",
                      }}
                    />
                  </div>
                </div>
              )}
              {!!results?.length && (
                <div className="flex flex-row h-full w-full max-w-3xl border-r-[1px] border-[#E6EBF5] ">
                  <div className="w-full max-w-3xl">
                    {results?.length > 0 ? (
                      results.map((result, index) => (
                        <SearchResult result={result} index={index} />
                      ))
                    ) : (
                      <p></p>
                    )}
                  </div>
                </div>
              )}
            </div>
            {groups && (
              <GroupFilter
                groups={groups}
                handleFilterChange={handleFilterChange}
                filter={filter}
                total={searchMeta?.totalCount!}
              />
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

const searchParams = z.object({
  page: z.number().optional(),
  offset: z.number().optional(),
  query: z.string().optional(),
  app: z.nativeEnum(Apps).optional(),
  entity: z.string().optional(),
})

type XyneSearch = z.infer<typeof searchParams>

export const Route = createFileRoute("/_authenticated/")({
  component: Index,
  validateSearch: (search) => searchParams.parse(search),
})
