// agentic rag
import { answerContextMap, cleanContext, userContext } from "@/ai/context"
import {
  baselineRAGJsonStream,
  generateSearchQueryOrAnswerFromConversation,
  generateTitleUsingQuery,
  jsonParseLLMOutput,
  meetingPromptJsonStream,
  queryRewriter,
  temporalEventClassification,
} from "@/ai/provider"
import {
  Models,
  type ConverseResponse,
  type TemporalClassifier,
} from "@/ai/types"
import config from "@/config"
import {
  deleteChatByExternalId,
  deleteMessagesByChatId,
  getChatByExternalId,
  getPublicChats,
  insertChat,
  updateChatByExternalId,
  updateMessageByExternalId,
} from "@/db/chat"
import { db } from "@/db/client"
import {
  getChatMessages,
  insertMessage,
  getMessageByExternalId,
  getChatMessagesBefore,
  updateMessage,
} from "@/db/message"
import {
  selectPublicChatSchema,
  selectPublicMessagesSchema,
  type SelectChat,
  type SelectMessage,
} from "@/db/schema"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getLogger } from "@/logger"
import { ChatSSEvents, OpenAIError, type MessageReqType } from "@/shared/types"
import { MessageRole, Subsystem } from "@/types"
import {
  getErrorMessage,
  getRelativeTime,
  splitGroupedCitationsWithSpaces,
} from "@/utils"
import {
  ToolResultContentBlock,
  type ConversationRole,
  type Message,
} from "@aws-sdk/client-bedrock-runtime"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE, type SSEStreamingApi } from "hono/streaming" // Import SSEStreamingApi
import { z } from "zod"
import type { chatSchema } from "@/api/search"
import { getTracer, type Span, type Tracer } from "@/tracer"
import { searchVespa, SearchModes, getItems } from "@/search/vespa"
import {
  Apps,
  chatMessageSchema,
  entitySchema,
  eventSchema,
  fileSchema,
  mailAttachmentSchema,
  mailSchema,
  userSchema,
  type VespaChatMessage,
  type VespaEvent,
  type VespaEventSearch,
  type VespaFile,
  type VespaMail,
  type VespaMailAttachment,
  type VespaMailSearch,
  type VespaSearchResult,
  type VespaSearchResultsSchema,
  type VespaUser,
  CalendarEntity,
  MailEntity,
  DriveEntity,
  type Entity,
  type VespaSearchResponse,
  type VespaSearchResults,
  type VespaGroupType,
  type VespaSchema, // Added import for VespaSchema
} from "@/search/types"
import { APIError } from "openai"
import {
  getChatTraceByExternalId,
  insertChatTrace,
  deleteChatTracesByChatExternalId,
  updateChatTrace,
} from "@/db/chatTrace"
import {
  getUserPersonalizationByEmail,
  getUserPersonalizationAlpha,
} from "@/db/personalization"
import VespaClient from "@/search/vespaClient"
import { generatePlannerActionJsonStream } from "@/ai/provider"
import {
  addErrMessageToMessage,
  handleError,
  processMessage,
  searchToCitation,
} from "@/api/chat/utils"
import type { Citation } from "./types"
import { activeStreams } from "./streams"
import { MessageMode } from "shared/types" // Import MessageMode
import {
  type AgentReasoningStep,
  AgentReasoningStepType,
  AgentToolName,
  type AgentReasoningIteration,
  type AgentReasoningPlanning,
  type AgentReasoningToolSelected,
  type AgentReasoningToolParameters,
  type AgentReasoningToolExecuting,
  type AgentReasoningToolResult,
  type AgentReasoningSynthesis,
  type AgentReasoningValidationError,
  type AgentReasoningBroadeningSearch,
  type AgentReasoningAnalyzingQuery,
  type AgentReasoningLogMessage,
} from "@/shared/types"

const {
  JwtPayloadKey,
  chatHistoryPageSize,
  defaultBestModel,
  defaultFastModel,
  maxDefaultSummary,
  chatPageSize,
  isReasoning,
  fastModelReasoning,
  StartThinkingToken,
  EndThinkingToken,
} = config
const Logger = getLogger(Subsystem.Chat)

interface MinimalAgentFragment {
  id: string // Unique ID for the fragment
  content: string
  source: Citation
  confidence: number
}

export const MessageApiAgenticMinimal = async (
  c: Context,
  parentSpan: Span,
) => {
  const rootSpan = parentSpan.startSpan("MessageApi_Agentic")
  let stream: any
  let chat: SelectChat | null = null
  let assistantMessageExternalId: string | null = null
  let userMessageExternalId: string | null = null
  let finalReasoningLogString = "" // For verbose server-side logging if needed
  const structuredReasoningSteps: AgentReasoningStep[] = [] // To store structured steps for DB
  const MOST_RECENT_CANDIDATE_COUNT = 3 // Define the constant here
  const costArr: number[] = [] // ***** Declare costArr here *****

  // Helper function to convert structured reasoning step to human-readable text for logging
  const convertReasoningStepToText = (step: AgentReasoningStep): string => {
    switch (step.type) {
      case AgentReasoningStepType.AnalyzingQuery:
        return step.details
      case AgentReasoningStepType.Iteration:
        return `### Iteration ${step.iteration}`
      case AgentReasoningStepType.Planning:
        return step.details // e.g., "Planning next step..."
      case AgentReasoningStepType.ToolSelected:
        return `Tool selected: ${step.toolName}`
      case AgentReasoningStepType.ToolParameters:
        const params = Object.entries(step.parameters)
          .map(
            ([key, value]) =>
              `• ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
          )
          .join("\n")
        return `Parameters:\n${params}`
      case AgentReasoningStepType.ToolExecuting:
        return `Executing tool: ${step.toolName}...`
      case AgentReasoningStepType.ToolResult:
        let resultText = `Tool result (${step.toolName}): ${step.resultSummary}`
        if (step.itemsFound !== undefined) {
          resultText += ` (Found ${step.itemsFound} item(s))`
        }
        if (step.error) {
          resultText += `\nError: ${step.error}`
        }
        return resultText
      case AgentReasoningStepType.Synthesis:
        return step.details // e.g., "Synthesizing answer from X fragments..."
      case AgentReasoningStepType.ValidationError:
        return `Validation Error: ${step.details}`
      case AgentReasoningStepType.BroadeningSearch:
        return `Broadening Search: ${step.details}`
      case AgentReasoningStepType.LogMessage:
        return step.message
      default:
        // This should ideally be an exhaustive check if all types are handled
        // const _exhaustiveCheck: never = step;
        return "Unknown reasoning step"
    }
  }

  try {
    // --- 1. Initial Setup ---
    const setupSpan = rootSpan.startSpan("initial_setup_agentic")
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

    // @ts-ignore
    const body = c.req.valid("query")
    let { message, chatId, modelId }: MessageReqType = body
    if (!message)
      throw new HTTPException(400, { message: "Message is required" })
    message = decodeURIComponent(message)
    rootSpan.setAttribute("message", message)

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const { user, workspace } = userAndWorkspace
    const userCtxObject = userContext(userAndWorkspace)
    const userAlpha = await getUserPersonalizationAlpha(db, email, 0.5)

    let dbMessages: SelectMessage[] = []
    let conversationHistory: Message[] = []
    let title = ""

    if (!chatId) {
      const titleSpan = setupSpan.startSpan("generate_title")
      const titleResp = await generateTitleUsingQuery(message, {
        modelId: defaultFastModel,
        stream: false,
      })
      title = titleResp.title
      titleSpan.setAttribute("title", title)
      titleSpan.end()

      let [insertedChat, insertedMsg] = await db.transaction(async (tx) => {
        const chat = await insertChat(tx, {
          title,
          workspaceId: workspace.id,
          workspaceExternalId: workspace.externalId,
          userId: user.id,
          email: user.email,
          attachments: [],
        })
        const msg = await insertMessage(tx, {
          message,
          chatId: chat.id,
          userId: user.id,
          chatExternalId: chat.externalId,
          workspaceExternalId: workspace.externalId,
          messageRole: MessageRole.User,
          email: user.email,
          sources: [],
          modelId,
          mode: MessageMode.Agentic, // Set mode for user message
        })
        return [chat, msg]
      })
      chat = insertedChat
      userMessageExternalId = insertedMsg.externalId
      dbMessages.push(insertedMsg)
      Logger.info("Agentic: Created new chat and user message", {
        chatId: chat.externalId,
        msgId: userMessageExternalId,
      })
    } else {
      let [existingChat, allMessages, insertedMsg] = await db.transaction(
        async (tx) => {
          let chat = await updateChatByExternalId(tx, chatId, {})
          let msgs = await getChatMessages(tx, chatId)
          let newMsg = await insertMessage(tx, {
            message,
            chatId: chat.id,
            userId: user.id,
            chatExternalId: chat.externalId,
            workspaceExternalId: workspace.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: [],
            modelId,
            mode: MessageMode.Agentic, // Set mode for user message
          })
          return [chat, msgs, newMsg]
        },
      )
      chat = existingChat
      userMessageExternalId = insertedMsg.externalId
      dbMessages = allMessages.concat(insertedMsg)
      Logger.info("Agentic: Loaded existing chat and added new user message", {
        chatId: chat.externalId,
        msgId: userMessageExternalId,
      })
    }

    conversationHistory = dbMessages
      .slice(0, -1)
      .filter(
        (msg): msg is SelectMessage & { message: string } =>
          // Type guard to ensure message exists
          !msg?.errorMessage &&
          msg.messageRole !== MessageRole.System &&
          typeof msg.message === "string",
      )
      .map((m) => ({
        role: m.messageRole as ConversationRole,
        content: [{ text: m.message }],
      }))
    setupSpan.end()

    if (!chat || !userMessageExternalId) {
      throw new Error(
        "Failed to create or identify chat/user message for agentic API.",
      )
    }

    // --- 2. Define Agent Tools ---
    interface AgentTool {
      name: string
      description: string
      parameters: Record<
        string,
        {
          type: string
          description: string
          required: boolean
        }
      >
      execute: (
        params: any,
        span?: Span,
      ) => Promise<{
        result: string // Human-readable summary of action/result
        contexts?: MinimalAgentFragment[] // Data fragments found
        error?: string // Error message if failed
      }>
    }

    // Search Tool (existing)
    const searchTool: AgentTool = {
      name: "search",
      description:
        "Search for general information across all data sources (Gmail, Calendar, Drive) using keywords.",
      parameters: {
        query: {
          type: "string",
          description: "The keywords or question to search for.",
          required: true,
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 10).",
          required: false,
        },
        excludedIds: {
          type: "array",
          description: "Optional list of document IDs to exclude from results.",
          required: false,
        },
      },
      execute: async (
        params: { query: string; limit?: number; excludedIds?: string[] },
        span?: Span,
      ) => {
        const execSpan = span?.startSpan("execute_search_tool")
        try {
          const searchLimit = params.limit || 10
          execSpan?.setAttribute("query", params.query)
          execSpan?.setAttribute("limit", searchLimit)
          if (params.excludedIds && params.excludedIds.length > 0) {
            execSpan?.setAttribute(
              "excludedIds",
              JSON.stringify(params.excludedIds),
            )
          }
          const searchResults = await searchVespa(
            params.query,
            email,
            null,
            null,
            {
              limit: searchLimit,
              alpha: userAlpha,
              excludedIds: params.excludedIds, // Pass excludedIds
              span: execSpan?.startSpan("vespa_search"),
            },
          )
          const children = searchResults?.root?.children || []
          execSpan?.setAttribute("results_count", children.length)
          if (children.length === 0)
            return { result: "No results found.", contexts: [] }
          const fragments = children.map((r) => {
            const citation = searchToCitation(r as any)
            return {
              id: `${citation.docId}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
              content: answerContextMap(r as any, maxDefaultSummary),
              source: citation,
              confidence: r.relevance || 0.7,
            }
          })
          const topItemsList = fragments
            .slice(0, 3)
            .map((f) => `- \"${f.source.title || "Untitled"}\"`)
            .join("\n")
          const summaryText = `Found ${fragments.length} results matching '${params.query}'.\nTop items:\n${topItemsList}`
          return { result: summaryText, contexts: fragments }
        } catch (error) {
          const errMsg = getErrorMessage(error)
          execSpan?.setAttribute("error", errMsg)
          return { result: `Search error: ${errMsg}`, error: errMsg }
        } finally {
          execSpan?.end()
        }
      },
    }

    // Filtered Search Tool (existing)
    const filteredSearchTool: AgentTool = {
      name: "filtered_search",
      description:
        "Search for information using keywords within a specific application. The 'app' parameter MUST BE EXACTLY ONE OF 'gmail', 'googlecalendar', 'googledrive'.",
      parameters: {
        query: {
          type: "string",
          description: "The keywords or question to search for.",
          required: true,
        },
        app: {
          type: "string",
          description:
            "The app to search in (MUST BE EXACTLY ONE OF 'gmail', 'googlecalendar', 'googledrive'). Case-insensitive.",
          required: true,
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 10).",
          required: false,
        },
        excludedIds: {
          type: "array",
          description: "Optional list of document IDs to exclude from results.",
          required: false,
        },
      },
      execute: async (
        params: {
          query: string
          app: string
          limit?: number
          excludedIds?: string[]
        },
        span?: Span,
      ) => {
        const execSpan = span?.startSpan("execute_filtered_search_tool")
        const lowerCaseApp = params.app.toLowerCase()
        try {
          const searchLimit = params.limit || 10
          execSpan?.setAttribute("query", params.query)
          execSpan?.setAttribute("app_original", params.app)
          execSpan?.setAttribute("app_processed", lowerCaseApp)
          execSpan?.setAttribute("limit", searchLimit)
          if (params.excludedIds && params.excludedIds.length > 0) {
            execSpan?.setAttribute(
              "excludedIds",
              JSON.stringify(params.excludedIds),
            )
          }

          let appEnum: Apps | null = null
          if (lowerCaseApp === "gmail") appEnum = Apps.Gmail
          else if (lowerCaseApp === "googlecalendar")
            appEnum = Apps.GoogleCalendar
          else if (lowerCaseApp === "googledrive") appEnum = Apps.GoogleDrive
          else {
            const errorMsg = `Error: Invalid app specified: '${params.app}'. Valid apps are 'gmail', 'googlecalendar', 'googledrive'.`
            execSpan?.setAttribute("error", errorMsg)
            return { result: errorMsg, error: "Invalid app" }
          }

          const vespaOptions: any = {
            limit: searchLimit,
            offset: 0,
            excludedIds: params.excludedIds,
            span: execSpan,
          }

          // Use lowerCaseApp in the error message
          if (!appEnum) {
            // Use correct app names in error message
            const errorMsg = `Invalid app specified: ${params.app}. Valid apps: gmail, google-calendar, google-drive.`
            execSpan?.setAttribute("error", errorMsg)
            return { result: errorMsg, error: "Invalid app" }
          }
          const searchResults = await searchVespa(
            params.query,
            email,
            appEnum,
            null,
            {
              limit: searchLimit,
              alpha: userAlpha,
              excludedIds: params.excludedIds, // Pass excludedIds
              span: execSpan?.startSpan("vespa_search"),
            },
          )
          const children = searchResults?.root?.children || []
          execSpan?.setAttribute("results_count", children.length)
          // Use lowerCaseApp in the success message
          if (children.length === 0)
            return {
              result: `No results found in ${lowerCaseApp}.`,
              contexts: [],
            }
          const fragments = children.map((r) => {
            const citation = searchToCitation(r as any)
            return {
              id: `${citation.docId}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
              content: answerContextMap(r as any, maxDefaultSummary),
              source: citation,
              confidence: r.relevance || 0.7,
            }
          })
          // Use lowerCaseApp in the summary
          const topItemsList = fragments
            .slice(0, 3)
            .map((f) => `- \"${f.source.title || "Untitled"}\"`)
            .join("\n")
          const summaryText = `Found ${fragments.length} results in \`${lowerCaseApp}\`.\nTop items:\n${topItemsList}`
          return { result: summaryText, contexts: fragments }
        } catch (error) {
          const errMsg = getErrorMessage(error)
          execSpan?.setAttribute("error", errMsg)
          // Use lowerCaseApp (now in scope) in the error message
          return {
            result: `Search error in ${lowerCaseApp}: ${errMsg}`,
            error: errMsg,
          }
        } finally {
          execSpan?.end()
        }
      },
    }

    // Time Search Tool (existing)
    const timeSearchTool: AgentTool = {
      name: "time_search",
      description:
        "Search for information using keywords within a specific time range (relative to today).",
      parameters: {
        query: {
          type: "string",
          description: "The keywords or question to search for.",
          required: true,
        },
        from_days_ago: {
          type: "number",
          description: "Start search N days ago.",
          required: true,
        },
        to_days_ago: {
          type: "number",
          description: "End search N days ago (0 means today).",
          required: true,
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 10).",
          required: false,
        },
        excludedIds: {
          type: "array",
          description: "Optional list of document IDs to exclude from results.",
          required: false,
        },
      },
      execute: async (
        params: {
          query: string
          from_days_ago: number
          to_days_ago: number
          limit?: number
          excludedIds?: string[]
        },
        span?: Span,
      ) => {
        const execSpan = span?.startSpan("execute_time_search_tool")
        try {
          const searchLimit = params.limit || 10
          execSpan?.setAttribute("query", params.query)
          execSpan?.setAttribute("from_days_ago", params.from_days_ago)
          execSpan?.setAttribute("to_days_ago", params.to_days_ago)
          execSpan?.setAttribute("limit", searchLimit)
          if (params.excludedIds && params.excludedIds.length > 0) {
            execSpan?.setAttribute(
              "excludedIds",
              JSON.stringify(params.excludedIds),
            )
          }
          const DAY_MS = 24 * 60 * 60 * 1000
          const now = Date.now()
          const fromTime = now - params.from_days_ago * DAY_MS
          const toTime = now - params.to_days_ago * DAY_MS
          const from = Math.min(fromTime, toTime)
          const to = Math.max(fromTime, toTime)
          execSpan?.setAttribute("from_date", new Date(from).toISOString())
          execSpan?.setAttribute("to_date", new Date(to).toISOString())
          const searchResults = await searchVespa(
            params.query,
            email,
            null,
            null,
            {
              limit: searchLimit,
              alpha: userAlpha,
              timestampRange: { from, to },
              excludedIds: params.excludedIds, // Pass excludedIds
              span: execSpan?.startSpan("vespa_search"),
            },
          )
          const children = searchResults?.root?.children || []
          execSpan?.setAttribute("results_count", children.length)
          if (children.length === 0)
            return {
              result: `No results found in the specified time range.`,
              contexts: [],
            }
          const fragments = children.map((r) => {
            const citation = searchToCitation(r as any)
            return {
              id: `${citation.docId}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
              content: answerContextMap(r as any, maxDefaultSummary),
              source: citation,
              confidence: r.relevance || 0.7,
            }
          })
          const topItemsList = fragments
            .slice(0, 3)
            .map((f) => `- \"${f.source.title || "Untitled"}\"`)
            .join("\n")
          const summaryText = `Found ${fragments.length} results in time range (\`${params.from_days_ago}\` to \`${params.to_days_ago}\` days ago).\nTop items:\n${topItemsList}`
          return { result: summaryText, contexts: fragments }
        } catch (error) {
          const errMsg = getErrorMessage(error)
          execSpan?.setAttribute("error", errMsg)
          return { result: `Time search error: ${errMsg}`, error: errMsg }
        } finally {
          execSpan?.end()
        }
      },
    }

    // === NEW Metadata Retrieval Tool ===
    const metadataRetrievalTool: AgentTool = {
      name: "metadata_retrieval",
      description:
        "Retrieves a list of items (e.g., emails, calendar events, drive files) based on type and time. Use for 'list my recent emails', 'show my first documents about X', 'find uber receipts'.",
      parameters: {
        item_type: {
          type: "string",
          description:
            "Type of item (e.g., 'meeting', 'event', 'email', 'notification', 'document', 'file'). For receipts or specific service-related items in email, use 'email'.",
          required: true,
        },
        app: {
          type: "string",
          description:
            "Optional app filter. If provided, MUST BE EXACTLY ONE OF 'gmail', 'googlecalendar', 'googledrive'. If omitted, inferred from item_type.",
          required: false,
        },
        entity: {
          type: "string",
          description:
            "Optional specific kind of item if item_type is 'document' or 'file' (e.g., 'spreadsheet', 'pdf', 'presentation').",
          required: false,
        },
        filter_query: {
          type: "string",
          description:
            "Optional keywords to filter the items (e.g., 'uber trip', 'flight confirmation').",
          required: false,
        },
        limit: {
          type: "number",
          description: "Maximum number of items to retrieve (default: 10).",
          required: false,
        },
        offset: {
          type: "number",
          description: "Number of items to skip for pagination (default: 0).",
          required: false,
        },
        order_direction: {
          type: "string",
          description:
            "Sort direction: 'asc' (oldest first) or 'desc' (newest first, default).",
          required: false,
        },
        excludedIds: {
          type: "array",
          description: "Optional list of document IDs to exclude from results.",
          required: false,
        },
      },
      execute: async (
        params: {
          item_type: string
          app?: string
          entity?: string
          filter_query?: string
          limit?: number
          offset?: number
          order_direction?: "asc" | "desc"
          excludedIds?: string[]
        },
        span?: Span,
      ) => {
        const execSpan = span?.startSpan("execute_metadata_retrieval_tool")
        execSpan?.setAttribute("item_type", params.item_type)
        if (params.app) execSpan?.setAttribute("app_param_original", params.app)
        if (params.entity) execSpan?.setAttribute("entity_param", params.entity)
        if (params.filter_query)
          execSpan?.setAttribute("filter_query", params.filter_query)
        execSpan?.setAttribute("limit", params.limit || 10)
        execSpan?.setAttribute("offset", params.offset || 0)
        if (params.order_direction)
          execSpan?.setAttribute(
            "order_direction_param",
            params.order_direction,
          )

        try {
          let schema: VespaSchema
          let entity: Entity | null = null
          let appToUse: Apps | null = null
          let timestampField: string

          const lowerCaseProvidedApp = params.app?.toLowerCase()

          // 1. Validate and set appToUse if params.app is provided
          if (lowerCaseProvidedApp) {
            if (lowerCaseProvidedApp === "gmail") appToUse = Apps.Gmail
            else if (lowerCaseProvidedApp === "googlecalendar")
              appToUse = Apps.GoogleCalendar
            else if (lowerCaseProvidedApp === "googledrive")
              appToUse = Apps.GoogleDrive
            else {
              const errorMsg = `Error: Invalid app '${params.app}' specified. Valid apps are 'gmail', 'googlecalendar', 'googledrive', or omit to infer from item_type.`
              execSpan?.setAttribute("error", errorMsg)
              return { result: errorMsg, error: "Invalid app" }
            }
            execSpan?.setAttribute(
              "app_from_user_validated",
              appToUse.toString(),
            )
          }

          // 2. Map item_type to schema, entity, timestampField, and default appToUse if not already set by user
          switch (params.item_type.toLowerCase()) {
            case "meeting":
            case "event":
              schema = eventSchema
              entity = CalendarEntity.Event
              timestampField = "startTime"
              if (!appToUse) appToUse = Apps.GoogleCalendar
              break
            case "email":
            case "message":
            case "notification": // 'notification' often implies email
              schema = mailSchema
              entity = MailEntity.Email
              timestampField = "timestamp"
              if (!appToUse) appToUse = Apps.Gmail
              break
            case "document":
            case "file":
              schema = fileSchema
              entity = null
              timestampField = "updatedAt" // Default entity to null for broader file searches
              if (!appToUse) appToUse = Apps.GoogleDrive
              break
            case "mail_attachment": // New case for mail attachments
            case "attachment": // New case for mail attachments
              schema = mailAttachmentSchema
              entity = null // No specific MailEntity for attachments, rely on schema
              timestampField = "timestamp" // Assuming 'timestamp' for recency
              if (!appToUse) appToUse = Apps.Gmail
              break
            case "user":
            case "person":
              schema = userSchema
              entity = null
              timestampField = "creationTime"
              if (!appToUse) appToUse = Apps.GoogleWorkspace // Default to Google Workspace users
              break
            case "contact":
              schema = userSchema
              entity = null
              timestampField = "creationTime"
              if (!appToUse) appToUse = null // Default to null app to target personal contacts via owner field in getItems
              break
            default:
              const unknownItemMsg = `Error: Unknown item_type '${params.item_type}'`
              execSpan?.setAttribute("error", unknownItemMsg)
              return { result: unknownItemMsg, error: `Unknown item_type` }
          }

          // Initialize finalEntity with the entity derived from item_type (often null for documents)
          let finalEntity: Entity | null = entity
          execSpan?.setAttribute(
            "initial_entity_from_item_type",
            finalEntity ? finalEntity.toString() : "null",
          )

          // If LLM provides an entity string, and it's for a Drive document/file, try to map it to a DriveEntity enum
          if (
            params.entity &&
            (params.item_type.toLowerCase() === "document" ||
              params.item_type.toLowerCase() === "file") &&
            appToUse === Apps.GoogleDrive
          ) {
            const llmEntityString = params.entity.toLowerCase().trim()
            execSpan?.setAttribute(
              "llm_provided_entity_string_for_drive",
              llmEntityString,
            )

            let mappedToDriveEntity: DriveEntity | null = null
            switch (llmEntityString) {
              case "sheets":
              case "spreadsheet":
                mappedToDriveEntity = DriveEntity.Sheets
                break
              case "slides":
                mappedToDriveEntity = DriveEntity.Slides
                break
              case "presentation":
              case "powerpoint":
                mappedToDriveEntity = DriveEntity.Presentation
                break
              case "pdf":
                mappedToDriveEntity = DriveEntity.PDF
                break
              case "doc":
              case "docs":
                mappedToDriveEntity = DriveEntity.Docs
                break
              case "folder":
                mappedToDriveEntity = DriveEntity.Folder
                break
              case "drawing":
                mappedToDriveEntity = DriveEntity.Drawing
                break
              case "form":
                mappedToDriveEntity = DriveEntity.Form
                break
              case "script":
                mappedToDriveEntity = DriveEntity.Script
                break
              case "site":
                mappedToDriveEntity = DriveEntity.Site
                break
              case "map":
                mappedToDriveEntity = DriveEntity.Map
                break
              case "audio":
                mappedToDriveEntity = DriveEntity.Audio
                break
              case "video":
                mappedToDriveEntity = DriveEntity.Video
                break
              case "photo":
                mappedToDriveEntity = DriveEntity.Photo
                break
              case "image":
                mappedToDriveEntity = DriveEntity.Image
                break
              case "zip":
                mappedToDriveEntity = DriveEntity.Zip
                break
              case "word":
              case "word_document":
                mappedToDriveEntity = DriveEntity.WordDocument
                break
              case "excel":
              case "excel_spreadsheet":
                mappedToDriveEntity = DriveEntity.ExcelSpreadsheet
                break
              case "text":
                mappedToDriveEntity = DriveEntity.Text
                break
              case "csv":
                mappedToDriveEntity = DriveEntity.CSV
                break
              // default: // No default, if not mapped, mappedToDriveEntity remains null
            }

            if (mappedToDriveEntity) {
              finalEntity = mappedToDriveEntity // Override with the more specific DriveEntity
              execSpan?.setAttribute(
                "mapped_llm_entity_to_drive_enum",
                finalEntity.toString(),
              )
            } else {
              execSpan?.setAttribute(
                "llm_entity_string_not_mapped_to_drive_enum",
                llmEntityString,
              )
              // finalEntity remains as initially set (e.g., null if item_type was 'document')
            }
          }

          execSpan?.setAttribute("derived_schema", schema.toString())
          if (entity)
            execSpan?.setAttribute("derived_entity", entity.toString())
          execSpan?.setAttribute(
            "final_app_to_use",
            appToUse ? appToUse.toString() : "null",
          )

          // 3. Sanity check: if user specified an app, ensure it's compatible with the item_type's inferred schema and app
          if (params.app) {
            // Only if user explicitly provided an app
            let expectedAppForType: Apps | null = null
            if (schema === mailSchema) expectedAppForType = Apps.Gmail
            else if (schema === eventSchema)
              expectedAppForType = Apps.GoogleCalendar
            else if (schema === fileSchema)
              expectedAppForType = Apps.GoogleDrive

            if (expectedAppForType && appToUse !== expectedAppForType) {
              const mismatchMsg = `Error: Item type '${params.item_type}' (typically in ${expectedAppForType}) is incompatible with specified app '${params.app}'.`
              execSpan?.setAttribute("error", mismatchMsg)
              return { result: mismatchMsg, error: `App/Item type mismatch` }
            }
          }

          const orderByString: string | undefined = params.order_direction
            ? `${timestampField} ${params.order_direction}`
            : undefined
          if (orderByString)
            execSpan?.setAttribute("orderBy_constructed", orderByString)

          // --- Vespa Call ---
          let searchResults: VespaSearchResponse | null = null
          let children: VespaSearchResults[] = []
          const searchOptionsVespa: {
            limit: number
            offset: number
            excludedIds: string[] | undefined
            span: Span | undefined
          } = {
            limit: params.limit || 10,
            offset: params.offset || 0,
            excludedIds: params.excludedIds,
            span: execSpan,
          }

          if (params.filter_query) {
            const searchQuery = params.filter_query
            if (params.order_direction) {
              execSpan?.setAttribute(
                "vespa_call_type",
                "searchVespa_GlobalSorted",
              )
              // TODO: let rank profile global sorted also respect the direction
              // currently it's hardcoded to desc
              searchResults = await searchVespa(
                searchQuery,
                email,
                appToUse,
                entity,
                {
                  limit: searchOptionsVespa.limit,
                  offset: searchOptionsVespa.offset,
                  excludedIds: searchOptionsVespa.excludedIds,
                  rankProfile: SearchModes.GlobalSorted,
                  span: execSpan?.startSpan(
                    "vespa_search_filtered_sorted_globalsorted",
                  ),
                },
              )
            } else {
              execSpan?.setAttribute(
                "vespa_call_type",
                "searchVespa_filter_no_sort",
              )
              searchResults = await searchVespa(
                searchQuery,
                email,
                appToUse,
                entity,
                {
                  limit: searchOptionsVespa.limit,
                  offset: searchOptionsVespa.offset,
                  excludedIds: searchOptionsVespa.excludedIds,
                  rankProfile: SearchModes.NativeRank,
                  span: execSpan?.startSpan("vespa_search_metadata_filtered"),
                },
              )
            }
            children = (searchResults?.root?.children || []).filter(
              (item): item is VespaSearchResults =>
                !!(item.fields && "sddocname" in item.fields),
            )
          } else {
            execSpan?.setAttribute(
              "vespa_call_type",
              "getItems_no_keyword_filter",
            )
            searchResults = await getItems({
              schema,
              app: appToUse,
              entity: finalEntity, // Use finalEntity here
              timestampRange: null,
              limit: searchOptionsVespa.limit,
              offset: searchOptionsVespa.offset,
              email,
              orderBy: orderByString,
              excludedIds: params.excludedIds, // Pass excludedIds from params directly
            })
            children = (searchResults?.root?.children || []).filter(
              (item): item is VespaSearchResults =>
                !!(item.fields && "sddocname" in item.fields),
            )
          }

          execSpan?.setAttribute("retrieved_items_count", children.length)

          // --- Format Result ---
          if (children.length > 0) {
            const fragments: MinimalAgentFragment[] = children.map(
              (item: VespaSearchResults): MinimalAgentFragment => {
                const citation = searchToCitation(item)
                Logger.debug(
                  { item },
                  "Processing item in metadata_retrieval tool",
                )

                const content = item.fields
                  ? answerContextMap(item, maxDefaultSummary)
                  : `Context unavailable for ${citation.title || citation.docId}`

                return {
                  id: `${citation.docId}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
                  content: content,
                  source: citation,
                  confidence: item.relevance || 0.7, // Use item.relevance if available
                }
              },
            )

            let responseText = `Found ${fragments.length} ${params.item_type}(s)`
            if (params.filter_query) {
              responseText += ` matching '${params.filter_query}'`
            }
            // Use the processed app name if available
            const appNameForText =
              lowerCaseProvidedApp ||
              (appToUse ? appToUse.toString() : null) ||
              "any app"
            if (params.app) {
              responseText += ` in \`${appNameForText}\``
            }
            if (params.offset && params.offset > 0) {
              const currentOffset = params.offset || 0
              responseText += ` (showing items ${currentOffset + 1} to ${currentOffset + fragments.length})`
            }
            const topItemsList = fragments
              .slice(0, 3)
              .map((f) => `- \"${f.source.title || "Untitled"}\"`)
              .join("\n")
            responseText += `.\nTop items:\n${topItemsList}`

            const successResult: {
              result: string
              contexts: MinimalAgentFragment[]
            } = {
              result: responseText,
              contexts: fragments,
            }
            return successResult
          } else {
            let notFoundMsg = `Could not find the ${params.item_type}`
            if (params.filter_query)
              notFoundMsg += ` matching '${params.filter_query}'`
            // Use the processed app name if available
            const appNameForText =
              lowerCaseProvidedApp ||
              (appToUse ? appToUse.toString() : null) ||
              "any app"
            if (params.app) notFoundMsg += ` in ${appNameForText}`
            notFoundMsg += `.`
            return { result: notFoundMsg, contexts: [] }
          }
        } catch (error) {
          const errMsg = getErrorMessage(error)
          execSpan?.setAttribute("error", errMsg)
          Logger.error(error, `Metadata retrieval tool error: ${errMsg}`)
          // Ensure this return type matches the interface
          return {
            result: `Error retrieving metadata: ${errMsg}`,
            error: errMsg,
          }
        } finally {
          execSpan?.end()
        }
      },
    }

    // All available tools, including the new one
    const agentTools: Record<string, AgentTool> = {
      metadata_retrieval: metadataRetrievalTool, // Add the new tool
      search: searchTool,
      filtered_search: filteredSearchTool,
      time_search: timeSearchTool,
    }

    // --- 3. Start Streaming & Agent Loop ---
    return streamSSE(c, async (sseStream) => {
      stream = sseStream
      const streamSpan = rootSpan.startSpan("stream_response_agentic")
      streamSpan.setAttribute("chatId", chat!.externalId)
      streamSpan.setAttribute("userMessageId", userMessageExternalId!)

      await stream.writeSSE({
        event: ChatSSEvents.ResponseMetadata,
        data: JSON.stringify({ chatId: chat!.externalId, messageId: null }),
      })
      if (!chatId && title) {
        await stream.writeSSE({
          data: title,
          event: ChatSSEvents.ChatTitleUpdate,
        })
      }

      let maxIterations = 5
      let iteration = 0
      let currentQuery = message
      let gatheredFragments: MinimalAgentFragment[] = []
      let finalAnswer = ""
      let finalCitationMap: Record<number, number> = {}
      let allCitedFragments: Citation[] = []
      let loopError: string | null = null
      let agentLog: string[] = []
      let consecutiveValidationFailures = 0 // NEW: Track consecutive validation failures
      let excludedIds: string[] = [] // NEW: Track IDs to exclude

      // Declare shouldSynthesize here so it's in scope for the tool selection check
      let shouldSynthesize = false

      // Helper function to log and stream reasoning to client
      const logAndStreamReasoning = async (
        reasoningStep: AgentReasoningStep,
      ) => {
        const humanReadableLog = convertReasoningStepToText(reasoningStep)
        agentLog.push(humanReadableLog) // For building the prompt context
        finalReasoningLogString += humanReadableLog + "\n" // For verbose server logs if desired
        structuredReasoningSteps.push(reasoningStep) // Store the structured step

        await stream.writeSSE({
          event: ChatSSEvents.Reasoning,
          data: JSON.stringify(reasoningStep), // Send the structured object to client
        })
      }

      // --- NEW Helper Function: Validate Single Result Quality ---
      const validateSingleResultQuality = async (
        userQuery: string,
        resultFragment: MinimalAgentFragment,
        validationSpan?: Span,
      ): Promise<boolean> => {
        const funcSpan = validationSpan?.startSpan(
          "validateSingleResultQuality",
        )
        funcSpan?.setAttribute("userQuery", userQuery)
        funcSpan?.setAttribute(
          "resultTitle",
          resultFragment.source.title || "N/A",
        )
        funcSpan?.setAttribute(
          "resultContentSample",
          resultFragment.content.substring(0, 100),
        )

        try {
          const validationPrompt = `User Query: "${userQuery}" (The user was likely looking for the single most recent or oldest specific item related to this query).

  Result Found:
  Source: ${resultFragment.source.title || "Unknown Source"} (${resultFragment.source.app})
  Content Snippet: ${resultFragment.content.substring(0, 200)}...

  Question: Does this result content seem like the *specific type* of item the user was most likely searching for (e.g., a specific email, a trip receipt, an event confirmation, a particular document version), or is it more likely tangential/generic content that happens to match keywords (e.g., a promotional email, a general help document, unrelated meeting notes)?

  Respond ONLY with 'GOOD_MATCH' if it seems like the specific item sought, or 'POOR_MATCH' otherwise.`

          // Using baselineRAGJsonStream for simplicity, asking for non-JSON text output
          const iterator = baselineRAGJsonStream(
            validationPrompt, // The query to the LLM
            "You are an AI assistant evaluating search result relevance to user intent. Respond ONLY with GOOD_MATCH or POOR_MATCH.", // System prompt
            "", // No extra context needed
            {
              modelId: defaultFastModel,
              stream: true,
              json: false,
              reasoning: false,
            }, // Simple text response needed
          )

          let validationResponse = ""
          for await (const chunk of iterator) {
            if (chunk.text) {
              validationResponse += chunk.text
            }
            // Ignore cost for this simple validation
          }

          validationResponse = validationResponse.trim().toUpperCase()
          funcSpan?.setAttribute("llmResponse", validationResponse)

          const isGoodMatch = validationResponse === "GOOD_MATCH"
          funcSpan?.setAttribute("isGoodMatch", isGoodMatch)
          funcSpan?.end()
          return isGoodMatch
        } catch (error) {
          const errMsg = getErrorMessage(error)
          funcSpan?.setAttribute("error", errMsg)
          Logger.error(
            error,
            `Error during single result validation: ${errMsg}`,
          )
          funcSpan?.end()
          return true // Default to assuming it's good if validation fails
        }
      }
      // --- End Helper Function ---

      try {
        await logAndStreamReasoning({
          type: AgentReasoningStepType.AnalyzingQuery,
          details: "Analyzing your question...",
        })

        // === Agent Tool Loop ===
        while (iteration < maxIterations && !finalAnswer && !loopError) {
          iteration++
          const iterSpan = streamSpan.startSpan(`agent_iteration_${iteration}`)
          iterSpan.setAttribute("iteration", iteration)

          // --- Planning and Tool Execution ---
          const planSpan = iterSpan.startSpan("agent_planning_and_execution")
          let currentToolSelection: { tool: string; parameters: any } | null =
            null
          let parsedToolSelection: { tool: string; parameters: any } | null =
            null
          let toolSelectionError: Error | null = null
          let toolResult: {
            result: string
            contexts?: MinimalAgentFragment[]
            error?: string
          } | null = null // Store result here
          let broadeningInstruction = "" // NEW: Instruction for broadening search

          try {
            // --- NEW: Check for stagnation and add broadening instruction ---
            const STAGNATION_THRESHOLD = 2 // Example threshold
            if (consecutiveValidationFailures >= STAGNATION_THRESHOLD) {
              broadeningInstruction = `\n**Instruction:** The previous specific search attempts (limit: 1) failed validation ${consecutiveValidationFailures} times. Broaden the search now. Prefer the general 'search' tool with core keywords. Remove strict filters (like limit: 1). Exclude the following previously failed IDs: ${JSON.stringify(excludedIds)}.`
              await logAndStreamReasoning({
                type: AgentReasoningStepType.BroadeningSearch,
                details: `Specific search failed validation ${consecutiveValidationFailures} times. Attempting to broaden search.`,
              })
              planSpan.setAttribute("broadening_search", true)
              planSpan.setAttribute(
                "excludedIds_for_broadening",
                JSON.stringify(excludedIds),
              )
              consecutiveValidationFailures = 0 // Reset after deciding to broaden
            }
            // --- End NEW ---

            await logAndStreamReasoning({
              type: AgentReasoningStepType.Iteration,
              iteration,
            })
            await logAndStreamReasoning({
              type: AgentReasoningStepType.Planning,
              details: "Planning next step...",
            })

            // Build planning context
            const planningContext = gatheredFragments
              .map(
                (f, i) =>
                  `[${i + 1}] ${f.source.title || "Source"}: ${f.content.substring(0, 100)}...`,
              )
              .join("\n")

            // ** Refined Planning Prompt **
            // This prompt guides the LLM to select the most appropriate tool based on query analysis.
            // It aims to improve handling of:
            // - Specific item/list retrieval queries (e.g., "latest email", "5 recent docs") -> metadata_retrieval
            // - App-specific searches (e.g., "search drive for X") -> filtered_search
            // - Keyword-based content searches -> search, time_search
            // - Summarization/Analysis requests (by gathering context first)
            const planningPrompt = `Current Query: "${currentQuery}"
  Conversation History: ${conversationHistory.map((m: any) => `${m.role}: ${m.content?.[0]?.text ?? ""}`).join("\\n")}
  Agent Log / Previous Steps:
  ${agentLog.join("\\n")}
  Available Context Fragments (${gatheredFragments.length}):
  ${planningContext || "None yet"}
  ${broadeningInstruction} // Inject broadening instruction here if applicable

  **Query Analysis & Tool Selection Strategy:**
  1.  **Classify Intent:** What is the user's primary goal?
      *   FIND specific information based on content/keywords?
      *   RETRIEVE/LIST specific items based on time/metadata (e.g., 'latest', 'oldest', 'first 5', 'recent emails', 'uber receipts', 'contacts named X')?
      *   UNDERSTAND/SUMMARIZE content?
  2.  **Identify Data Source Hints:** Are there keywords suggesting a source (email, drive, calendar, slack, doc, sheet, meeting, user, contact, person, etc.)? If a service like "Uber" or "Lyft" is mentioned, consider if related documents (like receipts) might be in Gmail; if so, 'item_type' for metadata_retrieval should be 'email' and 'app' (if specified) should be 'gmail'.
  3.  **Check Log & State:** (Internal check: Did the previous step find the requested quantity? Was a single item validated? Did a tool return an 'Invalid app' error for a specific app name? If so, avoid that app name.)
      // --- REMOVED FAULTY INSTRUCTION ---
      // *   **Explicit Quantity Check:** If the User Query explicitly asked for a number N ... THEN the current action *must* be SYNTHESIZE_ANSWER.

  **Action Selection (Choose ONE):**

  IF Available Context Fragments is 0:
    THEN Action MUST BE: **Use a Tool** (Select from the 'Available Tools' list below and provide parameters as JSON).
  ELSE (Available Context Fragments > 0):
    Action 1: **Synthesize Answer** {'tool': 'SYNTHESIZE_ANSWER', 'parameters': {}}
       *   Choose ONLY if:
            *   Enough context exists to fully answer the query (considering intent, quantity, validation).
            *   Max iterations reached with some relevant context.
       *   Do NOT choose if:
            *   Found items < requested items (and not a single item request where validation failed).
            *   A 'limit: 1' attempt just failed validation (retry tool instead).

    Action 2: **Use a Tool** (If not synthesizing based on the conditions above)
       *   **Tool Prioritization based on Intent & Keywords:**
            *   If Intent is RETRIEVE/LIST (e.g., user asks for 'latest', 'oldest', 'recent', 'first', a specific count, or specific item types like 'receipts', 'contacts'): **Strongly prefer 'metadata_retrieval'.**
                *   Set 'item_type'. Examples:
                    *   For emails or messages, use 'email'.
                    *   If the query is about specific items typically found in email like **'receipts'** (e.g., "uber receipts", "flight confirmations") or **'confirmations'**:
                        *   YOU MUST set 'item_type: email'.
                        *   YOU MUST set 'app: gmail'.
                        *   YOU MUST use the specific keywords (e.g., "uber receipt", "flight confirmation") for the 'filter_query' parameter.
                    *   For calendar events or meetings, use 'event'.
                    *   For generic documents/files in Google Drive (when no specific kind like 'sheet' or 'pdf' is mentioned by the user), use 'item_type: document' or 'item_type: file', with 'app: googledrive', and omit the 'entity' parameter.
                    *   For specific kinds of documents:
                        *   If the query mentions 'sheets' or 'spreadsheets', use 'item_type: document', 'app: googledrive', and 'entity: spreadsheet'.
                        *   If the query mentions 'slides' or 'presentations', use 'item_type: document', 'app: googledrive', and 'entity: presentation'.
                        *   If the query mentions 'PDFs', use 'item_type: document' (or 'file'), 'app: googledrive', and 'entity: pdf'.
                    *   If unsure about the specific document kind but it is a file, 'file' can be a general fallback for 'item_type'.
                    *   **For users, people, or contacts (e.g., "contacts named Sarah", "find user John Doe", "who is Jane Doe"):**
                        *   **YOU MUST use 'item_type: contact' (or 'user', 'person').**
                        *   **YOU MUST use the name or other identifying information (e.g., "Sarah", "John Doe", "Jane Doe") for the 'filter_query' parameter.**
                        *   The 'app' parameter is optional. If omitted for 'item_type: contact', it defaults to searching personal contacts (which uses the 'owner' field implicitly). If the query implies a directory (e.g., "find user John Doe in the company directory"), consider setting 'app: googleworkspace'.
                *   **CRITICAL FOR ORDERING:** If the user\'s query contains words like \'recent\', \'latest\', \'newest\', or asks for a list that implies newest first (e.g., "my emails"), YOU MUST include \'order_direction\': \'desc\' in the parameters.
                *   **CRITICAL FOR ORDERING:** If the user\'s query contains words like \'oldest\', \'first\', \'earliest\', YOU MUST include \'order_direction\': \'asc\' in the parameters.
                *   Set 'limit' appropriately (e.g., user-specified count, or a default like 10).
                *   For other cases requiring "the 'filter_query' parameter" (that aren't specific email item types like receipts mentioned above), use 'filter_query' for specific keywords to narrow down the list (e.g., 'report Q3' for documents). If the query is general (e.g., "my recent emails") and does not have extra filtering keywords, do not add unrelated terms to the parameter named 'filter_query'.
            *   If Intent is FIND content & Data Source Hint suggests an *integrated* app (gmail, drive, calendar): Use 'filtered_search'. Set 'app' (MUST BE EXACTLY ONE OF 'gmail', 'googlecalendar', 'googledrive') and 'query'.
            *   If Intent is FIND content & query mentions a non-integrated service (e.g., "Uber") but implies data might be in an integrated one (e.g., "Uber receipt"): use 'filtered_search' with the integrated app (e.g., 'gmail') and 'query' for the service, OR use 'metadata_retrieval' with 'item_type: email', 'filter_query: "uber receipt"', and app 'gmail'.
            *   If Intent is FIND content & Time range is primary: Use 'time_search'.
            *   If Intent is FIND content & General keywords (or previous app-specific attempts failed because of an invalid app): Use 'search'.
            *   If Intent is UNDERSTAND/SUMMARIZE: Use search tools first to gather context.
       *   **Parameter Rules (Apply in order):**
            *   Explicit Quantity: If user asked for N items, use 'limit: N'.
            *   Single Most Recent/Oldest: Use 'limit: ${MOST_RECENT_CANDIDATE_COUNT}' (currently 3) and correct 'order_direction' (prefer 'metadata_retrieval' or 'search'/'filtered_search' with orderBy).
            *   Default Limit: Use 10 otherwise.
            *   Avoid Repetition: Do NOT repeat the exact same successful tool call; use 'offset' or different parameters/tool.
            *   App Parameter: For 'filtered_search' or 'metadata_retrieval', if an 'app' parameter is provided, it MUST BE EXACTLY ONE OF 'gmail', 'googlecalendar', 'googledrive', 'googleworkspace'. No other values are permitted. If a previous tool call failed with an "Invalid app" error for a certain app name, do not use that app name again. Remove the app name from 'query' if it's used in the 'app' parameter for 'filtered_search'.
            *   Pass 'excludedIds': If validation failed, include 'excludedIds' in search tool parameters.

  Available Tools:
  1. metadata_retrieval: Retrieves a *list* based *purely on metadata/time/type*. Ideal for 'latest'/'oldest'/count and typed items like 'receipts', 'contacts', or 'users'.
     Params: item_type (req: 'meeting', 'event', 'email', 'document', 'file', 'user', 'person', 'contact', 'attachment', 'mail_attachment'), app (opt: If provided, MUST BE EXACTLY ONE OF 'gmail', 'googlecalendar', 'googledrive', 'googleworkspace'; else inferred based on item_type), entity (opt: specific kind of item if item_type is 'document' or 'file', e.g., 'spreadsheet', 'pdf', 'presentation'), filter_query (opt keywords like 'uber receipt' or a name like 'John Doe'), limit (opt), offset (opt), order_direction (opt: 'asc'/'desc'), excludedIds (opt: string[]).
  2. search: Search *content* across all sources. Params: query (req keywords), limit (opt), excludedIds (opt: string[]).
  3. filtered_search: Search *content* within a specific app.
     Params: query (req keywords), app (req: MUST BE EXACTLY ONE OF 'gmail', 'googlecalendar', 'googledrive'), limit (opt), excludedIds (opt: string[]).
  4. time_search: Search *content* within a specific time range. Params: query (req keywords), from_days_ago (req), to_days_ago (req), limit (opt), excludedIds (opt: string[]).

  Respond ONLY with the JSON for the chosen action.
  `
            // ** Fix End **

            // Tool Selection LLM Call - Use the new dedicated function
            const iterator = generatePlannerActionJsonStream(
              // <-- Use the correct function
              planningPrompt, // <-- Use the existing variable name 'planningPrompt'
              {
                modelId: defaultFastModel, // Use a faster model for planning
                stream: true, // Enable streaming
                temperature: 0.0, // Low temp for deterministic JSON output
                reasoning: false, // Planner function doesn't use <think> tags
                json: true, // The planner function expects JSON output
              },
            )

            let planningBuffer = ""
            parsedToolSelection = null // Reset before parsing
            toolSelectionError = null // Reset error

            for await (const chunk of iterator) {
              if (chunk.text) {
                planningBuffer += chunk.text
                try {
                  // Attempt to parse the buffer *incrementally*
                  const potentialSelection = jsonParseLLMOutput(planningBuffer)
                  // Basic validation: check if it has a 'tool' key
                  if (
                    potentialSelection &&
                    typeof potentialSelection.tool === "string"
                  ) {
                    // More robust check: ensure it's either SYNTHESIZE or a known tool with parameters (or empty obj for SYNTHESIZE)
                    if (
                      potentialSelection.tool === "SYNTHESIZE_ANSWER" ||
                      (agentTools[potentialSelection.tool] &&
                        typeof potentialSelection.parameters === "object")
                    ) {
                      parsedToolSelection = potentialSelection
                      // Optional: break here if we are confident, but letting it finish might catch trailing garbage
                      // break;
                    }
                  }
                } catch (e) {
                  // Ignore parsing errors while streaming, wait for more data
                  if (!(e instanceof SyntaxError)) {
                    // Log non-SyntaxErrors potentially
                    Logger.debug(
                      "Non-syntax error during incremental tool parse",
                      e,
                    )
                  }
                }
              }
              if (chunk.cost) {
                /* handle cost if needed */
              }
            }

            // Final check after stream ends
            if (!parsedToolSelection) {
              try {
                // Try parsing the complete buffer one last time
                const finalSelection = jsonParseLLMOutput(planningBuffer)
                if (
                  finalSelection &&
                  typeof finalSelection.tool === "string" &&
                  (finalSelection.tool === "SYNTHESIZE_ANSWER" ||
                    (agentTools[finalSelection.tool] &&
                      typeof finalSelection.parameters === "object"))
                ) {
                  parsedToolSelection = finalSelection
                } else {
                  throw new Error(
                    `Final LLM response for tool selection was not a valid tool JSON. Response: ${planningBuffer}`,
                  )
                }
              } catch (finalError) {
                toolSelectionError =
                  finalError instanceof Error
                    ? finalError
                    : new Error(String(finalError))
              }
            }

            // Handle parsing failure
            if (toolSelectionError) {
              throw toolSelectionError // Throw the captured error
            }
            if (!parsedToolSelection) {
              // Should not happen if error handling is correct, but as a safeguard
              throw new Error(
                `LLM failed to provide any valid tool selection JSON after streaming. Final buffer: ${planningBuffer}`,
              )
            }

            // Check if LLM decided to synthesize the answer directly
            if (parsedToolSelection?.tool === "SYNTHESIZE_ANSWER") {
              await logAndStreamReasoning({
                type: AgentReasoningStepType.LogMessage,
                message:
                  "LLM determined enough information is available. Proceeding to synthesis.",
              })
              shouldSynthesize = true // Force synthesis for the check after this block
            } else if (
              !parsedToolSelection ||
              !parsedToolSelection.tool ||
              !agentTools[parsedToolSelection.tool] ||
              !parsedToolSelection.parameters
            ) {
              // If not synthesizing and the tool selection is invalid, throw error
              throw new Error(
                `LLM failed to provide valid tool selection JSON. Response: ${planningBuffer}`,
              )
            } else {
              // --- Start: Add Pre-execution Parameter Adjustment ---
              const queryKeywords = currentQuery.toLowerCase() // Use original user query
              const isMostRecent = /most recent|latest|newest|last/.test(
                queryKeywords,
              )
              const isOldest = /oldest|first|earliest/.test(queryKeywords)
              // Get a modifiable reference to the parameters
              const toolParams = parsedToolSelection.parameters
              // MOST_RECENT_CANDIDATE_COUNT is now defined at a higher scope

              // Inject excludedIds if available
              if (excludedIds.length > 0) {
                toolParams.excludedIds = excludedIds
                planSpan?.setAttribute(
                  "injected_excludedIds",
                  JSON.stringify(excludedIds),
                )
              }

              if (isMostRecent || isOldest) {
                const sortableTools = [
                  "search",
                  "filtered_search",
                  "time_search",
                  "metadata_retrieval",
                ]
                if (sortableTools.includes(parsedToolSelection.tool)) {
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.LogMessage,
                    message: `Adjusting parameters for '${isMostRecent ? "most recent" : "oldest"}' request...`,
                  })
                  planSpan?.setAttribute(
                    "detected_time_sort_intent",
                    isMostRecent ? "recent" : "oldest",
                  )

                  // --- MODIFICATION START ---
                  // Only set limit to 1 if the LLM hasn't already set a specific limit based on user request
                  // Check if limit is default (10), undefined, or explicitly 1 (in case LLM correctly chose 1)
                  if (
                    toolParams.limit === undefined ||
                    toolParams.limit === 10 ||
                    toolParams.limit === 1
                  ) {
                    toolParams.limit = 1
                    planSpan?.setAttribute("injected_limit", 1)
                  } else {
                    planSpan?.setAttribute(
                      "preserved_limit_from_llm",
                      toolParams.limit,
                    ) // Log that we kept the LLM's limit
                  }
                  // --- MODIFICATION END ---

                  // Set sorting
                  const direction = isMostRecent ? "desc" : "asc"
                  // Assuming 'timestamp' is the relevant field. Adjust if needed for different schemas.
                  // TODO: Make this dynamic based on item_type/schema if needed (e.g., 'startTime' for events)
                  let timestampField = "timestamp" // Default
                  if (
                    parsedToolSelection.tool === "metadata_retrieval" &&
                    toolParams.item_type
                  ) {
                    switch (toolParams.item_type.toLowerCase()) {
                      case "meeting":
                      case "event":
                        timestampField = "startTime"
                        break
                      case "document":
                      case "file":
                        timestampField = "updatedAt"
                        break // Or createdAt
                      // Default 'timestamp' covers email, message, notification
                    }
                  }
                  planSpan?.setAttribute(
                    "determined_timestamp_field",
                    timestampField,
                  )

                  if (parsedToolSelection.tool === "metadata_retrieval") {
                    toolParams.order_direction = direction
                    // Ensure filter_query is used if available, otherwise it might just sort all items
                    // (No change needed here, just a note)
                    // Ensure filter_query is used if available, otherwise it might just sort all items
                    // (No change needed here, just a note)
                  } else {
                    // For search, filtered_search, time_search
                    toolParams.orderBy = `${timestampField} ${direction}`
                    // Remove potentially conflicting rank profile if it exists
                    delete toolParams.rankProfile
                  }
                  planSpan?.setAttribute(
                    "injected_sorting",
                    `${timestampField} ${direction}`,
                  )
                  planSpan?.setAttribute("injected_limit", 1)
                  // Update the parameters in parsedToolSelection directly
                  parsedToolSelection.parameters = toolParams
                }
              }
              // --- End: Pre-execution Parameter Adjustment ---

              // Valid tool selected (not SYNTHESIZE_ANSWER)
              // Execution logic uses the potentially modified parsedToolSelection
              currentToolSelection = parsedToolSelection

              // Execute Tool
              const selectedTool = agentTools[currentToolSelection.tool]
              const parameters = currentToolSelection.parameters // Use the potentially modified parameters

              await logAndStreamReasoning({
                type: AgentReasoningStepType.LogMessage,
                message: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
              })
              await logAndStreamReasoning({
                type: AgentReasoningStepType.ToolSelected,
                toolName: currentToolSelection.tool as AgentToolName,
              })
              await logAndStreamReasoning({
                type: AgentReasoningStepType.ToolParameters,
                parameters: parameters,
              })
              await logAndStreamReasoning({
                type: AgentReasoningStepType.LogMessage,
                message: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
              })

              planSpan.setAttribute("selected_tool", currentToolSelection.tool)
              planSpan.setAttribute(
                "tool_parameters",
                JSON.stringify(parameters),
              )

              await logAndStreamReasoning({
                type: AgentReasoningStepType.ToolExecuting,
                toolName: currentToolSelection.tool as AgentToolName,
              })
              toolResult = await selectedTool.execute(parameters, planSpan)

              // Process Tool Result
              const itemsFoundCount = toolResult.contexts?.length || 0
              await logAndStreamReasoning({
                type: AgentReasoningStepType.ToolResult,
                toolName: currentToolSelection.tool as AgentToolName,
                resultSummary: toolResult.result,
                itemsFound: itemsFoundCount,
                error: toolResult.error,
              })

              if (toolResult.error) {
                agentLog.push(
                  // This agentLog is for the final `thinking` string, so keep it human-readable
                  `Tool execution error (${currentToolSelection.tool}): ${toolResult.error}`,
                )
                // The error is already logged via the structured step above
                planSpan.setAttribute("tool_error", toolResult.error)
              } else {
                agentLog.push(
                  // This agentLog is for the final `thinking` string
                  `Tool result (${currentToolSelection.tool}): Found ${itemsFoundCount} item(s). ${toolResult.result}`,
                )
                if (toolResult.contexts && toolResult.contexts.length > 0) {
                  const newFragments = toolResult.contexts
                  gatheredFragments.push(...newFragments)
                  allCitedFragments.push(...newFragments.map((f) => f.source))
                  await stream.writeSSE({
                    event: ChatSSEvents.CitationsUpdate,
                    data: JSON.stringify({
                      contextChunks: allCitedFragments,
                      citationMap: {},
                    }),
                  })
                  planSpan.setAttribute(
                    "new_fragments_count",
                    newFragments.length,
                  )
                } else {
                  planSpan.setAttribute("new_fragments_count", 0)
                  // If a tool ran successfully but found nothing, it might indicate the specific search failed.
                  // Consider incrementing failure counter here too? For now, only on validation failure.
                }
              }
              planSpan.setAttribute("tool_success", !toolResult.error)
            }
          } catch (err) {
            const errMsg = getErrorMessage(err)
            planSpan.setAttribute("error", errMsg)
            Logger.error(
              err,
              `Error during agent iteration ${iteration}: ${errMsg}`,
            )
            agentLog.push(`Planning/Execution error: ${errMsg}`) // Keep for finalReasoning
            await logAndStreamReasoning({
              type: AgentReasoningStepType.LogMessage, // Or a more specific error type if desired
              message: `Error in planning/execution: ${errMsg}`,
            })
            if (iteration === 1)
              loopError = `Failed initial search attempt: ${errMsg}`
            // Reset consecutive failures on planning/execution error
            consecutiveValidationFailures = 0
          } finally {
            planSpan.end()
          }

          // --- Synthesis Check ---
          const toolSuccessAttr = planSpan.attributes?.["tool_success"]
          const newFragmentsCountAttr =
            planSpan.attributes?.["new_fragments_count"]
          // Removed incorrect redeclaration: let excludedIds: string[] = [];

          // Re-evaluate synthesis conditions - simplified check after adding SYNTHESIZE_ANSWER tool option
          if (shouldSynthesize) {
            // Already decided to synthesize by the LLM signal
            consecutiveValidationFailures = 0 // Reset counter if synthesizing
          } else if (
            toolSuccessAttr === true &&
            newFragmentsCountAttr === 1 &&
            toolResult?.contexts?.length === 1
          ) {
            // --- Validate the single result ---
            const singleFragment = toolResult.contexts[0]
            await logAndStreamReasoning({
              type: AgentReasoningStepType.LogMessage,
              message: `Tool returned a single item: "${singleFragment.source.title || "Untitled"}". Validating relevance...`,
            })
            const validationSpan = iterSpan.startSpan("validate_single_result")
            const isGoodMatch = await validateSingleResultQuality(
              currentQuery,
              singleFragment,
              validationSpan,
            )
            validationSpan.end()

            if (isGoodMatch) {
              shouldSynthesize = true
              await logAndStreamReasoning({
                type: AgentReasoningStepType.LogMessage,
                message:
                  "Single result validation passed. Synthesizing answer.",
              })
              consecutiveValidationFailures = 0 // Reset counter on success
            } else {
              shouldSynthesize = false // Do not synthesize
              consecutiveValidationFailures++ // Increment failure counter
              await logAndStreamReasoning({
                type: AgentReasoningStepType.ValidationError,
                details: `Single result validation failed (POOR_MATCH #${consecutiveValidationFailures}). Will continue searching.`,
              })
              // Add the failed item's ID to excludedIds for future searches
              if (
                singleFragment.source.docId &&
                !excludedIds.includes(singleFragment.source.docId)
              ) {
                excludedIds.push(singleFragment.source.docId)
                planSpan.setAttribute(
                  "excluded_after_validation",
                  singleFragment.source.docId,
                ) // Log exclusion
              }
              // Remove the bad fragment from gatheredFragments so it's not used later if synthesis happens anyway
              gatheredFragments = gatheredFragments.filter(
                (f) => f.id !== singleFragment.id,
              )
              allCitedFragments = allCitedFragments.filter(
                (c) => c.docId !== singleFragment.source.docId,
              )
            }
            // --- End Validation ---
          } else if (
            toolSuccessAttr === true &&
            toolResult?.contexts &&
            toolResult.contexts.length > 1
          ) {
            // Check if the number of items found matches the requested limit
            const requestedLimit = currentToolSelection?.parameters?.limit

            if (
              currentToolSelection?.tool === "metadata_retrieval" &&
              requestedLimit &&
              typeof requestedLimit === "number" &&
              requestedLimit > 1
            ) {
              // Check if we found exactly the requested number of items or close to it
              const foundCount = toolResult.contexts.length
              if (foundCount >= requestedLimit) {
                shouldSynthesize = true
                await logAndStreamReasoning({
                  type: AgentReasoningStepType.LogMessage,
                  message: `Found ${foundCount} items, which satisfies the requested count of ${requestedLimit}. Synthesizing answer.`,
                })
                consecutiveValidationFailures = 0
              } else if (
                iteration > 1 &&
                gatheredFragments.length >= requestedLimit
              ) {
                // If we have enough items after multiple iterations
                shouldSynthesize = true
                await logAndStreamReasoning({
                  type: AgentReasoningStepType.LogMessage,
                  message: `Found total of ${gatheredFragments.length} items across searches, which satisfies the requested count of ${requestedLimit}. Synthesizing answer.`,
                })
                consecutiveValidationFailures = 0
              }
            } else if (
              currentToolSelection?.tool === "metadata_retrieval" && // TODO: use AgentToolName
              iteration > 1
            ) {
              // If this is a repeated metadata_retrieval call and we found multiple items, synthesize
              // to avoid repeating the same search over and over
              shouldSynthesize = true
              await logAndStreamReasoning({
                type: AgentReasoningStepType.LogMessage,
                message: `Multiple search results found and we've completed multiple iterations. Synthesizing answer.`,
              })
              consecutiveValidationFailures = 0
            }
          } else if (
            iteration === maxIterations &&
            gatheredFragments.length > 0
          ) {
            // Synthesize on last iteration if we have *any* fragments
            shouldSynthesize = true
            await logAndStreamReasoning({
              type: AgentReasoningStepType.LogMessage,
              message: "Max iterations reached. Attempting synthesis.",
            })
            consecutiveValidationFailures = 0 // Reset counter if synthesizing
          } else {
            // If tool ran successfully but didn't return 1 fragment, or if tool failed, reset counter
            consecutiveValidationFailures = 0
          }

          if (shouldSynthesize) {
            const synthSpan = iterSpan.startSpan("agent_synthesis")
            try {
              await logAndStreamReasoning({
                type: AgentReasoningStepType.Synthesis,
                details: `Synthesizing answer from ${gatheredFragments.length} fragments...`,
              })
              await stream.writeSSE({ event: ChatSSEvents.Start, data: "" })

              // Ensure context string is properly escaped for inclusion in the prompt template literal
              // ** Enhanced Synthesis Prompt **
              // This prompt attempts to tailor the LLM's synthesis task based on keywords
              // in the original user query (or rewritten query stored in currentQuery),
              // enabling basic analysis like summarization.
              // It aims to improve handling of:
              // - "Summarize X"
              // - "What are the key points of Y?"
              // - "Compare A and B" (using the retrieved contexts for A and B)
              const synthesisContext = cleanContext(
                gatheredFragments
                  .map(
                    (f, i) =>
                      `[${i + 1}] Source: ${f.source.title || "Unknown Source"} (${f.source.app})\nContent: ${f.content}`,
                  )
                  .join("\n\n"),
              )

              let specificInstruction = `Answer the user's query based *only* on the provided context fragments.`
              const lowerCaseQuery = currentQuery.toLowerCase() // Use currentQuery which might be the original or rewritten query
              if (
                lowerCaseQuery.includes("summarize") ||
                lowerCaseQuery.includes("summary")
              ) {
                specificInstruction = `**Summarize** the main points relevant to the user's query based *only* on the provided context fragments.`
              } else if (
                lowerCaseQuery.includes("key points") ||
                lowerCaseQuery.includes("main points") ||
                lowerCaseQuery.includes("highlights")
              ) {
                specificInstruction = `**Extract the key points, decisions, or action items** relevant to the user's query based *only* on the provided context fragments.`
              } else if (
                lowerCaseQuery.includes("compare") ||
                lowerCaseQuery.includes("contrast") ||
                lowerCaseQuery.includes("difference")
              ) {
                specificInstruction = `**Compare and contrast** the information relevant to the user's query based *only* on the provided context fragments.`
              }

              // Define the system prompt instructing the LLM on its task and output format
              const synthesisSystemPrompt = `You are a helpful AI assistant.
  User Query: "${currentQuery}"

  Instruction: ${specificInstruction}
  - Answer concisely and directly based *only* on the context.
  - If the context does not contain the answer, state that you couldn't find the information in the provided sources.
  - **Cite every piece of information** you use from the context using the format [index], where 'index' corresponds to the number in the context fragment list (e.g., [1], [2]).
  - Combine information from multiple sources if necessary.
  - Do not add any information not present in the context.
  - Respond with ONLY a JSON object containing a single key "answer" with the final synthesized response as its value.

  Context Fragments:
  ${synthesisContext}
  ` // Ensure backticks are correctly handled

              // Define the user query for the LLM, reinforcing the JSON format requirement
              // Use currentQuery here as well
              const synthesisUserQuery = `Generate the response for the query "${currentQuery}" using *only* the provided context fragments and citing sources. Format the output as JSON: {"answer": "Your synthesized answer here"}`

              // Synthesis LLM Call - explicitly requesting JSON output
              const llmIterator = baselineRAGJsonStream(
                synthesisUserQuery,
                synthesisSystemPrompt,
                "", // No initial context needed beyond the prompt itself
                {
                  modelId: defaultBestModel,
                  stream: true,
                  reasoning: false,
                  json: true,
                }, // Request JSON mode
              )

              // --- Updated Streaming Logic ---
              finalCitationMap = {} // Reset citation map
              let synthesisBuffer = ""
              let currentSynthesizedAnswer = "" // Stores the clean answer text extracted so far
              let parsedSynthesizedOutput = { answer: "" } // Stores the latest parsed object
              const SYNTHESIS_ANSWER_TOKEN = '"answer":' // Token to help parsing

              for await (const chunk of llmIterator) {
                if (chunk.text) {
                  synthesisBuffer += chunk.text
                  try {
                    // Attempt incremental parsing, looking for the answer token
                    parsedSynthesizedOutput = jsonParseLLMOutput(
                      synthesisBuffer,
                      SYNTHESIS_ANSWER_TOKEN,
                    ) || { answer: "" }

                    // Check if we have a new, valid answer string
                    if (
                      parsedSynthesizedOutput.answer &&
                      currentSynthesizedAnswer !==
                        parsedSynthesizedOutput.answer
                    ) {
                      const newText = parsedSynthesizedOutput.answer.slice(
                        currentSynthesizedAnswer.length,
                      )
                      if (newText) {
                        // Only stream if there's actually new text
                        await stream.writeSSE({
                          event: ChatSSEvents.ResponseUpdate,
                          data: newText,
                        })
                      }
                      currentSynthesizedAnswer = parsedSynthesizedOutput.answer // Update the complete answer text
                    }
                  } catch (parseErr) {
                    // Ignore partial JSON errors while streaming
                    if (!(parseErr instanceof SyntaxError)) {
                      Logger.debug(
                        "Non-syntax error during incremental synthesis parse",
                        { error: parseErr, buffer: synthesisBuffer },
                      )
                    }
                    // Continue accumulating chunks
                  }
                } // end if(chunk.text)
                // TODO: Handle cost if necessary
              } // End for await loop

              // --- Final Answer Processing ---
              // Use the incrementally built answer text
              let actualAnswerText = currentSynthesizedAnswer

              // Add a log if the final state doesn't seem right
              if (!actualAnswerText && synthesisBuffer) {
                Logger.warn(
                  "Synthesis stream finished, but no answer text was extracted despite receiving content.",
                  { finalBuffer: synthesisBuffer },
                )
                // Optionally, attempt one last parse of the full buffer if needed,
                // but relying on the incremental parse is generally preferred.
              }

              // --- Post-process citations on the actual answer text ---
              const citationRegex = /\[(\d+)\]/g
              let match
              finalCitationMap = {} // Reset citation map again just in case
              while ((match = citationRegex.exec(actualAnswerText)) !== null) {
                // Use actualAnswerText
                const citationIndex = parseInt(match[1], 10)
                if (
                  citationIndex > 0 &&
                  citationIndex <= allCitedFragments.length
                ) {
                  finalCitationMap[citationIndex] = citationIndex - 1
                }
              }

              // Check if answer is valid (use the extracted text)
              if (
                actualAnswerText &&
                !/couldn't find|don't know|not provided/i.test(actualAnswerText)
              ) {
                finalAnswer = actualAnswerText // Assign the *extracted* text
                await logAndStreamReasoning({
                  type: AgentReasoningStepType.LogMessage,
                  message: "Synthesis successful.",
                })
                synthSpan.setAttribute("success", true)
                synthSpan.setAttribute("answer_length", finalAnswer.length)
                synthSpan.setAttribute(
                  "citations_found",
                  Object.keys(finalCitationMap).length,
                )
              } else {
                await logAndStreamReasoning({
                  type: AgentReasoningStepType.LogMessage,
                  message:
                    "Synthesis did not produce a definitive answer from the context.",
                })
                synthSpan.setAttribute("success", false)
                synthSpan.setAttribute("reason", "Answer not found in context")
                // If synthesis failed after metadata success, maybe we should error out?
                if (toolSuccessAttr === true && newFragmentsCountAttr === 1) {
                  // Only error out if the *single validated* result failed synthesis
                  finalAnswer = "" // Clear any potentially bad answer
                  loopError =
                    "Relevant item found, but failed to synthesize a good answer from it."
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.LogMessage,
                    message: loopError,
                  })
                }
              }
            } catch (synthErr) {
              const errMsg = getErrorMessage(synthErr)
              synthSpan.setAttribute("error", errMsg)
              Logger.error(synthErr, `Error during agent synthesis: ${errMsg}`)
              await logAndStreamReasoning({
                type: AgentReasoningStepType.LogMessage,
                message: `Synthesis error: ${errMsg}`,
              })
              loopError = `Failed to synthesize answer: ${errMsg}`
            } finally {
              synthSpan.end()
            }
          } // end shouldSynthesize

          iterSpan.end()

          // Break loop if we have an answer or a fatal error
          if (finalAnswer || loopError) {
            break
          }
        } // End while loop

        // Handle loop completion without definitive answer
        if (!finalAnswer && !loopError) {
          loopError =
            gatheredFragments.length > 0
              ? "Could not synthesize a conclusive answer from the gathered information."
              : "Failed to find any relevant information after multiple attempts."
          await logAndStreamReasoning({
            type: AgentReasoningStepType.LogMessage,
            message: loopError,
          })
          await stream.writeSSE({ event: ChatSSEvents.Error, data: loopError })
        }

        // --- Finalization ---
        const finalizationSpan = streamSpan.startSpan("agent_finalization")
        if (finalAnswer && !loopError) {
          finalizationSpan.setAttribute("outcome", "success")
          finalizationSpan.setAttribute("answer_length", finalAnswer.length)
          finalizationSpan.setAttribute(
            "citations_count",
            Object.keys(finalCitationMap).length,
          )
          const processedDbMessage = processMessage(
            finalAnswer,
            finalCitationMap,
          ) // Ensure processMessage uses the map correctly

          try {
            const assistantMsg = await insertMessage(db, {
              chatId: chat!.id,
              userId: user.id,
              workspaceExternalId: workspace.externalId,
              chatExternalId: chat!.externalId,
              messageRole: MessageRole.Assistant,
              email: user.email,
              sources: allCitedFragments,
              message: processedDbMessage,
              thinking: JSON.stringify(structuredReasoningSteps), // Store structured steps as JSON string
              modelId: modelId || defaultBestModel,
              mode: MessageMode.Agentic, // Set mode for assistant message
            })
            assistantMessageExternalId = assistantMsg.externalId
            await stream.writeSSE({
              event: ChatSSEvents.ResponseMetadata,
              data: JSON.stringify({
                chatId: chat!.externalId,
                messageId: assistantMessageExternalId,
              }),
            })
            Logger.info("Agentic processing successful", {
              chatId: chat!.externalId,
              msgId: assistantMessageExternalId,
            })
          } catch (dbErr) {
            const errMsg = getErrorMessage(dbErr)
            Logger.error(
              dbErr,
              `Failed to save final agentic message: ${errMsg}`,
            )
            finalizationSpan.setAttribute("db_error", errMsg)
            await stream.writeSSE({
              event: ChatSSEvents.Error,
              data: "Failed to save the final response.",
            })
          }
        } else {
          // Handle error case
          const finalError = loopError || "An unknown error occurred."
          finalizationSpan.setAttribute("outcome", "error")
          finalizationSpan.setAttribute("error_message", finalError)

          const assistantMsg = await insertMessage(db, {
            chatId: chat!.id,
            userId: user.id,
            workspaceExternalId: workspace.externalId,
            chatExternalId: chat!.externalId,
            messageRole: MessageRole.Assistant,
            email: user.email,
            sources: [], // No citations needed for error
            message: `Error: ${finalError}`,
            thinking: JSON.stringify(structuredReasoningSteps), // Store structured steps as JSON string
            modelId: modelId || defaultBestModel,
            errorMessage: finalError,
            mode: MessageMode.Agentic, // Set mode for error assistant message
          })
          assistantMessageExternalId = assistantMsg.externalId

          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chat!.externalId,
              messageId: assistantMessageExternalId,
            }),
          })

          Logger.warn(
            `Agentic processing failed, thinking preserved: ${finalError}`,
          )
        }

        await stream.writeSSE({ data: "", event: ChatSSEvents.End })
        finalizationSpan.end()
      } catch (error) {
        // Outer Catch Block
        const streamErrorSpan = streamSpan.startSpan(
          "handle_agent_stream_error",
        )
        // ... (error handling logic same as before) ...
        const errorMessage = getErrorMessage(error)
        const mappedError = handleError(error)
        streamErrorSpan.addEvent("error", {
          message: errorMessage,
          stack: (error as Error).stack || "",
        })
        streamErrorSpan.setAttribute("error", errorMessage)
        Logger.error(error, `Agentic Stream Unhandled Error: ${errorMessage}`)
        try {
          // Show any reasoning we collected before the error
          if (agentLog.length > 0) {
            await stream.writeSSE({
              event: ChatSSEvents.Reasoning,
              data: `\n--- Agent reasoning before error ---\n${agentLog.join("\n")}\n---`,
            })
          }

          // Update UI with error
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chat!.externalId,
              messageId: userMessageExternalId || null,
            }),
          })

          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: mappedError,
          })

          // Add error to user message
          if (userMessageExternalId) {
            const userMsgError = await getMessageByExternalId(
              db,
              userMessageExternalId,
            )
            if (userMsgError) {
              await addErrMessageToMessage(userMsgError, mappedError)
            }
          }

          // End the stream
          await stream.writeSSE({ data: "", event: ChatSSEvents.End })
        } catch (e) {
          Logger.error(e, "Failed to stream error to client")
        }

        streamErrorSpan.end()
      } finally {
        streamSpan.end()
        rootSpan.end() // End the absolute root span
      }
    }) // End streamSSE
  } catch (error) {
    // Top Level Catch
    const topLevelErrorSpan = rootSpan.startSpan(
      "handle_agentic_top_level_error",
    )
    // ... (top-level error handling same as before) ...
    const errMsg = getErrorMessage(error)
    topLevelErrorSpan.addEvent("error", {
      message: errMsg,
      stack: (error as Error).stack || "",
    })
    topLevelErrorSpan.setAttribute("error", errMsg)
    Logger.error(error, `Top-Level MessageApi_Agentic Error: ${errMsg}`)
    if (userMessageExternalId) {
      try {
        const userMsgTopLevel = await getMessageByExternalId(
          db,
          userMessageExternalId,
        )
        if (userMsgTopLevel)
          await addErrMessageToMessage(userMsgTopLevel, handleError(error))
      } catch (e) {
        Logger.error(
          e,
          "Failed to add error to user message from top-level catch",
        )
      }
    }
    topLevelErrorSpan.end()
    // Re-throw appropriate errors
    if (error instanceof HTTPException) throw error
    if (error instanceof APIError && error.status === 429)
      throw new HTTPException(429, { message: handleError(error) })
    throw new HTTPException(500, {
      message:
        "Could not process agentic message due to an internal server error.",
    })
  }
}

// --- Minimal Agent State Type ---
interface MinimalAgentFragment {
  id: string // Unique ID for the fragment
  content: string
  source: Citation
  confidence: number
}
