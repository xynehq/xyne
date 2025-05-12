import React, { useEffect, useMemo, useRef, useState } from "react" // Ensure React is imported
import { renderToStaticMarkup } from 'react-dom/server'; // For rendering ReactNode to HTML string
import {
  ArrowRight,
  Globe,
  AtSign,
  Layers,
  Square,
  ChevronDown,
  Check,
  Link,
  Search,
  RotateCcw,
} from "lucide-react"
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
import { Input } from "@/components/ui/input"

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
  name?: string
  title?: string
  from?: string
  timestamp?: number
  updatedAt?: number
  relevance: number
  url?: string
  type?: string
  email?: string
  photoLink?: string
}

interface Reference {
  id: string
  title: string
  url?: string
  docId?: string
  app?: string
  entity?: string
  type: "citation" | "global"
  photoLink?: string
}

interface ChatBoxProps {
  query: string
  setQuery: (query: string) => void
  handleSend: (
    messageToSend: string,
    references: Reference[],
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
    id: "googlesheets",
    name: "Google Sheets",
    app: Apps.GoogleDrive,
    entity: DriveEntity.Sheets,
    icon: getIcon(Apps.GoogleDrive, DriveEntity.Sheets, { w: 16, h: 16, mr: 8 }),
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

const getPillDisplayTitle = (title: string): string => {
  const truncatedTitle =
    title.length > 25 ? title.substring(0, 15) : title; // Removed + ""
  return truncatedTitle;
};

const getCaretCharacterOffsetWithin = (element: Node) => {
  let caretOffset = 0
  const doc = element.ownerDocument || (element as any).document
  if (doc.getSelection) {
    const selection = doc.getSelection()
    if (selection && selection.rangeCount) {
      const range = selection.getRangeAt(0)
      const preCaretRange = range.cloneRange()
      preCaretRange.selectNodeContents(element)
      preCaretRange.setEnd(range.endContainer, range.endOffset)
      caretOffset = preCaretRange.toString().length
    }
  }
  return caretOffset
}

const setCaretPosition = (element: Node, position: number) => {
  const range = document.createRange()
  const sel = window.getSelection()!
  let currentPosition = 0
  let targetNode: Node | null = null
  let targetOffset = 0

  const traverseNodes = (node: Node) => {
    if (currentPosition >= position) return
    if (node.nodeType === Node.TEXT_NODE) {
      const textLength = node.textContent?.length || 0
      if (currentPosition + textLength >= position) {
        targetNode = node
        targetOffset = position - currentPosition
      }
      currentPosition += textLength
    } else {
      for (const child of node.childNodes) {
        traverseNodes(child)
        if (targetNode) break
      }
    }
  }

  traverseNodes(element)
  if (targetNode) {
    range.setStart(targetNode, targetOffset)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }
}

export const ChatBox = ({
  query,
  setQuery,
  handleSend,
  isStreaming = false,
  allCitations,
  handleStop,
  chatId,
}: ChatBoxProps) => {
  const inputRef = useRef<HTMLDivElement | null>(null)
  const referenceBoxRef = useRef<HTMLDivElement | null>(null)
  const referenceItemsRef = useRef<
    (HTMLDivElement | HTMLButtonElement | null)[]
  >([])
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const referenceSearchInputRef = useRef<HTMLInputElement | null>(null)
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
  const [activeAtMentionIndex, setActiveAtMentionIndex] = useState(-1)
  const [referenceSearchTerm, setReferenceSearchTerm] = useState("")
  const [isPlaceholderVisible, setIsPlaceholderVisible] = useState(true)
  const [showSourcesButton, _] = useState(false) // Added this line

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
    return query.substring(activeAtMentionIndex + 1).trimStart()
  }, [query, showReferenceBox, activeAtMentionIndex])

  const currentSearchTerm = useMemo(() => {
    if (activeAtMentionIndex === -1 && showReferenceBox) {
      return referenceSearchTerm
    }
    return derivedReferenceSearch
  }, [
    activeAtMentionIndex,
    showReferenceBox,
    referenceSearchTerm,
    derivedReferenceSearch,
  ])

  useEffect(() => {
    if (showReferenceBox && activeAtMentionIndex !== -1) {
      const newMode = derivedReferenceSearch.length > 0 ? "global" : "citations"
      if (newMode !== searchMode) {
        setSearchMode(newMode)
        setSelectedRefIndex(-1)
        if (newMode === "citations") {
          setGlobalResults([])
          setGlobalError(null)
          setPage(1)
          setTotalCount(0)
        }
      }
    } else if (!showReferenceBox) {
      setSelectedRefIndex(-1)
    }
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

  const fetchResults = async (
    searchTermForFetch: string,
    pageToFetch: number,
    append: boolean = false,
  ) => {
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
        query: searchTermForFetch,
        limit: limit.toString(),
        offset: offset.toString(),
      }
      const response = await api.search.$get({
        query: params,
        credentials: "include",
      })
      const data = await response.json()
      const fetchedTotalCount = data.count || 0
      setTotalCount(fetchedTotalCount)

      const results: SearchResult[] = data.results || []

      setGlobalResults((prev) => {
        if (currentSearchTerm !== searchTermForFetch) {
          return append ? prev : []
        }
        const existingIds = new Set(prev.map((r) => r.docId))
        const newResults = results.filter((r) => !existingIds.has(r.docId))
        const updatedResults = append ? [...prev, ...newResults] : newResults

        if (
          !append &&
          updatedResults.length < 5 &&
          updatedResults.length < fetchedTotalCount
        ) {
          setTimeout(() => {
            fetchResults(searchTermForFetch, pageToFetch + 1, true)
          }, 0)
        }

        return updatedResults
      })

      setPage(pageToFetch)
      setGlobalError(null)
    } catch (error) {
      if (currentSearchTerm === searchTermForFetch) {
        setGlobalError("Failed to fetch global results. Please try again.")
        if (!append) setGlobalResults([])
      }
    } finally {
      if (currentSearchTerm === searchTermForFetch) {
        setIsGlobalLoading(false)
      }
    }
  }

  useEffect(() => {
    if (
      searchMode !== "global" ||
      !currentSearchTerm ||
      currentSearchTerm.length < 1
    ) {
      if (!isGlobalLoading) {
        setGlobalResults([])
        setGlobalError(null)
        setPage(1)
        setTotalCount(0)
      }
      return
    }

    if (debounceTimeout.current) clearTimeout(debounceTimeout.current)

    const termToFetch = currentSearchTerm
    debounceTimeout.current = setTimeout(() => {
      setPage(1)
      setGlobalResults([])
      fetchResults(termToFetch, 1, false)
    }, 300)

    return () => {
      if (debounceTimeout.current) clearTimeout(debounceTimeout.current)
    }
  }, [currentSearchTerm, searchMode])

  useEffect(() => {
    if (scrollContainerRef.current && scrollPositionRef.current > 0) {
      scrollContainerRef.current.scrollTop = scrollPositionRef.current
      scrollPositionRef.current = 0
    }
  }, [globalResults])

  useEffect(() => {
    if (!showReferenceBox) {
      setSelectedRefIndex(-1)
      return
    }

    const items =
      searchMode === "citations" ? displayedCitations : globalResults
    const canLoadMore =
      searchMode === "global" &&
      globalResults.length < totalCount &&
      !isGlobalLoading
    if (selectedRefIndex === -1) {
      setSelectedRefIndex(items.length > 0 ? 0 : -1)
    } else {
      const currentMaxIndex =
        searchMode === "citations"
          ? displayedCitations.length - 1
          : canLoadMore
            ? globalResults.length
            : globalResults.length - 1
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
  ])

  // Helper function to parse content and preserve existing pills as spans
  const parseContentWithPills = (
    text: string,
    references: Reference[],
    cursorPosition: number,
    lastAtIndex: number,
    newRef: Reference,
    inputElement: HTMLDivElement | null,
  ) => {
    const nodes: (Node | HTMLElement)[] = []
    let currentPos = 0
  
    // Collect existing pills from the input DOM to preserve their properties
    const existingPills: { node: HTMLElement; ref: Reference | null }[] = []
    if (inputElement) {
      const childNodes = Array.from(inputElement.childNodes)
      childNodes.forEach((node) => {
        if (
          node.nodeType === Node.ELEMENT_NODE &&
          (node as HTMLElement).classList.contains("reference-pill")
        ) {
          const pillText = (node as HTMLElement).textContent || ""
          const ref = references.find(
            (r) =>
              getPillDisplayTitle(r.title) === pillText ||
              r.title === pillText ||
              `@[${getPillDisplayTitle(r.title)}]` === pillText, // Backward compatibility
          )
          existingPills.push({ node: node as HTMLElement, ref: ref || null })
        }
      })
    }
  
    // Handle text before the @ mention
    const beforeAt = text.slice(0, lastAtIndex)
    if (beforeAt) {
      let lastIndex = 0
      let pillIndex = 0
  
      // Process text and existing pills
      while (lastIndex < beforeAt.length && pillIndex < existingPills.length) {
        const pill = existingPills[pillIndex]
        const pillText = pill.node.textContent || ""
        const pillPos = beforeAt.indexOf(pillText, lastIndex)
  
        if (pillPos === -1 || pillPos > lastIndex) {
          // Add text before the next pill or end
          const endIndex = pillPos === -1 ? beforeAt.length : pillPos
          nodes.push(document.createTextNode(beforeAt.slice(lastIndex, endIndex)))
          lastIndex = endIndex
        }
  
        if (pillPos !== -1 && pillPos === lastIndex) {
          // Re-use the existing pill node to preserve properties
          nodes.push(pill.node.cloneNode(true))
          lastIndex += pillText.length
          pillIndex++
        }
      }
  
      // Add any remaining text before the @ mention
      if (lastIndex < beforeAt.length) {
        nodes.push(document.createTextNode(beforeAt.slice(lastIndex)))
      }
      currentPos += beforeAt.length
    }
  
    // Add the new pill
    const newPill = document.createElement("span")
    newPill.className = "reference-pill bg-[#F1F5F9] text-[#374151] rounded-lg px-2 py-0.4 inline-flex items-center"
    newPill.contentEditable = "false"
  
    if (newRef.app && newRef.entity) {
      const iconContainer = document.createElement('span')
      const iconNode = getIcon(newRef.app, newRef.entity, { w: 14, h: 14, mr: 4 })
  
      if (React.isValidElement(iconNode)) {
        iconContainer.innerHTML = renderToStaticMarkup(iconNode)
      } else if (typeof iconNode === 'string') {
        iconContainer.textContent = iconNode
      } else {
        iconContainer.textContent = '▫️'
      }
      newPill.appendChild(iconContainer)
    }
    newPill.appendChild(document.createTextNode(getPillDisplayTitle(newRef.title)))
    nodes.push(newPill)
  
    // Add a space after the new pill
    const spaceNode = document.createTextNode("\u00A0")
    nodes.push(spaceNode)
  
    // Handle text after the @ mention
    const afterAt = text.slice(cursorPosition)
    if (afterAt) {
      let lastIndex = 0
      let pillIndex = existingPills.findIndex((p, i) => i >= existingPills.length || beforeAt.indexOf(p.node.textContent || "") === -1)
  
      while (lastIndex < afterAt.length && pillIndex < existingPills.length) {
        const pill = existingPills[pillIndex]
        const pillText = pill.node.textContent || ""
        const pillPos = afterAt.indexOf(pillText, lastIndex)
  
        if (pillPos === -1 || pillPos > lastIndex) {
          const endIndex = pillPos === -1 ? afterAt.length : pillPos
          nodes.push(document.createTextNode(afterAt.slice(lastIndex, endIndex)))
          lastIndex = endIndex
        }
  
        if (pillPos !== -1 && pillPos === lastIndex) {
          nodes.push(pill.node.cloneNode(true))
          lastIndex += pillText.length
          pillIndex++
        }
      }
  
      // Add any remaining text after the last pill
      if (lastIndex < afterAt.length) {
        nodes.push(document.createTextNode(afterAt.slice(lastIndex)))
      }
    }
  
    return { nodes, cursorNode: spaceNode, cursorOffset: 1 }
  }

  const handleAddReference = (citation: Citation) => {
    const citationApp = (citation as any).app
    const citationEntity = (citation as any).entity
  
    const newRef: Reference = {
      id: citation.url,
      title: citation.title,
      url: citation.url,
      app: typeof citationApp === "string" ? citationApp : undefined,
      entity: typeof citationEntity === "string" ? citationEntity : undefined,
      type: "citation",
    }
  
    setReferences((prev) => [...prev, newRef])
  
    const input = inputRef.current
    if (!input) return
  
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return
  
    const range = selection.getRangeAt(0)
    // const cursorPosition = getCaretCharacterOffsetWithin(input) // Original line, can be unreliable on click
    const textContent = input.textContent || ""
  
    let lastAtIndex = activeAtMentionIndex // Use activeAtMentionIndex directly
  
    if (lastAtIndex !== -1) {
      // Calculate effectiveCursorPosition assuming replacement from @ to end of input
      const effectiveCursorPosition = textContent.length;
      
      const { nodes, cursorNode, cursorOffset } = parseContentWithPills(
        textContent,
        references, // These are references before newRef is included in this specific 'references' variable instance
        effectiveCursorPosition, // Use calculated position
        lastAtIndex,
        newRef,
        input, // Pass input element
      )
  
      input.innerHTML = ""
      nodes.forEach((node) => input.appendChild(node))
  
      range.setStart(cursorNode, cursorOffset)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
  
      setQuery(input.textContent || "")
    }
  
    setShowReferenceBox(false)
    setActiveAtMentionIndex(-1)
    setReferenceSearchTerm("")
    setGlobalResults([])
    setGlobalError(null)
    setPage(1)
    setTotalCount(0)
    setSelectedRefIndex(-1)
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
      result.name ||
      result.subject ||
      result.title ||
      (result.type === "user" && result.email) ||
      "Untitled"
    const refId = result.docId || (result.type === "user" && result.email) || ""
  
    if (!refId) {
      console.error("Cannot add reference without a valid ID.", result)
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
  
    setReferences((prev) => [...prev, newRef])
  
    const input = inputRef.current
    if (!input) return
  
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return
  
    const range = selection.getRangeAt(0)
    // const cursorPosition = getCaretCharacterOffsetWithin(input) // Original line, can be unreliable on click
    const textContent = input.textContent || ""
  
    let lastAtIndex = activeAtMentionIndex // Use activeAtMentionIndex directly
  
    if (lastAtIndex !== -1) {
      // Calculate effectiveCursorPosition assuming replacement from @ to end of input
      const effectiveCursorPosition = textContent.length;

      const { nodes, cursorNode, cursorOffset } = parseContentWithPills(
        textContent,
        references, // These are references before newRef is included in this specific 'references' variable instance
        effectiveCursorPosition, // Use calculated position
        lastAtIndex,
        newRef,
        input, // Pass input element
      )
  
      input.innerHTML = ""
      nodes.forEach((node) => input.appendChild(node))
  
      range.setStart(cursorNode, cursorOffset)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
  
      setQuery(input.textContent || "")
    }
  
    setShowReferenceBox(false)
    setActiveAtMentionIndex(-1)
    setReferenceSearchTerm("")
    setGlobalResults([])
    setGlobalError(null)
    setPage(1)
    setTotalCount(0)
    setSelectedRefIndex(-1)
  }

  const handleReferenceKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
  ) => {
    if (!showReferenceBox) return

    const items =
      searchMode === "citations" ? displayedCitations : globalResults
    const totalItemsCount = items.length
    const canLoadMore =
      searchMode === "global" &&
      globalResults.length < totalCount &&
      !isGlobalLoading
    const loadMoreIndex = globalResults.length

    if (e.key === "ArrowDown") {
      e.preventDefault()
      const maxIndex = canLoadMore ? loadMoreIndex : totalItemsCount - 1
      setSelectedRefIndex((prev) => {
        const nextIndex = Math.min(prev + 1, maxIndex)
        if (prev === -1 && items.length > 0) return 0
        return nextIndex
      })
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedRefIndex((prev) => {
        const nextIndex = Math.max(prev - 1, 0)
        return nextIndex
      })
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (selectedRefIndex >= 0 && selectedRefIndex < totalItemsCount) {
        if (searchMode === "citations") {
          if (displayedCitations[selectedRefIndex]) {
            handleAddReference(displayedCitations[selectedRefIndex])
          }
        } else {
          if (globalResults[selectedRefIndex]) {
            handleSelectGlobalResult(globalResults[selectedRefIndex])
          }
        }
      } else if (
        searchMode === "global" &&
        selectedRefIndex === loadMoreIndex &&
        canLoadMore
      ) {
        handleLoadMore()
      }
    } else if (e.key === "Escape") {
      e.preventDefault()
      setShowReferenceBox(false)
      setActiveAtMentionIndex(-1)
      setReferenceSearchTerm("")
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

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        showReferenceBox &&
        referenceBoxRef.current &&
        !referenceBoxRef.current.contains(target) &&
        inputRef.current &&
        !inputRef.current.contains(target) &&
        !(event.target as HTMLElement).closest(".reference-trigger")
      ) {
        setShowReferenceBox(false)
        setActiveAtMentionIndex(-1)
        setReferenceSearchTerm("")
      }
    }

    document.addEventListener("mousedown", handleOutsideClick)
    return () => document.removeEventListener("mousedown", handleOutsideClick)
  }, [showReferenceBox])

  const handleSendMessage = () => {
    const activeSourceIds = Object.entries(selectedSources)
      .filter(([, isSelected]) => isSelected)
      .map(([id]) => id)

    const htmlMessage = inputRef.current?.innerHTML || ""; // Get innerHTML from the contentEditable div

    handleSend(htmlMessage, [...references], [...activeSourceIds]); // Pass innerHTML to the handleSend prop
    setReferences([])
    if (inputRef.current) {
      inputRef.current.innerHTML = ""; // Clear the innerHTML of the contentEditable div
    }
    setQuery("") // Clear the text-based query state in the parent component
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
    fetchResults(currentSearchTerm, nextPage, true)
  }

  useEffect(() => {
    if (
      showReferenceBox &&
      activeAtMentionIndex === -1 &&
      referenceSearchInputRef.current
    ) {
      referenceSearchInputRef.current.focus()
    }
  }, [showReferenceBox, activeAtMentionIndex])

  return (
    <div className="relative flex flex-col w-full max-w-3xl">
      {showReferenceBox && (
        <div
          ref={referenceBoxRef}
          className="absolute bottom-[calc(80%+8px)] left-0 bg-white rounded-md w-[400px] z-10 border border-gray-200 rounded-xl flex flex-col"
        >
          {activeAtMentionIndex === -1 && (
            <div className="p-2 border-b border-gray-200 relative">
              <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                ref={referenceSearchInputRef}
                type="text"
                placeholder="Search globally..."
                value={referenceSearchTerm}
                onChange={(e) => setReferenceSearchTerm(e.target.value)}
                onKeyDown={handleReferenceKeyDown}
                className="w-full pl-8 pr-2 py-1.5 text-sm border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          )}
          <div
            ref={scrollContainerRef}
            className="max-h-[250px] overflow-y-auto p-1"
          >
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
                              {citation.title || citation.name}
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
                    search for your docs...
                  </p>
                )}
              </>
            )}
            {searchMode === "global" && (
              <>
                {isGlobalLoading && globalResults.length === 0 && (
                  <p className="text-sm text-gray-500 px-2 py-1">Loading...</p>
                )}
                {globalError && (
                  <p className="text-sm text-red-500 px-2 py-1">{globalError}</p>
                )}
                {globalResults.map((result, index) => {
                  const displayTitle =
                    result.name ||
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
      <div className="flex flex-col w-full border rounded-[20px] bg-white">
        <div className="relative flex items-center">
          {isPlaceholderVisible && (
            <div className="absolute left-4 top-1/2 transform -translate-y-1/2 text-[#ACBCCC] pointer-events-none">
              Ask anything across apps...
            </div>
          )}
          <div
            ref={inputRef}
            contentEditable
            className="flex-grow resize-none bg-transparent outline-none text-[15px] font-[450] leading-[24px] text-[#1C1D1F] placeholder-[#ACBCCC] pl-[16px] pt-[14px] pb-[14px] pr-[16px] overflow-y-auto"
            onPaste={(e: React.ClipboardEvent<HTMLDivElement>) => {
              e.preventDefault();
              const text = e.clipboardData?.getData('text/plain');
              const currentInput = inputRef.current;

              if (text && currentInput) {
                const selection = window.getSelection();
                if (!selection || !selection.rangeCount) return;

                const range = selection.getRangeAt(0);
                range.deleteContents(); // Remove selected text or collapsed cursor position

                const textNode = document.createTextNode(text);
                range.insertNode(textNode);

                // Move cursor to the end of pasted text
                range.setStartAfter(textNode);
                range.collapse(true);
                selection.removeAllRanges(); // Clear existing selection
                selection.addRange(range); // Set new selection

                // Dispatch an 'input' event to trigger the onInput handler
                // This ensures setQuery and @mention logic runs
                currentInput.dispatchEvent(
                  new Event('input', { bubbles: true, cancelable: true })
                );
              }
            }}
            onInput={(e) => {
              const currentInput = inputRef.current;
              if (!currentInput) return;

              const newValue = currentInput.textContent || "";
              setQuery(newValue);
              setIsPlaceholderVisible(newValue.length === 0 && document.activeElement !== currentInput);

              const cursorPosition = getCaretCharacterOffsetWithin(currentInput as Node);
              
              let shouldTriggerBox = false;
              let newActiveMentionIndex = -1;

              // Check if the character right before the cursor is an '@' and if it's validly placed
              const atCharIndex = cursorPosition - 1;
              if (atCharIndex >= 0 && newValue[atCharIndex] === '@') {
                const isFirstCharacter = atCharIndex === 0;
                const isPrecededBySpace = atCharIndex > 0 && (newValue[atCharIndex - 1] === ' ' || newValue[atCharIndex - 1] === '\u00A0');
                if (isFirstCharacter || isPrecededBySpace) {
                  shouldTriggerBox = true;
                  newActiveMentionIndex = atCharIndex;
                }
              }

              if (shouldTriggerBox) {
                // A validly placed '@' is at the cursor. Open or keep the box open for this '@'.
                if (activeAtMentionIndex !== newActiveMentionIndex || !showReferenceBox) {
                  // It's a new trigger point or the box was closed. Activate for this '@'.
                  setActiveAtMentionIndex(newActiveMentionIndex);
                  setShowReferenceBox(true);
                  setReferenceSearchTerm(""); // Clear search for new mention context
                  setGlobalResults([]);
                  setGlobalError(null);
                  setPage(1);
                  setTotalCount(0);
                  setSelectedRefIndex(-1);
                  setSearchMode("citations"); // Default to citations
                }
                // If activeAtMentionIndex === newActiveMentionIndex and showReferenceBox is true,
                // the box is already open for this exact '@'. derivedReferenceSearch will handle query updates.
              } else {
                // No valid '@' trigger at the current cursor position.
                // If a reference box was open, determine if it should be closed.
                if (showReferenceBox && activeAtMentionIndex !== -1) {
                  // Check if the previously active mention (at activeAtMentionIndex) is still valid
                  // and if the cursor is still actively engaged with it (i.e., after it).
                  const charAtOldActiveMention = newValue[activeAtMentionIndex];
                  const oldActiveMentionStillIsAt = charAtOldActiveMention === '@';
                  const oldActiveMentionIsFirst = activeAtMentionIndex === 0;
                  const oldActiveMentionPrecededBySpace = activeAtMentionIndex > 0 && (newValue[activeAtMentionIndex - 1] === ' ' || newValue[activeAtMentionIndex - 1] === '\u00A0');
                  const oldActiveMentionStillValidlyPlaced = oldActiveMentionIsFirst || oldActiveMentionPrecededBySpace;
                  
                  // Close the box if:
                  // 1. Cursor has moved to or before the previously active '@'.
                  // 2. The character at the old activeAtMentionIndex is no longer an '@'.
                  // 3. The placement of the old active '@' is no longer valid (e.g., preceding space removed).
                  if (cursorPosition <= activeAtMentionIndex || !oldActiveMentionStillIsAt || !oldActiveMentionStillValidlyPlaced) {
                    setShowReferenceBox(false);
                    setActiveAtMentionIndex(-1);
                    setReferenceSearchTerm(""); // Clear search term when box closes
                  }
                  // Otherwise, the box remains open (e.g., user is typing after a valid '@').
                }
              }
            }}
            onKeyDown={(e) => {
              if (showReferenceBox) {
                handleReferenceKeyDown(e as React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>)
                if (e.defaultPrevented) return
              }

              if (e.key === "Enter" && !e.shiftKey && query.trim().length > 0) {
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
                if (document.activeElement === target) {
                  const len = target.textContent?.length || 0
                  setCaretPosition(inputRef.current as Node, len)
                }
              }, 0)
            }}
            onClick={() => {
              const cursorPosition = getCaretCharacterOffsetWithin(
                inputRef.current as Node,
              )
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
              const input = inputRef.current;
              if (!input) return;

              const currentText = input.textContent || "";
              // Add "@" or " @" to ensure it's validly placed
              const textToAppend = (currentText.length === 0 || currentText.endsWith(" ") || currentText.endsWith("\n") || currentText.endsWith("\u00A0")) ? "@" : " @";
              const newValue = currentText + textToAppend;
              
              input.textContent = newValue;
              setQuery(newValue);
              setIsPlaceholderVisible(newValue.length === 0 && document.activeElement !== input);

              const newAtSymbolIndex = currentText.length + (textToAppend === "@" ? 0 : 1); // Index of the newly added @
              setCaretPosition(input, newValue.length); // Move cursor to the end

              // Since textToAppend ensures valid placement, directly activate the mention UI
              setActiveAtMentionIndex(newAtSymbolIndex);
              setReferenceSearchTerm("");
              setShowReferenceBox(true);
              setSearchMode("citations");
              setGlobalResults([]);
              setGlobalError(null);
              setPage(1);
              setTotalCount(0);
              setSelectedRefIndex(-1);
              
              input.focus(); // Re-focus the input
            }}
          />
          {showSourcesButton && ( // Added this condition because currently it's backend is not ready therefore we are not showing it
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
                            onClick={handleClearAllSources}
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
                    <button
                      className="p-1 rounded-full text-transparent"
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
                      className="relative flex items-center pl-2 pr-2 gap-2 cursor-pointer"
                    >
                      <div className="flex itemsbinoculars flex items-center gap-2">
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
          )} {/* Closing tag for the conditional render */}
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
    </div>
  )
}