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
  attributes?: Record<string, any>
  duration?: number
  endTime?: number
  events?: any[]
  name?: string
  parentSpanId?: string | null
  spanId?: string
  startTime?: number
  traceId?: string
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

interface RagTraceVirtualizationProps {
  chatId: string
  messageId: string
  onClose: () => void
}

interface SafeSpan extends TraceSpan {
  children?: SafeSpan[]
  citationNumber?: number
}

interface CitationReference {
  number: number
  spanId: string
}

const fetchChatTrace = async (
  chatId: string,
  messageId: string,
): Promise<TraceJson> => {
  try {
    const res = await api.chat.trace.$get({
      query: { chatId, messageId },
    })
    console.log(res)
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

const parseCitationItem = (citationItemStr: string): any => {
  try {
    return JSON.parse(citationItemStr)
  } catch (e) {
    return { raw: citationItemStr }
  }
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

const extractCitationInfo = (span: SafeSpan): any => {
  if (!span.attributes) return null

  const citationItem = span.attributes["citation.item"]

  if (!citationItem) return null

  try {
    if (typeof citationItem === "string") {
      return parseCitationItem(citationItem)
    }
    return citationItem
  } catch (e) {
    return { raw: citationItem }
  }
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
  const [citationReferences, setCitationReferences] = useState<
    CitationReference[]
  >([])
  const [showTimeline, setShowTimeline] = useState(true)
  const [panelWidth, setPanelWidth] = useState(420) // Initial width in pixels (equivalent to w-96)
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

    const citationRefs: CitationReference[] = []

    const normalizedSpans = spans.map((span: any) => {
      const isVespaSearch = span.name === "vespaSearch"
      let citationNumber = null
      let citationData = null

      if (isVespaSearch && span.attributes?.["citation.index"] != null) {
        citationNumber = Number(span.attributes["citation.index"])
        citationData = extractCitationInfo(span)

        citationRefs.push({
          number: citationNumber,
          spanId:
            span.spanId ||
            span.id ||
            `span-${Math.random().toString(36).substr(2, 9)}`,
        })
      }

      const attributes = { ...(span.attributes || {}) }
      if (citationData && citationNumber != null) {
        if (typeof citationData === "object" && citationData !== null) {
          Object.entries(citationData).forEach(([key, value]) => {
            attributes[key] = value // Use base key (e.g., 'id' instead of 'citation.data.id')
          })
        }
        delete attributes["citation.item"] // Remove citation.item
        delete attributes["citation.number"] // Remove citation.number
      }

      return {
        ...span,
        spanId:
          span.spanId ||
          span.id ||
          span.name ||
          `span-${Math.random().toString(36).substr(2, 9)}`,
        parentSpanId: span.parentSpanId || span.parentId || null,
        name:
          isVespaSearch && citationNumber != null
            ? `Citation ${citationNumber}`
            : span.name || span.spanId || "Unnamed Span",
        startTime: span.startTime != null ? Number(span.startTime) : null,
        endTime: span.endTime != null ? Number(span.endTime) : null,
        duration:
          span.duration != null
            ? Number(span.duration)
            : span.startTime != null && span.endTime != null
              ? Number(span.endTime) - Number(span.startTime)
              : null,
        attributes: attributes,
        events: span.events || [],
        citationNumber,
      }
    })

    citationRefs.sort((a, b) => a.number - b.number)

    setCitationReferences(citationRefs)

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

  const handleCitationClick = (citationNumber: number) => {
    if (citationNumber == null || !citationReferences) return

    const reference = citationReferences.find(
      (ref) => ref.number === citationNumber,
    )
    if (!reference?.spanId) return

    const spans = traceData?.spans || []
    const index = spans.findIndex(
      (span: SafeSpan) => span.spanId === reference.spanId,
    )

    if (index >= 0) {
      setSelectedSpanIds([reference.spanId])
      setSelectedSpanIndex(index)
      setShowSpanDetails(true)
    }
  }

  useEffect(() => {
    if (!contentRef.current || !citationReferences?.length) return

    const processNode = (node: Node) => {
      if (node.nodeType !== Node.TEXT_NODE) return

      const text = node.textContent || ""
      const regex = /\[(\d+)\]/g
      let match
      let lastIndex = 0
      const fragments: (Node | Text)[] = []

      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          fragments.push(
            document.createTextNode(text.substring(lastIndex, match.index)),
          )
        }

        const citationNumber = parseInt(match[1], 10)
        if (
          !isNaN(citationNumber) &&
          citationReferences.some((ref) => ref.number === citationNumber)
        ) {
          const span = document.createElement("span")
          span.textContent = `[${citationNumber}]`
          span.className =
            "text-blue-500 cursor-pointer font-bold hover:underline"
          span.dataset.citation = citationNumber.toString()
          span.onclick = () => handleCitationClick(citationNumber)
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
  }, [contentRef.current, citationReferences])

  const renderAnswerText = () => {
    const answerText = traceData?.spans?.find(
      (span: SafeSpan) => span.attributes?.["answer.text"],
    )?.attributes?.["answer.text"]
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
                    ) : typeof value === "object" ? (
                      <div className="whitespace-pre-wrap text-xs bg-white dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-700">
                        {renderNestedObject(value)}
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

  const renderNestedObject = (obj: any, indent = 0): JSX.Element => {
    if (typeof obj !== "object" || obj === null) {
      return <span>{String(obj)}</span>
    }

    if (Array.isArray(obj)) {
      return (
        <div>
          {obj.map((item, idx) => (
            <div key={idx} style={{ marginLeft: `${indent * 8}px` }}>
              - {renderNestedObject(item, indent + 1)}
            </div>
          ))}
        </div>
      )
    }

    return (
      <div>
        {Object.entries(obj).map(([key, value], idx) => (
          <div key={key} style={{ marginLeft: `${indent * 8}px` }}>
            <span className="font-medium">{key}: </span>
            {typeof value === "object" ? (
              <div style={{ marginLeft: "8px" }}>
                {renderNestedObject(value, indent + 1)}
              </div>
            ) : (
              <span>{String(value)}</span>
            )}
          </div>
        ))}
      </div>
    )
  }

  const renderSpanBasicInfo = (span: SafeSpan) => {
    if (!span) return null

    return (
      <div className="mb-4">
        <div className="flex justify-between items-center mb-2">
          <h5 className="font-bold text-sm">
            {span.citationNumber ? (
              <span className="flex items-center">
                <span className="bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 px-2 py-0.5 rounded-full text-xs mr-2">
                  Citation #{span.citationNumber}
                </span>
                Attributes
              </span>
            ) : (
              "Attributes"
            )}
          </h5>
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

  const renderCitationReferences = () => {
    if (citationReferences.length === 0) return null

    return (
      <div className="mb-4 border-b border-gray-200 dark:border-gray-700 pb-3">
        <h4 className="text-sm font-bold mb-2">Citations</h4>
        <div className="flex flex-wrap gap-2">
          {citationReferences.map((ref) => (
            <button
              key={ref.spanId}
              className={`px-2 py-1 text-xs rounded-full font-medium ${
                selectedSpanIds.includes(ref.spanId)
                  ? "bg-blue-500 text-white"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
              }`}
              onClick={() => toggleSelected(ref.spanId)}
            >
              {ref.number}
            </button>
          ))}
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

        {renderCitationReferences()}

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
                (duration / totalDuration) * 100,
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
                        width: `${Math.min(100, durationPercent)}%`,
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
      <div className="flex-1 overflow-auto p-4">
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
