import { Search } from "lucide-react"
import { useRef, useEffect, forwardRef, useState } from "react"
import { SearchFilters } from "@/components/SearchFilter"
import { ArrowRight, X } from "lucide-react"
import { AutocompleteElement } from "@/components/Autocomplete"
import { useNavigate, useRouter } from "@tanstack/react-router"

export const SearchBar = forwardRef<HTMLDivElement, any>(
  (
    {
      autocompleteResults,
      setQuery,
      setAutocompleteResults,
      setAutocompleteQuery,
      setOffset,
      setFilter,
      query,
      handleSearch,
      handleAnswer,
      filter,
      onLastUpdated,
      hasSearched,
      setActiveQuery,
    },
    autocompleteRef,
  ) => {
    const inputRef = useRef<HTMLInputElement | null>(null)
    const navigate = useNavigate({ from: "/search" })
    const router = useRouter()
    const trimmedQuery = query.trim()
    const [highlightedIndex, setHighlightedIndex] = useState(-1)

    useEffect(() => {
      if (inputRef.current) {
        inputRef.current.focus()
      }
    }, [])

    useEffect(() => {
      setHighlightedIndex(-1)
    }, [autocompleteResults])

    const navigateToSearch = () => {
      if (hasSearched) setActiveQuery(query) // Update activeQuery
      const currentSearch = router.state.location.search as {
        embedded?: boolean
      }
      const isEmbedded = currentSearch?.embedded ?? false
      navigate({
        to: "/search",
        search: {
          query: encodeURIComponent(decodeURIComponent(query)),
          ...(isEmbedded ? { embedded: true } : {}),
        },
        state: { isQueryTyped: !!query.length },
      })
    }

    const queryFromResult = (result: any): string => {
      if (result.type === "file") return result.title
      if (result.type === "user_query") return result.query_text
      if (result.type === "kb_items") return result.title
      if (result.type === "mail") return result.subject
      if (result.type === "event") return result.name
      if (result.type === "mail_attachment") return result.filename
      return query
    }

    const selectSuggestion = (result: any) => {
      const nextQuery = queryFromResult(result)
      setQuery(nextQuery)
      setAutocompleteResults([])
      if (!nextQuery.trim()) return
      setOffset(0)
      if (hasSearched) setActiveQuery(nextQuery)
      const currentSearch = router.state.location.search as {
        embedded?: boolean
      }
      const isEmbedded = currentSearch?.embedded ?? false
      // Use router.navigate (no `from` constraint) so this works from any
      // route — `useNavigate({ from: "/search" })` would throw an invariant
      // when called from the home page.
      router.navigate({
        to: "/search",
        search: {
          query: encodeURIComponent(nextQuery),
          ...(isEmbedded ? { embedded: true } : {}),
        },
        state: { isQueryTyped: true },
      })
    }

    return (
      <div
        className={`flex flex-col bg-white dark:bg-[#1E1E1E] ${
          hasSearched
            ? "pt-[14px] pb-[14px] border-b-[1px] border-b-[#D3DAE0] dark:border-b-gray-700 justify-center sticky top-0 z-10"
            : ""
        }`}
      >
        <div
          className={`flex items-center w-full ${
            hasSearched ? "" : "flex-col max-w-3xl"
          }`}
        >
          <div
            className={`flex w-full items-center ${
              hasSearched ? "max-w-3xl ml-[186px]" : ""
            }`}
          >
            <div className="relative flex-grow">
              <div
                className={`flex w-full items-center bg-white dark:bg-[#1E1E1E] ${
                  autocompleteResults.length > 0
                    ? "rounded-t-[20px] border-b-0"
                    : "rounded-[20px]"
                } border dark:border-gray-700 h-[52px]`}
              >
                <Search
                  className="text-[#AEBAD3] dark:text-gray-500 ml-4 mr-2"
                  size={18}
                />
                <input
                  ref={inputRef}
                  placeholder="Search anything across apps..."
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setAutocompleteQuery(e.target.value)
                  }}
                  className="text-[#1C1D1F] dark:text-[#F1F3F4] flex-grow text-[15px] focus-visible:ring-0 placeholder-[#9AA0A6] dark:placeholder-gray-500 font-[450] leading-[24px] focus:outline-none bg-transparent dark:bg-transparent"
                  onKeyDown={(e) => {
                    const hasResults = autocompleteResults.length > 0
                    if (e.key === "ArrowDown" && hasResults) {
                      e.preventDefault()
                      setHighlightedIndex((i) =>
                        i < autocompleteResults.length - 1 ? i + 1 : 0,
                      )
                      return
                    }
                    if (e.key === "ArrowUp" && hasResults) {
                      e.preventDefault()
                      setHighlightedIndex((i) =>
                        i > 0 ? i - 1 : autocompleteResults.length - 1,
                      )
                      return
                    }
                    if (e.key === "Escape" && hasResults) {
                      setAutocompleteResults([])
                      return
                    }
                    if (e.key === "Enter") {
                      if (
                        hasResults &&
                        highlightedIndex >= 0 &&
                        highlightedIndex < autocompleteResults.length
                      ) {
                        e.preventDefault()
                        selectSuggestion(autocompleteResults[highlightedIndex])
                        return
                      }
                      if (trimmedQuery) {
                        setOffset(0)
                        handleSearch()
                        navigateToSearch()
                        setFilter((prevFilter: { lastUpdated?: string }) => ({
                          lastUpdated: prevFilter.lastUpdated || "anytime",
                        }))
                      }
                    }
                  }}
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("")
                      setAutocompleteResults([])
                      inputRef.current?.focus()
                    }}
                    className="flex mr-2 text-[#ACB8D1] dark:text-gray-500 hover:text-[#5D6878] dark:hover:text-gray-300 w-[28px] h-[28px] items-center justify-center"
                    aria-label="Clear search"
                  >
                    <X size={18} />
                  </button>
                )}
                {!hasSearched && (
                  <button
                    onClick={() => {
                      if (trimmedQuery) {
                        handleSearch()
                        navigateToSearch()
                      }
                    }}
                    className="flex mr-2 bg-[#464B53] dark:bg-slate-700 text-white dark:text-slate-200 hover:bg-[#5a5f66] dark:hover:bg-slate-600 rounded-[20px] w-[32px] h-[32px] items-center justify-center"
                  >
                    <ArrowRight
                      className="text-white dark:text-slate-200"
                      size={16}
                    />
                  </button>
                )}
                {!!autocompleteResults?.length && (
                  <div
                    ref={autocompleteRef}
                    className="absolute top-full w-full left-0 bg-white dark:bg-[#1E1E1E] rounded-b-[20px] border border-t-0 dark:border-gray-700 overflow-hidden"
                  >
                    {autocompleteResults.map((result: any, index: number) => (
                      <div
                        key={index}
                        onMouseEnter={() => setHighlightedIndex(index)}
                        className={
                          highlightedIndex === index
                            ? "bg-gray-100 dark:bg-gray-700"
                            : ""
                        }
                      >
                        <AutocompleteElement
                          onClick={() => selectSuggestion(result)}
                          result={result}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          {hasSearched && (
            <div className="text-[13px] ml-auto mr-4 shrink-0">
              <SearchFilters onLastUpdated={onLastUpdated} filter={filter} />
            </div>
          )}
        </div>
      </div>
    )
  },
)
