import { useState, useMemo, useEffect, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/api"
import {
  AlertCircle,
  Moon,
  Sun,
  BarChart2,
  Activity,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  GripVertical,
  ChevronDown,
  ChevronRight as ChevronRightIcon,
  ClipboardCopy,
} from "lucide-react"
import ReactJson from "react-json-view"

interface TraceSpan {
  traceId?: string
  spanId?: string
  parentSpanId?: string | null
  name?: string
  startTime?: number
  endTime?: number
  duration?: number
  attributes?: Record<string, any>
  events?: any[]
  [key: string]: any
}

interface TraceJson {
  id?: string | number
  chatId?: string | number
  workspaceId?: string | number
  userId?: string | number
  chatExternalId?: string
  createdAt?: string
  email?: string
  messageExternalId?: string
  messageId?: string | number
  traceJson?: {
    spans?: TraceSpan[]
    [key: string]: any
  }
  [key: string]: any
}

interface RagTraceVirtualizationProps {
  chatId: string
  messageId: string
  onClose: () => void
}

interface SafeSpan extends TraceSpan {
  children?: SafeSpan[]
}

interface Citation {
  docId: string
  title: string
  url: string
  app: string
  entity: string
}

interface CitationValues {
  [key: string]: Citation
}

interface ContextItem {
  index: number
  app: string
  entity: string
  sent: string
  subject: string
  from: string
  to: string
  labels: string[]
  content: string
  vespaRelevanceScore: number
}

const fetchChatTrace = async (
  chatId: string,
  messageId: string,
): Promise<TraceJson> => {
  try {
    const res = await api.chat.trace.$get({
      query: { chatId, messageId },
    })
    if (!res.ok) throw new Error("Error fetching chat trace")
    return await res.json()
  } catch (error) {
    console.error("Error fetching chat trace:", error)
    throw error
  }
}

const parseTraceJson = (data: any): any => {
  if (!data) return { spans: [] }
  if (typeof data === "string") {
    try {
      return JSON.parse(data)
    } catch (e) {
      console.error("Failed to parse trace JSON:", e)
      return { spans: [] }
    }
  }
  return data
}

const safeCalculateDuration = (spans: SafeSpan[]): number => {
  if (!spans || !Array.isArray(spans) || spans.length === 0) return 0
  try {
    const validSpans = spans.filter(
      (s) => s && s.startTime != null && s.endTime != null,
    )
    if (validSpans.length === 0) return 0
    const endTimes = validSpans.map((s) => Number(s.endTime))
    const startTimes = validSpans.map((s) => Number(s.startTime))
    return Math.max(...endTimes) - Math.min(...startTimes)
  } catch (error) {
    console.error("Error calculating duration:", error)
    return 0
  }
}

const formatDuration = (duration: number | null | undefined): string => {
  if (duration == null || isNaN(duration)) return "N/A"
  return `${duration.toFixed(2)}ms`
}

const safeTimelineCalculation = (spans: SafeSpan[]) => {
  if (!spans || !Array.isArray(spans) || spans.length === 0) return null
  try {
    const validSpans = spans.filter((span) => span && span.startTime != null)
    if (validSpans.length === 0) return null
    const startTimes = validSpans.map((s) => Number(s.startTime))
    const endTimes = validSpans
      .filter((s) => s.endTime != null)
      .map((s) => Number(s.endTime))
    const minTime = Math.min(...startTimes)
    const maxTime = endTimes.length > 0 ? Math.max(...endTimes) : Date.now()
    return { minTime, maxTime, totalDuration: maxTime - minTime }
  } catch (error) {
    console.error("Error in timeline calculation:", error)
    return null
  }
}

const validateSpanData = (span: SafeSpan): boolean => {
  return Boolean(
    span && typeof span.startTime === "number" && !isNaN(span.startTime),
  )
}

const parseCitationData = (span: SafeSpan | undefined) => {
  if (!span || !span.attributes) {
    return { citationValues: null, citationMap: null }
  }
  let citationValues: CitationValues | null = null
  let citationMap: Record<string, string> | null = null
  if (span.attributes.citation_values) {
    try {
      if (typeof span.attributes.citation_values === "string") {
        citationValues = JSON.parse(span.attributes.citation_values)
      } else {
        citationValues = span.attributes.citation_values
      }
    } catch (e) {
      console.error("Failed to parse citation_values:", e)
    }
  }
  if (span.attributes.citation_map) {
    try {
      if (typeof span.attributes.citation_map === "string") {
        citationMap = JSON.parse(span.attributes.citation_map)
      } else {
        citationMap = span.attributes.citation_map
      }
    } catch (e) {
      console.error("Failed to parse citation_map:", e)
    }
  }
  return { citationValues, citationMap }
}

const parseAnswerTextWithCitations = (
  answerText: string,
  citationMap: Record<string, string> | null,
  citationValues: CitationValues | null,
  setCurrentCitationIndex: (index: number) => void,
) => {
  if (!answerText || !citationMap || !citationValues) {
    return <span>{answerText}</span>
  }
  const citationRegex = /\[(\d+)\]/g
  const parts: (string | { citationNumber: string })[] = []
  let lastIndex = 0
  let match
  while ((match = citationRegex.exec(answerText)) !== null) {
    const citationNumber = match[1]
    const startIndex = match.index
    const endIndex = citationRegex.lastIndex
    if (startIndex > lastIndex) {
      parts.push(answerText.slice(lastIndex, startIndex))
    }
    parts.push({ citationNumber })
    lastIndex = endIndex
  }
  if (lastIndex < answerText.length) {
    parts.push(answerText.slice(lastIndex))
  }
  return parts.map((part, index) => {
    if (typeof part === "string") {
      return <span key={index}>{part}</span>
    }
    const { citationNumber } = part
    if (!citationValues[citationNumber]) {
      return <span key={index}>[{citationNumber}]</span>
    }
    const citationIndex = Object.keys(citationValues).indexOf(citationNumber)
    return (
      <button
        key={index}
        className="text-blue-500 hover:underline font-medium"
        onClick={() => {
          if (citationIndex >= 0) {
            setCurrentCitationIndex(citationIndex)
          }
        }}
        title={`View citation ${citationNumber}`}
      >
        [{citationNumber}]
      </button>
    )
  })
}

const parseContextData = (contextText: string): ContextItem[] => {
  const contextItems: ContextItem[] = []
  const indexRegex = /Index (\d+)/g
  const entries = contextText.split(indexRegex)

  for (let i = 1; i < entries.length; i += 2) {
    const index = parseInt(entries[i], 10)
    const content = entries[i + 1].trim()

    const appMatch = content.match(/App: ([^\s]+)/)
    const entityMatch = content.match(/Entity: ([^\s]+)/)
    const sentMatch = content.match(/Sent: ([^\n]+)/)
    const subjectMatch = content.match(/Subject: ([^\n]+)/)
    const fromMatch = content.match(/From: ([^\n]+)/)
    const toMatch = content.match(/To: ([^\n]+)/)
    const labelsMatch = content.match(/Labels: ([^\n]+)/)
    const contentMatch = content.match(
      /Content: ([\s\S]+?)(?=vespa relevance score|$)/,
    )
    const scoreMatch = content.match(/vespa relevance score: ([\d.]+)/)

    contextItems.push({
      index,
      app: appMatch ? appMatch[1] : "",
      entity: entityMatch ? entityMatch[1] : "",
      sent: sentMatch ? sentMatch[1] : "",
      subject: subjectMatch ? subjectMatch[1] : "",
      from: fromMatch ? fromMatch[1] : "",
      to: toMatch ? toMatch[1] : "",
      labels: labelsMatch
        ? labelsMatch[1].split(", ").map((label) => label.trim())
        : [],
      content: contentMatch ? contentMatch[1].trim() : "",
      vespaRelevanceScore: scoreMatch ? parseFloat(scoreMatch[1]) : 0,
    })
  }

  return contextItems.sort((a, b) => a.index - b.index)
}

const buildSpanHierarchy = (spans: SafeSpan[]): SafeSpan[] => {
  if (!spans || spans.length === 0) return []
  const spanMap = new Map<string, SafeSpan>()
  const rootSpans: SafeSpan[] = []

  // First pass: Populate spanMap with all spans
  spans.forEach((span) => {
    if (!span.spanId) {
      console.warn(`Span with name "${span.name}" is missing spanId, skipping`)
      return
    }
    spanMap.set(span.spanId, { ...span, children: [] })
  })

  // Second pass: Build hierarchy, handling null or undefined parentSpanId
  spans.forEach((span) => {
    if (!span.spanId) return // Skip spans without spanId
    const currentSpan = spanMap.get(span.spanId)
    if (!currentSpan) return // Should not happen due to first pass
    if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
      const parentSpan = spanMap.get(span.parentSpanId)!
      parentSpan.children = parentSpan.children || []
      parentSpan.children.push(currentSpan)
    } else {
      // Treat spans with null, undefined, or missing parentSpanId as root spans
      rootSpans.push(currentSpan)
    }
  })

  // Sort children and root spans
  const sortChildren = (span: SafeSpan) => {
    if (span.children && span.children.length > 0) {
      span.children.sort((a, b) => (a.startTime || 0) - (b.startTime || 0))
      span.children.forEach(sortChildren)
    }
  }
  rootSpans.sort((a, b) => (a.startTime || 0) - (b.startTime || 0))
  rootSpans.forEach(sortChildren)

  return rootSpans
}

// Format YQL query for readability
export const formatYqlQuery = (yql: string): string => {
  try {
    let cleaned = yql.replace(/\\n/g, " ").replace(/\s+/g, " ").trim()
    const lines: string[] = []
    let indentLevel = 0
    const indent = "  "
    let currentLine = ""
    let i = 0

    const keywords = [
      "select",
      "from",
      "where",
      "and",
      "or",
      "contains",
      "userInput",
      "nearestNeighbor",
    ]
    const splitRegex = /(\(|\)|,|;)/g

    const tokens: string[] = []
    let lastIndex = 0
    let match

    while ((match = splitRegex.exec(cleaned)) !== null) {
      const index = match.index
      const token = match[0]
      if (index > lastIndex) {
        tokens.push(cleaned.slice(lastIndex, index).trim())
      }
      tokens.push(token)
      lastIndex = splitRegex.lastIndex
    }
    if (lastIndex < cleaned.length) {
      tokens.push(cleaned.slice(lastIndex).trim())
    }

    while (i < tokens.length) {
      let token = tokens[i].trim()
      if (!token) {
        i++
        continue
      }

      if (
        keywords.some((kw) => token.toLowerCase().startsWith(kw)) ||
        token === "!"
      ) {
        if (currentLine) {
          lines.push(indent.repeat(indentLevel) + currentLine.trim())
          currentLine = ""
        }
        currentLine = token
        if (
          i + 1 < tokens.length &&
          tokens[i + 1] === "(" &&
          token.toLowerCase() !== "contains"
        ) {
          currentLine += tokens[i + 1]
          i += 2
          indentLevel++
          lines.push(indent.repeat(indentLevel - 1) + currentLine.trim())
          currentLine = ""
          continue
        }
      } else if (token === "(") {
        if (currentLine) {
          lines.push(indent.repeat(indentLevel) + currentLine.trim())
          currentLine = ""
        }
        indentLevel++
        currentLine = token
        lines.push(indent.repeat(indentLevel - 1) + currentLine)
        currentLine = ""
      } else if (token === ")") {
        if (currentLine) {
          lines.push(indent.repeat(indentLevel) + currentLine.trim())
          currentLine = ""
        }
        indentLevel--
        lines.push(indent.repeat(indentLevel) + token)
      } else if (token === ",") {
        if (currentLine) {
          currentLine += token + " "
        }
      } else {
        currentLine += (currentLine ? " " : "") + token
      }
      i++
    }

    if (currentLine) {
      lines.push(indent.repeat(indentLevel) + currentLine.trim())
    }

    const finalLines = lines
      .filter((line) => line.trim())
      .map((line, index, arr) => {
        if (
          line.trim().toLowerCase().startsWith("from") &&
          index + 1 < arr.length &&
          arr[index + 1].includes(",")
        ) {
          const nextLine = arr[index + 1]
          arr[index + 1] = ""
          return line.trim() + " " + nextLine.trim()
        }
        return line
      })
      .filter((line) => line.trim())

    return finalLines.join("\n")
  } catch (error) {
    console.error("Error formatting YQL:", error)
    return yql
  }
}

// Modal component for enlarged attribute view
interface AttributeModalProps {
  isOpen: boolean
  onClose: () => void
  attributeKey: string
  attributeValue: any
  darkMode: boolean
}

const AttributeModal: React.FC<AttributeModalProps> = ({
  isOpen,
  onClose,
  attributeKey,
  attributeValue,
  darkMode,
}) => {
  const [isCopied, setIsCopied] = useState(false)

  if (!isOpen) return null

  let displayValue: any = attributeValue
  let isJson = false
  const isUrl =
    typeof attributeValue === "string" && /^https?:\/\//.test(attributeValue)
  const isLongText =
    typeof attributeValue === "string" && attributeValue.length > 100

  if (attributeKey === "vespaPayload" && typeof attributeValue === "string") {
    try {
      const parsed = JSON.parse(attributeValue)
      if (parsed.yql) {
        displayValue = formatYqlQuery(parsed.yql)
      } else {
        // For vespaPayload that is not YQL, we'll use ReactJson if it's an object
        try {
          const potentialJson = JSON.parse(attributeValue)
          if (typeof potentialJson === "object" && potentialJson !== null) {
            displayValue = potentialJson
            isJson = true
          } else {
            displayValue = JSON.stringify(potentialJson, null, 2)
          }
        } catch (e) {
          displayValue = String(attributeValue)
        }
      }
    } catch (e) {
      console.error("Failed to parse vespaPayload:", e)
      displayValue = String(attributeValue)
    }
  } else if (typeof attributeValue === "object" && attributeValue !== null) {
    displayValue = attributeValue
    isJson = true
  } else if (typeof attributeValue === "string") {
    try {
      const parsed = JSON.parse(attributeValue)
      // Ensure it's an actual object or array, not just a stringified primitive
      if (typeof parsed === "object" && parsed !== null) {
        displayValue = parsed
        isJson = true
      } else {
        displayValue = String(attributeValue)
      }
    } catch (e) {
      displayValue = String(attributeValue)
    }
  } else {
    displayValue = String(attributeValue)
  }

  // Handle copy to clipboard
  const handleCopy = async () => {
    let textToCopy = ""
    if (isJson) {
      textToCopy = JSON.stringify(displayValue, null, 2)
    } else if (
      attributeKey === "vespaPayload" &&
      typeof attributeValue === "string"
    ) {
      // Special handling for vespaPayload if it was formatted as YQL
      try {
        const parsed = JSON.parse(attributeValue)
        if (parsed.yql) {
          textToCopy = formatYqlQuery(parsed.yql)
        } else {
          textToCopy = JSON.stringify(parsed, null, 2)
        }
      } catch (e) {
        textToCopy = String(attributeValue)
      }
    } else {
      textToCopy = String(attributeValue)
    }

    try {
      await navigator.clipboard.writeText(textToCopy)
      setIsCopied(true)
      setTimeout(() => setIsCopied(false), 2000) // Reset after 2 seconds
    } catch (err) {
      console.error("Failed to copy to clipboard:", err)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div
        className={`${
          darkMode ? "bg-gray-800 text-gray-200" : "bg-white text-gray-700"
        } rounded-lg p-6 w-3/4 max-w-4xl h-3/4 max-h-[80vh] flex flex-col shadow-xl border ${
          darkMode ? "border-gray-700" : "border-gray-200"
        } resize overflow-auto`}
      >
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold capitalize">{attributeKey}</h3>
          <div className="flex items-center space-x-2">
            <button
              onClick={handleCopy}
              className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 relative group"
              title={isCopied ? "Copied!" : "Copy to clipboard"}
            >
              <ClipboardCopy size={20} />
              {isCopied && (
                <span className="absolute top-full mt-2 left-1/2 transform -translate-x-1/2 bg-gray-800 text-white text-xs rounded py-1 px-2">
                  Copied!
                </span>
              )}
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
              title="Close"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-gray-50 dark:bg-gray-900 p-4 rounded border border-gray-200 dark:border-gray-600">
          {isJson ? (
            <div className="max-h-full overflow-y-auto text-sm font-mono bg-white dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-600">
              <ReactJson
                src={displayValue}
                theme={darkMode ? "ocean" : "summerfruit:inverted"}
                indentWidth={2}
                displayDataTypes={false}
                name={false}
                enableClipboard={false}
                style={{ backgroundColor: darkMode ? "#1f2937" : "#ffffff" }}
              />
            </div>
          ) : isUrl ? (
            <a
              href={String(displayValue)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:underline break-all"
            >
              {String(displayValue)}
            </a>
          ) : isLongText || (attributeKey === "vespaPayload" && !isJson) ? (
            <div className="max-h-full overflow-y-auto whitespace-pre-wrap text-sm font-mono bg-white dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-600">
              {String(displayValue)}
            </div>
          ) : (
            <pre className="text-sm whitespace-pre-wrap font-mono">
              {String(displayValue)}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}

export function RagTraceVirtualization({
  chatId,
  messageId,
  onClose,
}: RagTraceVirtualizationProps) {
  const [selectedSpanIds, setSelectedSpanIds] = useState<string[]>([])
  const [selectedSpanIndex, setSelectedSpanIndex] = useState<number>(0)
  const [activeTab, setActiveTab] = useState<"timeline" | "json" | "hierarchy">(
    "timeline",
  )
  const [darkMode, setDarkMode] = useState(true)
  const [showSpanDetails, setShowSpanDetails] = useState(true)
  const [showTimeline, setShowTimeline] = useState(true)
  const [panelWidth, setPanelWidth] = useState(950)
  const [currentCitationIndex, setCurrentCitationIndex] = useState<number>(0)
  const [showCitations, setShowCitations] = useState(true)
  const [expandedSpans, setExpandedSpans] = useState<Set<string>>(new Set())
  const [isAttributeModalOpen, setIsAttributeModalOpen] = useState(false)
  const [selectedContextItemIndex, setSelectedContextItemIndex] =
    useState<number>(0)
  const [selectedAttribute, setSelectedAttribute] = useState<{
    key: string
    value: any
  } | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const [isJsonCopied, setIsJsonCopied] = useState(false)

  const {
    data: rawTraceData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["traceData", chatId, messageId],
    queryFn: () => fetchChatTrace(chatId, messageId),
    enabled: !!chatId && !!messageId,
    retry: 1,
    staleTime: 5 * 60 * 1000,
  })

  const traceData = useMemo(() => {
    if (!rawTraceData) return null
    let parsedData = rawTraceData.traceJson
      ? parseTraceJson(rawTraceData.traceJson)
      : parseTraceJson(rawTraceData)
    let spans: SafeSpan[] = Array.isArray(parsedData?.spans)
      ? parsedData.spans
      : typeof parsedData?.spans === "object"
        ? Object.values(parsedData.spans)
        : Array.isArray(parsedData)
          ? parsedData
          : []

    const normalizedSpans = spans.map((span: any) => ({
      ...span,
      spanId: span.spanId || span.id || span.name || "unknown",
      parentSpanId: span.parentSpanId || span.parentId || null,
      name: span.name || span.spanId || "Unnamed Span",
      startTime: span.startTime != null ? Number(span.startTime) : null,
      endTime: span.endTime != null ? Number(span.endTime) : null,
      duration:
        span.duration != null
          ? Number(span.duration)
          : span.startTime != null && span.endTime != null
            ? Number(span.endTime) - Number(span.startTime)
            : null,
      attributes: span.attributes || {},
      events: span.events || [],
    }))

    return {
      ...parsedData,
      spans: normalizedSpans,
      traceId:
        parsedData.traceId ||
        normalizedSpans[0]?.traceId ||
        rawTraceData.id ||
        "unknown",
    }
  }, [rawTraceData])

  const citationData = useMemo(() => {
    if (!traceData?.spans)
      return {
        answerText: null,
        citationValues: null,
        citationMap: null,
        understandMessageSpan: null,
      }
    const processFinalAnswerSpan = traceData.spans.find(
      (span: SafeSpan) => span.name === "process_final_answer",
    )
    const conversationSearchSpan = traceData.spans.find(
      (span: SafeSpan) => span.name === "conversation_search",
    )
    const answerText =
      conversationSearchSpan?.attributes?.["answer_found"] ||
      processFinalAnswerSpan?.attributes?.["actual_answer"]
    const understandMessageSpan = traceData.spans.find(
      (span: SafeSpan) => span.name === "understand_message",
    )
    const { citationValues, citationMap } = parseCitationData(
      understandMessageSpan,
    )
    return { answerText, citationValues, citationMap, understandMessageSpan }
  }, [traceData])

  const contextData = useMemo(() => {
    if (!traceData?.spans) return []
    const buildContextSpan = traceData.spans.find(
      (span: SafeSpan) => span.name === "build_context",
    )
    if (!buildContextSpan || !buildContextSpan.attributes?.context) return []
    return parseContextData(buildContextSpan.attributes.context)
  }, [traceData])

  const spanHierarchy = useMemo(() => {
    if (!traceData?.spans) return []
    return buildSpanHierarchy(traceData.spans)
  }, [traceData])

  useEffect(() => {
    if (
      traceData?.spans &&
      traceData.spans.length > 0 &&
      selectedSpanIds.length === 0
    ) {
      const understandMessageSpan = traceData.spans.find(
        (span: SafeSpan) => span.name === "understand_message",
      )
      const spanToSelect =
        understandMessageSpan ||
        traceData.spans.find((span: SafeSpan) => validateSpanData(span))
      if (spanToSelect?.spanId) {
        setSelectedSpanIds([spanToSelect.spanId])
        const index = traceData.spans.indexOf(spanToSelect)
        setSelectedSpanIndex(index >= 0 ? index : 0)
        setShowSpanDetails(true)
        if (understandMessageSpan) {
          setExpandedSpans((prev) => {
            const newSet = new Set(prev)
            let current = understandMessageSpan
            while (current && current.parentSpanId) {
              newSet.add(current.parentSpanId)
              current = traceData.spans.find(
                (s: SafeSpan) => s.spanId === current!.parentSpanId,
              )
            }
            return newSet
          })
        }
      }
    }
  }, [traceData])

  const toggleSelected = (spanId: string) => {
    if (selectedSpanIds.includes(spanId)) {
      setSelectedSpanIds([])
      setSelectedSpanIndex(0)
      setShowSpanDetails(false)
    } else {
      setSelectedSpanIds([spanId])
      const spans = traceData?.spans || []
      const index = spans.findIndex((span: SafeSpan) => span.spanId === spanId)
      setSelectedSpanIndex(index >= 0 ? index : 0)
      setShowSpanDetails(true)
    }
  }

  const toggleExpandSpan = (spanId: string) => {
    setExpandedSpans((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(spanId)) {
        newSet.delete(spanId)
      } else {
        newSet.add(spanId)
      }
      return newSet
    })
  }

  const getValidSpans = () => {
    if (!traceData?.spans || !Array.isArray(traceData.spans)) return []
    return traceData.spans.filter(validateSpanData)
  }

  const getSelectedSpanDetails = (spans: SafeSpan[], spanId: string) => {
    return spans.find((span) => span.spanId === spanId)
  }

  const navigateToSpan = (direction: "next" | "prev") => {
    const validSpans = getValidSpans()
    if (validSpans.length === 0 || selectedSpanIds.length === 0) return
    let newIndex
    if (direction === "next") {
      newIndex = (selectedSpanIndex + 1) % validSpans.length
    } else {
      newIndex = (selectedSpanIndex - 1 + validSpans.length) % validSpans.length
    }
    setSelectedSpanIndex(newIndex)
    setSelectedSpanIds([validSpans[newIndex].spanId || ""])
  }

  const navigateToCitation = (direction: "next" | "prev") => {
    const { citationValues } = citationData
    if (!citationValues) return
    const citationCount = Object.keys(citationValues).length
    let newIndex
    if (direction === "next") {
      newIndex = (currentCitationIndex + 1) % citationCount
    } else {
      newIndex = (currentCitationIndex - 1 + citationCount) % citationCount
    }
    setCurrentCitationIndex(newIndex)
  }

  const navigateToContextItem = (direction: "next" | "prev") => {
    if (contextData.length === 0) return
    let newIndex
    if (direction === "next") {
      newIndex = (selectedContextItemIndex + 1) % contextData.length
    } else {
      newIndex =
        (selectedContextItemIndex - 1 + contextData.length) % contextData.length
    }
    setSelectedContextItemIndex(newIndex)
  }

  const renderAnswerTextWithCitations = () => {
    const { answerText, citationValues, citationMap } = citationData
    if (!answerText) return null
    return (
      <div className="mb-4 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-200 mb-2">
          Answer
        </h4>
        <div
          className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap"
          ref={contentRef}
        >
          {parseAnswerTextWithCitations(
            answerText,
            citationMap,
            citationValues,
            setCurrentCitationIndex,
          )}
        </div>
      </div>
    )
  }

  const renderAttributesTable = (attributes: Record<string, any>) => {
    if (!attributes || Object.keys(attributes).length === 0) {
      return (
        <div className="text-sm text-gray-500 dark:text-gray-400 italic">
          No attributes available
        </div>
      )
    }

    let citationValues: CitationValues | null = null
    if (attributes.citation_values) {
      try {
        citationValues =
          typeof attributes.citation_values === "string"
            ? JSON.parse(attributes.citation_values)
            : attributes.citation_values
      } catch (e) {
        console.error("Failed to parse citation_values:", e)
      }
    }

    let contextItems: ContextItem[] | null = null
    if (attributes.context) {
      try {
        contextItems = parseContextData(attributes.context)
      } catch (e) {
        console.error("Failed to parse context:", e)
      }
    }

    const sortedKeys = Object.keys(attributes)
      .filter((key) => key !== "citation_values" && key !== "context")
      .sort((a, b) => a.localeCompare(b))

    return (
      <div className="overflow-auto max-h-96 border border-gray-200 dark:border-gray-600 rounded">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100 dark:bg-gray-700">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-600">
                Key
              </th>
              <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-600">
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedKeys.map((key, index) => {
              let value = attributes[key]
              const isUrl =
                typeof value === "string" && /^https?:\/\//.test(value)
              const isLongText = typeof value === "string" && value.length > 100

              if (key === "vespaPayload" && typeof value === "string") {
                try {
                  const parsed = JSON.parse(value)
                  if (parsed.yql) {
                    value = formatYqlQuery(parsed.yql)
                  } else {
                    value = JSON.stringify(parsed, null, 2)
                  }
                } catch (e) {
                  console.error("Failed to parse vespaPayload:", e)
                  value = String(value)
                }
              } else if (typeof value === "object" && value !== null) {
                value = JSON.stringify(value, null, 2)
              }

              return (
                <tr
                  key={key}
                  className={
                    index % 2 === 0
                      ? "bg-white dark:bg-gray-800"
                      : "bg-gray-50 dark:bg-gray-900"
                  }
                >
                  <td className="px-4 py-2 border-b border-gray-100 dark:border-gray-600 font-medium text-gray-700 dark:text-gray-200">
                    <button
                      onClick={() => {
                        setSelectedAttribute({ key, value: attributes[key] })
                        setIsAttributeModalOpen(true)
                      }}
                      className="cursor-pointer text-left w-full px-4 py-2 block"
                      title="View enlarged"
                    >
                      {key}
                    </button>
                  </td>
                  <td className="px-4 py-2 border-b border-gray-100 dark:border-gray-600 font-mono text-gray-700 dark:text-gray-200">
                    {isUrl ? (
                      <a
                        href={value}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-500 hover:underline"
                      >
                        {value}
                      </a>
                    ) : isLongText ||
                      (key === "vespaPayload" && typeof value === "string") ? (
                      <div className="max-h-32 overflow-y-auto whitespace-pre-wrap text-xs bg-white dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-600">
                        {value}
                      </div>
                    ) : (
                      String(value)
                    )}
                  </td>
                </tr>
              )
            })}
            {contextItems && (
              <tr className="bg-white dark:bg-gray-800">
                <td className="px-4 py-2 border-b border-gray-100 dark:border-gray-600 font-medium text-gray-700 dark:text-gray-200">
                  <button
                    onClick={() => {
                      setSelectedAttribute({
                        key: "context",
                        value: JSON.stringify(contextItems, null, 2),
                      })
                      setIsAttributeModalOpen(true)
                    }}
                    className="cursor-pointer text-left w-full px-4 py-2 block"
                    title="View enlarged"
                  >
                    context
                  </button>
                </td>
                <td className="px-4 py-2 border-b border-gray-100 dark:border-gray-600 font-mono text-gray-700 dark:text-gray-200">
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <h5 className="font-bold text-sm text-gray-800 dark:text-gray-200">
                        Context Details
                      </h5>
                      <div className="flex items-center space-x-2">
                        <button
                          className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-400 disabled:opacity-50"
                          onClick={() => navigateToContextItem("prev")}
                          title="Previous context item"
                          disabled={contextItems.length <= 1}
                        >
                          <ChevronLeft size={18} />
                        </button>
                        <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center">
                          {selectedContextItemIndex + 1} / {contextItems.length}
                        </div>
                        <button
                          className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-400 disabled:opacity-50"
                          onClick={() => navigateToContextItem("next")}
                          title="Next context item"
                          disabled={contextItems.length <= 1}
                        >
                          <ChevronRight size={18} />
                        </button>
                      </div>
                    </div>
                    <div className="border border-gray-200 dark:border-gray-600 rounded">
                      <table className="min-w-full text-sm">
                        <thead className="bg-gray-100 dark:bg-gray-700">
                          <tr>
                            <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-600">
                              Key
                            </th>
                            <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-600">
                              Value
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {(() => {
                            const currentItem =
                              contextItems[selectedContextItemIndex]
                            if (!currentItem) {
                              return (
                                <tr className="bg-white dark:bg-gray-800">
                                  <td
                                    colSpan={2}
                                    className="px-4 py-2 text-center text-gray-500 dark:text-gray-400"
                                  >
                                    No context items available
                                  </td>
                                </tr>
                              )
                            }
                            const fields: [string, any][] = [
                              ["Index", currentItem.index],
                              ["App", currentItem.app],
                              ["Entity", currentItem.entity],
                              ["Sent", currentItem.sent],
                              ["Subject", currentItem.subject],
                              ["From", currentItem.from],
                              ["To", currentItem.to],
                              ["Labels", currentItem.labels.join(", ")],
                              ["Content", currentItem.content],
                              [
                                "Vespa Relevance Score",
                                currentItem.vespaRelevanceScore,
                              ],
                            ]
                            return fields.map(([key, value], index) => {
                              const isUrl =
                                typeof value === "string" &&
                                /^https?:\/\//.test(value)
                              const isLongText =
                                typeof value === "string" && value.length > 100
                              return (
                                <tr
                                  key={key}
                                  className={
                                    index % 2 === 0
                                      ? "bg-white dark:bg-gray-800"
                                      : "bg-gray-50 dark:bg-gray-900"
                                  }
                                >
                                  <td className="px-4 py-2 border-b border-gray-100 dark:border-gray-600 font-medium text-gray-700 dark:text-gray-200 capitalize">
                                    {key}
                                  </td>
                                  <td className="px-4 py-2 border-b border-gray-100 dark:border-gray-600 font-mono text-gray-700 dark:text-gray-200">
                                    {isUrl ? (
                                      <a
                                        href={value}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-blue-500 hover:underline"
                                      >
                                        {value}
                                      </a>
                                    ) : isLongText ? (
                                      <div className="max-h-32 overflow-y-auto whitespace-pre-wrap text-xs bg-white dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-600">
                                        {value}
                                      </div>
                                    ) : (
                                      String(value)
                                    )}
                                  </td>
                                </tr>
                              )
                            })
                          })()}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </td>
              </tr>
            )}
            {citationValues && (
              <tr className="bg-white dark:bg-gray-800">
                <td className="px-4 py-2 border-b border-gray-100 dark:border-gray-600 font-medium text-gray-700 dark:text-gray-200">
                  <button
                    onClick={() => {
                      setSelectedAttribute({
                        key: "citation_values",
                        value: JSON.stringify(citationValues, null, 2),
                      })
                      setIsAttributeModalOpen(true)
                    }}
                    className="cursor-pointer text-left w-full px-4 py-2 block"
                    title="View enlarged"
                  >
                    citation_values
                  </button>
                </td>
                <td className="px-4 py-2 border-b border-gray-100 dark:border-gray-600 font-mono text-gray-700 dark:text-gray-200">
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <h5 className="font-bold text-sm text-gray-800 dark:text-gray-200">
                        Citation Details
                      </h5>
                      <div className="flex items-center space-x-2">
                        <button
                          className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-400 disabled:opacity-50"
                          onClick={() => navigateToCitation("prev")}
                          title="Previous citation"
                          disabled={Object.keys(citationValues).length <= 1}
                        >
                          <ChevronLeft size={18} />
                        </button>
                        <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center">
                          {currentCitationIndex + 1} /{" "}
                          {Object.keys(citationValues).length}
                        </div>
                        <button
                          className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-400 disabled:opacity-50"
                          onClick={() => navigateToCitation("next")}
                          title="Next citation"
                          disabled={Object.keys(citationValues).length <= 1}
                        >
                          <ChevronRight size={18} />
                        </button>
                        <button
                          className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-400 flex items-center"
                          onClick={() => setShowCitations(!showCitations)}
                          title={
                            showCitations ? "Hide citations" : "Show citations"
                          }
                        >
                          {showCitations ? (
                            <EyeOff size={18} />
                          ) : (
                            <Eye size={18} />
                          )}
                          <span className="ml-1 text-xs">
                            {showCitations ? "Hide" : "Show"}
                          </span>
                        </button>
                      </div>
                    </div>
                    {showCitations && (
                      <div className="border border-gray-200 dark:border-gray-600 rounded">
                        <table className="min-w-full text-sm">
                          <thead className="bg-gray-100 dark:bg-gray-700">
                            <tr>
                              <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-600">
                                Key
                              </th>
                              <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-600">
                                Value
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {(() => {
                              const citations = Object.entries(citationValues)
                                .map(([key, citation]) => ({
                                  index: Number(key),
                                  citation,
                                }))
                                .sort((a, b) => a.index - b.index)
                              if (citations.length === 0) {
                                return (
                                  <tr className="bg-white dark:bg-gray-800">
                                    <td
                                      colSpan={2}
                                      className="px-4 py-2 text-center text-gray-500 dark:text-gray-400"
                                    >
                                      No citations available
                                    </td>
                                  </tr>
                                )
                              }
                              const currentCitation =
                                citations[currentCitationIndex]
                              return (
                                <>
                                  <tr className="bg-white dark:bg-gray-800">
                                    <td className="px-4 py-2 border-b border-gray-100 dark:border-gray-600 font-medium text-gray-700 dark:text-gray-200">
                                      Citation Number
                                    </td>
                                    <td className="px-4 py-2 border-b border-gray-100 dark:border-gray-600 font-mono text-gray-700 dark:text-gray-200">
                                      {currentCitation.index}
                                    </td>
                                  </tr>
                                  {Object.entries(currentCitation.citation).map(
                                    ([key, value], index) => {
                                      const isUrl =
                                        typeof value === "string" &&
                                        /^https?:\/\//.test(value)
                                      return (
                                        <tr
                                          key={key}
                                          className={
                                            (index + 1) % 2 === 0
                                              ? "bg-white dark:bg-gray-800"
                                              : "bg-gray-50 dark:bg-gray-900"
                                          }
                                        >
                                          <td className="px-4 py-2 border-b border-gray-100 dark:border-gray-600 font-medium text-gray-700 dark:text-gray-200 capitalize">
                                            {key}
                                          </td>
                                          <td className="px-4 py-2 border-b border-gray-100 dark:border-gray-600 font-mono text-gray-700 dark:text-gray-200">
                                            {isUrl ? (
                                              <a
                                                href={value}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-blue-500 hover:underline"
                                              >
                                                {value}
                                              </a>
                                            ) : (
                                              String(value)
                                            )}
                                          </td>
                                        </tr>
                                      )
                                    },
                                  )}
                                </>
                              )
                            })()}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    )
  }

  const renderSpanBasicInfo = (span: SafeSpan) => {
    if (!span) return null
    return (
      <div className="mb-4">
        <div className="flex justify-between items-center mb-2">
          <h5 className="font-bold text-sm text-gray-800 dark:text-gray-200">
            Attributes
          </h5>
          <button
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-400 flex items-center"
            onClick={() => setShowSpanDetails(!showSpanDetails)}
            title={showSpanDetails ? "Hide details" : "Show details"}
          >
            {showSpanDetails ? <EyeOff size={18} /> : <Eye size={18} />}
            <span className="ml-1 text-xs">
              {showSpanDetails ? "Hide details" : "Show details"}
            </span>
          </button>
        </div>
        {span.attributes && renderAttributesTable(span.attributes)}
      </div>
    )
  }

  const renderSpanDetails = (span: SafeSpan) => {
    if (!span) return null
    return (
      <div className="space-y-4">
        {renderSpanBasicInfo(span)}
        {showSpanDetails && (
          <>
            <div className="mt-4 border-t pt-4 border-gray-200 dark:border-gray-600">
              <h5 className="font-bold text-sm text-gray-800 dark:text-gray-200 mb-2">
                Span Details
              </h5>
              <div className="grid grid-cols-2 gap-2 text-sm text-gray-700 dark:text-gray-200">
                <div className="font-medium">ID:</div>
                <div className="font-mono">{span.spanId}</div>
                {span.parentSpanId && (
                  <>
                    <div className="font-medium">Parent:</div>
                    <div className="font-mono">{span.parentSpanId}</div>
                  </>
                )}
                {span.startTime != null && (
                  <>
                    <div className="font-medium">Start:</div>
                    <div>{new Date(span.startTime).toLocaleString()}</div>
                  </>
                )}
                {span.endTime != null && (
                  <>
                    <div className="font-medium">End:</div>
                    <div>{new Date(span.endTime).toLocaleString()}</div>
                  </>
                )}
                {span.duration != null && (
                  <>
                    <div className="font-medium">Duration:</div>
                    <div>{formatDuration(span.duration)}</div>
                  </>
                )}
                {span.traceId && (
                  <>
                    <div className="font-medium">Trace ID:</div>
                    <div className="font-mono truncate">{span.traceId}</div>
                  </>
                )}
              </div>
            </div>
            {span.events && span.events.length > 0 && (
              <div className="mt-4">
                <h5 className="font-bold text-sm text-gray-800 dark:text-gray-200 mb-2">
                  Events ({span.events.length})
                </h5>
                <div className="bg-white dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-600 max-h-48 overflow-y-auto">
                  <pre className="text-sm whitespace-pre-wrap text-gray-700 dark:text-gray-200">
                    {JSON.stringify(span.events, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  const renderHierarchyNode = (span: SafeSpan, level: number = 0) => {
    const spanId = span.spanId || "unknown"
    const hasChildren = span.children && span.children.length > 0
    const isExpanded = expandedSpans.has(spanId)
    const isUnderstandMessage = span.name === "understand_message"
    const duration =
      span.duration ||
      (span.endTime && span.startTime
        ? Number(span.endTime) - Number(span.startTime)
        : null)

    return (
      <div key={spanId} className="my-1">
        <div
          className={`flex items-center text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 rounded px-2 py-1`}
          style={{ paddingLeft: `${level * 24 + 8}px` }}
          onClick={() => toggleSelected(spanId)}
        >
          {hasChildren ? (
            <button
              className="mr-1 text-gray-500 dark:text-gray-400"
              onClick={(e) => {
                e.stopPropagation()
                toggleExpandSpan(spanId)
              }}
              title={isExpanded ? "Collapse" : "Expand"}
            >
              {isExpanded ? (
                <ChevronDown size={16} />
              ) : (
                <ChevronRightIcon size={16} />
              )}
            </button>
          ) : (
            <span className="w-5 mr-1" />
          )}
          <span
            className={`truncate flex-1 ${
              isUnderstandMessage ? "font-bold" : ""
            } ${
              selectedSpanIds.includes(spanId)
                ? "text-blue-600 dark:text-blue-400"
                : "text-gray-700 dark:text-gray-300"
            }`}
            title={span.name}
          >
            {span.name}
            {isUnderstandMessage && " 🔍"}
          </span>
          <span className="text-gray-500 dark:text-gray-400 ml-4">
            {formatDuration(duration)}
          </span>
        </div>
        {hasChildren && isExpanded && (
          <div>
            {span.children!.map((child) =>
              renderHierarchyNode(child, level + 1),
            )}
          </div>
        )}
      </div>
    )
  }

  const renderHierarchy = () => {
    if (!spanHierarchy || spanHierarchy.length === 0) {
      return (
        <div className="p-4 text-center text-gray-500">
          No spans available for hierarchy visualization
        </div>
      )
    }
    return (
      <div className="w-full p-4 overflow-auto" ref={contentRef}>
        {renderAnswerTextWithCitations()}
        <div className="mt-4">
          {spanHierarchy.map((span) => renderHierarchyNode(span))}
        </div>
      </div>
    )
  }

  const renderTimeline = () => {
    if (!traceData?.spans || !Array.isArray(traceData.spans)) {
      return (
        <div className="p-4 text-center text-gray-500">
          No spans available for timeline visualization
        </div>
      )
    }
    const validSpans = traceData.spans.filter(validateSpanData)
    if (validSpans.length === 0) {
      return (
        <div className="p-4 text-center text-gray-500">
          No valid spans available for visualization
        </div>
      )
    }
    const timelineData = safeTimelineCalculation(validSpans)
    if (!timelineData) {
      return (
        <div className="p-4 text-center text-gray-500">
          Could not calculate timeline data
        </div>
      )
    }
    const { minTime, totalDuration } = timelineData
    const sortedSpans = [...validSpans].sort((a, b) => {
      const timeComparison = (a.startTime ?? 0) - (b.startTime ?? 0)
      if (timeComparison !== 0) return timeComparison
      if (a.parentSpanId === b.spanId) return 1
      if (b.parentSpanId === a.spanId) return -1
      return (a.duration ?? 0) - (b.duration ?? 0)
    })
    return (
      <div className="w-full p-4" ref={contentRef}>
        {renderAnswerTextWithCitations()}
        {showTimeline ? (
          <div className="relative w-full mt-8">
            {sortedSpans.map((span, index) => {
              const spanId = span.spanId || "unknown"
              const startOffset =
                ((Number(span.startTime) - minTime) / totalDuration) * 100
              const duration =
                span.duration ||
                (span.endTime
                  ? Number(span.endTime) - Number(span.startTime)
                  : 0)
              const durationPercent = Math.max(
                0.5,
                Math.min(40, (duration / totalDuration) * 100),
              )
              const displayName = span.name
              const isUnderstandMessage = span.name === "understand_message"
              const isProcessFinalAnswer = span.name === "process_final_answer"
              return (
                <div
                  key={spanId}
                  className="flex items-center mb-4 group cursor-pointer"
                  onClick={() => toggleSelected(spanId)}
                >
                  <div
                    className={`w-56 pr-6 text-sm font-medium truncate cursor-pointer relative group ${
                      isUnderstandMessage ? "font-bold" : ""
                    } ${
                      selectedSpanIds.includes(spanId)
                        ? "text-blue-600 dark:text-blue-400"
                        : "text-gray-700 dark:text-gray-300"
                    } hover:text-blue-600 dark:hover:text-blue-400`}
                    onClick={() => toggleSelected(spanId)}
                  >
                    <div className="relative group w-max">
                      <span
                        className="truncate max-w-[150px] block"
                        title={`${displayName}\nStart: ${new Date(
                          span.startTime || 0,
                        ).toLocaleString()}\nDuration: ${formatDuration(duration)}`}
                      >
                        {displayName}
                      </span>
                      <div className="absolute z-10 hidden group-hover:block bg-gray-800 dark:bg-gray-700 text-white dark:text-gray-200 text-xs rounded-lg py-2 px-3 -top-10 left-0 max-w-xs shadow-lg whitespace-nowrap">
                        {displayName}
                      </div>
                    </div>
                  </div>
                  <div className="flex-1 relative h-8">
                    <div className="absolute inset-0 bg-gray-100 dark:bg-gray-800 rounded" />
                    <div
                      className={`absolute h-5 top-1.5 rounded cursor-pointer ${
                        selectedSpanIds.includes(spanId)
                          ? isProcessFinalAnswer
                            ? "bg-green-600 dark:bg-green-500"
                            : isUnderstandMessage
                              ? "bg-blue-700 dark:bg-blue-600"
                              : "bg-blue-700 dark:bg-blue-600"
                          : isProcessFinalAnswer
                            ? "bg-green-500 dark:bg-green-400 hover:bg-green-600 dark:hover:bg-green-500"
                            : isUnderstandMessage
                              ? "bg-blue-500 dark:bg-blue-400 hover:bg-blue-600 dark:hover:bg-blue-500"
                              : "bg-blue-500 dark:bg-blue-400 hover:bg-blue-600 dark:hover:bg-blue-500"
                      }`}
                      style={{
                        left: `${Math.max(0, Math.min(100, startOffset))}%`,
                        width: `${durationPercent}%`,
                      }}
                      onClick={() => toggleSelected(spanId)}
                      title={`${displayName}\nStart: ${new Date(
                        span.startTime || 0,
                      ).toLocaleString()}\nDuration: ${formatDuration(duration)}`}
                    />
                  </div>
                  <div className="w-32 pl-6 text-sm text-gray-500 dark:text-gray-400">
                    {formatDuration(duration)}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          selectedSpanIds.length > 0 && (
            <div className="mt-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
              <div className="flex justify-between items-center mb-4">
                <h4 className="text-lg font-extrabold text-blue-600 dark:text-blue-400">
                  {getSelectedSpanDetails(validSpans, selectedSpanIds[0])
                    ?.name || "Span Details"}
                </h4>
                <div className="flex space-x-2">
                  <button
                    className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-400"
                    onClick={() => navigateToSpan("prev")}
                    title="Previous span"
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center">
                    {selectedSpanIndex + 1} / {validSpans.length}
                  </div>
                  <button
                    className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-400"
                    onClick={() => navigateToSpan("next")}
                    title="Next span"
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
              </div>
              {renderSpanDetails(
                getSelectedSpanDetails(validSpans, selectedSpanIds[0])!,
              )}
            </div>
          )
        )}
      </div>
    )
  }

  const renderJsonView = () => {
    if (!rawTraceData)
      return (
        <div className="p-6 text-center text-gray-500">
          No trace data available
        </div>
      )
    const totalDuration = traceData?.spans
      ? safeCalculateDuration(traceData.spans)
      : 0

    const handleCopyJson = async () => {
      try {
        await navigator.clipboard.writeText(
          JSON.stringify(rawTraceData, null, 2),
        )
        setIsJsonCopied(true)
        setTimeout(() => setIsJsonCopied(false), 2000) // Reset after 2 seconds
      } catch (err) {
        console.error("Failed to copy JSON to clipboard:", err)
      }
    }

    return (
      <div className="w-full overflow-auto bg-gray-50 dark:bg-gray-800 p-6 rounded border border-gray-200 dark:border-gray-700">
        <div className="flex justify-between items-center mb-4 pb-3 border-b border-gray-200 dark:border-gray-600">
          <div className="text-sm text-gray-600 dark:text-gray-200">
            Total Duration: {formatDuration(totalDuration)}
          </div>
          <button
            onClick={handleCopyJson}
            className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 relative group text-sm flex items-center"
          >
            <ClipboardCopy size={18} className="mr-1" />
            {isJsonCopied && (
              <span className="absolute top-full mt-2 left-1/2 transform -translate-x-1/2 bg-gray-800 text-white text-xs rounded py-1 px-2">
                Copied!
              </span>
            )}
          </button>
        </div>
        <div className="text-sm font-mono text-gray-700 dark:text-gray-200">
          <ReactJson
            src={rawTraceData}
            theme={darkMode ? "ocean" : "summerfruit:inverted"}
            indentWidth={2}
            displayDataTypes={false}
            name={false}
            enableClipboard={false} // Using custom copy button
            style={{
              backgroundColor: darkMode
                ? "rgb(31 41 55 / 1)"
                : "rgb(249 250 251 / 1)",
            }} // Match tab background
          />
        </div>
      </div>
    )
  }

  const renderSpanDetailsPanel = () => {
    if (!selectedSpanIds.length) return null
    const validSpans = getValidSpans()
    const selectedSpan = getSelectedSpanDetails(validSpans, selectedSpanIds[0])
    if (!selectedSpan) return null
    if (!showTimeline && activeTab === "timeline") return null

    return (
      <div
        className="bg-gray-50 dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 p-4 overflow-y-auto"
        style={{
          width: `${panelWidth}px`,
          minWidth: "500px",
          maxWidth: "1500px",
        }}
      >
        <div className="flex justify-between items-center mb-4">
          <h4 className="text-lg font-extrabold text-blue-600 dark:text-blue-400">
            {selectedSpan.name || "Span Details"}
          </h4>
          <div className="flex items-center space-x-2">
            <button
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-400"
              onClick={() => navigateToSpan("prev")}
              title="Previous span"
              disabled={validSpans.length <= 1}
            >
              <ChevronLeft size={18} />
            </button>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {selectedSpanIndex + 1} / {validSpans.length}
            </span>
            <button
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-400"
              onClick={() => navigateToSpan("next")}
              title="Next span"
              disabled={validSpans.length <= 1}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
        {renderSpanDetails(selectedSpan)}
      </div>
    )
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    isDragging.current = true
    document.addEventListener("mousemove", handleMouseMove)
    document.addEventListener("mouseup", handleMouseUp)
  }

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging.current) return
    const newWidth = window.innerWidth - e.clientX
    if (newWidth >= 500 && newWidth <= 1500) {
      setPanelWidth(newWidth)
    }
  }

  const handleMouseUp = () => {
    isDragging.current = false
    document.removeEventListener("mousemove", handleMouseMove)
    document.removeEventListener("mouseup", handleMouseUp)
  }

  const toggleDarkMode = () => {
    setDarkMode(!darkMode)
  }

  const toggleTimelineView = () => {
    setShowTimeline(!showTimeline)
  }

  const getFooterDuration = () => {
    if (!traceData?.spans || !Array.isArray(traceData.spans)) return "N/A"
    try {
      const duration = safeCalculateDuration(traceData.spans)
      return formatDuration(duration)
    } catch {
      return "N/A"
    }
  }

  return (
    <div
      className={`flex flex-col h-screen ${
        darkMode ? "dark bg-gray-900" : "bg-gray-100"
      }`}
    >
      <div className="flex justify-between items-center p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center space-x-4">
          <h2 className="text-lg font-bold text-gray-800 dark:text-gray-200">
            Trace Visualization
          </h2>
          <div className="flex space-x-2">
            <button
              className={`px-3 py-1 rounded text-sm font-medium ${
                activeTab === "timeline"
                  ? "bg-blue-500 text-white"
                  : "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600"
              }`}
              onClick={() => setActiveTab("timeline")}
            >
              Timeline
            </button>
            <button
              className={`px-3 py-1 rounded text-sm font-medium ${
                activeTab === "hierarchy"
                  ? "bg-blue-500 text-white"
                  : "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600"
              }`}
              onClick={() => setActiveTab("hierarchy")}
            >
              Hierarchy
            </button>
            <button
              className={`px-3 py-1 rounded text-sm font-medium ${
                activeTab === "json"
                  ? "bg-blue-500 text-white"
                  : "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600"
              }`}
              onClick={() => setActiveTab("json")}
            >
              JSON
            </button>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <button
            className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
            onClick={toggleDarkMode}
            title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
          >
            {darkMode ? <Sun size={20} /> : <Moon size={20} />}
          </button>
          {activeTab === "timeline" && (
            <button
              className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
              onClick={toggleTimelineView}
              title={showTimeline ? "Hide timeline" : "Show timeline"}
            >
              {showTimeline ? <BarChart2 size={20} /> : <Activity size={20} />}
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="p-6 text-center text-gray-500">
              Loading trace data...
            </div>
          ) : error ? (
            <div className="p-6 text-center text-red-500 flex items-center justify-center">
              <AlertCircle size={20} className="mr-2" />
              Error loading trace data: {error.message}
            </div>
          ) : (
            <>
              {activeTab === "timeline" && renderTimeline()}
              {activeTab === "hierarchy" && renderHierarchy()}
              {activeTab === "json" && renderJsonView()}
            </>
          )}
        </div>
        {selectedSpanIds.length > 0 && (
          <div className="flex flex-col">
            <div
              className="w-4 cursor-col-resize flex items-center justify-center bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600"
              onMouseDown={handleMouseDown}
            >
              <GripVertical
                size={16}
                className="text-gray-500 dark:text-gray-400"
              />
            </div>
            {renderSpanDetailsPanel()}
          </div>
        )}
      </div>
      <div className="p-4 border-t border-gray-200 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-400">
        Trace ID: {traceData?.traceId || "N/A"} | Total Duration:{" "}
        {getFooterDuration()}
      </div>
      {isAttributeModalOpen && selectedAttribute && (
        <AttributeModal
          isOpen={isAttributeModalOpen}
          onClose={() => {
            setIsAttributeModalOpen(false)
            setSelectedAttribute(null)
          }}
          attributeKey={selectedAttribute.key}
          attributeValue={selectedAttribute.value}
          darkMode={darkMode}
        />
      )}
    </div>
  )
}
