import React, { useState, useEffect, useRef } from "react"
import { ChevronDown, ChevronRight, Gavel } from "lucide-react"
import { cn, splitGroupedCitationsWithSpaces } from "@/lib/utils"
import { AgentReasoningStepType, Citation } from "shared/types"
import MarkdownPreview from "@uiw/react-markdown-preview"
import { useTheme } from "@/components/ThemeContext"

// Simple hash function to generate stable IDs from content
const generateStableId = (content: string, index: number): number => {
  let hash = 0
  const str = `${content}-${index}`
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return Math.abs(hash)
}

interface ReasoningStep {
  type: AgentReasoningStepType | string
  content: string
  timestamp: number
  status?: "pending" | "success" | "error" | "info"
  iterationNumber?: number
  substeps?: ReasoningStep[]
}

interface EnhancedReasoningProps {
  content: string
  isStreaming?: boolean
  className?: string
  citations?: Citation[]
  citationMap?: Record<number, number>
}

// Step pattern configuration for robust parsing
const STEP_PATTERNS = {
  ITERATION: /Iteration (\d+)/,
  PLANNING: /Planning|Planning next step/,
  TOOL_SELECTED: /Tool selected:/,
  TOOL_PARAMETERS: /Parameters:/,
  TOOL_EXECUTING: /Executing tool:/,
  TOOL_RESULT: /Tool result/,
  TOOL_ERROR: /Error:/,
  SYNTHESIS: /Synthesizing|synthesis/,
  VALIDATION_ERROR: /Validation Error/,
  BROADENING_SEARCH: /Broadening Search/,
  ANALYZING: /Analyzing/,
} as const

// Step type configuration interface
interface StepTypeConfig {
  pattern: RegExp
  type: AgentReasoningStepType
  status: "pending" | "success" | "error" | "info"
  getStatus?: (line: string) => "pending" | "success" | "error" | "info"
  extractData?: (
    line: string,
    match: RegExpMatchArray,
  ) => { iterationNumber?: number }
}

// Step type mapping configuration
const STEP_TYPE_CONFIG: StepTypeConfig[] = [
  {
    pattern: STEP_PATTERNS.ITERATION,
    type: AgentReasoningStepType.Iteration,
    status: "info",
    extractData: (line: string, match: RegExpMatchArray) => ({
      iterationNumber: match[1] ? parseInt(match[1]) : undefined,
    }),
  },
  {
    pattern: STEP_PATTERNS.PLANNING,
    type: AgentReasoningStepType.Planning,
    status: "pending",
  },
  {
    pattern: STEP_PATTERNS.TOOL_SELECTED,
    type: AgentReasoningStepType.ToolSelected,
    status: "info",
  },
  {
    pattern: STEP_PATTERNS.TOOL_PARAMETERS,
    type: AgentReasoningStepType.ToolParameters,
    status: "info",
  },
  {
    pattern: STEP_PATTERNS.TOOL_EXECUTING,
    type: AgentReasoningStepType.ToolExecuting,
    status: "pending",
  },
  {
    pattern: STEP_PATTERNS.TOOL_ERROR,
    type: AgentReasoningStepType.ValidationError,
    status: "error",
  },
  {
    pattern: STEP_PATTERNS.TOOL_RESULT,
    type: AgentReasoningStepType.ToolResult,
    status: "success",
    getStatus: (line: string) =>
      STEP_PATTERNS.TOOL_ERROR.test(line) ? "error" : "success",
  },
  {
    pattern: STEP_PATTERNS.SYNTHESIS,
    type: AgentReasoningStepType.Synthesis,
    status: "pending",
  },
  {
    pattern: STEP_PATTERNS.VALIDATION_ERROR,
    type: AgentReasoningStepType.ValidationError,
    status: "error",
  },
  {
    pattern: STEP_PATTERNS.BROADENING_SEARCH,
    type: AgentReasoningStepType.BroadeningSearch,
    status: "info",
  },
  {
    pattern: STEP_PATTERNS.ANALYZING,
    type: AgentReasoningStepType.AnalyzingQuery,
    status: "pending",
  },
]

// Parse reasoning content into structured steps with iteration grouping
const parseReasoningContent = (content: string): ReasoningStep[] => {
  if (!content.trim()) return []

  const lines = content.split("\n").filter((line) => line.trim())
  const steps: ReasoningStep[] = []
  let currentIteration: ReasoningStep | null = null

  lines.forEach((line, index) => {
    let type: AgentReasoningStepType | string = "log_message"
    let status: "pending" | "success" | "error" | "info" = "info"
    let stepContent = line.trim()
    let iterationNumber: number | undefined = undefined

    // Clean up synthesis-related prefixes
    if (
      stepContent.toLowerCase().startsWith("synthesis:") ||
      stepContent.toLowerCase().startsWith("synthesis result:")
    ) {
      stepContent = stepContent
        .replace(/^synthesis(\s+result)?\s*:\s*/i, "")
        .trim()
    }

    // Find matching step type configuration
    for (const config of STEP_TYPE_CONFIG) {
      const match = line.match(config.pattern)
      if (match) {
        type = config.type
        status = config.getStatus ? config.getStatus(line) : config.status

        // Extract additional data if extractor function exists
        if (config.extractData) {
          const extracted = config.extractData(line, match)
          if (extracted.iterationNumber !== undefined) {
            iterationNumber = extracted.iterationNumber
          }
        }

        // Handle iteration step creation
        if (type === AgentReasoningStepType.Iteration) {
          const iterationStep: ReasoningStep = {
            type,
            content: stepContent,
            timestamp: generateStableId(stepContent, index),
            status,
            iterationNumber,
            substeps: [],
          }

          steps.push(iterationStep)
          currentIteration = iterationStep
          return
        }
        break
      }
    }

    const step: ReasoningStep = {
      type,
      content: stepContent,
      timestamp: generateStableId(stepContent, index),
      status,
    }

    // If we have a current iteration and this isn't a new iteration, add as substep
    if (currentIteration && type !== AgentReasoningStepType.Iteration) {
      currentIteration.substeps!.push(step)
    } else {
      // Otherwise add as top-level step
      steps.push(step)
    }
  })

  return steps
}

// Pattern to match citation references like [1], [2], etc.
const textToCitationIndex = /\[(\d+)\]/g

// Process reasoning content to include citation links
const processReasoningWithCitations = (
  text: string,
  citations?: Citation[],
  citationMap?: Record<number, number>,
): string => {
  if (!text) return text

  // Split grouped citations like [1,2,3] into [1] [2] [3]
  text = splitGroupedCitationsWithSpaces(text)
  // If no citations provided, return text as-is
  if (!citations?.length) return text

  const citationUrls = citations.map((c: Citation) => c.url)

  if (citationMap) {
    return text.replace(textToCitationIndex, (match, num) => {
      const index = citationMap[num]
      const url = citationUrls[index]
      return typeof index === "number" && url ? `[[${index + 1}]](${url})` : "" // Remove citation if no mapping found
    })
  } else {
    return text.replace(textToCitationIndex, (match, num) => {
      const url = citationUrls[num - 1]
      return url ? `[[${num}]](${url})` : "" // Remove citation if no URL found
    })
  }
}

// Get display properties for different step types
const getStepTypeDisplay = (type: AgentReasoningStepType | string) => {
  const displays: Record<
    string,
    {
      icon: string | React.ReactElement
      label: string
      color: string
      isError?: boolean
    }
  > = {
    [AgentReasoningStepType.Iteration]: {
      icon: "→",
      label: "Attempt",
      color: "text-blue-600 dark:text-blue-400",
    },
    [AgentReasoningStepType.Planning]: {
      icon: "●",
      label: "Planning",
      color: "text-purple-600 dark:text-purple-400",
    },
    [AgentReasoningStepType.ToolSelected]: {
      icon: "○",
      label: "Tool Selected",
      color: "text-green-600 dark:text-green-400",
    },
    [AgentReasoningStepType.ToolParameters]: {
      icon: "",
      label: "Parameters",
      color: "text-gray-500 dark:text-gray-400",
    },
    [AgentReasoningStepType.ToolExecuting]: {
      icon: <Gavel className="w-3 h-3" />,
      label: "Executing",
      color: "text-amber-600 dark:text-amber-400",
    },
    [AgentReasoningStepType.ToolResult]: {
      icon: "✓",
      label: "Result",
      color: "text-emerald-600 dark:text-emerald-400",
    },
    [AgentReasoningStepType.Synthesis]: {
      icon: "◇",
      label: "Synthesis",
      color: "text-indigo-600 dark:text-indigo-400",
    },
    [AgentReasoningStepType.ValidationError]: {
      icon: "✗",
      label: "Error",
      color: "text-red-600 dark:text-red-400",
      isError: true,
    },
    [AgentReasoningStepType.BroadeningSearch]: {
      icon: "◯",
      label: "Broadening Search",
      color: "text-orange-600 dark:text-orange-400",
    },
    [AgentReasoningStepType.AnalyzingQuery]: {
      icon: "○",
      label: "Analyzing",
      color: "text-cyan-600 dark:text-cyan-400",
    },
    log_message: {
      icon: "",
      label: "Thinking",
      color: "text-gray-500 dark:text-gray-400",
    },
  }

  return displays[type] || displays.log_message
}

// Component to render a single reasoning step
const ReasoningStepComponent: React.FC<{
  step: ReasoningStep
  index: number
  isStreaming: boolean
  isLastStep: boolean
  depth?: number
  citations?: Citation[]
  citationMap?: Record<number, number>
}> = ({
  step,
  index,
  isStreaming,
  isLastStep,
  depth = 0,
  citations,
  citationMap,
}) => {
  const [isExpanded, setIsExpanded] = useState(true)
  const { theme } = useTheme()
  const display = getStepTypeDisplay(step.type)
  const isIteration = step.type === AgentReasoningStepType.Iteration
  const hasSubsteps = step.substeps && step.substeps.length > 0

  return (
    <div className={cn("space-y-1 w-full min-w-full", depth > 0 && "ml-3")}>
      <div className="flex items-center space-x-2 py-1 w-full min-w-full">
        <div className="flex-shrink-0 flex items-center">
          {isIteration && hasSubsteps ? (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              aria-expanded={isExpanded}
              aria-label={
                isExpanded
                  ? "Collapse iteration details"
                  : "Expand iteration details"
              }
              className="flex items-center space-x-2 p-0.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              {isExpanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              <span
                className={cn(
                  "text-sm font-mono w-4 text-center flex items-center justify-center",
                  display.color,
                )}
              >
                {typeof display.icon === "string" ? display.icon : display.icon}
              </span>
              <span className={cn("text-sm font-medium", display.color)}>
                {display.label}
                {step.iterationNumber && ` ${step.iterationNumber}`}
              </span>
            </button>
          ) : (
            <span
              className={cn(
                "text-sm font-mono w-4 text-center flex items-center justify-center",
                display.color,
              )}
            >
              {typeof display.icon === "string" ? display.icon : display.icon}
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0 w-full">
          {!isIteration && (
            <div className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed w-full break-words">
              <MarkdownPreview
                source={processReasoningWithCitations(
                  step.content,
                  citations,
                  citationMap,
                )}
                wrapperElement={{
                  "data-color-mode": theme,
                }}
                style={{
                  padding: 0,
                  backgroundColor: "transparent",
                  fontSize: "inherit",
                  color: "inherit",
                  maxWidth: "100%",
                  overflowWrap: "break-word",
                  wordBreak: "break-word",
                  minWidth: 0,
                }}
                components={{
                  p: ({ children }) => <span>{children}</span>, // Render as inline to avoid extra spacing
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      {children}
                    </a>
                  ),
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Render substeps if iteration is expanded */}
      {isIteration && hasSubsteps && isExpanded && (
        <div className="space-y-1 ml-4 pl-2 w-full">
          {step.substeps!.map((substep, substepIndex) => (
            <ReasoningStepComponent
              key={substep.timestamp}
              step={substep}
              index={substepIndex}
              isStreaming={isStreaming}
              isLastStep={substepIndex === step.substeps!.length - 1}
              depth={depth + 1}
              citations={citations}
              citationMap={citationMap}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export const EnhancedReasoning: React.FC<EnhancedReasoningProps> = ({
  content,
  isStreaming = false,
  className,
  citations = [],
  citationMap,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [steps, setSteps] = useState<ReasoningStep[]>([])
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [userHasScrolled, setUserHasScrolled] = useState(false)

  // LOG 1: Raw content received from backend
  useEffect(() => {
    console.log("🔍 [EnhancedReasoning] Raw content from backend:", {
      content,
      contentLength: content?.length,
      isStreaming,
      citations,
      citationMap,
    })
  }, [content, isStreaming, citations, citationMap])

  useEffect(() => {
    const parsedSteps = parseReasoningContent(content)
    // LOG 2: Parsed steps after processing
    console.log("📊 [EnhancedReasoning] Parsed steps:", {
      rawContent: content,
      parsedSteps,
      stepsCount: parsedSteps.length,
    })
    setSteps(parsedSteps)
  }, [content])

  // Check if user is at the bottom of the scroll container
  const isScrolledToBottom = () => {
    const container = scrollContainerRef.current
    if (!container) return true

    const threshold = 10 // pixels from bottom to consider "at bottom"
    return (
      container.scrollHeight - container.scrollTop - container.clientHeight <
      threshold
    )
  }

  // Handle manual scrolling by user
  const handleScroll = () => {
    const isAtBottom = isScrolledToBottom()
    setUserHasScrolled(!isAtBottom)
  }

  // Reset user scroll state when streaming starts
  useEffect(() => {
    if (isStreaming) {
      setUserHasScrolled(false)
    }
  }, [isStreaming])

  // Auto-scroll to bottom when new content arrives during streaming
  useEffect(() => {
    if (
      isStreaming &&
      !isCollapsed &&
      !userHasScrolled &&
      scrollContainerRef.current &&
      steps.length > 0
    ) {
      const container = scrollContainerRef.current
      // Use setTimeout to ensure DOM has updated before scrolling
      setTimeout(() => {
        // Only scroll if user hasn't manually scrolled
        if (!userHasScrolled) {
          container.scrollTo({
            top: container.scrollHeight,
            behavior: "smooth",
          })
        }
      }, 10)
    }
  }, [steps, isStreaming, isCollapsed, userHasScrolled])

  if (!content.trim() && !isStreaming) {
    return null
  }

  const toggleCollapsed = () => setIsCollapsed(!isCollapsed)

  return (
    <div className={cn("mb-4 w-full max-w-none", className)}>
      {/* Header */}
      <button
        onClick={toggleCollapsed}
        className="flex items-center w-full min-w-full px-3 py-2 text-base text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 transition-colors flex-1"
      >
        {isCollapsed ? (
          <ChevronRight className="w-4 h-4 mr-2 text-slate-500" />
        ) : (
          <ChevronDown className="w-4 h-4 mr-2 text-slate-500" />
        )}
        <span className="flex items-center font-medium flex-1">Reasoning</span>
        <span className="flex-shrink-0 text-sm text-slate-400">
          {/* temporarily commenting this out */}
          {/* {steps.length} {steps.length === 1 ? "step" : "steps"} */}
        </span>
      </button>

      {/* Content */}
      {!isCollapsed && (
        <div className="w-full min-w-full max-w-none pl-3 mt-2">
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="space-y-1 max-h-80 overflow-y-auto w-full min-w-full"
          >
            {steps.length > 0 ? (
              steps.map((step, index) => (
                <ReasoningStepComponent
                  key={step.timestamp}
                  step={step}
                  index={index}
                  isStreaming={isStreaming}
                  isLastStep={index === steps.length - 1}
                  depth={0}
                  citations={citations}
                  citationMap={citationMap}
                />
              ))
            ) : isStreaming ? (
              <div className="flex items-center py-4 text-gray-500 dark:text-gray-400">
                <span className="mr-2">...</span>
                <span className="text-sm">initializing...</span>
              </div>
            ) : (
              <div className="py-4 text-gray-500 dark:text-gray-400 text-sm">
                No reasoning steps available
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default EnhancedReasoning
