import { ChevronDown, Sparkles, Terminal } from "lucide-react"
import React, { useRef, useEffect } from "react"

interface AgentThinkingPanelProps {
  thinking: string
  isStreaming?: boolean
  defaultExpanded?: boolean
}

export const AgentThinkingPanel: React.FC<AgentThinkingPanelProps> = ({
  thinking,
  isStreaming = false,
  defaultExpanded = false,
}) => {
  const [expanded, setExpanded] = React.useState(defaultExpanded)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom whenever thinking content changes
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [thinking])

  const hasContent = thinking.trim().length > 0
  const charCount = thinking.length

  if (!hasContent && !isStreaming) {
    return null
  }

  return (
    <div className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-slate-800 overflow-hidden">
      {/* Accordion Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-700/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          <span>Agent Thinking</span>
          {isStreaming && (
            <span className="flex items-center gap-1 text-xs text-blue-500">
              <Sparkles className="w-3 h-3 animate-pulse" />
              <span className="animate-pulse">Thinking...</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <span>{charCount > 0 && `${charCount} chars`}</span>
          <ChevronDown
            className={`w-4 h-4 transition-transform duration-200 ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </div>
      </button>

      {/* Content Panel */}
      {expanded && (
        <div
          ref={scrollRef}
          className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-slate-900 max-h-96 overflow-y-auto overflow-x-hidden"
        >
          <div
            className="p-3 text-xs font-mono text-gray-800 dark:text-gray-200 leading-relaxed"
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              overflowWrap: "break-word",
            }}
          >
            {thinking || (
              <span className="text-gray-400 dark:text-gray-500 italic">
                {isStreaming
                  ? "Waiting for thinking to begin..."
                  : "No thinking content available"}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Preview when collapsed */}
      {!expanded && hasContent && (
        <div className="px-3 py-2 border-t border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-slate-900/50">
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {thinking.split("\n")[0].slice(0, 100)}
            {thinking.length > 100 && "..."}
          </p>
        </div>
      )}
    </div>
  )
}

export default AgentThinkingPanel
