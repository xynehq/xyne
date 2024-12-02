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
      pathname,
    },
    autocompleteRef,
  ) => {
    const inputRef = useRef<HTMLInputElement | null>(null)
    const navigate = useNavigate({ from: "/search" })
    const hasSearched = !(pathname === "/")

    useEffect(() => {
      if (inputRef.current) {
        inputRef.current.focus()
      }
    }, [])

    const navigateToSearch = () => {
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
        className={`flex flex-col bg-white ${
          hasSearched
            ? "pt-[12px] border-b-[1px] border-b-[#D3DAE0] justify-center sticky top-0 z-10"
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
                  hasSearched ? "bg-[#F0F4F7]" : "bg-white"
                } ${
                  autocompleteResults.length > 0
                    ? "rounded-t-lg border-b-0"
                    : "rounded-[20px]"
                }  ${hasSearched ? "" : "border border-[#D3DAE0]"} h-[52px]`}
              >
                <Search className="text-[#AEBAD3] ml-4 mr-2" size={18} />
                <input
                  ref={inputRef}
                  placeholder="Search anything across apps..."
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setAutocompleteQuery(e.target.value)
                    setOffset(0)
                  }}
                  className={`text-[#1C1D1F] flex-grow text-[15px] focus-visible:ring-0 placeholder-[#BDC6D8] font-[450] leading-[24px] focus:outline-none ${
                    hasSearched ? "bg-[#F0F4F7]" : ""
                  }`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      navigateToSearch()
                      setFilter({}) // Use empty object instead of null
                      // we only want to look for answer if at least
                      // 3 words are there in the query
                      if (query.split(" ").length > 2) {
                        handleAnswer()
                      }
                    }
                  }}
                />
                {!hasSearched ? (
                  <button
                    onClick={() => {
                      handleSearch()
                      navigateToSearch()
                    }}
                    className="flex mr-2 bg-[#464B53] text-white hover:bg-[#5a5f66] rounded-[20px] w-[32px] h-[32px] items-center justify-center"
                  >
                    <ArrowRight className="text-white" size={16} />
                  </button>
                ) : (
                  <X
                    className="text-[#ACB8D1] cursor-pointer mr-[16px]"
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
                    className="absolute top-full w-full left-0 bg-white rounded-b-lg border border-t-0 border-[#AEBAD3]"
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
