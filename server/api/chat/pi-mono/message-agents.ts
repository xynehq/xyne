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
import {
  getChatMessagesWithAuth,
  insertMessage,
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
import {
  ChatSSEvents,
  type AttachmentMetadata,
  DEFAULT_TEST_AGENT_ID,
} from "@/shared/types"
import { MessageRole } from "@/types"
import { insertChat, updateChatByExternalIdWithAuth } from "@/db/chat"
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
} from "@/api/chat/utils"
import {
  buildFinalSynthesisPayload,
  buildFinalSynthesisRequest,
} from "@/api/chat/message-agents"
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
  createInitialXyneState,
  type XyneAgentState,
  setPersistFunction,
} from "./adapter"

const {
  defaultBestModel,
  defaultBestModelAgenticMode,
  JwtPayloadKey,
} = config

const Logger = getLogger(Subsystem.Chat)
const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

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
    message: data.answer,
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

/**
 * Build system prompt for pi-mono (mirrors JAF's buildAgentInstructions)
 */
function buildPiMonoSystemPrompt(
  toolNames: string[],
  dateForAI: string,
  agentPrompt?: string,
  userContext?: string,
  dedicatedAgentSystemPrompt?: string,
  email?: string,
  workspaceId?: string,
): string {
  const instructionLines: string[] = [
    "You are Xyne, an enterprise search assistant with agentic capabilities.",
    "",
    `The current date is: ${dateForAI}`,
    "",
    "<context>",
    `User: ${email || "Unknown"}`,
    `Workspace: ${workspaceId || "Unknown"}`,
    "</context>",
    "",
  ]

  // Available tools section
  instructionLines.push(
    "<available_tools>",
    "You have access to the following tools:",
    ...toolNames.map(name => `- ${name}`),
    "",
    "Tool descriptions:",
    "- todo_write: Create or update an execution plan with sequential tasks. MUST be called first.",
    "- searchGlobal: Search across all connected applications and data sources.",
    "- searchGmail: Search Gmail messages by content with optional filters.",
    "- searchDriveFiles: Search Google Drive files by title/content.",
    "- searchCalendarEvents: Search Google Calendar events.",
    "- searchGoogleContacts: Search Google Contacts.",
    "- getSlackRelatedMessages: Search Slack messages.",
    "- lsKnowledgeBase: Browse knowledge base collections/folders.",
    "- searchKnowledgeBase: Search document content in knowledge base.",
    "- searchChatHistory: Search earlier parts of the conversation.",
    "- listCustomAgents: List available custom AI agents.",
    "- runPublicAgent: Delegate execution to a custom agent.",
    "- synthesizeFinalAnswer: Generate and stream the final answer to the user. MUST be called last.",
    "- fallBack: Generate reasoning when search fails.",
    "</available_tools>",
    "",
  )

  // User context
  if (userContext?.trim()) {
    instructionLines.push("Workspace Context:", userContext.trim(), "")
  }

  // Agent system prompt
  if (dedicatedAgentSystemPrompt?.trim()) {
    instructionLines.push("Agent System Prompt:", dedicatedAgentSystemPrompt.trim(), "")
  } else if (agentPrompt?.trim()) {
    instructionLines.push("Agent Context:", agentPrompt.trim(), "")
  }

  // Core instructions
  instructionLines.push(
    "# PLANNING",
    "- Call todo_write at the start to create a plan.",
    "- The plan should have sequential tasks for gathering information.",
    "- Update task status as you progress.",
    "",
    "# EXECUTION",
    "- Work tasks sequentially; complete the current task before starting the next.",
    "- Use search tools to gather evidence from connected data sources.",
    "- Cite your sources using the K[docId_chunkIndex] format.",
    "",
    "# TOOL CALLS",
    "- Use the model's native function/tool-call interface.",
    "- Provide clean JSON arguments matching each tool's schema.",
    "- Wait for tool results before proceeding.",
    "",
    "# FINAL SYNTHESIS",
    "- When research is complete, CALL synthesizeFinalAnswer.",
    "- This tool streams the final response to the user.",
    "- Never output the final answer directly without using the tool.",
    "",
    "# CITATION RULES",
    "- ALWAYS cite at the chunk level with the K[docId_chunkIndex] format.",
    "- Place the citation immediately after the relevant claim.",
    "- Use at most 1-2 citations per sentence.",
    "",
  )

  return instructionLines.join("\n")
}

// ============================================================================
// CUSTOM TOOLS FOR PI-MONO
// ============================================================================

/**
 * Build the list of Xyne tools for pi-mono
 * Uses existing tool definitions from ./tools
 */
function buildXyneTools(): any[] {
  return [
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
  ]
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

        // Build custom tools (they use Xyne state via adapter)
        const customTools = buildXyneTools()

        // Build simplified system prompt (mirroring JAF structure)
        const systemPrompt = buildPiMonoSystemPrompt(
          customTools.map((tool: any) => tool.name),
          dateForAI,
          agentPromptForLLM,
          userCtxString,
          dedicatedAgentSystemPrompt,
          email,
          workspaceId
        )

    // Return streaming response
    return streamSSE(c, async (stream) => {
      const requestStartMs = Date.now()
      const stopController = new AbortController()
      const streamKey = String(chatRecord.externalId)

      const markStop = () => {
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

        // Prepare initial attachment context
        let initialAttachmentContext: {
          fragments: MinimalAgentFragment[]
          summary: string
        } | null = null

        if (allReferencedFileIds.length > 0) {
          await emitReasoningEvent(async (payload) => {
            thinkingLog += `${JSON.stringify(payload)}\n`
            await stream.writeSSE({
              event: ChatSSEvents.Reasoning,
              data: JSON.stringify(payload),
            })
          }, ReasoningSteps.attachmentAnalyzing())

          initialAttachmentContext = await prepareInitialAttachmentContext(
            allReferencedFileIds,
            threadIds,
            userMetadata,
            message,
            email,
            isMstWithAttachments,
          )

          if (initialAttachmentContext) {
            await emitReasoningEvent(async (payload) => {
              thinkingLog += `${JSON.stringify(payload)}\n`
              await stream.writeSSE({
                event: ChatSSEvents.Reasoning,
                data: JSON.stringify(payload),
              })
            }, ReasoningSteps.attachmentExtracted(
              initialAttachmentContext.fragments.length,
            ))
          }
        }

        // Handle image attachments
        const allFragments: MinimalAgentFragment[] = initialAttachmentContext?.fragments || []
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
          : `${config.LiteLLMBaseUrl}/v1`;

        // 2. Initialize AuthStorage and set LiteLLM credentials
        const authStorage = AuthStorage.create()
        if (config.LiteLLMApiKey) {
          authStorage.set("litellm", {
            type: "api_key",
            key: config.LiteLLMApiKey
          })
        }

        const modelRegistry = new ModelRegistry(authStorage)

        // 3. Define LiteLLM model directly (official pattern from docs)
        loggerWithChild({ email }).info(`Creating LiteLLM model profile for ${agenticModelId}`)
        const piModel = {
          id: agenticModelId,  // model ID as configured in LiteLLM (e.g., "kimi-latest")
          name: agenticModelId,
          api: "openai-completions",  // LiteLLM uses OpenAI-compatible API
          provider: "litellm",
          baseUrl: baseUrl,
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
          compat: {
            supportsStore: false,  // LiteLLM doesn't support 'store' field
            supportsStreaming: true,
            supportsToolStreaming: true
          }
        } as any

        loggerWithChild({ email }).info({
          modelId: piModel.id,
          modelProvider: piModel.provider,
          baseUrl: piModel.baseUrl
        }, "Using pi-mono model with LiteLLM")

        // Create Xyne state first (needed by tools)
        const xyneState = createInitialXyneState(
          email,
          String(workspaceId),
          user.id,
          String(chatRecord.externalId),
          message,
          attachmentsForContext
        )
        
        // Add additional context to state
        xyneState.userContext = userCtxString
        xyneState.agentPrompt = agentPromptForLLM
        xyneState.dedicatedAgentSystemPrompt = dedicatedAgentSystemPrompt
        xyneState.user.workspaceNumericId = workspace.id
        xyneState.chat.id = chatRecord.id
        
        // Set up persist function
        setPersistFunction(async (state) => {
          // Persist state if needed - for now just log
          loggerWithChild({ email }).debug("Persisting Xyne state")
        })

        // Build custom tools (they use Xyne state via adapter)
        const customTools = buildXyneTools()

        // Create pi-mono session
        const { session: piSession } = await createAgentSession({
          model: piModel,
          tools: [], // disable default tools
          customTools,
          authStorage,     // explicitly pass this (from docs)
          modelRegistry,   // explicitly pass this (from docs)
          sessionManager: SessionManager.inMemory(),
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: true },
            retry: { enabled: false, maxRetries: 3, baseDelayMs: 1000 },
          }),
        })

        // Set system prompt
        piSession.agent.setSystemPrompt(systemPrompt)
        
        // Store Xyne state in adapter for tools to access
        // Use the session's internal context as the key
        setXyneState(piSession as any, xyneState)
        
        // Log the full system prompt for debugging
        loggerWithChild({ email }).info(
          { systemPrompt },
          "📝 PI-MONO SYSTEM PROMPT"
        )
        
        loggerWithChild({ email }).info(
          { 
            systemPromptLength: systemPrompt.length, 
            toolCount: customTools.length,
            toolNames: customTools.map((t: any) => t.name)
          },
          "Created pi-mono session with Xyne state"
        )

        // Subscribe to events
        let answer = ""
        const citations: Citation[] = []
        const imageCitations: any[] = []
        const citationMap: Record<number, number> = {}
        const yieldedCitations = new Set<number>()
        const yieldedImageCitations = new Map<number, Set<number>>()
        let assistantMessageId: string | null = null

        const reasoningEmitter: StructuredReasoningEmitter = async (payload) => {
          thinkingLog += `${JSON.stringify(payload)}\n`
          if (stream.closed) return
          await stream.writeSSE({
            event: ChatSSEvents.Reasoning,
            data: JSON.stringify(payload),
          })
        }

        // Track completion
        let agentCompleted = false
        let agentCompletionResolve: (() => void) | null = null
        let agentCompletionReject: ((err: Error) => void) | null = null
        const agentCompletionPromise = new Promise<void>((resolve, reject) => {
          agentCompletionResolve = resolve
          agentCompletionReject = reject
        })

        // Subscribe to session events
        piSession.subscribe(async (event: any) => {
          // Log ALL events for debugging
          loggerWithChild({ email }).debug({ eventType: event.type, event }, "PI-MONO EVENT")
          
          if (stream.closed) return

          try {
            switch (event.type) {
              case "agent_start": {
                loggerWithChild({ email }).info("Pi-mono agent started")
                await emitReasoningEvent(reasoningEmitter, ReasoningSteps.turnStarted(1))
                break
              }

              case "tool_execution_start": {
                const toolName = event.toolName
                loggerWithChild({ email }).info({ toolName, args: event.args }, "🔧 TOOL EXECUTION STARTED")
                await emitReasoningEvent(reasoningEmitter, ReasoningSteps.toolSelected(toolName))
                break
              }

              case "tool_execution_end": {
                const toolName = event.toolName
                const isError = event.isError
                const result = event.result
                loggerWithChild({ email }).info({ toolName, isError, hasResult: !!result }, "🔧 TOOL EXECUTION ENDED")
                await emitReasoningEvent(reasoningEmitter, ReasoningSteps.toolCompleted(toolName, isError))
                
                if (toolName === "todo_write" && !isError) {
                  await emitReasoningEvent(reasoningEmitter, ReasoningSteps.planCreated(
                    "Execute search plan",
                    [{ id: "1", description: "Search for information", status: "in_progress" }]
                  ))
                }
                break
              }

              case "tool_call": {
                // Pi-mono might use different event name
                const toolName = event.toolName || event.name
                const args = event.args || event.arguments || event.input
                loggerWithChild({ email }).info({ toolName, args }, "🔧 TOOL CALL EVENT")
                break
              }

              case "message_update": {
                // Handle streaming text from assistant
                const assistantEvent = event.assistantMessageEvent
                if (assistantEvent?.type === "text_delta") {
                  const delta = assistantEvent.delta || ""
                  answer += delta
                  await stream.writeSSE({
                    event: ChatSSEvents.ResponseUpdate,
                    data: delta,
                  })
                }
                break
              }

              case "turn_start": {
                loggerWithChild({ email }).info({ turn: event.turnIndex }, "Pi-mono turn started")
                break
              }

              case "turn_end": {
                loggerWithChild({ email }).info({ turn: event.turnIndex }, "Pi-mono turn ended")
                break
              }

              case "assistant_message": {
                const content = event.message?.content
                loggerWithChild({ email }).info({ hasContent: !!content, contentLength: content?.length }, "Pi-mono assistant message")
                break
              }

              case "agent_end": {
                loggerWithChild({ email }).info("Pi-mono agent ended")
                agentCompleted = true
                if (agentCompletionResolve) {
                  agentCompletionResolve()
                }
                break
              }

              case "error": {
                const errorData = (event as any).error || {}
                loggerWithChild({ email }).error({ error: errorData }, "Pi-mono error")
                if (!stream.closed) {
                  await stream.writeSSE({
                    event: ChatSSEvents.Error,
                    data: JSON.stringify({
                      error: "agent_error",
                      message: errorData.message || "Unknown error",
                    }),
                  })
                }
                
                // Reject the promise so we don't wait 10 minutes
                agentCompleted = true
                if (agentCompletionReject) {
                  agentCompletionReject(new Error(errorData.message || "Agent Error"))
                }
                break
              }

              default: {
                loggerWithChild({ email }).debug({ eventType: event.type }, "Unhandled pi-mono event type")
              }
            }
          } catch (handlerError) {
            loggerWithChild({ email }).error(handlerError, "Event handler error")
          }
        })

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
        await new Promise(resolve => setTimeout(resolve, 100))
        
        if (promptError) {
          throw new Error(`Prompt failed: ${(promptError as Error).message}`)
        }
        
        loggerWithChild({ email }).info("Pi-mono prompt returned, waiting for completion...")

        // Wait for completion
        const completionTimeoutMs = 10 * 60 * 1000 // 10 minutes
        try {
          await Promise.race([
            agentCompletionPromise,
            new Promise<void>((_, reject) => 
              setTimeout(() => reject(new Error("Agent completion timeout")), completionTimeoutMs)
            )
          ])
          loggerWithChild({ email }).info("Agent completed successfully")
        } catch (timeoutErr) {
          loggerWithChild({ email }).error(timeoutErr, "Agent completion timeout")
          if (!agentCompleted) {
            throw timeoutErr
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
          loggerWithChild({ email }).error(persistErr, "Failed to persist message")
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
            loggerWithChild({ email }).warn(writeErr, "Failed to send error to client")
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
  ensureChatAndPersistUserMessage,
  resolveAgenticModelId,
  buildConversationHistoryForAgentRun,
  prepareInitialAttachmentContext,
  buildXyneTools,
  persistAssistantMessage,
}