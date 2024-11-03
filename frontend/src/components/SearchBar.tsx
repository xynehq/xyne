import { Search } from "lucide-react"
import React, { useState, useRef, useEffect } from "react"
import { SearchFilters } from "./SearchFilter"
import { ArrowRight, X } from "lucide-react" // Assuming ArrowRight and X are imported from lucide-react
import { AutocompleteElement } from "@/components/Autocomplete"
import { Button } from "@/components/ui/button"

export const SearchBar = React.forwardRef<HTMLDivElement, any>(
  (
    {
      hasSearched,
      autocompleteResults,
      setQuery,
      setAutocompleteResults,
      setAutocompleteQuery,
      setOffset,
      query,
      handleSearch,
      handleAnswer,
    },
    autocompleteRef,
  ) => {
    const inputRef = useRef<HTMLInputElement | null>(null)

    useEffect(() => {
      if (inputRef.current) {
        inputRef.current.focus()
      }
    }, [])

    return (
      <div
        className={`flex flex-col bg-white ${
          hasSearched
            ? "pt-[12px] border-b-[1px] border-b-[#E6EBF5] justify-center sticky top-0 z-10"
            : "items-center"
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
                    : "rounded-full"
                }  ${
                  hasSearched ? "" : "border border-[#AEBAD3]"
                } h-[52px] shadow-sm`}
              >
                <Search className="text-[#AEBAD3] ml-4 mr-2" size={18} />
                <input
                  ref={inputRef}
                  placeholder="Search anything across connected apps..."
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setAutocompleteQuery(e.target.value)
                    setOffset(0)
                  }}
                  className={`text-[#1C1D1F] w-full text-[15px] focus-visible:ring-0 placeholder-[#BDC6D8] font-[450] leading-[24px] focus:outline-none ${
                    hasSearched ? "bg-[#F0F4F7]" : ""
                  }`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleSearch()
                      // we only want to look for answer if at least
                      // 3 words are there in the query
                      if (query.split(" ").length > 2) {
                        handleAnswer()
                      }
                    }
                  }}
                />
                {!hasSearched ? (
                  <Button
                    onClick={(e) => handleSearch()}
                    className="mr-2 bg-[#464B53] text-white p-2 hover:bg-[#5a5f66] rounded-full"
                  >
                    <ArrowRight className="text-white" size={20} />
                  </Button>
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
                    className="absolute top-full w-full left-0 bg-white rounded-b-lg border border-t-0 border-[#AEBAD3] shadow-md"
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
        {/* search filters */}
        {hasSearched && (
          <div className="ml-[230px] text-[13px]">
            <SearchFilters />
          </div>
        )}
      </div>
    )
  },
)
