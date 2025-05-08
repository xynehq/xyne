import {
  ArrowRight,
  Globe,
  AtSign,
  X,
  Square,
  Layers,
  ChevronDown,
  Check,
  Link,
  Search,
  RotateCcw, // Added RotateCcw icon
} from "lucide-react" // Added Search icon
import { useEffect, useMemo, useRef, useState } from "react"
import Attach from "@/assets/attach.svg?react"
import { Citation, Apps } from "shared/types"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { getIcon } from "@/lib/common"
import { DriveEntity } from "shared/types"
import { api } from "@/api"
import { Input } from "@/components/ui/input" // Import Input component

interface SourceItem {
  id: string
  name: string
  app: Apps | string
  entity: string
  icon: React.ReactNode
}

interface SearchResult {
  docId: string
  threadId: string
  app: string
  entity: string
  subject?: string
  title?: string
  from?: string
  timestamp?: number
  updatedAt?: number
  relevance: number
  url?: string
  type?: string
  email?: string
  photoLink?: string // Add photoLink property
}

interface Reference {
  id: string
  title: string
  url?: string
  docId?: string
  app?: string
  entity?: string
  type: "citation" | "global"
  // Add properties to store user-specific info for pills
  photoLink?: string
}

interface ChatBoxProps {
  query: string
  setQuery: (query: string) => void
  handleSend: (
    messageToSend: string,
    references?: Reference[], // Changed from citations: Citation[]
    selectedSources?: string[],
  ) => void
  isStreaming?: boolean
  handleStop?: () => void
  chatId?: string | null
  allCitations: Map<string, Citation>
}

const availableSources: SourceItem[] = [
  {
    id: "googledrive",
    name: "Google Drive",
    app: Apps.GoogleDrive,
    entity: "file",
    icon: getIcon(Apps.GoogleDrive, "file", { w: 16, h: 16, mr: 8 }),
  },
  {
    id: "googledocs",
    name: "Google Docs",
    app: Apps.GoogleDrive,
    entity: DriveEntity.Docs,
    icon: getIcon(Apps.GoogleDrive, DriveEntity.Docs, { w: 16, h: 16, mr: 8 }),
  },
  {
    id: "googlesheets", // Added
    name: "Google Sheets", // Added
    app: Apps.GoogleDrive, // Added
    entity: DriveEntity.Sheets, // Added
    icon: getIcon(Apps.GoogleDrive, DriveEntity.Sheets, { w: 16, h: 16, mr: 8 }), // Added
  },
  {
    id: "slack",
    name: "Slack",
    app: Apps.Slack,
    entity: "message",
    icon: getIcon(Apps.Slack, "message", { w: 16, h: 16, mr: 8 }),
  },
  {
    id: "gmail",
    name: "Gmail",
    app: Apps.Gmail,
    entity: "mail",
    icon: getIcon(Apps.Gmail, "mail", { w: 16, h: 16, mr: 8 }),
  },
{
    id: "googlecalendar",
    name: "Calendar",
    app: Apps.GoogleCalendar,
    entity: "event",
    icon: getIcon(Apps.GoogleCalendar, "event", { w: 16, h: 16, mr: 8 }),
  },
  {
    id: "pdf",
    name: "PDF",
    app: "pdf",
    entity: "pdf_default",
    icon: getIcon("pdf", "pdf_default", { w: 16, h: 16, mr: 8 }),
  },
]

// Helper function to create placeholder text
const createPlaceholder = (title: string): string => {
  // Truncate title if too long for placeholder clarity
  const truncatedTitle =
    title.length > 25 ? title.substring(0, 22) + "..." : title
  return `@[${truncatedTitle}]`
}

export const ChatBox = ({
  query,
  setQuery,
  handleSend,
  isStreaming = false,
  handleStop,
  chatId,
  allCitations,
}: ChatBoxProps) => {
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const referenceBoxRef = useRef<HTMLDivElement | null>(null)
  const referenceItemsRef = useRef<
    (HTMLDivElement | HTMLButtonElement | null)[]
  >([])
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const referenceSearchInputRef = useRef<HTMLInputElement | null>(null) // Ref for the new input
  const debounceTimeout = useRef<NodeJS.Timeout | null>(null)
  const scrollPositionRef = useRef<number>(0)

  const [showReferenceBox, setShowReferenceBox] = useState(false)
  const [searchMode, setSearchMode] = useState<"citations" | "global">(
    "citations",
  )
  const [globalResults, setGlobalResults] = useState<SearchResult[]>([])
  const [selectedRefIndex, setSelectedRefIndex] = useState(-1)
  const [references, setReferences] = useState<Reference[]>([])
  const [selectedSources, setSelectedSources] = useState<
    Record<string, boolean>
  >({})
  const [isSourceMenuOpen, setIsSourceMenuOpen] = useState(false)
  const [isGlobalLoading, setIsGlobalLoading] = useState(false)
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const [activeAtMentionIndex, setActiveAtMentionIndex] = useState(-1) // Index of @ if typed
  const [referenceSearchTerm, setReferenceSearchTerm] = useState("") // Search term for the box input

  // Derived search term for @ mentions typed in the main input
  const derivedReferenceSearch = useMemo(() => {
    if (activeAtMentionIndex === -1 || !showReferenceBox) {
      return ""
    }
    if (
      activeAtMentionIndex >= query.length ||
      query[activeAtMentionIndex] !== "@"
    ) {
      return ""
    }
    // Only derive search from query if an @ mention is active
    return query.substring(activeAtMentionIndex + 1).trimStart()
  }, [query, showReferenceBox, activeAtMentionIndex])

  // Determine the actual search term to use for fetching
  const currentSearchTerm = useMemo(() => {
    // If opened via button click (no active @), use the dedicated search term state
    if (activeAtMentionIndex === -1 && showReferenceBox) {
      return referenceSearchTerm
    }
    // Otherwise (opened via typing @), use the derived term from the main query
    return derivedReferenceSearch
  }, [
    activeAtMentionIndex,
    showReferenceBox,
    referenceSearchTerm,
    derivedReferenceSearch,
  ])

  useEffect(() => {
    // Effect to switch modes based ONLY on typing @ in the main input
    if (showReferenceBox && activeAtMentionIndex !== -1) {
      // Only run if triggered by typing @
      const newMode = derivedReferenceSearch.length > 0 ? "global" : "citations"
      if (newMode !== searchMode) {
        setSearchMode(newMode)
        setSelectedRefIndex(-1) // Reset index when mode changes
        // Reset global results when switching back to citations mode from global via backspace
        if (newMode === "citations") {
          setGlobalResults([])
          setGlobalError(null)
          setPage(1)
          setTotalCount(0)
        }
      }
    } else if (!showReferenceBox) {
      // Ensure index is reset if box is hidden
      setSelectedRefIndex(-1)
    }
    // Note: We don't switch modes if opened via button click (activeAtMentionIndex === -1)
    // The mode is set directly to 'global' in the button's onClick handler.
  }, [
    derivedReferenceSearch,
    showReferenceBox,
    searchMode,
    activeAtMentionIndex,
  ])

  const selectedSourceItems = useMemo(() => {
    return availableSources.filter((source) => selectedSources[source.id])
  }, [selectedSources])

  const selectedSourcesCount = selectedSourceItems.length

  const formatTimestamp = (time: number | undefined) => {
    if (!time) return "Unknown Date"
    return new Date(time).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    })
  }

  // Displayed citations depend on derivedReferenceSearch (typing @)
  const displayedCitations = useMemo(() => {
    if (
      !allCitations ||
      !showReferenceBox ||
      searchMode !== "citations" ||
      activeAtMentionIndex === -1
    ) {
      return []
    }
    const searchValue = derivedReferenceSearch.toLowerCase()
    return Array.from(allCitations.values()).filter((citation) =>
      citation.title.toLowerCase().includes(searchValue),
    )
  }, [
    allCitations,
    derivedReferenceSearch,
    searchMode,
    showReferenceBox,
    activeAtMentionIndex,
  ])

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value
    const newLastAt = newValue.lastIndexOf("@")
    const cursorPosition = e.target.selectionStart

    setQuery(newValue)

    // --- Logic for opening/closing box based on typing @ ---
    if (newLastAt > activeAtMentionIndex) {
      if (cursorPosition === newLastAt + 1) {
        setActiveAtMentionIndex(newLastAt)
        setReferenceSearchTerm("") // Clear separate search term
        setShowReferenceBox(true)
        // Mode switching is handled by the useEffect watching derivedReferenceSearch
        setGlobalResults([])
        setGlobalError(null)
        setPage(1)
        setTotalCount(0)
        setSelectedRefIndex(-1)
      } else if (showReferenceBox && newLastAt !== activeAtMentionIndex) {
        setShowReferenceBox(false)
        setActiveAtMentionIndex(-1)
        setReferenceSearchTerm("")
      }
    } else if (newLastAt < activeAtMentionIndex && showReferenceBox) {
      setShowReferenceBox(false)
      setActiveAtMentionIndex(-1)
      setReferenceSearchTerm("")
    } else if (
      newLastAt === -1 &&
      showReferenceBox &&
      activeAtMentionIndex !== -1
    ) {
      // Only close if opened via typing
      setShowReferenceBox(false)
      setActiveAtMentionIndex(-1)
      setReferenceSearchTerm("")
    } else if (
      showReferenceBox &&
      activeAtMentionIndex !== -1 &&
      cursorPosition <= activeAtMentionIndex
    ) {
      setShowReferenceBox(false)
      setActiveAtMentionIndex(-1)
      setReferenceSearchTerm("")
    }
    // --- End logic for typing @ ---

    // Auto-resize textarea
    const textarea = e.target
    textarea.style.height = "auto"
    textarea.style.height = `${textarea.scrollHeight}px`
  }
  

  const fetchResults = async (
    searchTermForFetch: string,
    pageToFetch: number,
    append: boolean = false,
  ) => {
    // Use the passed searchTermForFetch
    if (!searchTermForFetch || searchTermForFetch.length < 1) return

    if (
      isGlobalLoading ||
      (append && globalResults.length >= totalCount && totalCount > 0)
    )
      return

    setIsGlobalLoading(true)
    if (!append) {
      setGlobalError(null)
    }

    try {
      const limit = 10
      const offset = (pageToFetch - 1) * limit
      const params: Record<string, string | string[]> = {
        query: searchTermForFetch, // Use the term passed to the function
        limit: limit.toString(),
        offset: offset.toString(),
      }
      // ... rest of fetch logic remains the same, using params ...
      const response = await api.search.$get({
        query: params,
        credentials: "include",
      })
      const data = await response.json()
      const fetchedTotalCount = data.count || 0
      setTotalCount(fetchedTotalCount)

      const results: SearchResult[] = data.results || []

      setGlobalResults((prev) => {
        // Check against the current overall search term state
        if (currentSearchTerm !== searchTermForFetch) {
          return append ? prev : []
        }
        const existingIds = new Set(prev.map((r) => r.docId))
        const newResults = results.filter((r) => !existingIds.has(r.docId))
        const updatedResults = append ? [...prev, ...newResults] : newResults

        // Auto-fetch next page if needed (only on initial load/non-append)
        if (
          !append &&
          updatedResults.length < 5 &&
          updatedResults.length < fetchedTotalCount
        ) {
          setTimeout(() => {
            // Fetch next page using the same search term
            fetchResults(searchTermForFetch, pageToFetch + 1, true)
          }, 0)
        }

        return updatedResults
      })

      setPage(pageToFetch)
      setGlobalError(null)
    } catch (error) {
      // Check against the current overall search term state
      if (currentSearchTerm === searchTermForFetch) {
        setGlobalError("Failed to fetch global results. Please try again.")
        if (!append) setGlobalResults([])
      }
    } finally {
      // Check against the current overall search term state
      if (currentSearchTerm === searchTermForFetch) {
        setIsGlobalLoading(false)
      }
    }
  }

  // Effect to fetch results based on the currentSearchTerm (derived or from input box)
  useEffect(() => {
    // Only fetch in global mode and if there's a search term
    if (
      searchMode !== "global" ||
      !currentSearchTerm ||
      currentSearchTerm.length < 1
    ) {
      // Clear results if conditions aren't met, unless loading is in progress
      if (!isGlobalLoading) {
        setGlobalResults([])
        setGlobalError(null)
        setPage(1)
        setTotalCount(0)
      }
      return
    }

    if (debounceTimeout.current) clearTimeout(debounceTimeout.current)

    // Store the term that triggers the fetch
    const termToFetch = currentSearchTerm

    debounceTimeout.current = setTimeout(() => {
      setPage(1) // Reset page for new search
      setGlobalResults([]) // Clear previous results immediately for new search
      fetchResults(termToFetch, 1, false) // Pass the specific term
    }, 300)

    return () => {
      if (debounceTimeout.current) clearTimeout(debounceTimeout.current)
    }
  }, [currentSearchTerm, searchMode]) // Depend on the combined search term

  useEffect(() => {
    if (scrollContainerRef.current && scrollPositionRef.current > 0) {
      scrollContainerRef.current.scrollTop = scrollPositionRef.current
      scrollPositionRef.current = 0
    }
  }, [globalResults])

  // Effect to manage selected index based on displayed items
  useEffect(() => {
    if (!showReferenceBox) {
      setSelectedRefIndex(-1)
      return
    }

    const items =
      searchMode === "citations" ? displayedCitations : globalResults
    // Special case for load more button in global mode
    const canLoadMore =
      searchMode === "global" &&
      globalResults.length < totalCount &&
      !isGlobalLoading
    // Reset or initialize selection
    if (selectedRefIndex === -1) {
      setSelectedRefIndex(items.length > 0 ? 0 : -1)
    } else {
      // Ensure index is within bounds
      const currentMaxIndex =
        searchMode === "citations"
          ? displayedCitations.length - 1
          : canLoadMore
            ? globalResults.length
            : globalResults.length - 1 // Adjust max index if load more exists

      if (selectedRefIndex > currentMaxIndex) {
        setSelectedRefIndex(currentMaxIndex)
      }
    }
  }, [
    searchMode,
    displayedCitations,
    globalResults,
    showReferenceBox,
    totalCount,
    isGlobalLoading,
  ]) // Dependencies updated

  const handleAddReference = (citation: Citation) => {
    const citationApp = (citation as any).app
    const citationEntity = (citation as any).entity

    const newRef: Reference = {
      id: citation.url, // Use URL as ID for citations
      title: citation.title,
      url: citation.url,
      app: typeof citationApp === "string" ? citationApp : undefined,
      entity: typeof citationEntity === "string" ? citationEntity : undefined,
      type: "citation",
    }

    if (!references.some((ref) => ref.id === newRef.id)) {
      setReferences((prev) => [...prev, newRef])

      // --- Insert Placeholder ---
      const placeholder = createPlaceholder(newRef.title)
      let newQuery = query
      let cursorPos = query.length // Default cursor position

      if (activeAtMentionIndex !== -1) {
        // Replace text from @ onwards
        newQuery = query.substring(0, activeAtMentionIndex) + placeholder + " "
        cursorPos = activeAtMentionIndex + placeholder.length + 1 // Position after placeholder + space
      } else {
        // Append placeholder (shouldn't happen for citations currently, but for consistency)
        newQuery = query + placeholder + " "
        cursorPos = newQuery.length
      }
      setQuery(newQuery)
      // --- End Insert Placeholder ---

      // Set cursor position after state update
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.setSelectionRange(cursorPos, cursorPos)
      }, 0)
    }

    // Close and reset state
    setShowReferenceBox(false)
    setActiveAtMentionIndex(-1)
    setReferenceSearchTerm("")
    setGlobalResults([])
    setGlobalError(null)
    setPage(1)
    setTotalCount(0)
    setSelectedRefIndex(-1)
    // Focus is handled by the setTimeout above
  }

  const handleSelectGlobalResult = (result: SearchResult) => {
    let resultUrl = result.url
    if (!resultUrl && result.app === Apps.Gmail) {
      const identifier = result.threadId || result.docId
      if (identifier) {
        resultUrl = `https://mail.google.com/mail/u/0/#inbox/${identifier}`
      }
    }
    const displayTitle =
      result.subject ||
      result.title ||
      (result.type === "user" && result.email) ||
      "Untitled"
    // Use docId or email as ID for global results
    const refId = result.docId || (result.type === "user" && result.email) || ""

    // Ensure refId is valid before proceeding
    if (!refId) {
      console.error(
        "Cannot add reference without a valid ID (docId or email).",
        result,
      )
      // Optionally close the box or show an error
      setShowReferenceBox(false)
      setActiveAtMentionIndex(-1)
      setReferenceSearchTerm("")
      return
    }

    const newRef: Reference = {
      id: refId,
      title: displayTitle,
      url: resultUrl,
      docId: result.docId,
      app: result.app,
      entity: result.entity,
      type: "global",
      photoLink: result.photoLink,
    }

    if (!references.some((ref) => ref.id === newRef.id)) {
      setReferences((prev) => [...prev, newRef])

      // --- Insert Placeholder ---
      const placeholder = createPlaceholder(newRef.title)
      let newQuery = query
      let cursorPos = query.length // Default cursor position

      if (activeAtMentionIndex !== -1) {
        // Replace text from @ onwards
        newQuery = query.substring(0, activeAtMentionIndex) + placeholder + " "
        cursorPos = activeAtMentionIndex + placeholder.length + 1 // Position after placeholder + space
      } else {
        // Append placeholder (opened via button)
        newQuery = query + placeholder + " "
        cursorPos = newQuery.length
      }
      setQuery(newQuery)
      // --- End Insert Placeholder ---

      // Set cursor position after state update
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.setSelectionRange(cursorPos, cursorPos)
      }, 0)
    }

    // Close and reset state
    setShowReferenceBox(false)
    setActiveAtMentionIndex(-1)
    setReferenceSearchTerm("")
    setGlobalResults([])
    setGlobalError(null)
    setPage(1)
    setTotalCount(0)
    setSelectedRefIndex(-1)
    // Focus is handled by the setTimeout above
  }

  const removeReference = (id: string) => {
    setReferences((prev) => prev.filter((ref) => ref.id !== id))
  }

  const handleReferenceKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
  ) => {
    // This handler now needs to work correctly whether focus is on main input or reference search input
    if (!showReferenceBox) return

    const items =
      searchMode === "citations" ? displayedCitations : globalResults
    const totalItemsCount = items.length
    const canLoadMore =
      searchMode === "global" &&
      globalResults.length < totalCount &&
      !isGlobalLoading
    const loadMoreIndex = globalResults.length // Index representing the "Load More" button

    if (e.key === "ArrowDown") {
      e.preventDefault()
      const maxIndex = canLoadMore ? loadMoreIndex : totalItemsCount - 1
      setSelectedRefIndex((prev) => {
        const nextIndex = Math.min(prev + 1, maxIndex)
        // If moving from input to first item, ensure index is 0
        if (prev === -1 && items.length > 0) return 0
        return nextIndex
      })
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedRefIndex((prev) => {
        const nextIndex = Math.max(prev - 1, 0)
        // Allow moving back to index 0
        return nextIndex
      })
      // If moving up from index 0, potentially focus the search input if it exists? (Might be complex)
      // For now, just stops at 0.
    } else if (e.key === "Enter") {
      // Prevent default form submission or newline in textarea
      e.preventDefault()
      if (selectedRefIndex >= 0 && selectedRefIndex < totalItemsCount) {
        if (searchMode === "citations") {
          // Ensure we have a valid citation before calling handler
          if (displayedCitations[selectedRefIndex]) {
            handleAddReference(displayedCitations[selectedRefIndex])
          }
        } else {
          // Ensure we have a valid global result before calling handler
          if (globalResults[selectedRefIndex]) {
            handleSelectGlobalResult(globalResults[selectedRefIndex])
          }
        }
      } else if (
        searchMode === "global" &&
        selectedRefIndex === loadMoreIndex &&
        canLoadMore
      ) {
        // Handle Enter on "Load More" button
        handleLoadMore()
      }
    } else if (e.key === "Escape") {
      e.preventDefault()
      setShowReferenceBox(false)
      setActiveAtMentionIndex(-1)
      setReferenceSearchTerm("") // Reset separate search term
      setSelectedRefIndex(-1)
    }
  }

  useEffect(() => {
    if (selectedRefIndex >= 0 && referenceItemsRef.current[selectedRefIndex]) {
      referenceItemsRef.current[selectedRefIndex]?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      })
    }
  }, [selectedRefIndex])

  // Effect for handling clicks outside the reference box and main input
  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        showReferenceBox &&
        referenceBoxRef.current &&
        !referenceBoxRef.current.contains(target) &&
        inputRef.current &&
        !inputRef.current.contains(target) &&
        !(event.target as HTMLElement).closest(".reference-trigger") // Ignore clicks on the @ button itself
      ) {
        setShowReferenceBox(false)
        setActiveAtMentionIndex(-1)
        setReferenceSearchTerm("") // Reset separate search term
      }
    }

    document.addEventListener("mousedown", handleOutsideClick)
    return () => document.removeEventListener("mousedown", handleOutsideClick)
  }, [showReferenceBox]) // Dependency remains the same

  const handleSendMessage = () => {
    const activeSourceIds = Object.entries(selectedSources)
      .filter(([, isSelected]) => isSelected)
      .map(([id]) => id)

    handleSend(query, [...references], [...activeSourceIds])
    setReferences([])
    setQuery("")
  }

  const handleSourceSelectionChange = (sourceId: string, checked: boolean) => {
    setSelectedSources((prev) => ({
      ...prev,
      [sourceId]: checked,
    }))
    setPage(1)
    setGlobalResults([])
  }

  const handleClearAllSources = () => {
    const clearedSources: Record<string, boolean> = {}
    availableSources.forEach((source) => {
      clearedSources[source.id] = false
    })
    setSelectedSources(clearedSources)
    setPage(1)
    setGlobalResults([])
  }

  const handleLoadMore = () => {
    if (scrollContainerRef.current) {
      scrollPositionRef.current = scrollContainerRef.current.scrollTop
    }
    const nextPage = page + 1
    // Fetch using the currentSearchTerm state
    fetchResults(currentSearchTerm, nextPage, true)
  }

  // Effect to focus the reference search input when opened via button
  useEffect(() => {
    if (
      showReferenceBox &&
      activeAtMentionIndex === -1 &&
      referenceSearchInputRef.current
    ) {
      referenceSearchInputRef.current.focus()
    }
  }, [showReferenceBox, activeAtMentionIndex])

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
      if (query) {
        const length = query.length
        inputRef.current.setSelectionRange(length, length)
      }
    }
  }, [])
  return (
    <div className="relative flex flex-col w-full max-w-3xl">
      {showReferenceBox && (
        <div
          ref={referenceBoxRef}
          className="absolute bottom-[calc(80%+8px)] left-0 bg-white rounded-md w-[400px] z-10 border border-gray-200 rounded-xl flex flex-col" // Added flex flex-col
        >
          {/* Search Input (only shown when opened via button click) */}
          {activeAtMentionIndex === -1 && ( // <-- Updated condition here
            <div className="p-2 border-b border-gray-200 relative">
              <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                ref={referenceSearchInputRef}
                type="text"
                placeholder="Search globally..."
                value={referenceSearchTerm}
                onChange={(e) => setReferenceSearchTerm(e.target.value)}
                onKeyDown={handleReferenceKeyDown} // Allow keyboard nav from input
                className="w-full pl-8 pr-2 py-1.5 text-sm border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500" // Added padding for icon
              />
            </div>
          )}

          {/* Results Area */}
          <div
            ref={scrollContainerRef}
            className="max-h-[250px] overflow-y-auto p-1"
          >
            {" "}
            {/* Added padding */}
            {searchMode === "citations" && activeAtMentionIndex !== -1 && (
              <>
                {displayedCitations.length > 0 ? (
                  <>
                    {displayedCitations.map((citation: Citation, index) => {
                      const citationApp = (citation as any).app
                      const citationEntity = (citation as any).entity
                      return (
                        <div
                          key={citation.url}
                          ref={(el) => (referenceItemsRef.current[index] = el)}
                          className={`p-2 cursor-pointer hover:bg-[#EDF2F7] rounded-md ${
                            index === selectedRefIndex ? "bg-[#EDF2F7]" : ""
                          }`}
                          onClick={() => handleAddReference(citation)}
                          onMouseEnter={() => setSelectedRefIndex(index)}
                        >
                          <div className="flex items-center gap-2">
                            {citationApp && citationEntity ? (
                              getIcon(citationApp, citationEntity, {
                                w: 16,
                                h: 16,
                                mr: 0,
                              })
                            ) : (
                              <Link size={16} className="text-gray-400" />
                            )}
                            <p className="text-sm font-medium text-gray-900 truncate">
                              {citation.title}
                            </p>
                          </div>
                          <p className="text-xs text-gray-500 truncate ml-6">
                            {citation.url}
                          </p>
                        </div>
                      )
                    })}
                  </>
                ) : (
                  <p className="text-sm text-gray-500 px-2 py-1">
                    No recent citations found matching "{derivedReferenceSearch}
                    ".
                  </p>
                )}
              </>
            )}
            {/* Global Results (shown if mode is global) */}
            {searchMode === "global" && (
              <>
                {/* Loading state */}
                {isGlobalLoading && globalResults.length === 0 && (
                  <p className="text-sm text-gray-500 px-2 py-1">Loading...</p>
                )}
                {/* Error state */}
                {globalError && (
                  <p className="text-sm text-red-500 px-2 py-1">
                    {globalError}
                  </p>
                )}
                {/* No results state */}
                {!isGlobalLoading &&
                  !globalError &&
                  globalResults.length === 0 &&
                  currentSearchTerm.length >= 1 && (
                    <p className="text-sm text-gray-500 px-2 py-1">
                      No results found for "{currentSearchTerm}"
                    </p>
                  )}
                {/* Display results */}
                {globalResults.map((result, index) => {
                  const displayTitle =
                    result.subject ||
                    result.title ||
                    (result.type === "user" && result.email) ||
                    "Untitled"
                  return (
                    <div
                      key={result.docId || result.email || index}
                      ref={(el) => (referenceItemsRef.current[index] = el)}
                      className={`p-2 cursor-pointer hover:bg-[#EDF2F7] rounded-md ${
                        index === selectedRefIndex ? "bg-[#EDF2F7]" : ""
                      }`}
                      onClick={() => handleSelectGlobalResult(result)}
                      onMouseEnter={() => setSelectedRefIndex(index)}
                    >
                      <div className="flex items-center gap-2">
                        {result.type === "user" && result.photoLink ? (
                          <img
                            src={result.photoLink}
                            alt={displayTitle}
                            className="w-4 h-4 rounded-full object-cover flex-shrink-0"
                          />
                        ) : (
                          getIcon(result.app, result.entity, {
                            w: 16,
                            h: 16,
                            mr: 0,
                          })
                        )}
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {displayTitle}
                        </p>
                      </div>
                      {result.type !== "user" && (
                        <p className="text-xs text-gray-500 truncate ml-6">
                          {result.from ? `From: ${result.from} | ` : ""}
                          {formatTimestamp(
                            result.timestamp || result.updatedAt,
                          )}
                        </p>
                      )}
                    </div>
                  )
                })}
                {/* Load More Button */}
                {!globalError &&
                  globalResults.length > 0 &&
                  globalResults.length < totalCount && (
                    <button
                      ref={(el) =>
                        (referenceItemsRef.current[globalResults.length] = el)
                      }
                      onClick={handleLoadMore}
                      className={`mt-1 w-full px-3 py-1.5 text-sm text-center text-gray-700 bg-gray-50 hover:bg-[#EDF2F7] rounded-md border border-gray-200 ${selectedRefIndex === globalResults.length ? "bg-[#EDF2F7] ring-1 ring-blue-300" : ""}`}
                      disabled={isGlobalLoading}
                      onMouseEnter={() =>
                        setSelectedRefIndex(globalResults.length)
                      }
                    >
                      {isGlobalLoading
                        ? "Loading..."
                        : `Load More (${totalCount - globalResults.length} remaining)`}
                    </button>
                  )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Main Chat Input Area */}
      <div className="flex flex-col w-full border rounded-[20px] sticky bottom-[20px] bg-white  max-w-3xl">
      <div className="relative flex items-center">
          <textarea
            ref={inputRef}
            rows={1}
            placeholder="Ask anything across apps... (try @ to mention a source)"
            value={query}
            className="flex-grow resize-none bg-transparent outline-none text-[15px] font-[450] leading-[24px] text-[#1C1D1F] placeholder-[#ACBCCC] pl-[16px] pt-[14px] pb-[14px] pr-[16px] overflow-y-auto"
            onChange={handleInputChange}
            onKeyDown={(e) => {
              // Handle reference box navigation first if open
              if (showReferenceBox) {
                handleReferenceKeyDown(e)
                // Prevent further handling if Enter/Escape etc. was handled
                if (e.defaultPrevented) return
              }

              // Handle Backspace for removing references
              if (e.key === "Backspace" && !e.defaultPrevented) {
                const cursorStart = e.currentTarget.selectionStart
                const cursorEnd = e.currentTarget.selectionEnd

                // Only act if cursor is not selecting a range and is not at the beginning
                if (cursorStart === cursorEnd && cursorStart > 0) {
                  // Check if the text immediately before the cursor matches a reference placeholder + space
                  const textBeforeCursor = query.substring(0, cursorStart)

                  for (const ref of references) {
                    const placeholder = createPlaceholder(ref.title) + " " // Match placeholder + space
                    if (textBeforeCursor.endsWith(placeholder)) {
                      e.preventDefault() // Prevent default backspace

                      // Remove the reference pill
                      removeReference(ref.id)

                      // Remove the placeholder text from the query
                      const newQuery =
                        textBeforeCursor.substring(
                          0,
                          textBeforeCursor.length - placeholder.length,
                        ) + query.substring(cursorStart)
                      setQuery(newQuery)

                      // Manually set cursor position
                      const newCursorPos = cursorStart - placeholder.length
                      setTimeout(() => {
                        inputRef.current?.setSelectionRange(
                          newCursorPos,
                          newCursorPos,
                        )
                      }, 0)

                      return // Stop checking after finding a match
                    }
                  }
                }
              }

              // Handle regular Enter key for sending message (if not handled above)
              if (
                !e.defaultPrevented &&
                e.key === "Enter" &&
                !e.shiftKey &&
                query.trim().length > 0
              ) {
                e.preventDefault()
                handleSendMessage()
              }
            }}
            style={{
              minHeight: "52px",
              maxHeight: "150px",
            }}
            onFocus={(e) => {
              const target = e.target
              setTimeout(() => {
                // Only move cursor if focus isn't immediately shifted away (e.g., to reference box)
                if (document.activeElement === target) {
                  const len = target.value.length
                  target.setSelectionRange(len, len)
                }
              }, 0)
            }}
            onClick={(e) => {
              const cursorPosition = e.currentTarget.selectionStart
              // If user clicks before an active @ typed mention, close the box
              if (
                showReferenceBox &&
                activeAtMentionIndex !== -1 &&
                cursorPosition <= activeAtMentionIndex
              ) {
                setShowReferenceBox(false)
                setActiveAtMentionIndex(-1)
                setReferenceSearchTerm("")
              }
            }}
          />
        </div>
        <div className="flex ml-[16px] mr-[6px] mb-[6px] items-center space-x-3 pt-1 pb-1">
          <Attach className="text-[#464D53] cursor-pointer" />
          <Globe size={16} className="text-[#464D53] cursor-pointer" />
          <AtSign
            size={16}
            className="text-[#464D53] cursor-pointer reference-trigger"
            onClick={() => {
              // Insert @ into the query and open the reference box
              const textarea = inputRef.current
              if (!textarea) return

              const start = textarea.selectionStart
              const end = textarea.selectionEnd
              const currentValue = query
              const newValue =
                currentValue.substring(0, start) +
                "@" +
                currentValue.substring(end)
              const newCursorPos = start + 1

              setQuery(newValue)
              setActiveAtMentionIndex(start) // Mark the position of the inserted @
              setReferenceSearchTerm("") // Clear separate search term if any
              setShowReferenceBox(true)
              setGlobalResults([]) // Reset results
              setGlobalError(null)
              setPage(1)
              setTotalCount(0)
              setSelectedRefIndex(-1) // Reset selection

              // Focus the input and set cursor position after the @
              setTimeout(() => {
                textarea.focus()
                textarea.setSelectionRange(newCursorPos, newCursorPos)
              }, 0)
            }}
          />
          <DropdownMenu
            open={isSourceMenuOpen}
            onOpenChange={setIsSourceMenuOpen}
          >
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-1 px-3 py-1 rounded-full bg-[#EDF2F7] hover:bg-gray-200 text-sm text-gray-700 cursor-pointer">
                {selectedSourcesCount === 0 ? (
                  <>
                    <Layers size={14} className="text-[#464D53]" />
                    <span>Sources</span>
                  </>
                ) : (
                  <>
                    {selectedSourceItems.map((item) => (
                      <span key={item.id} className="flex items-center">
                        {getIcon(item.app, item.entity, {
                          w: 14,
                          h: 14,
                          mr: 0,
                        })}
                      </span>
                    ))}
                    <span>
                      {selectedSourcesCount} source
                      {selectedSourcesCount > 1 ? "s" : ""}
                    </span>
                  </>
                )}
                <ChevronDown size={16} className="ml-1 text-gray-500" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-56 relative rounded-xl"
              align="start"
              side="top"
            >
              <div className="flex items-center justify-between px-2 py-1.5">
                <DropdownMenuLabel className="p-0">
                  Filter Sources
                </DropdownMenuLabel>
                {selectedSourcesCount > 0 ? (
                  <TooltipProvider delayDuration={100}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => {
                            handleClearAllSources()
                            // setIsSourceMenuOpen(false); // Optionally close menu after clearing
                          }}
                          className="p-1 rounded-full hover:bg-[#EDF2F7] text-gray-500 hover:text-gray-700"
                          aria-label="Clear all selected sources"
                        >
                          <RotateCcw size={16} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="bg-black text-white text-xs rounded-sm">
                        <p>Clear all</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <button // Placeholder for alignment, or can be removed if layout handles it
                    className="p-1 rounded-full text-transparent" // Invisible but takes space
                    aria-label="No sources to clear"
                    disabled
                  >
                    <RotateCcw size={16} />
                  </button>
                )}
              </div>
              <DropdownMenuSeparator />
              {availableSources.map((source) => {
                const isChecked = selectedSources[source.id] || false
                return (
                  <DropdownMenuItem
                    key={source.id}
                    onClick={() =>
                      handleSourceSelectionChange(source.id, !isChecked)
                    }
                    onSelect={(e) => e.preventDefault()}
                    className="relative flex items-center: flex items-center pl-2 pr-2 gap-2 cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      {getIcon(source.app, source.entity, {
                        w: 16,
                        h: 16,
                        mr: 0,
                      })}
                      <span>{source.name}</span>
                    </div>
                    <div
                      className={`ml-auto h-5 w-5 border rounded flex items-center justify-center ${
                        isChecked
                          ? "bg-green-500 border-green-500"
                          : "border-gray-400"
                      }`}
                    >
                      {isChecked && <Check className="h-4 w-4 text-white" />}
                    </div>
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <div
          className="flex ml-[16px] mr-[6px] mb-[6px] items-center space-x-3 pt-2 cursor-text"
          onClick={() => {
            inputRef?.current?.focus()
          }}
          ></div>
          {isStreaming && chatId ? (
          <button
            onClick={handleStop}
            style={{ marginLeft: "auto" }}
            className="flex mr-6 bg-[#464B53] text-white hover:bg-[#5a5f66] rounded-full w-[32px] h-[32px] items-center justify-center"
          >
            <Square className="text-white" size={16} />
          </button>
        ) : (
          <button
            disabled={isStreaming}
            onClick={() => handleSendMessage()}
            style={{ marginLeft: "auto" }}
            className="flex mr-6 bg-[#464B53] text-white hover:bg-[#5a5f66] rounded-full w-[32px] h-[32px] items-center justify-center disabled:opacity-50"
          >
            <ArrowRight className="text-white" size={16} />
          </button>
        )}
        
        </div>
      </div>

      {/* Reference pills container moved here */}
      {references.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {" "}
          {/* Changed mb-2 to mt-2 */}
          <TooltipProvider delayDuration={300}>
            {references.map((ref) => {
              let iconNode: React.ReactNode = null
              // Check for user photo first, specifically for global user entities
              if (
                ref.type === "global" &&
                ref.entity === "OtherContacts" &&
                ref.photoLink
              ) {
                iconNode = (
                  <img
                    src={ref.photoLink}
                    alt={ref.title}
                    className="w-4 h-4 rounded-full object-cover flex-shrink-0" // Removed mr-1
                  />
                )
              } else if (ref.app && ref.entity) {
                // Use app/entity icon for non-user global or citations with app/entity
                iconNode = getIcon(ref.app, ref.entity, { w: 14, h: 14, mr: 0 }) // Removed mr: 1
              } else if (ref.type === "citation") {
                // Fallback for citations without app/entity
                iconNode = (
                  <Link size={14} className="text-gray-600 flex-shrink-0" />
                ) // Removed mr: 1
              }

              const triggerClasses = `flex items-center bg-[#EDF2F7] text-gray-700 rounded-lg px-3 py-1 text-sm shadow-sm hover:bg-opacity-80 transition-colors cursor-default`

              return (
                <Tooltip key={ref.id}>
                  <TooltipTrigger asChild>
                    <div className={triggerClasses}>
                      {" "}
                      {/* Use div as the main container */}
                      {iconNode} {/* Render the determined icon/image */}
                      {ref.url ? (
                        <a
                          href={ref.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`truncate max-w-[100px] ${iconNode ? "ml-1.5" : ""} hover:underline hover:text-blue-700 cursor-pointer`} // Added ml-1.5 conditionally
                          onClick={(e) => e.stopPropagation()} // Prevent tooltip trigger on link click if needed
                        >
                          {ref.title}
                        </a>
                      ) : (
                        <span
                          className={`truncate max-w-[100px] ${iconNode ? "ml-1.5" : ""}`}
                        >
                          {ref.title}
                        </span> // Added ml-1.5 conditionally
                      )}
                      <X
                        size={14}
                        className="ml-2 cursor-pointer hover:text-black-700 transition-colors flex-shrink-0"
                        onClick={(e) => {
                          e.preventDefault() // Prevent any default behavior
                          e.stopPropagation() // Stop event bubbling
                          removeReference(ref.id)
                        }}
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[250px] break-words bg-white text-gray-900 border border-gray-200 shadow-md">
                    <p className="font-medium">{ref.title}</p>
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </TooltipProvider>
        </div>
      )}
    </div>
  )
}
