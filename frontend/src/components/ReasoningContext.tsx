import React, {
  createContext,
  useContext,
  useMemo,
  useCallback,
  useState,
  useEffect,
  memo,
} from "react"
import {
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  Users,
  Brain,
  Globe,
  Search,
  Bot,
  MessageSquare,
  PenLine,
  BookOpen,
} from "lucide-react"
import { cn, splitGroupedCitationsWithSpaces } from "@/lib/utils"
import { ReasoningEventType, Citation, XyneTools } from "shared/types"
import type { ReasoningStage, PlanSubTask } from "shared/types"
import MarkdownPreview from "@uiw/react-markdown-preview"
import { useTheme } from "@/components/ThemeContext"
import DriveIcon from "@/assets/drive.svg?react"
import SlackIcon from "@/assets/slack.svg?react"
import GmailIcon from "@/assets/gmail.svg?react"
import GoogleCalendarIcon from "@/assets/googleCalendar.svg?react"
import XyneIcon from "@/assets/assistant-logo.svg?react"
import McpIcon from "@/assets/mcp.svg?react"
import { textToCitationIndex } from "@/utils/chatUtils.tsx"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlanInfo {
  goal: string
  subTasks: PlanSubTask[]
}

export interface ReasoningStep {
  type: ReasoningEventType | string
  content: string
  timestamp: number
  status?: "pending" | "success" | "error" | "info"
  substeps?: ReasoningStep[]
  stepId?: string
  toolName?: string
  stage?: ReasoningStage
  agent?: string
  delegationRunId?: string
  runId?: string
  turn?: number
  parentAgent?: string
  toolExecutionId?: string
  toolQuery?: string
}

export interface ParsedReasoning {
  steps: ReasoningStep[]
  orchestratorPlan?: PlanInfo
  agentPlans: Record<string, PlanInfo>
}

export type FlatItem =
  | { kind: "step"; step: ReasoningStep; key: string }
  | { kind: "agent"; agentName: string; steps: ReasoningStep[]; key: string; planKey: string }
  | { kind: "tool"; toolExecutionId: string; toolName: string; steps: ReasoningStep[]; key: string }

export type StepOrToolItem =
  | { kind: "step"; step: ReasoningStep; key: string }
  | { kind: "tool"; toolExecutionId: string; toolName: string; steps: ReasoningStep[]; key: string }

// ─── Constants ────────────────────────────────────────────────────────────────

export const WINDOW_SIZE = 2

export const STAGE_UI: Record<ReasoningStage, { icon: React.ReactNode; label: string }> = {
  understanding: { icon: <MessageSquare className="w-4 h-4" />, label: "Understanding" },
  gathering: { icon: <Search className="w-4 h-4" />, label: "Searching" },
  analyzing: { icon: <Brain className="w-4 h-4" />, label: "Analyzing" },
  consulting: { icon: <Bot className="w-4 h-4" />, label: "Consulting agent" },
  preparing: { icon: <PenLine className="w-4 h-4" />, label: "Preparing answer" },
}

export const TOOL_BLOCK_NAMES: Record<string, string> = {
  searchGlobal: "Search all sources",
  searchKnowledgeBase: "Search knowledge base",
  searchGmail: "Search Gmail",
  searchDriveFiles: "Search Google Drive",
  searchCalendarEvents: "Search calendar",
  searchGoogleContacts: "Search contacts",
  getSlackMessages: "Search Slack",
  getSlackThreads: "Search Slack threads",
  getSlackUserProfile: "Look up Slack profile",
  list_custom_agents: "Search for agents",
  fall_back: "Fallback search",
  synthesize_final_answer: "Compose answer",
}

const STAGE_PROGRESS_TEXT: Record<ReasoningStage, string> = {
  understanding: "Reading your question and planning a search strategy...",
  gathering: "Searching your connected apps and documents...",
  analyzing: "Reading through results and extracting what's relevant...",
  consulting: "Asking a specialized agent for deeper expertise...",
  preparing: "Composing your answer...",
}

const PLANNING_TOOL_NAMES = new Set([XyneTools.toDoWrite])

// ─── Pure Helpers ─────────────────────────────────────────────────────────────

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

export function getStageIcon(stage?: ReasoningStage): React.ReactNode | null {
  if (!stage || !STAGE_UI[stage]) return null
  return STAGE_UI[stage].icon
}

export function buildReasoningTree(
  steps: ReasoningStep[],
): { agent?: string; steps: ReasoningStep[] }[] {
  const blocks: { agent?: string; steps: ReasoningStep[] }[] = []
  let current: { agent?: string; steps: ReasoningStep[] } | null = null
  for (const step of steps) {
    const agent = step.agent ?? undefined
    if (current && current.agent === agent) {
      current.steps.push(step)
    } else {
      current = { agent, steps: [step] }
      blocks.push(current)
    }
  }
  return blocks
}

function isPlanningNoise(step: ReasoningStep): boolean {
  if (
    (step.type === ReasoningEventType.ToolExecuting ||
      step.type === ReasoningEventType.ToolCompleted) &&
    step.toolName != null &&
    PLANNING_TOOL_NAMES.has(step.toolName as XyneTools)
  )
    return true
  return false
}

const formatParametersInText = (text: string): string => {
  const parameterPattern = /Parameters:\s*(.*?)(?=\n\n|\n[A-Z]|$)/gis
  return text.replace(parameterPattern, (match, paramContent) => {
    let items = paramContent.split("•").filter((item: string) => item.trim())
    if (items.length <= 1) {
      items = paramContent
        .split(/\s*•\s*|\s*,\s*(?=[a-zA-Z_]+:)/)
        .filter((item: string) => item.trim())
    }
    if (items.length > 0) {
      const formattedItems = items.map((item: string) => {
        const trimmed = item.trim()
        if (trimmed.includes(":")) {
          const [key, ...valueParts] = trimmed.split(":")
          const value = valueParts.join(":").trim()
          return `**${key.trim()}:** ${value}`
        }
        return trimmed
      })
      return `**Parameters:**\n\n${formattedItems.map((item: string) => `• ${item}`).join("\n\n")}\n\n`
    }
    return match
  })
}

export const processReasoningWithCitations = (
  text: string,
  citations?: Citation[],
  citationMap?: Record<number, number>,
): string => {
  if (!text) return text
  text = formatParametersInText(text)
  text = splitGroupedCitationsWithSpaces(text)
  if (!citations?.length) return text
  const citationUrls = citations.map((c: Citation) => c.url)
  if (citationMap) {
    return text.replace(textToCitationIndex, (match, num) => {
      const index = citationMap[num]
      const url = citationUrls[index]
      return typeof index === "number" && url ? `[[${index + 1}]](${url})` : ""
    })
  } else {
    return text.replace(textToCitationIndex, (match, num) => {
      const url = citationUrls[num - 1]
      return url ? `[[${num}]](${url})` : ""
    })
  }
}

export function buildToolGroupItems(steps: ReasoningStep[]): StepOrToolItem[] {
  const toolBlocks: Record<string, ReasoningStep[]> = {}
  for (const step of steps) {
    if (step.toolExecutionId) {
      if (!toolBlocks[step.toolExecutionId]) toolBlocks[step.toolExecutionId] = []
      toolBlocks[step.toolExecutionId].push(step)
    }
  }
  const items: StepOrToolItem[] = []
  const emitted = new Set<string>()
  for (const step of steps) {
    if (step.toolExecutionId) {
      const id = step.toolExecutionId
      if (!emitted.has(id)) {
        emitted.add(id)
        const toolSteps = toolBlocks[id] ?? []
        const rawName = toolSteps.find((s) => s.toolName)?.toolName ?? ""
        const toolName = TOOL_BLOCK_NAMES[rawName] || rawName || "Tool"
        items.push({ kind: "tool", toolExecutionId: id, toolName, steps: toolSteps, key: `tool-${id}` })
      }
    } else {
      items.push({ kind: "step", step, key: step.stepId ?? String(step.timestamp) })
    }
  }
  return items
}

export function buildFlatItems(substeps: ReasoningStep[]): FlatItem[] {
  const agentBlocks: Record<string, ReasoningStep[]> = {}
  const toolBlocks: Record<string, ReasoningStep[]> = {}
  for (const step of substeps) {
    if (step.delegationRunId) {
      if (!agentBlocks[step.delegationRunId]) agentBlocks[step.delegationRunId] = []
      agentBlocks[step.delegationRunId].push(step)
    } else if (step.toolExecutionId) {
      if (!toolBlocks[step.toolExecutionId]) toolBlocks[step.toolExecutionId] = []
      toolBlocks[step.toolExecutionId].push(step)
    }
  }
  const items: FlatItem[] = []
  const emittedAgents = new Set<string>()
  const emittedTools = new Set<string>()
  for (const step of substeps) {
    if (step.delegationRunId) {
      const key = step.delegationRunId
      if (!emittedAgents.has(key)) {
        emittedAgents.add(key)
        items.push({
          kind: "agent",
          agentName: step.agent ?? "Delegated agent",
          steps: agentBlocks[key] ?? [],
          key: `agent-${key}`,
          planKey: key,
        })
      }
    } else if (step.toolExecutionId) {
      const id = step.toolExecutionId
      if (!emittedTools.has(id)) {
        emittedTools.add(id)
        const toolSteps = toolBlocks[id] ?? []
        const rawName = toolSteps.find((s) => s.toolName)?.toolName ?? ""
        const toolName = TOOL_BLOCK_NAMES[rawName] || rawName || "Tool"
        items.push({ kind: "tool", toolExecutionId: id, toolName, steps: toolSteps, key: `tool-${id}` })
      }
    } else {
      items.push({ kind: "step", step, key: step.stepId ?? String(step.timestamp) })
    }
  }
  return items
}

function parseReasoningEvent(
  data: Record<string, unknown>,
  lineIndex: number,
): ReasoningStep {
  const type = (data.type as string) || ReasoningEventType.LogMessage
  const displayText = (data.displayText as string) || ""
  const stage = data.stage as ReasoningStage | undefined
  const turnNumber =
    (data.turnNumber as number | undefined) ?? (data.turn as number | undefined)
  let plan: PlanInfo | undefined
  if (type === ReasoningEventType.PlanCreated && data.plan) {
    const raw = data.plan as { goal?: string; subTasks?: unknown[] }
    if (raw.goal && Array.isArray(raw.subTasks)) {
      plan = { goal: raw.goal, subTasks: raw.subTasks as PlanSubTask[] }
    }
  }
  return {
    type,
    content: displayText,
    timestamp: (data.timestamp as number | undefined) ?? generateStableId(displayText, lineIndex),
    status: "info",
    substeps: [],
    toolName: data.toolName as string | undefined,
    stage,
    agent: data.agent as string | undefined,
    delegationRunId: data.delegationRunId as string | undefined,
    runId: data.runId as string | undefined,
    turn: turnNumber,
    parentAgent: data.parentAgent as string | undefined,
    toolExecutionId: data.toolExecutionId as string | undefined,
    toolQuery: data.toolQuery as string | undefined,
    stepId: `step_${lineIndex}_${type}`,
    ...(plan ? { _plan: plan } : {}),
  } as ReasoningStep & { _plan?: PlanInfo }
}

export const parseReasoningContent = (content: string): ParsedReasoning => {
  if (!content.trim()) return { steps: [], agentPlans: {} }
  const lines = content.split("\n").filter((line) => line.trim())
  const steps: ReasoningStep[] = []
  let currentIteration: ReasoningStep | null = null
  let orchestratorPlan: PlanInfo | undefined
  const agentPlans: Record<string, PlanInfo> = {}

  lines.forEach((line, lineIndex) => {
    let parsed: (ReasoningStep & { _plan?: PlanInfo }) | null = null
    try {
      const data = JSON.parse(line) as Record<string, unknown>
      if (typeof data.type === "string") {
        parsed = parseReasoningEvent(data, lineIndex) as ReasoningStep & { _plan?: PlanInfo }
      }
    } catch {
      const trimmed = line.trim()
      parsed = {
        type: ReasoningEventType.LogMessage,
        content: trimmed,
        timestamp: generateStableId(trimmed, lineIndex),
        status: "info",
      }
    }

    if (!parsed) return

    if (parsed.type === ReasoningEventType.TurnStarted && !parsed.agent) {
      currentIteration = parsed
      steps.push(parsed)
      return
    }
    if (parsed.type === ReasoningEventType.TurnStarted && parsed.agent) return

    if (parsed.type === ReasoningEventType.PlanCreated && parsed._plan && !parsed.agent) {
      orchestratorPlan = parsed._plan
      return
    }
    if (parsed.type === ReasoningEventType.PlanCreated && parsed._plan && parsed.agent) {
      const planKey = parsed.delegationRunId ?? parsed.agent
      agentPlans[planKey] = parsed._plan
      return
    }
    if (parsed.type === ReasoningEventType.PlanCreated) return
    if (isPlanningNoise(parsed)) return

    if (currentIteration) {
      if (!currentIteration.substeps) currentIteration.substeps = []
      if (parsed.toolName && !currentIteration.toolName) {
        currentIteration.toolName = parsed.toolName
      }
      currentIteration.substeps.push(parsed)
      return
    }
    steps.push(parsed)
  })

  return { steps, orchestratorPlan, agentPlans }
}

export const getCurrentProgressState = (
  steps: ReasoningStep[],
  isStreaming: boolean,
  /** Pre-computed elapsed ms captured the moment streaming ended — never recomputed. */
  completionDurationMs: number | null,
): { text: string } => {
  if (!isStreaming && steps.length > 0) {
    if (completionDurationMs !== null) {
      let durationText: string
      if (completionDurationMs < 1000) {
        durationText = `${completionDurationMs}ms`
      } else if (completionDurationMs < 60_000) {
        const secs = (completionDurationMs / 1000).toFixed(1).replace(/\.0$/, "")
        durationText = `${secs}s`
      } else {
        const totalSecs = Math.round(completionDurationMs / 1000)
        const mins = Math.floor(totalSecs / 60)
        const secs = totalSecs % 60
        durationText = secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
      }
      return { text: `Completed in ${durationText}` }
    }
    return { text: "Search completed" }
  }
  if (steps.length === 0) return { text: "Understanding your query..." }

  const lastTop = steps[steps.length - 1]
  let latestStage: ReasoningStage | undefined
  if (lastTop.type === ReasoningEventType.TurnStarted && lastTop.substeps?.length) {
    latestStage = lastTop.substeps[lastTop.substeps.length - 1].stage
  }
  latestStage ??= lastTop.stage
  if (!latestStage) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].stage) {
        latestStage = steps[i].stage
        break
      }
    }
  }
  return { text: latestStage ? STAGE_PROGRESS_TEXT[latestStage] : "Understanding your query..." }
}

// ─── Shared Sub-components ────────────────────────────────────────────────────

function SubTaskIcon({ status }: { status: PlanSubTask["status"] }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
    case "in_progress":
      return <Loader2 className="w-3.5 h-3.5 text-blue-500 flex-shrink-0 animate-spin" />
    case "blocked":
    case "failed":
      return <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
    default:
      return <Circle className="w-3.5 h-3.5 text-gray-300 dark:text-gray-600 flex-shrink-0" />
  }
}

export const PlanCard: React.FC<{ plan: PlanInfo; isStreaming: boolean; label?: string }> = memo(
  ({ plan, isStreaming, label }) => {
    const [expanded, setExpanded] = useState(false)
    const hasInProgress = plan.subTasks.some((t) => t.status === "in_progress")
    const completedCount = plan.subTasks.filter((t) => t.status === "completed").length
    const total = plan.subTasks.length
    return (
      <div className="mb-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-slate-800 text-xs">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
        >
          {expanded ? (
            <ChevronDown className="w-3 h-3 text-gray-400 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-gray-400 flex-shrink-0" />
          )}
          <Brain className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
          <span className="flex-1 font-medium text-gray-700 dark:text-gray-300 truncate">
            {label ?? plan.goal}
          </span>
          <span className="text-gray-400 flex-shrink-0 tabular-nums">
            {completedCount}/{total}
            {isStreaming && hasInProgress && <Loader2 className="inline w-3 h-3 ml-1 animate-spin" />}
          </span>
        </button>
        {expanded && (
          <div className="px-3 pb-2 space-y-1">
            {plan.subTasks.map((task) => (
              <div key={task.id} className="flex items-start gap-2 py-0.5">
                <SubTaskIcon status={task.status} />
                <span
                  className={cn(
                    "leading-snug",
                    task.status === "completed"
                      ? "text-gray-400 dark:text-gray-500 line-through"
                      : task.status === "in_progress"
                        ? "text-blue-600 dark:text-blue-400 font-medium"
                        : "text-gray-600 dark:text-gray-400",
                  )}
                >
                  {task.description}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  },
)
PlanCard.displayName = "PlanCard"

export const ReasoningStepComponent: React.FC<{
  step: ReasoningStep
  index: number
  isStreaming: boolean
  isLastStep: boolean
  depth?: number
  citations?: Citation[]
  citationMap?: Record<number, number>
  getAppIcon: (stepType?: string, stepIndex?: number, toolName?: string) => JSX.Element | null
}> = memo(({ step, index, isStreaming, isLastStep, depth = 0, citations, citationMap, getAppIcon }) => {
  const { theme } = useTheme()
  const stepIcon = getStageIcon(step.stage) ?? getAppIcon(step.type, index, step.toolName)
  return (
    <div
      className={cn(
        "w-full max-w-full space-y-1",
        "ml-8",
        depth > 0 && "ml-6",
      )}
    >
      <div className="w-full max-w-full">
        <div className="flex items-center space-x-2 py-1 w-full max-w-full pr-4">
          {stepIcon && (
            <span className="text-gray-500 dark:text-gray-400 flex-shrink-0">{stepIcon}</span>
          )}
          <div className="flex-1 min-w-0 w-full">
            <div className="text-sm leading-relaxed text-gray-700 dark:text-gray-300">
              <MarkdownPreview
                source={processReasoningWithCitations(step.content || "", citations, citationMap)}
                wrapperElement={{ "data-color-mode": theme }}
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
                    <ul className="list-disc pl-4 mt-1 space-y-0.5">{children}</ul>
                  ),
                  li: ({ children }) => <li className="text-sm">{children}</li>,
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
            {step.type === ReasoningEventType.ToolExecuting && step.toolQuery && (
              <div
                className="mt-0.5 text-xs text-gray-400 dark:text-gray-500 italic truncate"
                title={step.toolQuery}
              >
                "{step.toolQuery}"
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})
ReasoningStepComponent.displayName = "ReasoningStepComponent"

export const ToolBlock: React.FC<{
  toolName: string
  steps: ReasoningStep[]
  isStreaming: boolean
  citations?: Citation[]
  citationMap?: Record<number, number>
  getAppIcon: (stepType?: string, stepIndex?: number, toolName?: string) => JSX.Element | null
}> = memo(({ toolName, steps, isStreaming, citations, citationMap, getAppIcon }) => {
  const [expanded, setExpanded] = useState(true)
  useEffect(() => {
    if (!isStreaming) setExpanded(false)
  }, [isStreaming])
  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1.5 py-0.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 w-full text-left rounded"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 flex-shrink-0" />
        )}
        <span className="font-medium">{toolName}</span>
        {!expanded && (
          <span className="text-gray-400 dark:text-gray-500 ml-1">({steps.length})</span>
        )}
      </button>
      {expanded && (
        <div className="ml-4 space-y-1 mt-0.5">
          {steps.map((substep) => (
            <ReasoningStepComponent
              key={substep.stepId ?? substep.timestamp}
              step={substep}
              index={0}
              isStreaming={isStreaming}
              isLastStep={false}
              depth={1}
              citations={citations}
              citationMap={citationMap}
              getAppIcon={getAppIcon}
            />
          ))}
        </div>
      )}
    </div>
  )
})
ToolBlock.displayName = "ToolBlock"

/**
 * Collapsible block for a delegated agent's steps.
 * variant="inline"  → indented with a left border (used in merged view)
 * variant="box"     → no indent, no left border (used when wrapped in its own box in streaming view)
 */
export const AgentBlock: React.FC<{
  agentName: string
  steps: ReasoningStep[]
  plan?: PlanInfo
  isStreaming: boolean
  citations?: Citation[]
  citationMap?: Record<number, number>
  getAppIcon: (stepType?: string, stepIndex?: number, toolName?: string) => JSX.Element | null
  variant?: "inline" | "box"
}> = memo(
  ({
    agentName,
    steps,
    plan,
    isStreaming,
    citations,
    citationMap,
    getAppIcon,
    variant = "inline",
  }) => {
    const [expanded, setExpanded] = useState(true)
    const toolGroupItems = useMemo(() => buildToolGroupItems(steps), [steps])
    const visibleItems =
      isStreaming && toolGroupItems.length > WINDOW_SIZE
        ? toolGroupItems.slice(-WINDOW_SIZE)
        : toolGroupItems

    return (
      <div
        className={cn(
          "w-full",
          variant === "inline" && "border-l-2 border-gray-200 dark:border-gray-600 pl-3 ml-1",
        )}
      >
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-2 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-600 rounded px-1 -ml-1 w-full text-left"
        >
          {expanded ? (
            <ChevronDown className="w-4 h-4 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 flex-shrink-0" />
          )}
          <span className="flex-shrink-0">{STAGE_UI.consulting.icon}</span>
          <span>Consulting {agentName}</span>
        </button>
        {expanded && (
          <div className="mt-1 space-y-2">
            {plan && <PlanCard plan={plan} isStreaming={isStreaming} label={`${agentName} plan`} />}
            {toolGroupItems.length > 0 && (
              <div
                className={cn(
                  "relative py-1",
                  !isStreaming && variant === "inline" && "max-h-40 overflow-y-auto scrollbar-hide",
                )}
                style={
                  !isStreaming && variant === "inline"
                    ? { scrollbarWidth: "none", msOverflowStyle: "none" }
                    : undefined
                }
              >
                {isStreaming && toolGroupItems.length > WINDOW_SIZE && (
                  <div className="absolute top-0 left-0 right-0 h-6 bg-gradient-to-b from-[#F8FAFC] dark:from-slate-800 to-transparent z-10 pointer-events-none" />
                )}
                <div className="space-y-1">
                  {visibleItems.map((item) => (
                    <div key={item.key} className={isStreaming ? "reasoning-step-enter" : undefined}>
                      {item.kind === "tool" ? (
                        <ToolBlock
                          toolName={item.toolName}
                          steps={item.steps}
                          isStreaming={isStreaming}
                          citations={citations}
                          citationMap={citationMap}
                          getAppIcon={getAppIcon}
                        />
                      ) : (
                        <ReasoningStepComponent
                          step={item.step}
                          index={0}
                          isStreaming={isStreaming}
                          isLastStep={false}
                          depth={1}
                          citations={citations}
                          citationMap={citationMap}
                          getAppIcon={getAppIcon}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )
  },
)
AgentBlock.displayName = "AgentBlock"

// ─── React Context ────────────────────────────────────────────────────────────

export interface ReasoningContextValue {
  steps: ReasoningStep[]
  flatItems: FlatItem[]
  orchestratorPlan?: PlanInfo
  agentPlans: Record<string, PlanInfo>
  isStreaming: boolean
  citations?: Citation[]
  citationMap?: Record<number, number>
  getAppIcon: (stepType?: string, stepIndex?: number, toolName?: string) => JSX.Element | null
  progressState: { text: string }
}

const ReasoningCtx = createContext<ReasoningContextValue | null>(null)

export const useReasoningContext = (): ReasoningContextValue => {
  const ctx = useContext(ReasoningCtx)
  if (!ctx) throw new Error("useReasoningContext must be used within ReasoningProvider")
  return ctx
}

export const ReasoningProvider: React.FC<{
  content: string
  isStreaming: boolean
  /** Wall-clock ms the backend took to generate this response — from ResponseMetadata or DB. */
  timeTakenMs?: number
  citations?: Citation[]
  citationMap?: Record<number, number>
  children: React.ReactNode
}> = ({ content, isStreaming, timeTakenMs, citations, citationMap, children }) => {
  // Use backend-provided duration directly; reset to null while streaming.
  const completionDurationMs = isStreaming ? null : (timeTakenMs ?? null)

  const getIconFromToolName = useCallback((toolName: string) => {
    switch (toolName) {
      case XyneTools.toDoWrite:
        return <Brain className="w-4 h-4" />
      case XyneTools.searchGlobal:
        return <Globe className="w-4 h-4" />
      case XyneTools.searchKnowledgeBase:
        return <BookOpen className="w-4 h-4" />
      case XyneTools.searchGmail:
        return <GmailIcon className="w-4 h-4" />
      case XyneTools.searchDriveFiles:
        return <DriveIcon className="w-4 h-4" />
      case XyneTools.searchCalendarEvents:
        return <GoogleCalendarIcon className="w-4 h-4" />
      case XyneTools.searchGoogleContacts:
        return <Users className="w-4 h-4" />
      case XyneTools.getSlackMessages:
      case XyneTools.getSlackUserProfile:
      case XyneTools.getSlackThreads:
        return <SlackIcon className="w-4 h-4" />
      case XyneTools.listCustomAgents:
      case XyneTools.runPublicAgent:
        return <Bot className="w-4 h-4" />
      case XyneTools.fallBack:
      case XyneTools.synthesizeFinalAnswer:
        return <XyneIcon className="w-4 h-4" />
      default:
        return <McpIcon className="w-4 h-4" />
    }
  }, [])

  const getAppIcon = useCallback(
    (stepType?: string, stepIndex?: number, toolName?: string) => {
      if (stepType === ReasoningEventType.PlanCreated && stepIndex === 0) {
        return <Brain className="w-4 h-4" />
      }
      return toolName ? getIconFromToolName(toolName) : null
    },
    [getIconFromToolName],
  )

  const parsed = useMemo((): ParsedReasoning => {
    if (!content.trim()) return { steps: [], agentPlans: {} }
    return parseReasoningContent(content)
  }, [content])

  const { steps, orchestratorPlan, agentPlans } = parsed

  const turns = useMemo(
    () => steps.filter((s) => s.type === ReasoningEventType.TurnStarted),
    [steps],
  )

  const preTurnSteps = useMemo(
    () => steps.filter((s) => s.type !== ReasoningEventType.TurnStarted),
    [steps],
  )

  const flatItems = useMemo(() => {
    const allSubsteps: ReasoningStep[] = [
      ...preTurnSteps,
      ...turns.flatMap((t) => t.substeps ?? []),
    ]
    return buildFlatItems(allSubsteps)
  }, [preTurnSteps, turns])

  const progressState = useMemo(
    () => getCurrentProgressState(steps, isStreaming, completionDurationMs),
    [steps, isStreaming, timeTakenMs], // completionDurationMs is derived from timeTakenMs+isStreaming
  )

  const value = useMemo<ReasoningContextValue>(
    () => ({
      steps,
      flatItems,
      orchestratorPlan,
      agentPlans,
      isStreaming,
      citations,
      citationMap,
      getAppIcon,
      progressState,
    }),
    [
      steps,
      flatItems,
      orchestratorPlan,
      agentPlans,
      isStreaming,
      citations,
      citationMap,
      getAppIcon,
      progressState,
    ],
  )

  return <ReasoningCtx.Provider value={value}>{children}</ReasoningCtx.Provider>
}
