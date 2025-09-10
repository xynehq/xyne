import React, { useState, useEffect, useRef } from "react"
import {
  ChevronDown,
  ChevronUp,
  Brain,
  Search,
  Globe,
  FileText,
  Zap,
  Loader2,
  ExternalLink,
} from "lucide-react"
import { cn } from "@/lib/utils"

interface DeepResearchStep {
  id: string
  type: "reasoning" | "web_search" | "analysis" | "synthesis"
  title: string
  content?: string
  sourceUrl?: string
  sourcesCount?: number
  recentSources?: string[]
  timestamp: number
  status: "active" | "completed" | "error"
  query?: string // Search query for web_search steps
  focus?: string // What the reasoning/analysis is focusing on
  stepNumber?: number // Sequential number for same type steps
  isReasoningDelta?: boolean // Whether this is a delta update for reasoning content
  fullReasoningContent?: string // Complete reasoning content when step is done
}

interface DeepResearchReasoningProps {
  steps: DeepResearchStep[]
  isStreaming?: boolean
  className?: string
}

const getStepIcon = (type: string, status: string) => {
  const iconClass = "w-4 h-4"

  if (status === "active") {
    return <Loader2 className={cn(iconClass, "animate-spin text-slate-600")} />
  }

  switch (type) {
    case "reasoning":
      return <Brain className={cn(iconClass, "text-slate-600")} />
    case "web_search":
      return <Search className={cn(iconClass, "text-slate-600")} />
    case "analysis":
      return <FileText className={cn(iconClass, "text-slate-600")} />
    case "synthesis":
      return <Zap className={cn(iconClass, "text-slate-600")} />
    default:
      return <Globe className={cn(iconClass, "text-slate-500")} />
  }
}

const getStepColor = (type: string, status: string) => {
  if (status === "pending") return "text-slate-400"
  if (status === "active") return "text-slate-700"

  switch (type) {
    case "reasoning":
      return "text-slate-700"
    case "web_search":
      return "text-slate-700"
    case "analysis":
      return "text-slate-700"
    case "synthesis":
      return "text-slate-700"
    default:
      return "text-slate-600"
  }
}

const getEnhancedStepTitle = (
  step: DeepResearchStep,
  stepCounts: Record<string, number>,
) => {
  const typeCount = stepCounts[step.type] || 0

  // If the step already has a descriptive title, use it as-is (unless it's generic)
  if (
    step.title &&
    step.title !== "Reasoning" &&
    step.title !== "💭 Reasoning" &&
    step.title !== "Processing..." &&
    step.title !== "Web search completed"
  ) {
    return step.title
  }

  switch (step.type) {
    case "web_search":
      if (step.query) {
        return `Searched: "${step.query}"`
      }
      return `Web search ${typeCount > 1 ? `#${typeCount}` : ""}`

    case "reasoning":
      // Show a preview of the reasoning content if available
      if (step.content && step.content.length > 0) {
        const preview = step.content.substring(0, 80).replace(/\n/g, " ").trim()
        const suffix = step.content.length > 80 ? "..." : ""
        return `${preview}${suffix}`
      }
      if (
        step.focus &&
        step.focus !== "Analyzing and thinking through the problem"
      ) {
        return `${step.focus}`
      }
      if (step.query) {
        return `Analyzing search results for "${step.query}"`
      }
      return `Reasoning ${typeCount > 1 ? `#${typeCount}` : ""}`

    case "analysis":
      if (step.focus && step.focus !== step.title) {
        return `Analyzing: ${step.focus}`
      }
      return `Analysis ${typeCount > 1 ? `#${typeCount}` : ""}`

    case "synthesis":
      return `Synthesizing findings`

    default:
      return step.title
  }
}

export const DeepResearchReasoning: React.FC<DeepResearchReasoningProps> = ({
  steps,
  isStreaming = false,
  className,
}) => {
  const [isExpanded, setIsExpanded] = useState(true)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [userHasScrolled, setUserHasScrolled] = useState(false)

  // Auto-scroll to bottom when new steps arrive during streaming
  useEffect(() => {
    if (isStreaming && !userHasScrolled && scrollContainerRef.current) {
      const container = scrollContainerRef.current
      setTimeout(() => {
        container.scrollTo({
          top: container.scrollHeight,
          behavior: "smooth",
        })
      }, 10)
    }
  }, [steps, isStreaming, userHasScrolled])

  // Handle manual scrolling by user
  const handleScroll = () => {
    const container = scrollContainerRef.current
    if (!container) return

    const threshold = 10
    const isAtBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      threshold

    setUserHasScrolled(!isAtBottom)
  }

  // Reset user scroll state when streaming starts
  useEffect(() => {
    if (isStreaming) {
      setUserHasScrolled(false)
    }
  }, [isStreaming])

  // Auto-collapse when streaming ends
  useEffect(() => {
    if (!isStreaming && steps.length > 0) {
      // Small delay to let user see the final state before collapsing
      const timer = setTimeout(() => {
        setIsExpanded(false)
      }, 2000)
      return () => clearTimeout(timer)
    }
  }, [isStreaming, steps.length])

  if (steps.length === 0 && !isStreaming) {
    return null
  }

  const activeStep = steps.find((step) => step.status === "active")
  const completedSteps = steps.filter((step) => step.status === "completed")

  // Get the latest step (either active or most recent)
  const latestStep = activeStep || steps[steps.length - 1]

  // Calculate step counts for each type to show step numbers
  const stepCounts: Record<string, number> = {}
  steps.forEach((step) => {
    stepCounts[step.type] = (stepCounts[step.type] || 0) + 1
  })

  // Calculate total sources count from the latest step that has sourcesCount
  const totalSourcesCount = steps.reduce((max, step) => {
    return Math.max(max, step.sourcesCount || 0)
  }, 0)

  return (
    <div
      className={cn(
        "mb-6 w-full max-w-none rounded-2xl bg-gradient-to-r from-slate-50 to-slate-100 dark:from-slate-800 dark:to-slate-700",
        className,
      )}
    >
      <div className="p-1">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="sticky top-0 z-10 w-full bg-white dark:bg-slate-700 rounded-2xl border border-slate-200 dark:border-slate-600 px-6 py-3 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-3">
            {isStreaming && latestStep ? (
              getStepIcon(latestStep.type, latestStep.status)
            ) : (
              <Brain className="w-5 h-5 text-slate-600" />
            )}
            {isStreaming && (!latestStep || latestStep.status !== "active") && (
              <Loader2 className="w-4 h-4 animate-spin text-slate-600" />
            )}
            <span className="text-sm font-medium text-slate-700 dark:text-gray-300">
              {isStreaming
                ? latestStep
                  ? getEnhancedStepTitle(latestStep, stepCounts)
                  : "Deep research in progress..."
                : `Deep research completed • ${completedSteps.length} steps`}
            </span>
            {totalSourcesCount > 0 && (
              <div className="flex items-center gap-1 px-2 py-1 bg-slate-100 dark:bg-blue-900 rounded-full">
                <ExternalLink className="w-3 h-3 text-slate-600 dark:text-blue-400" />
                <span className="text-xs font-medium text-slate-700 dark:text-blue-300">
                  {totalSourcesCount} sources
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            {isExpanded ? (
              <ChevronUp className="w-4 h-4 text-slate-500" />
            ) : (
              <ChevronDown className="w-4 h-4 text-slate-500" />
            )}
          </div>
        </button>
      </div>

      {/* Content */}
      {isExpanded && (
        <div className="px-6 pb-6 pt-4">
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="space-y-3 max-h-80 overflow-y-auto pr-2"
            style={{
              scrollbarWidth: "thin",
              scrollbarColor: "#CBD5E0 transparent",
            }}
          >
            {steps.map((step, index) => {
              // Calculate current step count for this type up to this index
              const currentStepCounts: Record<string, number> = {}
              steps.slice(0, index + 1).forEach((s) => {
                currentStepCounts[s.type] = (currentStepCounts[s.type] || 0) + 1
              })

              return (
                <div
                  key={step.id}
                  className={cn(
                    "flex items-start gap-3 p-3 rounded-lg transition-all duration-200",
                    step.status === "active" &&
                      "bg-slate-100 dark:bg-slate-600/30",
                    step.status === "completed" &&
                      "bg-white dark:bg-slate-600/50",
                    step.status === "error" && "bg-red-50 dark:bg-red-900/20",
                  )}
                >
                  <div className="flex-shrink-0 mt-0.5">
                    {getStepIcon(step.type, step.status)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      className={cn(
                        "text-sm font-medium",
                        getStepColor(step.type, step.status),
                      )}
                    >
                      {getEnhancedStepTitle(step, currentStepCounts)}
                    </div>
                    {step.content && (
                      <div className="text-xs text-slate-600 dark:text-gray-400 mt-1 max-h-55 overflow-y-auto">
                        {step.type === "reasoning" &&
                        step.content.length > 150 ? (
                          <details className="cursor-pointer">
                            <summary className="hover:text-slate-800 dark:hover:text-gray-200">
                              {step.content.substring(0, 150)}...
                              <span className="text-slate-600 ml-1">
                                (click to expand)
                              </span>
                            </summary>
                            <div className="mt-2 p-4 bg-slate-50 dark:bg-slate-700 rounded text-sm whitespace-pre-wrap max-h-64 overflow-y-auto">
                              {step.content}
                            </div>
                          </details>
                        ) : (
                          <span
                            className={
                              step.type === "reasoning"
                                ? "whitespace-pre-wrap"
                                : ""
                            }
                          >
                            {step.content}
                          </span>
                        )}
                      </div>
                    )}
                    {step.fullReasoningContent &&
                      step.fullReasoningContent !== step.content && (
                        <div className="text-xs text-slate-600 dark:text-gray-400 mt-1">
                          <details className="cursor-pointer">
                            <summary className="text-slate-600 hover:text-slate-700">
                              View complete reasoning
                            </summary>
                            <div className="mt-2 p-4 bg-slate-50 dark:bg-slate-600/20 rounded text-sm whitespace-pre-wrap max-h-80 overflow-y-auto">
                              {step.fullReasoningContent}
                            </div>
                          </details>
                        </div>
                      )}
                    {step.query && step.type !== "web_search" && (
                      <div className="text-xs text-slate-500 dark:text-gray-400 mt-1">
                        Query: "{step.query}"
                      </div>
                    )}
                    {step.focus && (
                      <div className="text-xs text-slate-500 dark:text-gray-400 mt-1">
                        Focus: {step.focus}
                      </div>
                    )}
                    {step.sourceUrl && (
                      <div className="mt-2">
                        <a
                          href={step.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          {step.sourceUrl}
                        </a>
                      </div>
                    )}
                    {step.recentSources && step.recentSources.length > 0 && (
                      <div className="mt-2 space-y-1">
                        <div className="text-xs text-slate-500 dark:text-gray-400">
                          {step.recentSources.length} source
                          {step.recentSources.length > 1 ? "s" : ""} found:
                        </div>
                        {step.recentSources.slice(0, 3).map((url, urlIndex) => (
                          <a
                            key={urlIndex}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block text-xs text-blue-600 dark:text-blue-400 hover:underline truncate"
                          >
                            {url}
                          </a>
                        ))}
                        {step.recentSources.length > 3 && (
                          <div className="text-xs text-slate-500 dark:text-gray-400">
                            ... and {step.recentSources.length - 3} more
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex-shrink-0 flex flex-col items-end gap-2">
                    {step.status === "completed" && (
                      <div className="w-2 h-2 bg-emerald-500 rounded-full"></div>
                    )}
                  </div>
                </div>
              )
            })}

            {isStreaming && steps.length === 0 && (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-100 dark:bg-slate-600/30">
                <Loader2 className="w-4 h-4 animate-spin text-slate-600" />
                <span className="text-sm text-slate-600 dark:text-slate-400">
                  Initializing deep research...
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default DeepResearchReasoning
