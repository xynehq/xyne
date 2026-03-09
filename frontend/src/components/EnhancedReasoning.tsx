import React, { useState, useEffect, useRef } from "react"
import { Brain } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Citation } from "shared/types"
import ExpandIcon from "@/assets/expand-text-input.svg?react"
import type { ClarificationRequest } from "@/hooks/useChatStream"
import { ReasoningProvider, useReasoningContext } from "./ReasoningContext"
import StreamingReasoning from "./StreamingReasoning"
import MergedReasoning from "./MergedReasoning"

// Re-export utilities that callers may depend on
export { buildReasoningTree } from "./ReasoningContext"

interface EnhancedReasoningProps {
  content: string
  isStreaming?: boolean
  /** Wall-clock ms the backend took to generate this response — shown in the reasoning header. */
  timeTakenMs?: number
  className?: string
  citations?: Citation[]
  citationMap?: Record<number, number>
  clarificationRequest?: ClarificationRequest
  waitingForClarification?: boolean
  onClarificationSelect?: (
    selectedOptionId: string,
    selectedOptionLabel: string,
    customInput?: string,
  ) => void
}

/** Header button — reads progressState from context so it always reflects live data. */
const ReasoningHeader: React.FC<{
  isCollapsed: boolean
  onToggle: () => void
}> = ({ isCollapsed, onToggle }) => {
  const { progressState } = useReasoningContext()
  return (
    <button
      onClick={onToggle}
      className="sticky top-0 z-10 w-full bg-white dark:bg-slate-700 rounded-2xl border border-gray-200 dark:border-gray-700 px-6 py-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-slate-600 transition-colors cursor-pointer"
    >
      <div className="flex items-center gap-3">
        <Brain className="w-5 h-5 text-gray-500 dark:text-gray-300" />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {progressState.text}
        </span>
      </div>
      {isCollapsed && (
        <div className="border px-2 py-1 rounded-xl">
          <ExpandIcon className="w-3.5 h-3.5" />
        </div>
      )}
    </button>
  )
}

/**
 * Top-level reasoning component.
 *
 * Provides ReasoningProvider (the shared context) and conditionally renders:
 *  • StreamingReasoning — multiple boxes while the stream is live
 *  • MergedReasoning    — one big scrollable list once the stream ends
 */
export const EnhancedReasoning: React.FC<EnhancedReasoningProps> = ({
  content,
  isStreaming = false,
  timeTakenMs,
  className,
  citations = [],
  citationMap,
  clarificationRequest,
  waitingForClarification,
  onClarificationSelect,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const hasAutoCollapsedRef = useRef(false)
  const [customClarificationInput, setCustomClarificationInput] = useState("")

  // Reset collapse state when a new stream begins
  useEffect(() => {
    if (isStreaming) {
      setIsCollapsed(false)
      hasAutoCollapsedRef.current = false
    }
  }, [isStreaming])

  // Auto-collapse once when the stream finishes (skip if waiting for clarification)
  useEffect(() => {
    if (
      !isStreaming &&
      content.trim() &&
      !isCollapsed &&
      !hasAutoCollapsedRef.current &&
      !waitingForClarification
    ) {
      setIsCollapsed(true)
      hasAutoCollapsedRef.current = true
    }
  }, [isStreaming, content, isCollapsed, waitingForClarification])

  if (!content.trim() && !isStreaming && !clarificationRequest) return null

  return (
    <ReasoningProvider
      content={content}
      isStreaming={isStreaming}
      timeTakenMs={timeTakenMs}
      citations={citations}
      citationMap={citationMap}
    >
      <div
        className={cn(
          "mb-8 w-full max-w-none rounded-2xl bg-[#F8FAFC] dark:bg-slate-800",
          className,
        )}
      >
        {/* ── Collapsible header ── */}
        <div className="p-1">
          <ReasoningHeader
            isCollapsed={isCollapsed}
            onToggle={() => setIsCollapsed((c) => !c)}
          />
        </div>

        {/* ── Body ── */}
        {!isCollapsed && (
          <>
            {/*
              Streaming  → StreamingReasoning (multi-box, one per delegation)
              Done       → MergedReasoning    (single scrollable list)
            */}
            {isStreaming ? <StreamingReasoning /> : <MergedReasoning />}

            {/* ── HITL clarification UI ── */}
            {waitingForClarification && clarificationRequest && (
              <div className="px-6 pb-6">
                <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                  <div className="flex items-start gap-3 mb-4">
                    <div className="flex-shrink-0 mt-0.5">
                      <svg
                        className="w-5 h-5 text-blue-600 dark:text-blue-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-blue-900 dark:text-blue-100 mb-3">
                        {clarificationRequest.question}
                      </p>
                      <div className="space-y-2">
                        {clarificationRequest.options.map((option) => (
                          <button
                            key={option.id}
                            onClick={() =>
                              onClarificationSelect?.(option.id, option.label)
                            }
                            className="w-full text-left px-4 py-3 bg-white dark:bg-slate-700 border border-gray-200 dark:border-gray-600 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:border-blue-300 dark:hover:border-blue-600 transition-colors"
                          >
                            <span className="text-sm text-gray-700 dark:text-gray-200">
                              {option.label}
                            </span>
                          </button>
                        ))}

                        <div className="mt-4 pt-4 border-t border-blue-200 dark:border-blue-700">
                          <label className="block text-xs font-medium text-blue-800 dark:text-blue-200 mb-2">
                            Or provide a custom response:
                          </label>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={customClarificationInput}
                              onChange={(e) => setCustomClarificationInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && customClarificationInput.trim()) {
                                  onClarificationSelect?.(
                                    "custom",
                                    customClarificationInput.trim(),
                                    customClarificationInput.trim(),
                                  )
                                  setCustomClarificationInput("")
                                }
                              }}
                              placeholder="Enter your custom response..."
                              className="flex-1 px-3 py-2 text-sm bg-white dark:bg-slate-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400"
                            />
                            <button
                              onClick={() => {
                                if (customClarificationInput.trim()) {
                                  onClarificationSelect?.(
                                    "custom",
                                    customClarificationInput.trim(),
                                    customClarificationInput.trim(),
                                  )
                                  setCustomClarificationInput("")
                                }
                              }}
                              disabled={!customClarificationInput.trim()}
                              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed rounded-lg transition-colors"
                            >
                              Submit
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </ReasoningProvider>
  )
}

export default EnhancedReasoning
