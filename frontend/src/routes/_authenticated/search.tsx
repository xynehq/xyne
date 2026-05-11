import {
  createFileRoute,
  useNavigate,
  useRouterState,
  useSearch,
} from "@tanstack/react-router"
import MarkdownPreview from "@uiw/react-markdown-preview"

const page = 8

import { Sidebar } from "@/components/Sidebar"
import { useTheme } from "@/components/ThemeContext"

import { useCallback, useEffect, useRef, useState } from "react"

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
import type { Citation } from "shared/types"
import { Filter, Groups } from "@/types"
import CitationPreview from "@/components/CitationPreview"
import { SearchResult } from "@/components/SearchResult"
import answerSparkle from "@/assets/answerSparkle.svg"
import { SearchBar } from "@/components/SearchBar"
import { Button } from "@/components/ui/button"
import { z } from "zod"
import {
  ChevronsDownUp,
  ChevronsUpDown,
  MessageSquareShare,
} from "lucide-react"
import { LastUpdated } from "@/components/SearchFilter"
import { PublicUser, PublicWorkspace } from "shared/types"
import { errorComponent } from "@/components/error"
import { LoaderContent } from "@/lib/common"
import { createAuthEventSource } from "@/hooks/useChatStream"
import {
  DocumentOperationsProvider,
  useDocumentOperations,
} from "@/contexts/DocumentOperationsContext"

const logger = console

/** Sum all counts in groups so "All" matches the sum of filter items. */
function sumGroupCounts(groups: Groups | null | undefined): number {
  if (!groups || typeof groups !== "object") return 0
  let sum = 0
  for (const app of Object.keys(groups)) {
    const entityCounts = groups[app as keyof Groups]
    if (!entityCounts || typeof entityCounts !== "object") continue
    for (const entity of Object.keys(entityCounts)) {
      sum += entityCounts[entity as keyof typeof entityCounts] ?? 0
    }
  }
  return sum
}

export function SearchInfo({ info }: { info: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            className="p-0 m-0 rounded-full h-[20px] w-[20px] text-xs text-gray-500 dark:text-gray-400"
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
  agentWhiteList: boolean
}

export const Search = ({ user, workspace, agentWhiteList }: IndexProps) => {
  const { theme } = useTheme()
  let search: XyneSearch = useSearch({
    from: "/_authenticated/search",
  })
  const isEmbedded = search.embedded ?? false
  const navigate = useNavigate({ from: "/search" })
  if (!search.query) {
    navigate({
      to: "/",
    })
  }
  // TODO: debug the react warning
  // Cannot update a component (`MatchesInner`)
  const QueryTyped = useRouterState({
    select: (s) => s.location.state.isQueryTyped,
  })

  const [searchTab, setSearchTab] = useState<"all" | "apps" | "kb">("all")
  const [appsCount, setAppsCount] = useState(0)
  const [kbCount, setKbCount] = useState(0)
  const [query, setQuery] = useState(decodeURIComponent(search.query || "")) // State to hold the search query
  const [offset, setOffset] = useState(0)
  const [results, setResults] = useState<SearchResultDiscriminatedUnion[]>([]) // State to hold the search results
  const [activeQuery, setActiveQuery] = useState(
    decodeURIComponent(search.query || ""),
  ) // For confirmed searches
  const [groups, setGroups] = useState<Groups | null>(null)
  const [filter, setFilter] = useState<Filter>({
    lastUpdated: (search.lastUpdated as LastUpdated) || "anytime",
  })
  const [searchMeta, setSearchMeta] = useState<SearchMeta | null>(null)
  const [answer, setAnswer] = useState<string | null>(null)
  const [isExpanded, setIsExpanded] = useState<boolean>(false)
  const [showDebugInfo, setDebugInfo] = useState(
    import.meta.env.VITE_SHOW_DEBUG_INFO === "true" || (search.debug ?? false),
  ) // State for debug info visibility, initialized from env var
  const [traceData, setTraceData] = useState<any | null>(null) // State for trace data
  const [previewCitation, setPreviewCitation] = useState<Citation | null>(null)
  const [previewChunkIndex, setPreviewChunkIndex] = useState<number | null>(
    null,
  )
  const [previewPageIndex, setPreviewPageIndex] = useState<number | null>(null)
  const { documentOperationsRef } = useDocumentOperations()
  const prefetchedChunkRef = useRef<{
    docId: string
    chunkIndex: number
    chunkContent: string
    pageIndex: number
  } | null>(null)
  // close autocomplete if clicked outside
  const autocompleteRef = useRef<HTMLDivElement | null>(null)
  const [autocompleteQuery, setAutocompleteQuery] = useState("")

  const totalCount = searchMeta?.totalCount || 0
  const filterPageSize =
    filter.app && filter.entity
      ? groups
        ? groups[filter.app][filter.entity]
        : totalCount
      : totalCount

  // Added for infinite scroll functionality
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const handleNext = useCallback(() => {
    setOffset((prev) => prev + page)
  }, [])

  const loadingRef = useRef(false)

  const tabJustSwitchedRef = useRef(false)
  const requestIdRef = useRef(0)
  const handleTabChange = (tab: "all" | "apps" | "kb") => {
    tabJustSwitchedRef.current = true
    setSearchTab(tab)
    setOffset(0)
    setResults([])
    setGroups(null)
    setSearchMeta(null)
    if (activeQuery) handleSearch(0, tab)
  }

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

  // Intersection observer for infinite scroll
  useEffect(() => {
    if (!bottomRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries
        if (
          entry.isIntersecting &&
          results.length > 0 &&
          filterPageSize > page &&
          results.length < filterPageSize &&
          !loadingRef.current
        ) {
          loadingRef.current = true
          setIsLoading(true)
          handleNext()
        }
      },
      { threshold: 0.5 }, // Trigger when 50% of the element is visible
    )

    observer.observe(bottomRef.current)

    return () => {
      if (bottomRef.current) {
        observer.unobserve(bottomRef.current)
      }
    }
  }, [results, filterPageSize, page, handleNext])

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
      if (decodedQuery !== activeQuery) {
        setActiveQuery(decodedQuery)
        setOffset(0)
        setResults([])
      }
      setDebugInfo(
        import.meta.env.VITE_SHOW_DEBUG_INFO === "true" ||
          search.debug ||
          false,
      )
    }
  }, [search])

  useEffect(() => {
    if (activeQuery) {
      handleSearch(0)
    }
  }, [activeQuery])

  useEffect(() => {
    if (tabJustSwitchedRef.current) {
      tabJustSwitchedRef.current = false
      return
    }
    handleSearch()
  }, [offset])

  useEffect(() => {
    setOffset(0)
    handleSearch()
  }, [filter])

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

    let eventSource: EventSource
    try {
      eventSource = await createAuthEventSource(url.toString())
    } catch (err) {
      console.error("Failed to create EventSource:", err)
      return
    }

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

  const handleSearch = async (
    newOffset = offset,
    tabOverride?: "all" | "apps" | "kb",
  ) => {
    if (!activeQuery) return
    setAutocompleteResults([])
    const effectiveTab = tabOverride ?? searchTab

    // Increment request ID to track this specific search request
    requestIdRef.current += 1
    const currentRequestId = requestIdRef.current

    try {
      // TODO: figure out when lastUpdated changes and only
      // then make it true or when app,entity is not present
      const groupCount = true
      let params: any = {
        page: page,
        offset: newOffset,
        query: encodeURIComponent(activeQuery),
        groupCount,
        lastUpdated: filter.lastUpdated || "anytime",
        isQueryTyped: QueryTyped,
        debug: showDebugInfo,
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
          query: encodeURIComponent(activeQuery),
          page,
          offset: newOffset,
          app: params.app,
          entity: params.entity,
          lastUpdated: params.lastUpdated,
          ...(showDebugInfo ? { debug: showDebugInfo } : {}),
        }),
        state: { isQueryTyped: QueryTyped },
        replace: true,
        resetScroll: false,
      })

      // Always fan-out: fetch both apps (/search) and KB (/search/knowledge-base)
      // in parallel so we know counts for both tabs even when a specific tab is
      // selected. Render results based on the active tab (merged for "all").
      const [appsResp, kbResp] = await Promise.all([
        api.search.$get({ query: params }),
        api.search["knowledge-base"].$get({
          query: {
            query: params.query,
            page: String(params.page ?? page),
            offset: String(newOffset),
            lastUpdated: params.lastUpdated,
          },
        }),
      ])

      // Only update state if this is still the most recent request
      if (currentRequestId !== requestIdRef.current) {
        return
      }

      // Handle 401 from either endpoint
      if (appsResp.status === 401 || kbResp.status === 401) {
        navigate({ to: "/auth" })
        throw new Error("Unauthorized")
      }

      const appsData: SearchResponse = appsResp.ok
        ? await appsResp.json()
        : { results: [], count: 0, groupCount: undefined }
      const kbData: SearchResponse = kbResp.ok
        ? await kbResp.json()
        : { results: [], count: 0, groupCount: undefined }

      const appsResults = appsData.results ?? []
      const kbResults = kbData.results ?? []

      // Sum group counts for apps (covers the apps-side total),
      // KB count comes directly from kbData.count.
      const appsTotal =
        sumGroupCounts(appsData.groupCount) > 0
          ? sumGroupCounts(appsData.groupCount)
          : (appsData.count ?? 0)
      const kbTotal = kbData.count ?? 0
      setAppsCount(appsTotal)
      setKbCount(kbTotal)

      // Pick which results to render based on the selected tab.
      // For "all", merge by relevance score (descending). When score is missing,
      // preserve apps-first ordering — both APIs return Vespa-sorted lists.
      let newResults: SearchResultDiscriminatedUnion[]
      let activeTotal: number
      if (effectiveTab === "kb") {
        newResults = kbResults
        activeTotal = kbTotal
      } else if (effectiveTab === "apps") {
        newResults = appsResults
        activeTotal = appsTotal
      } else {
        const merged = [...appsResults, ...kbResults]
        const hasScore = merged.some(
          (r) => typeof (r as { relevance?: number }).relevance === "number",
        )
        if (hasScore) {
          merged.sort((a, b) => {
            const ar = (a as { relevance?: number }).relevance ?? 0
            const br = (b as { relevance?: number }).relevance ?? 0
            return br - ar
          })
        }
        newResults = merged
        activeTotal = appsTotal + kbTotal
      }

      if (newOffset > 0) {
        setResults((prev) => [...prev, ...newResults])
      } else {
        setResults(newResults)
      }

      setAutocompleteResults([])

      navigate({
        to: "/search",
        search: (prev: any) => ({ ...prev }),
        state: { isQueryTyped: false },
        replace: true,
        resetScroll: false,
      })

      // Group sidebar is driven by apps-side groupCount; KB has no app/entity facets.
      setGroups(appsData.groupCount ?? null)
      setSearchMeta({ totalCount: activeTotal })
      setTraceData(appsData.trace ?? kbData.trace ?? null)
      loadingRef.current = false
      setIsLoading(false)
    } catch (error) {
      logger.error(error, `Error fetching search results:', ${error}`)
      setResults([]) // Clear results on error
      loadingRef.current = false
      setIsLoading(false) // Reset loading state on error
    }
  }

  const handleKbFileClick = useCallback(
    async (result: SearchResultDiscriminatedUnion) => {
      if (result.type !== "kb_items") return
      const kb = result as {
        docId: string
        fileName?: string
        clId?: string
        itemId?: string
        entity?: string
        chunks_summary?: Array<
          { chunk: string; index: number; score: number } | string
        >
      }
      if (!kb.clId || !kb.itemId) return
      const citation: Citation = {
        docId: kb.docId,
        title: kb.fileName ?? kb.docId,
        app: Apps.KnowledgeBase,
        entity: (kb.entity as Citation["entity"]) ?? "file",
        clId: kb.clId,
        itemId: kb.itemId,
      }
      setPreviewCitation(citation)
      prefetchedChunkRef.current = null
      const firstChunk = kb.chunks_summary?.[0]
      const chunkIndex =
        typeof firstChunk === "object" &&
        firstChunk !== null &&
        "index" in firstChunk
          ? (firstChunk as { index: number }).index
          : null
      setPreviewChunkIndex(chunkIndex)
      if (chunkIndex != null && kb.docId) {
        try {
          const res = await api.chunk[":cId"].files[":docId"].content.$get({
            param: { cId: String(chunkIndex), docId: kb.docId },
          })
          if (res.ok) {
            const data = await res.json()
            const chunkContent = data?.chunkContent ?? ""
            const pageIndex =
              typeof data?.pageIndex === "number" ? data.pageIndex : -1
            prefetchedChunkRef.current = {
              docId: kb.docId,
              chunkIndex,
              chunkContent,
              pageIndex,
            }
            setPreviewPageIndex(pageIndex >= 0 ? pageIndex : null)
          } else {
            setPreviewPageIndex(null)
          }
        } catch {
          setPreviewPageIndex(null)
        }
      } else {
        setPreviewChunkIndex(null)
        setPreviewPageIndex(null)
      }
    },
    [],
  )

  const handleCitationPreviewDocumentLoaded = useCallback(() => {
    const citation = previewCitation
    const chunkIndex = previewChunkIndex
    if (
      chunkIndex == null ||
      !citation?.docId ||
      !documentOperationsRef?.current
    )
      return
    const prefetched = prefetchedChunkRef.current
    if (
      prefetched &&
      prefetched.docId === citation.docId &&
      prefetched.chunkIndex === chunkIndex
    ) {
      documentOperationsRef.current.clearHighlights?.()
      documentOperationsRef.current
        .highlightText?.(
          prefetched.chunkContent,
          chunkIndex,
          prefetched.pageIndex >= 0 ? prefetched.pageIndex : undefined,
          true,
        )
        .catch((err) => logger.error("Highlight failed", err))
      prefetchedChunkRef.current = null
    }
  }, [previewCitation, previewChunkIndex, documentOperationsRef])

  const handleCloseCitationPreview = useCallback(() => {
    setPreviewCitation(null)
    setPreviewChunkIndex(null)
    setPreviewPageIndex(null)
    prefetchedChunkRef.current = null
  }, [])

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
  // if filter is selected we should keep it's count to prevent showing button for pagination

  return (
    <div className="h-full w-full flex dark:bg-[#1E1E1E]">
      <Sidebar
        photoLink={user?.photoLink ?? ""}
        role={user?.role}
        isAgentMode={agentWhiteList}
        isEmbedded={isEmbedded}
      />
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
          setActiveQuery={setActiveQuery}
          onLastUpdated={(value: LastUpdated) => {
            const updatedFilter = { ...filter, lastUpdated: value }
            setFilter(updatedFilter)
          }}
        />

        <div className="flex flex-row ml-[186px] h-full">
          <div className="flex flex-col w-full max-w-3xl border-r-[1px] border-[#E6EBF5] dark:border-gray-700">
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
                      wrapperElement={{
                        "data-color-mode": theme,
                      }}
                      style={{
                        padding: 0,
                        backgroundColor:
                          theme === "dark" ? "#1F2937" : "#ffffff",
                        color: theme === "dark" ? "#E5E7EB" : "#464B53",
                      }}
                    />
                    {/* Gradient overlay when not expanded */}
                    {!isExpanded && (
                      <div className="absolute bottom-0 left-0 w-full h-4 bg-gradient-to-t from-white dark:from-slate-800 to-transparent pointer-events-none"></div>
                    )}
                  </div>

                  {/* Toggle Buttons */}
                  <div className="flex flex-row mt-2">
                    <button
                      className="pl-5 pr-5 pb-2 pt-2 text-[16px] text-[#707F9F] dark:text-gray-300 rounded-full flex items-center bg-[#F0F4F7] dark:bg-slate-700"
                      onClick={() => setIsExpanded(!isExpanded)}
                    >
                      {!isExpanded ? (
                        <ChevronsUpDown
                          size={16}
                          stroke="#707F9F"
                          className="dark:stroke-gray-300"
                        />
                      ) : (
                        <ChevronsDownUp
                          size={16}
                          stroke="#707F9F"
                          className="dark:stroke-gray-300"
                        />
                      )}
                      {isExpanded ? (
                        <span className="ml-2">Show less</span>
                      ) : (
                        <span className="ml-2">Show more</span>
                      )}
                    </button>
                    <button
                      className="ml-3 pl-5 pr-5 pb-2 pt-2 text-[16px] text-[#707F9F] dark:text-gray-300 rounded-full flex items-center bg-[#F0F4F7] dark:bg-slate-700"
                      onClick={() => {
                        // Your code here
                      }}
                    >
                      <MessageSquareShare
                        size={16}
                        stroke="#707F9F"
                        className="dark:stroke-gray-300"
                      />
                      <span className="ml-3">Turn into Chat</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
            {/* Top-level Trace Info Display */}
            {showDebugInfo && traceData && (
              <details className="mt-4 mb-4 text-xs">
                <summary className="text-gray-500 dark:text-gray-400 cursor-pointer">
                  Vespa Trace
                </summary>
                <pre className="text-xs bg-gray-100 dark:bg-slate-800 dark:text-gray-300 p-2 rounded overflow-auto max-h-96">
                  {" "}
                  {/* Increased max-height */}
                  {JSON.stringify(traceData, null, 2)}
                </pre>
              </details>
            )}
            {!!results?.length && (
              <div className="flex flex-col w-full max-w-3xl mb-[52px]">
                <div className="w-full max-w-3xl">
                  {results.map((result, index) => (
                    <SearchResult
                      key={index}
                      result={result}
                      index={index}
                      showDebugInfo={showDebugInfo}
                      onKbFileClick={handleKbFileClick}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Infinite scroll loading indicator and bottom reference */}
            {results.length > 0 && (
              <div ref={bottomRef} className="py-4 flex justify-center">
                {isLoading &&
                filterPageSize > page &&
                results.length < filterPageSize ? (
                  <LoaderContent />
                ) : null}
              </div>
            )}
          </div>
          {(groups || activeQuery) && (
            <div className="flex flex-col">
              {/* Source filter rows live in the right-pane list.
                  Each row mirrors the GroupFilterItem style (icon-less, since
                  these are aggregate sources). Rows only appear when their
                  side has results, and clicking a row swaps the active tab. */}
              {activeQuery && (appsCount > 0 || kbCount > 0) && (
                <div className="flex flex-col mt-[24px]">
                  <p className="text-[11.5px] font-medium text-[#97A6C4] dark:text-slate-400 ml-[40px] tracking-[0.08em]">
                    SOURCES
                  </p>
                  <div
                    className="rounded-md h-[32px] ml-[40px] mt-2"
                    onClick={() => handleTabChange("all")}
                  >
                    <div
                      className={`${
                        searchTab === "all"
                          ? "bg-[#F0F4F7] dark:bg-slate-700"
                          : ""
                      } flex flex-row rounded-[6px] items-center justify-between cursor-pointer pl-[12px] pr-[12px] pt-[4px] pb-[4px] w-[248px]`}
                    >
                      <p className="text-[#5D6878] dark:text-slate-300 text-[13px] font-medium">
                        All Results
                      </p>
                      <p className="text-[#97A6C4] dark:text-slate-400 ml-7">
                        {appsCount + kbCount}
                      </p>
                    </div>
                  </div>
                  {appsCount > 0 && (
                    <div
                      className="rounded-md h-[32px] ml-[40px]"
                      onClick={() => handleTabChange("apps")}
                    >
                      <div
                        className={`${
                          searchTab === "apps"
                            ? "bg-[#F0F4F7] dark:bg-slate-700"
                            : ""
                        } flex flex-row rounded-[6px] items-center justify-between cursor-pointer pl-[12px] pr-[12px] pt-[4px] pb-[4px] w-[248px]`}
                      >
                        <p className="text-[#5D6878] dark:text-slate-300 text-[13px] font-medium">
                          Apps & Mail
                        </p>
                        <p className="text-[#97A6C4] dark:text-slate-400 ml-7">
                          {appsCount}
                        </p>
                      </div>
                    </div>
                  )}
                  {kbCount > 0 && (
                    <div
                      className="rounded-md h-[32px] ml-[40px]"
                      onClick={() => handleTabChange("kb")}
                    >
                      <div
                        className={`${
                          searchTab === "kb"
                            ? "bg-[#F0F4F7] dark:bg-slate-700"
                            : ""
                        } flex flex-row rounded-[6px] items-center justify-between cursor-pointer pl-[12px] pr-[12px] pt-[4px] pb-[4px] w-[248px]`}
                      >
                        <p className="text-[#5D6878] dark:text-slate-300 text-[13px] font-medium">
                          Knowledge Base
                        </p>
                        <p className="text-[#97A6C4] dark:text-slate-400 ml-7">
                          {kbCount}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <CitationPreview
        citation={previewCitation}
        isOpen={!!previewCitation}
        onClose={handleCloseCitationPreview}
        documentOperationsRef={documentOperationsRef}
        onDocumentLoaded={handleCitationPreviewDocumentLoaded}
        initialPageIndex={previewPageIndex}
      />
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
    debug: z.boolean().optional(),
    embedded: z.coerce.boolean().optional(),
  })
  .refine((data) => (data.app && data.entity) || (!data.app && !data.entity), {
    message: "app and entity must be provided together",
    path: ["app", "entity"],
  })

type XyneSearch = z.infer<typeof searchParams>

export const Route = createFileRoute("/_authenticated/search")({
  component: () => {
    const matches = useRouterState({ select: (s) => s.matches })
    const { user, workspace, agentWhiteList } =
      matches[matches.length - 1].context
    return (
      <DocumentOperationsProvider>
        <Search
          user={user}
          workspace={workspace}
          agentWhiteList={agentWhiteList}
        />
      </DocumentOperationsProvider>
    )
  },
  validateSearch: (search) => searchParams.parse(search),
  errorComponent: errorComponent,
})
