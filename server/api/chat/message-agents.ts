/**
 * MessageAgents - JAF-Based Agentic Architecture Implementation
 * 
 * New agentic flow with:
 * - Single agent with toDoWrite for planning
 * - Automatic turn-end review
 * - Enhanced onBeforeToolExecution and onAfterToolExecution hooks
 * - Complete telemetry tracking
 * - Task-based sequential execution
 */

import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import { HTTPException } from "hono/http-exception"
import type {
  AgentRunContext,
  PlanState,
  ToolExecutionRecord,
  ReviewResult,
  AutoReviewInput,
  ToolFailureInfo,
  ToolExpectation,
  ToolExpectationAssignment,
  AgentImageMetadata,
  FinalSynthesisState,
  AgentRuntimeCallbacks,
  SubTask,
  MCPVirtualAgentRuntime,
  MCPToolDefinition,
  ReviewState,
} from "./agent-schemas"
import { ToolExpectationSchema, ReviewResultSchema } from "./agent-schemas"
import { getTracer } from "@/tracer"
import { getLogger, getLoggerWithChild } from "@/logger"
import { MessageRole, Subsystem, type UserMetadataType } from "@/types"
import config from "@/config"
import { Models, type ModelParams } from "@/ai/types"
import {
  runStream,
  generateRunId,
  generateTraceId,
  getTextContent,
  ToolResponse,
  type Agent as JAFAgent,
  type Message as JAFMessage,
  type RunConfig as JAFRunConfig,
  type RunState as JAFRunState,
  type Tool,
  type ToolCall,
  type ToolResult,
  type TraceEvent,
} from "@xynehq/jaf"
import { makeXyneJAFProvider } from "./jaf-provider"
import { buildContextSection } from "./jaf-adapter"
import { getErrorMessage } from "@/utils"
import { ChatSSEvents, AgentReasoningStepType } from "@/shared/types"
import type { MinimalAgentFragment, Citation, ImageCitation } from "./types"
import {
  extractBestDocumentIndexes,
  getProviderByModel,
  jsonParseLLMOutput,
} from "@/ai/provider"
import { answerContextMap, userContext } from "@/ai/context"
import { ConversationRole } from "@aws-sdk/client-bedrock-runtime"
import type { Message } from "@aws-sdk/client-bedrock-runtime"
import {
  TOOL_SCHEMAS,
  generateToolDescriptions,
  validateToolInput,
  ListCustomAgentsOutputSchema,
  type ListCustomAgentsOutput,
  type ToolOutput,
  type ResourceAccessSummary,
} from "./tool-schemas"
import { searchToCitation, extractImageFileNames } from "./utils"
import { GetDocumentsByDocIds } from "@/search/vespa"
import {
  Apps,
  KnowledgeBaseEntity,
  type VespaSearchResult,
  type VespaSearchResults,
} from "@xyne/vespa-ts/types"
import { expandSheetIds } from "@/search/utils"
import { parseAttachmentMetadata } from "@/utils/parseAttachment"
import { db } from "@/db/client"
import { insertChat, updateChatByExternalIdWithAuth } from "@/db/chat"
import { insertMessage } from "@/db/message"
import { storeAttachmentMetadata } from "@/db/attachment"
import { ChatType, type SelectChat, type SelectMessage } from "@/db/schema"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getUserAccessibleAgents } from "@/db/userAgentPermission"
import { executeAgentForWorkflowWithRag } from "@/api/agent/workflowAgentUtils"
import { getDateForAI } from "@/utils/index"
import googleTools from "./tools/google"
import { searchGlobalTool, fallbackTool } from "./tools/global"
import { getSlackRelatedMessagesTool } from "./tools/slack/getSlackMessages"
import type { AttachmentMetadata } from "@/shared/types"
import { processMessage } from "./utils"
import { checkAndYieldCitationsForAgent } from "./citation-utils"
import {
  evaluateAgentResourceAccess,
  getUserConnectorState,
  createEmptyConnectorState,
  type UserConnectorState,
} from "./resource-access"
import {
  getAgentByExternalIdWithPermissionCheck,
  type SelectAgent,
} from "@/db/agent"
import { isCuid } from "@paralleldrive/cuid2"
import { DEFAULT_TEST_AGENT_ID } from "@/shared/types"
import { parseAgentAppIntegrations } from "./tools/utils"
import { buildAgentPromptAddendum } from "./agentPromptCreation"
import { getConnectorById } from "@/db/connector"
import { getToolsByConnectorId } from "@/db/tool"
import {
  buildMCPJAFTools,
  type FinalToolsList,
} from "./jaf-adapter"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js"
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const {
  defaultBestModel,
  defaultFastModel,
  JwtPayloadKey,
  IMAGE_CONTEXT_CONFIG,
} = config
const Logger = getLogger(Subsystem.Chat)
const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

const MIN_TURN_NUMBER = 1
const ensureTurnNumber = (value?: number | null): number =>
  typeof value === "number" && value >= MIN_TURN_NUMBER ? value : MIN_TURN_NUMBER

type ReasoningPayload = {
  text: string
  step?: {
    type?: string
    iteration?: number
    toolName?: string
    status?: string
    stepSummary?: string
    [key: string]: unknown
  }
  quickSummary?: string
  aiSummary?: string
  [key: string]: unknown
}

type ReasoningEmitter = (payload: ReasoningPayload) => Promise<void>

async function streamReasoningStep(
  emitter: ReasoningEmitter | undefined,
  text: string,
  extra?: {
    type?: string
    iteration?: number
    toolName?: string
    status?: string
    detail?: string
    [key: string]: unknown
  }
): Promise<void> {
  if (!emitter) return
  try {
    // Build the step object to match agents.ts structure
    const step: Record<string, unknown> = {}
    
    // Set type - infer from context if not provided
    if (extra?.type) {
      step.type = extra.type
    } else if (extra?.iteration !== undefined && text.toLowerCase().includes('turn') && text.toLowerCase().includes('started')) {
      step.type = AgentReasoningStepType.Iteration
    } else {
      step.type = AgentReasoningStepType.LogMessage
    }
    
    if (extra?.iteration !== undefined) step.iteration = extra.iteration
    if (extra?.toolName !== undefined) step.toolName = extra.toolName
    if (extra?.status !== undefined) step.status = extra.status
    if (extra?.detail !== undefined) step.detail = extra.detail
    
    // Include any other extra properties in step
    Object.keys(extra || {}).forEach(key => {
      if (!['type', 'iteration', 'toolName', 'status', 'detail'].includes(key)) {
        step[key] = (extra as any)[key]
      }
    })
    
    await emitter({
      text,
      step: Object.keys(step).length > 0 ? step : undefined,
      quickSummary: text, // Use text as fallback summary
    })
  } catch (error) {
    Logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "Failed to stream reasoning step"
    )
  }
}

function truncateValue(value: string, maxLength = 160): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1)}…`
}

function formatToolArgumentsForReasoning(
  args: Record<string, unknown>
): string {
  if (!args || typeof args !== "object") {
    return "{}"
  }
  const entries = Object.entries(args)
  if (entries.length === 0) {
    return "{}"
  }
  const parts = entries.map(([key, value]) => {
    let serialized: string
    if (typeof value === "string") {
      serialized = `"${truncateValue(value, 80)}"`
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      serialized = String(value)
    } else {
      try {
        serialized = truncateValue(JSON.stringify(value), 80)
      } catch {
        serialized = "[unserializable]"
      }
    }
    return `${key}: ${serialized}`
  })
  const combined = parts.join(", ")
  return truncateValue(combined, 400)
}

function buildTurnToolReasoningSummary(
  turnNumber: number,
  records: ToolExecutionRecord[]
): string {
  const lines = records.map((record, idx) => {
    const argsSummary = formatToolArgumentsForReasoning(record.arguments)
    return `${idx + 1}. ${record.toolName} (${argsSummary})`
  })
  return `Tools executed in turn ${turnNumber}:\n${lines.join("\n")}`
}

function registerImageReferences(
  context: AgentRunContext,
  imageNames: string[],
  metadata: {
    turnNumber: number
    sourceFragmentId?: string | ((imageName: string) => string)
    sourceToolName: string
    isUserAttachment: boolean
  }
): number {
  if (!Array.isArray(imageNames) || imageNames.length === 0) {
    return 0
  }

  let added = 0
  const skipped: string[] = []
  
  for (const imageName of imageNames) {
    if (!imageName || context.imageMetadata.has(imageName)) {
      skipped.push(imageName || 'empty')
      continue
    }
    const fragmentId =
      typeof metadata.sourceFragmentId === "function"
        ? metadata.sourceFragmentId(imageName)
        : metadata.sourceFragmentId ?? ""
    context.imageFileNames.push(imageName)
    context.imageMetadata.set(imageName, {
      addedAtTurn: metadata.turnNumber,
      sourceFragmentId: fragmentId,
      sourceToolName: metadata.sourceToolName,
      isUserAttachment: metadata.isUserAttachment,
    })
    added++
  }
  
  if (added > 0) {
    // console.info('[IMAGE addition][Image Registry] Registered images:', {
    //   added,
    //   skipped: skipped.length,
    //   totalNow: context.imageFileNames.length,
    //   turn: metadata.turnNumber,
    //   source: metadata.sourceToolName,
    //   isAttachment: metadata.isUserAttachment,
    // })
  }
  
  return added
}

function getFragmentIdFromImageName(
  imageName: string,
  fragmentIndexMap: Map<number, string>,
  fallback = ""
): string {
  const separatorIdx = imageName.indexOf("_")
  if (separatorIdx <= 0) return fallback
  const docIndex = Number(imageName.slice(0, separatorIdx))
  if (Number.isNaN(docIndex)) return fallback
  return fragmentIndexMap.get(docIndex) ?? fallback
}

function getMetadataLayers(
  result: any
): Record<string, unknown>[] {
  const layers: Record<string, unknown>[] = []
  const metadata = result?.metadata
  if (metadata && typeof metadata === "object") {
    layers.push(metadata as Record<string, unknown>)
    const nested = (metadata as Record<string, unknown>).metadata
    if (nested && typeof nested === "object") {
      layers.push(nested as Record<string, unknown>)
    }
  }
  return layers
}

function getMetadataValue<T = unknown>(
  result: any,
  key: string
): T | undefined {
  for (const layer of getMetadataLayers(result)) {
    if (key in layer) {
      return layer[key] as T
    }
  }
  return undefined
}

function formatPlanForPrompt(plan: PlanState | null): string {
  if (!plan) return ""
  const lines = [`Goal: ${plan.goal}`]
  plan.subTasks.forEach((task, idx) => {
    const icon =
      task.status === "completed"
        ? "✓"
        : task.status === "in_progress"
          ? "→"
          : task.status === "failed"
            ? "✗"
            : task.status === "blocked"
              ? "!"
              : "○"
    const baseLine = `${idx + 1}. [${icon}] ${task.description}`
    const detailParts: string[] = []
    if (task.result) detailParts.push(`Result: ${task.result}`)
    if (task.toolsRequired?.length) {
      detailParts.push(`Tools: ${task.toolsRequired.join(", ")}`)
    }
    lines.push(
      detailParts.length > 0 ? `${baseLine}\n   ${detailParts.join(" | ")}` : baseLine
    )
  })
  return lines.join("\n")
}

function selectActiveSubTaskId(plan: PlanState | null): string | null {
  if (!plan || !Array.isArray(plan.subTasks) || plan.subTasks.length === 0) {
    return null
  }
  const priority: Array<SubTask["status"]> = [
    "in_progress",
    "pending",
    "blocked",
  ]
  for (const status of priority) {
    const match = plan.subTasks.find(
      (task) => task.status === status && task.id
    )
    if (match?.id) {
      return match.id
    }
  }
  return plan.subTasks[0]?.id ?? null
}

function normalizeSubTask(task: SubTask): SubTask {
  task.toolsRequired = Array.isArray(task.toolsRequired)
    ? task.toolsRequired
    : []
  task.completedTools = Array.isArray(task.completedTools)
    ? task.completedTools
    : []
  if (
    task.status !== "pending" &&
    task.status !== "in_progress" &&
    task.status !== "completed" &&
    task.status !== "failed" &&
    task.status !== "blocked"
  ) {
    task.status = "pending"
  }
  return task
}

function initializePlanState(plan: PlanState): string | null {
  plan.subTasks.forEach((task) => normalizeSubTask(task))
  let activeId = selectActiveSubTaskId(plan)
  const visited = new Set<string>()
  while (activeId && !visited.has(activeId)) {
    visited.add(activeId)
    const activeTask = plan.subTasks.find((task) => task.id === activeId)
    if (!activeTask) break
    if ((activeTask.toolsRequired?.length ?? 0) === 0) {
      activeTask.status = "completed"
      activeTask.completedAt = Date.now()
      activeTask.result =
        activeTask.result ||
        "Completed automatically (no tools required for this step)."
      activeTask.error = undefined
      activeId = selectActiveSubTaskId(plan)
      continue
    }
    if (
      activeTask.status === "pending" ||
      activeTask.status === "blocked"
    ) {
      activeTask.status = "in_progress"
      activeTask.error = undefined
    }
    break
  }
  return activeId ?? null
}

function advancePlanAfterTool(
  context: AgentRunContext,
  toolName: string,
  wasSuccessful: boolean,
  detail?: string
): void {
  if (!context.plan || !context.currentSubTask) return
  const task = context.plan.subTasks.find(
    (entry) => entry.id === context.currentSubTask
  )
  if (!task) return
  normalizeSubTask(task)

  if (wasSuccessful) {
    if (task.status === "pending" || task.status === "blocked") {
      task.status = "in_progress"
      task.error = undefined
    }
    if (
      task.toolsRequired.length === 0 ||
      task.toolsRequired.includes(toolName)
    ) {
      if (!task.completedTools.includes(toolName)) {
        task.completedTools.push(toolName)
      }
      const uniqueRequired = new Set(task.toolsRequired)
      const uniqueCompleted = new Set(task.completedTools)
      const shouldComplete =
        task.toolsRequired.length === 0 ||
        uniqueCompleted.size >= uniqueRequired.size
      if (shouldComplete) {
        task.status = "completed"
        task.completedAt = Date.now()
        task.result =
          detail ||
          task.result ||
          `Completed using ${Array.from(uniqueCompleted).join(", ")}`
        const previousTaskId = task.id
        const nextId = selectActiveSubTaskId(context.plan)
        if (nextId && nextId !== previousTaskId) {
          context.currentSubTask = nextId
          const nextTask = context.plan.subTasks.find(
            (entry) => entry.id === nextId
          )
          if (nextTask && nextTask.status === "pending") {
            nextTask.status = "in_progress"
            nextTask.error = undefined
          }
        } else if (!nextId) {
          context.currentSubTask = null
        }
      }
    }
  } else if (task.status !== "completed") {
    task.status = "blocked"
    task.error = detail
  }
}

function formatClarificationsForPrompt(
  clarifications: AgentRunContext["clarifications"]
): string {
  if (!clarifications?.length) return ""
  const formatted = clarifications
    .map(
      (clarification, idx) =>
        `${idx + 1}. Q: ${clarification.question}\n   A: ${clarification.answer}`
    )
    .join("\n")
  return formatted
}

function buildFinalSynthesisPayload(
  context: AgentRunContext,
  fragmentsLimit = Math.max(12, context.contextFragments.length || 1)
): { systemPrompt: string; userMessage: string } {
  const fragmentsSection = buildContextSection(context.contextFragments, fragmentsLimit)
  const planSection = formatPlanForPrompt(context.plan)
  const clarificationSection = formatClarificationsForPrompt(context.clarifications)
  const workspaceSection = context.userContext?.trim()
    ? `Workspace Context:\n${context.userContext}`
    : ""

  const parts = [
    `User Question:\n${context.message.text}`,
    planSection ? `Execution Plan Snapshot:\n${planSection}` : "",
    clarificationSection ? `Clarifications Resolved:\n${clarificationSection}` : "",
    workspaceSection,
    fragmentsSection,
  ].filter(Boolean)

  const userMessage = parts.join("\n\n")

  const systemPrompt = `
### Mission
- Deliver the user's final answer using the conversation, plan snapshot, clarifications, workspace context, context fragments, and supplied images; never plan or call tools.

### Evidence Intake
- Prioritize the highest-signal fragments, but pull any supporting fragment that improves accuracy.
- Treat delegated-agent outputs as citeable fragments; reference them like any other context entry.
- Describe evidence gaps plainly before concluding; never guess.
- Extract actionable details from provided images and cite them via their fragment indices.

### Response Construction
- Lead with the conclusion, then stack proof underneath.
- Organize output into tight sections (e.g., **Summary**, **Proof**, **Next Steps** when relevant); omit empty sections.
- Never mention internal tooling, planning logs, or this synthesis process.

### Constraint Handling
- When the user asks for an action the system cannot execute (e.g., sending an email), deliver the closest actionable substitute (draft, checklist, explicit next steps) inside the answer.
- Pair the substitute with a concise explanation of the limitation and the manual action the user must take.

### Citation Discipline
- Cite each factual sentence immediately with \`[n]\` (1-based); one fragment per bracket—never combine numbers.
- Cite only when the fragment explicitly supports the statement; leave interpretations or gap notes uncited.
- When evidence is missing, state the gap plus the data required to close it.

### Tone & Delivery
- Answer with confident, declarative, verb-first sentences that use concrete nouns.
- Highlight key deliverables using **bold** labels or short lists; keep wording razor-concise.
- Ask one targeted follow-up question only if missing info blocks action.

### Tool Spotlighting
- Reference critical tool outputs explicitly, e.g., "**Slack Search:** Ops escalated the RCA at 09:42 [2]."
- Explain why each highlighted tool mattered so reviewers see coverage breadth.
- When multiple tools contribute, show the sequence, e.g., "**Vespa Search:** context -> **Sheet Lookup:** metrics."

### Finish
- Close with a single sentence confirming completion or the next action you recommend.
`.trim()

  return { systemPrompt, userMessage }
}

function selectImagesForFinalSynthesis(
  context: AgentRunContext
): {
  selected: string[]
  total: number
  dropped: string[]
  userAttachmentCount: number
} {
  const total = context.imageFileNames.length
  if (!IMAGE_CONTEXT_CONFIG.enabled || total === 0) {
    return { selected: [], total, dropped: [], userAttachmentCount: 0 }
  }

  const attachmentNames: string[] = []
  const otherNames: string[] = []

  for (const imageName of context.imageFileNames) {
    const metadata = context.imageMetadata.get(imageName)
    if (metadata?.isUserAttachment) {
      attachmentNames.push(imageName)
    } else {
      otherNames.push(imageName)
    }
  }

  const prioritized = [...attachmentNames, ...otherNames]
  let selected = prioritized
  let dropped: string[] = []

  if (
    IMAGE_CONTEXT_CONFIG.maxImagesPerCall > 0 &&
    prioritized.length > IMAGE_CONTEXT_CONFIG.maxImagesPerCall
  ) {
    selected = prioritized.slice(0, IMAGE_CONTEXT_CONFIG.maxImagesPerCall)
    dropped = prioritized.slice(IMAGE_CONTEXT_CONFIG.maxImagesPerCall)
  }

  return {
    selected,
    total,
    dropped,
    userAttachmentCount: attachmentNames.length,
  }
}

/**
 * Initialize AgentRunContext with default values
 */
function initializeAgentContext(
  userEmail: string,
  workspaceId: string,
  userId: number,
  chatExternalId: string,
  messageText: string,
  attachments: Array<{ fileId: string; isImage: boolean }>,
  options?: {
    userContext?: string
    agentPrompt?: string
    workspaceNumericId?: number
  }
): AgentRunContext {
  const finalSynthesis: FinalSynthesisState = {
    requested: false,
    completed: false,
    suppressAssistantStreaming: false,
    streamedText: "",
    ackReceived: false,
  }

  return {
    user: {
      email: userEmail,
      workspaceId,
      id: String(userId),
      numericId: userId,
      workspaceNumericId: options?.workspaceNumericId,
    },
    chat: {
      externalId: chatExternalId,
      metadata: {},
    },
    message: {
      text: messageText,
      attachments,
      timestamp: new Date().toISOString(),
    },
    plan: null,
    currentSubTask: null,
    userContext: options?.userContext ?? "",
    agentPrompt: options?.agentPrompt,
    clarifications: [],
    ambiguityResolved: false,
    toolCallHistory: [],
    contextFragments: [],
    seenDocuments: new Set<string>(),
    imageFileNames: [],
    imageMetadata: new Map<string, AgentImageMetadata>(),
    turnCount: MIN_TURN_NUMBER,
    totalLatency: 0,
    totalCost: 0,
    tokenUsage: {
      input: 0,
      output: 0,
    },
    availableAgents: [],
    usedAgents: [],
    enabledTools: new Set<string>(),
    delegationEnabled: true,
    failedTools: new Map<string, ToolFailureInfo>(),
    retryCount: 0,
    maxRetries: 3,
    review: {
      lastReviewTurn: null,
      reviewFrequency: 5,
      lastReviewSummary: null,
      lastReviewResult: null,
      outstandingAnomalies: [],
      clarificationQuestions: [],
      cachedPlanSummary: undefined,
      cachedContextSummary: undefined,
    },
    decisions: [],
    finalSynthesis,
    runtime: undefined,
    maxOutputTokens: undefined,
  }
}

/**
 * Perform automatic turn-end review (STUB for now)
 * Called deterministically after every turn
 */
async function performAutomaticReview(
  input: AutoReviewInput,
  fullContext: AgentRunContext,
  conversationMessages?: Message[]
): Promise<ReviewResult> {
  try {
    const reviewContext: AgentRunContext = {
      ...fullContext,
      toolCallHistory: input.toolCallHistory,
      contextFragments: input.contextFragments,
      plan: input.plan,
    }
    const review = await runReviewLLM(reviewContext, {
      focus: input.focus,
      turnNumber: input.turnNumber,
      expectedResults: input.expectedResults,
      delegationEnabled: fullContext.delegationEnabled,
      messages: conversationMessages,
    })
    return review
  } catch (error) {
    Logger.error(error, "Automatic review failed, falling back to default response")
    return {
      status: "needs_attention",
      notes: `Automatic review fallback for turn ${input.turnNumber}: ${getErrorMessage(error)}`,
      toolFeedback: [],
      unmetExpectations: [],
      planChangeNeeded: false,
      anomaliesDetected: false,
      anomalies: [],
      recommendation: "proceed",
      ambiguityResolved: false,
      clarificationQuestions: [],
    }
  }
}

async function handleReviewOutcome(
  context: AgentRunContext,
  reviewResult: ReviewResult,
  iteration: number,
  focus: AutoReviewInput["focus"],
  reasoningEmitter?: ReasoningEmitter
): Promise<void> {
  context.review.lastReviewSummary = reviewResult.notes
  context.review.lastReviewResult = reviewResult
  context.review.lastReviewTurn = iteration
  context.ambiguityResolved = reviewResult.ambiguityResolved
  context.review.outstandingAnomalies =
    reviewResult.anomalies?.length ? reviewResult.anomalies : []
  context.review.clarificationQuestions =
    reviewResult.clarificationQuestions?.length
      ? reviewResult.clarificationQuestions
      : []

  await streamReasoningStep(
    reasoningEmitter,
    `Review (${focus}) complete. Recommendation: ${reviewResult.recommendation}. Plan change needed: ${reviewResult.planChangeNeeded ? "yes" : "no"}.`,
    {
      iteration,
      status: reviewResult.status,
      detail: reviewResult.notes,
      anomaliesDetected: reviewResult.anomaliesDetected,
      review: reviewResult,
      ambiguityResolved: reviewResult.ambiguityResolved,
      anomalies: reviewResult.anomalies,
      focus,
    }
  )

  if (
    reviewResult.anomaliesDetected ||
    (reviewResult.anomalies?.length ?? 0) > 0
  ) {
    Logger.info({
      turn: iteration,
      anomalies: reviewResult.anomalies,
      recommendation: reviewResult.recommendation,
      planChangeNeeded: reviewResult.planChangeNeeded,
      chatId: context.chat.externalId,
      focus,
    }, "[MessageAgents][Anomalies]")
    await streamReasoningStep(
      reasoningEmitter,
      `Anomalies detected: ${
        reviewResult.anomalies?.join("; ") || "unspecified"
      }`,
      {
        iteration,
        status: "needs_attention",
        detail: reviewResult.anomalies?.join("; "),
        ambiguityResolved: reviewResult.ambiguityResolved,
        anomalies: reviewResult.anomalies,
        focus,
      }
    )
  }
}

type AttachmentPhaseMetadata = {
  initialAttachmentPhase?: boolean
  initialAttachmentSummary?: string
}

function getAttachmentPhaseMetadata(
  context: AgentRunContext
): AttachmentPhaseMetadata {
  return (context.chat.metadata as AttachmentPhaseMetadata) || {}
}

type ChatBootstrapParams = {
  chatId?: string
  email: string
  user: { id: number; email: string }
  workspace: { id: number; externalId: string }
  message: string
  fileIds: string[]
  attachmentMetadata: AttachmentMetadata[]
  modelId?: string
  agentId?: string | null
}

type ChatBootstrapResult = {
  chat: SelectChat
  userMessage: SelectMessage
}

async function ensureChatAndPersistUserMessage(
  params: ChatBootstrapParams
): Promise<ChatBootstrapResult> {
  return await db.transaction(async (tx) => {
    if (!params.chatId) {
      const chat = await insertChat(tx, {
        workspaceId: params.workspace.id,
        workspaceExternalId: params.workspace.externalId,
        userId: params.user.id,
        email: params.user.email,
        title: "Untitled",
        attachments: [],
        agentId: params.agentId ?? undefined,
        chatType: ChatType.Default,
      })

      const userMessage = await insertMessage(tx, {
        chatId: chat.id,
        userId: params.user.id,
        workspaceExternalId: params.workspace.externalId,
        chatExternalId: chat.externalId,
        messageRole: MessageRole.User,
        email: params.user.email,
        sources: [],
        message: params.message,
        modelId: (params.modelId as Models) || defaultBestModel,
        fileIds: params.fileIds,
      })

      if (params.attachmentMetadata.length > 0) {
        await storeAttachmentSafely(tx, params.email, userMessage.externalId, params.attachmentMetadata)
      }

      return { chat, userMessage }
    }

    const chat = await updateChatByExternalIdWithAuth(
      tx,
      params.chatId,
      params.email,
      {}
    )

    const userMessage = await insertMessage(tx, {
      chatId: chat.id,
      userId: params.user.id,
      workspaceExternalId: params.workspace.externalId,
      chatExternalId: chat.externalId,
      messageRole: MessageRole.User,
      email: params.user.email,
      sources: [],
      message: params.message,
      modelId: (params.modelId as Models) || defaultBestModel,
      fileIds: params.fileIds,
    })

    if (params.attachmentMetadata.length > 0) {
      await storeAttachmentSafely(tx, params.email, userMessage.externalId, params.attachmentMetadata)
    }

    return { chat, userMessage }
  })
}

async function storeAttachmentSafely(
  tx: Parameters<typeof storeAttachmentMetadata>[0],
  email: string,
  messageExternalId: string,
  attachments: AttachmentMetadata[]
) {
  try {
    await storeAttachmentMetadata(tx, messageExternalId, attachments, email)
  } catch (error) {
    loggerWithChild({ email }).error(
      error,
      `Failed to store attachment metadata for message ${messageExternalId}`
    )
  }
}

async function vespaResultToAttachmentFragment(
  child: VespaSearchResult,
  idx: number,
  userMetadata: UserMetadataType,
  query: string
): Promise<MinimalAgentFragment> {
  const docId =
    (child.fields as Record<string, unknown>)?.docId ||
    `attachment_fragment_${idx}`

  return {
    id: String(docId),
    content: await answerContextMap(
      child as VespaSearchResults,
      userMetadata,
      0,
      true,
      undefined,
      query
    ),
    source: searchToCitation(child as VespaSearchResults),
    confidence: 1,
  }
}

async function prepareInitialAttachmentContext(
  fileIds: string[],
  userMetadata: UserMetadataType,
  query: string
): Promise<{ fragments: MinimalAgentFragment[]; summary: string } | null> {
  if (!fileIds?.length) {
    return null
  }

  const tracer = getTracer("chat")
  const span = tracer.startSpan("prepare_initial_attachment_context")

  try {
    const results = await GetDocumentsByDocIds(fileIds, span)
    const children = results?.root?.children || []
    if (children.length === 0) {
      return null
    }

    const fragments = await Promise.all(
      children.map((child, idx) =>
        vespaResultToAttachmentFragment(
          child as VespaSearchResult,
          idx,
          userMetadata,
          query
        )
      )
    )

    const summary = `User provided ${fragments.length} attachment fragment${
      fragments.length === 1 ? "" : "s"
    } for the first turn.`
    return { fragments, summary }
  } catch (error) {
    span.addEvent("attachment_context_error", {
      message: getErrorMessage(error),
    })
    Logger.error(error, "Failed to load attachment context")
    return null
  } finally {
    span.end()
  }
}

/**
 * onBeforeToolExecution Hook Implementation
 * Handles:
 * - Input validation against schemas
 * - Duplicate detection
 * - Failed tool budget check (3-strike rule)
 * - excludedIds injection
 */
export async function beforeToolExecutionHook(
  toolName: string,
  args: any,
  context: AgentRunContext,
  reasoningEmitter?: ReasoningEmitter
): Promise<any | null> {
  // 0. Validate input against schema
  const validation = validateToolInput(toolName, args)
  if (!validation.success) {
    await streamReasoningStep(
      reasoningEmitter,
      `⚠️ Invalid input for ${toolName}: ${validation.error.message}`,
      { toolName }
    )
    Logger.warn(
      `Tool input validation failed for ${toolName}: ${validation.error.message}`
    )
    // Don't block - let tool handle invalid input, but log it
  }

  // 1. Duplicate detection
  const isDuplicate = context.toolCallHistory.some(
    (record) =>
      record.toolName === toolName &&
      JSON.stringify(record.arguments) === JSON.stringify(args) &&
      record.status === "success" &&
      Date.now() - record.startedAt.getTime() < 60000 // 1 minute
  )

  if (isDuplicate) {
    await streamReasoningStep(
      reasoningEmitter,
      `Skipping redundant tool call to '${toolName}'.`,
      { toolName, status: "skipped" }
    )
    return null // Skip execution
  }

  // 2. Failed tool budget check
  const failureInfo = context.failedTools.get(toolName)
  if (failureInfo && failureInfo.count >= 3) {
    await streamReasoningStep(
      reasoningEmitter,
      `Tool '${toolName}' has failed ${failureInfo.count} times and is now blocked.`,
      { toolName, status: "blocked" }
    )
    return null // Skip execution
  }

  // 3. Add excludedIds to prevent re-fetching seen documents
  if (args.excludedIds !== undefined) {
    const seenIds = Array.from(context.seenDocuments)
    return {
      ...args,
      excludedIds: [...(args.excludedIds || []), ...seenIds],
    }
  }

  return args
}

/**
 * onAfterToolExecution Hook Implementation
 * Handles:
 * - ToolExecutionRecord creation and logging
 * - Context extraction and filtering
 * - Metrics update
 * - Failure tracking
 * - SSE event emission
 */
export async function afterToolExecutionHook(
  toolName: string,
  result: any,
  hookContext: {
    toolCall: ToolCall
    args: any
    state: JAFRunState<AgentRunContext>
    agentName: string
    executionTime: number
    status: string | ToolResult
  },
  userMessage: string,
  messagesWithNoErrResponse: Message[],
  gatheredFragmentskeys: Set<string>,
  expectedResult: ToolExpectation | undefined,
  reasoningEmitter?: ReasoningEmitter,
  turnNumber?: number
): Promise<string | null> {
  const { state, executionTime, status, args } = hookContext
  const context = state.context as AgentRunContext

  // 1. Create execution record
  const providedTurn =
    typeof turnNumber === "number" ? turnNumber : undefined
  const effectiveTurnNumber = ensureTurnNumber(
    providedTurn ?? context.turnCount
  )

  if (providedTurn === undefined && context.turnCount >= MIN_TURN_NUMBER) {
    Logger.info(
      {
        toolName,
        providedTurnNumber: turnNumber,
        fallbackTurnNumber: context.turnCount,
      },
      "Tool turnNumber not provided; falling back to current turnCount"
    )
  }

  const record: ToolExecutionRecord = {
    toolName,
    connectorId: result?.metadata?.connectorId || null,
    agentName: hookContext.agentName,
    arguments: args,
    turnNumber: effectiveTurnNumber,
    expectedResults: expectedResult,
    startedAt: new Date(Date.now() - executionTime),
    durationMs: executionTime,
    estimatedCostUsd: result?.metadata?.estimatedCostUsd || 0,
    resultSummary: JSON.stringify(result?.data || {}).slice(0, 200),
    fragmentsAdded: result?.metadata?.fragmentsAdded || [],
    status: status === "success" ? "success" : "error",
    error:
      status !== "success"
        ? {
            code: result?.error?.code || "UNKNOWN",
            message: result?.error?.message || "Unknown error",
          }
        : undefined,
  }

  // 2. Add to history
  context.toolCallHistory.push(record)

  // 3. Update metrics
  context.totalLatency += executionTime
  context.totalCost += record.estimatedCostUsd

  // 4. Track failures
  if (status !== "success") {
    const existing = context.failedTools.get(toolName) || {
      count: 0,
      lastError: "",
      lastAttempt: 0,
    }
    context.failedTools.set(toolName, {
      count: existing.count + 1,
      lastError: record.error!.message,
      lastAttempt: Date.now(),
    })
  }

  advancePlanAfterTool(
    context,
    toolName,
    status === "success",
    record.resultSummary
  )

  // 5. Extract and filter contexts
  const contexts = getMetadataValue<MinimalAgentFragment[]>(result, "contexts")
  if (Array.isArray(contexts) && contexts.length > 0) {
    const filteredContexts = contexts.filter(
      (c: MinimalAgentFragment) => !gatheredFragmentskeys.has(c.id)
    )

    if (filteredContexts.length > 0) {
      await streamReasoningStep(
        reasoningEmitter,
        `Received ${filteredContexts.length} document${
          filteredContexts.length === 1 ? "" : "s"
        }. Now filtering and ranking the most relevant ones.`,
        { toolName }
      )

      const contextStrings = filteredContexts.map(
        (v: MinimalAgentFragment) => {
          context.seenDocuments.add(v.id)
          return `
            title: ${v.source.title}\n
            content: ${v.content}\n
          `
        }
      )

      try {
        // Use extractBestDocumentIndexes to filter to best documents
        const bestDocIndexes = await extractBestDocumentIndexes(
          userMessage,
          contextStrings,
          {
            modelId: config.defaultBestModel,
            json: false,
            stream: false,
          },
          messagesWithNoErrResponse
        )

        if (bestDocIndexes.length > 0) {
          const selectedDocs: MinimalAgentFragment[] = []

          bestDocIndexes.forEach((idx) => {
            if (idx >= 1 && idx <= filteredContexts.length) {
              const doc: MinimalAgentFragment = filteredContexts[idx - 1]
              const key = doc.id
              if (!gatheredFragmentskeys.has(key)) {
                context.contextFragments.push(doc)
                gatheredFragmentskeys.add(key)
              }
              selectedDocs.push(doc)
            }
          })

          // Update record with actual fragments added
          record.fragmentsAdded = selectedDocs.map((d) => d.id)

          await streamReasoningStep(
            reasoningEmitter,
            `Filtered down to ${selectedDocs.length} best document${
              selectedDocs.length === 1 ? "" : "s"
            } for analysis.`,
            { toolName, detail: selectedDocs.map((doc) => doc.source.title || doc.id).join(", ") }
          )

          if (IMAGE_CONTEXT_CONFIG.enabled && selectedDocs.length > 0) {
            const vespaLikeResults = selectedDocs.map((doc, idx) => ({
              id: doc.id,
              relevance: 0,
              fields: { docId: doc.source.docId },
            })) as unknown as VespaSearchResult[]

            const combinedContext = selectedDocs
              .map((doc) => doc.content)
              .join("\n")
            
            // console.info('[IMAGE addition][Image Extraction] Processing tool result:', {
            //   toolName,
            //   turn: context.turnCount,
            //   documentCount: selectedDocs.length,
            //   contextLength: combinedContext.length,
            //   currentImageCount: context.imageFileNames.length,
            // })
            
            const { imageFileNames: extractedImages } = extractImageFileNames(
              combinedContext,
              vespaLikeResults
            )

            // console.info('[IMAGE addition][Image Extraction] Extracted image references:', {
            //   toolName,
            //   turn: context.turnCount,
            //   extractedCount: extractedImages.length,
            //   extractedImages: extractedImages.slice(0, 5),
            //   currentContextImages: context.imageFileNames.length,
            // })

            if (extractedImages.length > 0) {
              const fragmentIndexMap = new Map<number, string>()
              selectedDocs.forEach((doc, idx) => {
                fragmentIndexMap.set(idx, doc.id)
              })
              const turnNumber = ensureTurnNumber(context.turnCount)
              const addedImages = registerImageReferences(
                context,
                extractedImages,
                {
                  turnNumber,
                  sourceFragmentId: (imageName: string) =>
                    getFragmentIdFromImageName(
                      imageName,
                      fragmentIndexMap,
                      selectedDocs[0]?.id || ""
                    ),
                  sourceToolName: toolName,
                  isUserAttachment: false,
                }
              )
              
              // console.info('[IMAGE addition][Image Registry] After registration:', {
              //   toolName,
              //   turn: turnNumber,
              //   addedImages,
              //   totalImagesNow: context.imageFileNames.length,
              //   totalMetadataNow: context.imageMetadata.size,
              //   firstFewImages: context.imageFileNames.slice(0, 3),
              // })
              if (addedImages > 0) {
                loggerWithChild({ email: context.user.email }).info(
                  `Tracked ${addedImages} new image${
                    addedImages === 1 ? "" : "s"
                  } from ${toolName} on turn ${turnNumber}`
                )
              }
            }
          }

          // Emit SSE event (ToolMetric event to be added to ChatSSEvents later)
          // if (emitSSE) {
          //   await emitSSE(ChatSSEvents.ToolMetric, {
          //     toolName,
          //     durationMs: executionTime,
          //     cost: record.estimatedCostUsd,
          //     status,
          //     fragmentsAdded: record.fragmentsAdded.length,
          //   })
          // }

          return selectedDocs.map((doc) => doc.content).join("\n")
        }
      } catch (error) {
        await streamReasoningStep(
          reasoningEmitter,
          "Context ranking failed, retaining all retrieved documents.",
          { toolName }
        )
        // Fallback: add all contexts if extraction fails
        filteredContexts.forEach((doc: MinimalAgentFragment) => {
          const key = doc.id
          if (!gatheredFragmentskeys.has(key)) {
            context.contextFragments.push(doc)
            gatheredFragmentskeys.add(key)
          }
        })
        record.fragmentsAdded = filteredContexts.map((d: MinimalAgentFragment) => d.id)
      }
    }
  }

  // Emit metrics even if no contexts (ToolMetric event to be added to ChatSSEvents later)
  // if (emitSSE) {
  //   await emitSSE(ChatSSEvents.ToolMetric, {
  //     toolName,
  //     durationMs: executionTime,
  //     cost: record.estimatedCostUsd,
  //     status,
  //     fragmentsAdded: record.fragmentsAdded.length,
  //   })
  // }

  if (
    toolName === "toDoWrite" &&
    result &&
    typeof result === "object" &&
    result.status === "success"
  ) {
    const plan = result.data?.plan as PlanState | undefined
    if (plan) {
      const nextStep = plan.subTasks?.[0]?.description || "No sub-tasks defined."
      await streamReasoningStep(
        reasoningEmitter,
        `Plan created: ${plan.goal || "Goal not specified"}. Next step: ${nextStep}`,
        { toolName }
      )
    }
  }

  if (
    toolName === "list_custom_agents" &&
    result &&
    typeof result === "object" &&
    result.status === "success"
  ) {
    const agents = getMetadataValue<ListCustomAgentsOutput["agents"]>(
      result,
      "agents"
    )
    const agentCount = Array.isArray(agents) ? agents.length : 0
    await streamReasoningStep(
      reasoningEmitter,
      agentCount
        ? `Found ${agentCount} suitable agent${agentCount === 1 ? "" : "s"}. Evaluating options...`
        : "No suitable custom agents found. Continuing with built-in tools.",
      { toolName, detail: agentCount ? agents?.map((a) => a.agentName).join(", ") : undefined }
    )
  }

  if (
    toolName === "run_public_agent" &&
    result &&
    typeof result === "object" &&
    result.status === "success"
  ) {
    const agentId = getMetadataValue<string>(result, "agentId")
      || (hookContext?.args as { agentId?: string })?.agentId
    const agentName =
      context.availableAgents.find((agent) => agent.agentId === agentId)
        ?.agentName || agentId || "unknown agent"
    mergeAgentDelegationOutput({
      context,
      result,
      gatheredFragmentsKeys,
      agentId,
      agentName,
      turnNumber: turnNumber ?? context.turnCount,
      sourceToolName: toolName,
    })
    await streamReasoningStep(
      reasoningEmitter,
      `Received response from '${agentName}' agent.`,
      { toolName, detail: agentName }
    )
  }

  if (
    toolName === "fall_back" &&
    result &&
    typeof result === "object" &&
    result.status === "success"
  ) {
    await streamReasoningStep(
      reasoningEmitter,
      "Fallback analysis completed. Captured reasoning on why earlier attempts failed.",
      { toolName }
    )
  }

  return null
}


function mergeAgentDelegationOutput(opts: {
  context: AgentRunContext
  result: any
  gatheredFragmentsKeys: Set<string>
  agentId?: string
  agentName?: string
  turnNumber?: number
  sourceToolName: string
}): void {
  const { context, result, gatheredFragmentsKeys, agentId, agentName, turnNumber, sourceToolName } = opts
  const metadata = (result?.data as any)?.metadata || (result as any)?.metadata || {}
  const citations = metadata?.citations as Citation[] | undefined
  const imageCitations = metadata?.imageCitations as ImageCitation[] | undefined
  const agentFragments: MinimalAgentFragment[] = []
  const textResult =
    typeof (result?.data as any)?.result === "string"
      ? (result.data as any).result
      : typeof result?.result === "string"
        ? result.result
        : ""

  if (Array.isArray(citations) && citations.length > 0) {
    citations.forEach((citation, idx) => {
      const fragmentTurn = ensureTurnNumber(turnNumber ?? context.turnCount)
      const fragmentId = `${agentId || "agent"}:${citation.docId || idx}:${fragmentTurn}:${idx}`
      if (gatheredFragmentsKeys.has(fragmentId)) return
      agentFragments.push({
        id: fragmentId,
        content: textResult || citation.url || "Agent response",
        source: citation,
        confidence: 0.85,
      })
    })
  }

  // Add an attribution fragment for the delegated agent itself so downstream synthesis can cite the agent as a source.
  if (agentId) {
    const attributionFragmentId = `agent:${agentId}:turn:${ensureTurnNumber(
      turnNumber ?? context.turnCount
    )}`
    if (!gatheredFragmentsKeys.has(attributionFragmentId)) {
      agentFragments.push({
        id: attributionFragmentId,
        content: textResult || `Response provided by delegated agent ${agentName || agentId}`,
        source: {
          docId: `agent:${agentId}`,
          title: `Delegated agent: ${agentName || agentId}`,
          url: `/agents/${agentId}`,
          app: Apps.KnowledgeBase,
          entity: KnowledgeBaseEntity.File,
        } as Citation,
        confidence: 0.9,
      })
    }
  }

  // Prepend agent fragments (citations + attribution) so they are prioritized for synthesis.
  if (agentFragments.length > 0) {
    const existing = context.contextFragments.filter(
      (frag) => !agentFragments.some((a) => a.id === frag.id)
    )
    agentFragments.forEach((frag) => gatheredFragmentsKeys.add(frag.id))
    context.contextFragments = [...agentFragments, ...existing]
  }

  if (Array.isArray(imageCitations) && imageCitations.length > 0) {
    const imageNames = imageCitations
      .map((entry) => entry.imagePath)
      .filter((name): name is string => Boolean(name))
    if (imageNames.length > 0) {
      registerImageReferences(context, imageNames, {
        turnNumber: typeof turnNumber === "number" ? turnNumber : 0,
        sourceFragmentId: `${agentId || "agent"}:delegation`,
        sourceToolName,
        isUserAttachment: false,
      })
    }
  }
}

type PendingExpectation = ToolExpectationAssignment

export function extractExpectedResults(text: string): PendingExpectation[] {
  const expectations: PendingExpectation[] = []
  if (!text) return expectations

  const expectationRegex = /<expected_results>([\s\S]*?)<\/expected_results>/gi
  let match: RegExpExecArray | null

  while ((match = expectationRegex.exec(text)) !== null) {
    const body = match[1]?.trim()
    if (!body) continue

    const parsed = safeJsonParse(body)
    const entries = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as any)?.toolExpectations)
        ? (parsed as any).toolExpectations
        : []

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue
      const toolName = typeof entry.toolName === "string" ? entry.toolName.trim() : ""
      if (!toolName) continue

      const expectationCandidate = {
        goal: (entry as any).goal,
        successCriteria: (entry as any).successCriteria,
        failureSignals: (entry as any).failureSignals,
        stopCondition: (entry as any).stopCondition,
        evidencePlan: (entry as any).evidencePlan,
      }

      const validation = ToolExpectationSchema.safeParse(expectationCandidate)
      if (!validation.success) {
        Logger.warn(
          { toolName, error: validation.error.format() },
          "Invalid expected_results entry emitted by agent"
        )
        continue
      }

      expectations.push({ toolName, expectation: validation.data })
    }
  }

  return expectations
}

function consumePendingExpectation(
  queue: PendingExpectation[],
  toolName: string
): PendingExpectation | undefined {
  if (!toolName) return undefined
  const idx = queue.findIndex(
    (entry) => entry.toolName.toLowerCase() === toolName.toLowerCase()
  )
  if (idx === -1) {
    return undefined
  }
  return queue.splice(idx, 1)[0]
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function summarizePlan(plan: PlanState | null): string {
  Logger.info({ plan }, "summarizePlan input")
  if (!plan) {
    Logger.info(
      { summary: "No plan available." },
      "summarizePlan output"
    )
    return "No plan available."
  }
  const steps = plan.subTasks
    .map(
      (task, idx) =>
        `${idx + 1}. [${task.status}] ${task.description}${
          task.toolsRequired?.length
            ? ` (tools: ${task.toolsRequired.join(", ")})`
            : ""
        }`
    )
    .join("\n")
  const summary = `Goal: ${plan.goal}\n${steps}`
  Logger.info(
    { summary, subTaskCount: plan.subTasks.length },
    "summarizePlan output"
  )
  return summary
}

function summarizeExpectations(
  expectations?: ToolExpectationAssignment[]
): string {
  Logger.info({ expectations }, "summarizeExpectations input")
  if (!expectations || expectations.length === 0) {
    Logger.info(
      { summary: "No explicit expected results provided." },
      "summarizeExpectations output"
    )
    return "No explicit expected results provided."
  }

  const summary = expectations
    .map((entry, idx) => {
      const expectation = entry.expectation
      const success = expectation.successCriteria.join("; ")
      const failures = expectation.failureSignals?.length
        ? `\n   Failure Signals: ${expectation.failureSignals.join("; ")}`
        : ""
      const stop = expectation.stopCondition
        ? `\n   Stop Condition: ${expectation.stopCondition}`
        : ""
      return `${idx + 1}. Tool: ${entry.toolName}\n   Goal: ${expectation.goal}\n   Success Criteria: ${success}${failures}${stop}`
    })
    .join("\n")
  Logger.info(
    { summary, expectationCount: expectations.length },
    "summarizeExpectations output"
  )
  return summary
}

function summarizeToolHistory(
  records: ToolExecutionRecord[],
  limit = 8
): string {
  Logger.info(
    { limit, totalRecords: records.length },
    "summarizeToolHistory input"
  )
  if (!records.length) {
    Logger.info(
      { summary: "No tool executions yet." },
      "summarizeToolHistory output"
    )
    return "No tool executions yet."
  }

  const slice =
    records.length > limit ? records.slice(-limit) : records
  const summaryEntries = slice
    .map((record, idx) => {
      const expectationSummary = record.expectedResults
        ? `Expected: ${record.expectedResults.goal}`
        : "Expected: not provided"
      return `${idx + 1}. ${record.toolName} (${record.status})\nArgs: ${JSON.stringify(
        record.arguments
      )}\n${expectationSummary}\nResult: ${record.resultSummary}`
    })
  const prefix =
    records.length > limit
      ? `Showing last ${limit} of ${records.length} tool calls.\n`
      : ""
  const summary = `${prefix}${summaryEntries.join("\n\n")}`
  Logger.info(
    { summary, includedRecords: Math.min(limit, records.length) },
    "summarizeToolHistory output"
  )
  return summary
}

function summarizeFragments(
  fragments: MinimalAgentFragment[],
  limit = 5
): string {
  Logger.info(
    { fragmentsCount: fragments.length, limit },
    "summarizeFragments input"
  )
  if (!fragments.length) {
    Logger.info(
      { summary: "No context fragments gathered yet." },
      "summarizeFragments output"
    )
    return "No context fragments gathered yet."
  }
  const summary = fragments
    .slice(-limit)
    .map(
      (fragment, idx) =>
        `${idx + 1}. ${fragment.source.title || fragment.id} -> ${
          fragment.content?.slice(0, 200) || ""
        }`
    )
    .join("\n")
  Logger.info(
    { summary, includedFragments: Math.min(limit, fragments.length) },
    "summarizeFragments output"
  )
  return summary
}

function buildDefaultReviewPayload(notes?: string): ReviewResult {
  return {
    status: "ok",
    notes: notes?.trim() || "Review completed with no notable findings.",
    toolFeedback: [],
    unmetExpectations: [],
    planChangeNeeded: false,
    planChangeReason: undefined,
    anomaliesDetected: false,
    anomalies: [],
    recommendation: "proceed",
    ambiguityResolved: true,
    clarificationQuestions: [],
  }
}

function normalizeStringArray(value: unknown): string[] {
  // Logger.info({ value }, "normalizeStringArray input")
  if (!Array.isArray(value)) {
    // Logger.info({ normalized: [] }, "normalizeStringArray output")
    return []
  }
  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
  // Logger.info({ normalized }, "normalizeStringArray output")
  return normalized
}

function normalizeToolFeedbackEntry(
  entry: unknown
): ReviewResult["toolFeedback"][number] | null {
  // Logger.info({ entry }, "normalizeToolFeedbackEntry input")
  if (!entry || typeof entry !== "object") {
    // Logger.info(
    //   { normalized: null },
    //   "normalizeToolFeedbackEntry output"
    // )
    return null
  }
  const candidate = entry as Record<string, unknown>
  const toolName =
    typeof candidate.toolName === "string" ? candidate.toolName.trim() : ""
  const summary =
    typeof candidate.summary === "string" ? candidate.summary.trim() : ""
  if (!toolName || !summary) {
    // Logger.info(
    //   { normalized: null },
    //   "normalizeToolFeedbackEntry output"
    // )
    return null
  }
  const outcome =
    candidate.outcome === "met" ||
    candidate.outcome === "missed" ||
    candidate.outcome === "error"
      ? candidate.outcome
      : "missed"
  const expectationGoal =
    typeof candidate.expectationGoal === "string" &&
    candidate.expectationGoal.trim().length > 0
      ? candidate.expectationGoal.trim()
      : undefined
  const followUp =
    typeof candidate.followUp === "string" &&
    candidate.followUp.trim().length > 0
      ? candidate.followUp.trim()
      : undefined
  const normalizedEntry = {
    toolName,
    outcome,
    summary,
    expectationGoal,
    followUp,
  }
  // Logger.info(
  //   { normalized: normalizedEntry },
  //   "normalizeToolFeedbackEntry output"
  // )
  return normalizedEntry
}

function normalizeRecommendation(
  value: unknown
): ReviewResult["recommendation"] {
  // Logger.info({ value }, "normalizeRecommendation input")
  const recommendation: ReviewResult["recommendation"] =
    value === "gather_more" ||
    value === "clarify_query" ||
    value === "replan"
      ? value
      : "proceed"
  // Logger.info(
  //   { recommendation },
  //   "normalizeRecommendation output"
  // )
  return recommendation
}

function coerceBoolean(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === "boolean") {
    return value
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (normalized === "true") return true
    if (normalized === "false") return false
    if (normalized === "1") return true
    if (normalized === "0") return false
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return defaultValue
    return value !== 0
  }
  return defaultValue
}

function normalizeReviewResponse(payload: unknown): ReviewResult {
  // Logger.info({ payload }, "normalizeReviewResponse input")
  if (typeof payload === "string") {
    const normalizedFromString = buildDefaultReviewPayload(payload)
    // Logger.info(
    //   { normalized: normalizedFromString },
    //   "normalizeReviewResponse output (string payload)"
    // )
    return normalizedFromString
  }
  if (!payload || typeof payload !== "object") {
    const defaultPayload = buildDefaultReviewPayload()
    // Logger.info(
    //   { normalized: defaultPayload },
    //   "normalizeReviewResponse output (missing payload)"
    // )
    return defaultPayload
  }

  const raw = payload as Record<string, unknown>
  const base = buildDefaultReviewPayload(
    typeof raw.notes === "string" ? raw.notes : undefined
  )

  const toolFeedback = Array.isArray(raw.toolFeedback)
    ? raw.toolFeedback
        .map((entry) => normalizeToolFeedbackEntry(entry))
        .filter(
          (entry): entry is ReviewResult["toolFeedback"][number] =>
            entry !== null
        )
    : []
  const unmetExpectations = normalizeStringArray(raw.unmetExpectations)
  const anomalies = normalizeStringArray(raw.anomalies)
  const planChangeNeeded = coerceBoolean(raw.planChangeNeeded, false)
  const ambiguityResolved = coerceBoolean(
    (raw as any).ambiguityResolved,
    true
  )
  const clarificationQuestions = normalizeStringArray(
    (raw as any).clarificationQuestions
  )

  const normalized: ReviewResult = {
    ...base,
    status: raw.status === "needs_attention" ? "needs_attention" : "ok",
    toolFeedback,
    unmetExpectations,
    planChangeNeeded,
    planChangeReason: base.planChangeReason,
    anomaliesDetected:
      coerceBoolean(raw.anomaliesDetected, anomalies.length > 0) ||
      anomalies.length > 0,
    anomalies,
    recommendation: normalizeRecommendation(raw.recommendation),
    ambiguityResolved,
    clarificationQuestions,
  }

  if (planChangeNeeded) {
    const reason =
      typeof raw.planChangeReason === "string"
        ? raw.planChangeReason.trim()
        : ""
    normalized.planChangeReason = reason || undefined
  } else {
    normalized.planChangeReason = undefined
  }

  if (typeof raw.notes === "string" && raw.notes.trim().length > 0) {
    normalized.notes = raw.notes.trim()
  }

  // Logger.info(
  //   { normalized },
  //   "normalizeReviewResponse output"
  // )
  return normalized
}

async function runReviewLLM(
  context: AgentRunContext,
  options?: {
    focus?: string
    turnNumber?: number
    maxFindings?: number
    expectedResults?: ToolExpectationAssignment[]
    delegationEnabled?: boolean
    messages?: Message[]
  }
): Promise<ReviewResult> {
  Logger.info(
    {
      focus: options?.focus,
      turnNumber: options?.turnNumber,
      maxFindings: options?.maxFindings,
      expectedResultCount: options?.expectedResults?.length ?? 0,
      delegationEnabled: options?.delegationEnabled,
      expectedResults: options?.expectedResults,
    },
    "[DEBUG] runReviewLLM invoked - FULL expectedResults"
  )
  const modelId =
    (defaultFastModel as Models) || (defaultBestModel as Models)
  const delegationNote =
    options?.delegationEnabled === false
      ? "- Delegation tools (list_custom_agents/run_public_agent) were disabled for this run; do not flag their absence."
      : "- If delegation tools are available, ensure list_custom_agents precedes run_public_agent when delegation is appropriate."

  const params: ModelParams = {
    modelId,
    json: true,
    stream: false,
    temperature: 0,
    maxTokens: 800,
    systemPrompt: `You are a senior reviewer ensuring each agentic turn honors the agreed plan and tool expectations.
- Inspect every tool call from this turn, compare the outputs with the expected results, and decide whether each tool met or missed expectations.
- Evaluate the current plan to see if it still fits the evidence gathered from the tool calls; suggest plan changes when necessary.
- Detect anomalies (unexpected behaviors, contradictory data, missing outputs, or unresolved ambiguities) and call them out explicitly. If intent remains unclear, set ambiguityResolved=false and include the ambiguity notes inside the anomalies array.
${delegationNote}
- Set recommendation to "gather_more" when required evidence or data is missing, "clarify_query" when ambiguity remains unresolved, and "replan" only when the current plan is no longer viable.
- Always set ambiguityResolved=false whenever outstanding clarifications exist or anomalies highlight missing/contradictory information; otherwise leave it true.
Respond strictly in JSON matching this schema: ${JSON.stringify({
      status: "ok",
      notes: "Summary of overall findings",
      toolFeedback: [
        {
          toolName: "Tool that ran",
          outcome: "met|missed|error",
          summary: "What happened and whether expectation was satisfied",
          expectationGoal: "Expectation or success criteria that applies",
          followUp: "Specific follow-up if needed",
        },
      ],
      unmetExpectations: ["List of expectation goals still open"],
      planChangeNeeded: "false / true",
      planChangeReason: "Why plan needs updating if true",
      anomaliesDetected: "false / true ",
      anomalies: ["Description of anomalies or ambiguities"],
      recommendation: "proceed",
      ambiguityResolved: "true / false"
    })}
- Only emit keys defined in the schema; do not add prose outside the JSON object.`,
  }
  Logger.info(
    { modelId, params },
    "runReviewLLM prepared LLM params"
  )
  Logger.info(
    { systemPrompt: params.systemPrompt },
    "runReviewLLM system prompt"
  )

  const planHash = JSON.stringify(context.plan ?? null)
  let planSummary = context.review.cachedPlanSummary?.hash === planHash
    ? context.review.cachedPlanSummary.summary
    : summarizePlan(context.plan)
  if (context.review) {
    context.review.cachedPlanSummary = {
      hash: planHash,
      summary: planSummary,
    }
  }

  const fragmentsHash = JSON.stringify(
    context.contextFragments.map((fragment) => fragment.id)
  )
  let fragmentsSummary =
    context.review.cachedContextSummary?.hash === fragmentsHash
      ? context.review.cachedContextSummary.summary
      : summarizeFragments(context.contextFragments)
  if (context.review) {
    context.review.cachedContextSummary = {
      hash: fragmentsHash,
      summary: fragmentsSummary,
    }
  }

  const messageSections = [
    {
      label: "Focus",
      text: `${options?.focus ?? "general"}${
        options?.turnNumber ? `\nTurn: ${options.turnNumber}` : ""
      }`,
    },
    {
      label: "Expected Results",
      text: summarizeExpectations(options?.expectedResults),
    },
    { label: "Plan", text: planSummary },
    {
      label: "Recent Tool Calls",
      text: summarizeToolHistory(
        context.toolCallHistory,
        options?.maxFindings ?? 8
      ),
    },
    { label: "Context Fragments", text: fragmentsSummary },
  ].filter((section) => section.text && section.text.trim().length > 0)

  Logger.info({ sections: messageSections }, "runReviewLLM payload sections")

  const reviewContextText = messageSections
    .map((section) => `${section.label}:\n${section.text}`)
    .join("\n\n")

  let messages: Message[]
  if (options?.messages && options.messages.length > 0) {
    messages = [...options.messages]
    if (reviewContextText.trim().length > 0) {
      messages.push({
        role: ConversationRole.USER,
        content: [{ text: reviewContextText }],
      })
    }
  } else {
    messages = messageSections.map((section) => ({
      role: ConversationRole.USER,
      content: [{ text: `${section.label}:\n${section.text}` }],
    }))
  }

  Logger.info(
    {
      messagesCount: messages.length,
      usedConversationHistory: Boolean(options?.messages?.length),
    },
    "runReviewLLM messages configured"
  )

  const { text } = await getProviderByModel(modelId).converse(
    messages,
    params
  )
  Logger.info({ text }, "runReviewLLM raw LLM response")

  if (!text) {
    throw new Error("LLM returned empty review response")
  }

  const parsed = jsonParseLLMOutput(text)
  Logger.info({ parsed }, "runReviewLLM parsed LLM response")
  const normalized = normalizeReviewResponse(parsed)
  // Logger.info(
  //   { normalized },
  //   "runReviewLLM normalized response"
  // )
  const validation = ReviewResultSchema.safeParse(normalized)
  if (!validation.success) {
    Logger.error(
      { error: validation.error.format(), raw: parsed },
      "Review result does not match schema"
    )
    throw new Error("Review result does not match schema")
  }
  // Logger.info(
  //   { reviewResult: validation.data },
  //   "runReviewLLM returning validated review result"
  // )
  return validation.data
}

function buildInternalToolAdapters(): Tool<unknown, AgentRunContext>[] {
  const baseTools = [
    createToDoWriteTool(),
    searchGlobalTool,
    ...googleTools,
    getSlackRelatedMessagesTool,
    fallbackTool,
    createFinalSynthesisTool(),
  ] as Array<Tool<unknown, AgentRunContext>>

  return baseTools
}

type ToolAccessRequirement = {
  requiredApp?: Apps
  connectorFlag?: keyof UserConnectorState
}

const TOOL_ACCESS_REQUIREMENTS: Record<string, ToolAccessRequirement> = {
  searchGmail: { requiredApp: Apps.Gmail, connectorFlag: "gmailSynced" },
  searchDriveFiles: {
    requiredApp: Apps.GoogleDrive,
    connectorFlag: "googleDriveSynced",
  },
  searchCalendarEvents: {
    requiredApp: Apps.GoogleCalendar,
    connectorFlag: "googleCalendarSynced",
  },
  searchGoogleContacts: {
    requiredApp: Apps.GoogleWorkspace,
    connectorFlag: "googleWorkspaceSynced",
  },
  getSlackRelatedMessages: {
    requiredApp: Apps.Slack,
    connectorFlag: "slackConnected",
  },
}

function deriveAllowedAgentApps(agentPrompt?: string): Set<Apps> | null {
  if (!agentPrompt) return null
  const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)
  if (!agentAppEnums?.length) {
    return null
  }
  return new Set(agentAppEnums)
}

function filterToolsByAvailability(
  tools: Array<Tool<unknown, AgentRunContext>>,
  params: {
    connectorState: UserConnectorState
    allowedAgentApps: Set<Apps> | null
    email: string
    agentId?: string
  },
): Array<Tool<unknown, AgentRunContext>> {
  return tools.filter((tool) => {
    const rule = TOOL_ACCESS_REQUIREMENTS[tool.schema.name]
    if (!rule) return true

    if (
      rule.connectorFlag &&
      !params.connectorState[rule.connectorFlag]
    ) {
      loggerWithChild({ email: params.email, agentId: params.agentId }).info(
        `Disabling tool ${tool.schema.name}: connector '${rule.connectorFlag}' unavailable.`,
      )
      return false
    }

    if (
      rule.requiredApp &&
      params.allowedAgentApps &&
      params.allowedAgentApps.size > 0 &&
      !params.allowedAgentApps.has(rule.requiredApp)
    ) {
      loggerWithChild({ email: params.email, agentId: params.agentId }).info(
        `Disabling tool ${tool.schema.name}: agent not configured for ${rule.requiredApp}.`,
      )
      return false
    }

    return true
  })
}

function createToDoWriteTool(): Tool<unknown, AgentRunContext> {
  return {
    schema: {
      name: "toDoWrite",
      description: TOOL_SCHEMAS.toDoWrite.description,
      parameters: TOOL_SCHEMAS.toDoWrite.inputSchema,
    },
    async execute(args, context) {
      Logger.info(
        {
          email: context.user.email,
          args,
        },
        "[toDoWrite] Execution started"
      )
      const validation = validateToolInput<PlanState>("toDoWrite", args)
      if (!validation.success) {
        return ToolResponse.error(
          "INVALID_INPUT",
          validation.error.message
        )
      }

      const plan: PlanState = {
        goal: validation.data.goal,
        subTasks: validation.data.subTasks,
      }

      const activeSubTaskId = initializePlanState(plan)
      context.plan = plan
      context.currentSubTask = activeSubTaskId
      Logger.info(
        {
          email: context.user.email,
          goal: plan.goal,
          subTaskCount: plan.subTasks.length,
          activeSubTaskId,
        },
        "[toDoWrite] Plan created"
      )

      return ToolResponse.success({
        result: `Plan updated with ${plan.subTasks.length} sub-task${plan.subTasks.length === 1 ? "" : "s"}.`,
        plan,
      })
    },
  }
}


function buildDelegatedAgentQuery(baseQuery: string, context: AgentRunContext): string {
  const parts = [baseQuery.trim()]
  if (context.currentSubTask) {
    parts.push(`Active sub-task: ${context.currentSubTask}`)
  }
  if (context.plan?.goal) {
    parts.push(`Overall goal: ${context.plan.goal}`)
  }
  if (context.message?.text) {
    parts.push(`Original user question: ${context.message.text}`)
  }
  return parts.filter(Boolean).join("\n\n")
}

function buildCustomAgentTools(): Array<Tool<unknown, AgentRunContext>> {
  return [
    createListCustomAgentsTool(),
    createRunPublicAgentTool(),
  ]
}


function createListCustomAgentsTool(): Tool<unknown, AgentRunContext> {
  return {
    schema: {
      name: "list_custom_agents",
      description: TOOL_SCHEMAS.list_custom_agents.description,
      parameters: TOOL_SCHEMAS.list_custom_agents.inputSchema,
    },
    async execute(args, context) {
      const validation = validateToolInput<{
        query: string
        requiredCapabilities?: string[]
        maxAgents?: number
      }>("list_custom_agents", args)

      if (!validation.success) {
        return ToolResponse.error(
          "INVALID_INPUT",
          validation.error.message
        )
      }

      const result = await listCustomAgentsSuitable({
        query: validation.data.query,
        userEmail: context.user.email,
        workspaceExternalId: context.user.workspaceId,
        workspaceNumericId: context.user.workspaceNumericId,
        userId: context.user.numericId,
        requiredCapabilities: validation.data.requiredCapabilities,
        maxAgents: validation.data.maxAgents,
        mcpAgents: context.mcpAgents,
      })
      Logger.info(
        { params: validation.data, email: context.user.email },
        "[list_custom_agents] input params"
      )
      Logger.info(
        { selection: result, email: context.user.email },
        "[list_custom_agents] selection result"
      )

      const normalizedAgents = Array.isArray(result.agents) ? result.agents : []
      context.availableAgents = normalizedAgents
      const payload = {
        summary: result.result,
        agents: normalizedAgents.length ? normalizedAgents : null,
        totalEvaluated: result.totalEvaluated,
      }
      return ToolResponse.success(JSON.stringify(payload, null, 2), {
        metadata: result,
      })
    },
  }
}

function createRunPublicAgentTool(): Tool<unknown, AgentRunContext> {
  return {
    schema: {
      name: "run_public_agent",
      description: TOOL_SCHEMAS.run_public_agent.description,
      parameters: TOOL_SCHEMAS.run_public_agent.inputSchema,
    },
    async execute(args, context) {
      const validation = validateToolInput<{
        agentId: string
        query: string
        context?: string
        maxTokens?: number
      }>("run_public_agent", args)

      if (!validation.success) {
        return ToolResponse.error(
          "INVALID_INPUT",
          validation.error.message
        )
      }

      if (!context.ambiguityResolved) {
        return ToolResponse.error(
          "AMBIGUITY_NOT_RESOLVED",
          `Resolve ambiguity before running a custom agent. Unresolved: ${
            context.clarifications.length
              ? context.clarifications
                  .map((c) => c.question)
                  .join("; ")
              : "not specified"
          }`
        )
      }

      if (!context.availableAgents.length) {
        return ToolResponse.error(
          "NO_AGENTS_AVAILABLE",
          "No agents available. Run list_custom_agents this turn and select an agentId from its results."
        )
      }

      Logger.info(
        {
          requestedAgentId: validation.data.agentId,
          availableAgents: context.availableAgents.map((a) => ({
            agentId: a.agentId,
            agentName: a.agentName,
          })),
        },
        "[run_public_agent] Agent selection details"
      )

      const agentCapability = context.availableAgents.find(
        (agent) => agent.agentId === validation.data.agentId
      )
      if (!agentCapability) {
        return ToolResponse.error(
          "UNKNOWN_AGENT",
          `Agent '${validation.data.agentId}' not found in availableAgents. Call list_custom_agents and use one of: ${context.availableAgents
            .map((a) => `${a.agentName} (${a.agentId})`)
            .join("; ")}`
        )
      }

      const toolOutput = await executeCustomAgent({
        agentId: validation.data.agentId,
        query: buildDelegatedAgentQuery(validation.data.query, context),
        contextSnippet: validation.data.context,
        maxTokens: validation.data.maxTokens,
        userEmail: context.user.email,
        workspaceExternalId: context.user.workspaceId,
        mcpAgents: context.mcpAgents,
        parentTurn: ensureTurnNumber(context.turnCount),
      })
      Logger.info(
        { params: validation.data, email: context.user.email },
        "[run_public_agent] input params"
      )
      Logger.info(
        { toolOutput, email: context.user.email },
        "[run_public_agent] tool output"
      )
      context.usedAgents.push(agentCapability.agentId)

      if (toolOutput.error) {
        return ToolResponse.error(
          "EXECUTION_FAILED",
          toolOutput.error
        )
      }

      return ToolResponse.success(toolOutput.result, {
        metadata: {
          ...toolOutput.metadata,
          agentId: validation.data.agentId,
        },
        data: toolOutput,
      })
    },
  }
}

function createFinalSynthesisTool(): Tool<unknown, AgentRunContext> {
  return {
    schema: {
      name: "synthesize_final_answer",
      description: TOOL_SCHEMAS.synthesize_final_answer.description,
      parameters: TOOL_SCHEMAS.synthesize_final_answer.inputSchema,
    },
    async execute(_args, context) {
      if (context.finalSynthesis.requested && context.finalSynthesis.completed) {
        return ToolResponse.error(
          "EXECUTION_FAILED",
          "Final synthesis already completed for this run."
        )
      }

      const streamAnswer = context.runtime?.streamAnswerText
      if (!streamAnswer) {
        return ToolResponse.error(
          "EXECUTION_FAILED",
          "Streaming channel unavailable. Cannot deliver final answer."
        )
      }

      const { selected, total, dropped, userAttachmentCount } =
        selectImagesForFinalSynthesis(context)

      const { systemPrompt, userMessage } = buildFinalSynthesisPayload(context)
      const fragmentsCount = context.contextFragments.length

      context.finalSynthesis.requested = true
      context.finalSynthesis.suppressAssistantStreaming = true
      context.finalSynthesis.completed = false
      context.finalSynthesis.streamedText = ""

      await context.runtime?.emitReasoning?.({
        text: `Initiating final synthesis with ${fragmentsCount} context fragments and ${selected.length}/${total} images (${userAttachmentCount} user attachments).`,
        step: { type: AgentReasoningStepType.LogMessage },
      })

      const logger = loggerWithChild({ email: context.user.email })
      if (dropped.length > 0) {
        logger.info(
          {
            droppedCount: dropped.length,
            limit: IMAGE_CONTEXT_CONFIG.maxImagesPerCall,
            totalImages: total,
          },
          "Final synthesis image limit enforced; dropped oldest references."
        )
      }

      const modelId = (defaultBestModel as Models) || Models.Gpt_4o
      const modelParams: ModelParams = {
        modelId,
        systemPrompt,
        stream: true,
        temperature: 0.2,
        max_new_tokens: context.maxOutputTokens ?? 1500,
        imageFileNames: selected,
      }

      const messages: Message[] = [
        {
          role: ConversationRole.USER,
          content: [{ text: userMessage }],
        },
      ]

      Logger.info({
        email: context.user.email,
        chatId: context.chat.externalId,
        modelId,
        systemPrompt,
        messagesCount: messages.length,
        imagesProvided: selected.length,
      }, "[MessageAgents][FinalSynthesis] LLM call parameters")

      Logger.info({
        email: context.user.email,
        chatId: context.chat.externalId,
        messages,
      }, "[MessageAgents][FinalSynthesis] FULL MESSAGES ARRAY")

      const provider = getProviderByModel(modelId)
      let streamedCharacters = 0
      let estimatedCostUsd = 0

      try {
        const iterator = provider.converseStream(messages, modelParams)
        for await (const chunk of iterator) {
          if (chunk.text) {
            streamedCharacters += chunk.text.length
            context.finalSynthesis.streamedText += chunk.text
            await streamAnswer(chunk.text)
          }
          const chunkCost = chunk.metadata?.cost
          if (typeof chunkCost === "number" && !Number.isNaN(chunkCost)) {
            estimatedCostUsd += chunkCost
          }
        }

        context.finalSynthesis.completed = true

        await context.runtime?.emitReasoning?.({
          text: "Final synthesis completed and streamed to the user.",
          step: { type: AgentReasoningStepType.LogMessage },
        })

        return ToolResponse.success(
          {
            result: "Final answer streamed to user.",
            streamed: true,
            metadata: {
              textLength: streamedCharacters,
              totalImagesAvailable: total,
              imagesProvided: selected.length,
            },
          },
          {
            estimatedCostUsd,
          }
        )
      } catch (error) {
        context.finalSynthesis.suppressAssistantStreaming = false
        context.finalSynthesis.requested = false
        context.finalSynthesis.completed = false
        logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          "Final synthesis tool failed."
        )
        return ToolResponse.error(
          "EXECUTION_FAILED",
          `Failed to synthesize final answer: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    },
  }
}


/**
 * Build dynamic agent instructions including plan state and tool descriptions
 */
function buildAttachmentDirective(context: AgentRunContext): string {
  const { initialAttachmentPhase, initialAttachmentSummary } =
    getAttachmentPhaseMetadata(context)
  if (!initialAttachmentPhase) {
    return ""
  }

  const summaryLine =
    initialAttachmentSummary ||
    "User provided attachment context for this opening turn."

  return `
# ATTACHMENT-FIRST TURN
- ${summaryLine}
- Attempt to answer using ONLY the attachment context fragments listed below.
- If they fully answer the query, respond directly without calling tools.
- If they are insufficient, explain what is missing, then call toDoWrite to plan additional research before invoking other tools.
- Capture any useful facts from the attachments so they remain available in later turns.
`.trim()
}

function buildReviewDirective(reviewState: ReviewState): string {
  const lastReview = reviewState.lastReviewResult
  if (!lastReview) return ""

  const lines: string[] = []
  lines.push(`Turn: ${reviewState.lastReviewTurn ?? "unknown"}`)
  lines.push(`Status: ${lastReview.status}`)
  lines.push(`Recommendation: ${lastReview.recommendation}`)
  lines.push(
    `Plan change needed: ${lastReview.planChangeNeeded ? "yes" : "no"}${
      lastReview.planChangeReason ? ` (${lastReview.planChangeReason})` : ""
    }`
  )
  lines.push(`Ambiguity resolved: ${lastReview.ambiguityResolved ? "yes" : "no"}`)
  lines.push(`Notes: ${lastReview.notes}`)

  if (lastReview.anomalies?.length) {
    lines.push(`Anomalies: ${lastReview.anomalies.join("; ")}`)
  } else if (reviewState.outstandingAnomalies?.length) {
    lines.push(
      `Anomalies: ${reviewState.outstandingAnomalies.join("; ")}`
    )
  } else {
    lines.push("Anomalies: none reported")
  }

  if (reviewState.clarificationQuestions?.length) {
    lines.push(
      `Clarification questions to answer: ${reviewState.clarificationQuestions.join("; ")}`
    )
  }

  const toolFeedbackSection =
    lastReview.toolFeedback && lastReview.toolFeedback.length > 0
      ? lastReview.toolFeedback
          .map(
            (feedback, index) =>
              `${index + 1}. ${feedback.toolName} - ${feedback.outcome}${
                feedback.summary ? ` (${feedback.summary})` : ""
              }`
          )
          .join("\n")
      : "None."

  const unmetExpectationsSection =
    lastReview.unmetExpectations && lastReview.unmetExpectations.length > 0
      ? lastReview.unmetExpectations.map((exp, index) => `${index + 1}. ${exp}`).join("\n")
      : "None."

  const reviewJson = JSON.stringify(lastReview, null, 2)

  return `
<last_review_summary>
${lines.join("\n")}

Tool feedback:
${toolFeedbackSection}

Unmet expectations:
${unmetExpectationsSection}

Full review payload:
${reviewJson}
</last_review_summary>`.trim()
}

function buildAgentInstructions(
  context: AgentRunContext,
  enabledToolNames: string[],
  dateForAI: string,
  agentPrompt?: string,
  delegationEnabled = true
): string {
  const toolDescriptions = enabledToolNames.length > 0
    ? generateToolDescriptions(enabledToolNames)
    : "No tools available yet. "

  const agentSection = agentPrompt ? `\n\nAgent Constraints:\n${agentPrompt}` : ""
  const attachmentDirective = buildAttachmentDirective(context)
  const reviewDirective = buildReviewDirective(context.review)
  const promptAddendum = buildAgentPromptAddendum()

  let planSection = "\n<plan>\n"
  if (context.plan) {
    planSection += `Goal: ${context.plan.goal}\n\n`
    planSection += "Steps:\n"
    context.plan.subTasks.forEach((task, i) => {
      const status =
        task.status === "completed" ? "✓" :
        task.status === "in_progress" ? "→" :
        task.status === "failed" ? "✗" : "○"
      planSection += `${i + 1}. [${status}] ${task.description}\n`
      if (task.toolsRequired && task.toolsRequired.length > 0) {
        planSection += `   Tools: ${task.toolsRequired.join(", ")}\n`
      }
    })
    planSection += "\n</plan>\n"
  } else {
    planSection += "No plan exists yet. Use toDoWrite to create one.\n</plan>\n"
  }

  const delegationGuidance = delegationEnabled
    ? `- Before calling ANY search, calendar, Gmail, Drive, or other research tools, you MUST invoke \`list_custom_agents\` once per run. Treat the workflow as: plan -> list agents -> (maybe) run_public_agent -> other tools. If the selector returns \`null\`, explicitly log that no agent was suitable, then proceed with core tools.\n- Before calling \`run_public_agent\`, invoke \`list_custom_agents\`, compare every candidate, and respect a \`null\` result as "no delegate—continue with built-in tools."\n- Use \`run_custom_agent\` (the execution surface for selected specialists) immediately after choosing an agent from \`list_custom_agents\`; pass the specific agentId plus a rewritten query tailored to that agent.\n- When \`list_custom_agents\` returns high-confidence candidates, pause to assess the current sub-task and explicitly decide whether running one now accelerates the goal; document the rationale either way.\n- Only delegate when a specific agent's documented capabilities make it unquestionably suitable; otherwise keep iterating yourself.`
    : "- Delegation to other agents is disabled for this run. Do not call list_custom_agents or run_public_agent; rely on the available tools directly."

  const finalInstructions = `
You are Xyne, an enterprise search assistant with agentic capabilities.

The current date is: ${dateForAI}

<context>
User: ${context.user.email}
Workspace: ${context.user.workspaceId}
</context>

<available_tools>
${toolDescriptions}
</available_tools>

${agentSection}

${reviewDirective ? `${reviewDirective}\n` : ""}

${planSection}

${attachmentDirective ? `${attachmentDirective}\n` : ""}

${promptAddendum}

# PLANNING
- ALWAYS start by creating a plan using toDoWrite
- The review feedback overrides older assumptions—treat instructions inside <last_review_summary> as mandatory constraints
- Before changing the plan, READ <last_review_summary> (if present) and incorporate its guidance immediately
- Adjust the existing plan per the latest review recommendations; only run toDoWrite again if the review explicitly calls for a brand-new plan
- Do NOT call toDoWrite more than once in a single turn unless the review summary mandates it; otherwise refine the existing plan directly
- Break the goal into clear, sequential tasks (one sub-goal per task)
- Each task represents one sub-goal that must be completed before moving to the next
- Within a task, identify all tools needed to achieve that sub-goal
- Update plan as you learn more
- VERY IMPORTANT **Never call only toDoWrite tool in a turn , make tool calls releavnt for current / next subTask - goal to proceeed further . toDoWrite is independent tool , we can call other tools along with it.**
# EXECUTION STRATEGY
- Execute ONE TASK AT A TIME in sequential order
- Complete each task fully before moving to the next
- Within a single task, you may call multiple tools if they all contribute to that sub-goal
- Do NOT mix tools from different sub-goals in the same task

# TOOL CALLS & EXPECTATIONS
- Use the model's native function/tool-call interface. Provide clean JSON arguments.
- Do NOT wrap tool calls in custom XML—JAF already handles execution.
${delegationGuidance}
- After you decide which tools to call, emit a standalone expected-results block summarizing what each tool should achieve:
<expected_results>
[
  {
    "toolName": "searchGlobal",
    "goal": "Find Q4 ARR mentions",
    "successCriteria": ["ARR keyword present", "Dated Q4"],
    "failureSignals": ["No ARR context"],
    "stopCondition": "After 2 unsuccessful searches"
  }
]
</expected_results>
- Include one entry per tool invocation you intend to make. These expectations feed automatic review, so keep them specific and measurable.

# CONSTRAINT HANDLING
- When the user requests an action the available tools cannot execute, produce the closest actionable substitute (draft, checklist, instructions) so progress continues.
- State the exact limitation and what manual follow-up the user must perform to finish.

# FINAL SYNTHESIS
- When research is complete and evidence is locked, CALL \`synthesize_final_answer\` (no arguments). This tool composes and streams the response.
- Never output the final answer directly—always go through the tool and then acknowledge completion.
`

  // Logger.info({
  //   email: context.user.email,
  //   chatId: context.chat.externalId,
  //   turnCount: context.turnCount,
  //   instructionsLength: finalInstructions.length,
  //   enabledToolsCount: enabledToolNames.length,
  //   contextFragmentsCount: context.contextFragments.length,
  //   hasPlan: !!context.plan,
  //   delegationEnabled,
  // }, "[MessageAgents] Final agent instructions built")

  // Logger.info({
  //   email: context.user.email,
  //   chatId: context.chat.externalId,
  //   instructions: finalInstructions,
  // }, "[MessageAgents] FULL AGENT INSTRUCTIONS")

  return finalInstructions
}

/**
 * MessageAgents - New JAF-based agentic flow
 * 
 * This is the new implementation that will eventually replace MessageWithToolsApi
 * Activated via a flag/parameter in the request
 */
export async function MessageAgents(c: Context): Promise<Response> {
  const tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("MessageAgents")

  const { sub: email, workspaceId } = c.get(JwtPayloadKey)
  
  try {
    loggerWithChild({ email }).info("MessageAgents - New agentic flow starting")
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

    // Parse request body to get actual query
    // @ts-ignore
    const body = c.req.valid("query")
    let {
      message,
      chatId,
      agentId: rawAgentId,
      toolsList,
    }: {
      message: string
      chatId?: string
      agentId?: string
      toolsList?: Array<{ connectorId: string; tools: string[] }>
    } = body
    
    if (!message) {
      throw new HTTPException(400, { message: "Message is required" })
    }
    
    message = decodeURIComponent(message)
    rootSpan.setAttribute("message", message)
    rootSpan.setAttribute("chatId", chatId || "new")

    if (typeof toolsList === "string") {
      try {
        toolsList = JSON.parse(toolsList) as Array<{
          connectorId: string
          tools: string[]
        }>
      } catch (error) {
        loggerWithChild({ email }).warn(
          { err: error },
          "Unable to parse toolsList payload; skipping MCP connectors.",
        )
        toolsList = []
      }
    }

    let normalizedAgentId =
      typeof rawAgentId === "string" ? rawAgentId.trim() : undefined
    if (normalizedAgentId === "") {
      normalizedAgentId = undefined
    }
    if (normalizedAgentId === DEFAULT_TEST_AGENT_ID) {
      normalizedAgentId = undefined
    }
    if (normalizedAgentId && !isCuid(normalizedAgentId)) {
      throw new HTTPException(400, {
        message: "Invalid agentId. Expected a valid CUID.",
      })
    }

    const attachmentMetadata = parseAttachmentMetadata(c)
    const attachmentsForContext = attachmentMetadata.map((meta) => ({
      fileId: meta.fileId,
      isImage: meta.isImage,
    }))
    const referencedFileIds = Array.from(
      new Set(
        attachmentMetadata
          .filter((meta) => !meta.isImage)
          .flatMap((meta) => expandSheetIds(meta.fileId))
      )
    )
    const imageAttachmentFileIds = Array.from(
      new Set(attachmentMetadata.filter((meta) => meta.isImage).map((meta) => meta.fileId))
    )

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email
    )
    const { user, workspace } = userAndWorkspace
    let connectorState = createEmptyConnectorState()
    try {
      connectorState = await getUserConnectorState(db, email)
    } catch (error) {
      loggerWithChild({ email }).warn(
        error,
        "Failed to load user connector state; assuming no connectors",
      )
    }
    let agentPromptForLLM: string | undefined
    let resolvedAgentId: string | undefined
    let agentRecord: SelectAgent | null = null
    let allowedAgentApps: Set<Apps> | null = null

    if (normalizedAgentId) {
      agentRecord = await getAgentByExternalIdWithPermissionCheck(
        db,
        normalizedAgentId,
        workspace.id,
        user.id
      )
      if (!agentRecord) {
        throw new HTTPException(403, {
          message: "Access denied: You do not have permission to use this agent",
        })
      }
      resolvedAgentId = agentRecord.externalId
      agentPromptForLLM = JSON.stringify(agentRecord)
      allowedAgentApps = deriveAllowedAgentApps(agentPromptForLLM)
      rootSpan.setAttribute("agentId", resolvedAgentId)
    }
    const userTimezone = user?.timeZone || "UTC"
    const dateForAI = getDateForAI({ userTimeZone: userTimezone })
    const userMetadata: UserMetadataType = {
      userTimezone,
      dateForAI,
    }
    const userCtxString = userContext(userAndWorkspace)
    const messageFileIds = Array.from(
      new Set([
        ...referencedFileIds,
        ...attachmentMetadata.map((meta) => meta.fileId),
      ])
    )

    let chatRecord: SelectChat
    try {
      const bootstrap = await ensureChatAndPersistUserMessage({
        chatId,
        email,
        user: { id: user.id, email: user.email },
        workspace: { id: workspace.id, externalId: workspace.externalId },
        message,
        fileIds: messageFileIds,
        attachmentMetadata,
        modelId: defaultBestModel,
        agentId: resolvedAgentId ?? undefined,
      })
      chatRecord = bootstrap.chat
      const chatAgentId = chatRecord.agentId ?? undefined
      if (resolvedAgentId && chatAgentId && chatAgentId !== resolvedAgentId) {
        throw new HTTPException(400, {
          message:
            "This chat is already associated with a different agent. Please start a new chat for that agent.",
        })
      }
      if (!resolvedAgentId && chatAgentId) {
        resolvedAgentId = chatAgentId
      }
    } catch (error) {
      loggerWithChild({ email }).error(
        error,
        "Failed to persist user turn for MessageAgents"
      )
      const errMsg =
        error instanceof Error ? error.message : "Unknown persistence error"
      if (errMsg.includes("Chat not found")) {
        throw new HTTPException(404, { message: "Chat not found" })
      }
      throw new HTTPException(500, {
        message: "Failed to initialize chat for request",
      })
    }
    rootSpan.setAttribute("chatId", chatRecord.externalId)

    if (
      resolvedAgentId &&
      !agentRecord &&
      resolvedAgentId !== DEFAULT_TEST_AGENT_ID
    ) {
      agentRecord = await getAgentByExternalIdWithPermissionCheck(
        db,
        resolvedAgentId,
        workspace.id,
        user.id
      )
      if (!agentRecord) {
        throw new HTTPException(403, {
          message:
            "Access denied: You do not have permission to use the agent linked to this conversation",
        })
      }
      agentPromptForLLM = JSON.stringify(agentRecord)
      allowedAgentApps = deriveAllowedAgentApps(agentPromptForLLM)
      rootSpan.setAttribute("agentId", resolvedAgentId)
    }

    const hasExplicitAgent = Boolean(resolvedAgentId && agentPromptForLLM)
    const delegationEnabled = !hasExplicitAgent

    return streamSSE(c, async (stream) => {
      const mcpClients: Array<{ close?: () => Promise<void> }> = []
      try {
        let thinkingLog = ""
        const emitReasoningStep: ReasoningEmitter = async (payload) => {
          if (stream.closed) return
          thinkingLog += `${JSON.stringify(payload)}\n`
          await stream.writeSSE({
            event: ChatSSEvents.Reasoning,
            data: JSON.stringify(payload),
          })
        }

        // Initialize context with actual data
        const agentContext = initializeAgentContext(
          email,
          workspaceId,
          user.id,
          chatRecord.externalId,
          message,
          attachmentsForContext,
          {
            userContext: userCtxString,
            workspaceNumericId: workspace.id,
            agentPrompt: agentPromptForLLM,
          }
        )
        agentContext.delegationEnabled = delegationEnabled

        if (IMAGE_CONTEXT_CONFIG.enabled && imageAttachmentFileIds.length > 0) {
          // console.info('[IMAGE addition][Image Init] Processing user attachments:', {
          //   imageAttachmentCount: imageAttachmentFileIds.length,
          //   fileIds: imageAttachmentFileIds.slice(0, 5),
          //   userEmail: email,
          // })
          
          const attachmentImageNames = imageAttachmentFileIds.map(
            (fileId, index) => `${index}_${fileId}_${0}`
          )
          
          // console.info('[IMAGE addition][Image Init] Generated image names:', {
          //   count: attachmentImageNames.length,
          //   samples: attachmentImageNames.slice(0, 3),
          // })
          
          const added = registerImageReferences(agentContext, attachmentImageNames, {
            turnNumber: 0,
            sourceFragmentId: "user_attachment",
            sourceToolName: "user_input",
            isUserAttachment: true,
          })
          if (added > 0) {
            loggerWithChild({ email }).info(
              `Registered ${added} image attachment${added === 1 ? "" : "s"} for MessageAgents context`
            )
          }
        }

        // Build MCP connector tool map (mirrors MessageWithToolsApi semantics)
        const finalToolsMap: FinalToolsList = {}
        type FinalToolsEntry = FinalToolsList[string]
        type AdapterTool = FinalToolsEntry["tools"][number]
        const connectorMetaById = new Map<string, { name?: string; description?: string }>()

        if (toolsList && Array.isArray(toolsList) && toolsList.length > 0) {
          for (const item of toolsList) {
            const { connectorId, tools: toolExternalIds } = item
            const requestedToolIds = Array.isArray(toolExternalIds)
              ? toolExternalIds
              : []
            const parsedConnectorId = Number.parseInt(connectorId, 10)
            if (Number.isNaN(parsedConnectorId)) {
              loggerWithChild({ email }).warn(
                { connectorId },
                "[MessageAgents][MCP] Skipping connector with invalid id",
              )
              continue
            }

            let connector
            try {
              connector = await getConnectorById(db, parsedConnectorId, user.id)
            } catch (error) {
              loggerWithChild({ email }).error(
                error,
                `[MessageAgents][MCP] Connector not found or access denied for connectorId: ${connectorId}`,
              )
              continue
            }

            const client = new Client({
              name: `connector-${connectorId}`,
              version: (connector.config as { version?: string })?.version ?? "1.0",
            })

            try {
              const loadedConfig = connector.config as {
                url?: string
                headers?: Record<string, string>
                command?: string
                args?: string[]
                mode?: "sse" | "streamable-http"
                version?: string
              }
              const loadedUrl = loadedConfig.url
              const loadedHeaders = loadedConfig.headers ?? {}
              const loadedMode = loadedConfig.mode || "sse"

              if (loadedUrl) {
                loggerWithChild({ email }).info(
                  `Connecting to MCP client at ${loadedUrl} with mode: ${loadedMode}`,
                )

                if (loadedMode === "streamable-http") {
                  const transportOptions: StreamableHTTPClientTransportOptions = {
                    requestInit: { headers: loadedHeaders },
                  }
                  await client.connect(
                    new StreamableHTTPClientTransport(new URL(loadedUrl), transportOptions),
                  )
                } else {
                  const transportOptions: SSEClientTransportOptions = {
                    requestInit: { headers: loadedHeaders },
                  }
                  await client.connect(
                    new SSEClientTransport(new URL(loadedUrl), transportOptions),
                  )
                }
              } else if (loadedConfig.command) {
                loggerWithChild({ email }).info(
                  `Connecting to MCP Stdio client with command: ${loadedConfig.command}`,
                )
                await client.connect(
                  new StdioClientTransport({
                    command: loadedConfig.command,
                    args: loadedConfig.args || [],
                  }),
                )
              } else {
                throw new Error(
                  "Invalid MCP connector configuration: missing url or command.",
                )
              }
            } catch (error) {
              loggerWithChild({ email }).error(
                error,
                `Failed to connect to MCP client for connector ${connectorId}`,
              )
              continue
            }

            mcpClients.push(client)
            let tools = []
            try {
              tools = await getToolsByConnectorId(db, workspace.id, connector.id)
            } catch (error) {
              loggerWithChild({ email }).error(
                error,
                `[MessageAgents][MCP] Failed to fetch tools for connector ${connectorId}`,
              )
              continue
            }
            const filteredTools = tools.filter((tool) => {
              const isIncluded = requestedToolIds.includes(tool.externalId!)
              if (!isIncluded) {
                loggerWithChild({ email }).info(
                  `[MessageAgents][MCP] Tool ${tool.externalId}:${tool.toolName} not in requested toolExternalIds.`,
                )
              }
              return isIncluded
            })

            const formattedTools: FinalToolsEntry["tools"] = filteredTools.map(
              (tool): AdapterTool => ({
                toolName: tool.toolName,
                toolSchema: tool.toolSchema,
                description: tool.description ?? undefined,
              }),
            )

            if (formattedTools.length === 0) {
              continue
            }

            const wrappedClient: FinalToolsEntry["client"] = {
              callTool: async ({ name, arguments: toolArguments }) => {
                if (typeof toolArguments === "object" && toolArguments !== null) {
                  return client.callTool({
                    name,
                    arguments: toolArguments,
                  })
                }
                return client.callTool({ name })
              },
              close: () => client.close(),
            }

            const safeConnectorId = String(connector.id)
            finalToolsMap[safeConnectorId] = {
              tools: formattedTools,
              client: wrappedClient,
            }
            connectorMetaById.set(safeConnectorId, {
              name: connector.name,
              description: (connector as Record<string, unknown>)?.description as string | undefined,
            })
          }
        }

        const baseInternalTools = buildInternalToolAdapters()
        const internalTools = filterToolsByAvailability(baseInternalTools, {
          connectorState,
          allowedAgentApps,
          email,
          agentId: resolvedAgentId,
        })
        const customTools = delegationEnabled ? buildCustomAgentTools() : []

        // Decide which connectors become MCP agents vs direct tools (budgeted)
        const MAX_TOOLS_BUDGET = 30
        const connectorToolEntries = Object.entries(finalToolsMap).map(
          ([connectorId, entry]) => ({
            connectorId,
            toolCount: entry.tools.length,
          }),
        )
        let totalToolBudget =
          internalTools.length +
          connectorToolEntries.reduce((sum, entry) => sum + entry.toolCount, 0)
        const agentConnectorIds = new Set<string>()
        if (totalToolBudget > MAX_TOOLS_BUDGET) {
          const sortedConnectors = [...connectorToolEntries].sort(
            (a, b) => b.toolCount - a.toolCount,
          )
          for (const entry of sortedConnectors) {
            agentConnectorIds.add(entry.connectorId)
            totalToolBudget -= entry.toolCount
            if (totalToolBudget <= MAX_TOOLS_BUDGET) break
          }
        }

        const directMcpToolsMap: FinalToolsList = {}
        const mcpAgentCandidates: MCPVirtualAgentRuntime[] = []

        for (const [connectorId, entry] of Object.entries(finalToolsMap)) {
          if (agentConnectorIds.has(connectorId)) {
            mcpAgentCandidates.push({
              agentId: `mcp:${connectorId}`,
              connectorId,
              connectorName: connectorMetaById.get(connectorId)?.name,
              description: connectorMetaById.get(connectorId)?.description,
              tools: entry.tools as MCPToolDefinition[],
              client: entry.client,
            })
          } else {
            directMcpToolsMap[connectorId] = entry
          }
        }

        const directMcpTools = buildMCPJAFTools(directMcpToolsMap)
        const allTools: Tool<unknown, AgentRunContext>[] = [
          ...internalTools,
          ...directMcpTools,
          ...customTools,
        ]
        agentContext.enabledTools = new Set(
          allTools.map((tool) => tool.schema.name)
        )
        agentContext.mcpAgents = mcpAgentCandidates
        loggerWithChild({ email }).info({
          totalToolBudget,
          internalTools: internalTools.length,
          directMcpTools: directMcpTools.length,
          mcpAgents: mcpAgentCandidates.map((a) => a.agentId),
        }, "[MessageAgents][MCP] Tool budget applied")
        Logger.info({
          enabledTools: Array.from(agentContext.enabledTools),
          mcpAgentConnectors: Array.from(agentConnectorIds),
          directMcpTools: directMcpTools.length,
          email,
          chatId: agentContext.chat.externalId,
        }, "[MessageAgents] Tools exposed to LLM after filtering")

        // Track gathered fragments
        const gatheredFragmentsKeys = new Set<string>()

        let initialAttachmentContext: {
          fragments: MinimalAgentFragment[]
          summary: string
        } | null = null

        if (referencedFileIds.length > 0) {
          await streamReasoningStep(
            emitReasoningStep,
            "Analyzing user-provided attachments..."
          )
          initialAttachmentContext = await prepareInitialAttachmentContext(
            referencedFileIds,
            userMetadata,
            message
          )
          if (initialAttachmentContext) {
            await streamReasoningStep(
              emitReasoningStep,
              `Extracted ${initialAttachmentContext.fragments.length} context fragment${
                initialAttachmentContext.fragments.length === 1 ? "" : "s"
              } from attachments.`
            )
          }
        }
        if (initialAttachmentContext) {
          initialAttachmentContext.fragments.forEach((fragment) => {
            agentContext.contextFragments.push(fragment)
            agentContext.seenDocuments.add(fragment.id)
            gatheredFragmentsKeys.add(fragment.id)
          })
          agentContext.chat.metadata = {
            ...agentContext.chat.metadata,
            initialAttachmentPhase: true,
            initialAttachmentSummary: initialAttachmentContext.summary,
          }
        }

        // Build dynamic instructions
        const instructions = () => {
          // console.info('[IMAGE addition][Instructions] Building agent instructions:', {
          //   currentImageCount: agentContext.imageFileNames.length,
          //   currentMetadataSize: agentContext.imageMetadata.size,
          //   hasImageConfig: IMAGE_CONTEXT_CONFIG.enabled,
          //   userEmail: email,
          // })
          return buildAgentInstructions(
            agentContext,
            allTools.map((tool) => tool.schema.name),
            dateForAI,
            agentPromptForLLM,
            delegationEnabled
          )
        }

        // Set up JAF agent
        const jafAgent: JAFAgent<AgentRunContext, string> = {
          name: "xyne-agent",
          instructions,
          tools: allTools,
          modelConfig: { name: defaultBestModel },
        }

        // Set up model provider
        const modelProvider = makeXyneJAFProvider<AgentRunContext>()

        // Set up agent registry
        const agentRegistry = new Map<string, JAFAgent<AgentRunContext, string>>([
          [jafAgent.name, jafAgent],
        ])

        // Initialize run state
        const runId = generateRunId()
        const traceId = generateTraceId()
        const initialMessages: JAFMessage[] = [
          {
            role: "user",
            content: message, // Use actual user message
          },
        ]

        const runState: JAFRunState<AgentRunContext> = {
          runId,
          traceId,
          messages: initialMessages,
          currentAgentName: jafAgent.name,
          context: agentContext,
          turnCount: 0,
        }

        const messagesWithNoErrResponse: Message[] = [
          {
            role: ConversationRole.USER,
            content: [{ text: message }],
          },
        ]

        const pendingExpectations: PendingExpectation[] = []
        const expectationBuffer: PendingExpectation[] = []
        const expectationHistory = new Map<number, PendingExpectation[]>()
        const expectedResultsByCallId = new Map<string, ToolExpectation>()
        const toolCallTurnMap = new Map<string, number>()
        const syntheticToolCallIds = new WeakMap<ToolCall, string>()
        let syntheticToolCallSeq = 0
        const consecutiveToolErrors = new Map<string, number>()

        const recordExpectationsForTurn = (
          turn: number,
          expectations: PendingExpectation[]
        ) => {
          if (!expectations.length) {
            return
          }
          const existing = expectationHistory.get(turn) || []
          existing.push(...expectations)
          expectationHistory.set(turn, existing)
        }

        const flushExpectationBufferToTurn = (turn: number) => {
          if (!expectationBuffer.length) return
          const buffered = expectationBuffer.splice(0, expectationBuffer.length)
          recordExpectationsForTurn(turn, buffered)
        }

        const ensureToolCallId = (
          toolCall: ToolCall,
          turn: number,
          index: number
        ): string => {
          if (
            toolCall.id !== undefined &&
            toolCall.id !== null
          ) {
            const normalized = String(toolCall.id)
            syntheticToolCallIds.set(toolCall, normalized)
            return normalized
          }
          const existing = syntheticToolCallIds.get(toolCall)
          if (existing) return existing
          const generated = `synthetic-${turn}-${syntheticToolCallSeq++}-${index}`
          syntheticToolCallIds.set(toolCall, generated)
          return generated
        }

        const buildTurnReviewInput = (
          turn: number
        ): { reviewInput: AutoReviewInput; fallbackUsed: boolean } => {
          let toolHistory = agentContext.toolCallHistory.filter(
            (record) => record.turnNumber === turn
          )
          let fallbackUsed = false

          if (
            toolHistory.length === 0 &&
            agentContext.toolCallHistory.length > 0
          ) {
            fallbackUsed = true
            toolHistory = [
              agentContext.toolCallHistory[
                agentContext.toolCallHistory.length - 1
              ],
            ]
          }

          return {
            reviewInput: {
              focus: "turn_end",
              turnNumber: turn,
              contextFragments: agentContext.contextFragments,
              toolCallHistory: toolHistory,
              plan: agentContext.plan,
              expectedResults: expectationHistory.get(turn) || [],
            },
            fallbackUsed,
          }
        }

        const runTurnEndReviewAndCleanup = async (
          turn: number
        ): Promise<void> => {
          Logger.info({
            turn,
            expectationHistoryKeys: Array.from(expectationHistory.keys()),
            expectationsForThisTurn: expectationHistory.get(turn),
            chatId: agentContext.chat.externalId,
          }, "[DEBUG] Expectation history state at turn_end")

          try {
            const { reviewInput, fallbackUsed } = buildTurnReviewInput(turn)
            if (
              fallbackUsed &&
              agentContext.toolCallHistory.length > 0
            ) {
              Logger.warn(
                {
                  turn,
                  fallbackUsed,
                  toolHistoryCount: agentContext.toolCallHistory.length,
                  chatId: agentContext.chat.externalId,
                },
                "[MessageAgents] No per-turn tool records; defaulting to last tool call."
              )
            }
            await runAndBroadcastReview(reviewInput, turn)
          } catch (error) {
            Logger.error({
              turn,
              chatId: agentContext.chat.externalId,
              error: getErrorMessage(error),
            }, "[MessageAgents] Turn-end review failed")
          } finally {
            const attachmentState = getAttachmentPhaseMetadata(agentContext)
            if (attachmentState.initialAttachmentPhase) {
              agentContext.chat.metadata = {
                ...agentContext.chat.metadata,
                initialAttachmentPhase: false,
              }
            }
            pendingExpectations.length = 0
          }
        }

        const runAndBroadcastReview = async (
          reviewInput: AutoReviewInput,
          iteration: number
        ): Promise<ReviewResult> => {
          if (
            (!reviewInput.expectedResults ||
              reviewInput.expectedResults.length === 0) &&
            reviewInput.focus !== "run_end"
          ) {
            Logger.warn(
              { turn: iteration, focus: reviewInput.focus },
              "[MessageAgents] No expected results recorded for review input."
            )
          }

          let reviewResult: ReviewResult | null = null
          const pendingPromise = (async () => {
            const computedReview = await performAutomaticReview(
              reviewInput,
              agentContext,
              messagesWithNoErrResponse
            )
            reviewResult = computedReview
            await handleReviewOutcome(
              agentContext,
              computedReview,
              iteration,
              reviewInput.focus,
              emitReasoningStep
            )
          })()

          agentContext.review.pendingReview = pendingPromise
          try {
            await pendingPromise
            if (!reviewResult) {
              throw new Error("Review did not produce a result")
            }
            return reviewResult
          } finally {
            if (agentContext.review.pendingReview === pendingPromise) {
              agentContext.review.pendingReview = undefined
            }
          }
        }

        // Configure run with hooks
        const runCfg: JAFRunConfig<AgentRunContext> = {
          agentRegistry,
          modelProvider,
          maxTurns: 100,
          modelOverride: defaultBestModel,
          onTurnEnd: async ({ turn }) => {
            await runTurnEndReviewAndCleanup(turn)
          },
          // After tool execution hook
          onAfterToolExecution: async (
            toolName: string,
            result: any,
            hookContext: any
          ) => {
            const callIdRaw = hookContext?.toolCall?.id
            const normalizedCallId =
              hookContext?.toolCall
                ? syntheticToolCallIds.get(hookContext.toolCall) ??
                  (callIdRaw === undefined || callIdRaw === null
                    ? undefined
                    : String(callIdRaw))
                : undefined
            let expectationForCall: ToolExpectation | undefined
            if (
              normalizedCallId &&
              expectedResultsByCallId.has(normalizedCallId)
            ) {
              expectationForCall =
                expectedResultsByCallId.get(normalizedCallId)
              expectedResultsByCallId.delete(normalizedCallId)
            }
            const turnForCall = normalizedCallId
              ? toolCallTurnMap.get(normalizedCallId)
              : undefined
            if (normalizedCallId) {
              toolCallTurnMap.delete(normalizedCallId)
            }
            const content = await afterToolExecutionHook(
              toolName,
              result,
              hookContext,
              message,
              messagesWithNoErrResponse,
              gatheredFragmentsKeys,
              expectationForCall,
              emitReasoningStep,
              turnForCall
            )
            
            return content
          },
        }

        // Send initial metadata (without messageId yet - will send after storing)
        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({
            chatId: agentContext.chat.externalId,
          }),
        })

        // Execute JAF run with streaming
        let currentTurn = 0
        let answer = ""
        const citations: Citation[] = []
        const imageCitations: ImageCitation[] = []
        const citationMap: Record<number, number> = {}
        const yieldedCitations = new Set<number>()
        const yieldedImageCitations = new Map<number, Set<number>>()
        let assistantMessageId: string | null = null

        const streamAnswerText = async (text: string) => {
          if (!text) return
          const chunkSize = 200
          for (let i = 0; i < text.length; i += chunkSize) {
            const chunk = text.slice(i, i + chunkSize)
            answer += chunk
            await stream.writeSSE({
              event: ChatSSEvents.ResponseUpdate,
              data: chunk,
            })

            for await (const citationEvent of checkAndYieldCitationsForAgent(
              answer,
              yieldedCitations,
              agentContext.contextFragments,
              yieldedImageCitations,
              email,
            )) {
              if (citationEvent.citation) {
                const { index, item } = citationEvent.citation
                citations.push(item)
                citationMap[index] = citations.length - 1
                await stream.writeSSE({
                  event: ChatSSEvents.CitationsUpdate,
                  data: JSON.stringify({
                    contextChunks: citations,
                    citationMap,
                  }),
                })
              }
              if (citationEvent.imageCitation) {
                imageCitations.push(citationEvent.imageCitation)
                await stream.writeSSE({
                  event: ChatSSEvents.ImageCitationUpdate,
                  data: JSON.stringify(citationEvent.imageCitation),
                })
              }
            }
          }
        }
        agentContext.runtime = {
          streamAnswerText,
          emitReasoning: emitReasoningStep,
        }
        const traceEventHandler = async (event: TraceEvent) => {
          if (event.type === "before_tool_execution") {
            return beforeToolExecutionHook(
              event.data.toolName,
              event.data.args,
              agentContext,
              emitReasoningStep
            )
          }
          return undefined
        }

        Logger.info(
          {
            runId,
            chatId: agentContext.chat.externalId,
            modelOverride: defaultBestModel,
            email,
          },
          "[MessageAgents] Starting assistant call"
        )

        for await (const evt of runStream<AgentRunContext, string>(
          runState,
          runCfg,
          traceEventHandler
        )) {
          if (stream.closed) break

          switch (evt.type) {
            case "turn_start":
              runState.context.turnCount = evt.data.turn
              currentTurn = evt.data.turn
              flushExpectationBufferToTurn(currentTurn)
              await streamReasoningStep(
                emitReasoningStep,
                `Turn ${currentTurn} started`,
                { iteration: currentTurn }
              )
              break

            case "tool_requests":
              Logger.info(
                {
                  turn: currentTurn,
                  plannedTools: evt.data.toolCalls.map((toolCall) => ({
                    name: toolCall.name,
                    args: toolCall.args,
                  })),
                  chatId: agentContext.chat.externalId,
                },
                "[MessageAgents] Tool plan for turn"
              )
              for (const [idx, toolCall] of evt.data.toolCalls.entries()) {
                const normalizedCallId = ensureToolCallId(
                  toolCall,
                  currentTurn,
                  idx
                )
                toolCallTurnMap.set(normalizedCallId, currentTurn)
                const assignedExpectation = consumePendingExpectation(
                  pendingExpectations,
                  toolCall.name
                )
                if (assignedExpectation) {
                  expectedResultsByCallId.set(
                    normalizedCallId,
                    assignedExpectation.expectation
                  )
                }
                await streamReasoningStep(
                  emitReasoningStep,
                  `Tool selected: ${toolCall.name}`,
                  { toolName: toolCall.name }
                )

                if (toolCall.name === "toDoWrite") {
                  await streamReasoningStep(
                    emitReasoningStep,
                    "Formulating a step-by-step plan...",
                    { toolName: toolCall.name }
                  )
                } else if (toolCall.name === "list_custom_agents") {
                  await streamReasoningStep(
                    emitReasoningStep,
                    "Searching for specialized agents that can help...",
                    { toolName: toolCall.name }
                  )
                } else if (toolCall.name === "run_public_agent") {
                  const agentId = (toolCall.args as { agentId?: string })?.agentId
                  const agentName =
                    agentContext.availableAgents.find(
                      (agent) => agent.agentId === agentId
                    )?.agentName || agentId || "selected agent"
                  await streamReasoningStep(
                    emitReasoningStep,
                    `Delegating sub-task to the '${agentName}' agent...`,
                    { toolName: toolCall.name, detail: agentName }
                  )
                } else if (toolCall.name === "fall_back") {
                  await streamReasoningStep(
                    emitReasoningStep,
                    "Initial strategy was unsuccessful. Activating fallback search to find an answer.",
                    { toolName: toolCall.name }
                  )
                }
              }
              break

            case "tool_call_start":
              Logger.info({
                toolName: evt.data.toolName,
                args: evt.data.args,
                runId,
                chatId: agentContext.chat.externalId,
                turn: currentTurn,
              }, "[MessageAgents][Tool Start]")
              await streamReasoningStep(
                emitReasoningStep,
                `Executing ${evt.data.toolName}...`,
                {
                  toolName: evt.data.toolName,
                  detail: JSON.stringify(evt.data.args ?? {}),
                }
              )
              break

            case "tool_call_end":
              Logger.info({
                toolName: evt.data.toolName,
                args: evt.data.args,
                result: evt.data.result,
                error: evt.data.error,
                executionTime: evt.data.executionTime,
                status: evt.data.error ? "error" : "success",
                runId,
                chatId: agentContext.chat.externalId,
                turn: currentTurn,
              }, "[MessageAgents][Tool End]")
              await streamReasoningStep(
                emitReasoningStep,
                `Tool ${evt.data.toolName} completed`,
                {
                  toolName: evt.data.toolName,
                  status: evt.data.error ? "error" : evt.data.status,
                  detail: evt.data.error
                    ? `Error: ${evt.data.error}`
                    : `Result: ${typeof evt.data.result === "string"
                        ? evt.data.result.slice(0, 800)
                        : JSON.stringify(evt.data.result).slice(0, 800)}`,
                }
              )
              if (evt.data.error) {
                const newCount =
                  (consecutiveToolErrors.get(evt.data.toolName) ?? 0) + 1
                consecutiveToolErrors.set(evt.data.toolName, newCount)
                if (newCount >= 2) {
                  const recentHistory = agentContext.toolCallHistory
                    .filter((record) => record.toolName === evt.data.toolName)
                    .slice(-newCount)
                  if (recentHistory.length > 0) {
                    await runAndBroadcastReview(
                      {
                        focus: "tool_error",
                        turnNumber: currentTurn,
                        contextFragments: agentContext.contextFragments,
                        toolCallHistory: recentHistory,
                        plan: agentContext.plan,
                        expectedResults:
                          expectationHistory.get(currentTurn) || [],
                      },
                      currentTurn
                    )
                  }
                }
              } else {
                consecutiveToolErrors.delete(evt.data.toolName)
              }
              break

            case "turn_end":
              // DETERMINISTIC REVIEW: Run after every turn completes
              await streamReasoningStep(
                emitReasoningStep,
                "Turn complete. Reviewing progress and results...",
                { iteration: evt.data.turn }
              )

              const currentTurnToolHistory =
                agentContext.toolCallHistory.filter(
                  (record) => record.turnNumber === evt.data.turn
                )

              if (currentTurnToolHistory.length > 0) {
                await streamReasoningStep(
                  emitReasoningStep,
                  buildTurnToolReasoningSummary(
                    evt.data.turn,
                    currentTurnToolHistory
                  ),
                  { iteration: evt.data.turn }
                )
              } else {
                await streamReasoningStep(
                  emitReasoningStep,
                  `No tools were executed in turn ${evt.data.turn}.`,
                  { iteration: evt.data.turn }
                )
              }
              break

            case "assistant_message":
              Logger.info(
                {
                  turn: currentTurn,
                  hasToolCalls:
                    Array.isArray(evt.data.message?.tool_calls) &&
                    (evt.data.message.tool_calls?.length ?? 0) > 0,
                  contentPreview: getTextContent(evt.data.message.content)
                    ?.slice(0, 200) || "",
                  chatId: agentContext.chat.externalId,
                },
                "[MessageAgents] Assistant output received"
              )
              const content = getTextContent(evt.data.message.content) || ""
              
              if (content) {
                const extractedExpectations = extractExpectedResults(content)
                Logger.info({
                  turn: currentTurn,
                  extractedCount: extractedExpectations.length,
                  extractedExpectations,
                  chatId: agentContext.chat.externalId,
                }, "[DEBUG] Extracted expectations from assistant message")
                if (extractedExpectations.length > 0) {
                  await streamReasoningStep(
                    emitReasoningStep,
                    "Setting expectations for tool calls...",
                    { iteration: currentTurn }
                  )
                  for (const expectation of extractedExpectations) {
                    await streamReasoningStep(
                      emitReasoningStep,
                      `Expectation for '${expectation.toolName}': ${expectation.expectation.goal}`,
                      { toolName: expectation.toolName }
                    )
                  }
                  pendingExpectations.push(...extractedExpectations)
                  if (currentTurn > 0) {
                    Logger.info({
                      turn: currentTurn,
                      expectationsCount: extractedExpectations.length,
                      chatId: agentContext.chat.externalId,
                    }, "[DEBUG] Recording expectations for current turn")
                    recordExpectationsForTurn(
                      currentTurn,
                      extractedExpectations
                    )
                  } else {
                    Logger.info({
                      turn: currentTurn,
                      expectationsCount: extractedExpectations.length,
                      chatId: agentContext.chat.externalId,
                    }, "[DEBUG] Buffering expectations for future turn")
                    expectationBuffer.push(...extractedExpectations)
                  }
                }
              }

              const hasToolCalls =
                Array.isArray(evt.data.message?.tool_calls) &&
                (evt.data.message.tool_calls?.length ?? 0) > 0

              if (hasToolCalls) {
                await streamReasoningStep(
                  emitReasoningStep,
                  content || "Model planned tool usage."
                )
                break
              }

              if (agentContext.finalSynthesis.suppressAssistantStreaming) {
                if (content?.trim()) {
                  agentContext.finalSynthesis.ackReceived = true
                  await streamReasoningStep(
                    emitReasoningStep,
                    "Final synthesis acknowledged. Closing out the run."
                  )
                }
                break
              }

              if (content) {
                await streamAnswerText(content)
              }
              break

            case "final_output":
              const output = evt.data.output
              if (
                !agentContext.finalSynthesis.suppressAssistantStreaming &&
                typeof output === "string" &&
                output.length > 0
              ) {
                const remaining = output.slice(answer.length)
                if (remaining) {
                  await streamAnswerText(remaining)
                }
              }
              break

            case "run_end":
              const outcome = evt.data.outcome
              if (outcome?.status === "completed") {
                const finalTurnNumber = ensureTurnNumber(
                  agentContext.turnCount ?? currentTurn
                )
                await runAndBroadcastReview(
                  {
                    focus: "run_end",
                    turnNumber: finalTurnNumber,
                    contextFragments: agentContext.contextFragments,
                    toolCallHistory: agentContext.toolCallHistory,
                    plan: agentContext.plan,
                    expectedResults:
                      expectationHistory.get(finalTurnNumber) || [],
                  },
                  finalTurnNumber
                )
                // Store the response in database to prevent vanishing
                // TODO: Implement full DB integration similar to MessageWithToolsApi
                // For now, store basic message data
                loggerWithChild({ email }).info("Storing assistant response in database")
                
                // Calculate costs and tokens
                const totalCost = agentContext.totalCost
                const totalTokens =
                  agentContext.tokenUsage.input + agentContext.tokenUsage.output

                try {
                  const msg = await insertMessage(db, {
                    chatId: chatRecord.id,
                    userId: user.id,
                    workspaceExternalId: workspace.externalId,
                    chatExternalId: chatRecord.externalId,
                    messageRole: MessageRole.Assistant,
                    email: user.email,
                    sources: citations,
                    imageCitations,
                    message: processMessage(answer, citationMap),
                    thinking: thinkingLog,
                    modelId: defaultBestModel,
                    cost: totalCost.toString(),
                    tokensUsed: totalTokens,
                  })
                  assistantMessageId = msg.externalId
                } catch (error) {
                  loggerWithChild({ email }).error(
                    error,
                    "Failed to persist assistant response"
                  )
                }
                
                loggerWithChild({ email }).info({
                  answer,
                  citations: citations.length,
                  cost: totalCost,
                  tokens: totalTokens,
                }, "Response generated successfully")
                
                // Send final metadata with messageId
                await stream.writeSSE({
                  event: ChatSSEvents.ResponseMetadata,
                  data: JSON.stringify({
                    chatId: agentContext.chat.externalId,
                    messageId: assistantMessageId || "temp-message-id",
                  }),
                })
                
                await stream.writeSSE({
                  event: ChatSSEvents.End,
                  data: "",
                })
              } else if (outcome?.status === "error") {
                const err = outcome.error
                const errMsg = err?._tag === "MaxTurnsExceeded"
                  ? `Max turns exceeded: ${err.turns}`
                  : "Execution error"
                
                await stream.writeSSE({
                  event: ChatSSEvents.Error,
                  data: JSON.stringify({ error: err?._tag, message: errMsg }),
                })
                await stream.writeSSE({
                  event: ChatSSEvents.End,
                  data: "",
                })
              }
              break
          }
        }

        rootSpan.end()
      } catch (error) {
        loggerWithChild({ email }).error(error, "MessageAgents stream error")
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: JSON.stringify({
            error: "stream_error",
            message: getErrorMessage(error),
          }),
        })
        await stream.writeSSE({
          event: ChatSSEvents.End,
          data: "",
        })
        rootSpan.end()
      } finally {
        for (const client of mcpClients) {
          try {
            await client.close?.()
          } catch (error) {
            loggerWithChild({ email }).error(
              error,
              "Failed to close MCP client",
            )
          }
        }
      }
    })
  } catch (error) {
    loggerWithChild({ email }).error(error, "MessageAgents failed")
    rootSpan.end()
    throw error
  }
}

type ListAgentsParams = {
  query: string
  userEmail: string
  workspaceExternalId: string
  workspaceNumericId?: number
  userId?: number
  requiredCapabilities?: string[]
  maxAgents?: number
  mcpAgents?: MCPVirtualAgentRuntime[]
}

export async function listCustomAgentsSuitable(
  params: ListAgentsParams
): Promise<ListCustomAgentsOutput> {
  const maxAgents = Math.min(Math.max(params.maxAgents ?? 5, 1), 10)
  let workspaceDbId = params.workspaceNumericId
  let userDbId = params.userId
  const mcpAgentsFromContext = params.mcpAgents ?? []

  if (!workspaceDbId || !userDbId) {
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      params.workspaceExternalId,
      params.userEmail
    )
    workspaceDbId = userAndWorkspace.workspace.id
    userDbId = userAndWorkspace.user.id
  }

  const accessibleAgents = await getUserAccessibleAgents(
    db,
    userDbId!,
    workspaceDbId!,
    25,
    0
  )

  if (!accessibleAgents.length && mcpAgentsFromContext.length === 0) {
    return {
      result: "No custom agents available for this workspace.",
      agents: [],
      totalEvaluated: 0,
    }
  }

  let connectorState = createEmptyConnectorState()
  try {
    connectorState = await getUserConnectorState(db, params.userEmail)
  } catch (error) {
    loggerWithChild({ email: params.userEmail }).warn(
      error,
      "Failed to load connector state; defaulting to no connectors",
    )
  }

  const resourceAccessByAgent = new Map<string, ResourceAccessSummary[]>()
  const briefs = await Promise.all(
    accessibleAgents.map(async (agent) => {
      let resourceAccess: ResourceAccessSummary[] = []
      try {
        resourceAccess = await evaluateAgentResourceAccess({
          agent,
          userEmail: params.userEmail,
          connectorState,
        })
      } catch (error) {
        loggerWithChild({ email: params.userEmail }).warn(
          error,
          "Failed to evaluate resource access for agent",
          { agentId: agent.externalId },
        )
      }
      resourceAccessByAgent.set(agent.externalId, resourceAccess)
      return buildAgentBrief(agent, resourceAccess)
    }),
  )
  const mcpBriefs: AgentBrief[] = mcpAgentsFromContext.map((agent) => ({
    agentId: agent.agentId,
    agentName: agent.connectorName || `Connector ${agent.connectorId}`,
    description:
      agent.description ||
      `MCP agent wrapping ${agent.tools.length} tool${agent.tools.length === 1 ? "" : "s"}.`,
    capabilities: agent.tools.map((t) => t.toolName),
    domains: ["mcp"],
    estimatedCost: "medium",
    averageLatency: 4500,
    isPublic: true,
    resourceAccess: [],
  }))
  const combinedBriefs = [...briefs, ...mcpBriefs]
  const totalEvaluated = accessibleAgents.length + mcpBriefs.length

  const systemPrompt = [
    "You are routing queries to the best custom agent.",
    "Return JSON with keys result, agents (array|null), totalEvaluated.",
    "Each agent entry must include: agentId, agentName, description, capabilities[], domains[], suitabilityScore (0-1), confidence (0-1), estimatedCost ('low'|'medium'|'high'), averageLatency (ms).",
    `Select up to ${maxAgents} agents.`,
    "If no agent is unquestionably suitable, set agents to null and explain why in result.",
    "Only include an agent when you can cite concrete capability matches; otherwise leave it out.",
    "You may return multiple agents when several are clearly relevant—rank the strongest ones first."
  ].join(" ")

  const payload = [
    `User Query: ${params.query}`,
    params.requiredCapabilities?.length
      ? `Required capabilities: ${params.requiredCapabilities.join(", ")}`
      : "Required capabilities: none specified",
    "Agents:",
    formatAgentBriefsForPrompt(combinedBriefs),
  ].join("\n\n")

  const modelId =
    (defaultFastModel as Models) || (defaultBestModel as Models)
  const modelParams: ModelParams = {
    modelId,
    json: true,
    stream: false,
    temperature: 0,
    maxTokens: 800,
    systemPrompt,
  }

  try {
    const messages: Message[] = [
      {
        role: ConversationRole.USER,
        content: [{ text: payload }],
      },
    ]

    const { text } = await getProviderByModel(modelId).converse(
      messages,
      modelParams
    )

    const parsed = jsonParseLLMOutput(text || "")
    const validation = ListCustomAgentsOutputSchema.safeParse(parsed)
    if (validation.success) {
      const trimmedAgentsRaw = validation.data.agents
        ? validation.data.agents.slice(0, maxAgents)
        : []
      const trimmedAgents =
        trimmedAgentsRaw.length > 0 ? trimmedAgentsRaw : null
      const enrichedAgents = trimmedAgents
        ? trimmedAgents.map((agent) => ({
            ...agent,
            resourceAccess: resourceAccessByAgent.get(agent.agentId) ?? [],
          }))
        : null
      return {
        result: validation.data.result,
        agents: enrichedAgents,
        totalEvaluated,
      }
    }

    loggerWithChild({ email: params.userEmail }).warn(
      { issue: validation.error.format() },
      "LLM agent selection output invalid, falling back to heuristic scoring"
    )
  } catch (error) {
    loggerWithChild({ email: params.userEmail }).error(
      { err: error },
      "LLM agent selection failed, falling back to heuristic scoring"
    )
  }

  loggerWithChild({ email: params.userEmail }).info(
    { 
      query: params.query,
      totalAgents: combinedBriefs.length,
      maxAgents,
    },
    "Using heuristic agent selection mechanism (LLM-based selection not available or failed)"
  )

  return buildHeuristicAgentSelection(
    combinedBriefs,
    params.query,
    maxAgents,
    totalEvaluated
  )
}

export async function executeCustomAgent(
  params: {
    agentId: string
    query: string
    userEmail: string
    workspaceExternalId: string
    contextSnippet?: string
    maxTokens?: number
    parentTurn?: number
    mcpAgents?: MCPVirtualAgentRuntime[]
  }
): Promise<ToolOutput> {
  const turnInfo =
    typeof params.parentTurn === "number"
      ? `\n\nTurn info: Parent turn number is ${params.parentTurn}. Continue numbering from here.`
      : ""

  const combinedQuery = params.contextSnippet
    ? `${params.query}\n\nAdditional context:\n${params.contextSnippet}${turnInfo}`
    : `${params.query}${turnInfo}`

  if (params.agentId.startsWith("mcp:")) {
    return executeMcpAgent(params.agentId, combinedQuery, {
      mcpAgents: params.mcpAgents,
      maxTokens: params.maxTokens,
      parentTurn: params.parentTurn,
      userEmail: params.userEmail,
    })
  }

  if (config.delegation_agentic) {
    return runDelegatedAgentWithMessageAgents({
      agentId: params.agentId,
      query: combinedQuery,
      userEmail: params.userEmail,
      workspaceExternalId: params.workspaceExternalId,
      maxTokens: params.maxTokens,
      parentTurn: params.parentTurn,
      mcpAgents: params.mcpAgents,
    })
  }

  try {
    const result = await executeAgentForWorkflowWithRag({
      agentId: params.agentId,
      userQuery: combinedQuery,
      workspaceId: params.workspaceExternalId,
      userEmail: params.userEmail,
      isStreamable: false,
      temperature: 0.2,
      max_new_tokens: params.maxTokens,
      parentTurn: params.parentTurn,
      attachmentFileIds: [],
      nonImageAttachmentFileIds: [],
    })

    if (!result.success) {
      return {
        result: "Agent execution failed",
        error: result.error || "Unknown error",
        metadata: {
          agentId: params.agentId,
        },
      }
    }

    return {
      result: result.response || "Agent did not return any text.",
      metadata: {
        agentId: params.agentId,
        citations: result.citations,
        imageCitations: result.imageCitations,
        cost: result.cost,
        tokensUsed: result.tokensUsed,
        parentTurn: params.parentTurn,
      },
    }
  } catch (error) {
    Logger.error(
      { err: error },
      "executeCustomAgent encountered an error"
    )
    return {
      result: "Agent execution threw an exception",
      error: getErrorMessage(error),
      metadata: {
        agentId: params.agentId,
        parentTurn: params.parentTurn,
      },
    }
  }
}

const DELEGATED_RUN_MAX_TURNS = 25

type DelegatedAgentRunParams = {
  agentId: string
  query: string
  userEmail: string
  workspaceExternalId: string
  maxTokens?: number
  parentTurn?: number
  mcpAgents?: MCPVirtualAgentRuntime[]
}

async function runDelegatedAgentWithMessageAgents(
  params: DelegatedAgentRunParams
): Promise<ToolOutput> {
  const logger = loggerWithChild({ email: params.userEmail })
  try {
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      params.workspaceExternalId,
      params.userEmail
    )
    const { user, workspace } = userAndWorkspace
    const agentRecord = await getAgentByExternalIdWithPermissionCheck(
      db,
      params.agentId,
      workspace.id,
      user.id
    )

    if (!agentRecord) {
      return {
        result: "Agent execution failed",
        error: `Access denied: You don't have permission to use agent ${params.agentId}`,
        metadata: { agentId: params.agentId, parentTurn: params.parentTurn },
      }
    }

    const agentPromptForLLM = JSON.stringify(agentRecord)
    const userCtxString = userContext(userAndWorkspace)
    const userTimezone = user?.timeZone || "Asia/Kolkata"
    const dateForAI = getDateForAI({ userTimeZone: userTimezone })
    const attachmentsForContext: Array<{ fileId: string; isImage: boolean }> = []

    let connectorState = createEmptyConnectorState()
    try {
      connectorState = await getUserConnectorState(db, params.userEmail)
    } catch (error) {
      logger.warn(
        error,
        "[DelegatedAgenticRun] Failed to load connector state; assuming no connectors"
      )
    }

    const chatExternalId = `delegate-${generateRunId()}`
    const agentContext = initializeAgentContext(
      params.userEmail,
      params.workspaceExternalId,
      user.id,
      chatExternalId,
      params.query,
      attachmentsForContext,
      {
        userContext: userCtxString,
        agentPrompt: agentPromptForLLM,
        workspaceNumericId: workspace.id,
      }
    )
    agentContext.delegationEnabled = false
    agentContext.ambiguityResolved = true
    agentContext.maxOutputTokens = params.maxTokens
    agentContext.mcpAgents = params.mcpAgents ?? []

    const allowedAgentApps = deriveAllowedAgentApps(agentPromptForLLM)
    const baseInternalTools = buildInternalToolAdapters()
    const internalTools = filterToolsByAvailability(baseInternalTools, {
      connectorState,
      allowedAgentApps,
      email: params.userEmail,
      agentId: params.agentId,
    })

    const directMcpToolsMap: FinalToolsList = {}
    if (params.mcpAgents?.length) {
      for (const agent of params.mcpAgents) {
        if (!agent.client || agent.tools.length === 0) continue
        const connectorKey = String(agent.connectorId || agent.agentId)
        directMcpToolsMap[connectorKey] = {
          tools: agent.tools.map((tool) => ({
            toolName: tool.toolName,
            toolSchema: tool.toolSchema,
            description: tool.description,
          })),
          client: agent.client,
        }
      }
    }
    const directMcpTools = buildMCPJAFTools(directMcpToolsMap)

    const allTools: Tool<unknown, AgentRunContext>[] = [
      ...internalTools,
      ...directMcpTools,
    ]
    agentContext.enabledTools = new Set(
      allTools.map((tool) => tool.schema.name)
    )

    const gatheredFragmentsKeys = new Set<string>()

    const instructions = () =>
      buildAgentInstructions(
        agentContext,
        allTools.map((tool) => tool.schema.name),
        dateForAI,
        agentPromptForLLM,
        false
      )

    const jafAgent: JAFAgent<AgentRunContext, string> = {
      name: "xyne-delegate",
      instructions,
      tools: allTools,
      modelConfig: { name: defaultBestModel },
    }

    const modelProvider = makeXyneJAFProvider<AgentRunContext>()
    const agentRegistry = new Map<string, JAFAgent<AgentRunContext, string>>([
      [jafAgent.name, jafAgent],
    ])

    const runId = generateRunId()
    const traceId = generateTraceId()
    const message = params.query

    const initialMessages: JAFMessage[] = [
      {
        role: "user",
        content: message,
      },
    ]

    const runState: JAFRunState<AgentRunContext> = {
      runId,
      traceId,
      messages: initialMessages,
      currentAgentName: jafAgent.name,
      context: agentContext,
      turnCount: 0,
    }

    const messagesWithNoErrResponse: Message[] = [
      {
        role: ConversationRole.USER,
        content: [{ text: message }],
      },
    ]

    const pendingExpectations: PendingExpectation[] = []
    const expectationBuffer: PendingExpectation[] = []
    const expectationHistory = new Map<number, PendingExpectation[]>()
    const expectedResultsByCallId = new Map<string, ToolExpectation>()
    const toolCallTurnMap = new Map<string, number>()
    const syntheticToolCallIds = new WeakMap<ToolCall, string>()
    let syntheticToolCallSeq = 0
    const consecutiveToolErrors = new Map<string, number>()

    const recordExpectationsForTurn = (
      turn: number,
      expectations: PendingExpectation[]
    ) => {
      if (!expectations.length) return
      const existing = expectationHistory.get(turn) || []
      existing.push(...expectations)
      expectationHistory.set(turn, existing)
    }

    const flushExpectationBufferToTurn = (turn: number) => {
      if (!expectationBuffer.length) return
      const buffered = expectationBuffer.splice(0, expectationBuffer.length)
      recordExpectationsForTurn(turn, buffered)
    }

    const ensureToolCallId = (
      toolCall: ToolCall,
      turn: number,
      index: number
    ): string => {
      if (toolCall.id !== undefined && toolCall.id !== null) {
        const normalized = String(toolCall.id)
        syntheticToolCallIds.set(toolCall, normalized)
        return normalized
      }
      const existing = syntheticToolCallIds.get(toolCall)
      if (existing) return existing
      const generated = `synthetic-${turn}-${syntheticToolCallSeq++}-${index}`
      syntheticToolCallIds.set(toolCall, generated)
      return generated
    }

    const buildTurnReviewInput = (
      turn: number
    ): { reviewInput: AutoReviewInput; fallbackUsed: boolean } => {
      let toolHistory = agentContext.toolCallHistory.filter(
        (record) => record.turnNumber === turn
      )
      let fallbackUsed = false

      if (
        toolHistory.length === 0 &&
        agentContext.toolCallHistory.length > 0
      ) {
        fallbackUsed = true
        toolHistory = [
          agentContext.toolCallHistory[
            agentContext.toolCallHistory.length - 1
          ],
        ]
      }

      return {
        reviewInput: {
          focus: "turn_end",
          turnNumber: turn,
          contextFragments: agentContext.contextFragments,
          toolCallHistory: toolHistory,
          plan: agentContext.plan,
          expectedResults: expectationHistory.get(turn) || [],
        },
        fallbackUsed,
      }
    }

    const runTurnEndReviewAndCleanup = async (
      turn: number
    ): Promise<void> => {
      Logger.info({
        turn,
        expectationHistoryKeys: Array.from(expectationHistory.keys()),
        expectationsForThisTurn: expectationHistory.get(turn),
        chatId: agentContext.chat.externalId,
      }, "[DelegatedAgenticRun][DEBUG] Expectation history state at turn_end")

      try {
        const { reviewInput, fallbackUsed } = buildTurnReviewInput(turn)
        if (
          fallbackUsed &&
          agentContext.toolCallHistory.length > 0
        ) {
          Logger.warn(
            {
              turn,
              fallbackUsed,
              toolHistoryCount: agentContext.toolCallHistory.length,
              chatId: agentContext.chat.externalId,
            },
            "[DelegatedAgenticRun] No per-turn tool records; defaulting to last tool call."
          )
        }
        await runAndBroadcastReview(reviewInput, turn)
      } catch (error) {
        Logger.error({
          turn,
          chatId: agentContext.chat.externalId,
          error: getErrorMessage(error),
        }, "[DelegatedAgenticRun] Turn-end review failed")
      } finally {
        const attachmentState = getAttachmentPhaseMetadata(agentContext)
        if (attachmentState.initialAttachmentPhase) {
          agentContext.chat.metadata = {
            ...agentContext.chat.metadata,
            initialAttachmentPhase: false,
          }
        }
        pendingExpectations.length = 0
      }
    }

    const emitReasoningStep: ReasoningEmitter = async (_payload) => {
      return
    }

    const runAndBroadcastReview = async (
      reviewInput: AutoReviewInput,
      iteration: number
    ): Promise<ReviewResult> => {
      if (
        (!reviewInput.expectedResults ||
          reviewInput.expectedResults.length === 0) &&
        reviewInput.focus !== "run_end"
      ) {
        Logger.warn(
          { turn: iteration, focus: reviewInput.focus },
          "[DelegatedAgenticRun] No expected results recorded for review input."
        )
      }
      const reviewResult = await performAutomaticReview(
        reviewInput,
        agentContext
      )
      await handleReviewOutcome(
        agentContext,
        reviewResult,
        iteration,
        reviewInput.focus,
        emitReasoningStep
      )
      return reviewResult
    }

    const runCfg: JAFRunConfig<AgentRunContext> = {
      agentRegistry,
      modelProvider,
      maxTurns: Math.min(DELEGATED_RUN_MAX_TURNS, 100),
      modelOverride: defaultBestModel,
      onTurnEnd: async ({ turn }) => {
        await runTurnEndReviewAndCleanup(turn)
      },
      onAfterToolExecution: async (
        toolName: string,
        result: any,
        hookContext: any
      ) => {
        const callIdRaw = hookContext?.toolCall?.id
        const normalizedCallId =
          hookContext?.toolCall
            ? syntheticToolCallIds.get(hookContext.toolCall) ??
              (callIdRaw === undefined || callIdRaw === null
                ? undefined
                : String(callIdRaw))
            : undefined
        let expectationForCall: ToolExpectation | undefined
        if (
          normalizedCallId &&
          expectedResultsByCallId.has(normalizedCallId)
        ) {
          expectationForCall = expectedResultsByCallId.get(normalizedCallId)
          expectedResultsByCallId.delete(normalizedCallId)
        }
        const turnForCall = normalizedCallId
          ? toolCallTurnMap.get(normalizedCallId)
          : undefined
        if (normalizedCallId) {
          toolCallTurnMap.delete(normalizedCallId)
        }
        return afterToolExecutionHook(
          toolName,
          result,
          hookContext,
          message,
          messagesWithNoErrResponse,
          gatheredFragmentsKeys,
          expectationForCall,
          emitReasoningStep,
          turnForCall
        )
      },
    }

    const traceEventHandler = async (event: TraceEvent) => {
      if (event.type !== "before_tool_execution") return undefined
      return beforeToolExecutionHook(
        event.data.toolName,
        event.data.args,
        agentContext,
        emitReasoningStep
      )
    }

    let answer = ""
    const streamAnswerText = async (text: string) => {
      if (!text) return
      answer += text
    }
    agentContext.runtime = {
      streamAnswerText,
      emitReasoning: emitReasoningStep,
    }

    let currentTurn = 0
    let runCompleted = false
    let runFailedMessage: string | null = null

    try {
      for await (const evt of runStream<AgentRunContext, string>(
        runState,
        runCfg,
        traceEventHandler
      )) {
        switch (evt.type) {
          case "turn_start":
            runState.context.turnCount = evt.data.turn
            currentTurn = evt.data.turn
            flushExpectationBufferToTurn(currentTurn)
            await streamReasoningStep(
              emitReasoningStep,
              `Turn ${currentTurn} started`,
              { iteration: currentTurn }
            )
            break

          case "tool_requests":
            for (const [idx, toolCall] of evt.data.toolCalls.entries()) {
              const normalizedCallId = ensureToolCallId(
                toolCall,
                currentTurn,
                idx
              )
              toolCallTurnMap.set(normalizedCallId, currentTurn)
              const assignedExpectation = consumePendingExpectation(
                pendingExpectations,
                toolCall.name
              )
              if (assignedExpectation) {
                expectedResultsByCallId.set(
                  normalizedCallId,
                  assignedExpectation.expectation
                )
              }
              await streamReasoningStep(
                emitReasoningStep,
                `Tool selected: ${toolCall.name}`,
                { toolName: toolCall.name }
              )
            }
            break

          case "tool_call_start":
            await streamReasoningStep(
              emitReasoningStep,
              `Executing ${evt.data.toolName}...`,
              {
                toolName: evt.data.toolName,
                detail: JSON.stringify(evt.data.args ?? {}),
              }
            )
            break

          case "tool_call_end":
            await streamReasoningStep(
              emitReasoningStep,
              `Tool ${evt.data.toolName} completed`,
              {
                toolName: evt.data.toolName,
                status: evt.data.error ? "error" : evt.data.status,
                detail: evt.data.error
                  ? `Error: ${evt.data.error}`
                  : `Result: ${typeof evt.data.result === "string"
                      ? evt.data.result.slice(0, 800)
                      : JSON.stringify(evt.data.result).slice(0, 800)}`,
              }
            )
            if (evt.data.error) {
              const newCount =
                (consecutiveToolErrors.get(evt.data.toolName) ?? 0) + 1
              consecutiveToolErrors.set(evt.data.toolName, newCount)
              if (newCount >= 2) {
                const recentHistory = agentContext.toolCallHistory
                  .filter((record) => record.toolName === evt.data.toolName)
                  .slice(-newCount)
                if (recentHistory.length > 0) {
                  await runAndBroadcastReview(
                    {
                      focus: "tool_error",
                      turnNumber: currentTurn,
                      contextFragments: agentContext.contextFragments,
                      toolCallHistory: recentHistory,
                      plan: agentContext.plan,
                      expectedResults:
                        expectationHistory.get(currentTurn) || [],
                    },
                    currentTurn
                  )
                }
              }
            } else {
              consecutiveToolErrors.delete(evt.data.toolName)
            }
            break

          case "turn_end":
            await streamReasoningStep(
              emitReasoningStep,
              "Turn complete. Reviewing progress and results...",
              { iteration: evt.data.turn }
            )

            const currentTurnToolHistory =
              agentContext.toolCallHistory.filter(
                (record) => record.turnNumber === evt.data.turn
              )

            if (currentTurnToolHistory.length > 0) {
              await streamReasoningStep(
                emitReasoningStep,
                buildTurnToolReasoningSummary(
                  evt.data.turn,
                  currentTurnToolHistory
                ),
                { iteration: evt.data.turn }
              )
            } else {
              await streamReasoningStep(
                emitReasoningStep,
                `No tools were executed in turn ${evt.data.turn}.`,
                { iteration: evt.data.turn }
              )
            }

            break

          case "assistant_message":
            const content = getTextContent(evt.data.message.content) || ""
            if (content) {
              const extractedExpectations = extractExpectedResults(content)
              if (extractedExpectations.length > 0) {
                await streamReasoningStep(
                  emitReasoningStep,
                  "Setting expectations for tool calls...",
                  { iteration: currentTurn }
                )
                for (const expectation of extractedExpectations) {
                  await streamReasoningStep(
                    emitReasoningStep,
                    `Expectation for '${expectation.toolName}': ${expectation.expectation.goal}`,
                    { toolName: expectation.toolName }
                  )
                }
                pendingExpectations.push(...extractedExpectations)
                if (currentTurn > 0) {
                  recordExpectationsForTurn(
                    currentTurn,
                    extractedExpectations
                  )
                } else {
                  expectationBuffer.push(...extractedExpectations)
                }
              }
            }

            const hasToolCalls =
              Array.isArray(evt.data.message?.tool_calls) &&
              (evt.data.message.tool_calls?.length ?? 0) > 0

            if (hasToolCalls) {
              await streamReasoningStep(
                emitReasoningStep,
                content || "Model planned tool usage."
              )
              break
            }

            if (agentContext.finalSynthesis.suppressAssistantStreaming) {
              if (content?.trim()) {
                agentContext.finalSynthesis.ackReceived = true
                await streamReasoningStep(
                  emitReasoningStep,
                  "Final synthesis acknowledged. Closing out the run."
                )
              }
              break
            }

            if (content) {
              await agentContext.runtime?.streamAnswerText?.(content)
            }
            break

          case "final_output":
            const output = evt.data.output
            if (
              !agentContext.finalSynthesis.suppressAssistantStreaming &&
              typeof output === "string" &&
              output.length > 0
            ) {
              const remaining = output.slice(answer.length)
              if (remaining) {
                await agentContext.runtime?.streamAnswerText?.(remaining)
              }
            }
            break

          case "run_end":
            const outcome = evt.data.outcome
            if (outcome?.status === "completed") {
              const finalTurnNumber = ensureTurnNumber(
                agentContext.turnCount ?? currentTurn
              )
              await runAndBroadcastReview(
                {
                  focus: "run_end",
                  turnNumber: finalTurnNumber,
                  contextFragments: agentContext.contextFragments,
                  toolCallHistory: agentContext.toolCallHistory,
                  plan: agentContext.plan,
                  expectedResults:
                    expectationHistory.get(finalTurnNumber) || [],
                },
                finalTurnNumber
              )
              runCompleted = true
              break
            }
            if (outcome?.status === "error") {
              const err = outcome.error
              runFailedMessage =
                err?._tag === "MaxTurnsExceeded"
                  ? `Max turns exceeded: ${err.turns}`
                  : "Execution error"
              break
            }
            break
        }

        if (runCompleted || runFailedMessage) {
          break
        }
      }
    } catch (error) {
      logger.error(error, "[DelegatedAgenticRun] Stream processing failed")
      return {
        result: "Agent execution failed",
        error: getErrorMessage(error),
        metadata: { agentId: params.agentId, parentTurn: params.parentTurn },
      }
    }

    if (runFailedMessage) {
      return {
        result: "Agent execution failed",
        error: runFailedMessage,
        metadata: { agentId: params.agentId, parentTurn: params.parentTurn },
      }
    }

    if (!runCompleted) {
      return {
        result: "Agent execution did not complete",
        error: "RUN_INCOMPLETE",
        metadata: { agentId: params.agentId, parentTurn: params.parentTurn },
      }
    }

    const citations: Citation[] = []
    const imageCitations: ImageCitation[] = []
    const yieldedCitations = new Set<number>()
    const yieldedImageCitations = new Map<number, Set<number>>()

    const answerForCitations =
      answer.trim().length > 0
        ? answer
        : agentContext.finalSynthesis.streamedText || ""

    if (answerForCitations) {
      for await (const event of checkAndYieldCitationsForAgent(
        answerForCitations,
        yieldedCitations,
        agentContext.contextFragments,
        yieldedImageCitations,
        params.userEmail
      )) {
        if (event.citation) {
          citations.push(event.citation.item)
        }
        if (event.imageCitation) {
          imageCitations.push(event.imageCitation)
        }
      }
    }

    const finalAnswer =
      answerForCitations || "Agent did not return any text."

    return {
      result: finalAnswer,
      contexts: agentContext.contextFragments,
      metadata: {
        agentId: params.agentId,
        citations,
        imageCitations,
        cost: agentContext.totalCost,
        tokensUsed:
          agentContext.tokenUsage.input + agentContext.tokenUsage.output,
        parentTurn: params.parentTurn,
      },
    }
  } catch (error) {
    logger.error(error, "[DelegatedAgenticRun] Failed to execute agent")
    return {
      result: "Agent execution threw an exception",
      error: getErrorMessage(error),
      metadata: {
        agentId: params.agentId,
        parentTurn: params.parentTurn,
      },
    }
  }
}

type ExecuteMcpAgentOptions = {
  mcpAgents?: MCPVirtualAgentRuntime[]
  maxTokens?: number
  parentTurn?: number
  userEmail: string
}

async function executeMcpAgent(
  agentId: string,
  query: string,
  options: ExecuteMcpAgentOptions
): Promise<ToolOutput> {
  const connectorId = agentId.replace(/^mcp:/, "")
  const mcpAgent = options.mcpAgents?.find(
    (agent) => agent.agentId === agentId || agent.connectorId === connectorId
  )
  if (!mcpAgent) {
    return {
      result: "MCP agent not available for this request",
      error: "UNKNOWN_MCP_AGENT",
      metadata: { agentId },
    }
  }
  if (!mcpAgent.client) {
    return {
      result: "MCP agent client is not initialized",
      error: "MCP_CLIENT_UNAVAILABLE",
      metadata: { agentId },
    }
  }

  const modelId = (defaultFastModel as Models) || (defaultBestModel as Models)
  const toolList = mcpAgent.tools
    .map(
      (tool, idx) =>
        `${idx + 1}. ${tool.toolName} - ${tool.description ?? "No description provided"}`
    )
    .join("\n")

  const systemPrompt = [
    "You are orchestrating MCP tools to satisfy the user query.",
    "Return strict JSON: {tools:[{toolName, arguments, rationale}, ...]}.",
    "Include at least one tool; order by execution priority; keep arguments concise and schema-aligned.",
    "If absolutely unable to structure an array, fall back to a single object, but prefer the array shape.",
  ].join(" ")

  const payload = [
    `User query:\n${query}`,
    `Available MCP tools (${mcpAgent.tools.length}):\n${toolList}`,
    options.parentTurn !== undefined
      ? `Parent turn number: ${options.parentTurn}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  let selectedToolName = mcpAgent.tools[0]?.toolName
  let selectedArgs: Record<string, unknown> = {}
  let selectionRationale = "Heuristic default selection."
  let selectedToolsArray:
    | Array<{ toolName: string; arguments?: Record<string, unknown>; rationale?: string }>
    | null = null

  try {
    const provider = getProviderByModel(modelId)
    const messages: Message[] = [
      {
        role: ConversationRole.USER,
        content: [{ text: payload }],
      },
    ]
    const modelParams: ModelParams = {
      modelId,
      json: true,
      stream: false,
      temperature: 0,
      maxTokens: Math.min(options.maxTokens ?? 800, 1200),
      systemPrompt,
    }
    const toolSchema = {
      name: "select_mcp_tools",
      description: "Select and parametrize MCP tools to satisfy the query",
      parameters: {
        type: "object",
        properties: {
          tools: {
            type: "array",
            items: {
              type: "object",
              properties: {
                toolName: { type: "string" },
                arguments: { type: "object" },
                rationale: { type: "string" },
              },
              required: ["toolName", "arguments"],
            },
          },
        },
        required: ["tools"],
      },
    }

    const selectionResponse = await provider.converse(messages, {
      ...modelParams,
      tools: [toolSchema],
      tool_choice: "select_mcp_tools",
    })

    const calls =
      selectionResponse.toolCalls && Array.isArray(selectionResponse.toolCalls)
        ? selectionResponse.toolCalls.map((tc: any) => ({
            toolName:
              tc.name ??
              tc.function?.name ??
              (typeof tc.toolName === "string" ? tc.toolName : undefined),
            arguments: (() => {
              const rawArgs =
                tc.arguments ??
                tc.function?.arguments ??
                (typeof tc.args === "string" ? tc.args : "{}")
              if (typeof rawArgs === "object" && rawArgs !== null) {
                return rawArgs as Record<string, unknown>
              }
              if (typeof rawArgs === "string") {
                try {
                  return JSON.parse(rawArgs)
                } catch {
                  return {}
                }
              }
              return {}
            })(),
            rationale:
              tc.rationale ??
              (typeof tc.reason === "string" ? tc.reason : undefined),
          }))
        : null

    if (calls && calls.length > 0) {
      selectedToolsArray = calls
      selectedToolName = calls[0].toolName
      selectedArgs = calls[0].arguments ?? {}
      selectionRationale =
        calls[0].rationale ?? "LLM selected tool without rationale."
    }
  } catch (error) {
    Logger.warn(
      { err: error, agentId },
      "[MCP Agent] Tool selection failed; falling back to heuristic",
    )
  }

  const chosenTool = mcpAgent.tools.find(
    (tool) => tool.toolName === selectedToolName,
  )
  if (!chosenTool) {
    return {
      result: `Chosen tool '${selectedToolName}' is not available for this MCP agent.`,
      error: "MCP_TOOL_NOT_FOUND",
      metadata: { agentId, connectorId },
    }
  }

  try {
    const executions: Array<{
      toolName: string
      arguments: Record<string, unknown>
      result: unknown
      rationale?: string
    }> = []

    const availableTools = new Map<string, MCPToolDefinition>()
    mcpAgent.tools.forEach((t) => availableTools.set(t.toolName, t))

    const executionListRaw =
      selectedToolsArray && selectedToolsArray.length > 0
        ? selectedToolsArray
        : [
            {
              toolName: selectedToolName,
              arguments: selectedArgs,
              rationale: selectionRationale,
            },
          ]

    const executionList = executionListRaw
      .filter((entry) => availableTools.has(entry.toolName))
      .map((entry) => ({
        toolName: entry.toolName,
        arguments: entry.arguments || {},
        rationale: entry.rationale,
      }))
      .slice(0, 3) // safety cap to avoid long chains

    if (executionList.length === 0) {
      executionList.push({
        toolName: selectedToolName,
        arguments: selectedArgs,
        rationale: selectionRationale,
      })
    }

    for (const entry of executionList) {
      const raw = await mcpAgent.client.callTool({
        name: entry.toolName,
        arguments: entry.arguments,
      })
      executions.push({
        toolName: entry.toolName,
        arguments: entry.arguments || {},
        result: raw,
        rationale: entry.rationale,
      })
    }

    const formattedPieces: string[] = []
    for (const exec of executions) {
      let piece = `Tool ${exec.toolName} executed successfully.`
      try {
        const resp = exec.result as {
          content?: Array<{ text?: string }>
          data?: { contexts?: unknown }
          metadata?: { contexts?: unknown }
          contexts?: unknown
        }
        const content = resp?.content?.[0]?.text
        if (typeof content === "string" && content.trim()) {
          piece = content
        }
      } catch {
        // ignore parsing errors
      }
      formattedPieces.push(piece)
    }

    const formattedContent =
      formattedPieces.length === 1
        ? formattedPieces[0]
        : formattedPieces.join("\n\n")

    return {
      result: formattedContent,
      metadata: {
        agentId,
        connectorId,
        toolName: executions[0]?.toolName ?? selectedToolName,
        rationale: executions[0]?.rationale ?? selectionRationale,
        requestedTools: executions.map((exec) => ({
          toolName: exec.toolName,
          arguments: exec.arguments,
          rationale: exec.rationale,
        })),
        parentTurn: options.parentTurn,
      },
    }
  } catch (error) {
    return {
      result: `MCP tool '${selectedToolName}' failed`,
      error: getErrorMessage(error),
      metadata: { agentId, connectorId, toolName: selectedToolName },
    }
  }
}

type AgentBrief = {
  agentId: string
  agentName: string
  description: string
  capabilities: string[]
  domains: string[]
  estimatedCost: "low" | "medium" | "high"
  averageLatency: number
  isPublic: boolean
  resourceAccess?: ResourceAccessSummary[]
}

function buildAgentBrief(
  agent: any,
  resourceAccess?: ResourceAccessSummary[]
): AgentBrief {
  const integrations = extractIntegrationKeys(agent.appIntegrations)
  const domains = deriveDomainsFromIntegrations(integrations)
  const capabilities = integrations.length ? integrations : domains
  return {
    agentId: agent.externalId,
    agentName: agent.name,
    description: agent.description || "",
    capabilities,
    domains,
    estimatedCost: agent.allowWebSearch ? "high" : "medium",
    averageLatency: 4500,
    isPublic: agent.isPublic,
    resourceAccess,
  }
}

function extractIntegrationKeys(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry))
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
  }
  return []
}

function deriveDomainsFromIntegrations(integrations: string[]): string[] {
  if (!integrations.length) return ["generic"]
  return integrations.map((integration) => integration.toLowerCase())
}

function formatAgentBriefsForPrompt(briefs: AgentBrief[]): string {
  return briefs
    .map(
      (brief, idx) =>
        `${idx + 1}. ${brief.agentName} (${brief.agentId})
Description: ${brief.description || "N/A"}
Capabilities: ${brief.capabilities.join(", ") || "N/A"}
Domains: ${brief.domains.join(", ")}
Estimated cost: ${brief.estimatedCost}
Resource readiness: ${summarizeResourceAccess(brief.resourceAccess)}`
    )
    .join("\n\n")
}

function summarizeResourceAccess(
  resourceAccess?: ResourceAccessSummary[]
): string {
  if (!resourceAccess || resourceAccess.length === 0) {
    return "unknown"
  }
  return resourceAccess
    .map((entry) => {
      const detailParts: string[] = []
      if (entry.availableItems?.length) {
        detailParts.push(`${entry.availableItems.length} ok`)
      }
      if (entry.missingItems?.length) {
        detailParts.push(`${entry.missingItems.length} blocked`)
      }
      if (entry.note && detailParts.length === 0) {
        detailParts.push(entry.note)
      }
      const detail =
        detailParts.length > 0 ? ` (${detailParts.join(", ")})` : ""
      return `${entry.app}:${entry.status}${detail}`
    })
    .join("; ")
}

function buildHeuristicAgentSelection(
  briefs: AgentBrief[],
  query: string,
  maxAgents: number,
  totalEvaluated: number
): ListCustomAgentsOutput {
  const tokens = query.toLowerCase().split(/\s+/)
  const scored = briefs.map((brief) => {
    const text =
      `${brief.agentName} ${brief.description} ${brief.capabilities.join(" ")}`.toLowerCase()
    const baseScore =
      tokens.reduce(
        (acc, token) => (text.includes(token) ? acc + 1 : acc),
        0
      ) / Math.max(tokens.length, 1)
    const penalty = brief.resourceAccess?.some(
      (entry) => entry.status === "missing"
    )
      ? 0.3
      : brief.resourceAccess?.some((entry) => entry.status === "partial")
        ? 0.15
        : 0
    const score = Math.max(baseScore - penalty, 0)
    return { brief, score }
  })

  const selected = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxAgents)
    .map(({ brief, score }) => ({
      agentId: brief.agentId,
      agentName: brief.agentName,
      description: brief.description,
      capabilities: brief.capabilities,
      domains: brief.domains,
      suitabilityScore: Math.min(Math.max(score, 0.2), 1),
      confidence: Math.min(Math.max(score + 0.1, 0.3), 1),
      estimatedCost: brief.estimatedCost,
      averageLatency: brief.averageLatency,
      resourceAccess: brief.resourceAccess,
    }))

  return {
    result: selected.length
      ? "Heuristic agent ranking"
      : "No high-confidence agents found heuristically",
    agents: selected.length ? selected : null,
    totalEvaluated,
  }
}
