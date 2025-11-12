import React, { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { ChevronRight, Loader2, FileText, Users, Brain } from "lucide-react"
import { cn, splitGroupedCitationsWithSpaces } from "@/lib/utils"
import { AgentReasoningStepType, Citation, XyneTools, Apps } from "shared/types"
import MarkdownPreview from "@uiw/react-markdown-preview"
import { useTheme } from "@/components/ThemeContext"
import DriveIcon from "@/assets/drive.svg?react"
import SlackIcon from "@/assets/slack.svg?react"
import GmailIcon from "@/assets/gmail.svg?react"
import GithubIcon from "@/assets/github.svg?react"
import GoogleCalendarIcon from "@/assets/googleCalendar.svg?react"
import SearchIcon from "@/assets/search.svg?react"
import XyneIcon from "@/assets/assistant-logo.svg?react"
import SvgIcon from "@/assets/mcp.svg?react"
import ExpandIcon from "@/assets/expand-text-input.svg?react"
import { textToCitationIndex } from "@/utils/chatUtils.tsx"
import { ClarificationRequest } from "@/hooks/useChatStream"

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
  stepSummary?: string
  aiGeneratedSummary?: string
  stepId?: string
  toolName?: string
  app?: string
  action?: string
  isIterationSummary?: boolean
  iterationToolName?: string
}

interface EnhancedReasoningProps {
  content: string
  isStreaming?: boolean
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

// Process reasoning content to include citation links and format parameters
const processReasoningWithCitations = (
  text: string,
  citations?: Citation[],
  citationMap?: Record<number, number>,
): string => {
  if (!text) return text

  // Format parameters if they exist in the text
  text = formatParametersInText(text)

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

// Helper function to format parameters in text
const formatParametersInText = (text: string): string => {
  // Look for "Parameters:" followed by bullet points or structured data
  const parameterPattern = /Parameters:\s*(.*?)(?=\n\n|\n[A-Z]|$)/gis

  return text.replace(parameterPattern, (match, paramContent) => {
    // First try to split by bullet points (•)
    let items = paramContent.split("•").filter((item: string) => item.trim())

    // If no bullet points found, try to split by common parameter separators
    if (items.length <= 1) {
      // Look for pattern like "key: value • key: value" or "key: value, key: value"
      items = paramContent
        .split(/\s*•\s*|\s*,\s*(?=[a-zA-Z_]+:)/)
        .filter((item: string) => item.trim())
    }

    if (items.length > 0) {
      const formattedItems = items.map((item: string) => {
        const trimmed = item.trim()
        // Check if it's a key-value pair
        if (trimmed.includes(":")) {
          const [key, ...valueParts] = trimmed.split(":")
          const value = valueParts.join(":").trim()
          return `**${key.trim()}:** ${value}`
        }
        return trimmed
      })

      // Use proper markdown formatting with line breaks
      const result = `**Parameters:**\n\n${formattedItems.map((item: string) => `• ${item}`).join("\n\n")}\n\n`
      return result
    }

    return match
  })
}

// Parse reasoning content into structured steps
const parseReasoningContent = (content: string): ReasoningStep[] => {
  if (!content.trim()) return []

  const lines = content.split("\n").filter((line) => line.trim())
  const steps: ReasoningStep[] = []
  const stepMap = new Map<string, ReasoningStep>()
  let currentIteration: ReasoningStep | null = null

  // Track steps per iteration for limiting display (same as backend)
  let currentIterationSteps = 0
  let currentIterationNumber = 0
  let currentIterationToolName: string | undefined = undefined
  const MAX_STEPS_PER_ITERATION = 3

  lines.forEach((line, lineIndex) => {
    try {
      const jsonData = JSON.parse(line)

      if (jsonData.step && jsonData.text) {
        const stepId = jsonData.step.stepId || `step_${lineIndex}`

        // Check if we already have this step (by stepId)
        const existingStep = stepMap.get(stepId)
        if (existingStep) {
          // Update existing step with new data
          existingStep.stepSummary =
            jsonData.quickSummary || existingStep.stepSummary
          existingStep.aiGeneratedSummary =
            jsonData.aiSummary || existingStep.aiGeneratedSummary
          return
        }

        // Create new step
        const step: ReasoningStep = {
          type: jsonData.step.type || AgentReasoningStepType.LogMessage,
          content: jsonData.text,
          timestamp:
            jsonData.step.timestamp ||
            generateStableId(jsonData.text, lineIndex),
          status: jsonData.step.status || "info",
          iterationNumber: jsonData.step.iteration,
          stepSummary: jsonData.quickSummary,
          aiGeneratedSummary: jsonData.aiSummary,
          stepId: stepId,
          substeps: [],
          toolName: jsonData.step.toolName,
          app: jsonData.step.app,
          isIterationSummary: jsonData.isIterationSummary || false,
          iterationToolName: currentIterationToolName,
        }

        // Handle iteration summaries - add them as top-level steps
        if (step.isIterationSummary) {
          steps.push(step)
          stepMap.set(stepId, step)
          return
        }

        // Apply the same 3-steps-per-iteration logic as backend
        if (step.type === AgentReasoningStepType.Iteration) {
          currentIteration = step
          currentIterationNumber =
            step.iterationNumber ?? currentIterationNumber + 1
          currentIterationSteps = 0 // Reset step counter for new iteration
          currentIterationToolName = undefined // Reset tool name for new iteration
          // Add iteration step to show attempt headers
          steps.push(step)
          stepMap.set(stepId, step)
        } else if (
          currentIteration &&
          step.type !== AgentReasoningStepType.Iteration
        ) {
          // Track tool name from ToolExecuting steps for the entire iteration
          if (
            step.type === AgentReasoningStepType.ToolExecuting &&
            step.toolName
          ) {
            currentIterationToolName = step.toolName
            // Update the current iteration with the tool name
            currentIteration.iterationToolName = currentIterationToolName
            // Update all existing substeps in this iteration with the tool name
            if (currentIteration.substeps) {
              currentIteration.substeps.forEach((substep) => {
                if (!substep.app && !substep.toolName) {
                  substep.iterationToolName = currentIterationToolName
                }
              })
            }
          }

          // Set the iteration tool name for this step
          step.iterationToolName = currentIterationToolName

          // Check if we've already added 3 steps for this iteration
          if (currentIterationSteps >= MAX_STEPS_PER_ITERATION) {
            // Skip this step to maintain 3-step limit per iteration
            stepMap.set(stepId, step) // Still track it internally
            return
          }
          currentIterationSteps++

          // Add to substeps array of the current iteration
          if (!currentIteration.substeps) {
            currentIteration.substeps = []
          }
          currentIteration.substeps.push(step)
          stepMap.set(stepId, step)
        } else {
          // Add as top-level step (for steps outside iterations)
          steps.push(step)
          stepMap.set(stepId, step)
        }
      } else if (
        jsonData.step &&
        jsonData.step.type === AgentReasoningStepType.LogMessage &&
        jsonData.step.stepId &&
        jsonData.step.stepId.startsWith("consolidated_")
      ) {
        // Handle consolidated summary steps
        const step: ReasoningStep = {
          type: AgentReasoningStepType.LogMessage,
          content:
            jsonData.text ||
            jsonData.quickSummary ||
            jsonData.aiSummary ||
            "Additional processing completed",
          timestamp: jsonData.step.timestamp || Date.now(),
          status: "info",
          iterationNumber: jsonData.step.iteration,
          stepSummary: jsonData.quickSummary || jsonData.aiSummary,
          aiGeneratedSummary: jsonData.aiSummary || jsonData.quickSummary,
          stepId: jsonData.step.stepId,
          substeps: [],
        }

        // Add consolidated summary as a regular step
        steps.push(step)
        stepMap.set(step.stepId!, step)
      }
    } catch (e) {
      try {
        const content = line.trim()
        const status: "pending" | "success" | "error" | "info" = "info"
        const step: ReasoningStep = {
          type: "ReasoningStep",
          content,
          timestamp: generateStableId(content, lineIndex),
          status,
        }

        // Add consolidated summary as a regular step
        steps.push(step)
        stepMap.set(step.stepId!, step)
      } catch (error) {
        console.error("Failed to create step from line:", line, "Error:", error)
      }
    }
  })

  return steps
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
  parentApp?: string
  getAppIcon: (
    app?: string,
    stepType?: string,
    stepIndex?: number,
    toolName?: string,
    iterationToolName?: string,
  ) => JSX.Element | null
  allSteps?: ReasoningStep[]
}> = React.memo(
  ({
    step,
    index,
    isStreaming,
    isLastStep,
    depth = 0,
    citations,
    citationMap,
    parentApp,
    getAppIcon,
    allSteps = [],
  }) => {
    const [showFullDetails, setShowFullDetails] = useState(false)
    const { theme } = useTheme()
    const isIteration = step.type === AgentReasoningStepType.Iteration
    const isIterationSummary = step.isIterationSummary
    const hasSubsteps = step.substeps && step.substeps.length > 0

    // Check if this is an initial message that should always show full content
    const isInitialMessage =
      step.type === AgentReasoningStepType.LogMessage &&
      (step.content.includes("We're reading your question") ||
        step.content.includes("figuring out the best way") ||
        step.content.includes("This might take a few seconds"))

    // Get the display text - show actual message for step 1, summaries for steps 2 and 3
    const getDisplayText = () => {
      if (isIteration) {
        return `Attempt ${step.iterationNumber}`
      }

      // For initial messages, always show full content
      if (isInitialMessage) {
        return step.content
      }

      // For iteration summaries, show the summary content
      if (isIterationSummary) {
        return step.content
      }

      // For substeps (steps within an iteration), show actual message for step 1, summaries for steps 2 and 3
      if (depth > 0) {
        // Step 1 (index 0): show actual message
        if (index === 0) {
          return step.content
        }
        // Steps 2 and 3 (index 1 and 2): show summary only
        if (index >= 1 && (step.aiGeneratedSummary || step.stepSummary)) {
          return step.aiGeneratedSummary || step.stepSummary
        }
        // Fallback to content if no summary available
        return step.content
      }

      // For top-level messages with summaries, always show the summary
      if (step.aiGeneratedSummary || step.stepSummary) {
        return step.aiGeneratedSummary || step.stepSummary
      }

      // Otherwise show full content
      return step.content
    }

    const hasAISummary = Boolean(step.aiGeneratedSummary || step.stepSummary)
    // Only allow toggling details for step 1 (index 0) in substeps, or for top-level messages
    const canToggleDetails =
      hasAISummary &&
      !isIteration &&
      !isInitialMessage &&
      !isIterationSummary &&
      step.content !== (step.aiGeneratedSummary || step.stepSummary) &&
      (depth === 0 || index === 0) // Only step 1 in iterations or top-level steps
    const isWaitingForSummary =
      isStreaming &&
      isLastStep &&
      !hasAISummary &&
      step.content &&
      !isInitialMessage &&
      !isIterationSummary

    // Special styling for iteration headers and summaries
    const getStepClassName = () => {
      if (isIteration) {
        return "font-semibold text-blue-700 dark:text-blue-300"
      }
      if (isIterationSummary) {
        return ""
      }
      return ""
    }

    if (isIteration) {
      // Check if there are multiple iterations in the entire steps array
      const totalIterations = allSteps.filter(
        (s) => s.type === AgentReasoningStepType.Iteration,
      ).length
      const showAttemptHeader = totalIterations > 1

      return (
        <div className={cn("mt-4", index > 0 && "mt-8")}>
          {/* Header outside the white div - show for all attempts if there are multiple */}
          {showAttemptHeader && (
            <div className="flex items-center mb-2 gap-2">
              <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                {getDisplayText()}
              </span>
            </div>
          )}

          {/* White div with fixed height and scrollable content */}
          <div className="bg-white dark:bg-slate-700 rounded-xl py-4 shadow-sm h-36 overflow-y-auto overflow-x-hidden flex flex-col items-start gap-4 w-full max-w-full">
            {hasSubsteps && (
              <div className="space-y-1 w-full max-w-full">
                {step.substeps!.map((substep, substepIndex) => (
                  <ReasoningStepComponent
                    key={substep.stepId || substep.timestamp}
                    step={substep}
                    index={substepIndex}
                    isStreaming={isStreaming}
                    isLastStep={substepIndex === step.substeps!.length - 1}
                    depth={depth + 1}
                    citations={citations}
                    citationMap={citationMap}
                    parentApp={step.app}
                    getAppIcon={getAppIcon}
                    allSteps={allSteps}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )
    }

    // Handle iteration summary with its own dedicated container
    if (isIterationSummary) {
      return (
        <div className="rounded-lg p-4 mt-16 mb-16 ">
          <div className="w-full max-w-full">
            <div className="text-sm leading-relaxed text-gray-700 dark:text-gray-300">
              <MarkdownPreview
                source={processReasoningWithCitations(
                  getDisplayText() || "",
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
                  display: "block",
                  overflowWrap: "break-word",
                  wordBreak: "break-word",
                  maxWidth: "100%",
                  overflow: "hidden",
                }}
                components={{
                  p: ({ children }) => <div className="mb-2">{children}</div>,
                  ul: ({ children }) => (
                    <ul className="list-disc pl-4 mt-1 space-y-0.5">
                      {children}
                    </ul>
                  ),
                  li: ({ children }) => <li className="text-sm">{children}</li>,
                  strong: ({ children }) => (
                    <strong className="font-semibold text-gray-800 dark:text-gray-200">
                      {children}
                    </strong>
                  ),
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
          </div>
        </div>
      )
    }

    // Determine which app to use for icon (parentApp if available, otherwise step's app)
    const appForIcon = parentApp || step.app

    // Get the icon for this step
    const stepIcon = getAppIcon(
      appForIcon,
      step.type,
      index,
      step.toolName,
      step.iterationToolName,
    )

    return (
      <div
        className={cn(
          "w-full max-w-full space-y-1",
          !isInitialMessage && !isIteration && "ml-8",
          depth > 0 && "ml-6",
          isInitialMessage && "mb-6",
        )}
      >
        <div className="w-full max-w-full">
          <div
            className={cn(
              "flex items-center space-x-2 py-1 w-full max-w-full pr-4",
              getStepClassName(),
            )}
          >
            {/* Add icon for substeps */}
            {depth > 0 && stepIcon && (
              <span className="text-gray-500 dark:text-gray-400 flex-shrink-0">
                {stepIcon}
              </span>
            )}
            <div className="flex-1 min-w-0 w-full">
              <div
                className={cn(
                  "text-sm leading-relaxed text-gray-700 dark:text-gray-300",
                  canToggleDetails && "cursor-pointer",
                )}
                onClick={
                  canToggleDetails
                    ? () => setShowFullDetails(!showFullDetails)
                    : undefined
                }
              >
                <MarkdownPreview
                  source={processReasoningWithCitations(
                    getDisplayText() || "",
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
                    display: "block",
                    overflowWrap: "break-word",
                    wordBreak: "break-word",
                    maxWidth: "100%",
                    overflow: "hidden",
                  }}
                  components={{
                    p: ({ children }) => (
                      <div className="mb-2">
                        {children}
                        {canToggleDetails && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setShowFullDetails(!showFullDetails)
                            }}
                            aria-expanded={showFullDetails}
                            aria-label={
                              showFullDetails
                                ? "Collapse step details"
                                : "Expand step details"
                            }
                            className="inline-block align-middle ml-1 p-0.5 text-gray-400"
                          >
                            {showFullDetails ? null : (
                              <ChevronRight className=" w-4 h-3.5" />
                            )}
                          </button>
                        )}
                      </div>
                    ),
                    ul: ({ children }) => (
                      <ul className="list-disc pl-4 mt-1 space-y-0.5">
                        {children}
                      </ul>
                    ),
                    li: ({ children }) => (
                      <li className="text-sm">{children}</li>
                    ),
                    strong: ({ children }) => (
                      <strong className="font-semibold text-gray-700 dark:text-gray-200">
                        {children}
                      </strong>
                    ),
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
              <div className="w-full">
                {isWaitingForSummary && step.type !== "ReasoningStep" && (
                  <div className="mt-1 text-xs text-gray-400 dark:text-gray-500 flex items-center">
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    Generating AI summary...
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Show full details below when expanded */}
          {showFullDetails && canToggleDetails && (
            <div className="mt-2 ml-4 pl-2 ">
              <div className="text-sm text-[#6B757F] leading-relaxed w-full break-words flex">
                <span className="mr-1 flex-shrink-0">-</span>
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
                    display: "inline",
                  }}
                  components={{
                    p: ({ children }) => <div className="mb-2">{children}</div>,
                    ul: ({ children }) => (
                      <ul className="list-disc pl-4 mt-2 mb-2 space-y-1">
                        {children}
                      </ul>
                    ),
                    li: ({ children }) => (
                      <li className="text-sm">{children}</li>
                    ),
                    strong: ({ children }) => (
                      <strong className="font-semibold text-gray-700 dark:text-gray-200">
                        {children}
                      </strong>
                    ),
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
            </div>
          )}
        </div>
      </div>
    )
  },
)

// Progress state enum
enum ProgressState {
  UnderstandingQuery = 1,
  PlanningTask = 2,
  ScanningDocuments = 3,
  ExtractingInformation = 4,
  GeneratingSummary = 5,
  SearchCompleted = 6,
}

// Get current progress state based on steps
const getCurrentProgressState = (
  steps: ReasoningStep[],
  isStreaming: boolean,
  startTime: number | null,
): { state: ProgressState; text: string; attemptNumber?: number } => {
  if (steps.length === 0) {
    return {
      state: ProgressState.UnderstandingQuery,
      text: "Understanding the user's query...",
    }
  }

  // Check if streaming has ended
  if (!isStreaming && steps.length > 0) {
    if (startTime) {
      const duration = Math.round((Date.now() - startTime) / 1000)
      return {
        state: ProgressState.SearchCompleted,
        text: `The search was completed in ${duration} seconds`,
      }
    }
    return {
      state: ProgressState.SearchCompleted,
      text: "The search was completed",
    }
  }

  // Find the latest step
  const latestStep = steps[steps.length - 1]

  // Check for initial message
  const hasInitialMessage = steps.some(
    (step) =>
      step.type === AgentReasoningStepType.LogMessage &&
      (step.content.includes("We're reading your question") ||
        step.content.includes("figuring out the best way")),
  )

  if (hasInitialMessage && steps.length === 1) {
    return {
      state: ProgressState.UnderstandingQuery,
      text: "Understanding the user's query...",
    }
  }

  // Find current iteration
  let currentIteration: ReasoningStep | null = null
  let currentIterationNumber = 0

  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].type === AgentReasoningStepType.Iteration) {
      currentIteration = steps[i]
      currentIterationNumber = steps[i].iterationNumber ?? 1
      break
    }
  }

  // Check if we're in an iteration summary
  if (latestStep.isIterationSummary) {
    return {
      state: ProgressState.GeneratingSummary,
      text: `Generating summary for attempt ${currentIterationNumber}...`,
      attemptNumber: currentIterationNumber,
    }
  }

  // If we have an iteration
  if (currentIteration) {
    const substeps = currentIteration.substeps || []

    // No substeps yet = just started iteration (planning phase)
    if (substeps.length === 0) {
      return {
        state: ProgressState.PlanningTask,
        text: "Planning the task...",
        attemptNumber: currentIterationNumber,
      }
    }

    // Based on step position in the attempt (1st, 2nd, 3rd step)
    const stepPosition = substeps.length

    if (stepPosition === 1) {
      return {
        state: ProgressState.PlanningTask,
        text: "Planning the task...",
        attemptNumber: currentIterationNumber,
      }
    } else if (stepPosition === 2) {
      return {
        state: ProgressState.ScanningDocuments,
        text: "Scanning the documents...",
        attemptNumber: currentIterationNumber,
      }
    } else if (stepPosition >= 3) {
      return {
        state: ProgressState.ExtractingInformation,
        text: "Extracting information from documents...",
        attemptNumber: currentIterationNumber,
      }
    }
  }

  // Default
  return {
    state: ProgressState.UnderstandingQuery,
    text: "Understanding the user's query...",
  }
}

export const EnhancedReasoning: React.FC<EnhancedReasoningProps> = ({
  content,
  isStreaming = false,
  className,
  citations = [],
  citationMap,
  clarificationRequest,
  waitingForClarification,
  onClarificationSelect,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [steps, setSteps] = useState<ReasoningStep[]>([])
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [userHasScrolled, setUserHasScrolled] = useState(false)
  const hasAutoCollapsedRef = useRef(false)
  const [customClarificationInput, setCustomClarificationInput] = useState("")
  const [progressState, setProgressState] = useState<{
    state: ProgressState
    text: string
    attemptNumber?: number
  }>({
    state: ProgressState.UnderstandingQuery,
    text: "Understanding the user's query...",
  })
  const startTimeRef = useRef<number | null>(null)

  // Track start time when streaming begins
  useEffect(() => {
    if (isStreaming && !startTimeRef.current) {
      startTimeRef.current = Date.now()
    }
  }, [isStreaming])

  // Memoize icon mapping functions
  const getIconFromApp = useCallback((app?: string) => {
    switch (app) {
      // Apps enum values
      case Apps.Gmail:
        return <GmailIcon className="w-4 h-4" />
      case Apps.GoogleDrive:
        return <DriveIcon className="w-4 h-4" />
      case Apps.GoogleCalendar:
        return <GoogleCalendarIcon className="w-4 h-4" />
      case Apps.Slack:
        return <SlackIcon className="w-4 h-4" />
      case Apps.GoogleWorkspace:
        return <Users className="w-4 h-4" />
      case Apps.MCP:
        return <SvgIcon className="w-4 h-4" />
      case Apps.Github:
        return <GithubIcon className="w-4 h-4" />
      case Apps.DataSource:
        return <FileText className="w-4 h-4" />
      case Apps.Xyne:
        return <XyneIcon className="w-4 h-4" />
      default:
        return null
    }
  }, [])

  const getIconFromToolName = useCallback((toolName: string) => {
    switch (toolName) {
      case XyneTools.GetUserInfo:
        return <XyneIcon className="w-4 h-4" />

      case XyneTools.Search:
      case XyneTools.FilteredSearch:
      case XyneTools.TimeSearch:
        return <SearchIcon className="w-4 h-4" />

      case XyneTools.getSlackRelatedMessages:
      case XyneTools.getSlackThreads:
      case XyneTools.getUserSlackProfile:
        return <SlackIcon className="w-4 h-4" />

      default:
        // Default for unknown tools
        return <XyneIcon className="w-4 h-4" />
    }
  }, [])

  const getAppIcon = useCallback(
    (
      app?: string,
      stepType?: string,
      stepIndex?: number,
      toolName?: string,
      iterationToolName?: string,
    ) => {
      // For planning steps (first step in iteration)
      if (stepType === AgentReasoningStepType.Planning || stepIndex === 0) {
        return <Brain className="w-4 h-4" />
      }

      // First try to get icon from app
      const appIcon = getIconFromApp(app)
      if (appIcon) return appIcon

      // If no app, try to get icon from tool name (current step's tool or iteration's tool)
      const currentToolName = toolName || iterationToolName
      if (currentToolName) {
        return getIconFromToolName(currentToolName)
      }

      return null
    },
    [getIconFromApp, getIconFromToolName],
  )

  // Memoize expensive computations
  const parsedSteps = useMemo(() => {
    if (!content.trim()) return []
    return parseReasoningContent(content)
  }, [content])

  // Parse content and update steps
  useEffect(() => {
    setSteps(parsedSteps)
  }, [parsedSteps])

  // Memoize progress state calculation
  const currentProgressState = useMemo(() => {
    return getCurrentProgressState(steps, isStreaming, startTimeRef.current)
  }, [steps, isStreaming])

  // Update progress state when steps or streaming status changes
  useEffect(() => {
    setProgressState(currentProgressState)
  }, [currentProgressState])

  // Memoize scroll functions to prevent recreating on every render
  const isScrolledToBottom = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return true

    const threshold = 10 // pixels from bottom to consider "at bottom"
    return (
      container.scrollHeight - container.scrollTop - container.clientHeight <
      threshold
    )
  }, [])

  // Handle manual scrolling by user
  const handleScroll = useCallback(() => {
    const isAtBottom = isScrolledToBottom()
    setUserHasScrolled(!isAtBottom)
  }, [isScrolledToBottom])

  // Reset user scroll state when streaming starts
  useEffect(() => {
    if (isStreaming) {
      setUserHasScrolled(false)
      setIsCollapsed(false) // Ensure it's expanded when streaming starts
      hasAutoCollapsedRef.current = false // Reset auto-collapse flag when new streaming starts
    }
  }, [isStreaming])

  // Auto-collapse when streaming ends (only once)
  // BUT: Don't auto-collapse when waiting for clarification
  useEffect(() => {
    if (
      !isStreaming &&
      steps.length > 0 &&
      !isCollapsed &&
      !hasAutoCollapsedRef.current &&
      !waitingForClarification
    ) {
      setIsCollapsed(true)
      hasAutoCollapsedRef.current = true // Mark that auto-collapse has happened
    }
  }, [isStreaming, steps.length, isCollapsed, waitingForClarification])

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

  if (!content.trim() && !isStreaming && !clarificationRequest) {
    return null
  }

  const toggleCollapsed = useCallback(
    () => setIsCollapsed(!isCollapsed),
    [isCollapsed],
  )

  return (
    <div
      className={cn(
        "mb-8 w-full max-w-none rounded-2xl bg-[#F8FAFC] dark:bg-slate-800",
        className,
      )}
    >
      <div className="p-1">
        <button
          onClick={toggleCollapsed}
          className="sticky top-0 z-10 w-full bg-white dark:bg-slate-700 rounded-2xl border border-gray-200 dark:border-gray-700 px-6 py-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-slate-600 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-3">
            <Brain className="w-5 h-5 text-gray-500 dark:text-gray-300" />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {progressState.text}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {isCollapsed ? (
              <div className="border px-2 py-1 rounded-xl ">
                <ExpandIcon className="w-3.5 h-3.5" />
              </div>
            ) : null}
          </div>
        </button>
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div className="p-6">
          <div className="w-full max-w-full pl-4 pr-1 ">
            <div
              ref={scrollContainerRef}
              onScroll={handleScroll}
              className="space-y-6 max-h-80 overflow-y-auto overflow-x-hidden w-full max-w-full pr-4 pb-2 scrollbar-hide"
              style={{
                scrollbarWidth: "none",
                msOverflowStyle: "none",
              }}
            >
              {steps.length > 0 ? (
                steps.map((step, index) => (
                  <ReasoningStepComponent
                    key={step.stepId || step.timestamp}
                    step={step}
                    index={index}
                    isStreaming={isStreaming}
                    isLastStep={index === steps.length - 1}
                    depth={0}
                    citations={citations}
                    citationMap={citationMap}
                    getAppIcon={getAppIcon}
                    allSteps={steps}
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

              {/* HITL: Show clarification UI when waiting for user input */}
              {waitingForClarification && clarificationRequest && (
                <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
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
                              onClarificationSelect &&
                              onClarificationSelect(option.id, option.label)
                            }
                            className="w-full text-left px-4 py-3 bg-white dark:bg-slate-700 border border-gray-200 dark:border-gray-600 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:border-blue-300 dark:hover:border-blue-600 transition-colors"
                          >
                            <span className="text-sm text-gray-700 dark:text-gray-200">
                              {option.label}
                            </span>
                          </button>
                        ))}

                        {/* Custom input section */}
                        <div className="mt-4 pt-4 border-t border-blue-200 dark:border-blue-700">
                          <label className="block text-xs font-medium text-blue-800 dark:text-blue-200 mb-2">
                            Or provide a custom response:
                          </label>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={customClarificationInput}
                              onChange={(e) =>
                                setCustomClarificationInput(e.target.value)
                              }
                              onKeyDown={(e) => {
                                if (
                                  e.key === "Enter" &&
                                  customClarificationInput.trim()
                                ) {
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
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default EnhancedReasoning
