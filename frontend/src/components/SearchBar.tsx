import { Search } from "lucide-react"
import { useRef, useEffect, forwardRef } from "react"
import { SearchFilters } from "@/components/SearchFilter"
import { ArrowRight, X } from "lucide-react" // Assuming ArrowRight and X are imported from lucide-react
import { AutocompleteElement } from "@/components/Autocomplete"
import { useNavigate } from "@tanstack/react-router"

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
    const trimmedQuery = query.trim()

    useEffect(() => {
      if (inputRef.current) {
        inputRef.current.focus()
      }
    }, [])

    const navigateToSearch = () => {
      if (hasSearched) setActiveQuery(query) // Update activeQuery
      navigate({
        to: "/search",
        search: {
          query: encodeURIComponent(decodeURIComponent(query)),
        },
        state: { isQueryTyped: !!query.length },
      })
    }

    return (
      <div
        className={`flex flex-col bg-white dark:bg-[#1E1E1E] ${
          hasSearched
            ? "pt-[12px] border-b-[1px] border-b-[#D3DAE0] dark:border-b-gray-700 justify-center sticky top-0 z-10"
            : ""
        }`}
      >
        <div
          className={`flex flex-col max-w-3xl ${
            hasSearched ? "ml-[186px]" : ""
          } w-full`}
        >
          <div className="flex w-full">
            <div className="relative w-full">
              <div
                className={`flex w-full items-center ${
                  hasSearched
                    ? "bg-transparent dark:bg-transparent"
                    : "bg-white dark:bg-[#1E1E1E]"
                } ${
                  autocompleteResults.length > 0
                    ? "rounded-t-lg border-b-0"
                    : "rounded-[20px]"
                }  border ${hasSearched ? "border-transparent dark:border-gray-700" : "border-[#D3DAE0] dark:border-gray-700"} h-[52px]`}
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
                  className={`text-[#1C1D1F] dark:text-[#F1F3F4] flex-grow text-[15px] focus-visible:ring-0 placeholder-[#BDC6D8] dark:placeholder-gray-500 font-[450] leading-[24px] focus:outline-none ${
                    hasSearched
                      ? "bg-transparent dark:bg-transparent"
                      : "bg-transparent dark:bg-transparent"
                  }`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      if (trimmedQuery) {
                        setOffset(0)
                        navigateToSearch()
                        setFilter((prevFilter: { lastUpdated?: string }) => ({
                          lastUpdated: prevFilter.lastUpdated || "anytime",
                        }))
                        // we only want to look for answer if at least
                        // 3 words are there in the query
                      }
                      if (query.split(" ").length > 2) {
                        // handleAnswer()
                      }
                    }
                  }}
                />
                {!hasSearched ? (
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
                ) : (
                  <X
                    className="text-[#ACB8D1] dark:text-gray-500 cursor-pointer mr-[16px]"
                    size={20}
                    onClick={(e) => {
                      setQuery("")
                      inputRef.current?.focus()
                    }}
                  />
                )}
                {!!autocompleteResults?.length && (
                  <div
                    ref={autocompleteRef}
                    className="absolute top-full w-full left-0 bg-white dark:bg-slate-800 rounded-b-lg border border-t-0 border-[#AEBAD3] dark:border-gray-700"
                  >
                    {autocompleteResults.map((result: any, index: number) => (
                      <AutocompleteElement
                        key={index}
                        onClick={() => {
                          if (result.type === "file") {
                            setQuery(result.title)
                          } else if (result.type === "user_query") {
                            setQuery(result.query_text)
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
        {hasSearched && (
          <div className="ml-[230px] text-[13px]">
            <SearchFilters onLastUpdated={onLastUpdated} filter={filter} />
          </div>
        )}
      </div>
    )
  },
)
