/**
 * MessageAgents - Pi-Mono Version
 *
 * Full implementation using pi-mono coding-agent runtime.
 * Maintains compatibility with existing XyneAgentState.
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
import {
  getChatMessagesWithAuth,
  insertMessage,
  updateMessage,
} from "@/db/message"
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
import { ChatSSEvents, XyneTools, type AttachmentMetadata, DEFAULT_TEST_AGENT_ID } from "@/shared/types"
import { MessageRole } from "@/types"
import { insertChat, updateChatByExternalIdWithAuth } from "@/db/chat"
import { getAgentByExternalIdWithPermissionCheck } from "@/db/agent"
import { storeAttachmentMetadata } from "@/db/attachment"
import { searchVespaInFiles, searchCollectionRAG, SearchEmailThreads } from "@/search/vespa"
import { getChunkCountPerDoc } from "@/api/chat/chunk-selection"
import { expandSheetIds } from "@/search/utils"
import { parseMessageText } from "@/api/chat/chat"
import { extractFileIdsFromMessage, processThreadResults, collectReferencedFileIdsUntilCompaction } from "@/api/chat/utils"
import { getUserPersonalizationByEmail } from "@/db/personalization"
import { answerContextMap } from "@/ai/context"
import type { AgentRunContext, SubTask, ToolExecutionRecord, ToolExecutionRecordWithResult } from "@/api/chat/agent-schemas"
import { ReasoningSteps, emitReasoningEvent, type ReasoningEmitter as StructuredReasoningEmitter } from "@/api/chat/reasoning-steps"
import { ToolCooldownManager } from "@/api/chat/tool-cooldown"
import { activeStreams } from "@/api/chat/stream"
import type { Citation, FragmentImageReference, MinimalAgentFragment } from "@/api/chat/types"
import { extractImageFileNames, checkAndYieldCitationsForAgent, searchToCitation } from "@/api/chat/utils"
import { buildFinalSynthesisPayload, buildFinalSynthesisRequest } from "@/api/chat/message-agents"
import { getModelValueFromLabel } from "@/ai/modelConfig"
import { Models } from "@/ai/types"
import { parseAttachmentMetadata } from "@/utils/parseAttachment"
import { getPrecomputedDbContextIfNeeded } from "@/lib/databaseContext"
import { userContext } from "@/ai/context"
import { createEmptyConnectorState, getUserConnectorState } from "@/api/chat/resource-access"
import { isMessageWithContext } from "@/api/chat/utils"
import { safeDecodeURIComponent } from "@/api/chat/utils"
import { retrieveEpisodicMemories } from "@/services/episodicMemoryRetriever"
import { retrieveRelevantChatHistory } from "@/services/chatMemoryRetriever"
import { maybeCompactAndIndex } from "@/services/chatMemoryIndexer"
import { getChatExternalIdsByAgentId } from "@/db/chat"
import { insertChatTrace } from "@/db/chatTrace"
import { getTracer } from "@/tracer"

// Pi-mono imports
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent"
import { getModel } from "@mariozechner/pi-ai"

import { setXyneState, createInitialXyneState, type XyneAgentState } from "./adapter"
import { searchGlobalTool } from "./tools/search-global"
import { searchGmailTool } from "./tools/search-gmail"
import { searchDriveFilesTool } from "./tools/search-drive-files"
import { searchCalendarEventsTool } from "./tools/search-calendar-events"
import { searchGoogleContactsTool } from "./tools/search-google-contacts"
import { getSlackRelatedMessagesTool } from "./tools/get-slack-related-messages"
import { lsKnowledgeBaseTool } from "./tools/ls-knowledge-base"
import { searchKnowledgeBaseTool } from "./tools/search-knowledge-base"
import { fallBackTool } from "./tools/fall-back"
import { toDoWriteTool } from "./tools/to-do-write"
import { synthesizeFinalAnswerTool } from "./tools/synthesize-final-answer"
import { searchChatHistoryTool } from "./tools/search-chat-history"
import { listCustomAgentsTool } from "./tools/list-custom-agents"
import { runPublicAgentTool } from "./tools/run-public-agent"

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
const DEFAULT_REVIEW_FREQUENCY = 5

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
 * Initialize fresh Xyne state for pi-mono
 */
function initializePiMonoAgentContext(
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
): XyneAgentState {
  // Create base state
  const state = createInitialXyneState(
    userEmail,
    workspaceId,
    userId,
    chatExternalId,
    messageText,
    attachments
  )
  
  // Apply optional overrides
  if (options?.userContext) state.userContext = options.userContext
  if (options?.agentPrompt) state.agentPrompt = options.agentPrompt
  if (options?.dedicatedAgentSystemPrompt) {
    state.dedicatedAgentSystemPrompt = options.dedicatedAgentSystemPrompt
  }
  if (options?.workspaceNumericId) {
    state.user.workspaceNumericId = options.workspaceNumericId
  }
  if (options?.chatId) state.chat.id = options.chatId
  if (options?.stopController) {
    state.stopController = options.stopController
    state.stopSignal = options.stopController.signal
  }
  if (options?.stopSignal) state.stopSignal = options.stopSignal
  if (options?.modelId) state.modelId = options.modelId
  
  return state
}

/**
 * Build tool list for pi-mono
 */
function buildPiMonoTools(): any[] {
  return [
    // Search tools
    searchGlobalTool,
    searchGmailTool,
    searchDriveFilesTool,
    searchCalendarEventsTool,
    searchGoogleContactsTool,
    getSlackRelatedMessagesTool,
    lsKnowledgeBaseTool,
    searchKnowledgeBaseTool,
    searchChatHistoryTool,
    // Control flow tools
    toDoWriteTool,
    fallBackTool,
    synthesizeFinalAnswerTool,
    // Agent delegation
    listCustomAgentsTool,
    runPublicAgentTool,
  ]
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
    message: data.answer,
    thinking: data.thinkingLog,
    modelId: context.agenticModelId,
    cost: context.totalCost.toString(),
    tokensUsed: context.tokenUsage.input + context.tokenUsage.output,
    timeTakenMs,
  } as unknown as Omit<InsertMessage, "externalId">
  
  // Note: This is a simplified version - full implementation would use actual DB insert
  const msg = await insertMessage(db, assistantInsert)
  
  return { 
    msg, 
    assistantMessageId: String(msg.externalId) 
  }
}

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

// ============================================================================
// MAIN MESSAGE AGENTS FUNCTION (PI-MONO VERSION)
// ============================================================================

/**
 * MessageAgents - Pi-Mono Implementation
 * 
 * Full implementation using pi-mono coding-agent runtime.
 * Maintains compatibility with existing XyneAgentState and streaming.
 */
export async function MessageAgentsPiMono(c: Context): Promise<Response> {
  const tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("MessageAgentsPiMono")

  const { sub: email, workspaceId } = c.get(JwtPayloadKey)
  
  try {
    loggerWithChild({ email }).info("MessageAgentsPiMono starting")
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)
    
    // Parse request body
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

    const userAndWorkspace = await getUserAndWorkspaceByEmail(db, workspaceId, email)
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

        // Build tools - cast to any to bypass type checking since our tool definitions
        // have more specific types than the base ToolDefinition
        const tools = buildPiMonoTools() as any[]

    // Return streaming response
    return streamSSE(c, async (stream) => {
      const requestStartMs = Date.now()
      const stopController = new AbortController()
      const streamKey = String(chatRecord.externalId)
      let agentContextRef: XyneAgentState | null = null
      
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

      try {
        let thinkingLog = ""
        
        // Initialize context with actual data
        const agentContext = initializePiMonoAgentContext(
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
        
        // Build conversation history
        const { messages: llmHistory } = buildConversationHistoryForAgentRun(
          previousConversationHistory,
        )
        
        // Prepare initial attachment context
        let initialAttachmentContext: {
          fragments: MinimalAgentFragment[]
          summary: string
        } | null = null

        if (allReferencedFileIds.length > 0) {
          await emitReasoningEvent(
            async (payload) => {
              thinkingLog += `${JSON.stringify(payload)}\n`
              await stream.writeSSE({
                event: ChatSSEvents.Reasoning,
                data: JSON.stringify(payload),
              })
            },
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
              async (payload) => {
                thinkingLog += `${JSON.stringify(payload)}\n`
                await stream.writeSSE({
                  event: ChatSSEvents.Reasoning,
                  data: JSON.stringify(payload),
                })
              },
              ReasoningSteps.attachmentExtracted(initialAttachmentContext.fragments.length)
            )
            agentContext.allFragments.push(...initialAttachmentContext.fragments)
          }
        }

        // Handle image attachments
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
          agentContext.allFragments.push(...imageFragments)
        }

        // Send initial metadata
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

        // Set up pi-mono auth and model with LiteLLM
        const authStorage = AuthStorage.create()
        const modelRegistry = new ModelRegistry(authStorage)
        
        // Register LiteLLM as a custom provider
        if (config.LiteLLMBaseUrl && config.LiteLLMApiKey) {
          modelRegistry.registerProvider("litellm", {
            baseUrl: config.LiteLLMBaseUrl,
            apiKey: config.LiteLLMApiKey,
            api: "openai-chat",
            headers: {
              "Authorization": `Bearer ${config.LiteLLMApiKey}`,
              "Content-Type": "application/json",
            },
            authHeader: true,
          })
        }
        
        // Map Xyne model to pi-mono model
        // Try to get model from LiteLLM first
        let piModel = modelRegistry.find("litellm", agenticModelId as any)
        
        // If not found in LiteLLM, try other providers
        if (!piModel) {
          piModel = modelRegistry.find("anthropic", agenticModelId as any) || 
                    modelRegistry.find("openai", agenticModelId as any)
        }
        
        // If not found in registry, try to get from built-in models
        if (!piModel) {
          // Try common model IDs
          piModel = getModel("anthropic", agenticModelId as any) || 
                    getModel("openai", agenticModelId as any)
        }
        
        // If still not found, create a custom model for LiteLLM
        if (!piModel && config.LiteLLMBaseUrl) {
          piModel = {
            provider: "litellm",
            id: agenticModelId,
            name: agenticModelId,
            api: "openai-chat",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
            compat: { supportsStreaming: true },
          } as any
        }
        
        // If still not found, use a default
        if (!piModel) {
          loggerWithChild({ email }).warn(
            `Model ${agenticModelId} not found in pi-mono registry, trying to use default`
          )
          // Try to get any available model
          const availableModels = await modelRegistry.getAvailable()
          if (availableModels.length > 0) {
            piModel = availableModels[0]
          } else {
            throw new Error(`No model available for ${agenticModelId}. Please configure API keys.`)
          }
        }

        // Create pi-mono agent session with Xyne tools
        const { session: piSession } = await createAgentSession({
          model: piModel,
          tools: tools as any[],
          // Use in-memory session manager to avoid file-based session storage
          sessionManager: SessionManager.inMemory(),
          // Use in-memory settings
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: true },
            retry: { enabled: false, maxRetries: 3, baseDelayMs: 1000 },
          }),
          authStorage,
          modelRegistry,
        })

        // Store Xyne state in the adapter for tools to access
        setXyneState(piSession as any, agentContext)

        // Subscribe to pi-mono events and forward to SSE stream
        let answer = ""
        const citations: Citation[] = []
        const imageCitations: any[] = []
        const citationMap: Record<number, number> = {}
        const yieldedCitations = new Set<number>()
        const yieldedImageCitations = new Map<number, Set<number>>()
        let assistantMessageId: string | null = null
        let turnCount = 0

        const reasoningEmitter: StructuredReasoningEmitter = async (payload) => {
          thinkingLog += `${JSON.stringify(payload)}\n`
          if (stream.closed) return
          await stream.writeSSE({
            event: ChatSSEvents.Reasoning,
            data: JSON.stringify(payload),
          })
        }

        // Subscribe to session events
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        piSession.subscribe(async (event: any) => {
          if (stream.closed) return

          switch (event.type) {
            case "turn_start": {
              turnCount++
              await emitReasoningEvent(
                reasoningEmitter,
                ReasoningSteps.turnStarted(turnCount)
              )
              break
            }

            case "tool_execution_start": {
              // Tool execution starting - emit tool selection
              const toolCall = event.toolCall
              if (!toolCall) break
              
              const toolQuery = typeof toolCall.args?.query === "string" 
                ? toolCall.args.query 
                : undefined
              
              if (toolCall.name === XyneTools.toDoWrite) {
                await emitReasoningEvent(
                  reasoningEmitter,
                  ReasoningSteps.toolSelected(toolCall.name)
                )
              } else if (toolCall.name === XyneTools.listCustomAgents) {
                await emitReasoningEvent(
                  reasoningEmitter,
                  ReasoningSteps.agentSearching()
                )
              } else if (toolCall.name === XyneTools.runPublicAgent) {
                // Handled in tool completion
              } else if (toolCall.name === XyneTools.fallBack) {
                await emitReasoningEvent(
                  reasoningEmitter,
                  ReasoningSteps.fallbackActivated()
                )
              } else {
                await emitReasoningEvent(
                  reasoningEmitter,
                  ReasoningSteps.toolSelected(toolCall.name, toolQuery)
                )
              }
              break
            }

            case "tool_execution_end": {
              // Tool execution completed
              const toolResult = event.result
              const toolError = event.error
              const toolName = event.toolCall?.name

              if (toolError) {
                await emitReasoningEvent(
                  reasoningEmitter,
                  ReasoningSteps.toolCompleted(toolName, true)
                )
              } else {
                await emitReasoningEvent(
                  reasoningEmitter,
                  ReasoningSteps.toolCompleted(toolName, false)
                )
              }

              // Handle special tools
              if (toolName === XyneTools.toDoWrite && toolResult?.plan) {
                await emitReasoningEvent(
                  reasoningEmitter,
                  ReasoningSteps.planCreated(
                    toolResult.plan.goal || "Goal not specified",
                    toolResult.plan.subTasks?.map((t: any) => ({
                      id: t.id,
                      description: t.description,
                      status: t.status,
                    })) || []
                  )
                )
              }

              if (toolName === XyneTools.listCustomAgents && toolResult?.agents) {
                const agentCount = Array.isArray(toolResult.agents) 
                  ? toolResult.agents.length 
                  : 0
                const agentNames = agentCount 
                  ? toolResult.agents.map((a: any) => a.agentName) 
                  : undefined
                await emitReasoningEvent(
                  reasoningEmitter,
                  ReasoningSteps.agentsFound(agentCount, agentNames)
                )
              }

              if (toolName === XyneTools.runPublicAgent && toolResult) {
                const agentName = toolResult.agentName || "unknown agent"
                const delegationRunId = toolResult.delegationRunId
                await emitReasoningEvent(
                  reasoningEmitter,
                  ReasoningSteps.agentCompleted(agentName, delegationRunId)
                )
              }

              if (toolName === XyneTools.fallBack && toolResult?.reasoning) {
                await emitReasoningEvent(
                  reasoningEmitter,
                  ReasoningSteps.fallbackCompleted()
                )
              }

              // Handle synthesis completion
              if (
                toolName === XyneTools.synthesizeFinalAnswer &&
                !toolError
              ) {
                await emitReasoningEvent(
                  reasoningEmitter,
                  ReasoningSteps.synthesisCompleted()
                )
              }
              break
            }

            case "message_update": {
              // Handle assistant text streaming
              const assistantEvent = event.assistantMessageEvent
              if (assistantEvent?.type === "text_delta") {
                const delta = assistantEvent.delta
                if (delta) {
                  answer += delta
                  await stream.writeSSE({
                    event: ChatSSEvents.ResponseUpdate,
                    data: delta,
                  })

                  // Check for citations
                  for await (const citationEvent of checkAndYieldCitationsForAgent(
                    answer,
                    yieldedCitations,
                    agentContext.allFragments,
                    yieldedImageCitations,
                    email,
                  )) {
                    if (stream.closed) break
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
              break
            }

            case "turn_end": {
              // Turn completed
              break
            }

            case "agent_end": {
              // Run completed - persist and send final metadata
              if (!stream.closed) {
                try {
                  const persisted = await persistAssistantMessage(
                    {
                      chatRecord,
                      user,
                      workspace: { externalId: workspace.externalId },
                      agenticModelId,
                      totalCost: 0, // TODO: Extract from pi-mono
                      tokenUsage: { input: 0, output: 0 }, // TODO: Extract from pi-mono
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
                  lastPersistedMessageId = persisted.msg.id as number
                  lastPersistedMessageExternalId = persisted.assistantMessageId
                  
                  await persistTrace(lastPersistedMessageId, lastPersistedMessageExternalId)
                } catch (error) {
                  loggerWithChild({ email }).error(
                    error,
                    "Failed to persist assistant response",
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
              }
              break
            }

            case "error": {
              // Error occurred
              loggerWithChild({ email }).error(
                { error: event.error },
                "Pi-mono session error"
              )
              if (!stream.closed) {
                await stream.writeSSE({
                  event: ChatSSEvents.Error,
                  data: JSON.stringify({
                    error: "agent_error",
                    message: event.error?.message || "Unknown error",
                  }),
                })
              }
              break
            }
          }
        })

        // Start the pi-mono session with the user's message
        await piSession.prompt(message)

        // Wait for run to complete
        // The run_end event will handle cleanup and final metadata

        rootSpan.end()
      } catch (error) {
        loggerWithChild({ email }).error(error, "MessageAgentsPiMono stream error")
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
              "Failed to send stream_error to client (stream likely closed)",
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
  initializePiMonoAgentContext,
  buildPiMonoTools,
  persistAssistantMessage,
  ensureChatAndPersistUserMessage,
  resolveAgenticModelId,
  buildConversationHistoryForAgentRun,
  prepareInitialAttachmentContext,
}