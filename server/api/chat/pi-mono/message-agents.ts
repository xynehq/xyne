/**
 * MessageAgents - Pi-Mono Version
 *
 * Full implementation using pi-mono coding-agent runtime.
 * Based on the INTEGRATION_GUIDE.md for proper SDK usage.
 */

import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import type { Message } from "@aws-sdk/client-bedrock-runtime"
import { ConversationRole } from "@aws-sdk/client-bedrock-runtime"
import { isCuid } from "@paralleldrive/cuid2"
import {
  Apps,
  AttachmentEntity,
  SearchModes,
  type VespaSearchResult,
  type VespaSearchResults,
} from "@xyne/vespa-ts/types"

// Xyne imports
import config from "@/config"
import { db } from "@/db/client"
import { getChatMessagesWithAuth, insertMessage } from "@/db/message"
import {
  ChatType,
  type InsertChat,
  type InsertMessage,
  type SelectChat,
  type SelectMessage,
} from "@/db/schema"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem, type UserMetadataType } from "@/types"
import { getErrorMessage } from "@/utils"
import { getDateForAI } from "@/utils/index"
import {
  ChatSSEvents,
  type AttachmentMetadata,
  DEFAULT_TEST_AGENT_ID,
  type ReasoningEventPayload,
} from "@/shared/types"
import { MessageRole } from "@/types"
import {
  getChatExternalIdsByAgentId,
  insertChat,
  updateChatByExternalIdWithAuth,
} from "@/db/chat"
import { getAgentByExternalIdWithPermissionCheck } from "@/db/agent"
import { storeAttachmentMetadata } from "@/db/attachment"
import {
  searchVespaInFiles,
  searchCollectionRAG,
  SearchEmailThreads,
} from "@/search/vespa"
import { getChunkCountPerDoc } from "@/api/chat/chunk-selection"
import { expandSheetIds } from "@/search/utils"
import { parseMessageText } from "@/api/chat/chat"
import {
  extractFileIdsFromMessage,
  processThreadResults,
  collectReferencedFileIdsUntilCompaction,
} from "@/api/chat/utils"
import { getUserPersonalizationByEmail } from "@/db/personalization"
import { answerContextMap } from "@/ai/context"
import type {
  AgentRunContext,
  SubTask,
  ToolExecutionRecord,
  ToolExecutionRecordWithResult,
} from "@/api/chat/agent-schemas"
import {
  ReasoningSteps,
  emitReasoningEvent,
  type ReasoningEmitter,
  type ReasoningEmitter as StructuredReasoningEmitter,
} from "@/api/chat/reasoning-steps"
import { activeStreams } from "@/api/chat/stream"
import type {
  Citation,
  FragmentImageReference,
  MinimalAgentFragment,
} from "@/api/chat/types"
import {
  extractImageFileNames,
  checkAndYieldCitationsForAgent,
  searchToCitation,
  processMessage,
} from "@/api/chat/utils"
import {
  buildFinalSynthesisPayload,
  buildFinalSynthesisRequest,
} from "@/api/chat/message-agents"
import { buildAgentPromptAddendum } from "@/api/chat/agentPromptCreation"
import { getModelValueFromLabel } from "@/ai/modelConfig"
import { Models } from "@/ai/types"
import { parseAttachmentMetadata } from "@/utils/parseAttachment"
import { getPrecomputedDbContextIfNeeded } from "@/lib/databaseContext"
import { userContext } from "@/ai/context"
import {
  createEmptyConnectorState,
  getUserConnectorState,
} from "@/api/chat/resource-access"
import { isMessageWithContext } from "@/api/chat/utils"
import { safeDecodeURIComponent } from "@/api/chat/utils"
import { maybeCompactAndIndex } from "@/services/chatMemoryIndexer"
import { retrieveEpisodicMemories } from "@/services/episodicMemoryRetriever"
import { retrieveRelevantChatHistory } from "@/services/chatMemoryRetriever"
import { insertChatTrace } from "@/db/chatTrace"
import { getTracer } from "@/tracer"
import {
  extractMetadataConstraintsFromUserMessage,
  rankFragmentsByMetadataConstraints,
} from "@/api/chat/message-agents-metadata"
import { generateToolDescriptions } from "@/api/chat/tool-schemas"

import type { AgentSession as PiMonoAgentSession } from "@mariozechner/pi-coding-agent"
// Pi-mono imports
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent"
import { getModel } from "@mariozechner/pi-ai"

// Import the turn-end extension
import piMonoTurnProcessor, {
  setExtensionState,
  clearExtensionState,
} from "./pi-mono-extension"
import { generateRunId } from "@xynehq/jaf"

// Pi-mono tools
import {
  searchGlobalTool,
  searchGmailTool,
  searchDriveFilesTool,
  searchCalendarEventsTool,
  searchGoogleContactsTool,
  getSlackRelatedMessagesTool,
  lsKnowledgeBaseTool,
  searchKnowledgeBaseTool,
  searchChatHistoryTool,
  toDoWriteTool,
  fallBackTool,
  synthesizeFinalAnswerTool,
  listCustomAgentsTool,
  runPublicAgentTool,
} from "./tools"

import {
  setXyneState,
  setRuntime,
  registerSession,
  unregisterSession,
  setSessionRuntime,
  createInitialXyneState,
  type XyneAgentState,
  setPersistFunction,
} from "./adapter"
import {
  extractExpectedResults,
  consumePendingExpectation,
  recordExpectationsForTurn,
  buildTurnReviewInput,
  performAutomaticReview,
  handleReviewOutcome,
} from "./review"
import type { ToolExpectationAssignment } from "./adapter"
import { ToolCooldownManager } from "@/api/chat/tool-cooldown"

// MCP imports
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
import { getConnectorById } from "@/db/connector"
import { getToolsByConnectorId } from "@/db/tool"
import {
  buildMcpCustomTools,
  buildMcpVirtualAgents,
  type MCPVirtualAgentRuntime,
  type MCPToolClient,
  type MCPToolDefinition,
} from "./mcp-tools"
import { buildPiMonoSystemPrompt } from "./prompts/xyne-prompts"
import { createEventRouter, createXyneAgentSession } from "./core"
import { createXyneEventHandlers } from "./xyne-handlers"

const { defaultBestModel, defaultBestModelAgenticMode, JwtPayloadKey } = config

const Logger = getLogger(Subsystem.Chat)
const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

// ============================================================================
// DETAILED LOGGING HELPERS (mirrors JAF's logging approach)
// ============================================================================

/**
 * Build a snapshot of the current context state for logging
 */
function buildContextTraceSnapshot(
  context: XyneAgentState,
): Record<string, unknown> {
  return {
    chatId: context.chat?.externalId,
    turnCount: context.turnCount,
    currentSubTask: context.currentSubTask,
    seenDocumentsCount: context.seenDocuments?.size ?? 0,
    seenDocumentsSample: Array.from(context.seenDocuments || []).slice(0, 10),
    allFragmentsCount: context.allFragments?.length ?? 0,
    allImagesCount: context.allImages?.length ?? 0,
    recentImagesCount: context.recentImages?.length ?? 0,
    currentTurnFragmentCount:
      context.currentTurnArtifacts?.fragments?.length ?? 0,
    currentTurnImageCount: context.currentTurnArtifacts?.images?.length ?? 0,
    currentTurnToolOutputCount:
      context.currentTurnArtifacts?.toolOutputs?.length ?? 0,
    currentTurnExpectationCount:
      context.currentTurnArtifacts?.expectations?.length ?? 0,
    toolCallHistoryCount: context.toolCallHistory?.length ?? 0,
    failedToolsCount: context.failedTools?.size ?? 0,
    availableAgentsCount: context.availableAgents?.length ?? 0,
    usedAgentsCount: context.usedAgents?.length ?? 0,
    ambiguityResolved: context.ambiguityResolved,
    finalSynthesisRequested: context.finalSynthesis?.requested,
    finalSynthesisCompleted: context.finalSynthesis?.completed,
    finalSynthesisAckReceived: context.finalSynthesis?.ackReceived,
  }
}

/**
 * Log context mutations with detailed state information (mirrors JAF's logContextMutation)
 */
function logContextMutation(
  context: XyneAgentState,
  message: string,
  details: Record<string, unknown> = {},
): void {
  loggerWithChild({ email: context.user?.email }).info(
    {
      ...buildContextTraceSnapshot(context),
      ...details,
    },
    message,
  )
}

/**
 * Normalize excluded IDs for logging
 */
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

/**
 * Summarize tool result payload for logging
 */
function summarizeToolResultPayload(result: any): string {
  if (!result) {
    return "No result returned."
  }
  const truncateValue = (value: string, maxLength = 160): string => {
    if (value.length <= maxLength) return value
    return `${value.slice(0, maxLength - 1)}…`
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

// ============================================================================
// TYPES
// ============================================================================

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
  imageCitations: any[]
  citationMap: Record<number, number>
  thinkingLog: string
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Ensure chat exists and persist user message
 */
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

/**
 * Store attachment metadata safely
 */
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

/**
 * Resolve agentic model ID
 */
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

/**
 * Build conversation history for agent run
 */
function buildConversationHistoryForAgentRun(history: SelectMessage[]): {
  messages: Message[]
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
    messages: filtered.map((msg) => ({
      role:
        msg.messageRole === MessageRole.Assistant
          ? ConversationRole.ASSISTANT
          : ConversationRole.USER,
      content: [{ text: toText(msg) }],
    })),
  }
}

/**
 * Normalize user message for history
 */
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

/**
 * Prepare initial attachment context
 */
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
        allowChunkCitations = true
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
          idx < chunksPerDocument.length
            ? chunksPerDocument[idx]
            : maxSummaryChunks,
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
 * Convert Vespa result to attachment fragment
 */
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

/**
 * Persist assistant message to database
 */
async function persistAssistantMessage(
  context: PersistAssistantMessageContext,
  data: PersistAssistantMessageData,
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

  return {
    msg,
    assistantMessageId: String(msg.externalId),
  }
}

// ============================================================================
// SYSTEM PROMPT BUILDER (mirrors JAF structure)
// ============================================================================

// CUSTOM TOOLS FOR PI-MONO
// ============================================================================

/**
 * Build the list of Xyne tools for pi-mono
 * Uses existing tool definitions from ./tools
 */
function buildXyneTools(delegationEnabled = true): unknown[] {
  const baseTools: unknown[] = [
    searchGlobalTool,
    searchGmailTool,
    searchDriveFilesTool,
    searchCalendarEventsTool,
    searchGoogleContactsTool,
    getSlackRelatedMessagesTool,
    lsKnowledgeBaseTool,
    searchKnowledgeBaseTool,
    searchChatHistoryTool,
    toDoWriteTool,
    fallBackTool,
    synthesizeFinalAnswerTool,
  ]

  // Only include delegation tools when delegation is enabled
  if (delegationEnabled) {
    baseTools.push(listCustomAgentsTool, runPublicAgentTool)
  }

  return baseTools
}

// ============================================================================
// MAIN MESSAGE AGENTS FUNCTION (PI-MONO VERSION)
// ============================================================================

/**
 * MessageAgents - Pi-Mono Implementation
 *
 * Full implementation using pi-mono coding-agent runtime.
 */
export async function MessageAgentsPiMono(c: Context): Promise<Response> {
  const tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("MessageAgentsPiMono")

  const { sub: email, workspaceId } = c.get(JwtPayloadKey)

  try {
    loggerWithChild({ email }).info("MessageAgentsPiMono starting")
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

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

    // Parse model configuration
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
          `Parsed model config for MessageAgentsPiMono: model="${parsedModelId}", reasoning=${isReasoningEnabled}, websearch=${enableWebSearch}, deepResearch=${isDeepResearchEnabled}`,
        )
      } catch (error) {
        loggerWithChild({ email }).warn(
          error,
          "Failed to parse selectedModelConfig JSON in MessageAgentsPiMono. Using defaults.",
        )
        parsedModelId = config.defaultBestModel
      }
    } else {
      parsedModelId = config.defaultBestModel
      loggerWithChild({ email }).debug(
        "No model config provided to MessageAgentsPiMono, using default",
      )
    }

    let actualModelId: string = parsedModelId || config.defaultBestModel
    if (parsedModelId) {
      const convertedModelId = getModelValueFromLabel(parsedModelId)
      if (convertedModelId) {
        actualModelId = convertedModelId as string
        loggerWithChild({ email }).debug(
          `Converted model label "${parsedModelId}" to value "${actualModelId}" for MessageAgentsPiMono`,
        )
      } else if (parsedModelId in Models) {
        actualModelId = parsedModelId
        loggerWithChild({ email }).debug(
          `Using model ID "${parsedModelId}" directly for MessageAgentsPiMono`,
        )
      } else {
        loggerWithChild({ email }).error(
          `Invalid model: ${parsedModelId}. Model not found in label mappings or Models enum for MessageAgentsPiMono.`,
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

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
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
    let agentRecord: any | null = null

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
        "Failed to persist user turn for MessageAgentsPiMono",
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
      rootSpan.setAttribute("agentId", resolvedAgentId)
    }

    const hasExplicitAgent = Boolean(resolvedAgentId && agentPromptForLLM)
    const dedicatedAgentSystemPrompt =
      typeof agentRecord?.prompt === "string" &&
      agentRecord.prompt.trim().length > 0
        ? agentRecord.prompt.trim()
        : undefined
    const delegationEnabled = !hasExplicitAgent

    // Return streaming response
    return streamSSE(c, async (stream) => {
      const requestStartMs = Date.now()
      const stopController = new AbortController()
      const streamKey = String(chatRecord.externalId)

      // Step 1: Generate runId at session start
      let currentTurn = { value: 0 }

      // Reference to xyneState for early callbacks (like stop handler)
      let xyneStateRef: XyneAgentState | null = null

      const markStop = () => {
        if (xyneStateRef) {
          ;(xyneStateRef as any).stopRequested = true
        }
        stopController.abort()
      }
      // Listen to the incoming request's signal for client disconnect
      c.req.raw.signal.addEventListener("abort", markStop)
      activeStreams.set(streamKey, { stream, stopController })

      if (!chatId) {
        await stream.writeSSE({
          event: ChatSSEvents.ChatTitleUpdate,
          data: String(chatRecord.title) || "Untitled",
        })
      }

      // --- MCP Connector Loading ---
      const mcpClients: Array<{ close?: () => Promise<void> }> = []
      const finalToolsMap: Record<
        string,
        {
          tools: MCPToolDefinition[]
          client: MCPToolClient
          metadata?: { name?: string; description?: string }
        }
      > = {}

      if (toolsList && toolsList.length > 0) {
        loggerWithChild({ email }).info(
          { connectorCount: toolsList.length },
          "[MCP] Loading MCP connectors",
        )

        for (const item of toolsList) {
          const { connectorId, tools: requestedToolIds } = item
          const parsedConnectorId = Number.parseInt(connectorId, 10)

          if (Number.isNaN(parsedConnectorId)) {
            loggerWithChild({ email }).warn(
              { connectorId },
              "[MCP] Skipping connector with invalid id",
            )
            continue
          }

          try {
            const connector = await getConnectorById(
              db,
              parsedConnectorId,
              user.id,
            )
            const connectorNumericId = Number(connector.id)

            const client = new Client({
              name: `connector-${connectorId}`,
              version:
                (connector.config as { version?: string })?.version ?? "1.0",
            })

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
              if (loadedMode === "streamable-http") {
                const transportOptions: StreamableHTTPClientTransportOptions = {
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
                  new SSEClientTransport(new URL(loadedUrl), transportOptions),
                )
              }
            } else if (loadedConfig.command) {
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

            mcpClients.push(client)

            // Get tools for this connector
            const dbTools = await getToolsByConnectorId(
              db,
              workspace.id,
              connectorNumericId,
            )

            const filteredTools = dbTools.filter((tool) => {
              const toolExternalId =
                typeof tool.externalId === "string"
                  ? tool.externalId
                  : undefined
              return (
                !!toolExternalId && requestedToolIds.includes(toolExternalId)
              )
            })

            const formattedTools: MCPToolDefinition[] = filteredTools
              .map((tool) => ({
                toolName:
                  typeof tool.toolName === "string" ? tool.toolName : "",
                toolSchema:
                  typeof tool.toolSchema === "string"
                    ? tool.toolSchema
                    : undefined,
                description:
                  typeof tool.description === "string"
                    ? tool.description
                    : undefined,
              }))
              .filter((t) => t.toolName)

            if (formattedTools.length === 0) {
              continue
            }

            const wrappedClient: MCPToolClient = {
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

            finalToolsMap[connectorId] = {
              tools: formattedTools,
              client: wrappedClient,
              metadata: {
                name:
                  typeof connector.name === "string"
                    ? connector.name
                    : `Connector ${connectorId}`,
                description:
                  typeof (connector as any).description === "string"
                    ? (connector as any).description
                    : undefined,
              },
            }

            loggerWithChild({ email }).info(
              {
                connectorId,
                toolCount: formattedTools.length,
              },
              "[MCP] Connector loaded successfully",
            )
          } catch (error) {
            loggerWithChild({ email }).error(
              error,
              `[MCP] Failed to load connector ${connectorId}`,
            )
          }
        }
      }

      // Apply tool budget - decide which connectors become direct tools vs virtual agents
      const MAX_TOOLS_BUDGET = 30
      const connectorToolEntries = Object.entries(finalToolsMap).map(
        ([connectorId, entry]) => ({
          connectorId,
          toolCount: entry.tools.length,
        }),
      )

      let totalToolBudget =
        12 + // Base Xyne tools count
        connectorToolEntries.reduce((sum, entry) => sum + entry.toolCount, 0)

      const agentConnectorIds = new Set<string>()
      if (totalToolBudget > MAX_TOOLS_BUDGET) {
        // Sort by tool count descending, move largest to virtual agents
        const sortedConnectors = [...connectorToolEntries].sort(
          (a, b) => b.toolCount - a.toolCount,
        )
        for (const entry of sortedConnectors) {
          agentConnectorIds.add(entry.connectorId)
          totalToolBudget -= entry.toolCount
          if (totalToolBudget <= MAX_TOOLS_BUDGET) break
        }
      }

      const directMcpToolsMap: Record<string, any> = {}
      const mcpAgentCandidates: MCPVirtualAgentRuntime[] = []

      for (const [connectorId, entry] of Object.entries(finalToolsMap)) {
        if (agentConnectorIds.has(connectorId)) {
          mcpAgentCandidates.push({
            agentId: `mcp:${connectorId}`,
            connectorId,
            connectorName: entry.metadata?.name,
            description: entry.metadata?.description,
            tools: entry.tools,
            client: entry.client,
          })
        } else {
          directMcpToolsMap[connectorId] = entry
        }
      }

      // Build MCP tools for pi-mono
      const mcpTools = buildMcpCustomTools(directMcpToolsMap)

      loggerWithChild({ email }).info(
        {
          directMcpTools: mcpTools.length,
          mcpVirtualAgents: mcpAgentCandidates.length,
        },
        "[MCP] Tool budget applied",
      )

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
        // Step 2: Create enriched emitReasoningStep wrapper
        const emitReasoningStep: ReasoningEmitter = async (
          payload: ReasoningEventPayload,
        ) => {
          if (stream.closed) return
          // Attach orchestration metadata
          const withMeta: ReasoningEventPayload = {
            ...payload,
            runId: mainRunIdRef != null ? String(mainRunIdRef) : undefined,
            turnNumber: payload.turnNumber ?? currentTurn.value,
            parentAgent: payload.parentAgent ?? undefined,
          }
          thinkingLog += `${JSON.stringify(withMeta)}\n`
          await stream.writeSSE({
            event: ChatSSEvents.Reasoning,
            data: JSON.stringify(withMeta),
          })
        }
        mainRunIdRef = generateRunId()
        const xyneState = createInitialXyneState(
          email,
          String(workspace.externalId), // workspaceId must be externalId for DB queries
          String(user.id),
          user.id, // numericId
          String(chatRecord.externalId),
          message,
          new Date().toISOString(),
        )

        // Assign to ref so stop handler can access it
        xyneStateRef = xyneState

        // Add additional context to state
        xyneState.userContext = userCtxString
        xyneState.agentPrompt = agentPromptForLLM
        xyneState.dedicatedAgentSystemPrompt = dedicatedAgentSystemPrompt
        xyneState.user.workspaceNumericId = workspace.id
        xyneState.chat.id = chatRecord.id
        xyneState.modelId = agenticModelId
        xyneState.mcpAgents = mcpAgentCandidates

        // --- Fix 5: Retrieve episodic + chat memory (mirrors JAF L4708-4747) ---

        const episodicChatIds: string[] | undefined = delegationEnabled
          ? undefined
          : resolvedAgentId
            ? await getChatExternalIdsByAgentId(db, resolvedAgentId, email)
            : undefined

        try {
          const [episodicResults, chatMemoryResults] = await Promise.all([
            retrieveEpisodicMemories({
              query: message,
              email,
              workspaceId: String(workspaceId),
              chatIds: episodicChatIds,
            }).catch((err) => {
              loggerWithChild({ email }).warn(
                err,
                "Episodic memory retrieval failed",
              )
              return []
            }),
            retrieveRelevantChatHistory({
              query: message,
              chatId: String(chatRecord.externalId),
              email,
              workspaceId: String(workspaceId),
              limit: 5,
            }).catch((err) => {
              loggerWithChild({ email }).warn(
                err,
                "Chat memory retrieval failed",
              )
              return []
            }),
          ])

          if (episodicResults.length > 0) {
            xyneState.episodicMemoriesText = episodicResults
              .map(
                (m) =>
                  `- [${m.memoryType}] ${m.memoryText} (chatId: ${m.sourceChatId})`,
              )
              .join("\n")
          }
          if (chatMemoryResults.length > 0) {
            xyneState.chatMemoryText = chatMemoryResults
              .map(
                (c) =>
                  `User: ${c.userMessage}\nAssistant thinking: ${c.assistantThinking}\nAssistant: ${c.assistantMessage}`,
              )
              .join("\n\n")
          }

          loggerWithChild({ email }).info(
            {
              episodicCount: episodicResults.length,
              chatMemoryCount: chatMemoryResults.length,
            },
            "[Pi-Mono] Memory retrieval complete",
          )
        } catch (memErr) {
          loggerWithChild({ email }).warn(memErr, "Memory retrieval failed")
        }

        // Prepare initial attachment context
        let initialAttachmentContext: {
          fragments: MinimalAgentFragment[]
          summary: string
        } | null = null

        // Step 3: Replace inline emitters with enriched wrapper
        if (allReferencedFileIds.length > 0) {
          await emitReasoningEvent(
            emitReasoningStep,
            ReasoningSteps.attachmentAnalyzing(),
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
              ReasoningSteps.attachmentExtracted(
                initialAttachmentContext.fragments.length,
              ),
            )
          }
        }

        // Handle image attachments
        const allFragments: MinimalAgentFragment[] =
          initialAttachmentContext?.fragments || []
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
          allFragments.push(...imageFragments)
        }

        // Store attachment fragments in xyneState BEFORE building system prompt
        // This ensures they're available for citation extraction
        xyneState.allFragments = allFragments
        xyneState.currentTurnArtifacts.fragments = [...allFragments]

        // Build combined summary like JAF does (file attachments + image attachments)
        let attachmentSummary = ""
        if (
          initialAttachmentContext?.summary &&
          imageAttachmentFileIds.length > 0
        ) {
          // Both file and image attachments - concatenate summaries
          const imageSummary = `User provided ${imageAttachmentFileIds.length} image attachment${imageAttachmentFileIds.length === 1 ? "" : "s"}.`
          attachmentSummary = `${initialAttachmentContext.summary}\n${imageSummary}`
        } else if (initialAttachmentContext?.summary) {
          // Only file attachments
          attachmentSummary = initialAttachmentContext.summary
        } else if (imageAttachmentFileIds.length > 0) {
          // Only image attachments
          attachmentSummary = `User provided ${imageAttachmentFileIds.length} image attachment${imageAttachmentFileIds.length === 1 ? "" : "s"}.`
        }

        // Store attachment metadata for buildAttachmentDirective
        if (allFragments.length > 0) {
          xyneState.chat.metadata = {
            ...xyneState.chat.metadata,
            initialAttachmentPhase: true,
            initialAttachmentSummary: attachmentSummary,
          }
        }

        loggerWithChild({ email }).info(
          {
            fragmentCount: allFragments.length,
            imageCount: imageAttachmentFileIds.length,
            hasAttachmentPhase: allFragments.length > 0,
          },
          "[Pi-Mono] Attachment fragments stored in state",
        )

        // Send start event
        await stream.writeSSE({
          event: ChatSSEvents.Start,
          data: "",
        })

        // Send initial metadata
        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({
            chatId: chatRecord.externalId,
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

        // 1. Format Base URL (ensure /v1 suffix)
        const baseUrl = config.LiteLLMBaseUrl?.endsWith("/v1")
          ? config.LiteLLMBaseUrl
          : `${config.LiteLLMBaseUrl}/v1`

        // 2. Initialize AuthStorage and set LiteLLM credentials
        const authStorage = AuthStorage.create()
        if (config.LiteLLMApiKey) {
          authStorage.set("litellm", {
            type: "api_key",
            key: config.LiteLLMApiKey,
          })
        }

        const modelRegistry = new ModelRegistry(authStorage)

        // 3. Define LiteLLM model directly (official pattern from docs)
        loggerWithChild({ email }).info(
          `Creating LiteLLM model profile for ${agenticModelId}`,
        )
        const piModel = {
          id: agenticModelId, // model ID as configured in LiteLLM (e.g., "kimi-latest")
          name: agenticModelId,
          api: "openai-completions", // LiteLLM uses OpenAI-compatible API
          provider: "litellm",
          baseUrl: baseUrl,
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
          compat: {
            supportsStore: false, // LiteLLM doesn't support 'store' field
            supportsStreaming: true,
            supportsToolStreaming: true,
          },
        } as any

        loggerWithChild({ email }).info(
          {
            modelId: piModel.id,
            modelProvider: piModel.provider,
            baseUrl: piModel.baseUrl,
          },
          "Using pi-mono model with LiteLLM",
        )

        // Create Xyne state first (needed by tools)

        // Register session for concurrent-safe state access by tools
        const sessionId = chatRecord.externalId
        const persistFn = async (state: XyneAgentState) => {
          loggerWithChild({ email }).debug("Persisting Xyne state")
        }
        registerSession(sessionId, xyneState, persistFn)

        // Set up persist function (legacy compat)
        setPersistFunction(persistFn)

        // --- Fix 3: Store conversation history for synthesis ---
        xyneState.conversationHistoryMessages = previousConversationHistory
          .filter(
            (m: any) =>
              m.messageRole === "user" || m.messageRole === "assistant",
          )
          .slice(-20) // Keep last 20 messages for context
          .map((m: any) => ({
            role: m.messageRole === "user" ? "user" : "assistant",
            content: [{ text: m.message || "" }],
          }))

        // Build custom tools (they use Xyne state via adapter)
        // Merge Xyne tools with MCP tools
        const customTools: any[] = [
          ...buildXyneTools(delegationEnabled),
          ...mcpTools,
        ]
        xyneState.enabledTools = new Set(
          customTools.map((tool: any) => tool.name),
        )
        // Build robust system prompt using JAF logic
        let systemPrompt = buildPiMonoSystemPrompt(
          xyneState,
          customTools.map((tool: any) => tool.name),
          dateForAI,
          agentPromptForLLM,
          delegationEnabled,
        )

        const session = await createXyneAgentSession({
          model: agenticModelId,
          systemPrompt,
          tools: customTools,
          state: xyneState,
          baseUrl,
          apiKey: config.LiteLLMApiKey,
        })
        const piSession = session.getUnderlyingSession() as PiMonoAgentSession
        // Store Xyne state in adapter for tools to access
        // Use the session's internal context as the key
        setXyneState(piSession as any, xyneState)

        // Set extension state for turn-end processing
        setExtensionState({
          xyneState,
          currentTurn,
          agenticModelId,
          message,
          email,
          emitReasoningStep,
        })

        // Log the full system prompt for debugging
        loggerWithChild({ email }).info(
          { systemPrompt },
          "📝 PI-MONO SYSTEM PROMPT",
        )

        loggerWithChild({ email }).info(
          {
            systemPromptLength: systemPrompt.length,
            toolCount: customTools.length,
            toolNames: customTools.map((t: any) => t.name),
          },
          "Created pi-mono session with Xyne state",
        )

        // Subscribe to events
        let answer = ""
        const citations: Citation[] = []
        const citationsByDocId: Map<string, number> = new Map() // docId -> index in citations array
        const imageCitations: any[] = []
        const citationMap: Record<number, number> = {}
        const yieldedCitations = new Set<number>()
        const yieldedImageCitations = new Map<number, Set<number>>()
        let assistantMessageId: string | null = null

        // Expectation tracking (ported from JAF)
        const expectationBuffer: ToolExpectationAssignment[] = []
        let syntheticToolCallSeq = { value: 0 }

        // Use the enriched emitReasoningStep created in Step 2

        // Set up runtime callbacks BEFORE tools run
        // This gives synthesizeFinalAnswer direct access to the SSE stream
        setRuntime({
          streamAnswerText: async (text: string) => {
            if (!text || stream.closed) return
            const chunkSize = 200
            for (let i = 0; i < text.length; i += chunkSize) {
              if (stream.closed) return
              // Check stop signal between chunks
              if (stopController.signal.aborted) return
              const chunk = text.slice(i, i + chunkSize)
              answer += chunk
              await stream.writeSSE({
                event: ChatSSEvents.ResponseUpdate,
                data: chunk,
              })

              // Extract citations inline as text streams (mirrors JAF's streamAnswerText)
              const fragmentsForCitations = xyneState.allFragments
              for await (const citationEvent of checkAndYieldCitationsForAgent(
                answer,
                yieldedCitations,
                fragmentsForCitations,
                yieldedImageCitations,
                email,
                xyneState.citationDocIdMapping,
              )) {
                if (stream.closed) break
                if (citationEvent.citation) {
                  const { index, item } = citationEvent.citation
                  const docId = item.docId || item.url || String(index)

                  // Check if we've already seen this document
                  if (citationsByDocId.has(docId)) {
                    // Reuse existing citation index
                    citationMap[index] = citationsByDocId.get(docId)!
                  } else {
                    // Add new citation
                    citations.push(item)
                    const citationIndex = citations.length - 1
                    citationsByDocId.set(docId, citationIndex)
                    citationMap[index] = citationIndex
                  }

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
          },
          emitReasoning: async (payload: any) => {
            // Step 7: Use enriched emitter
            await emitReasoningEvent(emitReasoningStep, payload)
          },
        })

        // Track completion
        let agentCompleted = false
        let agentCompletionResolve: (() => void) | null = null
        let agentCompletionReject: ((err: Error) => void) | null = null
        const agentCompletionPromise = new Promise<void>((resolve, reject) => {
          agentCompletionResolve = resolve
          agentCompletionReject = reject
        })

        const eventHandlers = createXyneEventHandlers({
          message,
          customTools,
          dateForAI,
          email,
          agentCompletionResolve,
          agentCompletionReject,
          state: xyneState,
          stream: {
            closed: false,
            writeSSE: async (data: { event: string; data: string }) => {
              if (!stream.closed) {
                await stream.writeSSE(data)
              }
            },
          },
          session: piSession,
          stateManager: {
            persist: async () => {
              Logger.debug("Persisting Xyne state")
            },
          },
          reasoningEmitter: emitReasoningStep,
          setAgentCompleted: (completed: boolean) => {
            agentCompleted = completed
          },
          buildSystemPrompt: (s, toolNames, date, delegation) =>
            buildPiMonoSystemPrompt(
              s,
              toolNames,
              date,
              agentPromptForLLM,
              delegation,
            ),
          currentTurn,
          syntheticToolCallSeq,
          expectationBuffer,
          mainRunId: mainRunIdRef,
          delegationEnabled,
        })
        // Create and start the event router
        const router = createEventRouter({
          state: xyneState,
          session: piSession,
          handlers: eventHandlers,
          onError: (error) => {
            Logger.error(error, "Event router error")
          },
        })
        router.start()

        // Start the conversation
        loggerWithChild({ email }).info("Starting pi-mono prompt...")

        // Catch synchronous errors from prompt()
        let promptError: Error | null = null
        piSession.prompt(message).catch((err: any) => {
          promptError = err instanceof Error ? err : new Error(String(err))
          loggerWithChild({ email }).error({ err }, "PI-MONO PROMPT CRASHED")
          // Force agent completion to unblock the promise
          if (!agentCompleted && agentCompletionResolve) {
            agentCompletionResolve()
          }
        })

        // Small delay to see if prompt() fails synchronously
        await new Promise((resolve) => setTimeout(resolve, 100))

        if (promptError) {
          throw new Error(`Prompt failed: ${(promptError as Error).message}`)
        }

        loggerWithChild({ email }).info(
          "Pi-mono prompt returned, waiting for completion...",
        )

        // Wait for completion
        const completionTimeoutMs = 10 * 60 * 1000 // 10 minutes
        try {
          await Promise.race([
            agentCompletionPromise,
            new Promise<void>((_, reject) =>
              setTimeout(
                () => reject(new Error("Agent completion timeout")),
                completionTimeoutMs,
              ),
            ),
          ])
          loggerWithChild({ email }).info("Agent completed successfully")
        } catch (timeoutErr) {
          loggerWithChild({ email }).error(
            timeoutErr,
            "Agent completion timeout",
          )
          if (!agentCompleted) {
            throw timeoutErr
          }
        }

        // Fallback if the agent disobeyed the prompt and answered natively without using synthesizeFinalAnswer
        // Fallback if the agent disobeyed the prompt and answered natively without using synthesizeFinalAnswer
        if (!xyneState.finalSynthesis.requested && thinkingLog.trim() !== "") {
          loggerWithChild({ email }).warn(
            "Agent bypassed synthesizeFinalAnswer tool, forcefully intercepting to ensure grounding...",
          )

          try {
            // Forcefully execute the synthesis tool to guarantee a grounded, cited answer
            await synthesizeFinalAnswerTool.execute(
              "forced_fallback_call",
              { insightsUsefulForAnswering: thinkingLog.trim() },
              undefined,
              () => {},
              piSession as any,
            )
          } catch (forcedSynthesisErr) {
            loggerWithChild({ email }).error(
              forcedSynthesisErr,
              "Forced synthesis failed, falling back to raw text dump",
            )

            // Absolute worst-case fallback: stream the raw text
            const fallbackText = thinkingLog.trim()
            answer = fallbackText

            await stream.writeSSE({
              event: ChatSSEvents.ResponseUpdate,
              data: fallbackText,
            })

            // Extract citations from the fallback text too
            const fragmentsForCitations = xyneState.allFragments
            for await (const citationEvent of checkAndYieldCitationsForAgent(
              answer,
              yieldedCitations,
              fragmentsForCitations,
              yieldedImageCitations,
              email,
            )) {
              if (stream.closed) break
              if (citationEvent.citation) {
                const { index, item } = citationEvent.citation
                const docId = item.docId || item.url || String(index)

                // Check if we've already seen this document
                if (citationsByDocId.has(docId)) {
                  // Reuse existing citation index
                  citationMap[index] = citationsByDocId.get(docId)!
                } else {
                  // Add new citation
                  citations.push(item)
                  const citationIndex = citations.length - 1
                  citationsByDocId.set(docId, citationIndex)
                  citationMap[index] = citationIndex
                }

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
            await emitReasoningEvent(
              emitReasoningStep,
              ReasoningSteps.synthesisCompleted(),
            )
          }
        }

        // Persist final message
        try {
          const persisted = await persistAssistantMessage(
            {
              chatRecord,
              user,
              workspace: { externalId: workspace.externalId },
              agenticModelId,
              totalCost: 0,
              tokenUsage: { input: 0, output: 0 },
              requestStartMs,
            },
            {
              answer,
              citations,
              imageCitations,
              citationMap,
              thinkingLog,
            },
          )
          assistantMessageId = persisted.assistantMessageId
          await persistTrace(persisted.msg.id as number, assistantMessageId)
        } catch (persistErr) {
          loggerWithChild({ email }).error(
            persistErr,
            "Failed to persist message",
          )
        }

        // Send final metadata
        if (!stream.closed) {
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chatRecord.externalId,
              messageId: assistantMessageId || "temp-message-id",
              timeTakenMs: Date.now() - requestStartMs,
            }),
          })
          await stream.writeSSE({
            event: ChatSSEvents.End,
            data: "",
          })
        }

        rootSpan.end()
      } catch (error) {
        loggerWithChild({ email }).error(
          error,
          "MessageAgentsPiMono stream error",
        )
        const streamErrMsg = getErrorMessage(error)

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
              "Failed to send error to client",
            )
          }
        }
        rootSpan.end()
      } finally {
        stopController.signal.removeEventListener("abort", markStop)
        const activeEntry = activeStreams.get(streamKey)
        if (activeEntry?.stream === stream) {
          activeStreams.delete(streamKey)
        }
        // Clean up session-scoped state
        unregisterSession(chatRecord?.externalId ?? "")
        clearExtensionState() // Clear extension state
      }
    })
  } catch (error) {
    loggerWithChild({ email }).error(error, "MessageAgentsPiMono failed")
    rootSpan.end()
    throw error
  }
}

// ============================================================================
// EXPORT INTERNALS FOR TESTING
// ============================================================================

export const __messageAgentsPiMonoInternals = {
  ensureChatAndPersistUserMessage,
  resolveAgenticModelId,
  buildConversationHistoryForAgentRun,
  prepareInitialAttachmentContext,
  buildXyneTools,
  persistAssistantMessage,
}
