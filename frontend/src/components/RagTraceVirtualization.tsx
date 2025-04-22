import { useState, useMemo, useEffect, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/api"
import {
  AlertCircle,
  Moon,
  Sun,
  Code,
  X,
  BarChart2,
  Activity,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  GripVertical,
} from "lucide-react"

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
  chatInternalId?: string
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

interface Citation {
  docId: string
  title: string
  url: string
  app: string
  entity: string
  [key: string]: any
}

interface CitationMap {
  [key: string]: number // Maps citation key (e.g., "15") to index (e.g., 0)
}

interface RagTraceVirtualizationProps {
  chatId: string
  messageId: string
  onClose: () => void
}

interface SafeSpan extends TraceSpan {
  children?: SafeSpan[]
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

const parseCitationValues = (citationValues: any): Record<string, Citation> => {
  if (typeof citationValues === "string") {
    try {
      return JSON.parse(citationValues)
    } catch (e) {
      console.error("Failed to parse citation_values:", e)
      return {}
    }
  }
  return citationValues || {}
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

export function RagTraceVirtualization({
  chatId,
  messageId,
  onClose,
}: RagTraceVirtualizationProps) {
  const [selectedSpanIds, setSelectedSpanIds] = useState<string[]>([])
  const [selectedSpanIndex, setSelectedSpanIndex] = useState<number>(0)
  const [activeTab, setActiveTab] = useState<"timeline" | "json">("timeline")
  const [darkMode, setDarkMode] = useState(true)
  const [showSpanDetails, setShowSpanDetails] = useState(true)
  const [showTimeline, setShowTimeline] = useState(true)
  const [showCitationColumn, setShowCitationColumn] = useState(true)
  const [panelWidth, setPanelWidth] = useState(750)
  const [currentCitationIndex, setCurrentCitationIndex] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)

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
      spanId:
        span.spanId ||
        span.id ||
        span.name ||
        `span-${Math.random().toString(36).substr(2, 9)}`,
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
    const understandSpan = traceData?.spans?.find(
      (span: SafeSpan) => span.name === "understand_message",
    )
    if (!understandSpan || !understandSpan.attributes)
      return { citationValues: {}, citationMap: {}, indexToKey: {} }

    const citationValues = parseCitationValues(
      understandSpan.attributes["citation_values"],
    )
    const citationMap: CitationMap =
      understandSpan.attributes["citation_map"] || {}

    // Create a mapping from final_answer index (e.g., 1) to citation_values key (e.g., "15")
    const indexToKey: { [index: string]: string } = {}
    Object.entries(citationMap).forEach(([key, index]) => {
      indexToKey[(index + 1).toString()] = key
    })

    return { citationValues, citationMap, indexToKey }
  }, [traceData])

  useEffect(() => {
    if (
      traceData?.spans &&
      traceData.spans.length > 0 &&
      selectedSpanIds.length === 0
    ) {
      const firstSpan = traceData.spans.find((span: SafeSpan) =>
        validateSpanData(span),
      )
      if (firstSpan?.spanId) {
        setSelectedSpanIds([firstSpan.spanId])
        const index = traceData.spans.indexOf(firstSpan)
        setSelectedSpanIndex(index >= 0 ? index : 0)
        setShowSpanDetails(true)
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

  const getValidSpans = () => {
    if (!traceData?.spans || !Array.isArray(traceData.spans)) return []
    return traceData.spans.filter(validateSpanData)
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

  const handleCitationClick = (citationIndex: string) => {
    const citationKey = citationData.indexToKey[citationIndex]
    if (!citationKey || !citationData.citationValues[citationKey]) return

    // Update currentCitationIndex to show the clicked citation
    const citationEntries = Object.entries(citationData.citationValues)
    const newCitationIndex = citationEntries.findIndex(
      ([key]) => key === citationKey,
    )
    if (newCitationIndex >= 0) {
      setCurrentCitationIndex(newCitationIndex)
      setShowCitationColumn(true) // Ensure citation column is visible
    }

    // Try to find a span with a matching docId or related attribute
    const spans = traceData?.spans || []
    const citation = citationData.citationValues[citationKey]
    const span = spans.find(
      (s: SafeSpan) =>
        s.attributes?.result_ids?.includes(citation.docId) ||
        s.attributes?.docId === citation.docId,
    )

    if (span?.spanId) {
      const index = spans.findIndex((s: SafeSpan) => s.spanId === span.spanId)
      if (index >= 0) {
        setSelectedSpanIds([span.spanId])
        setSelectedSpanIndex(index)
        setShowSpanDetails(true)
        setShowTimeline(true)
      }
    }
  }

  useEffect(() => {
    if (!contentRef.current || !Object.keys(citationData.citationValues).length)
      return

    const processNode = (node: Node) => {
      if (node.nodeType !== Node.TEXT_NODE) return

      const text = node.textContent || ""
      const regex = /\[(\d+)\]/g
      let match
      let lastIndex = 0
      const fragments: (Node | HTMLElement)[] = []

      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          fragments.push(
            document.createTextNode(text.substring(lastIndex, match.index)),
          )
        }

        const citationIndex = match[1]
        const citationKey = citationData.indexToKey[citationIndex]
        if (citationKey && citationData.citationValues[citationKey]) {
          const span = document.createElement("span")
          span.textContent = `[${citationIndex}]`
          span.className =
            "text-blue-500 cursor-pointer font-bold hover:underline"
          span.dataset.citation = citationIndex
          span.onclick = () => handleCitationClick(citationIndex)
          fragments.push(span)
        } else {
          fragments.push(document.createTextNode(match[0]))
        }

        lastIndex = match.index + match[0].length
      }

      if (lastIndex < text.length) {
        fragments.push(document.createTextNode(text.substring(lastIndex)))
      }

      if (fragments.length > 1) {
        const parent = node.parentNode
        if (parent) {
          fragments.forEach((fragment) => {
            parent.insertBefore(fragment, node)
          })
          parent.removeChild(node)
        }
      }
    }

    const walker = document.createTreeWalker(
      contentRef.current,
      NodeFilter.SHOW_TEXT,
      null,
    )

    let node: Node | null = walker.nextNode()
    while (node) {
      processNode(node)
      node = walker.nextNode()
    }
  }, [contentRef.current, citationData])

  const renderAnswerText = () => {
    const answerText = traceData?.spans?.find(
      (span: SafeSpan) => span.attributes?.["final_answer"],
    )?.attributes?.["final_answer"]
    if (!answerText) return null

    return (
      <div className="mb-4 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        <h4 className="text-sm font-bold mb-2">Answer</h4>
        <div
          className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap"
          ref={contentRef}
        >
          {answerText}
        </div>
      </div>
    )
  }

  const renderAttributesTable = (attributes: Record<string, any>) => {
    if (!attributes || Object.keys(attributes).length === 0) {
      return (
        <div className="text-sm text-gray-500 italic">
          No attributes available
        </div>
      )
    }

    const sortedKeys = Object.keys(attributes).sort((a, b) =>
      a.localeCompare(b),
    )

    return (
      <div className="overflow-auto max-h-96 border border-gray-200 dark:border-gray-700 rounded">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100 dark:bg-gray-800">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">
                Key
              </th>
              <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedKeys.map((key, index) => {
              const value = attributes[key]
              const isUrl =
                typeof value === "string" && /^https?:\/\//.test(value)
              const isLongText = typeof value === "string" && value.length > 100

              return (
                <tr
                  key={key}
                  className={
                    index % 2 === 0
                      ? "bg-white dark:bg-gray-900"
                      : "bg-gray-50 dark:bg-gray-800"
                  }
                >
                  <td className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 font-medium">
                    {key}
                  </td>
                  <td className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 font-mono">
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
                      <div className="max-h-32 overflow-y-auto whitespace-pre-wrap text-xs bg-white dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-700">
                        {value}
                      </div>
                    ) : typeof value === "object" && value !== null ? (
                      <div className="whitespace-pre-wrap text-xs bg-white dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-700">
                        {JSON.stringify(value, null, 2)}
                      </div>
                    ) : (
                      String(value)
                    )}
                  </td>
                </tr>
              )
            })}
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
          <h5 className="font-bold text-sm">Attributes</h5>
          <button
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 flex items-center"
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
            <div className="mt-4 border-t pt-4 border-gray-200 dark:border-gray-700">
              <h5 className="font-bold text-sm mb-2">Span Details</h5>
              <div className="grid grid-cols-2 gap-2 text-sm">
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
                <h5 className="font-bold text-sm mb-2">
                  Events ({span.events.length})
                </h5>
                <div className="bg-white dark:bg-gray-900 p-2 rounded border border-gray-200 dark:border-gray-700 max-h-48 overflow-y-auto">
                  <pre className="text-sm whitespace-pre-wrap">
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

  const renderCitationColumn = () => {
    if (!Object.keys(citationData.citationValues).length || !showCitationColumn)
      return null

    const citationEntries = Object.entries(citationData.citationValues)
    if (citationEntries.length === 0) return null

    const [key, citation] = citationEntries[currentCitationIndex]
    const citationIndex = Object.entries(citationData.indexToKey).find(
      ([_, k]) => k === key,
    )?.[0]

    const handleNextCitation = () => {
      setCurrentCitationIndex((prev) => (prev + 1) % citationEntries.length)
    }

    const handlePrevCitation = () => {
      setCurrentCitationIndex(
        (prev) => (prev - 1 + citationEntries.length) % citationEntries.length,
      )
    }

    return (
      <div className="mt-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        <div className="flex justify-between items-center mb-4">
          <h4 className="font-bold text-sm">Citation Details</h4>
          <div className="flex space-x-2">
            <button
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 disabled:opacity-50"
              onClick={handlePrevCitation}
              disabled={citationEntries.length <= 1}
              title="Previous citation"
            >
              <ChevronLeft size={18} />
            </button>
            <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center">
              {currentCitationIndex + 1} / {citationEntries.length}
            </div>
            <button
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 disabled:opacity-50"
              onClick={handleNextCitation}
              disabled={citationEntries.length <= 1}
              title="Next citation"
            >
              <ChevronRight size={18} />
            </button>
            <button
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 flex items-center"
              onClick={() => setShowCitationColumn(false)}
              title="Hide citations"
            >
              <EyeOff size={18} />
            </button>
          </div>
        </div>
        <div
          className="p-4 rounded border border-gray-200 dark:border-gray-700 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
          onClick={() => citationIndex && handleCitationClick(citationIndex)}
        >
          <div className="text-sm font-bold mb-2 border-b border-gray-200 dark:border-gray-700 pb-2">
            Citation #{key}
          </div>
          <div className="text-sm pt-2">
            <div className="flex border-b border-gray-200 dark:border-gray-700 py-2">
              <span className="font-medium w-20">Title:</span>
              <span className="flex-1">{citation.title}</span>
            </div>
            <div className="flex border-b border-gray-200 dark:border-gray-700 py-2">
              <span className="font-medium w-20">URL:</span>
              <span className="flex-1">
                <a
                  href={citation.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:underline"
                >
                  {citation.url}
                </a>
              </span>
            </div>
            <div className="flex border-b border-gray-200 dark:border-gray-700 py-2">
              <span className="font-medium w-20">App:</span>
              <span className="flex-1">{citation.app}</span>
            </div>
            <div className="flex pt-2">
              <span className="font-medium w-20">Entity:</span>
              <span className="flex-1">{citation.entity}</span>
            </div>
          </div>
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
    const selectedSpan =
      selectedSpanIds.length > 0
        ? getSelectedSpanDetails(validSpans, selectedSpanIds[0])
        : undefined

    const sortedSpans = [...validSpans].sort((a, b) => {
      const timeComparison = (a.startTime ?? 0) - (b.startTime ?? 0)
      if (timeComparison !== 0) return timeComparison
      if (a.parentSpanId === b.spanId) return 1
      if (b.parentSpanId === a.spanId) return -1
      return (a.duration ?? 0) - (b.duration ?? 0)
    })

    return (
      <div className="w-full p-4" ref={contentRef}>
        <div className="mb-4 text-sm text-gray-600 dark:text-gray-300 pb-3 border-b border-gray-200 dark:border-gray-700">
          Total Duration: {formatDuration(totalDuration)}
        </div>
        {renderAnswerText()}
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

              return (
                <div key={spanId} className="flex items-center mb-4 group">
                  <div
                    className={`w-56 pr-6 text-sm font-medium truncate cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 ${
                      selectedSpanIds.includes(spanId)
                        ? "text-blue-600 dark:text-blue-400"
                        : "text-gray-700 dark:text-gray-300"
                    }`}
                    style={{ cursor: "pointer" }}
                    onClick={() => toggleSelected(spanId)}
                  >
                    {displayName}
                  </div>
                  <div className="flex-1 relative h-8">
                    <div className="absolute inset-0 bg-gray-100 dark:bg-gray-800 rounded" />
                    <div
                      className={`absolute h-5 top-1.5 rounded cursor-pointer ${
                        selectedSpanIds.includes(spanId)
                          ? "bg-blue-700"
                          : "bg-blue-500 hover:bg-blue-600"
                      }`}
                      style={{
                        left: `${Math.max(0, Math.min(100, startOffset))}%`,
                        width: `${durationPercent}%`,
                      }}
                      onClick={() => toggleSelected(spanId)}
                      title={`${displayName}\nStart: ${new Date(span.startTime || 0).toLocaleString()}\nDuration: ${formatDuration(duration)}`}
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
          selectedSpan && (
            <div className="mt-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
              <div className="flex justify-between items-center mb-4">
                <h4 className="font-bold text-sm">
                  {selectedSpan.name || "Span Details"}
                </h4>
                <div className="flex space-x-2">
                  <button
                    className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
                    onClick={() => navigateToSpan("prev")}
                    title="Previous span"
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center">
                    {selectedSpanIndex + 1} / {validSpans.length}
                  </div>
                  <button
                    className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
                    onClick={() => navigateToSpan("next")}
                    title="Next span"
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
              </div>
              {renderSpanDetails(selectedSpan)}
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

    return (
      <div className="w-full overflow-auto bg-gray-50 dark:bg-gray-900 p-6 rounded border border-gray-200 dark:border-gray-700">
        <div className="mb-4 text-sm text-gray-600 dark:text-gray-300 pb-3 border-b border-gray-200 dark:border-gray-700">
          Total Duration: {formatDuration(totalDuration)}
        </div>
        <pre className="text-sm whitespace-pre-wrap font-mono">
          {JSON.stringify(rawTraceData, null, 2)}
        </pre>
      </div>
    )
  }

  const renderSpanDetailsPanel = () => {
    if (!selectedSpanIds.length) return null
    const validSpans = getValidSpans()
    const selectedSpan = getSelectedSpanDetails(validSpans, selectedSpanIds[0])
    if (!selectedSpan) return null

    if (!showTimeline) return null

    return (
      <div
        className="bg-gray-50 dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 p-4 overflow-y-auto"
        style={{
          width: `${panelWidth}px`,
          minWidth: "200px",
          maxWidth: "800px",
        }}
      >
        <div className="flex justify-between items-center mb-4">
          <h4 className="font-bold text-sm">
            {selectedSpan.name || "Span Details"}
          </h4>
          <div className="flex space-x-2">
            <button
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
              onClick={() => navigateToSpan("prev")}
              title="Previous span"
            >
              <ChevronLeft size={18} />
            </button>
            <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center">
              {selectedSpanIndex + 1} / {validSpans.length}
            </div>
            <button
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
              onClick={() => navigateToSpan("next")}
              title="Next span"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
        {renderSpanDetails(selectedSpan)}
        {!showCitationColumn &&
          Object.keys(citationData.citationValues).length > 0 && (
            <button
              className="mt-4 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 flex items-center"
              onClick={() => setShowCitationColumn(true)}
              title="Show citations"
            >
              <Eye size={18} />
              <span className="ml-1 text-xs">Show citations</span>
            </button>
          )}
        {renderCitationColumn()}
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
    if (newWidth >= 200 && newWidth <= 800) {
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

  const getSpanCount = () => {
    return traceData?.spans && Array.isArray(traceData.spans)
      ? traceData.spans.length
      : 0
  }

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode)
    return () => document.documentElement.classList.remove("dark")
  }, [darkMode])

  const getSelectedSpanDetails = (
    spans: SafeSpan[],
    selectedId: string,
  ): SafeSpan | undefined => {
    return spans.find((span: SafeSpan) => span.spanId === selectedId)
  }

  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
        </div>
      )
    }
    if (error) {
      return (
        <div className="flex-1 flex items-center justify-center text-red-500">
          <AlertCircle size={24} className="mr-2" />
          <span>
            Error loading trace data:{" "}
            {error instanceof Error ? error.message : "Unknown error"}
          </span>
        </div>
      )
    }
    return (
      <div className="flex-1 overflow-auto">
        {activeTab === "timeline" && renderTimeline()}
        {activeTab === "json" && renderJsonView()}
      </div>
    )
  }

  return (
    <div className={darkMode ? "dark" : ""}>
      <div className="fixed inset-0 z-50 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100">
        <div className="w-full h-full flex flex-col shadow-lg border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 p-4">
            <div className="flex items-center">
              <Activity
                size={24}
                className="mr-2 text-blue-600 dark:text-blue-400"
              />
              <h2 className="font-bold text-lg">
                Trace Explorer:{" "}
                {traceData?.traceId || rawTraceData?.chatId || "Loading..."}
              </h2>
              {traceData?.spans && (
                <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">
                  ({formatDuration(safeCalculateDuration(traceData.spans))})
                </span>
              )}
            </div>
            <div className="flex items-center space-x-2">
              <button
                className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800"
                onClick={toggleDarkMode}
                title="Toggle dark mode"
              >
                {darkMode ? <Sun size={20} /> : <Moon size={20} />}
              </button>
              <button
                className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800"
                onClick={onClose}
                title="Close"
              >
                <X size={20} />
              </button>
            </div>
          </div>
          <div className="border-b border-gray-200 dark:border-gray-700 p-2 flex justify-end">
            <div className="flex space-x-1">
              <button
                className={`px-3 py-1 rounded-md text-sm flex items-center ${
                  activeTab === "timeline"
                    ? "bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200"
                    : "hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
                onClick={() => setActiveTab("timeline")}
              >
                <BarChart2 size={16} className="mr-1" />
                Timeline
              </button>
              <button
                className={`px-3 py-1 rounded-md text-sm flex items-center ${
                  activeTab === "json"
                    ? "bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200"
                    : "hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
                onClick={() => setActiveTab("json")}
              >
                <Code size={16} className="mr-1" />
                JSON
              </button>
              {activeTab === "timeline" && (
                <button
                  className="px-3 py-1 rounded-md text-sm flex items-center hover:bg-gray-100 dark:hover:bg-gray-800"
                  onClick={toggleTimelineView}
                  title={
                    showTimeline ? "Show only selected span" : "Show timeline"
                  }
                >
                  {showTimeline ? (
                    <EyeOff size={16} className="mr-1" />
                  ) : (
                    <Eye size={16} className="mr-1" />
                  )}
                  {showTimeline ? "Span Only" : "Timeline"}
                </button>
              )}
            </div>
          </div>
          <div className="flex-1 flex overflow-hidden">
            {renderContent()}
            {activeTab === "timeline" && (
              <>
                {renderSpanDetailsPanel() && (
                  <div
                    className="w-2 bg-gray-200 dark:bg-gray-700 cursor-col-resize flex items-center justify-center hover:bg-gray-300 dark:hover:bg-gray-600"
                    onMouseDown={handleMouseDown}
                  >
                    <GripVertical
                      size={16}
                      className="text-gray-500 dark:text-gray-400"
                    />
                  </div>
                )}
                {renderSpanDetailsPanel()}
              </>
            )}
          </div>
          <div className="border-t border-gray-200 dark:border-gray-700 p-2 text-sm text-gray-500 dark:text-gray-400 flex justify-between">
            <div>{traceData ? `${getSpanCount()} spans` : "No data"}</div>
            <div>
              {traceData && traceData.spans && traceData.spans.length > 0 && (
                <>Total Duration: {getFooterDuration()}</>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
