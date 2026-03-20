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

import {
  answerContextMap,
  answerContextMapFromFragments,
  userContext,
} from "@/ai/context"
import { getModelValueFromLabel } from "@/ai/modelConfig"
import { extractBestDocumentsPrompt } from "@/ai/prompts"
import {
  extractBestDocumentIndexes,
  getProviderByModel,
  jsonParseLLMOutput,
} from "@/ai/provider"
import { type ModelParams, Models } from "@/ai/types"
import { executeAgentForWorkflowWithRag } from "@/api/agent/workflowAgentUtils"
import config from "@/config"
import {
  type SelectAgent,
  getAgentByExternalIdWithPermissionCheck,
} from "@/db/agent"
import { storeAttachmentMetadata } from "@/db/attachment"
import { getChatExternalIdsByAgentId, insertChat, updateChatByExternalIdWithAuth } from "@/db/chat"
import { insertChatTrace } from "@/db/chatTrace"
import { db } from "@/db/client"
import { getConnectorById } from "@/db/connector"
import {
  getChatMessagesWithAuth,
  insertMessage,
  updateMessage,
} from "@/db/message"
import { getUserPersonalizationByEmail } from "@/db/personalization"
import {
  ChatType,
  type InsertChat,
  type InsertMessage,
  type InternalUserWorkspace,
  type SelectChat,
  type SelectMessage,
} from "@/db/schema"
import { getToolsByConnectorId } from "@/db/tool"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getUserAccessibleAgents } from "@/db/userAgentPermission"
import { getPrecomputedDbContextIfNeeded } from "@/lib/databaseContext"
import { getLogger, getLoggerWithChild } from "@/logger"
import { expandSheetIds } from "@/search/utils"
import {
  SearchEmailThreads,
  GetDocumentsByDocIds,
  searchCollectionRAG,
  searchVespaInFiles,
} from "@/search/vespa"
import {
  type AttachmentMetadata,
  ChatSSEvents,
  DEFAULT_TEST_AGENT_ID,
  type ReasoningEventPayload,
  ReasoningEventType,
  type ReasoningStage,
  XyneTools,
} from "@/shared/types"
import { type Span, getTracer } from "@/tracer"
import { MessageRole, Subsystem, type UserMetadataType } from "@/types"
import { getErrorMessage } from "@/utils"
import { getDateForAI } from "@/utils/index"
import { parseAttachmentMetadata } from "@/utils/parseAttachment"
import { ConversationRole } from "@aws-sdk/client-bedrock-runtime"
import type { Message } from "@aws-sdk/client-bedrock-runtime"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { isCuid } from "@paralleldrive/cuid2"
import {
  Apps,
  AttachmentEntity,
  KnowledgeBaseEntity,
  SearchModes,
  type VespaSearchResult,
  type VespaSearchResults,
} from "@xyne/vespa-ts/types"
import {
  type Agent as JAFAgent,
  type Message as JAFMessage,
  type RunConfig as JAFRunConfig,
  type RunState as JAFRunState,
  type Tool,
  type ToolCall,
  ToolErrorCodes,
  ToolResponse,
  type ToolResult,
  type TraceEvent,
  generateRunId,
  generateTraceId,
  getTextContent,
  runStream,
} from "@xynehq/jaf"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import type { ZodTypeAny } from "zod"
import type {
  AgentRunContext,
  AutoReviewInput,
  CurrentTurnArtifacts,
  DocumentState,
  FinalSynthesisState,
  MCPToolDefinition,
  MCPVirtualAgentRuntime,
  PlanState,
  ReviewResult,
  SubTask,
  ToolExecutionRecord,
  ToolExecutionRecordWithResult,
  ToolExpectation,
  ToolExpectationAssignment,
  ToolFailureInfo,
  ToolRawDocument,
  RetrievalSignal,
  UnrankedFragmentWithToolContext,
} from "./agent-schemas"
import { ReviewResultSchema, ToolExpectationSchema } from "./agent-schemas"
import { isMessageAgentStopError, throwIfStopRequested } from "./agent-stop"
import { buildAgentPromptAddendum } from "./agentPromptCreation"
import { parseMessageText } from "./chat"
import { getChunkCountPerDoc } from "./chunk-selection"
import { type FinalToolsList, buildMCPJAFTools } from "./jaf-adapter"
import { logJAFTraceEvent } from "./jaf-logging"
import { makeXyneJAFProvider } from "./jaf-provider"
import {
  buildAgentSystemPromptContextBlock,
  enforceMetadataConstraintsOnSelection,
  extractMetadataConstraintsFromUserMessage,
  formatFragmentWithMetadataForRanking,
  formatFragmentsWithMetadata,
  rankFragmentsByMetadataConstraints,
  sanitizeAgentSystemPromptSnapshot,
  withAgentSystemPromptMessage,
} from "./message-agents-metadata"
import {
  ReasoningSteps,
  type ReasoningEmitter as StructuredReasoningEmitter,
  emitReasoningEvent,
} from "./reasoning-steps"
import {
  type UserConnectorState,
  createEmptyConnectorState,
  evaluateAgentResourceAccess,
  getUserConnectorState,
} from "./resource-access"
import { activeStreams } from "./stream"
import { ToolCooldownManager } from "./tool-cooldown"
import {
  type ListCustomAgentsOutput,
  ListCustomAgentsOutputSchema,
  type ResourceAccessSummary,
  TOOL_SCHEMAS,
  type ToolOutput,
  generateToolDescriptions,
  validateToolInput,
} from "./tool-schemas"
import { fallbackTool, searchGlobalTool } from "./tools/global"
import googleTools from "./tools/google"
import {
  lsKnowledgeBaseTool,
  searchKnowledgeBaseTool,
} from "./tools/knowledgeBaseFlow"
import { getSlackRelatedMessagesTool } from "./tools/slack/getSlackMessages"
import {
  formatSearchToolResponseAsRawDocuments,
  parseAgentAppIntegrations,
} from "./tools/utils"
import {
  documentMemoryToRawDocuments,
  chunkKeyFromContent,
  createDocumentState,
  getFragmentsForSynthesis,
  getFragmentsForSynthesisForDocs,
  getDocsWithSignalsInTurnRange,
  getAllImagesFromDocumentMemory,
  mergeDocumentStatesIntoDocumentMemory,
  mergeRawDocumentsIntoDocumentMemory,
} from "./document-memory"
import type { Citation, FragmentImageReference, ImageCitation, MinimalAgentFragment } from "./types"
import {
  checkAndYieldCitationsForAgent,
  collectReferencedFileIdsUntilCompaction,
  extractFileIdsFromMessage,
  isMessageWithContext,
  getFragmentDedupKey,
  processMessage,
  processThreadResults,
  safeDecodeURIComponent,
  searchToCitation,
} from "./utils"
import { retrieveEpisodicMemories } from "@/services/episodicMemoryRetriever"
import { retrieveRelevantChatHistory } from "@/services/chatMemoryRetriever"
import { searchChatHistoryTool } from "./tools/chatMemory"
import { maybeCompactAndIndex } from "@/services/chatMemoryIndexer"
import { runTurnEndPipeline } from "./turn-lifecycle"

export { __messageAgentsMetadataInternals } from "./message-agents-metadata"

const {
  defaultBestModel,
  defaultBestModelAgenticMode,
  defaultFastModel,
  JwtPayloadKey,
  IMAGE_CONTEXT_CONFIG,
} = config

const Logger = getLogger(Subsystem.Chat)
const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

const MIN_TURN_NUMBER = 0

// when true we do fragments ranking and filtering with llm call
const USE_AGENTIC_FILTERING = config.useAgenticFiltering ?? true

const DEFAULT_REVIEW_FREQUENCY = 5
const MIN_REVIEW_FREQUENCY = 1
const MAX_REVIEW_FREQUENCY = 50

function normalizeReviewFrequency(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < MIN_REVIEW_FREQUENCY) {
    return DEFAULT_REVIEW_FREQUENCY
  }
  return Math.min(MAX_REVIEW_FREQUENCY, Math.floor(n))
}

const mutableAgentContext = (
  context: Readonly<AgentRunContext>,
): AgentRunContext => context as AgentRunContext

const createEmptyTurnArtifacts = (): CurrentTurnArtifacts => ({
  expectations: [],
  toolOutputs: [],
  syntheticDocs: [],
  executionToolsCalled: 0,
  todoWriteCalled: false,
  turnStartedAt: Date.now(),
})

function mergeToolOutputsIntoCurrentTurnMemory(
  context: AgentRunContext,
  turnNumber: number,
): void {
  // Rebuild current-turn memory from buffered tool outputs to avoid races
  // while tools execute in parallel.
  context.currentTurnDocumentMemory = new Map<string, DocumentState>()

  for (const output of context.currentTurnArtifacts.toolOutputs) {
    const raw = output.rawDocuments
    if (!raw || raw.length === 0) continue
    mergeRawDocumentsIntoDocumentMemory(
      context.currentTurnDocumentMemory,
      raw,
      turnNumber,
      output.query ?? "",
      output.toolName,
    )
  }

  if (context.currentTurnArtifacts.syntheticDocs.length > 0) {
    mergeDocumentStatesIntoDocumentMemory(
      context.currentTurnDocumentMemory,
      context.currentTurnArtifacts.syntheticDocs,
      turnNumber,
    )
  }
}

const reviewsAllowed = (context: AgentRunContext): boolean =>
  !context.review.lockedByFinalSynthesis

function resolveAgenticModelId(requestedModelId?: string | Models): Models {
  const hasAgenticOverride =
    defaultBestModelAgenticMode &&
    defaultBestModelAgenticMode !== ("" as Models)
  const fallback = hasAgenticOverride
    ? (defaultBestModelAgenticMode as Models)
    : (defaultBestModel as Models)
  const normalized = (requestedModelId as Models) || fallback
  return normalized
}

const toToolParameters = (
  schema: ZodTypeAny,
): Tool<unknown, AgentRunContext>["schema"]["parameters"] =>
  schema as unknown as Tool<unknown, AgentRunContext>["schema"]["parameters"]

function fragmentsToToolContexts(
  fragments: MinimalAgentFragment[] | undefined,
): ToolOutput["contexts"] {
  if (!fragments?.length) {
    return undefined
  }
  return fragments.map((fragment) => {
    const source = fragment.source || ({} as Citation)
    return {
      id: fragment.id,
      content: fragment.content,
      source: {
        ...source,
        docId: source.docId,
        title: source.title ?? "Untitled",
        url: source.url ?? "",
      },
      confidence: fragment.confidence,
    }
  })
}

type ToolCallReference = ToolCall | { id?: string | number | null }

// ReasoningEmitter and helpers are now imported from ./reasoning-steps
// The old ReasoningPayload / ReasoningEmitter / toUserFriendlyReasoningStep /
// getToolIntentLabel / getToolResultLabel / streamReasoningStep are all removed.
// Use emitReasoningEvent(emitter, ReasoningSteps.xxx(...)) instead.

/** Internal alias so the SSE-level emitter can still use the structured type */
type ReasoningEmitter = StructuredReasoningEmitter

function truncateValue(value: string, maxLength = 160): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1)}…`
}

function normalizeUserMessageForHistory(message: SelectMessage): string {
  const fileIds = Array.isArray(message?.fileIds) ? message.fileIds : []
  if (
    message.messageRole !== MessageRole.User ||
    !fileIds.length ||
    !message.message.startsWith("[{")
  ) {
    return message.message
  }

  try {
    const parsed = JSON.parse(message.message)
    if (!Array.isArray(parsed)) {
      return message.message
    }
    return parsed
      .map((item) => {
        if (item?.type === "text") {
          return `${item?.value ?? ""} `
        }
        if (item?.type === "pill") {
          const title = item?.value?.title ?? "Unknown file"
          return `<User referred a file with title "${title}" here> `
        }
        if (item?.type === "link") {
          return "<User added a link with url here, this url's content is already available to you in the prompt> "
        }
        return ""
      })
      .join("")
      .trim()
  } catch {
    return message.message
  }
}

function buildConversationHistoryForAgentRun(history: SelectMessage[]): {
  jafHistory: JAFMessage[]
  llmHistory: Message[]
} {
  const filtered = history
    .filter((msg) => !msg?.errorMessage)
    .filter(
      (msg) => !(msg.messageRole === MessageRole.Assistant && !msg.message),
    )
    .filter(
      (msg) =>
        msg.messageRole === MessageRole.User ||
        msg.messageRole === MessageRole.Assistant,
    )

  const toText = (msg: SelectMessage) => normalizeUserMessageForHistory(msg)

  return {
    jafHistory: filtered.map((msg) => ({
      role: msg.messageRole === MessageRole.Assistant ? "assistant" : "user",
      content: toText(msg),
    })),
    llmHistory: filtered.map((msg) => ({
      role:
        msg.messageRole === MessageRole.Assistant
          ? ConversationRole.ASSISTANT
          : ConversationRole.USER,
      content: [{ text: toText(msg) }],
    })),
  }
}

export const __messageAgentsHistoryInternals = {
  normalizeUserMessageForHistory,
  buildConversationHistoryForAgentRun,
}

function buildReviewSystemPrompt(options: {
  isFirstReview: boolean
  delegationNote: string
}): string {
  const firstReviewGuidance = options.isFirstReview
    ? [
        "- If prior conversation history is provided as messages, use it only for continuity, intent, and prior commitments.",
        "- If memory context appears in the user prompt, treat it as supporting context.",
        "- Prioritize current turn tool outputs, expectations, clarifications, plan state, fragments, and images over older assistant statements in conversation history.",
      ]
    : []

  return [
    "You are a senior reviewer ensuring each agentic turn honors the agreed plan and tool expectations.",
    ...firstReviewGuidance,
    "- Context fragments are incremental: you may receive only new fragments since the last review, plus a high-level previous review summary for continuity; use that summary to avoid re-evaluating already-reviewed context.",
    '- The tool call section may cover a single turn or multiple turns (e.g. "last N turns"). Inspect every tool call in that section, compare the outputs with the expected results, and decide whether each tool met or missed expectations.',
    "- Evaluate the current plan to see if it still fits the evidence gathered from the tool calls; suggest plan changes when necessary.",
    "- Detect anomalies (unexpected behaviors, contradictory data, missing outputs, or unresolved ambiguities) and call them out explicitly. If intent remains unclear, set ambiguityResolved=false and include the ambiguity notes inside the anomalies array.",
    options.delegationNote,
    `- When the available context is already relevant and sufficient and it meets all the requirement of user's ask , set planChangeNeeded=true and use planChangeReason to state that the plan should pivot toward final synthesis because the evidence is complete.`,
    '- Set recommendation to "gather_more" when required evidence or data is missing, "clarify_query" when ambiguity remains unresolved, and "replan" only when the current plan is no longer viable.',
    "- If the user asked multiple questions or sub-questions, verify that the plan or gathered evidence addresses each; report incomplete coverage in anomalies and set recommendation or planChangeNeeded as appropriate.",
    "- Always set ambiguityResolved=false whenever outstanding clarifications exist or anomalies highlight missing/contradictory information; otherwise leave it true.",
  ].join("\n")
}

export const __messageAgentsPromptInternals = {
  buildReviewSystemPrompt,
}

function normalizeExcludedIdsForLogging(excludedIds: unknown): string[] {
  if (Array.isArray(excludedIds)) {
    return excludedIds
      .map((value) =>
        typeof value === "string"
          ? value
          : value === null || value === undefined
            ? ""
            : String(value),
      )
      .filter(Boolean)
  }
  if (excludedIds === null || excludedIds === undefined) {
    return []
  }
  const normalized =
    typeof excludedIds === "string" ? excludedIds : String(excludedIds)
  return normalized ? [normalized] : []
}

function buildContextTraceSnapshot(
  context: AgentRunContext,
): Record<string, unknown> {
  return {
    chatId: context.chat.externalId,
    turnCount: context.turnCount,
    currentSubTask: context.currentSubTask,
    documentMemoryDocCount: context.documentMemory.size,
    currentTurnDocumentMemoryDocCount: context.currentTurnDocumentMemory.size,
    currentTurnToolOutputCount: context.currentTurnArtifacts.toolOutputs.length,
    currentTurnExpectationCount:
      context.currentTurnArtifacts.expectations.length,
    toolCallHistoryCount: context.toolCallHistory.length,
    failedToolsCount: context.failedTools.size,
    availableAgentsCount: context.availableAgents.length,
    usedAgentsCount: context.usedAgents.length,
    ambiguityResolved: context.ambiguityResolved,
    finalSynthesisRequested: context.finalSynthesis.requested,
    finalSynthesisCompleted: context.finalSynthesis.completed,
    finalSynthesisAckReceived: context.finalSynthesis.ackReceived,
  }
}

function logContextMutation(
  context: AgentRunContext,
  message: string,
  details: Record<string, unknown> = {},
): void {
  loggerWithChild({ email: context.user.email }).info(
    {
      ...buildContextTraceSnapshot(context),
      ...details,
    },
    message,
  )
}

function resetCurrentTurnArtifacts(context: AgentRunContext): void {
  const previousArtifacts = context.currentTurnArtifacts
  const clearedRawCount = previousArtifacts.toolOutputs.reduce(
    (sum, o) => sum + (o.rawDocuments?.length ?? 0),
    0,
  )
  const clearedSyntheticDocsCount = previousArtifacts.syntheticDocs.length
  const currentTurnDocCount = context.currentTurnDocumentMemory.size
  context.currentTurnArtifacts = createEmptyTurnArtifacts()
  context.currentTurnDocumentMemory = new Map<string, DocumentState>()
  logContextMutation(
    context,
    "[MessageAgents][Context] Reset current turn artifacts",
    {
      clearedRawCount,
      clearedSyntheticDocsCount,
      clearedExpectationCount: previousArtifacts.expectations.length,
      clearedToolOutputCount: previousArtifacts.toolOutputs.length,
      clearedCurrentTurnDocumentMemoryDocs: currentTurnDocCount,
    },
  )
}

function summarizeToolResultPayload(result: any): string {
  if (!result) {
    return "No result returned."
  }
  const summaryCandidates: Array<unknown> = [
    result?.data?.summary,
    result?.data?.result,
  ]
  for (const candidate of summaryCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return truncateValue(candidate.trim(), 200)
    }
  }
  if (typeof result?.data === "string") {
    return truncateValue(result.data, 200)
  }
  try {
    return truncateValue(JSON.stringify(result?.data ?? result), 200)
  } catch {
    return "Result unavailable."
  }
}

function formatToolArgumentsForReasoning(
  args: Record<string, unknown>,
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
  records: ToolExecutionRecord[],
): string {
  const lines = records.map((record, idx) => {
    const argsSummary = formatToolArgumentsForReasoning(record.arguments)
    return `${idx + 1}. ${record.toolName} (${argsSummary})`
  })
  return `Tools executed in turn ${turnNumber}:\n${lines.join("\n")}`
}

function getMetadataLayers(result: any): Record<string, unknown>[] {
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
  key: string,
): T | undefined {
  if (result?.data && typeof result.data === "object" && key in result.data) {
    return (result.data as Record<string, unknown>)[key] as T
  }
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
      detailParts.length > 0
        ? `${baseLine}\n   ${detailParts.join(" | ")}`
        : baseLine,
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
      (task) => task.status === status && task.id,
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
    if (activeTask.status === "pending" || activeTask.status === "blocked") {
      activeTask.status = "in_progress"
      activeTask.error = undefined
    }
    break
  }
  return activeId ?? null
}

/**
 * Extract a human-readable query string from tool arguments to surface in the
 * reasoning UI alongside each tool call.  Returns undefined for tools that have
 * no meaningful search term (e.g. synthesizeFinalAnswer, toDoWrite).
 */
function extractToolQuery(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  switch (toolName) {
    case XyneTools.searchGlobal:
    case XyneTools.searchGmail:
    case XyneTools.searchDriveFiles:
    case XyneTools.searchCalendarEvents:
    case XyneTools.searchGoogleContacts:
    case XyneTools.searchKnowledgeBase:
    case XyneTools.listCustomAgents:
    case XyneTools.runPublicAgent:
      return typeof args.query === "string" && args.query.trim()
        ? args.query.trim()
        : undefined
    case XyneTools.getSlackRelatedMessages:
    case XyneTools.getSlackThreads:
      return typeof args.filter_query === "string" && args.filter_query.trim()
        ? args.filter_query.trim()
        : typeof args.channel_name === "string" && args.channel_name.trim()
          ? `#${args.channel_name.trim()}`
          : typeof args.user_email === "string" && args.user_email.trim()
            ? args.user_email.trim()
            : undefined
    case XyneTools.getSlackUserProfile:
      return typeof args.user_email === "string" && args.user_email.trim()
        ? args.user_email.trim()
        : undefined
    default:
      return undefined
  }
}

/**
 * Persists an error message to the user message row so the frontend can display it
 * (e.g. from the user message's errorMessage property). Swallows DB errors and logs
 * with contextDescription so the original error handling can continue.
 */
async function persistErrorToUserMessage(
  db: Parameters<typeof updateMessage>[0],
  userMessageExternalId: string,
  errorMessage: string,
  email: string,
  contextDescription: string,
): Promise<void> {
  if (!userMessageExternalId) return
  try {
    await updateMessage(db, userMessageExternalId, { errorMessage })
  } catch (updateErr) {
    loggerWithChild({ email }).warn(
      updateErr,
      `Failed to persist error to user message (${contextDescription})`,
    )
  }
}

type PersistAssistantMessageContext = {
  chatRecord: SelectChat
  user: { id: number; email: string }
  workspace: { externalId: string }
  agenticModelId: string
  totalCost: number
  tokenUsage: { input: number; output: number }
  requestStartMs: number
}

type PersistAssistantMessageData = {
  answer: string
  citations: Citation[]
  imageCitations: ImageCitation[]
  citationMap: Record<number, number>
  thinkingLog: string
}

/**
 * Inserts an assistant message and persists trace. Shared by tool_call_end
 * (synthesizeFinalAnswer) and run_end (direct-answer path). Caller is responsible
 * for updating lastPersistedMessageId, lastPersistedMessageExternalId, and
 * assistantMessageId, and for sending SSE (ResponseMetadata, End) if needed.
 */
async function persistAssistantMessage(
  db: Parameters<typeof insertMessage>[0],
  context: PersistAssistantMessageContext,
  data: PersistAssistantMessageData,
  persistTrace: (messageId: number, messageExternalId: string) => Promise<void>,
): Promise<{ msg: SelectMessage; assistantMessageId: string }> {
  const timeTakenMs = Date.now() - context.requestStartMs
  const assistantInsert = {
    chatId: context.chatRecord.id,
    userId: context.user.id,
    workspaceExternalId: String(context.workspace.externalId),
    chatExternalId: String(context.chatRecord.externalId),
    messageRole: MessageRole.Assistant,
    email: context.user.email,
    sources: data.citations,
    imageCitations: data.imageCitations,
    message: processMessage(data.answer, data.citationMap),
    thinking: data.thinkingLog,
    modelId: context.agenticModelId,
    cost: context.totalCost.toString(),
    tokensUsed: context.tokenUsage.input + context.tokenUsage.output,
    timeTakenMs,
  } as unknown as Omit<InsertMessage, "externalId">
  const msg = await insertMessage(db, assistantInsert)
  await persistTrace(msg.id as number, msg.externalId)
  return { msg, assistantMessageId: String(msg.externalId) }
}

function formatClarificationsForPrompt(
  clarifications: AgentRunContext["clarifications"],
): string {
  if (!clarifications?.length) return ""
  const formatted = clarifications
    .map(
      (clarification, idx) =>
        `${idx + 1}. Q: ${clarification.question}\n   A: ${clarification.answer}`,
    )
    .join("\n")
  return formatted
}

type FinalSynthesisBuildOptions = {
  fragmentsLimit?: number
  insightsUsefulForAnswering?: string
}

function sanitizeInsightsUsefulForAnswering(
  insightsUsefulForAnswering?: string,
): string | undefined {
  const trimmed = insightsUsefulForAnswering?.trim()
  return trimmed ? trimmed : undefined
}

function sanitizeChatMemoryForLLMContext(
  chatMemoryText?: string,
): string | undefined {
  if (!chatMemoryText?.trim()) return undefined
  const sanitized = chatMemoryText
    .split("\n")
    .filter(
      (line) => !line.trimStart().startsWith("Assistant thinking:"),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return sanitized ? sanitized : undefined
}

function buildLLMMemoryContextSection(
  context: AgentRunContext,
): string {
  const parts: string[] = []
  if (context.episodicMemoriesText?.trim()) {
    parts.push(`Relevant Past Experiences:\n${context.episodicMemoriesText}`)
  }
  const sanitizedChatMemory = sanitizeChatMemoryForLLMContext(
    context.chatMemoryText,
  )
  if (sanitizedChatMemory) {
    parts.push(`Retrieved Chat Memory:\n${sanitizedChatMemory}`)
  }
  if (!parts.length) return ""
  return `Memory Context:\n${parts.join("\n\n")}`
}

export async function buildFinalSynthesisPayload(
  context: AgentRunContext,
  options?: FinalSynthesisBuildOptions,
): Promise<{ systemPrompt: string; userMessage: string }> {
  const fragments = await getFragmentsForSynthesis(context.documentMemory, {
    email: context.user.email,
    userId: context.user.numericId ?? undefined,
    workspaceId: context.user.workspaceNumericId ?? undefined,
  })
  const agentSystemPromptBlock = buildAgentSystemPromptContextBlock(
    context.dedicatedAgentSystemPrompt,
  )
  const agentSystemPromptSection = agentSystemPromptBlock
    ? `Agent System Prompt Context:\n${agentSystemPromptBlock}`
    : ""
  const formattedFragments = formatFragmentsWithMetadata(
    fragments,
  )
  const fragmentsSection = formattedFragments
    ? `Context Fragments:\n${formattedFragments}`
    : ""
  const planSection = formatPlanForPrompt(context.plan)
  const clarificationSection = formatClarificationsForPrompt(
    context.clarifications,
  )
  const workspaceSection = context.userContext?.trim()
    ? `Workspace Context:\n${context.userContext}`
    : ""
  const memorySection = buildLLMMemoryContextSection(context)
  const sanitizedInsights = sanitizeInsightsUsefulForAnswering(
    options?.insightsUsefulForAnswering,
  )
  const insightsSection = sanitizedInsights
    ? `Agent Insights for Final Answer:\n${sanitizedInsights}`
    : ""

  const parts = [
    `User Question:\n${context.message.text}`,
    agentSystemPromptSection,
    planSection ? `Execution Plan Snapshot:\n${planSection}` : "",
    clarificationSection
      ? `Clarifications Resolved:\n${clarificationSection}`
      : "",
    workspaceSection,
    memorySection,
    insightsSection,
    fragmentsSection,
  ].filter(Boolean)

  const userMessage = parts.join("\n\n")

  const systemPrompt = `
### Mission
- Deliver the user's final answer using the prior conversation history provided as messages, the plan snapshot, clarifications, workspace context, memory context, context fragments, and supplied images; never plan or call tools.

### Evidence Intake
- Use prior conversation history for continuity, user intent, and prior commitments, but do not let earlier assistant statements override newer evidence.
- When sources conflict, prioritize the current request, resolved clarifications, workspace context, memory context, context fragments, and images over earlier assistant statements in conversation history.
- Prioritize the highest-signal fragments, but pull any supporting fragment that improves accuracy.
- Only draw on context that directly answers the user's question; ignore unrelated fragments even if they were retrieved earlier.
- Treat delegated-agent outputs as citeable fragments; reference them like any other context entry.
- Describe evidence gaps plainly before concluding; never guess.
- Extract actionable details from provided images and cite them via their fragment indices.
- Respect user-imposed constraints using fragment metadata (any metadata field). If compliant evidence is missing, state that clearly.
- Treat "Agent Insights for Final Answer" as important agent-provided context that may include material information not repeated elsewhere. Consider it seriously, use it when consistent with the broader evidence, and note any unsupported or conflicting points explicitly
- If "This is the system prompt of agent:" is present, analyse for instructions relevant for answering and strictly bind by them .

### Response Construction
- Lead with the conclusion, then stack proof underneath.
- Organize output into tight sections (e.g., **Summary**, **Proof**, **Next Steps** when relevant); omit empty sections.
- Never mention internal tooling, planning logs, or this synthesis process.

### Constraint Handling
- When the user asks for an action the system cannot execute (e.g., sending an email), deliver the closest actionable substitute (draft, checklist, explicit next steps) inside the answer.
- Pair the substitute with a concise explanation of the limitation and the manual action the user must take.

### File & Chunk Formatting (CRITICAL)
- Each file starts with a header line exactly like:
  index {docId} {file context begins here...}
- \`docId\` is a unique identifier for that file (e.g., 0, 1, 2, etc.).
- Inside the file context, text is split into chunks.
- Each chunk might begin with a bracketed numeric index, e.g.: [0], [1], [2], etc.
- This is the chunk index within that file, if it exists.

### Guidelines for Response
1. Data Interpretation:
   - Use ONLY the provided files and their chunks as your knowledge base.
   - Treat every file header \`index {docId} ...\` as the start of a new document.
   - Treat every bracketed number like [0], [1], [2] as the authoritative chunk index within that document.
   - If dates exist, interpret them relative to the user's timezone when paraphrasing.
2. Response Structure:
   - Start with the most relevant facts from the chunks across files.
   - Keep order chronological when it helps comprehension.
   - Every factual statement MUST cite the exact chunk it came from using the format:
     K[docId_chunkIndex]
     where:
       - \`docId\` is taken from the file header line ("index {docId} ...").
       - \`chunkIndex\` is the bracketed number prefixed on that chunk within the same file.
   - Examples:
     - Single citation: "X is true K[12_3]."
     - Two citations in one sentence (from different files or chunks): "X K[12_3] and Y K[7_0]."
   - Use at most 1-2 citations per sentence; NEVER add more than 2 for one sentence.
3. Citation Rules (DOCUMENT+CHUNK LEVEL ONLY):
   - ALWAYS cite at the chunk level with the K[docId_chunkIndex] format.
   - Every chunk level citation must start with the K prefix eg. K[12_3] K[7_0] correct, but K[12_3] [7_0] is incorrect.
   - Place the citation immediately after the relevant claim.
   - Do NOT group indices inside one set of brackets (WRONG: "K[12_3,7_1]").
   - If a sentence draws on two distinct chunks (possibly from different files), include two separate citations inline, e.g., "... K[12_3] ... K[7_1]".
   - Only cite information that appears verbatim or is directly inferable from the cited chunk.
   - If you cannot ground a claim to a specific chunk, do not make the claim.
4. Quality Assurance:
   - Cross-check across multiple chunks/files when available and briefly note inconsistencies if they exist.
   - Keep tone professional and concise.
   - Acknowledge gaps if the provided chunks don't contain enough detail.

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

export async function buildFinalSynthesisRequest(
  context: AgentRunContext,
  options?: FinalSynthesisBuildOptions,
): Promise<{
  systemPrompt: string
  userMessage: string
  finalUserPrompt: string
  messages: Message[]
}> {
  const { systemPrompt, userMessage } = await buildFinalSynthesisPayload(
    context,
    options,
  )
  const finalUserPrompt = `${userMessage}\n\nSynthesize the final answer using the evidence above.`
  const messages: Message[] = [
    ...context.conversationHistoryMessages,
    {
      role: ConversationRole.USER,
      content: [{ text: finalUserPrompt }],
    },
  ]
  return {
    systemPrompt,
    userMessage,
    finalUserPrompt,
    messages,
  }
}

/** Synthetic tool name for initial memory context (episodic + chat memory). */
const INITIAL_TOOL_MESSAGE = "getChatMemory"
/** Synthetic tool name for attachment fragments context. */
const ATTACHMENT_TOOL_MESSAGE = "getAttachmentContent"

/**
 * Builds a synthetic assistant tool-call message so the JAF prompt builder can
 * include the corresponding tool result (role="tool") as a proper
 * OpenAI-style tool-result part.
 */
function buildSyntheticAssistantToolCallMessage(args: {
  toolCallId: string
  toolName: string
  // Keep runtime OpenAI-compatible JSON for tool-call arguments.
  // JAF type definitions in this repo expect `function.arguments` to be a string.
  arguments: unknown
}): JAFMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: args.toolCallId,
        type: "function",
        function: {
          name: args.toolName,
          // JAF expects stringified JSON for tool-call arguments (OpenAI-style).
          arguments: JSON.stringify(args.arguments as any),
        },
      },
    ],
  }
}

/**
 * Builds a synthetic tool-result message for memory context (episodic + chat memory).
 * Model receives this as low-privilege tool output, not system instructions.
 */
function buildInitialToolMessage(options: {
  episodicMemoriesText?: string
  chatMemoryText?: string
  toolCallId: string
}): JAFMessage | null {
  const parts: string[] = []
  if (options.episodicMemoriesText?.trim()) {
    parts.push(
      "## Relevant Past Experiences\n",
      options.episodicMemoriesText.trim(),
      "\nTo search within a past experience, use searchChatHistory with the chatId shown for that experience.\n",
    )
  }
  if (options.chatMemoryText?.trim()) {
    parts.push("## Earlier Conversation Context\n", options.chatMemoryText.trim(), "\n")
  }
  if (parts.length === 0) return null
  const content = parts.join("")
  const resultPayload = ToolResponse.success({ content })
  const envelope = {
    status: "executed",
    result: JSON.stringify(resultPayload),
    tool_name: INITIAL_TOOL_MESSAGE,
    message: "Memory context prepared.",
  }
  return {
    role: "tool",
    tool_call_id: options.toolCallId,
    content: JSON.stringify(envelope),
  }
}

/**
 * Builds a synthetic tool-result message for attachment context.
 * Fragments are built from document memory (after raw docs are merged) so the model receives
 * the same fragment shape as other tool results.
 */
function buildAttachmentToolMessage(
  fragments: MinimalAgentFragment[],
  summary: string,
  toolCallId: string,
): JAFMessage {
  const resultPayload = ToolResponse.success({
    summary:
      summary ||
      "Attachment content retrieved and ready for answering the user query. Use these fragments directly; no further retrieval is needed unless they are irrelevant.",
    fragments,
  })
  const envelope = {
    status: "executed",
    result: JSON.stringify(resultPayload),
    tool_name: ATTACHMENT_TOOL_MESSAGE,
    message: "Attachment context prepared.",
  }
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify(envelope),
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
    dedicatedAgentSystemPrompt?: string
    workspaceNumericId?: number
    chatId?: number
    stopController?: AbortController
    stopSignal?: AbortSignal
    modelId?: string
  },
): AgentRunContext {
  const finalSynthesis: FinalSynthesisState = {
    requested: false,
    completed: false,
    suppressAssistantStreaming: false,
    streamedText: "",
    ackReceived: false,
  }
  const currentTurnArtifacts = createEmptyTurnArtifacts()
  const context: AgentRunContext = {
    user: {
      email: userEmail,
      workspaceId,
      id: String(userId),
      numericId: userId,
      workspaceNumericId: options?.workspaceNumericId,
    },
    chat: {
      id: options?.chatId,
      externalId: chatExternalId,
      metadata: {},
    },
    message: {
      text: messageText,
      attachments,
      timestamp: new Date().toISOString(),
    },
    modelId: options?.modelId,
    plan: null,
    currentSubTask: null,
    userContext: options?.userContext ?? "",
    agentPrompt: options?.agentPrompt,
    dedicatedAgentSystemPrompt: options?.dedicatedAgentSystemPrompt,
    conversationHistoryMessages: [],
    episodicMemoriesText: undefined,
    chatMemoryText: undefined,
    clarifications: [],
    ambiguityResolved: false,
    toolCallHistory: [],
    documentMemory: new Map(),
    currentTurnDocumentMemory: new Map(),
    turnRankedCount: new Map(),
    turnNewChunksCount: new Map(),
    currentTurnArtifacts,
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
      lastReviewedFragmentIndex: 0,
      lastReviewResult: null,
      outstandingAnomalies: [],
      clarificationQuestions: [],
      lockedByFinalSynthesis: false,
      lockedAtTurn: null,
      cachedPlanSummary: undefined,
      cachedContextSummary: undefined,
    },
    decisions: [],
    finalSynthesis,
    runtime: undefined,
    maxOutputTokens: undefined,
    stopController: options?.stopController,
    stopSignal: options?.stopController?.signal ?? options?.stopSignal,
    stopRequested:
      options?.stopController?.signal?.aborted ??
      options?.stopSignal?.aborted ??
      false,
  }
  logContextMutation(
    context,
    "[MessageAgents][Context] Initialized agent context",
    {
      attachmentCount: attachments.length,
      attachmentIds: attachments.map((attachment) => attachment.fileId),
      hasAgentPrompt: !!options?.agentPrompt,
      hasDedicatedAgentSystemPrompt: !!options?.dedicatedAgentSystemPrompt,
      modelId: options?.modelId,
    },
  )
  return context
}

/**
 * Perform automatic turn-end review (STUB for now)
 * Called deterministically after every turn
 */
async function performAutomaticReview(
  input: AutoReviewInput,
  fullContext: AgentRunContext,
): Promise<ReviewResult> {
  const reviewContext: AgentRunContext = {
    ...fullContext,
    toolCallHistory: input.toolCallHistory,
    plan: input.plan,
  }
  const tripReviewSpan = getTracer("chat").startSpan("auto_review")
  tripReviewSpan.setAttribute("focus", input.focus)
  tripReviewSpan.setAttribute("turn_number", input.turnNumber ?? -1)
  tripReviewSpan.setAttribute(
    "expected_results_count",
    input.expectedResults?.length ?? 0,
  )
  let reviewResult: ReviewResult
  try {
    reviewResult = await runReviewLLM(
      reviewContext,
      {
        focus: input.focus,
        turnNumber: input.turnNumber,
        expectedResults: input.expectedResults,
        delegationEnabled: fullContext.delegationEnabled,
      },
      fullContext.modelId,
    )
  } catch (error) {
    tripReviewSpan.setAttribute("error", true)
    tripReviewSpan.setAttribute("error_message", getErrorMessage(error))
    Logger.error(
      error,
      "Automatic review failed, falling back to default response",
    )
    reviewResult = {
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

  tripReviewSpan.setAttribute("review_status", reviewResult.status)
  tripReviewSpan.setAttribute(
    "recommendation",
    reviewResult.recommendation ?? "unknown",
  )
  tripReviewSpan.setAttribute(
    "anomalies_detected",
    reviewResult.anomaliesDetected ?? false,
  )
  tripReviewSpan.end()

  return reviewResult
}

async function handleReviewOutcome(
  context: AgentRunContext,
  reviewResult: ReviewResult,
  iteration: number,
  focus: AutoReviewInput["focus"],
  reasoningEmitter?: ReasoningEmitter,
): Promise<void> {
  context.review.lastReviewResult = reviewResult
  context.review.lastReviewTurn = iteration
  context.ambiguityResolved = reviewResult.ambiguityResolved
  context.review.outstandingAnomalies = reviewResult.anomalies?.length
    ? reviewResult.anomalies
    : []
  context.review.clarificationQuestions = reviewResult.clarificationQuestions
    ?.length
    ? reviewResult.clarificationQuestions
    : []

  const hasAnomalies =
    reviewResult.anomaliesDetected || (reviewResult.anomalies?.length ?? 0) > 0
  const recommendation = reviewResult.recommendation ?? "proceed"
  logContextMutation(
    context,
    "[MessageAgents][Context] Review outcome applied",
    {
      iteration,
      focus,
      recommendation: recommendation,
      reviewStatus: reviewResult.status,
      ambiguityResolved: reviewResult.ambiguityResolved,
      anomaliesDetected: reviewResult.anomaliesDetected,
      anomalies: context.review.outstandingAnomalies,
      clarificationQuestions: context.review.clarificationQuestions,
    },
  )

  // Always emit review complete so the user sees the time-taking step finished.
  await emitReasoningEvent(
    reasoningEmitter,
    ReasoningSteps.reviewCompleted(recommendation, iteration),
  )

  if (hasAnomalies) {
    Logger.debug(
      {
        turn: iteration,
        anomalies: reviewResult.anomalies,
        recommendation: reviewResult.recommendation,
        planChangeNeeded: reviewResult.planChangeNeeded,
        chatId: context.chat.externalId,
        focus,
      },
      "[MessageAgents][Anomalies]",
    )
    await emitReasoningEvent(
      reasoningEmitter,
      ReasoningSteps.anomaliesDetected(reviewResult.anomalies ?? [])
    )
  }
}

type AttachmentPhaseMetadata = {
  initialAttachmentPhase?: boolean
  initialAttachmentSummary?: string
}

function getAttachmentPhaseMetadata(
  context: AgentRunContext,
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
  conversationHistory: SelectMessage[]
  attachmentError?: Error
}

async function ensureChatAndPersistUserMessage(
  params: ChatBootstrapParams,
): Promise<ChatBootstrapResult> {
  const workspaceId = Number(params.workspace.id)
  const workspaceExternalId = String(params.workspace.externalId)
  const userId = Number(params.user.id)
  const userEmail = String(params.user.email)
  const incomingChatId = params.chatId ? String(params.chatId) : undefined
  let attachmentError: Error | null = null
  return await db.transaction(async (tx) => {
    if (!incomingChatId) {
      const chatInsert = {
        workspaceId,
        workspaceExternalId,
        userId,
        email: userEmail,
        title: "Untitled",
        attachments: [],
        agentId: params.agentId ?? undefined,
        chatType: ChatType.Default,
      } as unknown as Omit<InsertChat, "externalId">
      const chat = await insertChat(tx, chatInsert)

      const messageInsert = {
        chatId: chat.id,
        userId,
        workspaceExternalId,
        chatExternalId: chat.externalId,
        messageRole: MessageRole.User,
        email: userEmail,
        sources: [],
        message: params.message,
        modelId: (params.modelId as Models) || defaultBestModel,
        fileIds: params.fileIds,
      } as unknown as Omit<InsertMessage, "externalId">
      const userMessage = await insertMessage(tx, messageInsert)

      if (params.attachmentMetadata.length > 0) {
        const storageErr = await storeAttachmentSafely(
          tx,
          userEmail,
          String(userMessage.externalId),
          params.attachmentMetadata,
        )
        if (storageErr) {
          attachmentError = storageErr
        }
      }

      return {
        chat,
        userMessage,
        conversationHistory: [],
        attachmentError: attachmentError ?? undefined,
      }
    }

    const chat = await updateChatByExternalIdWithAuth(
      tx,
      String(incomingChatId),
      String(params.email),
      {},
    )
    const allMessages = await getChatMessagesWithAuth(
      tx,
      String(incomingChatId),
      String(params.email),
    )
    const conversationHistory = await maybeCompactAndIndex({
      trx: tx,
      chatId: String(incomingChatId),
      email: String(params.email),
      workspaceId: workspaceExternalId,
      allMessages,
      chatIdInternal: chat.id,
      userId,
      modelId: (params.modelId as Models) || defaultBestModel,
    })

    const messageInsert = {
      chatId: chat.id,
      userId,
      workspaceExternalId,
      chatExternalId: chat.externalId,
      messageRole: MessageRole.User,
      email: userEmail,
      sources: [],
      message: params.message,
      modelId: (params.modelId as Models) || defaultBestModel,
      fileIds: params.fileIds,
    } as unknown as Omit<InsertMessage, "externalId">
    const userMessage = await insertMessage(tx, messageInsert)

    if (params.attachmentMetadata.length > 0) {
      const storageErr = await storeAttachmentSafely(
        tx,
        userEmail,
        String(userMessage.externalId),
        params.attachmentMetadata,
      )
      if (storageErr) {
        attachmentError = storageErr
      }
    }

    return {
      chat,
      userMessage,
      conversationHistory,
      attachmentError: attachmentError ?? undefined,
    }
  })
}

async function storeAttachmentSafely(
  tx: Parameters<typeof storeAttachmentMetadata>[0],
  email: string,
  messageExternalId: string,
  attachments: AttachmentMetadata[],
): Promise<Error | null> {
  try {
    await storeAttachmentMetadata(tx, messageExternalId, attachments, email)
    return null
  } catch (error) {
    loggerWithChild({ email }).error(
      error,
      `Failed to store attachment metadata for message ${messageExternalId}`,
    )
    return error as Error
  }
}

async function prepareInitialAttachmentContext(
  fileIds: string[] = [],
  threadIds: string[],
  userMetadata: UserMetadataType,
  query: string,
  email: string,
  imageAttachmentFileIds: string[] = [],
): Promise<{ rawDocuments: ToolRawDocument[]; summary: string } | null> {
  // We support image-only requests: `fileIds` can be empty while
  // `imageAttachmentFileIds` is non-empty (images extracted from attachments).
  if ((!fileIds?.length || fileIds.length === 0) && (!imageAttachmentFileIds?.length || imageAttachmentFileIds.length === 0)) {
    return null
  }

  const queryText = parseMessageText(query)
  let userAlpha = 0.5
  try {
    const personalization = await getUserPersonalizationByEmail(db, email)
    if (personalization) {
      const nativeRankParams =
        personalization.parameters?.[SearchModes.NativeRank]
      if (nativeRankParams?.alpha !== undefined) {
        userAlpha = nativeRankParams.alpha
      }
    }
  } catch (err) {
    // proceed with default alpha
  }

  const tracer = getTracer("chat")
  const span = tracer.startSpan("prepare_initial_attachment_context")

  try {
    const combinedSearchResponse: VespaSearchResult[] = []
    const attachmentFallbackDocs: VespaSearchResult[] = []

    if (fileIds && fileIds.length > 0) {
      const fileSearchSpan = span.startSpan("file_search")
      let results
      const collectionFileIds = fileIds.filter(
        (fid) => fid.startsWith("clf-") || fid.startsWith("att_"),
      )
      const nonCollectionFileIds = fileIds.filter(
        (fid) => !fid.startsWith("clf-") && !fid.startsWith("att"),
      )
      const attachmentFileIds = fileIds.filter((fid) => fid.startsWith("attf_"))
      if (nonCollectionFileIds && nonCollectionFileIds.length > 0) {
        results = await searchVespaInFiles(
          queryText,
          email,
          nonCollectionFileIds,
          {
            limit: fileIds?.length,
            alpha: userAlpha,
            rankProfile: SearchModes.GlobalSorted,
          },
        )
        if (results.root.children) {
          combinedSearchResponse.push(...results.root.children)
        }
      }
      if (collectionFileIds && collectionFileIds.length > 0) {
        results = await searchCollectionRAG(
          queryText,
          collectionFileIds,
          undefined,
          undefined,
          undefined,
          undefined,
          SearchModes.GlobalSorted,
        )
        if (results.root.children) {
          combinedSearchResponse.push(...results.root.children)
        }
      }
      if (attachmentFileIds && attachmentFileIds.length > 0) {
        results = await searchVespaInFiles(
          queryText,
          email,
          attachmentFileIds,
          {
            limit: fileIds?.length,
            alpha: userAlpha,
            rankProfile: SearchModes.GlobalSorted,
          },
        )
        if (results.root.children && results.root.children.length > 0) {
          combinedSearchResponse.push(...results.root.children)
        } else {
          // Fallback: if Vespa search can't score attachments (or yields nothing),
          // fetch the raw attachment documents directly and treat them as equal-weight hits.
          const direct = await GetDocumentsByDocIds(
            attachmentFileIds,
            fileSearchSpan ?? span,
          )
          if (direct?.root?.children?.length) {
            attachmentFallbackDocs.push(...direct.root.children)
          }
        }
      }
      fileSearchSpan?.end()
    }
    
    if(imageAttachmentFileIds && imageAttachmentFileIds.length > 0) {
      const direct = await GetDocumentsByDocIds(
        imageAttachmentFileIds,
        span,
      )
      if (direct?.root?.children?.length) {
        attachmentFallbackDocs.push(...direct.root.children)
      }
    }

    if (threadIds && threadIds.length > 0) {
      const threadSpan = span.startSpan("fetch_email_threads")
      threadSpan.setAttribute("threadIds", JSON.stringify(threadIds))

      try {
        const threadResults = await SearchEmailThreads(threadIds, email)
        if (
          threadResults.root.children &&
          threadResults.root.children.length > 0
        ) {
          const existingDocIds = new Set(
            combinedSearchResponse.map((child: any) => child.fields.docId),
          )
          const { addedCount, threadInfo } = processThreadResults(
            threadResults.root.children,
            existingDocIds,
            combinedSearchResponse,
          )
          threadSpan.setAttribute("added_email_count", addedCount)
          threadSpan.setAttribute(
            "total_thread_emails_found",
            threadResults.root.children.length,
          )
          threadSpan.setAttribute("thread_info", JSON.stringify(threadInfo))
        }
      } catch (error) {
        loggerWithChild({ email: email }).error(
          error,
          `Error fetching email threads: ${getErrorMessage(error)}`,
        )
        threadSpan?.setAttribute("error", getErrorMessage(error))
      }

      threadSpan?.end()
    }

    let rawDocuments: ToolRawDocument[] = []
    if (combinedSearchResponse.length > 0) {
      const vespaResponse = {
        root: { children: combinedSearchResponse },
      } as Parameters<typeof formatSearchToolResponseAsRawDocuments>[0]
      rawDocuments = await formatSearchToolResponseAsRawDocuments(
        vespaResponse,
        { email },
      )
    }

    if (attachmentFallbackDocs.length > 0) {
      const existing = new Set(rawDocuments.map((d) => d.docId))
      const perDocChunkBudget = Math.max(
        1,
        Math.floor(config.maxChunksPerTool / attachmentFallbackDocs.length),
      )
      for (const doc of attachmentFallbackDocs) {
        const fields = (doc as any)?.fields
        const docId = fields?.docId
        if (!docId || existing.has(docId)) continue
        existing.add(docId)
        const citation = searchToCitation(doc as any)
        const chunksSummary: unknown[] = Array.isArray(fields?.chunks_summary)
          ? fields.chunks_summary
          : []
        const chunks = chunksSummary
          .slice(0, perDocChunkBudget)
          .map((c: any, idx: number) => ({
            chunkKey: `i:${idx}`,
            content: typeof c === "string" ? c : String(c ?? ""),
            score: 0,
          }))
          .filter((c: any) => c.content)
        rawDocuments.push({
          docId,
          relevance: 1,
          source: citation,
          chunks,
          vespaHit: doc as any,
        })
      }
    }

    const summary =
      rawDocuments.length > 0
        ? `Attachment content retrieved (${rawDocuments.length} document${
            rawDocuments.length === 1 ? "" : "s"
          }) for the first turn.`
        : "No attachment content could be retrieved for this turn; continue without attachment context."
    return { rawDocuments, summary }
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
  reasoningEmitter?: ReasoningEmitter,
): Promise<any | null> {
  const incomingExcludedIds = normalizeExcludedIdsForLogging(args?.excludedIds)
  logContextMutation(context, "[beforeToolExecutionHook] Received tool args", {
    toolName,
    args,
    incomingExcludedIds,
    incomingExcludedIdsCount: incomingExcludedIds.length,
  })
  // 0. Validate input against schema
  const validation = validateToolInput(toolName, args)
  if (!validation.success) {
    await emitReasoningEvent(
      reasoningEmitter,
      ReasoningSteps.toolValidationError(toolName, validation.error.message)
    )
    Logger.warn(
      `Tool input validation failed for ${toolName}: ${validation.error.message}`,
    )
    // Don't block - let tool handle invalid input, but log it
  }

  // 1. Duplicate detection
  const isDuplicate = context.toolCallHistory.some(
    (record) =>
      record.toolName === toolName &&
      JSON.stringify(record.arguments) === JSON.stringify(args) &&
      record.status === "success" &&
      Date.now() - record.startedAt.getTime() < 60000, // 1 minute
  )

  if (isDuplicate) {
    await emitReasoningEvent(
      reasoningEmitter,
      ReasoningSteps.toolSkippedDuplicate(toolName)
    )
    return null // Skip execution
  }

  // 2. Cooldown check — tool removed from LLM's tool list on turn_start,
  //    but this is a safety net in case it's still called mid-turn.
  const cooldownManager = new ToolCooldownManager(context.failedTools)
  if (cooldownManager.isInCooldown(toolName, context.turnCount)) {
    const info = cooldownManager.getCooldownInfo(toolName)!
    const turnsLeft = info.cooldownUntilTurn - context.turnCount
    await emitReasoningEvent(
      reasoningEmitter,
      ReasoningSteps.toolSkippedCooldown(toolName, turnsLeft)
    )
    return null // Skip execution — tool is also removed from tool list
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
  expectedResult: ToolExpectation | undefined,
  turnNumber: number,
  reasoningEmitter?: ReasoningEmitter,
): Promise<string | ToolResult | null> {
  const { state, executionTime, status, args } = hookContext
  const context = state.context as AgentRunContext

  logContextMutation(
    context,
    "[afterToolExecutionHook] Processing tool result",
    {
      toolName,
      turnNumber,
      status,
      executionTime,
      args,
      hasResult: !!result,
      resultType: result ? typeof result : "null",
      resultStatus: result?.status,
      resultError: result?.error,
      resultMetadata: result?.metadata,
      resultExcludedIds: normalizeExcludedIdsForLogging(
        result?.data?.excludedIds,
      ),
    },
  )

  // 1. Create execution record
  const fallbackTurn = context.turnCount ?? MIN_TURN_NUMBER
  let effectiveTurnNumber =
    typeof turnNumber === "number" ? turnNumber : fallbackTurn
  if (effectiveTurnNumber < MIN_TURN_NUMBER) {
    Logger.debug(
      {
        toolName,
        providedTurnNumber: turnNumber,
        fallbackTurnNumber: fallbackTurn,
      },
      "Tool turnNumber below minimum; normalizing to MIN_TURN_NUMBER",
    )
    effectiveTurnNumber = MIN_TURN_NUMBER
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
    status: status === "success" ? "success" : "error",
    error:
      status !== "success"
        ? {
            code: result?.error?.code || "UNKNOWN",
            message: result?.error?.message || "Unknown error",
          }
        : undefined,
  }

  // 2. Add to history (toDoWrite is plan bookkeeping, not execution)
  if (toolName !== XyneTools.toDoWrite) {
    logContextMutation(
      context,
      "[afterToolExecutionHook] Added tool execution record to history",
      {
        toolName,
        turnNumber: effectiveTurnNumber,
        recordStatus: record.status,
        recordError: record.error,
        historyLength: context.toolCallHistory.length,
      },
    )
    context.toolCallHistory.push(record)
    context.currentTurnArtifacts.executionToolsCalled++
  }

  // 3. Update metrics
  context.totalLatency += executionTime
  context.totalCost += record.estimatedCostUsd

  // 4. Track failures with cooldown
  if (status !== "success") {
    const cooldownMgr = new ToolCooldownManager(context.failedTools)
    const enteredCooldown = cooldownMgr.recordFailure(
      toolName,
      record.error!.message,
      context.turnCount
    )
    if (enteredCooldown) {
      const info = cooldownMgr.getCooldownInfo(toolName)!
      await emitReasoningEvent(
        reasoningEmitter,
        ReasoningSteps.toolCooldownApplied(toolName, info.count, info.cooldownUntilTurn - context.turnCount)
      )
    }
  }

  // 5. Extract raw Vespa results only. All tools return rawDocuments.
  const resultData = result?.data
  const rawDocuments: ToolRawDocument[] =
    (resultData && typeof resultData === "object" && Array.isArray((resultData as { rawDocuments?: unknown }).rawDocuments))
      ? (resultData as { rawDocuments: ToolRawDocument[] }).rawDocuments
      : []
  let toolFragments: MinimalAgentFragment[] = (resultData && typeof resultData === "object" && Array.isArray((resultData as { fragments?: unknown }).fragments))
    ? (resultData as { fragments: MinimalAgentFragment[] }).fragments
    : []

  loggerWithChild({ email: context.user.email }).info(
    { toolName, rawDocumentsExtracted: rawDocuments.length },
    "[afterToolExecutionHook] Raw Vespa results extracted",
  )

  if (rawDocuments.length > 0) {
    await emitReasoningEvent(
      reasoningEmitter,
      ReasoningSteps.documentsFound(rawDocuments.length, toolName),
    )
  }

  // Emit metrics even if no contexts (ToolMetric event to be added to ChatSSEvents later)
  // if (emitSSE) {
  //   await emitSSE(ChatSSEvents.ToolMetric, {
  //     toolName,
  //     durationMs: executionTime,
  //     cost: record.estimatedCostUsd,
  //     status,
  //   })
  // }

  if (
    toolName === XyneTools.toDoWrite &&
    result &&
    typeof result === "object" &&
    result.status === "success"
  ) {
    const plan = result.data?.plan as PlanState | undefined
    if (plan) {
      await emitReasoningEvent(
        reasoningEmitter,
        ReasoningSteps.planCreated(
          plan.goal || "Goal not specified",
          plan.subTasks.map((t) => ({ id: t.id, description: t.description, status: t.status })),
        ),
      )
    }
  }

  // Re-emit the plan after synthesis so the frontend has the latest snapshot.
  // Plan status (including completed tasks) is owned by the LLM via toDoWrite;
  // the server does not auto-complete tasks after tool runs.
  if (
    toolName === XyneTools.synthesizeFinalAnswer &&
    status === "success" &&
    context.plan
  ) {
    await emitReasoningEvent(
      reasoningEmitter,
      ReasoningSteps.planCreated(
        context.plan.goal || "Goal not specified",
        context.plan.subTasks.map((t) => ({ id: t.id, description: t.description, status: t.status })),
      ),
    )
  }

  if (
    toolName === XyneTools.listCustomAgents &&
    result &&
    typeof result === "object" &&
    result.status === "success"
  ) {
    const agents = (result?.data as { agents?: ListCustomAgentsOutput["agents"] })?.agents
    const agentCount = Array.isArray(agents) ? agents.length : 0
    const agentNames = agentCount ? agents?.map((a) => a.agentName) : undefined
    await emitReasoningEvent(
      reasoningEmitter,
      ReasoningSteps.agentsFound(agentCount, agentNames)
    )
  }

  if (
    toolName === XyneTools.runPublicAgent &&
    result &&
    typeof result === "object" &&
    result.status === "success"
  ) {
    const agentId =
      (result?.data as { agentId?: string })?.agentId ||
      (hookContext?.args as { agentId?: string })?.agentId
    const agentName =
      context.availableAgents.find((agent) => agent.agentId === agentId)
        ?.agentName ||
      agentId ||
      "unknown agent"
    const delegationFragments = buildDelegatedAgentFragments({
      result,
      agentId,
      agentName,
      turnNumber: effectiveTurnNumber,
      sourceToolName: toolName,
    })
    toolFragments = delegationFragments.concat(toolFragments)
    // Read the delegation ID from the tool's return value — each parallel call
    // returns its own ID, so no shared mutable state and no race condition.
    const delegationRunId = (result?.data as { delegationRunId?: string })
      ?.delegationRunId
    await emitReasoningEvent(
      reasoningEmitter,
      ReasoningSteps.agentCompleted(agentName, delegationRunId)
    )
  }

  if (
    toolName === XyneTools.fallBack &&
    result &&
    typeof result === "object" &&
    result.status === "success" &&
    (result.data as { reasoning?: string } | undefined)?.reasoning
  ) {
    await emitReasoningEvent(
      reasoningEmitter,
      ReasoningSteps.fallbackCompleted()
    )
  }

  const toolQuery = extractToolQuery(toolName, args as Record<string, unknown>) ?? ""
  const resultSummary =
    (result?.data && typeof result.data === "object" && typeof (result.data as { resultSummary?: string }).resultSummary === "string")
      ? (result.data as { resultSummary: string }).resultSummary
      : summarizeToolResultPayload(result)

  // Special case: delegated agent response with no citations/rawDocuments.
  // Represent its output as a synthetic non-Vespa DocumentState so it can flow through
  // the same filter/review/synthesis paths (fallback chunk-join when vespaHit is absent).
  if (
    toolName === XyneTools.runPublicAgent &&
    toolFragments.length === 0 &&
    typeof resultSummary === "string" &&
    resultSummary.trim().length > 0
  ) {
    const agentId =
      (result?.data as { agentId?: string })?.agentId ||
      (hookContext?.args as { agentId?: string })?.agentId ||
      "unknown"
    const agentName =
      context.availableAgents.find((agent) => agent.agentId === agentId)
        ?.agentName ||
      agentId ||
      "unknown agent"
    const syntheticDocId = `delegated_agent:${agentId}:turn:${effectiveTurnNumber}`
    const existsAlready = context.currentTurnArtifacts.syntheticDocs.some(
      (d) => d.docId === syntheticDocId,
    )
    if (!existsAlready) {
      const doc = createDocumentState(syntheticDocId, {
        docId: syntheticDocId,
        title: `Delegated agent (${agentName})`,
        url: "",
        app: Apps.Xyne,
        entity: { type: "agent", name: agentName } as unknown as Citation["entity"],
      })
      doc.chunks.set(chunkKeyFromContent(resultSummary), {
        content: resultSummary,
        firstSeenTurn: effectiveTurnNumber,
        lastSeenTurn: effectiveTurnNumber,
        confidence: 0.7,
        queries: toolQuery ? [toolQuery] : [],
      })
      doc.signals.push({
        query: toolQuery,
        confidence: 0.7,
        turn: effectiveTurnNumber,
        toolName,
      })
      doc.maxScore = 0.7
      doc.relevanceScore = 0.7
      context.currentTurnArtifacts.syntheticDocs.push(doc)
    }
  }

  context.currentTurnArtifacts.toolOutputs.push({
    toolName,
    arguments: args,
    status: record.status,
    resultSummary,
    query: toolQuery,
    rawDocuments: rawDocuments.length > 0 ? rawDocuments : undefined,
  })
  logContextMutation(
    context,
    "[afterToolExecutionHook] Recorded tool output (raw only; no fragments in message)",
    {
      toolName,
      turnNumber: effectiveTurnNumber,
      rawDocumentsCount: rawDocuments.length,
      fragmentsCount: toolFragments.length,
      resultSummary,
    },
  )

  if (toolName !== XyneTools.runPublicAgent) {
    await emitReasoningEvent(
      reasoningEmitter,
      ReasoningSteps.toolCompleted(toolName, record.status === "error")
    )
  }

  if (toolFragments.length > 0) {
    return ToolResponse.success(toolFragments)
  }

  return null
}

export function buildDelegatedAgentFragments(opts: {
  result: any
  agentId?: string
  agentName?: string
  turnNumber: number
  sourceToolName: string
}): MinimalAgentFragment[] {
  const {
    result,
    agentId,
    agentName,
    turnNumber,
    sourceToolName,
  } = opts
  const resultData = (result?.data as Record<string, unknown>) || {}
  const citations = resultData.citations as Citation[] | undefined
  const imageCitations = resultData.imageCitations as
    | ImageCitation[]
    | undefined
  const agentFragments: MinimalAgentFragment[] = []
  const fragmentTurn = Math.max(turnNumber, MIN_TURN_NUMBER)
  const normalizedAgentName =
    agentName || agentId || sourceToolName || "delegated_agent"
  const normalizedAgentId = agentId || `agent:${sourceToolName}`
  const baseSource: Citation = {
    docId: normalizedAgentId,
    title: normalizedAgentName,
    url: "",
    app: Apps.Xyne,
    entity: {
      type: "agent",
      name: normalizedAgentName,
    } as unknown as Citation["entity"],
  }
  const textResult =
    typeof resultData.result === "string"
      ? (resultData.result as string)
      : typeof (resultData as { agentResult?: string })?.agentResult ===
          "string"
        ? ((resultData as { agentResult?: string }).agentResult as string)
        : typeof result?.result === "string"
          ? result.result
          : ""

  if (Array.isArray(citations) && citations.length > 0) {
    citations.forEach((citation, idx) => {
      const fragmentId = `${normalizedAgentId}:${citation.docId || idx}:${fragmentTurn}:${idx}`
      const citationExtras = citation as Partial<{
        excerpt: string
        summary: string
      }>
      agentFragments.push({
        id: fragmentId,
        content:
          citationExtras.excerpt ||
          citationExtras.summary ||
          textResult ||
          citation?.url ||
          `Delegated agent ${normalizedAgentName} response`,
        source: {
          ...baseSource,
          ...citation,
          docId: citation.docId || baseSource.docId,
          title: citation.title || baseSource.title,
          url: citation.url || baseSource.url,
          app: citation.app || baseSource.app,
          entity: citation.entity || baseSource.entity,
        },
        confidence: 0.85,
      })
    })
  }

  if (agentFragments.length === 0) {
    const attributionFragmentId = `${normalizedAgentId}:turn:${fragmentTurn}`
    agentFragments.push({
      id: attributionFragmentId,
      content:
        textResult ||
        `Response provided by delegated agent ${normalizedAgentName}`,
      source: baseSource,
      confidence: 0.9,
    })
  }

  if (agentFragments.length === 0) {
    return []
  }

  if (Array.isArray(imageCitations) && imageCitations.length > 0) {
    const fragmentByDoc = new Map(
      agentFragments
        .filter((fragment) => fragment.source?.docId)
        .map((fragment) => [fragment.source.docId!, fragment]),
    )

    for (const imageCitation of imageCitations) {
      if (!imageCitation?.imagePath) continue
      const targetFragment =
        (imageCitation.item?.docId
          ? fragmentByDoc.get(imageCitation.item.docId)
          : agentFragments[0]) || agentFragments[0]
      if (!targetFragment) continue
      const ref: FragmentImageReference = {
        fileName: imageCitation.imagePath,
        addedAtTurn: fragmentTurn,
        sourceFragmentId: targetFragment.id,
        sourceToolName,
        isUserAttachment: false,
      }
      targetFragment.images = [...(targetFragment.images ?? []), ref]
    }
  }

  return agentFragments
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
      const toolName =
        typeof entry.toolName === "string" ? entry.toolName.trim() : ""
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
          "Invalid expected_results entry emitted by agent",
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
  toolName: string,
): PendingExpectation | undefined {
  if (!toolName) return undefined
  const idx = queue.findIndex(
    (entry) => entry.toolName.toLowerCase() === toolName.toLowerCase(),
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
  Logger.debug({ plan }, "summarizePlan input")
  if (!plan) {
    Logger.debug({ summary: "No plan available." }, "summarizePlan output")
    return "No plan available."
  }
  const steps = plan.subTasks
    .map(
      (task, idx) =>
        `${idx + 1}. [${task.status}] ${task.description}${
          task.toolsRequired?.length
            ? ` (tools: ${task.toolsRequired.join(", ")})`
            : ""
        }`,
    )
    .join("\n")
  const summary = `Goal: ${plan.goal}\n${steps}`
  Logger.debug(
    { summary, subTaskCount: plan.subTasks.length },
    "summarizePlan output",
  )
  return summary
}

function formatExpectationsForReview(
  expectations?: ToolExpectationAssignment[],
): string {
  Logger.debug({ expectations }, "formatExpectationsForReview input")
  if (!expectations || expectations.length === 0) {
    Logger.debug({ serialized: "[]" }, "formatExpectationsForReview output")
    return "[]"
  }
  const serialized = JSON.stringify(expectations, null, 2)
  Logger.debug(
    {
      expectationCount: expectations.length,
      serializedLength: serialized.length,
    },
    "formatExpectationsForReview output",
  )
  return serialized
}

function formatToolOutputsForReview(
  outputs: ToolExecutionRecordWithResult[],
): string {
  if (!outputs || outputs.length === 0) {
    return "No tools executed this turn."
  }
  return outputs
    .map((output, idx) => {
      const argsSummary = formatToolArgumentsForReasoning(
        output.arguments || {},
      )
      const rawSummary =
        (output.rawDocuments?.length ?? 0) > 0
          ? ` (${output.rawDocuments!.length} doc${output.rawDocuments!.length === 1 ? "" : "s"} for document memory)`
          : ""
      return `${idx + 1}. ${output.toolName} [${output.status}]\n   Args: ${argsSummary}\n   Result: ${output.resultSummary ?? "No result summary available."}${rawSummary}`
    })
    .join("\n\n")
}

/** Format ToolExecutionRecord[] for review prompt, grouped by turn (for last-N-turns context). */
function formatToolCallHistoryByTurn(records: ToolExecutionRecord[]): string {
  if (!records || records.length === 0) {
    return "No tool calls in this window."
  }
  const byTurn = new Map<number, ToolExecutionRecord[]>()
  for (const r of records) {
    const list = byTurn.get(r.turnNumber) ?? []
    list.push(r)
    byTurn.set(r.turnNumber, list)
  }
  const turns = Array.from(byTurn.keys()).sort((a, b) => a - b)
  return turns
    .map((turnNum) => {
      const turnRecords = byTurn.get(turnNum)!
      const lines = turnRecords.map((r, idx) => {
        const argsSummary = formatToolArgumentsForReasoning(r.arguments || {})
        const err = r.error ? ` Error: ${r.error.message}` : ""
        return `  ${idx + 1}. ${r.toolName} [${r.status}]${err}\n     Args: ${argsSummary}`
      })
      return `Turn ${turnNum}:\n${lines.join("\n")}`
    })
    .join("\n\n")
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

function normalizeReviewResult(raw: unknown): unknown {
  // We only normalize the top-level keys that the review schema requires.
  // This protects weaker models that sometimes omit "optional-looking" fields.
  if (!raw || typeof raw !== "object") return raw
  const r = raw as Record<string, unknown>

  const toolFeedback = Array.isArray(r.toolFeedback)
    ? r.toolFeedback.map((item: any) => ({
        toolName: typeof item?.toolName === "string" ? item.toolName : "",
        outcome:
          item?.outcome === "met" ||
          item?.outcome === "missed" ||
          item?.outcome === "error"
            ? item.outcome
            : "missed",
        summary: typeof item?.summary === "string" ? item.summary : "",
        expectationGoal:
          typeof item?.expectationGoal === "string"
            ? item.expectationGoal
            : "",
        followUp:
          typeof item?.followUp === "string"
            ? item.followUp
            : "",
      }))
    : []
  const unmetExpectations = Array.isArray(r.unmetExpectations)
    ? r.unmetExpectations
    : []
  const anomalies = Array.isArray(r.anomalies) ? r.anomalies : []
  const clarificationQuestions = Array.isArray(r.clarificationQuestions)
    ? r.clarificationQuestions
    : []

  return {
    status:
      r.status === "ok" || r.status === "needs_attention"
        ? r.status
        : "needs_attention",
    notes: typeof r.notes === "string" ? r.notes : "",
    toolFeedback,
    unmetExpectations,
    planChangeNeeded: typeof r.planChangeNeeded === "boolean" ? r.planChangeNeeded : false,
    planChangeReason: typeof r.planChangeReason === "string" ? r.planChangeReason : undefined,
    anomaliesDetected:
      typeof r.anomaliesDetected === "boolean"
        ? r.anomaliesDetected
        : anomalies.length > 0,
    anomalies,
    recommendation:
      r.recommendation === "proceed" ||
      r.recommendation === "gather_more" ||
      r.recommendation === "clarify_query" ||
      r.recommendation === "replan"
        ? r.recommendation
        : "proceed",
    ambiguityResolved: typeof r.ambiguityResolved === "boolean" ? r.ambiguityResolved : false,
    clarificationQuestions,
  }
}

/**
 * Build unranked fragments from current-turn document memory only (raw Vespa docs
 * from tool calls this turn). One fragment per document; used for filtering (reranking).
 * After ranking, ranked results are merged into cross-turn documentMemory.
 */
async function buildUnrankedFragmentsFromDocumentMemory(
  context: AgentRunContext,
  turn: number,
): Promise<UnrankedFragmentWithToolContext[] | null> {
  const docs = Array.from(context.currentTurnDocumentMemory.values())
  if (docs.length === 0) return null

  const fragments = await getFragmentsForSynthesisForDocs(
    context.currentTurnDocumentMemory,
    docs,
    {
      email: context.user.email,
      userId: context.user.numericId ?? undefined,
      workspaceId: context.user.workspaceNumericId ?? undefined,
    },
  )
  if (fragments.length === 0) return null

  const docById = new Map(docs.map((d) => [d.docId, d]))
  const out: UnrankedFragmentWithToolContext[] = []
  for (const fragment of fragments) {
    const doc = fragment.id != null ? docById.get(fragment.id) : undefined
    if (!doc) continue
    const signals = doc.signals
    const lastSignal = signals[signals.length - 1]
    const toolName = lastSignal?.toolName ?? "search"
    const toolQuery = lastSignal?.query ?? ""
    out.push({ fragment, toolName, toolQuery, signals })
  }
  return out
}

/**
 * Batch fragment ranking — runs a SINGLE extractBestDocumentIndexes LLM call
 * for ALL fragments collected across all tools in this turn.
 *
 * This replaces the old per-tool ranking (N LLM calls per turn → 1 LLM call).
 * Called from the turn-lifecycle pipeline at turn-end.
 */
async function batchRankFragments(
  context: AgentRunContext,
  allUnrankedWithToolContext: UnrankedFragmentWithToolContext[],
  userMessage: string,
  messagesWithNoErrResponse: Message[],
  turnNumber: number,
  reasoningEmitter?: ReasoningEmitter
): Promise<MinimalAgentFragment[]> {
  if (allUnrankedWithToolContext.length === 0) return []

  const allUnranked = allUnrankedWithToolContext.map((e) => e.fragment)
  const fragmentKeyToToolContext = new Map<
    string,
    { toolName: string; toolQuery: string; signals: RetrievalSignal[] }
  >()
  for (const { fragment, toolName, toolQuery, signals } of allUnrankedWithToolContext) {
    const key = getFragmentDedupKey(fragment) || fragment.id || ""
    if (!fragmentKeyToToolContext.has(key)) {
      fragmentKeyToToolContext.set(key, { toolName, toolQuery, signals: [...signals] })
      continue
    }

    const existing = fragmentKeyToToolContext.get(key)
    if (!existing) continue

    // Preserve "all" signals for this doc/content key (dedupe by query+turn+toolName).
    const existingSigKeys = new Set(
      existing.signals.map((s) => `${s.toolName ?? "search"}|${s.query}|${s.turn}`),
    )
    for (const sig of signals) {
      const k = `${sig.toolName ?? "search"}|${sig.query}|${sig.turn}`
      if (existingSigKeys.has(k)) continue
      existing.signals.push(sig)
      existingSigKeys.add(k)
    }
  }

  const metadataConstraints = extractMetadataConstraintsFromUserMessage(userMessage)
  const {
    rankedCandidates,
    hasConstraints: hasMetadataConstraints,
    hasCompliantCandidates,
  } = rankFragmentsByMetadataConstraints(allUnranked, metadataConstraints)
  const rankingCandidates = rankedCandidates.map((c) => c.fragment)
  const strictNoCompliantCandidates =
    hasMetadataConstraints && metadataConstraints.strict && !hasCompliantCandidates

  /** Skip ranking LLM when fragments already fit context; use all and record. */
  const RANKING_CONTEXT_WINDOW_CAPACITY = 8
  const skipRankingLLM = rankingCandidates.length <= RANKING_CONTEXT_WINDOW_CAPACITY

  if (!skipRankingLLM) {
    await emitReasoningEvent(
      reasoningEmitter,
      ReasoningSteps.documentsFilteringStarted(),
    )
    if (hasMetadataConstraints) {
      if (strictNoCompliantCandidates) {
        await emitReasoningEvent(reasoningEmitter, ReasoningSteps.metadataNoMatch())
      } else {
        await emitReasoningEvent(
          reasoningEmitter,
          ReasoningSteps.metadataFilterApplied(hasCompliantCandidates)
        )
      }
    }
  }

  let selectedDocs: MinimalAgentFragment[] = []

  if (skipRankingLLM) {
    selectedDocs = strictNoCompliantCandidates
      ? []
      : hasMetadataConstraints && metadataConstraints.strict && hasCompliantCandidates
        ? rankedCandidates.filter((c) => c.compliant).map((c) => c.fragment)
        : rankingCandidates
  } else {
    const contextStrings = rankingCandidates.map(
      (fragment: MinimalAgentFragment, index: number) => {
        const key = getFragmentDedupKey(fragment) || fragment.id || ""
        const toolContext = fragmentKeyToToolContext.get(key)
        return formatFragmentWithMetadataForRanking(
          fragment,
          index,
          toolContext?.toolName,
          toolContext?.toolQuery,
          toolContext?.signals,
        )
      }
    )

  try {
    const rankingModelId = (context.modelId as Models) || config.defaultBestModel
    const selectionSpan = getTracer("chat").startSpan("batch_select_best_documents")
    selectionSpan.setAttribute("total_unranked", allUnrankedWithToolContext.length)
    selectionSpan.setAttribute("context_count", contextStrings.length)

    let bestDocIndexes: number[] = []
    try {
      const rankingMessages = withAgentSystemPromptMessage(
        messagesWithNoErrResponse,
        context.dedicatedAgentSystemPrompt
      )
      selectionSpan.setAttribute(
        "has_agent_system_prompt_snapshot",
        !!sanitizeAgentSystemPromptSnapshot(context.dedicatedAgentSystemPrompt)
      )
      bestDocIndexes = await extractBestDocumentIndexes(
        userMessage,
        contextStrings,
        { modelId: rankingModelId, json: false, stream: false },
        rankingMessages
      )
      selectionSpan.setAttribute("selected_count", bestDocIndexes.length)
    } catch (error) {
      selectionSpan.setAttribute("error", true)
      selectionSpan.setAttribute("error_message", getErrorMessage(error))
      throw error
    } finally {
      selectionSpan.end()
    }

    if (bestDocIndexes.length > 0) {
      bestDocIndexes.forEach((idx) => {
        if (idx >= 1 && idx <= rankingCandidates.length) {
          selectedDocs.push(rankingCandidates[idx - 1])
        }
      })
      selectedDocs = enforceMetadataConstraintsOnSelection(
        selectedDocs,
        rankedCandidates,
        metadataConstraints
      )
    }

    if (selectedDocs.length === 0) {
      // Fallback: use all candidates (or compliant-only if strict)
      selectedDocs = strictNoCompliantCandidates
        ? []
        : hasMetadataConstraints && metadataConstraints.strict && hasCompliantCandidates
        ? rankedCandidates.filter((c) => c.compliant).map((c) => c.fragment)
        : rankingCandidates
    }
  } catch (error) {
    loggerWithChild({ email: context.user.email }).error(
      {
        error: error instanceof Error ? error.message : String(error),
        totalUnranked: allUnranked.length,
      },
      "[batchRankFragments] Ranking failed — falling back to all candidates"
    )
    await emitReasoningEvent(
      reasoningEmitter,
      ReasoningSteps.rankingFailed(strictNoCompliantCandidates)
    )
    // Apply same metadata-based filtering as success-path fallback so strict mode
    // does not reintroduce non-compliant fragments.
    selectedDocs = strictNoCompliantCandidates
      ? []
      : hasMetadataConstraints && metadataConstraints.strict && hasCompliantCandidates
        ? rankedCandidates.filter((c) => c.compliant).map((c) => c.fragment)
        : rankingCandidates
  }
  }

  if (selectedDocs.length > 0) {
    await emitReasoningEvent(
      reasoningEmitter,
      ReasoningSteps.documentsFiltered(selectedDocs.length)
    )

    // Merge ranked current-turn docs into cross-turn document memory before recording
    const rankedDocIds = new Set(
      selectedDocs.map((f) => f.source?.docId ?? f.id).filter(Boolean) as string[]
    )
    const rankedDocsFromCurrentTurn = Array.from(
      context.currentTurnDocumentMemory.values()
    ).filter((d) => rankedDocIds.has(d.docId))
    if (rankedDocsFromCurrentTurn.length > 0) {
      const newChunks = mergeDocumentStatesIntoDocumentMemory(
        context.documentMemory,
        rankedDocsFromCurrentTurn,
        turnNumber,
      )
      if (newChunks > 0) {
        context.turnNewChunksCount.set(
          turnNumber,
          (context.turnNewChunksCount.get(turnNumber) ?? 0) + newChunks,
        )
      }
    }
  }

  return selectedDocs
}

export async function buildReviewPromptFromContext(
  context: AgentRunContext,
  options?: {
    focus?: string
    turnNumber?: number
  },
  fallbackExpectations?: ToolExpectationAssignment[],
): Promise<{ prompt: string; imageFileNames: string[] }> {
  const isFirstReview = context.review.lastReviewResult === null
  const turnExpectations =
    (fallbackExpectations?.length ?? 0) > 0
      ? (fallbackExpectations ?? [])
      : context.currentTurnArtifacts.expectations.length > 0
        ? context.currentTurnArtifacts.expectations
        : []
  const planSection = formatPlanForPrompt(context.plan)
  const clarificationsSection = formatClarificationsForPrompt(
    context.clarifications,
  )
  const workspaceSection = context.userContext?.trim()
    ? `Workspace Context:\n${context.userContext.trim()}`
    : ""
  const memorySection = isFirstReview
    ? buildLLMMemoryContextSection(context)
    : ""
  const useMultiTurnHistory =
    context.toolCallHistory.length > 0 || options?.focus === "turn_end"
  const toolOutputsSection = useMultiTurnHistory
    ? (() => {
        if (context.toolCallHistory.length === 0) {
          return formatToolCallHistoryByTurn(context.toolCallHistory)
        }
        const turns = context.toolCallHistory.map((r) => r.turnNumber)
        const minTurn = Math.min(...turns)
        const maxTurn = Math.max(...turns)
        const turnLabel =
          minTurn === maxTurn
            ? `turn ${maxTurn}`
            : `turns ${minTurn}–${maxTurn} (${maxTurn - minTurn + 1} turns since last review)`
        return `Tool activity ${turnLabel}:\n${formatToolCallHistoryByTurn(context.toolCallHistory)}`
      })()
    : formatToolOutputsForReview(context.currentTurnArtifacts.toolOutputs)
  const expectationsSection = formatExpectationsForReview(turnExpectations)
  const currentTurn = options?.turnNumber ?? context.turnCount
  const newDocs = isFirstReview
    ? Array.from(context.documentMemory?.values() ?? [])
    : getDocsWithSignalsInTurnRange(
        context.documentMemory ?? new Map(),
        (context.review.lastReviewTurn ?? 0) + 1,
        currentTurn,
      )
  const newFragments = await getFragmentsForSynthesisForDocs(
    context.documentMemory ?? new Map(),
    newDocs,
    {
      email: context.user.email,
      userId: context.user.numericId ?? undefined,
      workspaceId: context.user.workspaceNumericId ?? undefined,
    },
  )
  const fragmentsSection = newFragments.length
    ? `New Context Fragments (since last review):\n${answerContextMapFromFragments(
        newFragments,
        newFragments.length,
      )}`
    : "New Context Fragments (since last review):\nNo new context fragments since last review."
  const previousReviewSection =
    context.review.lastReviewResult != null
      ? (() => {
          const r = context.review.lastReviewResult
          const parts = [
            `Status: ${r.status}`,
            `Recommendation: ${r.recommendation}`,
            r.notes ? `Notes: ${r.notes}` : "",
            r.unmetExpectations?.length
              ? `Unmet expectations: ${r.unmetExpectations.join("; ")}`
              : "",
            r.anomalies?.length
              ? `Anomalies: ${r.anomalies.join("; ")}`
              : "",
          ].filter(Boolean)
          return `Previous review summary (for continuity):\n${parts.join("\n")}`
        })()
      : ""
  const docOrderForImages = newFragments.map((f) => f.id)
  const reviewImageBudget =
    IMAGE_CONTEXT_CONFIG.maxImagesPerCall && IMAGE_CONTEXT_CONFIG.maxImagesPerCall > 0
      ? IMAGE_CONTEXT_CONFIG.maxImagesPerCall
      : 8
  const { imageFileNamesForModel: currentImages, total: totalImages } =
    getAllImagesFromDocumentMemory(context.documentMemory ?? new Map(), {
      docOrder: docOrderForImages,
      maxImages: reviewImageBudget,
    })
  const additionalImages = Math.max(totalImages - currentImages.length, 0)
  const imageSection = `Attachments in this window: ${currentImages.length}\nFrom prior turns: ${additionalImages}`
  const reviewFocus = `Review Focus: ${options?.focus ?? "turn_end"} (evaluating through turn ${
    options?.turnNumber ?? context.turnCount
  })`

  const userPromptSections = [
    `User Question:\n${context.message.text}`,
    planSection ? `Execution Plan Snapshot:\n${planSection}` : "",
    clarificationsSection ? `Clarifications:\n${clarificationsSection}` : "",
    workspaceSection,
    memorySection,
    previousReviewSection,
    `Recent Tool Activity (since last review):\n${toolOutputsSection}`,
    `Expectations (associated with tool calls in this window):\n${expectationsSection}`,
    fragmentsSection,
    `Images:\n${imageSection}`,
    reviewFocus,
  ].filter(Boolean)

  return {
    prompt: userPromptSections.join("\n\n"),
    imageFileNames: currentImages,
  }
}

export async function buildReviewRequest(
  context: AgentRunContext,
  options?: {
    focus?: string
    turnNumber?: number
    expectedResults?: ToolExpectationAssignment[]
  },
): Promise<{
  prompt: string
  imageFileNames: string[]
  messages: Message[]
  isFirstReview: boolean
}> {
  const isFirstReview = context.review.lastReviewResult === null
  const { prompt, imageFileNames } = await buildReviewPromptFromContext(
    context,
    options,
    options?.expectedResults,
  )
  const messages: Message[] = [
    ...(isFirstReview ? context.conversationHistoryMessages : []),
    {
      role: ConversationRole.USER,
      content: [{ text: prompt }],
    },
  ]
  return {
    prompt,
    imageFileNames,
    messages,
    isFirstReview,
  }
}

async function runReviewLLM(
  context: AgentRunContext,
  options?: {
    focus?: string
    turnNumber?: number
    maxFindings?: number
    expectedResults?: ToolExpectationAssignment[]
    delegationEnabled?: boolean
  },
  modelOverride?: string,
): Promise<ReviewResult> {
  const tracer = getTracer("chat")
  const reviewSpan = tracer.startSpan("review_llm_call")
  reviewSpan.setAttribute("focus", options?.focus ?? "unknown")
  reviewSpan.setAttribute("turn_number", options?.turnNumber ?? -1)
  reviewSpan.setAttribute(
    "expected_results_count",
    options?.expectedResults?.length ?? 0,
  )
  Logger.debug(
    {
      focus: options?.focus,
      turnNumber: options?.turnNumber,
      maxFindings: options?.maxFindings,
      expectedResultCount: options?.expectedResults?.length ?? 0,
      delegationEnabled: options?.delegationEnabled,
      expectedResults: options?.expectedResults,
      email: context.user.email,
      chatId: context.chat.externalId,
    },
    "[MessageAgents][runReviewLLM] invoked - FULL expectedResults",
  )
  const modelId =
    (modelOverride as Models) ||
    (defaultFastModel as Models) ||
    (defaultBestModel as Models)
  const delegationNote =
    options?.delegationEnabled === false
      ? "- Delegation tools (list_custom_agents/run_public_agent) were disabled for this run; do not flag their absence."
      : "- If delegation tools are available, ensure list_custom_agents precedes run_public_agent when delegation is appropriate."

  const reviewRequest = await buildReviewRequest(context, {
    focus: options?.focus,
    turnNumber: options?.turnNumber,
    expectedResults: options?.expectedResults,
  })
  const {
    prompt: userPrompt,
    imageFileNames: currentImages,
    messages,
    isFirstReview,
  } = reviewRequest
  const hasEpisodicMemories = !!context.episodicMemoriesText?.trim()
  const hasChatMemory = !!sanitizeChatMemoryForLLMContext(
    context.chatMemoryText,
  )
  const totalImagesAll = Array.from(context.documentMemory?.values?.() ?? []).reduce(
    (sum, doc) => sum + (doc.images?.length ?? 0),
    0,
  )
  Logger.debug(
    {
      email: context.user.email,
      chatId: context.chat.externalId,
      focus: options?.focus,
      turnNumber: options?.turnNumber,
      reviewImages: currentImages,
      additionalImages: Math.max(totalImagesAll - currentImages.length, 0),
      fragmentsCount: context.documentMemory.size,
      toolOutputsCount: context.currentTurnArtifacts.toolOutputs.length,
      isFirstReview,
      conversationHistoryCount: context.conversationHistoryMessages.length,
      hasEpisodicMemories,
      hasChatMemory,
    },
    "[MessageAgents][runReviewLLM] Context summary for review model",
  )

  Logger.debug(
    {
      email: context.user.email,
      chatId: context.chat.externalId,
      focus: options?.focus,
      turnNumber: options?.turnNumber,
      modelId,
    },
    "[MessageAgents][runReviewLLM] Preparing review LLM call",
  )

  const params: ModelParams = {
    modelId,
    json: true,
    stream: false,
    temperature: 0,
    max_new_tokens: 800,
    systemPrompt: `${buildReviewSystemPrompt({
      isFirstReview,
      delegationNote,
    })}
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
      planChangeNeeded: false,
      planChangeReason: "Why plan needs updating if true",
      anomaliesDetected: false,
      anomalies: ["Description of anomalies or ambiguities"],
      recommendation: "proceed",
      ambiguityResolved: true,
    })}
- Use native JSON booleans (true/false) for every yes/no field.
- Only emit keys defined in the schema; do not add prose outside the JSON object.
- You MUST include every key present in the example JSON object (status, notes, toolFeedback, unmetExpectations, planChangeNeeded, planChangeReason, anomaliesDetected, anomalies, recommendation, ambiguityResolved, clarificationQuestions). Missing keys = INVALID.
- If you have no items, use [] (arrays), false (booleans), and an empty string \"\" for notes/planChangeReason. For recommendation defaults use \"proceed\".`,
  }
  if (currentImages.length > 0) {
    params.imageFileNames = currentImages
  }
  Logger.debug(
    {
      email: context.user.email,
      chatId: context.chat.externalId,
      modelId,
      params,
      temperature: params.temperature,
      maxTokens: params.max_new_tokens,
      json: params.json,
      stream: params.stream,
      isFirstReview,
      conversationHistoryCount: context.conversationHistoryMessages.length,
      hasEpisodicMemories,
      hasChatMemory,
    },
    "[MessageAgents][runReviewLLM] LLM params prepared",
  )
  Logger.debug(
    {
      email: context.user.email,
      chatId: context.chat.externalId,
      userPrompt,
      isFirstReview,
    },
    "[MessageAgents][runReviewLLM] Review user prompt",
  )

  Logger.debug(
    {
      email: context.user.email,
      chatId: context.chat.externalId,
      systemPrompt: params.systemPrompt,
      isFirstReview,
    },
    "[MessageAgents][runReviewLLM] System prompt",
  )

  const { text } = await getProviderByModel(modelId).converse(messages, params)

  Logger.debug(
    {
      email: context.user.email,
      chatId: context.chat.externalId,
      text,
    },
    "[MessageAgents][runReviewLLM] Raw LLM response",
  )

  if (!text) {
    throw new Error("LLM returned empty review response")
  }

  const parsed = jsonParseLLMOutput(text)
  Logger.debug(
    {
      email: context.user.email,
      chatId: context.chat.externalId,
      parsed,
    },
    "[MessageAgents][runReviewLLM] Parsed LLM response",
  )

  if (!parsed || typeof parsed !== "object") {
    Logger.error(
      {
        email: context.user.email,
        chatId: context.chat.externalId,
        raw: parsed,
      },
      "[MessageAgents][runReviewLLM] Invalid review payload",
    )
    return buildDefaultReviewPayload(
      `Review model returned invalid payload for turn ${options?.turnNumber ?? "unknown"}`,
    )
  }

  const normalized = normalizeReviewResult(parsed)
  const validation = ReviewResultSchema.safeParse(normalized)
  if (!validation.success) {
    Logger.error(
      {
        email: context.user.email,
        chatId: context.chat.externalId,
        error: validation.error.format(),
        raw: parsed,
        normalized,
      },
      "[MessageAgents][runReviewLLM] Review result does not match schema",
    )
    return buildDefaultReviewPayload(
      `Review model response failed validation for turn ${options?.turnNumber ?? "unknown"}`,
    )
  }

  Logger.debug(
    {
      email: context.user.email,
      chatId: context.chat.externalId,
      reviewResult: validation.data,
    },
    "[MessageAgents][runReviewLLM] Returning review result",
  )
  Logger.debug(
    {
      email: context.user.email,
      chatId: context.chat.externalId,
      status: validation.data.status,
      recommendation: validation.data.recommendation,
      imageFileCount: currentImages.length,
      toolOutputsEvaluated: context.currentTurnArtifacts.toolOutputs.length,
      isFirstReview,
      conversationHistoryCount: context.conversationHistoryMessages.length,
      hasEpisodicMemories,
      hasChatMemory,
    },
    "[MessageAgents][runReviewLLM] Review LLM call completed",
  )
  reviewSpan.setAttribute("model_id", modelId)
  reviewSpan.setAttribute("review_status", validation.data.status)
  reviewSpan.setAttribute("recommendation", validation.data.recommendation)
  reviewSpan.setAttribute(
    "anomalies_detected",
    validation.data.anomaliesDetected ?? false,
  )
  reviewSpan.setAttribute(
    "tool_feedback_count",
    validation.data.toolFeedback.length,
  )
  reviewSpan.end()
  return validation.data
}

function buildInternalToolAdapters(): Tool<unknown, AgentRunContext>[] {
  const baseTools = [
    createToDoWriteTool(),
    searchGlobalTool,
    lsKnowledgeBaseTool,
    searchKnowledgeBaseTool,
    searchChatHistoryTool,
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
  ls: { requiredApp: Apps.KnowledgeBase },
  searchKnowledgeBase: { requiredApp: Apps.KnowledgeBase },
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

    if (rule.connectorFlag && !params.connectorState[rule.connectorFlag]) {
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
      name: XyneTools.toDoWrite,
      description: TOOL_SCHEMAS.toDoWrite.description,
      parameters: toToolParameters(TOOL_SCHEMAS.toDoWrite.inputSchema),
    },
    async execute(args, context) {
      const mutableContext = mutableAgentContext(context)
      Logger.debug(
        {
          email: context.user.email,
          args,
        },
        "[toDoWrite] Execution started",
      )
      const validation = validateToolInput<PlanState>(XyneTools.toDoWrite, args)
      if (!validation.success) {
        return ToolResponse.error("INVALID_INPUT", validation.error.message)
      }

      const plan: PlanState = {
        goal: validation.data.goal,
        subTasks: validation.data.subTasks,
      }

      const activeSubTaskId = initializePlanState(plan)
      mutableContext.plan = plan
      mutableContext.currentSubTask = activeSubTaskId

      // Track that toDoWrite was called this turn (for no-op detection)
      mutableContext.currentTurnArtifacts.todoWriteCalled = true

      Logger.debug(
        {
          email: context.user.email,
          goal: plan.goal,
          subTaskCount: plan.subTasks.length,
          activeSubTaskId,
        },
        "[toDoWrite] Plan created",
      )

      return ToolResponse.success({ plan })
    },
  }
}

function buildDelegatedAgentQuery(
  baseQuery: string,
  context: AgentRunContext,
): string {
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
  return [createListCustomAgentsTool(), createRunPublicAgentTool()]
}

function createListCustomAgentsTool(): Tool<unknown, AgentRunContext> {
  return {
    schema: {
      name: XyneTools.listCustomAgents,
      description: TOOL_SCHEMAS.list_custom_agents.description,
      parameters: toToolParameters(TOOL_SCHEMAS.list_custom_agents.inputSchema),
    },
    async execute(args, context) {
      const mutableContext = mutableAgentContext(context)
      const validation = validateToolInput<{
        query: string
        requiredCapabilities?: string[]
        maxAgents?: number
      }>(XyneTools.listCustomAgents, args)

      if (!validation.success) {
        return ToolResponse.error("INVALID_INPUT", validation.error.message)
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
      Logger.debug(
        { params: validation.data, email: context.user.email },
        "[list_custom_agents] input params",
      )
      Logger.debug(
        { selection: result, email: context.user.email },
        "[list_custom_agents] selection result",
      )

      const normalizedAgents = Array.isArray(result.agents) ? result.agents : []
      mutableContext.availableAgents = normalizedAgents
      logContextMutation(
        mutableContext,
        "[list_custom_agents] Updated availableAgents in context",
        {
          query: validation.data.query,
          requiredCapabilities: validation.data.requiredCapabilities,
          availableAgentIds: normalizedAgents.map((agent) => agent.agentId),
          availableAgentNames: normalizedAgents.map((agent) => agent.agentName),
        },
      )
      return ToolResponse.success({
        agents: normalizedAgents.length ? normalizedAgents : null,
        totalEvaluated: result.totalEvaluated,
      })
    },
  }
}

function createRunPublicAgentTool(): Tool<unknown, AgentRunContext> {
  return {
    schema: {
      name: XyneTools.runPublicAgent,
      description: TOOL_SCHEMAS.run_public_agent.description,
      parameters: toToolParameters(TOOL_SCHEMAS.run_public_agent.inputSchema),
    },
    async execute(args, context) {
      const validation = validateToolInput<{
        agentId: string
        query: string
        context?: string
        maxTokens?: number
      }>(XyneTools.runPublicAgent, args)

      if (!validation.success) {
        return ToolResponse.error("INVALID_INPUT", validation.error.message)
      }

      if (!context.ambiguityResolved) {
        return ToolResponse.error(
          ToolErrorCodes.INVALID_INPUT,
          `Resolve ambiguity before running a custom agent. Unresolved: ${
            context.clarifications.length
              ? context.clarifications.map((c) => c.question).join("; ")
              : "not specified"
          }`,
        )
      }

      if (!context.availableAgents.length) {
        return ToolResponse.error(
          ToolErrorCodes.RESOURCE_UNAVAILABLE,
          "No agents available. Run list_custom_agents this turn and select an agentId from its results.",
        )
      }

      Logger.debug(
        {
          requestedAgentId: validation.data.agentId,
          availableAgents: context.availableAgents.map((a) => ({
            agentId: a.agentId,
            agentName: a.agentName,
          })),
        },
        "[run_public_agent] Agent selection details",
      )

      const agentCapability = context.availableAgents.find(
        (agent) => agent.agentId === validation.data.agentId,
      )
      if (!agentCapability) {
        return ToolResponse.error(
          ToolErrorCodes.NOT_FOUND,
          `Agent '${validation.data.agentId}' not found in availableAgents. Call list_custom_agents and use one of: ${context.availableAgents
            .map((a) => `${a.agentName} (${a.agentId})`)
            .join("; ")}`,
        )
      }

      const delegatedAgentName =
        context.availableAgents.find(
          (a) => a.agentId === validation.data.agentId,
        )?.agentName || validation.data.agentId

      // Generate the delegation ID here, inside this isolated execute() scope.
      // Each parallel run_public_agent call runs its own execute(), so there is
      // no shared mutable state and no overwrite race regardless of parallelism.
      const delegationRunId = generateRunId()

      // Emit agentDelegated now — later than tool_requests but race-free.
      if (context.runtime?.emitReasoning) {
        await context.runtime.emitReasoning(
          ReasoningSteps.agentDelegated(
            delegatedAgentName,
            delegationRunId,
          ) as ReasoningEventPayload,
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
        parentTurn: Math.max(
          context.turnCount ?? MIN_TURN_NUMBER,
          MIN_TURN_NUMBER,
        ),
        stopSignal: context.stopSignal,
        delegationRunId,
        reasoningEmitter: context.runtime?.emitReasoning
          ? async (payload: ReasoningEventPayload) => {
              const withAgent: ReasoningEventPayload = {
                ...payload,
                agent: delegatedAgentName,
                delegationRunId,
                parentAgent: "Main",
              }
              await context.runtime!.emitReasoning!(withAgent)
            }
          : undefined,
      })
      Logger.debug(
        { params: validation.data, email: context.user.email },
        "[run_public_agent] input params",
      )
      Logger.debug(
        { toolOutput, email: context.user.email },
        "[run_public_agent] tool output",
      )
      context.usedAgents.push(agentCapability.agentId)
      logContextMutation(
        context,
        "[run_public_agent] Added agent to usedAgents",
        {
          selectedAgentId: agentCapability.agentId,
          selectedAgentName: agentCapability.agentName,
          query: validation.data.query,
        },
      )

      if (toolOutput.error) {
        return ToolResponse.error("EXECUTION_FAILED", toolOutput.error)
      }

      const metadata = toolOutput.metadata || {}
      const metadataFragments = Array.isArray((metadata as any).fragments)
        ? ((metadata as any).fragments as MinimalAgentFragment[])
        : []
      const fragments =
        metadataFragments.length > 0
          ? metadataFragments
          : Array.isArray(toolOutput.contexts)
            ? toolOutput.contexts.map((item) => {
                const source = (item as any).source || {}
                const normalizedSource: Citation = {
                  ...source,
                  docId: source.docId || item.id || "",
                  title: source.title || "Untitled",
                  url: source.url || "",
                  app: (source.app || Apps.Xyne) as Apps,
                  entity: source.entity as Citation["entity"],
                }
                return {
                  id: item.id,
                  content: item.content,
                  source: normalizedSource,
                  confidence: item.confidence ?? 0.7,
                } as MinimalAgentFragment
              })
            : []
      const rawDocumentsUnfiltered = Array.isArray((metadata as any).rawDocuments)
        ? ((metadata as any).rawDocuments as ToolRawDocument[])
        : []
      const citations = Array.isArray((metadata as any).citations)
        ? ((metadata as any).citations as Citation[])
        : []
      const citedDocIds = new Set(
        citations.map((c) => c?.docId).filter((id): id is string => !!id),
      )
      const rawDocuments =
        citedDocIds.size === 0
          ? []
          : rawDocumentsUnfiltered.filter((d) => citedDocIds.has(d.docId))
      const resultSummary =
        typeof toolOutput.result === "string"
          ? toolOutput.result
          : "Delegated agent completed."

      return ToolResponse.success({
        resultSummary,
        rawDocuments,
        fragments,
        agentId: validation.data.agentId,
        // Pass back so afterToolExecutionHook can tag agentCompleted with the
        // same ID — no shared mutable context needed.
        delegationRunId,
        citations: (metadata as any).citations || [],
        imageCitations: (metadata as any).imageCitations || [],
      })
    },
  }
}

function createFinalSynthesisTool(): Tool<unknown, AgentRunContext> {
  return {
    schema: {
      name: XyneTools.synthesizeFinalAnswer,
      description: TOOL_SCHEMAS.synthesize_final_answer.description,
      parameters: toToolParameters(
        TOOL_SCHEMAS.synthesize_final_answer.inputSchema,
      ),
    },
    async execute(args, context) {
      const validation = validateToolInput<{
        insightsUsefulForAnswering?: string
      }>(XyneTools.synthesizeFinalAnswer, args)
      if (!validation.success) {
        return ToolResponse.error("INVALID_INPUT", validation.error.message)
      }
      const insightsUsefulForAnswering = sanitizeInsightsUsefulForAnswering(
        validation.data.insightsUsefulForAnswering,
      )
      const mutableContext = mutableAgentContext(context)
      if (!mutableContext.review.lockedByFinalSynthesis) {
        mutableContext.review.lockedByFinalSynthesis = true
        mutableContext.review.lockedAtTurn =
          mutableContext.turnCount ?? MIN_TURN_NUMBER
        logContextMutation(
          mutableContext,
          "[MessageAgents][FinalSynthesis] Locked review state for synthesis",
          {
            lockedAtTurn: mutableContext.review.lockedAtTurn,
          },
        )
        loggerWithChild({ email: context.user.email }).info(
          {
            chatId: context.chat.externalId,
            turn: mutableContext.review.lockedAtTurn,
          },
          "[MessageAgents][FinalSynthesis] Review lock activated after synthesis tool call.",
        )
      }
      if (
        mutableContext.finalSynthesis.requested &&
        mutableContext.finalSynthesis.completed
      ) {
        return ToolResponse.error(
          "EXECUTION_FAILED",
          "Final synthesis already completed for this run.",
        )
      }

      const streamAnswer = mutableContext.runtime?.streamAnswerText
      if (!streamAnswer) {
        return ToolResponse.error(
          "EXECUTION_FAILED",
          "Streaming channel unavailable. Cannot deliver final answer.",
        )
      }

      const synthesisRequest = await buildFinalSynthesisRequest(context, {
        insightsUsefulForAnswering,
      })
      const { systemPrompt, userMessage, messages } = synthesisRequest
      const fragments = await getFragmentsForSynthesis(context.documentMemory, {
        email: context.user.email,
        userId: context.user.numericId ?? undefined,
        workspaceId: context.user.workspaceNumericId ?? undefined,
      })
      const docOrder = fragments.map((f) => f.id)
      const {
        imageFileNamesForModel: selected,
        total,
        dropped,
      } = IMAGE_CONTEXT_CONFIG.enabled
        ? getAllImagesFromDocumentMemory(context.documentMemory, {
            docOrder,
            maxImages: IMAGE_CONTEXT_CONFIG.maxImagesPerCall,
          })
        : { imageFileNamesForModel: [], total: 0, dropped: 0 }

      const attachmentImageCount = Array.from(context.documentMemory.values())
        .flatMap((d) => d.images ?? [])
        .filter((img) => img.isAttachment).length

      loggerWithChild({ email: context.user.email }).debug(
        {
          chatId: context.chat.externalId,
          selectedImages: selected,
          totalImages: total,
          droppedImages: dropped,
          attachmentImageCount,
        },
        "[MessageAgents][FinalSynthesis] Image payload",
      )
      const fragmentsCount = fragments.length
      const hasEpisodicMemories = !!context.episodicMemoriesText?.trim()
      const hasChatMemory = !!sanitizeChatMemoryForLLMContext(
        context.chatMemoryText,
      )
      loggerWithChild({ email: context.user.email }).debug(
        {
          chatId: context.chat.externalId,
          finalSynthesisSystemPrompt: systemPrompt,
          finalSynthesisUserMessage: userMessage,
          conversationHistoryCount: context.conversationHistoryMessages.length,
          hasInsightsUsefulForAnswering: !!insightsUsefulForAnswering,
          hasEpisodicMemories,
          hasChatMemory,
        },
        "[MessageAgents][FinalSynthesis] Full context payload",
      )

      mutableContext.finalSynthesis.requested = true
      mutableContext.finalSynthesis.suppressAssistantStreaming = true
      mutableContext.finalSynthesis.completed = false
      mutableContext.finalSynthesis.streamedText = ""
      logContextMutation(
        mutableContext,
        "[MessageAgents][FinalSynthesis] Updated final synthesis state to requested",
        {
          fragmentsCount,
          selectedImages: selected,
          totalImages: total,
          droppedImages: dropped,
          conversationHistoryCount: context.conversationHistoryMessages.length,
          hasInsightsUsefulForAnswering: !!insightsUsefulForAnswering,
          hasEpisodicMemories,
          hasChatMemory,
        },
      )

      await mutableContext.runtime?.emitReasoning?.(
        ReasoningSteps.synthesisStarted(fragmentsCount),
      )

      const logger = loggerWithChild({ email: context.user.email })
      if (dropped > 0) {
        logger.info(
          {
            droppedCount: dropped,
            limit: IMAGE_CONTEXT_CONFIG.maxImagesPerCall,
            totalImages: total,
          },
          "Final synthesis image limit enforced; dropped oldest references.",
        )
      }

      const modelId =
        (context.modelId as Models) ||
        (defaultBestModel as Models) ||
        Models.Gpt_4o
      const modelParams: ModelParams = {
        modelId,
        systemPrompt,
        stream: true,
        temperature: 0.2,
        max_new_tokens: context.maxOutputTokens ?? 8192,
        imageFileNames: selected,
      }

      Logger.debug(
        {
          email: context.user.email,
          chatId: context.chat.externalId,
          fragmentsCount: fragments.length,
          planPresent: !!context.plan,
          clarificationsCount: context.clarifications.length,
          toolOutputsThisTurn: context.currentTurnArtifacts.toolOutputs.length,
          imageNames: selected,
          conversationHistoryCount: context.conversationHistoryMessages.length,
          hasInsightsUsefulForAnswering: !!insightsUsefulForAnswering,
          hasEpisodicMemories,
          hasChatMemory,
        },
        "[MessageAgents][FinalSynthesis] Context summary for synthesis call",
      )

      Logger.debug(
        {
          email: context.user.email,
          chatId: context.chat.externalId,
          modelId,
          systemPrompt,
          messagesCount: messages.length,
          imagesProvided: selected.length,
          conversationHistoryCount: context.conversationHistoryMessages.length,
          hasInsightsUsefulForAnswering: !!insightsUsefulForAnswering,
          hasEpisodicMemories,
          hasChatMemory,
        },
        "[MessageAgents][FinalSynthesis] LLM call parameters",
      )

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
        logContextMutation(
          context,
          "[MessageAgents][FinalSynthesis] Marked final synthesis as completed",
          {
            streamedCharacters,
            estimatedCostUsd,
            imagesProvided: selected,
          },
        )
        loggerWithChild({ email: context.user.email }).debug(
          {
            chatId: context.chat.externalId,
            streamedCharacters,
            estimatedCostUsd,
            imagesProvided: selected,
          },
          "[MessageAgents][FinalSynthesis] LLM call completed",
        )

        await context.runtime?.emitReasoning?.(
          ReasoningSteps.synthesisCompleted(),
        )

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
          },
        )
      } catch (error) {
        context.finalSynthesis.suppressAssistantStreaming = false
        context.finalSynthesis.requested = false
        context.finalSynthesis.completed = false
        logContextMutation(
          context,
          "[MessageAgents][FinalSynthesis] Reset final synthesis state after failure",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        )
        logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          "Final synthesis tool failed.",
        )
        return ToolResponse.error(
          "EXECUTION_FAILED",
          `Failed to synthesize final answer: ${
            error instanceof Error ? error.message : String(error)
          }`,
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
${summaryLine}

Attachment handling:
1. Inspect the attachment fragments below.
2. If the attachments fully answer the user's request → respond using citations (see format below).
3. If the attachments are partial or incomplete → create a plan with toDoWrite and run the tools needed to fill the gaps in the same turn.
4. State that information is unavailable only after the attachments and available tools have been used and the answer still cannot be found.

# Response and citations
- Use the provided files and chunks as your knowledge base. Treat \`Index {docId} ...\` as the start of a document and [0], [1], [2] as chunk indices within that document.
- Cite every factual statement with the exact chunk: K[docId_chunkIndex] (docId from the file header, chunkIndex from the bracketed number). Example: "X is true K[3_12]." Use at most 1-2 citations per sentence; for two chunks use two citations: "... K[3_12] ... K[1_0]".
- Place the citation immediately after the claim. Only cite information that appears in or is directly inferable from the cited chunk; if you cannot ground a claim, omit it.
- Keep tone professional and concise; note inconsistencies across chunks when relevant and acknowledge gaps when the chunks lack detail.
`.trim()
}

function buildAgentInstructions(
  context: AgentRunContext,
  enabledToolNames: string[],
  dateForAI: string,
  agentPrompt?: string,
  delegationEnabled = true,
): string {
  const availableToolNames = enabledToolNames.filter((tool) => context.enabledTools.has(tool))
  const toolDescriptions = availableToolNames.length > 0
    ? generateToolDescriptions(availableToolNames)
    : "No tools available yet. "

  const cooldownMgr = new ToolCooldownManager(context.failedTools)
  const toolsInCooldown = enabledToolNames
    .filter((t) => !context.enabledTools.has(t) && cooldownMgr.isInCooldown(t, context.turnCount))
    .map((name) => ({ name, info: cooldownMgr.getCooldownInfo(name)! }))
  const cooldownBlock =
    toolsInCooldown.length > 0
      ? [
          "",
          "<tools_in_cooldown>",
          "The following tools are temporarily disabled due to repeated failures. Use other tools or data sources instead.",
          ...toolsInCooldown.map(
            ({ name, info }) =>
              `- ${name}: failed ${info.count}x (last: ${info.lastError || "error"}), ${info.cooldownUntilTurn - context.turnCount} turn(s) remaining.`
          ),
          "</tools_in_cooldown>",
          "",
        ].join("\n")
      : ""

  const agentSection = agentPrompt ? `\n\nAgent Constraints:\n${agentPrompt}` : ""
  const attachmentDirective = buildAttachmentDirective(context)
  const promptAddendum = buildAgentPromptAddendum()
  const reviewResultBlock =
    context.review.lastReviewResult
      ? [
          "<last_review_result>",
          JSON.stringify(context.review.lastReviewResult, null, 2),
          "</last_review_result>",
          "",
        ].join("\n")
      : ""

  let planSection = "\n<plan>\n"
  if (context.plan) {
    planSection += `Goal: ${context.plan.goal}\n\n`
    planSection += "Steps:\n"
    context.plan.subTasks.forEach((task, i) => {
      const status =
        task.status === "completed"
          ? "✓"
          : task.status === "in_progress"
            ? "→"
            : task.status === "failed"
              ? "✗"
              : "○"
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
    : ""

  const isFirstTurn = context.turnCount === 1
  const workingMemoryMessages = config.MEMORY_CONFIG?.WORKING_MEMORY_MESSAGES ?? 6
  const conversationContext = isFirstTurn ? `You are given only the last ${workingMemoryMessages} messages of this chat in context. Use \`searchChatHistory\` when you need to recall or search older messages.` : '';

  const instructionLines: string[] = [
    "You are Xyne, an enterprise search assistant with agentic capabilities.",
    "",
    `The current date is: ${dateForAI}`,
    "",
    "<context>",
    `User: ${context.user.email}`,
    `Workspace: ${context.user.workspaceId}`,
    conversationContext,
    "</context>",
    "",
  ]

  instructionLines.push(
    "<available_tools>",
    toolDescriptions,
    "</available_tools>",
    cooldownBlock,
  )

  if (agentSection.trim()) {
    instructionLines.push(agentSection.trim(), "")
  }

  instructionLines.push(planSection.trim(), "")

  if (attachmentDirective) {
    instructionLines.push(attachmentDirective, "")
  }

  instructionLines.push(promptAddendum.trim())

  if (reviewResultBlock) {
    instructionLines.push("", reviewResultBlock.trim(), "")
  }

  if (context.review.lastReviewResult) {
    instructionLines.push(
      "# REVIEW FEEDBACK",
      "- Inspect the <last_review_result> block above; treat every instruction, anomaly, and clarification inside it as mandatory.",
      "- Example: if the review notes “Tool X lacked evidence,” reopen that sub-task, add a step to fetch the missing evidence, and mark status accordingly before launching tools.",
      "- Log every required fix directly in the plan so auditors can see alignment with the review.",
      "- When the review lists anomalies or ambiguity, capture each as a corrective sub-task (e.g., “Validate source for claim [2]”) and close it before moving forward.",
      "- Answer outstanding clarification questions immediately; if the user must respond, surface the exact question back to them.",
      "",
    )
  }

  instructionLines.push(
    "# PLANNING",
    "- Call toDoWrite at the start of a turn when the plan is new, when review requested changes, or when you need to add or close tasks; otherwise you may proceed without calling toDoWrite to avoid unnecessary iterations.",
    "- Terminate the active plan the moment you have enough evidence to cater to the complete requirement of the user; immediately drop any remaining subtasks when the goal is satisfied.",
    "- Scale the number of subtasks to the query’s true complexity , however quality of the final answer and complete execution and satisfaction of user's query outranks task count, you must always prioritize quality",
    ...(context.review.lastReviewResult
      ? [
          "- If the review reports `planChangeNeeded=true`, rewrite the plan around the provided `planChangeReason` before running any new tools, even if older tasks were mid-flight.",
          "- Mirror every `toolFeedback.followUp` and `unmetExpectations` item with a dedicated sub-task (or reopened task) and list the tools that will satisfy it.",
          "- Track each `clarificationQuestions` entry as its own sub-task or outbound user question until the ambiguity is resolved inside <last_review_result>.",
          "- If review feedback demands a brand-new approach, rebuild the plan; otherwise refine the existing tasks.",
          "- If no plan change is needed, explicitly mark the tasks `in_progress` or `completed` so the reviewer sees momentum.",
        ] : []),
    "- Maintain one sub-task per concrete goal; list only the tools truly needed for that sub-task.",
    "- Only chain subtasks when real dependencies exist—for example, “fetch the people who messaged me today → gather the emails received from them → summarize the combined thread” keeps later steps paused until earlier outputs arrive.",
    "- After every tool run, immediately update the active sub-task’s status, result, and any newly required tasks so the plan mirrors reality.",
    "- Never finish a turn after only calling toDoWrite—run at least one execution tool that advances the active task.",
    "# EXECUTION STRATEGY",
    "- Work tasks sequentially; complete the current task before starting the next.",
    "- Call tools with precise parameters tied to the sub-task goal; reuse stored fragments instead of re-fetching data.",
  )

  const hasDelegationTools =
    enabledToolNames.includes(XyneTools.listCustomAgents) &&
    enabledToolNames.includes(XyneTools.runPublicAgent)
  if (delegationEnabled && hasDelegationTools) {
    instructionLines.push(
      "- When delegation is enabled and justified, run list_custom_agents before run_public_agent; document why the selected agent accelerates the plan.",
      "- Prefer list_custom_agents → run_public_agent before core tools when delegation is enabled and justified by the plan.",
      "- Invoke list_custom_agents at the sub-task level whenever targeted delegation could unlock better results; multi-part queries may require multiple calls as the context evolves.",
      "- Let earlier tool outputs reshape later sub-tasks (e.g., if getSlackRelatedMessages returns only Finance senders, rewrite the next list_custom_agents query with that Finance focus before proceeding).",
    )
  }

  instructionLines.push(
    "- Obey the `recommendation` flag: pause for clarifications when it reads `clarify_query`, keep collecting data for `gather_more`, and do not progress until a fresh plan is in place for `replan`.",
    "- If anomalies or notes in the latest review call out missing evidence, misalignments, or unresolved questions, fix those items before progressing and explain the remediation in the plan.",
    "",
    "# TOOL CALLS & EXPECTATIONS",
    "- Use the model's native function/tool-call interface. Provide clean JSON arguments.",
    "- Do NOT wrap tool calls in custom XML—JAF already handles execution.",
    delegationGuidance,
    "- After you decide which tools to call, emit a standalone expected-results block summarizing what each tool should achieve:",
    "<expected_results>",
    "[",
    "  {",
    '    "toolName": "searchGlobal",',
    '    "goal": "Find Q4 ARR mentions",',
    '    "successCriteria": ["ARR keyword present", "Dated Q4"],',
    '    "failureSignals": ["No ARR context"],',
    '    "stopCondition": "After 2 unsuccessful searches"',
    "  }",
    "]",
    "</expected_results>",
    "- Include one entry per tool invocation you intend to make. These expectations feed automatic review, so keep them specific and measurable.",
    "",
    "# CONSTRAINT HANDLING",
    "- When the user requests an action the available tools cannot execute, produce the closest actionable substitute (draft, checklist, instructions) so progress continues.",
    "- State the exact limitation and what manual follow-up the user must perform to finish.",
    "",
    "# FINAL SYNTHESIS",
    "- When research is complete and evidence is locked, CALL `synthesize_final_answer` with optional `insightsUsefulForAnswering` guidance when it will help the final answer model emphasize the right conclusions or ordering. This tool composes and streams the response.",
    "- Never output the final answer directly—always go through the tool and then acknowledge completion.",
  )

  const finalInstructions = instructionLines.join("\n")

  // Logger.debug({
  //   email: context.user.email,
  //   chatId: context.chat.externalId,
  //   turnCount: context.turnCount,
  //   instructionsLength: finalInstructions.length,
  //   enabledToolsCount: enabledToolNames.length,
  //   hasPlan: !!context.plan,
  //   delegationEnabled,
  // }, "[MessageAgents] Final agent instructions built")

  // Logger.debug({
  //   email: context.user.email,
  //   chatId: context.chat.externalId,
  //   instructions: finalInstructions,
  // }, "[MessageAgents] FULL AGENT INSTRUCTIONS")

  return finalInstructions
}

/**
 * MessageAgents - JAF-based agentic flow
 *
 * Primary implementation for agentic conversations when web search and deep
 * research are disabled. Activated either explicitly via query flag or by the
 * MessageApi router when the request qualifies for agentic handling.
 */
export async function MessageAgents(c: Context): Promise<Response> {
  const tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("MessageAgents")

  const { sub: email, workspaceId } = c.get(JwtPayloadKey)

  try {
    loggerWithChild({ email }).info("MessageAgents agentic flow starting")
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
      selectedModelConfig,
    }: {
      message: string
      chatId?: string
      agentId?: string
      toolsList?: Array<{ connectorId: string; tools: string[] }>
      selectedModelConfig?: string
    } = body

    if (!message) {
      throw new HTTPException(400, { message: "Message is required" })
    }

    message = safeDecodeURIComponent(message)
    rootSpan.setAttribute("message", message)
    rootSpan.setAttribute("chatId", chatId || "new")

    let parsedModelId: string | undefined = undefined
    let isReasoningEnabled = false
    let enableWebSearch = false
    let isDeepResearchEnabled = false

    if (selectedModelConfig) {
      try {
        const modelConfig = JSON.parse(selectedModelConfig)
        parsedModelId = modelConfig.model
        isReasoningEnabled = modelConfig.reasoning === true
        enableWebSearch = modelConfig.websearch === true
        isDeepResearchEnabled = modelConfig.deepResearch === true

        if (
          modelConfig.capabilities &&
          !isReasoningEnabled &&
          !enableWebSearch &&
          !isDeepResearchEnabled
        ) {
          if (Array.isArray(modelConfig.capabilities)) {
            isReasoningEnabled = modelConfig.capabilities.includes("reasoning")
            enableWebSearch = modelConfig.capabilities.includes("websearch")
            isDeepResearchEnabled =
              modelConfig.capabilities.includes("deepResearch")
          } else if (typeof modelConfig.capabilities === "object") {
            isReasoningEnabled = modelConfig.capabilities.reasoning === true
            enableWebSearch = modelConfig.capabilities.websearch === true
            isDeepResearchEnabled =
              modelConfig.capabilities.deepResearch === true
          }
        }

        loggerWithChild({ email }).debug(
          `Parsed model config for MessageAgents: model="${parsedModelId}", reasoning=${isReasoningEnabled}, websearch=${enableWebSearch}, deepResearch=${isDeepResearchEnabled}`,
        )
      } catch (error) {
        loggerWithChild({ email }).warn(
          error,
          "Failed to parse selectedModelConfig JSON in MessageAgents. Using defaults.",
        )
        parsedModelId = config.defaultBestModel
      }
    } else {
      parsedModelId = config.defaultBestModel
      loggerWithChild({ email }).debug(
        "No model config provided to MessageAgents, using default",
      )
    }

    let actualModelId: string = parsedModelId || config.defaultBestModel
    if (parsedModelId) {
      const convertedModelId = getModelValueFromLabel(parsedModelId)
      if (convertedModelId) {
        actualModelId = convertedModelId as string
        loggerWithChild({ email }).debug(
          `Converted model label "${parsedModelId}" to value "${actualModelId}" for MessageAgents`,
        )
      } else if (parsedModelId in Models) {
        actualModelId = parsedModelId
        loggerWithChild({ email }).debug(
          `Using model ID "${parsedModelId}" directly for MessageAgents`,
        )
      } else {
        loggerWithChild({ email }).error(
          `Invalid model: ${parsedModelId}. Model not found in label mappings or Models enum for MessageAgents.`,
        )
      }
    }

    const agenticModelId = resolveAgenticModelId(actualModelId)
    rootSpan.setAttribute("selectedModelId", actualModelId)
    rootSpan.setAttribute("agenticModelId", agenticModelId)
    rootSpan.setAttribute("reasoningEnabled", isReasoningEnabled)
    rootSpan.setAttribute("webSearchEnabled", enableWebSearch)
    rootSpan.setAttribute("deepResearchEnabled", isDeepResearchEnabled)

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

    const isMsgWithContext = isMessageWithContext(message)
    const extractedInfo = isMsgWithContext
      ? await extractFileIdsFromMessage(message, email)
      : {
          totalValidFileIdsFromLinkCount: 0,
          fileIds: [],
          threadIds: [],
        }
    let attachmentsForContext =
      extractedInfo?.fileIds.map((fileId) => ({
        fileId,
        isImage: false,
      })) || []
    const attachmentMetadata = parseAttachmentMetadata(c)
    attachmentsForContext = attachmentsForContext.concat(
      attachmentMetadata.map((meta) => ({
        fileId: meta.fileId,
        isImage: meta.isImage,
      })),
    )
    const threadIds = extractedInfo?.threadIds || []
    const referencedFileIds = Array.from(
      new Set(
        attachmentsForContext
          .filter((meta) => !meta.isImage)
          .flatMap((meta) => expandSheetIds(meta.fileId)),
      ),
    )
    let allReferencedFileIds = referencedFileIds
    const imageAttachmentFileIds = Array.from(
      new Set(
        attachmentsForContext
          .filter((meta) => meta.isImage)
          .map((meta) => meta.fileId),
      ),
    )

    const userAndWorkspace: InternalUserWorkspace =
      await getUserAndWorkspaceByEmail(db, workspaceId, email)
    const rawUser = userAndWorkspace.user
    const rawWorkspace = userAndWorkspace.workspace
    const user = {
      id: Number(rawUser.id),
      email: String(rawUser.email),
      timeZone: typeof rawUser.timeZone === "string" ? rawUser.timeZone : "UTC",
    }
    const workspace = {
      id: Number(rawWorkspace.id),
      externalId: String(rawWorkspace.externalId),
    }
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
        user.id,
      )
      if (!agentRecord) {
        throw new HTTPException(403, {
          message:
            "Access denied: You do not have permission to use this agent",
        })
      }
      resolvedAgentId = String(agentRecord.externalId)
      agentPromptForLLM = JSON.stringify(agentRecord)
      allowedAgentApps = deriveAllowedAgentApps(agentPromptForLLM)
      rootSpan.setAttribute("agentId", resolvedAgentId)
    }
    const userTimezone: string = user.timeZone || "UTC"
    const dateForAI = getDateForAI({ userTimeZone: userTimezone })
    const userMetadata: UserMetadataType = {
      userTimezone,
      dateForAI,
      userId: user.id,
      workspaceId: workspace.id,
    }
    const userCtxString = userContext(userAndWorkspace)

    let chatRecord: SelectChat
    let lastPersistedMessageId = 0
    let lastPersistedMessageExternalId = ""
    /** User message externalId; used to persist errorMessage when the agent loop fails. */
    let userMessageExternalId = ""
    let attachmentStorageError: Error | null = null
    let previousConversationHistory: SelectMessage[] = []

    try {
      const bootstrap = await ensureChatAndPersistUserMessage({
        chatId,
        email,
        user: { id: user.id, email: user.email },
        workspace: { id: workspace.id, externalId: workspace.externalId },
        message,
        fileIds: referencedFileIds,
        attachmentMetadata,
        modelId: agenticModelId,
        agentId: resolvedAgentId ?? undefined,
      })
      chatRecord = bootstrap.chat
      lastPersistedMessageId = bootstrap.userMessage.id as number
      lastPersistedMessageExternalId = String(bootstrap.userMessage.externalId)
      userMessageExternalId = lastPersistedMessageExternalId
      attachmentStorageError = bootstrap.attachmentError ?? null
      previousConversationHistory = bootstrap.conversationHistory ?? []
      const historyFileIds = collectReferencedFileIdsUntilCompaction(
        previousConversationHistory,
      )
      allReferencedFileIds = Array.from(
        new Set([
          ...referencedFileIds,
          ...historyFileIds.flatMap((id) => expandSheetIds(id)),
        ]),
      )
      const chatAgentId = chatRecord.agentId
        ? String(chatRecord.agentId)
        : undefined
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
        "Failed to persist user turn for MessageAgents",
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
    rootSpan.setAttribute("chatId", String(chatRecord.externalId))
    rootSpan.setAttribute(
      "conversation_history_count",
      previousConversationHistory.length,
    )

    if (
      resolvedAgentId &&
      !agentRecord &&
      resolvedAgentId !== DEFAULT_TEST_AGENT_ID
    ) {
      agentRecord = await getAgentByExternalIdWithPermissionCheck(
        db,
        resolvedAgentId,
        workspace.id,
        user.id,
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
    const dedicatedAgentSystemPrompt =
      typeof agentRecord?.prompt === "string" &&
      agentRecord.prompt.trim().length > 0
        ? agentRecord.prompt.trim()
        : undefined
    const delegationEnabled = !hasExplicitAgent

    // Multi-agent streaming: only this callback owns the HTTP connection. All agents (main + delegated)
    // emit reasoning via the shared ReasoningEmitter → same stream. Delegated agents must NOT open
    // their own stream; they receive the parent emitter and only stream answer tokens from the main run.
    return streamSSE(c, async (stream) => {
      const requestStartMs = Date.now()
      const stopController = new AbortController()
      const streamKey = String(chatRecord.externalId)
      let agentContextRef: AgentRunContext | null = null
      const markStop = () => {
        if (agentContextRef) {
          agentContextRef.stopRequested = true
        }
      }
      stopController.signal.addEventListener("abort", markStop)
      activeStreams.set(streamKey, { stream, stopController })

      if (!chatId) {
        await stream.writeSSE({
          event: ChatSSEvents.ChatTitleUpdate,
          data: String(chatRecord.title) || "Untitled",
        })
      }

      const mcpClients: Array<{ close?: () => Promise<void> }> = []
      const persistTrace = async (
        messageId: number,
        messageExternalId: string,
      ) => {
        try {
          const traceJson = tracer.serializeToJson()
          await insertChatTrace({
            workspaceId: workspace.id as number,
            userId: user.id as number,
            chatId: chatRecord.id as number,
            messageId: messageId as number,
            chatExternalId: chatRecord.externalId as string,
            email: user.email as string,
            messageExternalId: messageExternalId as string,
            traceJson,
          })
        } catch (traceError) {
          loggerWithChild({ email }).error(
            traceError,
            "Failed to persist chat trace",
          )
        }
      }
      const persistTraceForLastMessage = async () => {
        if (lastPersistedMessageId > 0 && lastPersistedMessageExternalId) {
          await persistTrace(
            lastPersistedMessageId,
            lastPersistedMessageExternalId,
          )
        }
      }
      try {
        let thinkingLog = ""
        let mainRunIdRef: ReturnType<typeof generateRunId> | undefined
        const emitReasoningStep: ReasoningEmitter = async (
          payload: ReasoningEventPayload,
        ) => {
          if (stream.closed) return
          // Attach orchestration metadata
          const withMeta: ReasoningEventPayload = {
            ...payload,
            runId: mainRunIdRef != null ? String(mainRunIdRef) : undefined,
            turnNumber: payload.turnNumber ?? agentContextRef?.turnCount,
            parentAgent: payload.parentAgent ?? undefined,
          }
          thinkingLog += `${JSON.stringify(withMeta)}\n`
          await stream.writeSSE({
            event: ChatSSEvents.Reasoning,
            data: JSON.stringify(withMeta),
          })
        }

        // Set runId before any emitReasoningStep so early events (e.g. attachmentAnalyzing, attachmentExtracted) carry a stable runId
        mainRunIdRef = generateRunId()

        // Initialize context with actual data
        const agentContext = initializeAgentContext(
          email,
          String(workspaceId),
          user.id,
          String(chatRecord.externalId),
          message,
          attachmentsForContext,
          {
            userContext: userCtxString,
            workspaceNumericId: workspace.id,
            agentPrompt: agentPromptForLLM,
            dedicatedAgentSystemPrompt,
            chatId: chatRecord.id as number,
            stopController,
            modelId: agenticModelId,
          },
        )
        agentContextRef = agentContext
        agentContext.delegationEnabled = delegationEnabled
        logContextMutation(
          agentContext,
          "[MessageAgents][Context] Updated delegationEnabled for primary run",
          {
            delegationEnabled,
            hasExplicitAgent,
            resolvedAgentId,
          },
        )

        // Episodic: when inside an agent (!delegationEnabled), search within this agent's chats; when delegation (no agent), search globally.
        // Chat memory: always search within current chat only (no chatId => empty from vespa-ts).
        const episodicChatIds: string[] | undefined = delegationEnabled
          ? undefined
          : resolvedAgentId
            ? await getChatExternalIdsByAgentId(db, resolvedAgentId, email)
            : undefined

        // Memory retrieval is best-effort; failures should not block message handling
        let episodicMemories: Awaited<ReturnType<typeof retrieveEpisodicMemories>> = []
        let chatMemoryChunks: Awaited<ReturnType<typeof retrieveRelevantChatHistory>> = []
        try {
          const [episodicResults, chatMemoryResults] = await Promise.all([
            retrieveEpisodicMemories({
              query: message,
              email,
              workspaceId: String(workspaceId),
              chatIds: episodicChatIds,
              limit: 5,
            }),
            retrieveRelevantChatHistory({
              query: message,
              chatId: String(chatRecord.externalId),
              email,
              workspaceId: String(workspaceId),
              limit: 5,
            }),
          ])
          episodicMemories = episodicResults
          chatMemoryChunks = chatMemoryResults
        } catch (memoryError) {
          // Log error but continue processing without memory context
          loggerWithChild({ email }).warn(
            memoryError,
            "[MessageAgents] Memory retrieval failed, continuing without memory context",
          )
        }
        agentContext.episodicMemoriesText =
          episodicMemories.length > 0
            ? episodicMemories
                .map(
                  (m) =>
                    `- [${m.memoryType}] ${m.memoryText} (chatId: ${m.sourceChatId})`,
                )
                .join("\n")
            : undefined
        agentContext.chatMemoryText =
          chatMemoryChunks.length > 0
            ? chatMemoryChunks
                .map(
                  (c) =>
                    `User: ${c.userMessage}\nAssistant thinking: ${c.assistantThinking}\nAssistant: ${c.assistantMessage}`,
                )
                .join("\n\n")
            : undefined

        // Build MCP connector tool map using the legacy agentic semantics
        const finalToolsMap: FinalToolsList = {}
        type FinalToolsEntry = FinalToolsList[string]
        type AdapterTool = FinalToolsEntry["tools"][number]
        const connectorMetaById = new Map<
          string,
          { name?: string; description?: string }
        >()

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
              version:
                (connector.config as { version?: string })?.version ?? "1.0",
            })
            const connectorNumericId = Number(connector.id)

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
                loggerWithChild({ email }).debug(
                  `Connecting to MCP client at ${loadedUrl} with mode: ${loadedMode}`,
                )

                if (loadedMode === "streamable-http") {
                  const transportOptions: StreamableHTTPClientTransportOptions =
                    {
                      requestInit: { headers: loadedHeaders },
                    }
                  await client.connect(
                    new StreamableHTTPClientTransport(
                      new URL(loadedUrl),
                      transportOptions,
                    ),
                  )
                } else {
                  const transportOptions: SSEClientTransportOptions = {
                    requestInit: { headers: loadedHeaders },
                  }
                  await client.connect(
                    new SSEClientTransport(
                      new URL(loadedUrl),
                      transportOptions,
                    ),
                  )
                }
              } else if (loadedConfig.command) {
                loggerWithChild({ email }).debug(
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
              tools = await getToolsByConnectorId(
                db,
                workspace.id,
                connectorNumericId,
              )
            } catch (error) {
              loggerWithChild({ email }).error(
                error,
                `[MessageAgents][MCP] Failed to fetch tools for connector ${connectorId}`,
              )
              continue
            }
            const filteredTools = tools.filter((tool) => {
              const toolExternalId =
                typeof tool.externalId === "string"
                  ? tool.externalId
                  : undefined
              const isIncluded =
                !!toolExternalId && requestedToolIds.includes(toolExternalId)
              if (!isIncluded) {
                loggerWithChild({ email }).debug(
                  `[MessageAgents][MCP] Tool ${toolExternalId}:${tool.toolName} not in requested toolExternalIds.`,
                )
              }
              return isIncluded
            })

            const formattedTools: FinalToolsEntry["tools"] = filteredTools
              .map((tool): AdapterTool | null => {
                const toolNameValue =
                  typeof tool.toolName === "string" ? tool.toolName : ""
                const toolName = toolNameValue.trim()
                if (!toolName) return null
                return {
                  toolName,
                  toolSchema:
                    typeof tool.toolSchema === "string"
                      ? tool.toolSchema
                      : undefined,
                  description:
                    typeof tool.description === "string"
                      ? tool.description
                      : undefined,
                }
              })
              .filter((entry): entry is AdapterTool => Boolean(entry))

            if (formattedTools.length === 0) {
              continue
            }

            const wrappedClient: FinalToolsEntry["client"] = {
              callTool: async ({ name, arguments: toolArguments }) => {
                const normalizedArgs =
                  toolArguments &&
                  typeof toolArguments === "object" &&
                  !Array.isArray(toolArguments)
                    ? (toolArguments as Record<string, unknown>)
                    : {}
                return client.callTool({
                  name,
                  arguments: normalizedArgs,
                })
              },
              close: () => client.close(),
            }

            const safeConnectorId = String(connector.id)
            finalToolsMap[safeConnectorId] = {
              tools: formattedTools,
              client: wrappedClient,
              metadata: connectorMetaById.get(safeConnectorId),
            }
            const connectorRecord = connector as Record<string, unknown>
            connectorMetaById.set(safeConnectorId, {
              name:
                typeof connector.name === "string"
                  ? connector.name
                  : `Connector ${safeConnectorId}`,
              description:
                typeof connectorRecord.description === "string"
                  ? (connectorRecord.description as string)
                  : undefined,
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
          allTools.map((tool) => tool.schema.name),
        )
        agentContext.mcpAgents = mcpAgentCandidates
        logContextMutation(
          agentContext,
          "[MessageAgents][Context] Updated enabled tools and MCP agents",
          {
            enabledTools: Array.from(agentContext.enabledTools),
            mcpAgentIds: agentContext.mcpAgents.map((agent) => agent.agentId),
            directMcpToolCount: directMcpTools.length,
            internalToolCount: internalTools.length,
            customToolCount: customTools.length,
          },
        )
        loggerWithChild({ email }).debug(
          {
            totalToolBudget,
            internalTools: internalTools.length,
            directMcpTools: directMcpTools.length,
            mcpAgents: mcpAgentCandidates.map((a) => a.agentId),
          },
          "[MessageAgents][MCP] Tool budget applied",
        )
        Logger.debug(
          {
            enabledTools: Array.from(agentContext.enabledTools),
            mcpAgentConnectors: Array.from(agentConnectorIds),
            directMcpTools: directMcpTools.length,
            email,
            chatId: agentContext.chat.externalId,
          },
          "[MessageAgents] Tools exposed to LLM after filtering",
        )


        const initialSyntheticMessages: JAFMessage[] = []

        let initialAttachmentContext: {
          rawDocuments: ToolRawDocument[]
          summary: string
        } | null = null

        const referencedWithImages = [
          ...allReferencedFileIds,
          ...imageAttachmentFileIds,
        ]
        if (referencedWithImages.length > 0) {
          await emitReasoningEvent(
            emitReasoningStep,
            ReasoningSteps.attachmentAnalyzing()
          )
          const prepared = await prepareInitialAttachmentContext(
            allReferencedFileIds,
            threadIds,
            userMetadata,
            message,
            email,
            imageAttachmentFileIds
          )
          if (prepared) {
            await emitReasoningEvent(
              emitReasoningStep,
              ReasoningSteps.attachmentExtracted(prepared.rawDocuments.length)
            )
            initialAttachmentContext = {
              rawDocuments: prepared.rawDocuments,
              summary: prepared.summary,
            }
          }
        }
        if (initialAttachmentContext) {
          const { rawDocuments, summary: attachmentSummary } =
            initialAttachmentContext
          if (rawDocuments.length > 0) {
            mergeRawDocumentsIntoDocumentMemory(
              agentContext.documentMemory,
              rawDocuments,
              MIN_TURN_NUMBER,
              message,
              "initial_attachment",
            )
          }
          agentContext.chat.metadata = {
            ...agentContext.chat.metadata,
            initialAttachmentPhase: true,
            initialAttachmentSummary: attachmentSummary,
          }
        }

        // Pass memory then attachments as low-privilege synthetic tool results.
        // We must also simulate the preceding assistant tool_call so JAF can
        // correctly include the tool-result content in the prompt.
        const initialToolCallId = `synthetic-initialToolMessage-${MIN_TURN_NUMBER}`
        const initialToolMsg = buildInitialToolMessage({
          episodicMemoriesText: agentContext.episodicMemoriesText,
          chatMemoryText: agentContext.chatMemoryText,
          toolCallId: initialToolCallId,
        })
        if (initialToolMsg) {
          initialSyntheticMessages.push(
            buildSyntheticAssistantToolCallMessage({
              toolCallId: initialToolCallId,
              toolName: INITIAL_TOOL_MESSAGE,
              arguments: {},
            }),
            initialToolMsg,
          )
        }
        if (initialAttachmentContext) {
          const attachmentDocIds = initialAttachmentContext.rawDocuments.map(
            (d) => d.docId,
          )
          const attachmentDocs = attachmentDocIds
            .map((id) => agentContext.documentMemory.get(id))
            .filter((d): d is DocumentState => d != null)
          const attachmentFragments =
            attachmentDocs.length > 0
              ? await getFragmentsForSynthesisForDocs(
                  agentContext.documentMemory,
                  attachmentDocs,
                  {
                    email: agentContext.user.email,
                    userId: agentContext.user.numericId ?? undefined,
                    workspaceId: agentContext.user.workspaceNumericId ?? undefined,
                  },
                )
              : []
          const attachmentToolCallId = `synthetic-${ATTACHMENT_TOOL_MESSAGE}-${MIN_TURN_NUMBER}`
          initialSyntheticMessages.push(
            buildSyntheticAssistantToolCallMessage({
              toolCallId: attachmentToolCallId,
              toolName: ATTACHMENT_TOOL_MESSAGE,
              arguments: { source: "user_attachment" },
            }),
            buildAttachmentToolMessage(
              attachmentFragments,
              initialAttachmentContext.summary,
              attachmentToolCallId,
            ),
          )
        }

        // Build dynamic instructions
        const instructions = () => {
          return buildAgentInstructions(
            agentContext,
            allTools.map((tool) => tool.schema.name),
            dateForAI,
            agentPromptForLLM,
            delegationEnabled,
          )
        }

        // Set up JAF agent
        const jafAgent: JAFAgent<AgentRunContext, string> = {
          name: "xyne-agent",
          instructions,
          tools: allTools,
          modelConfig: { name: agenticModelId },
        }

        // Set up model provider
        const modelProvider = makeXyneJAFProvider<AgentRunContext>()

        // Set up agent registry
        const agentRegistry = new Map<
          string,
          JAFAgent<AgentRunContext, string>
        >([[jafAgent.name, jafAgent]])

        // Run state: mainRunIdRef was set above before any emitReasoningStep so all events (including attachmentAnalyzing/attachmentExtracted) share the same runId
        const runId = mainRunIdRef!
        const traceId = generateTraceId()
        const { jafHistory, llmHistory } = buildConversationHistoryForAgentRun(
          previousConversationHistory,
        )
        agentContext.conversationHistoryMessages = llmHistory
        const initialMessages: JAFMessage[] = [
          ...jafHistory,
          {
            role: "user",
            content: message,
          },
          ...initialSyntheticMessages,
        ]

        const runState: JAFRunState<AgentRunContext> = {
          runId,
          traceId,
          messages: initialMessages,
          currentAgentName: jafAgent.name,
          context: agentContext,
          turnCount: MIN_TURN_NUMBER,
        }
        const jafStreamingSpan = rootSpan.startSpan("jaf_stream")
        jafStreamingSpan.setAttribute("chat_external_id", chatRecord.externalId)
        jafStreamingSpan.setAttribute("run_id", runId)
        jafStreamingSpan.setAttribute("trace_id", traceId)
        jafStreamingSpan.setAttribute(
          "history_message_count",
          jafHistory.length,
        )
        jafStreamingSpan.setAttribute("history_seeded", jafHistory.length > 0)
        let turnSpan: Span | undefined
        const endTurnSpan = () => {
          if (turnSpan) {
            turnSpan.end()
            turnSpan = undefined
          }
        }
        let jafSpanEnded = false
        const endJafSpan = () => {
          if (!jafSpanEnded) {
            endTurnSpan()
            jafStreamingSpan.end()
            jafSpanEnded = true
          }
        }

        const messagesWithNoErrResponse: Message[] = [
          ...llmHistory,
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
        const syntheticToolCallIds = new WeakMap<object, string>()
        let syntheticToolCallSeq = 0
        const consecutiveToolErrors = new Map<string, number>()

        const recordExpectationsForTurn = (
          turn: number,
          expectations: PendingExpectation[],
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
          toolCall: ToolCallReference,
          turn: number,
          index: number,
        ): string => {
          const mapKey = toolCall as object
          if (toolCall.id !== undefined && toolCall.id !== null) {
            const normalized = String(toolCall.id)
            syntheticToolCallIds.set(mapKey, normalized)
            return normalized
          }
          const existing = syntheticToolCallIds.get(mapKey)
          if (existing) return existing
          const generated = `synthetic-${turn}-${syntheticToolCallSeq++}-${index}`
          syntheticToolCallIds.set(mapKey, generated)
          return generated
        }

        const buildTurnReviewInput = (
          turn: number,
          _reviewFreq: number,
        ): { reviewInput: AutoReviewInput } => {
          const lastReviewTurn = agentContext.review.lastReviewTurn ?? -1
          const startTurn = Math.max(MIN_TURN_NUMBER, lastReviewTurn + 1)
          const toolHistory = agentContext.toolCallHistory.filter(
            (record) =>
              record.turnNumber >= startTurn && record.turnNumber <= turn,
          )

          const expectedResults: ToolExpectationAssignment[] = []
          for (let t = startTurn; t <= turn; t++) {
            expectedResults.push(...(expectationHistory.get(t) || []))
          }

          return {
            reviewInput: {
              focus: "turn_end",
              turnNumber: turn,
              toolCallHistory: toolHistory,
              plan: agentContext.plan,
              expectedResults,
            },
          }
        }

        /**
         * Turn-end processing via the turn-lifecycle pipeline.
         *
         * This is the SINGLE entry point for ALL post-turn work:
         *   1. No-op turn detection (skip if only toDoWrite)
         *   2. Batch fragment ranking (single LLM call for all tools)
         *   3. Review (single LLM call, no duplicates)
         *   4. Cleanup (finalize images, reset artifacts)
         *
         * The turn_end and run_end event handlers do NOT run reviews.
         */
        const runTurnEndReviewAndCleanup = async (
          turn: number,
        ): Promise<void> => {
          mergeToolOutputsIntoCurrentTurnMemory(agentContext, turn)
          await runTurnEndPipeline(agentContext, {
            turn,
            useAgenticFiltering: USE_AGENTIC_FILTERING,
            reviewFrequency: agentContext.review.reviewFrequency ?? DEFAULT_REVIEW_FREQUENCY,
            minTurnNumber: MIN_TURN_NUMBER,
            emitter: emitReasoningStep,

            // Wiring: review
            runReview: async (ctx, input, t) => {
              return runAndBroadcastReview(ctx, input, t)
            },
            handleReviewOutcome: async (ctx, result, t, focus, emitter) => {
              await handleReviewOutcome(ctx, result, t, focus, emitter)
            },
            buildDefaultReview: buildDefaultReviewPayload,
            buildReviewInput: (t, freq) => {
              const { reviewInput } = buildTurnReviewInput(t, freq)
              return reviewInput
            },
            getExpectationsForTurn: (t) => expectationHistory.get(t) || [],

            // Wiring: batch fragment ranking (one fragment per doc from merged document memory)
            getUnrankedFragmentsForRanking: (ctx, t) =>
              buildUnrankedFragmentsFromDocumentMemory(ctx, t),
            rankFragments: async (ctx, allUnrankedWithToolContext, t, emitter) => {
              return await batchRankFragments(
                ctx,
                allUnrankedWithToolContext,
                message,
                messagesWithNoErrResponse,
                t,
                emitter
              )
            },
            mergeCurrentTurnIntoCrossTurn: (ctx, t, rankedDocIds) => {
              const docs = Array.from(ctx.currentTurnDocumentMemory.values()).filter(
                (doc) => !rankedDocIds || rankedDocIds.has(doc.docId),
              )
              if (docs.length > 0) {
                const newChunks = mergeDocumentStatesIntoDocumentMemory(
                  ctx.documentMemory,
                  docs,
                  t,
                )
                if (newChunks > 0) {
                  ctx.turnNewChunksCount.set(
                    t,
                    (ctx.turnNewChunksCount.get(t) ?? 0) + newChunks,
                  )
                }
              }
            },

            // Wiring: cleanup
            flushExpectations: () => {
              pendingExpectations.length = 0
            },
            resetTurnArtifacts: resetCurrentTurnArtifacts,
            clearAttachmentPhase: (ctx) => {
              const attachmentState = getAttachmentPhaseMetadata(ctx)
              if (attachmentState.initialAttachmentPhase) {
                ctx.chat.metadata = {
                  ...ctx.chat.metadata,
                  initialAttachmentPhase: false,
                }
              }
            },
          })
        }

        const runAndBroadcastReview = async (
          context: AgentRunContext,
          reviewInput: AutoReviewInput,
          iteration: number,
        ): Promise<ReviewResult | null> => {
          if (!reviewsAllowed(context)) {
            Logger.info(
              {
                turn: iteration,
                chatId: context.chat.externalId,
                lockedAtTurn: context.review.lockedAtTurn,
                focus: reviewInput.focus,
              },
              `[MessageAgents] Review skipped for focus '${reviewInput.focus}' due to final synthesis lock.`,
            )
            return null
          }
          if (
            (!reviewInput.expectedResults ||
              reviewInput.expectedResults.length === 0) &&
            reviewInput.focus !== "run_end"
          ) {
            Logger.warn(
              { turn: iteration, focus: reviewInput.focus },
              "[MessageAgents] No expected results recorded for review input.",
            )
          }

          let reviewResult: ReviewResult | null = null
          const pendingPromise = (async () => {
            const computedReview = await performAutomaticReview(
              reviewInput,
              context,
            )
            reviewResult = computedReview
            await handleReviewOutcome(
              context,
              computedReview,
              iteration,
              reviewInput.focus,
              emitReasoningStep,
            )
          })()

          context.review.pendingReview = pendingPromise
          logContextMutation(
            context,
            "[MessageAgents][Context] Registered pending review promise",
            {
              iteration,
              focus: reviewInput.focus,
            },
          )
          try {
            await pendingPromise
            if (!reviewResult) {
              throw new Error("Review did not produce a result")
            }
            return reviewResult
          } finally {
            if (context.review.pendingReview === pendingPromise) {
              context.review.pendingReview = undefined
              logContextMutation(
                context,
                "[MessageAgents][Context] Cleared pending review promise",
                {
                  iteration,
                  focus: reviewInput.focus,
                },
              )
            }
          }
        }

        // Configure run with hooks
        const runCfg: JAFRunConfig<AgentRunContext> & {
          onEvent?: (event: TraceEvent) => void
        } = {
          agentRegistry,
          modelProvider,
          maxTurns: 100,
          modelOverride: agenticModelId,
          onTurnEnd: async ({ turn }) => {
            await runTurnEndReviewAndCleanup(turn)
          },
          // After tool execution hook
          onAfterToolExecution: async (
            toolName: string,
            result: any,
            hookContext: any,
          ) => {
            const callIdRaw = hookContext?.toolCall?.id
            const normalizedCallId = hookContext?.toolCall
              ? (syntheticToolCallIds.get(hookContext.toolCall) ??
                (callIdRaw === undefined || callIdRaw === null
                  ? undefined
                  : String(callIdRaw)))
              : undefined
            let expectationForCall: ToolExpectation | undefined
            if (
              normalizedCallId &&
              expectedResultsByCallId.has(normalizedCallId)
            ) {
              expectationForCall = expectedResultsByCallId.get(normalizedCallId)
              expectedResultsByCallId.delete(normalizedCallId)
            }
            let turnForCall = normalizedCallId
              ? toolCallTurnMap.get(normalizedCallId)
              : undefined
            if (normalizedCallId) {
              toolCallTurnMap.delete(normalizedCallId)
            }
            if (turnForCall === undefined || turnForCall < MIN_TURN_NUMBER) {
              turnForCall =
                agentContext.turnCount ?? currentTurn ?? MIN_TURN_NUMBER
            }
            // Create a per-call scoped emitter that pre-stamps toolExecutionId.
            // Each parallel onAfterToolExecution branch captures its own
            // normalizedCallId in a closure — no shared scalar, no race.
            // runPublicAgent is excluded because its events group by delegationRunId.
            const toolScopedEmitter: ReasoningEmitter =
              normalizedCallId && toolName !== XyneTools.runPublicAgent
                ? async (payload) =>
                    emitReasoningStep({
                      ...payload,
                      toolExecutionId: normalizedCallId,
                    })
                : emitReasoningStep
            const content = await afterToolExecutionHook(
              toolName,
              result,
              hookContext,
              message,
              messagesWithNoErrResponse,
              expectationForCall,
              turnForCall,
              toolScopedEmitter,
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

        if (attachmentMetadata.length > 0 && lastPersistedMessageExternalId) {
          await stream.writeSSE({
            event: ChatSSEvents.AttachmentUpdate,
            data: JSON.stringify({
              messageId: lastPersistedMessageExternalId,
              attachments: attachmentMetadata,
            }),
          })
        }

        if (attachmentStorageError) {
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: JSON.stringify({
              error: "attachment_storage_failed",
              message:
                "Failed to store attachment metadata. Your message was saved but attachments may not be available for future reference.",
              details: attachmentStorageError.message,
            }),
          })
        }

        // Execute JAF run with streaming
        let currentTurn = MIN_TURN_NUMBER
        let answer = ""
        const citations: Citation[] = []
        const imageCitations: ImageCitation[] = []
        const citationMap: Record<number, number> = {}
        const yieldedCitations = new Set<number>()
        const yieldedImageCitations = new Map<number, Set<number>>()
        let assistantMessageId: string | null = null

        const streamAnswerText = async (text: string) => {
          if (!text) return
          if (stream.closed) return
          throwIfStopRequested(stopController.signal)
          const chunkSize = 200
          for (let i = 0; i < text.length; i += chunkSize) {
            if (stream.closed) return
            throwIfStopRequested(stopController.signal)
            const chunk = text.slice(i, i + chunkSize)
            answer += chunk
            await stream.writeSSE({
              event: ChatSSEvents.ResponseUpdate,
              data: chunk,
            })

            const fragmentsForCitations =
              await getFragmentsForSynthesis(agentContext.documentMemory, {
                email: agentContext.user?.email,
                userId: agentContext.user?.numericId ?? undefined,
                workspaceId: agentContext.user?.workspaceNumericId ?? undefined,
              })
            for await (const citationEvent of checkAndYieldCitationsForAgent(
              answer,
              yieldedCitations,
              fragmentsForCitations,
              yieldedImageCitations,
              email,
            )) {
              if (stream.closed) return
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
          emitReasoning: async (payload) => {
            await emitReasoningEvent(
              emitReasoningStep,
              payload as ReasoningEventPayload,
            )
          },
        }
        logContextMutation(
          agentContext,
          "[MessageAgents][Context] Attached runtime callbacks",
          {
            hasStreamAnswerText: true,
            hasEmitReasoning: true,
          },
        )
        const traceEventHandler = async (event: TraceEvent) => {
          if (event.type === "before_tool_execution") {
            return beforeToolExecutionHook(
              event.data.toolName as XyneTools,
              event.data.args,
              agentContext,
              emitReasoningStep,
            )
          }
          return undefined
        }
        runCfg.onEvent = (event) => {
          logJAFTraceEvent(
            {
              chatId: agentContext.chat.externalId,
              email,
              flow: "MessageAgents",
              runId,
            },
            event,
          )
        }

        Logger.debug(
          {
            runId,
            chatId: agentContext.chat.externalId,
            modelOverride: agenticModelId,
            email,
          },
          "[MessageAgents] Starting assistant call",
        )

        for await (const evt of runStream<AgentRunContext, string>(
          runState,
          runCfg,
          traceEventHandler,
        )) {
          if (stream.closed) break

          switch (evt.type) {
            case "turn_start": {
              endTurnSpan()
              turnSpan = jafStreamingSpan.startSpan(`turn_${evt.data.turn}`)
              turnSpan.setAttribute("turn_number", evt.data.turn)
              turnSpan.setAttribute("agent_name", evt.data.agentName)
              agentContext.turnCount = evt.data.turn
              currentTurn = evt.data.turn
              flushExpectationBufferToTurn(currentTurn)

              // Cooldown: recover expired tools, filter out cooled-down ones
              const cooldown = new ToolCooldownManager(agentContext.failedTools)
              const recovered = cooldown.recoverExpiredTools(currentTurn)
              if (recovered.length > 0) {
                await emitReasoningEvent(
                  emitReasoningStep,
                  ReasoningSteps.toolRecovered(recovered)
                )
              }
              const activeTools = cooldown.getAvailableTools(allTools, currentTurn)
              agentContext.enabledTools = new Set(
                activeTools.map((t) => t.schema.name)
              )

              Logger.debug(
                {
                  turn: currentTurn,
                  agentName: evt.data.agentName,
                  chatId: agentContext.chat.externalId,
                  runId,
                  jafRunState: runState
                },
                "[MessageAgents] Turn start LLM input",
              )

              await emitReasoningEvent(
                emitReasoningStep,
                ReasoningSteps.turnStarted(currentTurn)
              )
              break
            }

            case "tool_requests": {
              const plannedTools = evt.data.toolCalls.map((toolCall) => ({
                name: toolCall.name,
                args: toolCall.args,
              }))
              const toolRequestsSpan = turnSpan?.startSpan("tool_requests")
              toolRequestsSpan?.setAttribute(
                "tool_calls_count",
                plannedTools.length,
              )
              Logger.debug(
                {
                  turn: currentTurn,
                  plannedTools,
                  chatId: agentContext.chat.externalId,
                },
                "[MessageAgents] Tool plan for turn",
              )
              for (const [idx, toolCall] of evt.data.toolCalls.entries()) {
                const normalizedCallId = ensureToolCallId(
                  toolCall,
                  currentTurn,
                  idx,
                )
                toolCallTurnMap.set(normalizedCallId, currentTurn)
                const assignedExpectation = consumePendingExpectation(
                  pendingExpectations,
                  toolCall.name,
                )
                if (assignedExpectation) {
                  expectedResultsByCallId.set(
                    normalizedCallId,
                    assignedExpectation.expectation,
                  )
                }
                const selectionSpan =
                  toolRequestsSpan?.startSpan("tool_selection")
                selectionSpan?.setAttribute("tool_name", toolCall.name)
                selectionSpan?.setAttribute(
                  "args",
                  JSON.stringify(toolCall.args ?? {}),
                )
                // Emit a tool-specific intent message based on the tool being selected.
                // toolExecutionId is inlined directly in each payload — no shared scalar,
                // so parallel tool calls never overwrite each other's group key.
                const toolQuery = extractToolQuery(toolCall.name, (toolCall.args ?? {}) as Record<string, unknown>)
                if (toolCall.name === XyneTools.toDoWrite) {
                  await emitReasoningEvent(
                    emitReasoningStep,
                    { ...ReasoningSteps.toolSelected(toolCall.name), toolExecutionId: normalizedCallId }
                  )
                } else if (toolCall.name === XyneTools.listCustomAgents) {
                  await emitReasoningEvent(
                    emitReasoningStep,
                    { ...ReasoningSteps.agentSearching(), toolExecutionId: normalizedCallId, toolName: XyneTools.listCustomAgents, ...(toolQuery ? { toolQuery } : {}) }
                  )
                } else if (toolCall.name === XyneTools.runPublicAgent) {
                  // agentDelegated emission moved into createRunPublicAgentTool.execute()
                  // so each parallel call generates its own ID in an isolated async scope,
                  // eliminating the shared-scalar overwrite race condition.
                } else if (toolCall.name === XyneTools.fallBack) {
                  await emitReasoningEvent(
                    emitReasoningStep,
                    { ...ReasoningSteps.fallbackActivated(), toolExecutionId: normalizedCallId, toolName: XyneTools.fallBack }
                  )
                } else {
                  await emitReasoningEvent(
                    emitReasoningStep,
                    { ...ReasoningSteps.toolSelected(toolCall.name, toolQuery), toolExecutionId: normalizedCallId }
                  )
                }
                selectionSpan?.end()
              }
              toolRequestsSpan?.end()
              break
            }

            case "tool_call_start": {
              // Intent already emitted by tool_requests handler — no duplicate emit here.
              const toolStartSpan = turnSpan?.startSpan("tool_call_start")
              toolStartSpan?.setAttribute("tool_name", evt.data.toolName)
              toolStartSpan?.setAttribute(
                "args",
                JSON.stringify(evt.data.args ?? {}),
              )
              Logger.debug(
                {
                  toolName: evt.data.toolName,
                  args: evt.data.args,
                  runId,
                  chatId: agentContext.chat.externalId,
                  turn: currentTurn,
                },
                "[MessageAgents][Tool Start]",
              )
              toolStartSpan?.end()
              break
            }

            case "tool_call_end": {
              const toolEndSpan = turnSpan?.startSpan("tool_call_end")
              toolEndSpan?.setAttribute("tool_name", evt.data.toolName)
              toolEndSpan?.setAttribute(
                "status",
                evt.data.error ? "error" : (evt.data.status ?? "completed"),
              )
              toolEndSpan?.setAttribute(
                "execution_time_ms",
                evt.data.executionTime ?? 0,
              )
              Logger.debug(
                {
                  toolName: evt.data.toolName,
                  result: evt.data.result,
                  error: evt.data.error,
                  executionTime: evt.data.executionTime,
                  status: evt.data.error ? "error" : "success",
                  runId,
                  chatId: agentContext.chat.externalId,
                  turn: currentTurn,
                },
                "[MessageAgents][Tool End]",
              )
              // Track consecutive errors for cooldown manager; review
              // happens at turn-end via the pipeline (no per-tool review).
              if (evt.data.error) {
                const newCount =
                  (consecutiveToolErrors.get(evt.data.toolName) ?? 0) + 1
                consecutiveToolErrors.set(evt.data.toolName, newCount)
              } else {
                consecutiveToolErrors.delete(evt.data.toolName)
              }

              // Emit stream End and persist immediately when synthesis completes,
              // so the frontend can close/stop waiting instead of waiting for
              // turn_end (which is delayed by onTurnEnd → runTurnEndPipeline).
              if (
                evt.data.toolName === XyneTools.synthesizeFinalAnswer &&
                !evt.data.error &&
                agentContext.finalSynthesis.requested &&
                agentContext.finalSynthesis.completed
              ) {
                loggerWithChild({ email }).info(
                  "Storing assistant response in database (after synthesis tool)",
                )
                Logger.debug(
                  {
                    chatId: agentContext.chat.externalId,
                    turn: currentTurn,
                    answerPreview: truncateValue(answer, 500),
                    citationsCount: citations.length,
                    imageCitationsCount: imageCitations.length,
                  },
                  "[MessageAgents][FinalSynthesis] Persist + End at tool_call_end",
                )
                try {
                  const persisted = await persistAssistantMessage(
                    db,
                    {
                      chatRecord,
                      user,
                      workspace: { externalId: workspace.externalId },
                      agenticModelId,
                      totalCost: agentContext.totalCost,
                      tokenUsage: agentContext.tokenUsage,
                      requestStartMs,
                    },
                    {
                      answer,
                      citations,
                      imageCitations,
                      citationMap,
                      thinkingLog,
                    },
                    persistTrace,
                  )
                  assistantMessageId = persisted.assistantMessageId
                  lastPersistedMessageId = persisted.msg.id as number
                  lastPersistedMessageExternalId = persisted.assistantMessageId
                } catch (error) {
                  loggerWithChild({ email }).error(
                    error,
                    "Failed to persist assistant response (tool_call_end)",
                  )
                }
                if (!stream.closed) {
                  await stream.writeSSE({
                    event: ChatSSEvents.ResponseMetadata,
                    data: JSON.stringify({
                      chatId: agentContext.chat.externalId,
                      messageId: assistantMessageId || "temp-message-id",
                      timeTakenMs: Date.now() - requestStartMs,
                    }),
                  })
                  await stream.writeSSE({
                    event: ChatSSEvents.End,
                    data: "",
                  })
                  Logger.debug(
                    { chatId: agentContext.chat.externalId },
                    "[MessageAgents] stream end emitted (after synthesis tool_call_end)",
                  )
                }
              }

              toolEndSpan?.end()
              break
            }

            case "assistant_message": {
              const assistantSpan = turnSpan?.startSpan("assistant_message")
              Logger.debug(
                {
                  turn: currentTurn,
                  hasToolCalls:
                    Array.isArray(evt.data.message?.tool_calls) &&
                    (evt.data.message.tool_calls?.length ?? 0) > 0,
                  contentPreview:
                    getTextContent(evt.data.message.content)?.slice(0, 200) ||
                    "",
                  chatId: agentContext.chat.externalId,
                },
                "[MessageAgents] Assistant output received",
              )
              const content = getTextContent(evt.data.message.content) || ""
              const hasToolCalls =
                Array.isArray(evt.data.message?.tool_calls) &&
                (evt.data.message.tool_calls?.length ?? 0) > 0
              assistantSpan?.setAttribute("content_length", content.length)
              assistantSpan?.setAttribute("has_tool_calls", hasToolCalls)

              if (content) {
                const extractedExpectations = extractExpectedResults(content)
                Logger.debug(
                  {
                    turn: currentTurn,
                    extractedCount: extractedExpectations.length,
                    extractedExpectations,
                    chatId: agentContext.chat.externalId,
                  },
                  "[DEBUG] Extracted expectations from assistant message",
                )
                if (extractedExpectations.length > 0) {
                  await emitReasoningEvent(
                    emitReasoningStep,
                    ReasoningSteps.expectationsSet(),
                  )
                  pendingExpectations.push(...extractedExpectations)
                  agentContext.currentTurnArtifacts.expectations.push(
                    ...extractedExpectations
                  )
                  if (currentTurn > 0) {
                    recordExpectationsForTurn(
                      currentTurn,
                      extractedExpectations,
                    )
                  } else {
                    expectationBuffer.push(...extractedExpectations)
                  }
                }
              }

              if (hasToolCalls) {
                // Tool intent is emitted by the tool_requests handler — no duplicate here.
                assistantSpan?.end()
                break
              }

              if (agentContext.finalSynthesis.suppressAssistantStreaming) {
                // Only emit synthesisCompleted here if the synthesizeFinalAnswer tool
                // hasn't already done so (it sets .completed = true before emitting).
                if (content?.trim() && !agentContext.finalSynthesis.completed) {
                  agentContext.finalSynthesis.ackReceived = true
                  await emitReasoningEvent(
                    emitReasoningStep,
                    ReasoningSteps.synthesisCompleted()
                  )
                }
                assistantSpan?.end()
                break
              }

              if (content) {
                await streamAnswerText(content)
              }
              assistantSpan?.end()
              break
            }

            case "token_usage": {
              const tokenUsageSpan = jafStreamingSpan.startSpan("token_usage")
              tokenUsageSpan.setAttribute("prompt_tokens", evt.data.prompt ?? 0)
              tokenUsageSpan.setAttribute(
                "completion_tokens",
                evt.data.completion ?? 0,
              )
              tokenUsageSpan.setAttribute("total_tokens", evt.data.total ?? 0)
              tokenUsageSpan.end()
              break
            }

            case "guardrail_violation": {
              const guardrailSpan = jafStreamingSpan.startSpan(
                "guardrail_violation",
              )
              guardrailSpan.setAttribute("stage", evt.data.stage)
              guardrailSpan.setAttribute("reason", evt.data.reason)
              guardrailSpan.end()
              break
            }

            case "decode_error": {
              const decodeSpan = jafStreamingSpan.startSpan("decode_error")
              decodeSpan.setAttribute(
                "errors",
                JSON.stringify(evt.data.errors ?? []),
              )
              decodeSpan.end()
              break
            }

            case "handoff_denied": {
              const handoffSpan = jafStreamingSpan.startSpan("handoff_denied")
              handoffSpan.setAttribute("from", evt.data.from)
              handoffSpan.setAttribute("to", evt.data.to)
              handoffSpan.setAttribute("reason", evt.data.reason)
              handoffSpan.end()
              break
            }

            case "clarification_requested": {
              const clarificationSpan = jafStreamingSpan.startSpan(
                "clarification_requested",
              )
              clarificationSpan.setAttribute(
                "clarification_id",
                evt.data.clarificationId,
              )
              clarificationSpan.setAttribute("question", evt.data.question)
              clarificationSpan.setAttribute(
                "options_count",
                evt.data.options.length,
              )
              clarificationSpan.end()
              break
            }

            case "clarification_provided": {
              const clarificationProvidedSpan = jafStreamingSpan.startSpan(
                "clarification_provided",
              )
              clarificationProvidedSpan.setAttribute(
                "clarification_id",
                evt.data.clarificationId,
              )
              clarificationProvidedSpan.setAttribute(
                "selected_id",
                evt.data.selectedId,
              )
              clarificationProvidedSpan.end()
              break
            }

            case "final_output": {
              const finalOutputSpan = jafStreamingSpan.startSpan("final_output")
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
              finalOutputSpan.setAttribute(
                "output_length",
                typeof output === "string" ? output.length : 0,
              )
              finalOutputSpan.end()
              break
            }

            case "run_end": {
              const runEndSpan = jafStreamingSpan.startSpan("run_end")
              const outcome = evt.data.outcome
              runEndSpan.setAttribute(
                "outcome_status",
                outcome?.status ?? "unknown",
              )
              if (outcome?.status === "error") {
                if (stopController.signal.aborted) {
                  await persistTraceForLastMessage()
                  break
                }
                const err = outcome.error
                const errDetail =
                  err && typeof err === "object" && "detail" in err
                    ? (err as { detail?: string }).detail
                    : undefined
                const errMsg =
                  err?._tag === "MaxTurnsExceeded"
                    ? `Max turns exceeded: ${err.turns}`
                    : errDetail ||
                      (err && typeof (err as any).reason === "string"
                        ? (err as any).reason
                        : getErrorMessage(err) || "Execution error")

                loggerWithChild({ email }).error(
                  {
                    chatId: agentContext.chat.externalId,
                    runId,
                    errorTag: err?._tag,
                    detail: errMsg,
                  },
                  "[MessageAgents] Agent run ended with error",
                )

                if (!stream.closed) {
                  await stream.writeSSE({
                    event: ChatSSEvents.Error,
                    data: JSON.stringify({
                      error: err?._tag,
                      message: errMsg,
                    }),
                  })
                  await stream.writeSSE({
                    event: ChatSSEvents.End,
                    data: "",
                  })
                }
                await persistErrorToUserMessage(
                  db,
                  userMessageExternalId,
                  errMsg,
                  email,
                  "run_end",
                )
                await persistTraceForLastMessage()
              } else {
                // Success path: if we never sent End (e.g. direct answer without
                // synthesize_final_answer), persist and send End here so the
                // frontend can close the stream.
                const alreadySentEnd =
                  agentContext.finalSynthesis.requested &&
                  agentContext.finalSynthesis.completed
                if (!alreadySentEnd && answer && !stream.closed) {
                  try {
                    const persisted = await persistAssistantMessage(
                      db,
                      {
                        chatRecord,
                        user,
                        workspace: { externalId: workspace.externalId },
                        agenticModelId,
                        totalCost: agentContext.totalCost,
                        tokenUsage: agentContext.tokenUsage,
                        requestStartMs,
                      },
                      {
                        answer,
                        citations,
                        imageCitations,
                        citationMap,
                        thinkingLog,
                      },
                      persistTrace,
                    )
                    assistantMessageId = persisted.assistantMessageId
                    lastPersistedMessageId = persisted.msg.id as number
                    lastPersistedMessageExternalId = persisted.assistantMessageId
                  } catch (error) {
                    loggerWithChild({ email }).error(
                      error,
                      "Failed to persist assistant response (run_end direct-answer path)",
                    )
                  }
                  if (!stream.closed) {
                    await stream.writeSSE({
                      event: ChatSSEvents.ResponseMetadata,
                      data: JSON.stringify({
                        chatId: agentContext.chat.externalId,
                        messageId: assistantMessageId || "temp-message-id",
                        timeTakenMs: Date.now() - requestStartMs,
                      }),
                    })
                    await stream.writeSSE({
                      event: ChatSSEvents.End,
                      data: "",
                    })
                  }
                }
              }
              runEndSpan.end()
              endJafSpan()
              break
            }
          }
        }

        endJafSpan()
        rootSpan.end()
      } catch (error) {
        if (stopController.signal.aborted || isMessageAgentStopError(error)) {
          loggerWithChild({ email }).info(
            { chatId: chatRecord.externalId },
            "MessageAgents stream terminated due to stop request",
          )
          await persistTraceForLastMessage()
          rootSpan.end()
        } else {
          loggerWithChild({ email }).error(error, "MessageAgents stream error")
          const streamErrMsg = getErrorMessage(error)
          await persistErrorToUserMessage(
            db,
            userMessageExternalId,
            streamErrMsg,
            email,
            "stream_error catch",
          )
          if (!stream.closed) {
            try {
              await stream.writeSSE({
                event: ChatSSEvents.Error,
                data: JSON.stringify({
                  error: "stream_error",
                  message: streamErrMsg,
                }),
              })
              await stream.writeSSE({
                event: ChatSSEvents.End,
                data: "",
              })
            } catch (writeErr) {
              loggerWithChild({ email }).warn(
                writeErr,
                "Failed to send stream_error to client (stream likely closed)",
              )
            }
          }
          await persistTraceForLastMessage()
          rootSpan.end()
        }
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
        stopController.signal.removeEventListener("abort", markStop)
        const activeEntry = activeStreams.get(streamKey)
        if (activeEntry?.stream === stream) {
          activeStreams.delete(streamKey)
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
  params: ListAgentsParams,
): Promise<ListCustomAgentsOutput> {
  const maxAgents = Math.min(Math.max(params.maxAgents ?? 5, 1), 10)
  let workspaceDbId = params.workspaceNumericId
  let userDbId = params.userId
  const mcpAgentsFromContext = params.mcpAgents ?? []

  if (!workspaceDbId || !userDbId) {
    const userAndWorkspace: InternalUserWorkspace =
      await getUserAndWorkspaceByEmail(
        db,
        params.workspaceExternalId,
        params.userEmail,
      )
    workspaceDbId = Number(userAndWorkspace.workspace.id)
    userDbId = Number(userAndWorkspace.user.id)
  }

  const accessibleAgents = await getUserAccessibleAgents(
    db,
    userDbId!,
    workspaceDbId!,
    25,
    0,
  )

  if (!accessibleAgents.length && mcpAgentsFromContext.length === 0) {
    return {
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
      resourceAccessByAgent.set(String(agent.externalId), resourceAccess)
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
    "Return JSON with keys agents (array|null) and totalEvaluated.",
    "Each agent entry must include: agentId, agentName, description, capabilities[], domains[], suitabilityScore (0-1), confidence (0-1), estimatedCost ('low'|'medium'|'high'), averageLatency (ms).",
    `Select up to ${maxAgents} agents.`,
    "If no agent is unquestionably suitable, set agents to null.",
    "Only include an agent when you can cite concrete capability matches; otherwise leave it out.",
    "You may return multiple agents when several are clearly relevant—rank the strongest ones first.",
  ].join(" ")

  const payload = [
    `User Query: ${params.query}`,
    params.requiredCapabilities?.length
      ? `Required capabilities: ${params.requiredCapabilities.join(", ")}`
      : "Required capabilities: none specified",
    "Agents:",
    formatAgentBriefsForPrompt(combinedBriefs),
  ].join("\n\n")

  const modelId = (defaultFastModel as Models) || (defaultBestModel as Models)
  const modelParams: ModelParams = {
    modelId,
    json: true,
    stream: false,
    temperature: 0,
    max_new_tokens: 800,
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
      modelParams,
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
        agents: enrichedAgents,
        totalEvaluated,
      }
    }

    loggerWithChild({ email: params.userEmail }).warn(
      { issue: validation.error.format() },
      "LLM agent selection output invalid, falling back to heuristic scoring",
    )
  } catch (error) {
    loggerWithChild({ email: params.userEmail }).error(
      { err: error },
      "LLM agent selection failed, falling back to heuristic scoring",
    )
  }

  loggerWithChild({ email: params.userEmail }).info(
    {
      query: params.query,
      totalAgents: combinedBriefs.length,
      maxAgents,
    },
    "Using heuristic agent selection mechanism (LLM-based selection not available or failed)",
  )

  return buildHeuristicAgentSelection(
    combinedBriefs,
    params.query,
    maxAgents,
    totalEvaluated,
  )
}

export async function executeCustomAgent(params: {
  agentId: string
  query: string
  userEmail: string
  workspaceExternalId: string
  contextSnippet?: string
  maxTokens?: number
  parentTurn?: number
  mcpAgents?: MCPVirtualAgentRuntime[]
  stopSignal?: AbortSignal
  /** When set, delegated agent reasoning is streamed to the parent's SSE (nested JAF streaming). */
  reasoningEmitter?: ReasoningEmitter
  /** Stable UUID for this specific delegation; forwarded to the inner emitter wrapper. */
  delegationRunId?: string
}): Promise<ToolOutput> {
  const turnInfo =
    typeof params.parentTurn === "number"
      ? `\n\nTurn info: Parent turn number is ${params.parentTurn}. Continue numbering from here.`
      : ""

  const combinedQuery = params.contextSnippet
    ? `${params.query}\n\nAdditional context:\n${params.contextSnippet}${turnInfo}`
    : `${params.query}${turnInfo}`

  if (params.agentId.startsWith("mcp:")) {
    throwIfStopRequested(params.stopSignal)
    return executeMcpAgent(params.agentId, combinedQuery, {
      mcpAgents: params.mcpAgents,
      maxTokens: params.maxTokens,
      parentTurn: params.parentTurn,
      userEmail: params.userEmail,
    })
  }

  throwIfStopRequested(params.stopSignal)

  if (config.delegation_agentic) {
    return runDelegatedAgentWithMessageAgents({
      agentId: params.agentId,
      query: combinedQuery,
      userEmail: params.userEmail,
      workspaceExternalId: params.workspaceExternalId,
      maxTokens: params.maxTokens,
      parentTurn: params.parentTurn,
      mcpAgents: params.mcpAgents,
      stopSignal: params.stopSignal,
      reasoningEmitter: params.reasoningEmitter,
      delegationRunId: params.delegationRunId,
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
    throwIfStopRequested(params.stopSignal)

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
    Logger.error({ err: error }, "executeCustomAgent encountered an error")
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
  stopSignal?: AbortSignal
  /** When set, delegated run reuses parent's emitter so reasoning streams to the same SSE. */
  reasoningEmitter?: ReasoningEmitter
  /**
   * Stable UUID generated at delegation time (in tool_requests handler).
   * Passed through to the inner emitter wrapper so every reasoning event
   * emitted by the delegated agent carries the same delegationRunId, giving
   * the frontend one consistent group key per run_public_agent call.
   */
  delegationRunId?: string
}

async function runDelegatedAgentWithMessageAgents(
  params: DelegatedAgentRunParams,
): Promise<ToolOutput> {
  const logger = loggerWithChild({ email: params.userEmail })
  const delegateModelId = resolveAgenticModelId(defaultBestModel)
  try {
    throwIfStopRequested(params.stopSignal)
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      params.workspaceExternalId,
      params.userEmail,
    )
    const rawUser = userAndWorkspace.user
    const rawWorkspace = userAndWorkspace.workspace
    const user = {
      id: Number(rawUser.id),
      email: String(rawUser.email),
      timeZone:
        typeof rawUser.timeZone === "string"
          ? rawUser.timeZone
          : "Asia/Kolkata",
    }
    const workspace = {
      id: Number(rawWorkspace.id),
      externalId: String(rawWorkspace.externalId),
    }
    const agentRecord = await getAgentByExternalIdWithPermissionCheck(
      db,
      params.agentId,
      workspace.id,
      user.id,
    )

    if (!agentRecord) {
      return {
        result: "Agent execution failed",
        error: `Access denied: You don't have permission to use agent ${params.agentId}`,
        metadata: { agentId: params.agentId, parentTurn: params.parentTurn },
      }
    }

    const agentPromptForLLM = JSON.stringify(agentRecord)
    const dedicatedAgentSystemPrompt =
      typeof agentRecord.prompt === "string" &&
      agentRecord.prompt.trim().length > 0
        ? agentRecord.prompt.trim()
        : undefined
    const userCtxString = userContext(userAndWorkspace)
    const userTimezone = user.timeZone || "Asia/Kolkata"
    const dateForAI = getDateForAI({ userTimeZone: userTimezone })
    const attachmentsForContext: Array<{ fileId: string; isImage: boolean }> =
      []

    let connectorState = createEmptyConnectorState()
    try {
      connectorState = await getUserConnectorState(db, params.userEmail)
    } catch (error) {
      logger.warn(
        error,
        "[DelegatedAgenticRun] Failed to load connector state; assuming no connectors",
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
        dedicatedAgentSystemPrompt,
        workspaceNumericId: workspace.id,
        stopSignal: params.stopSignal,
        modelId: delegateModelId,
      },
    )
    agentContext.delegationEnabled = false
    agentContext.ambiguityResolved = true
    agentContext.maxOutputTokens = params.maxTokens
    agentContext.mcpAgents = params.mcpAgents ?? []
    logContextMutation(
      agentContext,
      "[DelegatedAgenticRun][Context] Updated delegated agent context defaults",
      {
        delegationEnabled: agentContext.delegationEnabled,
        maxOutputTokens: agentContext.maxOutputTokens,
        mcpAgentCount: agentContext.mcpAgents.length,
      },
    )

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
      allTools.map((tool) => tool.schema.name),
    )
    logContextMutation(
      agentContext,
      "[DelegatedAgenticRun][Context] Updated enabled tools",
      {
        enabledTools: Array.from(agentContext.enabledTools),
        directMcpToolCount: directMcpTools.length,
        internalToolCount: internalTools.length,
      },
    )

    // Episodic memory for delegated agent initial turn (same as main agent: scope by this agent's chats)
    const delegatedAgentChatIds = await getChatExternalIdsByAgentId(
      db,
      params.agentId,
      params.userEmail,
    )
    const episodicMemoriesForDelegate = await retrieveEpisodicMemories({
      query: params.query,
      email: params.userEmail,
      workspaceId: params.workspaceExternalId,
      chatIds: delegatedAgentChatIds,
      limit: 5,
    })
    if (episodicMemoriesForDelegate.length > 0) {
      agentContext.episodicMemoriesText = episodicMemoriesForDelegate
        .map(
          (m) =>
            `- [${m.memoryType}] ${m.memoryText} (chatId: ${m.sourceChatId})`,
        )
        .join("\n")
    }

    const instructions = () => {
      return buildAgentInstructions(
        agentContext,
        allTools.map((tool) => tool.schema.name),
        dateForAI,
        agentPromptForLLM,
        false,
      )
    }

    const jafAgent: JAFAgent<AgentRunContext, string> = {
      name: "xyne-delegate",
      instructions,
      tools: allTools,
      modelConfig: { name: delegateModelId },
    }

    const modelProvider = makeXyneJAFProvider<AgentRunContext>()
    const agentRegistry = new Map<string, JAFAgent<AgentRunContext, string>>([
      [jafAgent.name, jafAgent],
    ])

    const runId = generateRunId()
    const traceId = generateTraceId()
    const message = params.query

    const delegatedInitialToolCallId = `synthetic-initialToolMessage-delegated-${MIN_TURN_NUMBER}`
    const delegatedInitialToolMsg = buildInitialToolMessage({
      episodicMemoriesText: agentContext.episodicMemoriesText,
      chatMemoryText: agentContext.chatMemoryText,
      toolCallId: delegatedInitialToolCallId,
    })
    const initialMessages: JAFMessage[] = [
      {
        role: "user",
        content: message,
      },
      ...(delegatedInitialToolMsg
        ? [
            buildSyntheticAssistantToolCallMessage({
              toolCallId: delegatedInitialToolCallId,
              toolName: INITIAL_TOOL_MESSAGE,
              arguments: {},
            }),
            delegatedInitialToolMsg,
          ]
        : []),
    ]

    const runState: JAFRunState<AgentRunContext> = {
      runId,
      traceId,
      messages: initialMessages,
      currentAgentName: jafAgent.name,
      context: agentContext,
      turnCount: MIN_TURN_NUMBER,
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
    const syntheticToolCallIds = new WeakMap<object, string>()
    let syntheticToolCallSeq = 0
    const consecutiveToolErrors = new Map<string, number>()

    const recordExpectationsForTurn = (
      turn: number,
      expectations: PendingExpectation[],
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
      toolCall: ToolCallReference,
      turn: number,
      index: number,
    ): string => {
      const mapKey = toolCall as object
      if (toolCall.id !== undefined && toolCall.id !== null) {
        const normalized = String(toolCall.id)
        syntheticToolCallIds.set(mapKey, normalized)
        return normalized
      }
      const existing = syntheticToolCallIds.get(mapKey)
      if (existing) return existing
      const generated = `synthetic-${turn}-${syntheticToolCallSeq++}-${index}`
      syntheticToolCallIds.set(mapKey, generated)
      return generated
    }

    const buildTurnReviewInput = (
      turn: number,
      _reviewFreq: number,
    ): { reviewInput: AutoReviewInput } => {
      const lastReviewTurn = agentContext.review.lastReviewTurn ?? -1
      const startTurn = Math.max(MIN_TURN_NUMBER, lastReviewTurn + 1)
      const toolHistory = agentContext.toolCallHistory.filter(
        (record) => record.turnNumber >= startTurn && record.turnNumber <= turn,
      )

      const expectedResults: ToolExpectationAssignment[] = []
      for (let t = startTurn; t <= turn; t++) {
        expectedResults.push(...(expectationHistory.get(t) || []))
      }

      return {
        reviewInput: {
          focus: "turn_end",
          turnNumber: turn,
          toolCallHistory: toolHistory,
          plan: agentContext.plan,
          expectedResults,
        },
      }
    }

    const runTurnEndReviewAndCleanup = async (
      turn: number,
    ): Promise<void> => {
          mergeToolOutputsIntoCurrentTurnMemory(agentContext, turn)
      await runTurnEndPipeline(agentContext, {
        turn,
        useAgenticFiltering: USE_AGENTIC_FILTERING,
        reviewFrequency: agentContext.review.reviewFrequency ?? DEFAULT_REVIEW_FREQUENCY,
        minTurnNumber: MIN_TURN_NUMBER,
        emitter: emitReasoningStep,

        runReview: async (ctx, input, t) => {
          return runAndBroadcastReview(ctx, input, t)
        },
        handleReviewOutcome: async (ctx, result, t, focus, emitter) => {
          await handleReviewOutcome(ctx, result, t, focus, emitter)
        },
        buildDefaultReview: buildDefaultReviewPayload,
        buildReviewInput: (t, freq) => {
          const { reviewInput } = buildTurnReviewInput(t, freq)
          return reviewInput
        },
        getExpectationsForTurn: (t) => expectationHistory.get(t) || [],

        getUnrankedFragmentsForRanking: (ctx, t) =>
          buildUnrankedFragmentsFromDocumentMemory(ctx, t),
        rankFragments: async (ctx, allUnrankedWithToolContext, t, emitter) => {
          return await batchRankFragments(
            ctx,
            allUnrankedWithToolContext,
            message,
            messagesWithNoErrResponse,
            t,
            emitter
          )
        },
        mergeCurrentTurnIntoCrossTurn: (ctx, t, rankedDocIds) => {
          const docs = Array.from(ctx.currentTurnDocumentMemory.values()).filter(
            (doc) => !rankedDocIds || rankedDocIds.has(doc.docId),
          )
          if (docs.length > 0) {
            const newChunks = mergeDocumentStatesIntoDocumentMemory(
              ctx.documentMemory,
              docs,
              t,
            )
            if (newChunks > 0) {
              ctx.turnNewChunksCount.set(
                t,
                (ctx.turnNewChunksCount.get(t) ?? 0) + newChunks,
              )
            }
          }
        },

        flushExpectations: () => {
          pendingExpectations.length = 0
        },
        resetTurnArtifacts: resetCurrentTurnArtifacts,
        clearAttachmentPhase: (ctx) => {
          const attachmentState = getAttachmentPhaseMetadata(ctx)
          if (attachmentState.initialAttachmentPhase) {
            ctx.chat.metadata = {
              ...ctx.chat.metadata,
              initialAttachmentPhase: false,
            }
          }
        },
      })
    }

    // Reuse parent's emitter when provided so nested agent reasoning streams to the same SSE.
    // Tag every payload with agent name and delegationRunId so the frontend can:
    // - Treat as delegated (swallow TurnStarted, group steps).
    // - Group by delegationRunId = one container per run_public_agent call (multiple calls → multiple containers).
    const delegatedAgentName =
      (agentRecord as { name?: string }).name ||
      params.agentId ||
      "Delegated agent"
    // Prefer the ID pre-generated at delegation time (tool_requests handler) so
    // agentDelegated, all inner steps, and agentCompleted share the same key.
    // Fall back to the internal runId only when called without a parent context.
    const effectiveDelegationRunId = params.delegationRunId ?? runId
    const emitReasoningStep: ReasoningEmitter = params.reasoningEmitter
      ? async (payload) => {
          await params.reasoningEmitter!({
            ...payload,
            agent: delegatedAgentName,
            delegationRunId: effectiveDelegationRunId,
            turnNumber: payload.turnNumber ?? currentTurn,
          })
        }
      : async (_payload) => {
          return
        }

    const runAndBroadcastReview = async (
      context: AgentRunContext,
      reviewInput: AutoReviewInput,
      iteration: number,
    ): Promise<ReviewResult | null> => {
      if (!reviewsAllowed(context)) {
        Logger.info(
          {
            turn: iteration,
            chatId: context.chat.externalId,
            lockedAtTurn: context.review.lockedAtTurn,
            focus: reviewInput.focus,
          },
          `[DelegatedAgenticRun] Review skipped for focus '${reviewInput.focus}' due to final synthesis lock.`,
        )
        return null
      }
      if (
        (!reviewInput.expectedResults ||
          reviewInput.expectedResults.length === 0) &&
        reviewInput.focus !== "run_end"
      ) {
        Logger.warn(
          { turn: iteration, focus: reviewInput.focus },
          "[DelegatedAgenticRun] No expected results recorded for review input.",
        )
      }
      const reviewResult = await performAutomaticReview(reviewInput, context)
      await handleReviewOutcome(
        context,
        reviewResult,
        iteration,
        reviewInput.focus,
        emitReasoningStep,
      )
      return reviewResult
    }

    const runCfg: JAFRunConfig<AgentRunContext> & {
      onEvent?: (event: TraceEvent) => void
    } = {
      agentRegistry,
      modelProvider,
      maxTurns: Math.min(DELEGATED_RUN_MAX_TURNS, 100),
      modelOverride: delegateModelId,
      onTurnEnd: async ({ turn }) => {
        await runTurnEndReviewAndCleanup(turn)
      },
      onAfterToolExecution: async (
        toolName: string,
        result: any,
        hookContext: any,
      ) => {
        const callIdRaw = hookContext?.toolCall?.id
        const normalizedCallId = hookContext?.toolCall
          ? (syntheticToolCallIds.get(hookContext.toolCall) ??
            (callIdRaw === undefined || callIdRaw === null
              ? undefined
              : String(callIdRaw)))
          : undefined
        let expectationForCall: ToolExpectation | undefined
        if (normalizedCallId && expectedResultsByCallId.has(normalizedCallId)) {
          expectationForCall = expectedResultsByCallId.get(normalizedCallId)
          expectedResultsByCallId.delete(normalizedCallId)
        }
        let turnForCall = normalizedCallId
          ? toolCallTurnMap.get(normalizedCallId)
          : undefined
        if (normalizedCallId) {
          toolCallTurnMap.delete(normalizedCallId)
        }
        if (turnForCall === undefined || turnForCall < MIN_TURN_NUMBER) {
          turnForCall = agentContext.turnCount ?? currentTurn ?? MIN_TURN_NUMBER
        }
        // Per-call scoped emitter — same race-free pattern as the main run.
        // runPublicAgent is excluded because its events group by delegationRunId.
        const toolScopedEmitter: ReasoningEmitter =
          normalizedCallId && toolName !== XyneTools.runPublicAgent
            ? async (payload) =>
                emitReasoningStep({
                  ...payload,
                  toolExecutionId: normalizedCallId,
                })
            : emitReasoningStep
        const hookResult = await afterToolExecutionHook(
          toolName,
          result,
          hookContext,
          message,
          messagesWithNoErrResponse,
          expectationForCall,
          turnForCall,
          toolScopedEmitter,
        )
        return hookResult
      },
    }

    const traceEventHandler = async (event: TraceEvent) => {
      if (event.type !== "before_tool_execution") return undefined
      return beforeToolExecutionHook(
        event.data.toolName,
        event.data.args,
        agentContext,
        emitReasoningStep,
      )
    }
    runCfg.onEvent = (event) => {
      logJAFTraceEvent(
        {
          chatId: agentContext.chat.externalId,
          email: params.userEmail,
          flow: "DelegatedAgenticRun",
          runId,
        },
        event,
      )
    }

    let answer = ""
    const streamAnswerText = async (text: string) => {
      if (!text) return
      throwIfStopRequested(params.stopSignal)
      answer += text
    }
    agentContext.runtime = {
      streamAnswerText,
      emitReasoning: async (payload) =>
        emitReasoningStep(payload as ReasoningEventPayload),
    }
    logContextMutation(
      agentContext,
      "[DelegatedAgenticRun][Context] Attached runtime callbacks",
      {
        hasStreamAnswerText: true,
        hasEmitReasoning: true,
      },
    )

    let currentTurn = MIN_TURN_NUMBER
    let runCompleted = false
    let runFailedMessage: string | null = null

    try {
      for await (const evt of runStream<AgentRunContext, string>(
        runState,
        runCfg,
        traceEventHandler,
      )) {
        throwIfStopRequested(params.stopSignal)
        switch (evt.type) {
          case "turn_start": {
            agentContext.turnCount = evt.data.turn
            currentTurn = evt.data.turn
            flushExpectationBufferToTurn(currentTurn)

            // Cooldown: recover expired tools, filter out cooled-down ones
            const dCooldown = new ToolCooldownManager(agentContext.failedTools)
            const dRecovered = dCooldown.recoverExpiredTools(currentTurn)
            if (dRecovered.length > 0) {
              await emitReasoningEvent(
                emitReasoningStep,
                ReasoningSteps.toolRecovered(dRecovered),
              )
            }
            const dActiveTools = dCooldown.getAvailableTools(
              allTools,
              currentTurn,
            )
            agentContext.enabledTools = new Set(
              dActiveTools.map((t) => t.schema.name),
            )

            Logger.debug(
              {
                turn: currentTurn,
                agentName: evt.data.agentName,
                chatId: agentContext.chat.externalId,
                runId,
                jafRunState: runState,
                agentSystemPrompt: sanitizeAgentSystemPromptSnapshot(
                  agentContext.dedicatedAgentSystemPrompt,
                ),
              },
              "[DelegatedAgenticRun] Turn start LLM input",
            )

            await emitReasoningEvent(
              emitReasoningStep,
              ReasoningSteps.turnStarted(currentTurn),
            )
            break
          }

          case "tool_requests":
            for (const [idx, toolCall] of evt.data.toolCalls.entries()) {
              const normalizedCallId = ensureToolCallId(
                toolCall,
                currentTurn,
                idx,
              )
              toolCallTurnMap.set(normalizedCallId, currentTurn)
              const assignedExpectation = consumePendingExpectation(
                pendingExpectations,
                toolCall.name,
              )
              if (assignedExpectation) {
                expectedResultsByCallId.set(
                  normalizedCallId,
                  assignedExpectation.expectation,
                )
              }
              const dToolQuery = extractToolQuery(
                toolCall.name,
                (toolCall.args ?? {}) as Record<string, unknown>,
              )
              await emitReasoningEvent(emitReasoningStep, {
                ...ReasoningSteps.toolSelected(toolCall.name, dToolQuery),
                toolExecutionId: normalizedCallId,
              })
            }
            break

          case "tool_call_start":
            // Intent already emitted by tool_requests handler — no duplicate emit here.
            break

          case "tool_call_end": {
            // Track consecutive errors for cooldown manager; review
            // happens at turn-end via the pipeline (no per-tool review).
            if (evt.data.error) {
              const newCount =
                (consecutiveToolErrors.get(evt.data.toolName) ?? 0) + 1
              consecutiveToolErrors.set(evt.data.toolName, newCount)
            } else {
              consecutiveToolErrors.delete(evt.data.toolName)
            }
            break
          }

          case "turn_end":
            // turnToolSummary / turnNoTools duplicate review_completed; omitted here.
            break

          case "assistant_message": {
            const content = getTextContent(evt.data.message.content) || ""
            if (content) {
              const extractedExpectations = extractExpectedResults(content)
              if (extractedExpectations.length > 0) {
                await emitReasoningEvent(
                  emitReasoningStep,
                  ReasoningSteps.expectationsSet(),
                )
                pendingExpectations.push(...extractedExpectations)
                if (currentTurn > 0) {
                  recordExpectationsForTurn(currentTurn, extractedExpectations)
                } else {
                  expectationBuffer.push(...extractedExpectations)
                }
              }
            }

            const hasToolCalls =
              Array.isArray(evt.data.message?.tool_calls) &&
              (evt.data.message.tool_calls?.length ?? 0) > 0

            if (hasToolCalls) {
              // Tool intent is emitted by the tool_requests handler — no duplicate here.
              break
            }

            if (agentContext.finalSynthesis.suppressAssistantStreaming) {
              // Only emit synthesisCompleted here if the synthesizeFinalAnswer tool
              // hasn't already done so (it sets .completed = true before emitting).
              if (content?.trim() && !agentContext.finalSynthesis.completed) {
                agentContext.finalSynthesis.ackReceived = true
                await emitReasoningEvent(
                  emitReasoningStep,
                  ReasoningSteps.synthesisCompleted(),
                )
              }
              break
            }

            if (content) {
              await agentContext.runtime?.streamAnswerText?.(content)
            }
            break
          }

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
              // Review is handled by runTurnEndPipeline (final-turn logic).
              // No duplicate run_end review here.
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
      if (isMessageAgentStopError(error)) {
        throw error
      }
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

    const fragmentsForCitations =
    await getFragmentsForSynthesis(agentContext.documentMemory, {
      email: params.userEmail,
    })

    if (answerForCitations) {
      for await (const event of checkAndYieldCitationsForAgent(
        answerForCitations,
        yieldedCitations,
        fragmentsForCitations,
        yieldedImageCitations,
        params.userEmail,
      )) {
        if (event.citation) {
          citations.push(event.citation.item)
        }
        if (event.imageCitation) {
          imageCitations.push(event.imageCitation)
        }
      }
    }

    const finalAnswer = answerForCitations || "Agent did not return any text."
    const rawDocuments = documentMemoryToRawDocuments(agentContext.documentMemory)

    return {
      result: finalAnswer,
      metadata: {
        agentId: params.agentId,
        contexts: fragmentsToToolContexts(fragmentsForCitations),
        citations,
        imageCitations,
        rawDocuments,
        cost: agentContext.totalCost,
        tokensUsed:
          agentContext.tokenUsage.input + agentContext.tokenUsage.output,
        parentTurn: params.parentTurn,
      },
    }
  } catch (error) {
    if (isMessageAgentStopError(error)) {
      throw error
    }
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
  options: ExecuteMcpAgentOptions,
): Promise<ToolOutput> {
  const connectorId = agentId.replace(/^mcp:/, "")
  const mcpAgent = options.mcpAgents?.find(
    (agent) => agent.agentId === agentId || agent.connectorId === connectorId,
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
        `${idx + 1}. ${tool.toolName} - ${tool.description ?? "No description provided"}`,
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
  let selectedToolsArray: Array<{
    toolName: string
    arguments?: Record<string, unknown>
    rationale?: string
  }> | null = null

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
      max_new_tokens: Math.min(options.maxTokens ?? 800, 1200),
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
      tool_choice: "select_mcp_tools" as unknown as ModelParams["tool_choice"],
    })

    const responseToolCalls =
      selectionResponse.tool_calls ??
      (selectionResponse as { toolCalls?: typeof selectionResponse.tool_calls })
        ?.toolCalls
    const calls = Array.isArray(responseToolCalls)
      ? responseToolCalls.map((tc: any) => ({
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
  resourceAccess?: ResourceAccessSummary[],
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
Resource readiness: ${summarizeResourceAccess(brief.resourceAccess)}`,
    )
    .join("\n\n")
}

function summarizeResourceAccess(
  resourceAccess?: ResourceAccessSummary[],
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
  totalEvaluated: number,
): ListCustomAgentsOutput {
  const tokens = query.toLowerCase().split(/\s+/)
  const scored = briefs.map((brief) => {
    const text =
      `${brief.agentName} ${brief.description} ${brief.capabilities.join(" ")}`.toLowerCase()
    const baseScore =
      tokens.reduce((acc, token) => (text.includes(token) ? acc + 1 : acc), 0) /
      Math.max(tokens.length, 1)
    const penalty = brief.resourceAccess?.some(
      (entry) => entry.status === "missing",
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
    agents: selected.length ? selected : null,
    totalEvaluated,
  }
}
