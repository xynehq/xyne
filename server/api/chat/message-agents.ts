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
import { getChatMessagesWithAuth, insertMessage } from "@/db/message"
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
import { parseAgentAppIntegrations } from "./tools/utils"
import type {
  Citation,
  FragmentImageReference,
  ImageCitation,
  MinimalAgentFragment,
} from "./types"
import {
  checkAndYieldCitationsForAgent,
  collectReferencedFileIdsUntilCompaction,
  extractFileIdsFromMessage,
  extractImageFileNames,
  isMessageWithContext,
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
  fragments: [],
  unrankedFragmentsByTool: new Map(),
  expectations: [],
  toolOutputs: [],
  images: [],
  executionToolsCalled: 0,
  todoWriteCalled: false,
  turnStartedAt: Date.now(),
})

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

const RECENT_IMAGE_WINDOW = 2

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
    seenDocumentsCount: context.seenDocuments.size,
    seenDocumentsSample: Array.from(context.seenDocuments).slice(0, 10),
    allFragmentsCount: context.allFragments.length,
    allImagesCount: context.allImages.length,
    recentImagesCount: context.recentImages.length,
    currentTurnFragmentCount: context.currentTurnArtifacts.fragments.length,
    currentTurnImageCount: context.currentTurnArtifacts.images.length,
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

/**
 * Deduplication key for fragments: Vespa document id when present, otherwise fragment id.
 * All dedupe (merge, seenDocuments, excludedIds) should rely on this so the same document
 * is not stored or re-fetched under different synthetic ids (e.g. docA:0, agentX:docA:turn:0).
 */
function getFragmentDedupKey(fragment: MinimalAgentFragment): string {
  if (!fragment?.id) return ""
  const vespaDocId = fragment.source?.docId
  if (vespaDocId != null && vespaDocId !== "") return vespaDocId
  return fragment.id
}

function mergeFragmentLists(
  target: MinimalAgentFragment[],
  incoming: MinimalAgentFragment[],
): MinimalAgentFragment[] {
  if (!incoming.length) {
    return target
  }
  const merged = [...target]
  const indexByDedupKey = new Map<string, number>()
  merged.forEach((fragment, idx) => {
    const key = getFragmentDedupKey(fragment)
    if (key) indexByDedupKey.set(key, idx)
  })
  for (const fragment of incoming) {
    const key = getFragmentDedupKey(fragment)
    if (!key) continue
    const existingIndex = indexByDedupKey.get(key)
    if (existingIndex !== undefined) {
      merged[existingIndex] = fragment
    } else {
      indexByDedupKey.set(key, merged.length)
      merged.push(fragment)
    }
  }
  return merged
}

function mergeImageReferences(
  target: FragmentImageReference[],
  incoming: FragmentImageReference[],
): FragmentImageReference[] {
  if (!incoming.length) {
    return target
  }
  const merged = [...target]
  const indexByFile = new Map<string, number>()
  merged.forEach((image, idx) => indexByFile.set(image.fileName, idx))
  for (const image of incoming) {
    if (!image?.fileName) continue
    const existingIndex = indexByFile.get(image.fileName)
    if (existingIndex !== undefined) {
      merged[existingIndex] = image
    } else {
      indexByFile.set(image.fileName, merged.length)
      merged.push(image)
    }
  }
  return merged
}

function extractImagesFromFragments(
  fragments: MinimalAgentFragment[],
): FragmentImageReference[] {
  const references: FragmentImageReference[] = []
  for (const fragment of fragments) {
    if (!Array.isArray(fragment.images) || fragment.images.length === 0)
      continue
    for (const image of fragment.images) {
      if (image?.fileName) {
        references.push(image)
      }
    }
  }
  return references
}

function recordFragmentsForContext(
  context: AgentRunContext,
  fragments: MinimalAgentFragment[],
  turnNumber: number,
): void {
  if (!fragments.length) return

  const seenDocumentsBefore = context.seenDocuments.size
  const addedSeenDocumentIds: string[] = []

  fragments.forEach((fragment) => {
    const vespaDocId = fragment.source?.docId
    if (vespaDocId != null && vespaDocId !== "") {
      if (!context.seenDocuments.has(vespaDocId)) {
        addedSeenDocumentIds.push(vespaDocId)
      }
      context.seenDocuments.add(vespaDocId)
    }
  })

  context.currentTurnArtifacts.fragments = mergeFragmentLists(
    context.currentTurnArtifacts.fragments,
    fragments,
  )
  context.allFragments = mergeFragmentLists(context.allFragments, fragments)
  const existingForTurn = context.turnFragments.get(turnNumber) ?? []
  context.turnFragments.set(
    turnNumber,
    mergeFragmentLists(existingForTurn, fragments),
  )

  logContextMutation(
    context,
    "[MessageAgents][Context] Recorded fragments and updated seenDocuments",
    {
      turnNumber,
      fragmentCount: fragments.length,
      fragmentIds: fragments.map((fragment) => fragment.id),
      addedSeenDocumentIds,
      seenDocumentsBefore,
      seenDocumentsAfter: context.seenDocuments.size,
      turnFragmentCount: (context.turnFragments.get(turnNumber) || []).length,
    },
  )

  const fragmentImages = extractImagesFromFragments(fragments)
  if (fragmentImages.length > 0) {
    context.currentTurnArtifacts.images = mergeImageReferences(
      context.currentTurnArtifacts.images,
      fragmentImages,
    )
    logContextMutation(
      context,
      "[MessageAgents][Context] Updated current turn images from fragments",
      {
        turnNumber,
        fragmentCount: fragments.length,
        imageNames: fragmentImages.map((img) => img.fileName),
        addedImageCount: fragmentImages.length,
      },
    )
  }
}

function resetCurrentTurnArtifacts(context: AgentRunContext): void {
  const previousArtifacts = context.currentTurnArtifacts
  context.currentTurnArtifacts = createEmptyTurnArtifacts()
  logContextMutation(
    context,
    "[MessageAgents][Context] Reset current turn artifacts",
    {
      clearedFragmentCount: previousArtifacts.fragments.length,
      clearedImageCount: previousArtifacts.images.length,
      clearedExpectationCount: previousArtifacts.expectations.length,
      clearedToolOutputCount: previousArtifacts.toolOutputs.length,
    },
  )
}

function finalizeTurnImages(
  context: AgentRunContext,
  turnNumber: number,
): void {
  const imagesForTurn = context.currentTurnArtifacts.images
  context.imagesByTurn.set(turnNumber, [...imagesForTurn])
  context.allImages = mergeImageReferences(context.allImages, imagesForTurn)
  const recentTurns = Array.from(context.imagesByTurn.keys())
    .sort((a, b) => a - b)
    .slice(-RECENT_IMAGE_WINDOW)
  const flattened: FragmentImageReference[] = []
  for (const recentTurn of recentTurns) {
    const refs = context.imagesByTurn.get(recentTurn)
    if (refs?.length) {
      flattened.push(...refs)
    }
  }
  context.recentImages = mergeImageReferences([], flattened)
  context.currentTurnArtifacts.images = []
  logContextMutation(
    context,
    "[MessageAgents][Context] Finalized turn images",
    {
      turnNumber,
      committedImages: imagesForTurn.map((img) => img.fileName),
      recentWindow: recentTurns,
      recentImages: context.recentImages.map((img) => img.fileName),
      allImagesCount: context.allImages.length,
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

type FragmentImageOptions = {
  turnNumber: number
  sourceToolName: string
  isUserAttachment: boolean
}

function attachImagesToFragments(
  fragments: MinimalAgentFragment[],
  imageNames: string[],
  options: FragmentImageOptions,
): MinimalAgentFragment[] {
  if (!Array.isArray(imageNames) || imageNames.length === 0) {
    return fragments
  }

  const fragmentIndexMap = new Map<number, string>()
  fragments.forEach((fragment, idx) => fragmentIndexMap.set(idx, fragment.id))

  const referencesByFragment = new Map<string, FragmentImageReference[]>()
  for (const imageName of imageNames) {
    if (!imageName) continue
    const fragmentId = getFragmentIdFromImageName(
      imageName,
      fragmentIndexMap,
      fragments[0]?.id || "",
    )
    if (!fragmentId) continue
    const ref: FragmentImageReference = {
      fileName: imageName,
      addedAtTurn: options.turnNumber,
      sourceFragmentId: fragmentId,
      sourceToolName: options.sourceToolName,
      isUserAttachment: options.isUserAttachment,
    }
    const existing = referencesByFragment.get(fragmentId)
    if (existing) {
      existing.push(ref)
    } else {
      referencesByFragment.set(fragmentId, [ref])
    }
  }

  if (referencesByFragment.size === 0) {
    return fragments
  }

  return fragments.map((fragment) => {
    const refs = referencesByFragment.get(fragment.id)
    if (!refs || refs.length === 0) {
      return fragment
    }

    const existing = fragment.images ?? []
    const seen = new Set(existing.map((img) => img.fileName))
    const merged = [...existing]
    for (const ref of refs) {
      if (!seen.has(ref.fileName)) {
        merged.push(ref)
        seen.add(ref.fileName)
      }
    }

    return {
      ...fragment,
      images: merged,
    }
  })
}

function getFragmentIdFromImageName(
  imageName: string,
  fragmentIndexMap: Map<number, string>,
  fallback = "",
): string {
  const separatorIdx = imageName.indexOf("_")
  if (separatorIdx <= 0) return fallback
  const docIndex = Number(imageName.slice(0, separatorIdx))
  if (Number.isNaN(docIndex)) return fallback
  return fragmentIndexMap.get(docIndex) ?? fallback
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

function advancePlanAfterTool(
  context: AgentRunContext,
  toolName: string,
  wasSuccessful: boolean,
  detail?: string,
): void {
  if (!context.plan || !context.currentSubTask) return
  const task = context.plan.subTasks.find(
    (entry) => entry.id === context.currentSubTask,
  )
  if (!task) return
  normalizeSubTask(task)
  const requiredTools = (task.toolsRequired ??= [])

  if (wasSuccessful) {
    if (task.status === "pending" || task.status === "blocked") {
      task.status = "in_progress"
      task.error = undefined
    }
    if (requiredTools.length === 0 || requiredTools.includes(toolName)) {
      task.status = "completed"
      task.completedAt = Date.now()
      task.result = detail || task.result || `Completed using ${toolName}`
      const previousTaskId = task.id
      const nextId = selectActiveSubTaskId(context.plan)
      if (nextId && nextId !== previousTaskId) {
        context.currentSubTask = nextId
        const nextTask = context.plan.subTasks.find(
          (entry) => entry.id === nextId,
        )
        if (nextTask && nextTask.status === "pending") {
          nextTask.status = "in_progress"
          nextTask.error = undefined
        }
      } else if (!nextId) {
        context.currentSubTask = null
      }
    }
  } else if (task.status !== "completed") {
    task.status = "blocked"
    task.error = detail
  }
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

export function buildFinalSynthesisPayload(
  context: AgentRunContext,
  fragmentsLimit = Math.max(12, context.allFragments.length || 1),
): { systemPrompt: string; userMessage: string } {
  const fragments = context.allFragments
  const agentSystemPromptBlock = buildAgentSystemPromptContextBlock(
    context.dedicatedAgentSystemPrompt,
  )
  const agentSystemPromptSection = agentSystemPromptBlock
    ? `Agent System Prompt Context:\n${agentSystemPromptBlock}`
    : ""
  const formattedFragments = formatFragmentsWithMetadata(
    fragments,
    fragmentsLimit,
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

  const parts = [
    `User Question:\n${context.message.text}`,
    agentSystemPromptSection,
    planSection ? `Execution Plan Snapshot:\n${planSection}` : "",
    clarificationSection
      ? `Clarifications Resolved:\n${clarificationSection}`
      : "",
    workspaceSection,
    fragmentsSection,
  ].filter(Boolean)

  const userMessage = parts.join("\n\n")

  const systemPrompt = `
### Mission
- Deliver the user's final answer using the conversation, plan snapshot, clarifications, workspace context, context fragments, and supplied images; never plan or call tools.

### Evidence Intake
- Prioritize the highest-signal fragments, but pull any supporting fragment that improves accuracy.
- Only draw on context that directly answers the user's question; ignore unrelated fragments even if they were retrieved earlier.
- Treat delegated-agent outputs as citeable fragments; reference them like any other context entry.
- Describe evidence gaps plainly before concluding; never guess.
- Extract actionable details from provided images and cite them via their fragment indices.
- Respect user-imposed constraints using fragment metadata (any metadata field). If compliant evidence is missing, state that clearly.
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

function selectImagesForFinalSynthesis(context: AgentRunContext): {
  selected: string[]
  total: number
  dropped: string[]
  userAttachmentCount: number
} {
  const images = context.allImages
  const total = images.length
  if (!IMAGE_CONTEXT_CONFIG.enabled || total === 0) {
    return { selected: [], total, dropped: [], userAttachmentCount: 0 }
  }

  const attachments = images.filter((img) => img.isUserAttachment)
  const nonAttachments = images
    .filter((img) => !img.isUserAttachment)
    .sort((a, b) => {
      const ageA = context.turnCount - a.addedAtTurn
      const ageB = context.turnCount - b.addedAtTurn
      return ageA - ageB
    })

  const prioritized = [...attachments, ...nonAttachments]
  const uniqueNames: string[] = []
  const seen = new Set<string>()
  for (const image of prioritized) {
    if (seen.has(image.fileName)) continue
    seen.add(image.fileName)
    uniqueNames.push(image.fileName)
  }

  let selected = uniqueNames
  let dropped: string[] = []

  if (
    IMAGE_CONTEXT_CONFIG.maxImagesPerCall > 0 &&
    uniqueNames.length > IMAGE_CONTEXT_CONFIG.maxImagesPerCall
  ) {
    selected = uniqueNames.slice(0, IMAGE_CONTEXT_CONFIG.maxImagesPerCall)
    dropped = uniqueNames.slice(IMAGE_CONTEXT_CONFIG.maxImagesPerCall)
  }

  return {
    selected,
    total,
    dropped,
    userAttachmentCount: attachments.length,
  }
}

/** Synthetic tool name for initial memory context (episodic + chat memory). */
const INITIAL_TOOL_MESSAGE = "initialToolMessage"
/** Synthetic tool name for attachment fragments context. */
const ATTACHMENT_TOOL_MESSAGE = "attachmentToolMessage"

/**
 * Builds a synthetic tool-result message for memory context (episodic + chat memory).
 * Model receives this as low-privilege tool output, not system instructions.
 */
function buildInitialToolMessage(options: {
  episodicMemoriesText?: string
  chatMemoryText?: string
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
    content: JSON.stringify(envelope),
  }
}

/**
 * Builds a synthetic tool-result message for attachment fragments.
 * Model receives this as low-privilege tool output, not system instructions.
 */
function buildAttachmentToolMessage(
  fragments: MinimalAgentFragment[],
  summary: string,
): JAFMessage {
  const resultPayload = ToolResponse.success({ summary, fragments })
  const envelope = {
    status: "executed",
    result: JSON.stringify(resultPayload),
    tool_name: ATTACHMENT_TOOL_MESSAGE,
    message: "Attachment context prepared.",
  }
  return {
    role: "tool",
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
    clarifications: [],
    ambiguityResolved: false,
    toolCallHistory: [],
    seenDocuments: new Set<string>(),
    allFragments: [],
    turnFragments: new Map<number, MinimalAgentFragment[]>(),
    allImages: [],
    imagesByTurn: new Map<number, FragmentImageReference[]>(),
    recentImages: [],
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

async function vespaResultToAttachmentFragment(
  child: VespaSearchResult,
  idx: number,
  userMetadata: UserMetadataType,
  query: string,
  allowChunkCitations?: boolean,
  maxSummaryChunks?: number,
  precomputedDbContext?: Map<string, string>,
): Promise<MinimalAgentFragment> {
  const docId =
    (child.fields as Record<string, unknown>)?.docId ||
    `attachment_fragment_${idx}`

  return {
    id: String(docId),
    content: await answerContextMap(
      child as VespaSearchResults,
      userMetadata,
      maxSummaryChunks ? maxSummaryChunks : 0,
      true,
      allowChunkCitations ?? false,
      query,
      precomputedDbContext,
    ),
    source: searchToCitation(child as VespaSearchResults),
    confidence: 1,
  }
}

async function prepareInitialAttachmentContext(
  fileIds: string[],
  threadIds: string[],
  userMetadata: UserMetadataType,
  query: string,
  email: string,
  allowChunkCitations?: boolean,
): Promise<{ fragments: MinimalAgentFragment[]; summary: string } | null> {
  if (!fileIds?.length) {
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
    let chunksPerDocument: number[] = []
    const targetChunks = config.maxChunksPerPage
    const maxSummaryChunks = config.maxDefaultSummary

    if (fileIds && fileIds.length > 0) {
      const fileSearchSpan = span.startSpan("file_search")
      let results
      // Split into 3 groups
      // Search each group
      // Push results to combinedSearchResponse
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
        allowChunkCitations = true // for the case where kb files are in @
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
        if (results.root.children) {
          combinedSearchResponse.push(...results.root.children)
        }
      }

      // Apply intelligent chunk selection based on document relevance and chunk scores
      chunksPerDocument = await getChunkCountPerDoc(
        combinedSearchResponse,
        targetChunks,
        email,
        fileSearchSpan,
      )
      fileSearchSpan?.end()
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

          // Use the helper function to process thread results
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

    const precomputedDbContext = await getPrecomputedDbContextIfNeeded(
      combinedSearchResponse as VespaSearchResults[],
      query,
      userMetadata.userId,
      userMetadata.workspaceId,
    )
    const fragments = await Promise.all(
      combinedSearchResponse.map((child, idx) =>
        vespaResultToAttachmentFragment(
          child as VespaSearchResult,
          idx,
          userMetadata,
          query,
          allowChunkCitations,
          idx < chunksPerDocument.length ? chunksPerDocument[idx] : maxSummaryChunks,
          precomputedDbContext,
        ),
      ),
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

  // 3. Add excludedIds to prevent re-fetching seen documents
  if (args?.excludedIds !== undefined) {
    const providedExcludedIds = normalizeExcludedIdsForLogging(args.excludedIds)
    const seenDocIds = Array.from(context.seenDocuments)
    const mergedExcludedIds = [...providedExcludedIds, ...seenDocIds]

    logContextMutation(
      context,
      "[beforeToolExecutionHook] Merged excludedIds with seenDocuments",
      {
        toolName,
        args,
        providedExcludedIds,
        providedExcludedIdsCount: providedExcludedIds.length,
        seenDocumentIds: seenDocIds,
        seenDocumentCount: seenDocIds.length,
        mergedExcludedIds,
        mergedExcludedIdsCount: mergedExcludedIds.length,
      },
    )

    return {
      ...args,
      excludedIds: mergedExcludedIds,
    }
  }

  logContextMutation(
    context,
    "[beforeToolExecutionHook] excludedIds not provided on tool args",
    {
      toolName,
      args,
      seenDocumentIds: Array.from(context.seenDocuments),
    },
  )

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
  gatheredFragmentsKeys: Set<string>,
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
      seenDocumentIds: Array.from(context.seenDocuments),
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

  const toolFragments: MinimalAgentFragment[] = []
  const addToolFragments = (fragments: MinimalAgentFragment[]) => {
    if (!Array.isArray(fragments) || fragments.length === 0) {
      return
    }
    const deduped: MinimalAgentFragment[] = []
    const skippedKeys: string[] = []
    for (const fragment of fragments) {
      const key = getFragmentDedupKey(fragment)
      if (!key) continue
      if (gatheredFragmentsKeys.has(key)) {
        skippedKeys.push(key)
        continue
      }
      gatheredFragmentsKeys.add(key)
      deduped.push(fragment)
    }
    if (deduped.length !== fragments.length) {
      Logger.info(
        {
          toolName,
          incoming: fragments.length,
          deduped: deduped.length,
          skippedKeys,
        },
        "[afterToolExecutionHook] Deduplicated tool fragments (by Vespa docId / dedup key)",
      )
    }
    if (!deduped.length) {
      return
    }
    toolFragments.push(...deduped)
    recordFragmentsForContext(context, deduped, effectiveTurnNumber)
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

  advancePlanAfterTool(context, toolName, status === "success")

  // 5. Extract and filter contexts
  const resultData = result?.data
  let contexts: MinimalAgentFragment[] = []
  if (Array.isArray(resultData)) {
    contexts = resultData as unknown as MinimalAgentFragment[]
  } else if (resultData && typeof resultData === "object") {
    const fragmentsCandidate = (resultData as { fragments?: unknown }).fragments
    if (Array.isArray(fragmentsCandidate)) {
      contexts = fragmentsCandidate as MinimalAgentFragment[]
    }
  }
  if (!Array.isArray(contexts) || contexts.length === 0) {
    const legacyContexts = getMetadataValue<MinimalAgentFragment[]>(
      result,
      "contexts",
    )
    if (Array.isArray(legacyContexts)) {
      contexts = legacyContexts
    }
  }

  // LOG: Context extraction results
  loggerWithChild({ email: context.user.email }).info(
    {
      toolName,
      totalContextsExtracted: contexts.length,
      gatheredFragmentsKeysSize: gatheredFragmentsKeys.size,
    },
    "[afterToolExecutionHook] Context extraction completed",
  )

  // ── Fragment collection (deferred ranking) ──────────────────────────
  // Instead of ranking per-tool (N LLM calls), we collect all unranked
  // fragments here and defer ranking to a single batch call at turn-end
  // via the turn-lifecycle pipeline. This eliminates N-1 redundant LLM
  // calls and gives the ranker full cross-tool context.
  if (Array.isArray(contexts) && contexts.length > 0) {
    const filteredContexts = contexts.filter((c: MinimalAgentFragment) => {
      const key = getFragmentDedupKey(c)
      return !key || !gatheredFragmentsKeys.has(key)
    })

    loggerWithChild({ email: context.user.email }).info(
      {
        toolName,
        totalContexts: contexts.length,
        filteredContextsCount: filteredContexts.length,
        duplicatesFiltered: contexts.length - filteredContexts.length,
      },
      "[afterToolExecutionHook] Filtered out duplicate contexts",
    )

    if (filteredContexts.length > 0) {
      // Mark dedup keys as seen
      for (const c of filteredContexts) {
        const key = getFragmentDedupKey(c)
        if (key) gatheredFragmentsKeys.add(key)
      }

      await emitReasoningEvent(
        reasoningEmitter,
        ReasoningSteps.documentsFound(filteredContexts.length, toolName)
      )

      // Store unranked fragments keyed by tool — one batch per searchGlobal invocation (provenance preserved)
      const toolQuery = extractToolQuery(toolName, args as Record<string, unknown>) ?? ""
      const key = toolName+":"+toolQuery
      const existing = context.currentTurnArtifacts.unrankedFragmentsByTool.get(key)
      const mergedFragments = mergeFragmentLists(
        existing?.fragments ?? [],
        filteredContexts
      )
      context.currentTurnArtifacts.unrankedFragmentsByTool.set(key, {
        query: toolQuery,
        fragments: mergedFragments,
      })

      loggerWithChild({ email: context.user.email }).debug(
        {
          toolName,
          deferredCount: filteredContexts.length,
          totalDeferredForTool: (existing?.fragments?.length ?? 0) + filteredContexts.length,
        },
        "[afterToolExecutionHook] Fragments deferred to turn-end batch ranking"
      )
    }
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

  // After synthesizeFinalAnswer completes, advancePlanAfterTool (called above) marks
  // the last subtask as "completed" in server memory, but no event is sent to the
  // frontend — so the last todo step stays in loading state. Re-emit the plan with
  // its updated (all-completed) subtask statuses so the frontend can reflect the change.
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
      gatheredFragmentsKeys,
      agentId,
      agentName,
      turnNumber: effectiveTurnNumber,
      sourceToolName: toolName,
    })
    if (delegationFragments.length > 0) {
      addToolFragments(delegationFragments)
    }
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

  context.currentTurnArtifacts.toolOutputs.push({
    toolName,
    arguments: args,
    status: record.status,
    resultSummary: summarizeToolResultPayload(result),
    fragments: toolFragments,
  })
  logContextMutation(
    context,
    "[afterToolExecutionHook] Recorded tool output for current turn",
    {
      toolName,
      turnNumber: effectiveTurnNumber,
      toolFragmentsCount: toolFragments.length,
      toolFragmentIds: toolFragments.map((fragment) => fragment.id),
      resultSummary: summarizeToolResultPayload(result),
    },
  )

  // Emit toolCompleted here so it uses the per-call scoped emitter passed in
  // from onAfterToolExecution — this ensures correct toolExecutionId for parallel
  // tool calls. runPublicAgent uses agentCompleted (emitted above) instead.
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
  gatheredFragmentsKeys: Set<string>
  agentId?: string
  agentName?: string
  turnNumber: number
  sourceToolName: string
}): MinimalAgentFragment[] {
  const {
    result,
    gatheredFragmentsKeys,
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
      if (gatheredFragmentsKeys.has(fragmentId)) return
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
    if (!gatheredFragmentsKeys.has(attributionFragmentId)) {
      agentFragments.push({
        id: attributionFragmentId,
        content:
          textResult ||
          `Response provided by delegated agent ${normalizedAgentName}`,
        source: baseSource,
        confidence: 0.9,
      })
    }
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
      const fragmentSummary = output.fragments?.length
        ? `${output.fragments.length} fragment${output.fragments.length === 1 ? "" : "s"}`
        : "0 fragments"
      return `${idx + 1}. ${output.toolName} [${output.status}]\n   Args: ${argsSummary}\n   Result: ${output.resultSummary ?? "No result summary available."}\n   Fragments: ${fragmentSummary}`
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
  const fragmentKeyToToolContext = new Map<string, { toolName: string; toolQuery: string }>()
  for (const { fragment, toolName, toolQuery } of allUnrankedWithToolContext) {
    const key = getFragmentDedupKey(fragment) || fragment.id || ""
    if (!fragmentKeyToToolContext.has(key)) {
      fragmentKeyToToolContext.set(key, { toolName, toolQuery })
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
          toolContext?.toolQuery
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
    selectedDocs = strictNoCompliantCandidates
      ? []
      : rankingCandidates
  }
  }

  if (selectedDocs.length > 0) {
    await emitReasoningEvent(
      reasoningEmitter,
      ReasoningSteps.documentsFiltered(selectedDocs.length)
    )

    // Extract images from selected documents
    if (IMAGE_CONTEXT_CONFIG.enabled) {
      const vespaLikeResults = selectedDocs.map((doc) => ({
        id: doc.id,
        relevance: 0,
        fields: { docId: doc.source.docId },
      })) as unknown as VespaSearchResult[]
      const combinedContext = selectedDocs.map((doc) => doc.content).join("\n")
      const { imageFileNames: extractedImages } = extractImageFileNames(
        combinedContext,
        vespaLikeResults
      )
      if (extractedImages.length > 0) {
        selectedDocs = attachImagesToFragments(selectedDocs, extractedImages, {
          turnNumber,
          sourceToolName: "batch_ranking",
          isUserAttachment: false,
        })
      }
    }

    // Record into context
    recordFragmentsForContext(context, selectedDocs, turnNumber)
  }

  return selectedDocs
}

export function buildReviewPromptFromContext(
  context: AgentRunContext,
  options?: {
    focus?: string
    turnNumber?: number
  },
  fallbackExpectations?: ToolExpectationAssignment[],
): { prompt: string; imageFileNames: string[] } {
  const turnExpectations =
    context.currentTurnArtifacts.expectations.length > 0
      ? context.currentTurnArtifacts.expectations
      : (fallbackExpectations ?? [])
  const planSection = formatPlanForPrompt(context.plan)
  const clarificationsSection = formatClarificationsForPrompt(
    context.clarifications,
  )
  const workspaceSection = context.userContext?.trim()
    ? `Workspace Context:\n${context.userContext.trim()}`
    : ""
  const useMultiTurnHistory =
    context.toolCallHistory.length > 0 || options?.focus === "turn_end"
  const toolOutputsSection = useMultiTurnHistory
    ? (() => {
        if (context.toolCallHistory.length === 0) {
          return `Tool calls:\n${formatToolCallHistoryByTurn(context.toolCallHistory)}`
        }
        const turns = context.toolCallHistory.map((r) => r.turnNumber)
        const minTurn = Math.min(...turns)
        const maxTurn = Math.max(...turns)
        const label =
          minTurn === maxTurn
            ? `Tool calls (turn ${maxTurn}):`
            : `Tool calls (turns ${minTurn}–${maxTurn}, last ${maxTurn - minTurn + 1} turns):`
        return `${label}\n${formatToolCallHistoryByTurn(context.toolCallHistory)}`
      })()
    : formatToolOutputsForReview(context.currentTurnArtifacts.toolOutputs)
  const expectationsSection = formatExpectationsForReview(turnExpectations)
  const fragmentsSection = answerContextMapFromFragments(
    context.allFragments,
    Math.max(12, context.allFragments.length || 1),
  )
  const currentImages = context.currentTurnArtifacts.images.map(
    (image) => image.fileName,
  )
  const additionalImages = Math.max(
    context.allImages.length - currentImages.length,
    0,
  )
  const imageSection = `Current turn attachments: ${currentImages.length}\nAdditional images available from prior turns: ${additionalImages}`
  const reviewFocus = `Review Focus: ${options?.focus ?? "turn_end"} (Turn ${
    options?.turnNumber ?? context.turnCount
  })`

  const userPromptSections = [
    `User Question:\n${context.message.text}`,
    planSection ? `Execution Plan Snapshot:\n${planSection}` : "",
    clarificationsSection ? `Clarifications:\n${clarificationsSection}` : "",
    workspaceSection,
    `Current Turn Tool Outputs:\n${toolOutputsSection}`,
    `Expectations:\n${expectationsSection}`,
    fragmentsSection || "Context Fragments:\nNone captured yet.",
    `Images:\n${imageSection}`,
    reviewFocus,
  ].filter(Boolean)

  return {
    prompt: userPromptSections.join("\n\n"),
    imageFileNames: currentImages,
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

  const { prompt: userPrompt, imageFileNames: currentImages } =
    buildReviewPromptFromContext(context, options, options?.expectedResults)
  Logger.debug(
    {
      email: context.user.email,
      chatId: context.chat.externalId,
      focus: options?.focus,
      turnNumber: options?.turnNumber,
      reviewImages: currentImages,
      additionalImages: Math.max(
        context.allImages.length - currentImages.length,
        0,
      ),
      fragmentsCount: context.allFragments.length,
      toolOutputsCount: context.currentTurnArtifacts.toolOutputs.length,
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
    systemPrompt: `You are a senior reviewer ensuring each agentic turn honors the agreed plan and tool expectations.
- The tool call section may cover a single turn or multiple turns (e.g. "last N turns"). Inspect every tool call in that section, compare the outputs with the expected results, and decide whether each tool met or missed expectations.
- Evaluate the current plan to see if it still fits the evidence gathered from the tool calls; suggest plan changes when necessary.
- Detect anomalies (unexpected behaviors, contradictory data, missing outputs, or unresolved ambiguities) and call them out explicitly. If intent remains unclear, set ambiguityResolved=false and include the ambiguity notes inside the anomalies array.
${delegationNote}
- When the available context is already relevant and sufficient and it meets all the requirement of user's ask , set planChangeNeeded=true and use planChangeReason to state that the plan should pivot toward final synthesis because the evidence is complete.
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
      planChangeNeeded: false,
      planChangeReason: "Why plan needs updating if true",
      anomaliesDetected: false,
      anomalies: ["Description of anomalies or ambiguities"],
      recommendation: "proceed",
      ambiguityResolved: true,
    })}
- Use native JSON booleans (true/false) for every yes/no field.
- Only emit keys defined in the schema; do not add prose outside the JSON object.`,
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
    },
    "[MessageAgents][runReviewLLM] LLM params prepared",
  )
  Logger.debug(
    {
      email: context.user.email,
      chatId: context.chat.externalId,
      userPrompt,
    },
    "[MessageAgents][runReviewLLM] Review user prompt",
  )

  Logger.debug(
    {
      email: context.user.email,
      chatId: context.chat.externalId,
      systemPrompt: params.systemPrompt,
    },
    "[MessageAgents][runReviewLLM] System prompt",
  )

  const messages: Message[] = [
    {
      role: ConversationRole.USER,
      content: [{ text: userPrompt }],
    },
  ]

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

  const validation = ReviewResultSchema.safeParse(parsed)
  if (!validation.success) {
    Logger.error(
      {
        email: context.user.email,
        chatId: context.chat.externalId,
        error: validation.error.format(),
        raw: parsed,
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

      return ToolResponse.success({
        result: toolOutput.result,
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
    async execute(_args, context) {
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

      const { selected, total, dropped, userAttachmentCount } =
        selectImagesForFinalSynthesis(context)
      loggerWithChild({ email: context.user.email }).debug(
        {
          chatId: context.chat.externalId,
          selectedImages: selected,
          totalImages: total,
          droppedImages: dropped,
          userAttachmentCount,
        },
        "[MessageAgents][FinalSynthesis] Image payload",
      )

      const { systemPrompt, userMessage } = buildFinalSynthesisPayload(context)
      const fragmentsCount = context.allFragments.length
      loggerWithChild({ email: context.user.email }).debug(
        {
          chatId: context.chat.externalId,
          finalSynthesisSystemPrompt: systemPrompt,
          finalSynthesisUserMessage: userMessage,
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
        },
      )

      await mutableContext.runtime?.emitReasoning?.(
        ReasoningSteps.synthesisStarted(fragmentsCount),
      )

      const logger = loggerWithChild({ email: context.user.email })
      if (dropped.length > 0) {
        logger.info(
          {
            droppedCount: dropped.length,
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
        max_new_tokens: context.maxOutputTokens ?? 1500,
        imageFileNames: selected,
      }

      const finalUserPrompt = `${userMessage}\n\nSynthesize the final answer using the evidence above.`
      const messages: Message[] = [
        {
          role: ConversationRole.USER,
          content: [{ text: finalUserPrompt }],
        },
      ]
      Logger.debug(
        {
          email: context.user.email,
          chatId: context.chat.externalId,
          fragmentsCount: context.allFragments.length,
          planPresent: !!context.plan,
          clarificationsCount: context.clarifications.length,
          toolOutputsThisTurn: context.currentTurnArtifacts.toolOutputs.length,
          imageNames: selected,
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

  // Include the actual fragment content, not just metadata
  const fragmentsContent =
    context.allFragments.length > 0
      ? answerContextMapFromFragments(
          context.allFragments,
          context.allFragments.length,
        )
      : "No attachment content available."

  return `
# ATTACHMENT-FIRST TURN
${summaryLine}

Attachment handling:
1. Inspect the attachment fragments below.
2. If the attachments fully answer the user's request → respond using citations (see format below).
3. If the attachments are partial or incomplete → create a plan with toDoWrite and run the tools needed to fill the gaps in the same turn.
4. State that information is unavailable only after the attachments and available tools have been used and the answer still cannot be found.

# ATTACHMENT CONTEXT FRAGMENTS
${fragmentsContent}

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

  const instructionLines: string[] = [
    "You are Xyne, an enterprise search assistant with agentic capabilities.",
    "",
    `The current date is: ${dateForAI}`,
    "",
    "<context>",
    `User: ${context.user.email}`,
    `Workspace: ${context.user.workspaceId}`,
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
    "- When research is complete and evidence is locked, CALL `synthesize_final_answer` (no arguments). This tool composes and streams the response.",
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
    const isMstWithAttachments = attachmentMetadata.length > 0

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

        // Track gathered fragments
        const gatheredFragmentsKeys = new Set<string>()

        const initialSyntheticMessages: JAFMessage[] = []

        let initialAttachmentContext: {
          fragments: MinimalAgentFragment[]
          summary: string
        } | null = null

        if (allReferencedFileIds.length > 0) {
          await emitReasoningEvent(
            emitReasoningStep,
            ReasoningSteps.attachmentAnalyzing()
          )
          initialAttachmentContext = await prepareInitialAttachmentContext(
            allReferencedFileIds,
            threadIds,
            userMetadata,
            message,
            email,
            isMstWithAttachments,
          )
          if (initialAttachmentContext) {
            await emitReasoningEvent(
              emitReasoningStep,
              ReasoningSteps.attachmentExtracted(initialAttachmentContext.fragments.length)
            )
          }
        }
        if (imageAttachmentFileIds.length > 0) {
          const imageFragments = imageAttachmentFileIds.map((fileId, index) => {
            const fragmentId = `user_attachment_image:${fileId}:${index}`
            return {
              id: fragmentId,
              content: `User provided image attachment ${index + 1}.`,
              source: {
                docId: fileId,
                title: `Attachment image ${index + 1}`,
                url: "",
                app: Apps.Attachment,
                entity: AttachmentEntity.Image,
              } as Citation,
              confidence: 0.9,
              images: [
                {
                  fileName: `${index}_${fileId}_0`,
                  addedAtTurn: 0,
                  sourceFragmentId: fragmentId,
                  sourceToolName: "user_input",
                  isUserAttachment: true,
                },
              ],
            } as MinimalAgentFragment
          })
          const summary = `User provided ${imageFragments.length} image attachment${imageFragments.length === 1 ? "" : "s"}.`
          if (initialAttachmentContext) {
            initialAttachmentContext.fragments.push(...imageFragments)
            initialAttachmentContext.summary = `${initialAttachmentContext.summary}\n${summary}`
          } else {
            initialAttachmentContext = {
              fragments: imageFragments,
              summary,
            }
          }
        }
        if (initialAttachmentContext) {
          initialAttachmentContext.fragments.forEach((fragment) => {
            const key = getFragmentDedupKey(fragment)
            if (key) gatheredFragmentsKeys.add(key)
          })
          recordFragmentsForContext(
            agentContext,
            initialAttachmentContext.fragments,
            MIN_TURN_NUMBER,
          )
          agentContext.chat.metadata = {
            ...agentContext.chat.metadata,
            initialAttachmentPhase: true,
            initialAttachmentSummary: initialAttachmentContext.summary,
          }
        }

        // Pass memory then attachments as low-privilege synthetic tool results
        const initialToolMsg = buildInitialToolMessage({
          episodicMemoriesText: agentContext.episodicMemoriesText,
          chatMemoryText: agentContext.chatMemoryText,
        })
        if (initialToolMsg) {
          initialSyntheticMessages.push(initialToolMsg)
        }
        if (initialAttachmentContext) {
          initialSyntheticMessages.push(
            buildAttachmentToolMessage(
              initialAttachmentContext.fragments,
              initialAttachmentContext.summary,
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
          reviewFreq: number,
        ): { reviewInput: AutoReviewInput } => {
          const startTurn = Math.max(MIN_TURN_NUMBER, turn - reviewFreq + 1)
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

            // Wiring: batch fragment ranking
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
            ingestFragments: (ctx, fragments, t) => {
              recordFragmentsForContext(ctx, fragments, t)
            },

            // Wiring: cleanup
            flushExpectations: () => {
              pendingExpectations.length = 0
            },
            finalizeTurnImages,
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
              gatheredFragmentsKeys,
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
          throwIfStopRequested(stopController.signal)
          const chunkSize = 200
          for (let i = 0; i < text.length; i += chunkSize) {
            throwIfStopRequested(stopController.signal)
            const chunk = text.slice(i, i + chunkSize)
            answer += chunk
            await stream.writeSSE({
              event: ChatSSEvents.ResponseUpdate,
              data: chunk,
            })

            const fragmentsForCitations = agentContext.allFragments
            for await (const citationEvent of checkAndYieldCitationsForAgent(
              answer,
              yieldedCitations,
              fragmentsForCitations,
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
                const totalCost = agentContext.totalCost
                const totalTokens =
                  agentContext.tokenUsage.input + agentContext.tokenUsage.output
                try {
                  const timeTakenMs = Date.now() - requestStartMs
                  const assistantInsert = {
                    chatId: chatRecord.id,
                    userId: user.id,
                    workspaceExternalId: String(workspace.externalId),
                    chatExternalId: String(chatRecord.externalId),
                    messageRole: MessageRole.Assistant,
                    email: String(user.email),
                    sources: citations,
                    imageCitations,
                    message: processMessage(answer, citationMap),
                    thinking: thinkingLog,
                    modelId: agenticModelId,
                    cost: totalCost.toString(),
                    tokensUsed: totalTokens,
                    timeTakenMs,
                  } as unknown as Omit<InsertMessage, "externalId">
                  const msg = await insertMessage(db, assistantInsert)
                  assistantMessageId = String(msg.externalId)
                  lastPersistedMessageId = msg.id as number
                  lastPersistedMessageExternalId = assistantMessageId
                  await persistTrace(msg.id as number, msg.externalId)
                } catch (error) {
                  loggerWithChild({ email }).error(
                    error,
                    "Failed to persist assistant response (tool_call_end)",
                  )
                }
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

                await stream.writeSSE({
                  event: ChatSSEvents.Error,
                  data: JSON.stringify({ error: err?._tag, message: errMsg }),
                })
                await stream.writeSSE({
                  event: ChatSSEvents.End,
                  data: "",
                })
                await persistTraceForLastMessage()
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

    const gatheredFragmentsKeys = new Set<string>()

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

    const delegatedInitialToolMsg = buildInitialToolMessage({
      episodicMemoriesText: agentContext.episodicMemoriesText,
      chatMemoryText: agentContext.chatMemoryText,
    })
    const initialMessages: JAFMessage[] = [
      {
        role: "user",
        content: message,
      },
      ...(delegatedInitialToolMsg ? [delegatedInitialToolMsg] : []),
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
      reviewFreq: number,
    ): { reviewInput: AutoReviewInput } => {
      const startTurn = Math.max(MIN_TURN_NUMBER, turn - reviewFreq + 1)
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
        ingestFragments: (ctx, fragments, t) => {
          recordFragmentsForContext(ctx, fragments, t)
        },

        flushExpectations: () => {
          pendingExpectations.length = 0
        },
        finalizeTurnImages,
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
          gatheredFragmentsKeys,
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

    if (answerForCitations) {
      const fragmentsForCitations = agentContext.allFragments
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

    return {
      result: finalAnswer,
      contexts: fragmentsToToolContexts(agentContext.allFragments),
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
