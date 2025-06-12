import {
  answerContextMap,
  cleanContext,
  constructToolContext,
  userContext,
} from "@/ai/context"
import {
  // baselineRAGIterationJsonStream,
  baselineRAGJsonStream,
  generateSearchQueryOrAnswerFromConversation,
  generateTitleUsingQuery,
  jsonParseLLMOutput,
  mailPromptJsonStream,
  temporalPromptJsonStream,
  queryRewriter,
  generateAnswerBasedOnToolOutput,
  meetingPromptJsonStream,
  generateToolSelectionOutput,
  generateSynthesisBasedOnToolOutput,
} from "@/ai/provider"
import { getConnectorByExternalId, getConnectorByApp } from "@/db/connector"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import {
  Models,
  QueryType,
  type ConverseResponse,
  type QueryRouterLLMResponse,
  type QueryRouterResponse,
  type TemporalClassifier,
  type UserQuery,
} from "@/ai/types"
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
import { getToolsByConnectorId, syncConnectorTools } from "@/db/tool"
import {
  selectPublicChatSchema,
  selectPublicMessagesSchema,
  messageFeedbackEnum,
  type SelectChat,
  type SelectMessage,
  selectMessageSchema,
} from "@/db/schema"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getLogger } from "@/logger"
import {
  AgentReasoningStepType,
  AgentToolName,
  ChatSSEvents,
  ContextSysthesisState,
  OpenAIError,
  type AgentReasoningStep,
  type MessageReqType,
} from "@/shared/types"
import { MessageRole, Subsystem } from "@/types"
import {
  delay,
  getErrorMessage,
  getRelativeTime,
  interpretDateFromReturnedTemporalValue,
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
import type { chatSchema, MessageRetryReqType } from "@/api/search"
import { getTracer, type Span, type Tracer } from "@/tracer"
import {
  searchVespa,
  SearchModes,
  searchVespaInFiles,
  getItems,
  GetDocumentsByDocIds,
  getDocumentOrNull,
  searchVespaThroughAgent,
  searchVespaAgent,
} from "@/search/vespa"
import {
  Apps,
  CalendarEntity,
  chatMessageSchema,
  datasourceFileSchema,
  DriveEntity,
  entitySchema,
  eventSchema,
  fileSchema,
  GooglePeopleEntity,
  isValidApp,
  isValidEntity,
  mailAttachmentSchema,
  MailEntity,
  mailSchema,
  SystemEntity,
  userSchema,
  type Entity,
  type VespaChatMessage,
  type VespaEvent,
  type VespaEventSearch,
  type VespaFile,
  type VespaMail,
  type VespaMailAttachment,
  type VespaMailSearch,
  type VespaSchema,
  type VespaSearchResponse,
  type VespaSearchResult,
  type VespaSearchResults,
  type VespaSearchResultsSchema,
  type VespaUser,
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
import { entityToSchemaMapper } from "@/search/mappers"
import { getDocumentOrSpreadsheet } from "@/integrations/google/sync"
import type { S } from "ollama/dist/shared/ollama.6319775f.mjs"
import { isCuid } from "@paralleldrive/cuid2"
import { getAgentByExternalId, type SelectAgent } from "@/db/agent"
import { selectToolSchema, type SelectTool } from "@/db/schema/McpConnectors"
import { activeStreams } from "./stream"
import {
  ragPipelineConfig,
  RagPipelineStages,
  type MinimalAgentFragment,
} from "./types"
import {
  extractFileIdsFromMessage,
  flattenObject,
  handleError,
  isMessageWithContext,
  processMessage,
  searchToCitation,
} from "./utils"
export const textToCitationIndex = /\[(\d+)\]/g
import config from "@/config"
import {
  buildUserQuery,
  isContextSelected,
  UnderstandMessageAndAnswer,
  UnderstandMessageAndAnswerForGivenContext,
} from "./chat"
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
  maxValidLinks,
  maxUserRequestCount,
} = config
const Logger = getLogger(Subsystem.Chat)
const checkAndYieldCitationsForAgent = function* (
  textInput: string,
  yieldedCitations: Set<number>,
  results: MinimalAgentFragment[],
  baseIndex: number = 0,
) {
  const text = splitGroupedCitationsWithSpaces(textInput)
  let match
  while ((match = textToCitationIndex.exec(text)) !== null) {
    const citationIndex = parseInt(match[1], 10)
    console.log(citationIndex, "citations index")
    if (!yieldedCitations.has(citationIndex)) {
      const item = results[citationIndex - 1]
      if (item.source.docId) {
        yield {
          citation: {
            index: citationIndex,
            item: item.source,
          },
        }
        yieldedCitations.add(citationIndex)
      } else {
        Logger.error(
          "Found a citation index but could not find it in the search result ",
          citationIndex,
          results.length,
        )
      }
    }
  }
}

async function* getToolContinuationIterator(
  message: string,
  userCtx: string,
  toolsPrompt: string,
  toolOutput: string,
  results: MinimalAgentFragment[],
): AsyncIterableIterator<
  ConverseResponse & { citation?: { index: number; item: any } }
> {
  const continuationIterator = generateAnswerBasedOnToolOutput(
    message,
    userCtx,
    {
      modelId: ragPipelineConfig[RagPipelineStages.AnswerOrSearch].modelId,
      stream: true,
      json: true,
      reasoning: false,
    },
    toolsPrompt,
    toolOutput ?? "",
  )

  const previousResultsLength = 0 // todo fix this
  let buffer = ""
  let currentAnswer = ""
  let parsed = { answer: "" }
  let thinking = ""
  let reasoning = config.isReasoning
  let yieldedCitations = new Set<number>()
  const ANSWER_TOKEN = '"answer":'

  for await (const chunk of continuationIterator) {
    if (chunk.text) {
      // if (reasoning) {
      //   if (thinking && !chunk.text.includes(EndThinkingToken)) {
      //     thinking += chunk.text
      //     yield* checkAndYieldCitationsForAgent(
      //       thinking,
      //       yieldedCitations,
      //       results,
      //       previousResultsLength,
      //     )
      //     yield { text: chunk.text, reasoning }
      //   } else {
      //     // first time
      //     const startThinkingIndex = chunk.text.indexOf(StartThinkingToken)
      //     if (
      //       startThinkingIndex !== -1 &&
      //       chunk.text.trim().length > StartThinkingToken.length
      //     ) {
      //       let token = chunk.text.slice(
      //         startThinkingIndex + StartThinkingToken.length,
      //       )
      //       if (chunk.text.includes(EndThinkingToken)) {
      //         token = chunk.text.split(EndThinkingToken)[0]
      //         thinking += token
      //       } else {
      //         thinking += token
      //       }
      //       yield* checkAndYieldCitationsForAgent(
      //         thinking,
      //         yieldedCitations,
      //         results,
      //         previousResultsLength,
      //       )
      //       yield { text: token, reasoning }
      //     }
      //   }
      // }
      // if (reasoning && chunk.text.includes(EndThinkingToken)) {
      //   reasoning = false
      //   chunk.text = chunk.text.split(EndThinkingToken)[1].trim()
      // }
      // if (!reasoning) {
      buffer += chunk.text
      try {
        parsed = jsonParseLLMOutput(buffer, ANSWER_TOKEN)
        // If we have a null answer, break this inner loop and continue outer loop
        // seen some cases with just "}"
        if (parsed.answer === null || parsed.answer === "}") {
          break
        }

        // If we have an answer and it's different from what we've seen
        if (parsed.answer && currentAnswer !== parsed.answer) {
          if (currentAnswer === "") {
            // First valid answer - send the whole thing
            yield { text: parsed.answer }
          } else {
            // Subsequent chunks - send only the new part
            const newText = parsed.answer.slice(currentAnswer.length)
            yield { text: newText }
          }
          yield* checkAndYieldCitationsForAgent(
            parsed.answer,
            yieldedCitations,
            results,
            previousResultsLength,
          )
          currentAnswer = parsed.answer
        }
      } catch (e) {
        // If we can't parse the JSON yet, continue accumulating
        continue
      }
      // }
    }

    if (chunk.cost) {
      yield { cost: chunk.cost }
    }
  }
}
const addErrMessageToMessage = async (
  lastMessage: SelectMessage,
  errorMessage: string,
) => {
  if (lastMessage.messageRole === MessageRole.User) {
    await updateMessageByExternalId(db, lastMessage?.externalId, {
      errorMessage,
    })
  }
}
export const MessageWithToolsApi = async (c: Context) => {
  const tracer: Tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("MessageWithToolsApi")

  let stream: any
  let chat: SelectChat
  let assistantMessageId: string | null = null
  let streamKey: string | null = null

  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

    // @ts-ignore
    const body = c.req.valid("query")
    let {
      message,
      chatId,
      modelId,
      toolExternalIds,
      isReasoningEnabled,
    }: MessageReqType = body
    Logger.info(`getting mcp create with body: ${JSON.stringify(body)}`)
    // const userRequestsReasoning = isReasoningEnabled // Addressed: Will be used below
    const isMsgWithContext = isMessageWithContext(message)
    const extractedInfo = isMsgWithContext
      ? await extractFileIdsFromMessage(message)
      : {
          totalValidFileIdsFromLinkCount: 0,
          fileIds: [],
        }
    const fileIds = extractedInfo?.fileIds
    const totalValidFileIdsFromLinkCount =
      extractedInfo?.totalValidFileIdsFromLinkCount

    if (!message) {
      throw new HTTPException(400, {
        message: "Message is required",
      })
    }
    message = decodeURIComponent(message)
    rootSpan.setAttribute("message", message)

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const { user, workspace } = userAndWorkspace
    let messages: SelectMessage[] = []
    const costArr: number[] = []
    const ctx = userContext(userAndWorkspace)
    let chat: SelectChat

    const chatCreationSpan = rootSpan.startSpan("chat_creation")
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

    const convertReasoningStepToText = (step: AgentReasoningStep): string => {
      switch (step.type) {
        case AgentReasoningStepType.AnalyzingQuery:
          return step.details
        case AgentReasoningStepType.Iteration:
          return `### Iteration ${step.iteration} \n`
        case AgentReasoningStepType.Planning:
          return step.details + "\n" // e.g., "Planning next step..."
        case AgentReasoningStepType.ToolSelected:
          return `Tool selected: ${step.toolName} \n`
        case AgentReasoningStepType.ToolParameters:
          const params = Object.entries(step.parameters)
            .map(
              ([key, value]) =>
                `• ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
            )
            .join("\n")
          return `Parameters:\n${params} \n`
        case AgentReasoningStepType.ToolExecuting:
          return `Executing tool: ${step.toolName}...\n`
        case AgentReasoningStepType.ToolResult:
          let resultText = `Tool result (${step.toolName}): ${step.resultSummary}`
          if (step.itemsFound !== undefined) {
            resultText += ` (Found ${step.itemsFound} item(s))`
          }
          if (step.error) {
            resultText += `\nError: ${step.error}\n`
          }
          return resultText + "\n"
        case AgentReasoningStepType.Synthesis:
          return step.details + "\n" // e.g., "Synthesizing answer from X fragments..."
        case AgentReasoningStepType.ValidationError:
          return `Validation Error: ${step.details} \n`
        case AgentReasoningStepType.BroadeningSearch:
          return `Broadening Search: ${step.details}\n`
        case AgentReasoningStepType.LogMessage:
          return step.message + "\n"
        default:
          return "Unknown reasoning step"
      }
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
              alpha: 0.5,
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
              alpha: 0.5,
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
              alpha: 0.5,
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
        console.log(
          "[metadata_retrieval] Input Parameters:",
          JSON.stringify(params, null, 2) +
            " EXCLUDED_IDS: " +
            JSON.stringify(params.excludedIds),
        )
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
              console.error(
                "[metadata_retrieval] Invalid app parameter:",
                errorMsg,
              )
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
              console.error(
                "[metadata_retrieval] Unknown item_type:",
                unknownItemMsg,
              )
              return { result: unknownItemMsg, error: `Unknown item_type` }
          }
          console.log(
            `[metadata_retrieval] Derived from item_type '${params.item_type}': schema='${schema.toString()}', initial_entity='${entity ? entity.toString() : "null"}', timestampField='${timestampField}', inferred_appToUse='${appToUse ? appToUse.toString() : "null"}'`,
          )

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
          console.log(
            `[metadata_retrieval] Final determined values before Vespa call: appToUse='${appToUse ? appToUse.toString() : "null"}', schema='${schema.toString()}', finalEntity='${finalEntity ? finalEntity.toString() : "null"}'`,
          )

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
          console.log(
            `[metadata_retrieval] orderByString for Vespa (if applicable): '${orderByString}'`,
          )

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

          console.log(
            "[metadata_retrieval] Common Vespa searchOptions:",
            JSON.stringify(
              {
                limit: searchOptionsVespa.limit,
                offset: searchOptionsVespa.offset,
                excludedIds: searchOptionsVespa.excludedIds,
              },
              null,
              2,
            ),
          )

          if (params.filter_query) {
            const searchQuery = params.filter_query
            console.log(
              `[metadata_retrieval] Using searchVespa with filter_query: '${searchQuery}'`,
            )

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
              asc: params.order_direction === "asc",
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
    const userInfoTool: AgentTool = {
      name: "get_user_info",
      description:
        "Retrieves basic information about the current user and their environment, such as their name, email, company, current date, and time. Use this tool when the user's query directly asks for personal details (e.g., 'What is my name?', 'My email?', 'What time is it?', 'Who am I?') that can be answered from this predefined context.",
      parameters: {}, // No parameters needed from the LLM
      execute: async (_params: any, span?: Span) => {
        const execSpan = span?.startSpan("execute_get_user_info_tool")
        try {
          // userCtxObject is already available in the outer scope
          const userFragment: MinimalAgentFragment = {
            id: `user_info_context-${Date.now()}`,
            content: ctx, // The string generated by userContext()
            source: {
              docId: "user_info_context",
              title: "User and System Information", // Optional
              app: Apps.Xyne, // Use Apps.Xyne as per feedback
              url: "", // Optional
              entity: SystemEntity.UserProfile, // Use the new SystemEntity.UserProfile
            },
            confidence: 1.0,
          }
          execSpan?.setAttribute("user_context_retrieved", true)
          return {
            result:
              "User and system context information retrieved successfully.",
            contexts: [userFragment],
          }
        } catch (error) {
          const errMsg = getErrorMessage(error)
          execSpan?.setAttribute("error", errMsg)
          Logger.error(error, `Error in get_user_info tool: ${errMsg}`)
          return {
            result: `Error retrieving user context: ${errMsg}`,
            error: errMsg,
          }
        } finally {
          execSpan?.end()
        }
      },
    }

    const agentTools: Record<string, AgentTool> = {
      get_user_info: userInfoTool, // Add the new user info tool
      metadata_retrieval: metadataRetrievalTool,
      search: searchTool,
      filtered_search: filteredSearchTool,
      time_search: timeSearchTool,
    }

    let title = ""
    if (!chatId) {
      const titleSpan = chatCreationSpan.startSpan("generate_title")
      // let llm decide a title
      const titleResp = await generateTitleUsingQuery(message, {
        modelId: ragPipelineConfig[RagPipelineStages.NewChatTitle].modelId,
        stream: false,
      })
      title = titleResp.title
      const cost = titleResp.cost
      if (cost) {
        costArr.push(cost)
        titleSpan.setAttribute("cost", cost)
      }
      titleSpan.setAttribute("title", title)
      titleSpan.end()

      let [insertedChat, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage]> => {
          const chat = await insertChat(tx, {
            workspaceId: workspace.id,
            workspaceExternalId: workspace.externalId,
            userId: user.id,
            email: user.email,
            title,
            attachments: [],
          })

          const insertedMsg = await insertMessage(tx, {
            chatId: chat.id,
            userId: user.id,
            chatExternalId: chat.externalId,
            workspaceExternalId: workspace.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: [],
            message,
            modelId,
            fileIds: fileIds,
          })
          return [chat, insertedMsg]
        },
      )
      Logger.info(
        "First mesage of the conversation, successfully created the chat",
      )
      chat = insertedChat
      messages.push(insertedMsg) // Add the inserted message to messages array
      chatCreationSpan.end()
    } else {
      let [existingChat, allMessages, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage[], SelectMessage]> => {
          // we are updating the chat and getting it's value in one call itself

          let existingChat = await updateChatByExternalId(db, chatId, {})
          let allMessages = await getChatMessages(tx, chatId)

          let insertedMsg = await insertMessage(tx, {
            chatId: existingChat.id,
            userId: user.id,
            workspaceExternalId: workspace.externalId,
            chatExternalId: existingChat.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: [],
            message,
            modelId,
            fileIds,
          })
          return [existingChat, allMessages, insertedMsg]
        },
      )
      Logger.info("Existing conversation, fetched previous messages")
      messages = allMessages.concat(insertedMsg) // Update messages array
      chat = existingChat
      chatCreationSpan.end()
    }
    return streamSSE(
      c,
      async (stream) => {
        let finalReasoningLogString = ""
        let agentLog: string[] = [] // For building the prompt context
        let structuredReasoningSteps: AgentReasoningStep[] = [] // For structured reasoning steps
        const logAndStreamReasoning = async (
          reasoningStep: AgentReasoningStep,
        ) => {
          const humanReadableLog = convertReasoningStepToText(reasoningStep)
          agentLog.push(humanReadableLog)
          structuredReasoningSteps.push(reasoningStep)
          await stream.writeSSE({
            event: ChatSSEvents.Reasoning,
            data: convertReasoningStepToText(reasoningStep),
          })
        }

        streamKey = `${chat.externalId}` // Create the stream key
        activeStreams.set(streamKey, stream) // Add stream to the map
        Logger.info(`Added stream ${streamKey} to active streams map.`)
        const streamSpan = rootSpan.startSpan("stream_response")
        streamSpan.setAttribute("chatId", chat.externalId)
        let wasStreamClosedPrematurely = false
        try {
          if (!chatId) {
            const titleUpdateSpan = streamSpan.startSpan("send_title_update")
            await stream.writeSSE({
              data: title,
              event: ChatSSEvents.ChatTitleUpdate,
            })
            titleUpdateSpan.end()
          }

          Logger.info("Chat stream started")
          // we do not set the message Id as we don't have it
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chat.externalId,
            }),
          })

          let messagesWithNoErrResponse = messages
            .slice(0, messages.length - 1)
            .filter((msg) => !msg?.errorMessage)
            .map((m) => ({
              role: m.messageRole as ConversationRole,
              content: [{ text: m.message }],
            }))

          console.log(messagesWithNoErrResponse)
          Logger.info(
            "Checking if answer is in the conversation or a mandatory query rewrite is needed before RAG",
          )
          const finalToolsList: Record<
            string,
            {
              tools: SelectTool[]
              client: Client
            }
          > = {}
          const maxIterations = 10
          let iterationCount = 0
          let answered = false

          await logAndStreamReasoning({
            type: AgentReasoningStepType.LogMessage,
            message: `Analyzing your query...`,
          })
          // once we start getting toolsList will remove the above code
          if (toolExternalIds && toolExternalIds.length > 0) {
            // Fetch connector info and create client
            const connector = await getConnectorByApp(
              db,
              user.id,
              Apps.GITHUB_MCP,
            )

            const config = connector.config as any
            const client = new Client({
              name: `connector-${connector.id}`,
              version: config.version,
            })
            await client.connect(
              new StdioClientTransport({
                command: config.command,
                args: config.args,
              }),
            )

            // Fetch all available tools from the client
            // TODO: look in the DB. cache logic has to be discussed.

            const tools = await getToolsByConnectorId(
              db,
              workspace.id,
              connector.id,
            )
            // Filter to only the requested tools, or use all tools if toolNames is empty
            const filteredTools = tools.filter((tool) => {
              const isIncluded = toolExternalIds.includes(tool.externalId!)
              if (!isIncluded) {
                Logger.info(
                  `[MessageWithToolsApi] Tool ${tool.externalId}:${tool.toolName} not in requested toolExternalIds.`,
                )
              }
              return isIncluded
            })

            finalToolsList[connector.id] = {
              tools: filteredTools,
              client: client,
            }
            // Update tool definitions in the database for future use
            // await syncConnectorTools(
            //   db,
            //   workspace.id,
            //   connector.id,
            //   filteredTools.map((tool) => ({
            //     toolName: tool.tool_name,
            //     toolSchema: JSON.stringify(tool),
            //     description: tool.description ?? "",
            //   })),
            // )
          }
          let answer = ""
          let currentAnswer = ""
          let citations = []
          let citationMap: Record<number, number> = {}
          let citationValues: Record<number, string> = {}
          let thinking = ""
          let reasoning =
            ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning
          let gatheredFragments: MinimalAgentFragment[] = []
          let excludedIds: string[] = [] // To track IDs of retrieved documents
          let agentScratchpad = "" // To build the reasoning history for the prompt
          const previousToolCalls: { tool: string; args: string }[] = []
          while (iterationCount <= maxIterations && !answered) {
            if (stream.closed) {
              Logger.info(
                "[MessageApi] Stream closed during conversation search loop. Breaking.",
              )
              wasStreamClosedPrematurely = true
              break
            }
            let buffer = ""
            let parsed = {
              answer: "",
              tool: "",
              arguments: {} as any,
            }
            iterationCount++

            let loopWarningPrompt = ""
            const reasoningHeader = `
            --- AGENT REASONING SO FAR ---
            Below is the step-by-step reasoning you've taken so far. Use this to inform your next action.
            ${structuredReasoningSteps
              .map(convertReasoningStepToText)
              .join("\n")}
            `
            const evidenceSummary =
              gatheredFragments.length > 0
                ? `\n--- CURRENTLY GATHERED EVIDENCE (for final answer generation) ---\n` +
                  gatheredFragments
                    .map(
                      (f, i) =>
                        `[Fragment ${i + 1}] (Source Doc ID: ${f.source.docId})\n` +
                        `  - Title: ${f.source.title || "Untitled"}\n` +
                        // Truncate content in the scratchpad to keep the prompt concise.
                        // The full content is available in `planningContext` for the final answer.
                        `  - Content Snippet: "${f.content}"`,
                    )
                    .join("\n\n")
                : "\n--- NO EVIDENCE GATHERED YET ---"

            if (previousToolCalls.length) {
              loopWarningPrompt = `
                   ---
                   **Critique Past Actions:** You have already called some tools ${previousToolCalls.map((toolCall, idx) => `[Iteration-${idx}] Tool: ${toolCall.tool}, Args: ${JSON.stringify(toolCall.args)}`).join("\n")}  and the result was insufficient. You are in a loop. You MUST choose a appropriate tool to resolve user query.
                 You **MUST** change your strategy.
                  For example: 
                    1.  Choose a **DIFFERENT TOOL**.
                    2.  Use the **SAME TOOL** but with **DIFFERENT ARGUMENTS**.
  
                  Do NOT make this call again. Formulate a new, distinct plan.
                   ---
                `
            }

            agentScratchpad =
              evidenceSummary + loopWarningPrompt + reasoningHeader

            let toolsPrompt = ""
            // TODO: make more sense to move this inside prompt such that format of output can be written together.
            if (Object.keys(finalToolsList).length > 0) {
              toolsPrompt = `While answering check if any below given AVAILABLE_TOOLS can be invoked to get more context to answer the user query more accurately, this is very IMPORTANT so you should check this properly based on the given tools information. 
                AVAILABLE_TOOLS:\n\n`

              // Format each client's tools
              for (const [connectorId, { tools }] of Object.entries(
                finalToolsList,
              )) {
                if (tools.length > 0) {
                  for (const tool of tools) {
                    const parsedTool = selectToolSchema.safeParse(tool)
                    if (parsedTool.success && parsedTool.data.toolSchema) {
                      toolsPrompt += `${constructToolContext(parsedTool.data.toolSchema)}\n\n`
                    }
                  }
                }
              }
            }

            const getToolOrAnswerIterator = generateToolSelectionOutput(
              message,
              ctx,
              toolsPrompt,
              agentScratchpad,
              {
                modelId: defaultBestModel,
                stream: true,
                json: true,
                reasoning:
                  ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning,
                messages: messagesWithNoErrResponse,
              },
            )
            for await (const chunk of getToolOrAnswerIterator) {
              if (stream.closed) {
                Logger.info(
                  "[MessageApi] Stream closed during conversation search loop. Breaking.",
                )
                wasStreamClosedPrematurely = true
                break
              }

              if (chunk.text) {
                if (reasoning) {
                  if (thinking && !chunk.text.includes(EndThinkingToken)) {
                    thinking += chunk.text
                    stream.writeSSE({
                      event: ChatSSEvents.Reasoning,
                      data: chunk.text,
                    })
                  } else {
                    // first time
                    if (!chunk.text.includes(StartThinkingToken)) {
                      let token = chunk.text
                      if (chunk.text.includes(EndThinkingToken)) {
                        token = chunk.text.split(EndThinkingToken)[0]
                        thinking += token
                      } else {
                        thinking += token
                      }
                      stream.writeSSE({
                        event: ChatSSEvents.Reasoning,
                        data: token,
                      })
                    }
                  }
                }
                if (reasoning && chunk.text.includes(EndThinkingToken)) {
                  reasoning = false
                  chunk.text = chunk.text.split(EndThinkingToken)[1].trim()
                }
                if (!reasoning) {
                  buffer += chunk.text
                  try {
                    parsed = jsonParseLLMOutput(buffer) || {}
                    if (parsed.answer && currentAnswer !== parsed.answer) {
                      if (currentAnswer === "") {
                        Logger.info(
                          "We were able to find the answer/respond to users query in the conversation itself so not applying RAG",
                        )
                        stream.writeSSE({
                          event: ChatSSEvents.Start,
                          data: "",
                        })
                        // First valid answer - send the whole thing
                        stream.writeSSE({
                          event: ChatSSEvents.ResponseUpdate,
                          data: parsed.answer,
                        })
                      } else {
                        // Subsequent chunks - send only the new part
                        const newText = parsed.answer.slice(
                          currentAnswer.length,
                        )
                        stream.writeSSE({
                          event: ChatSSEvents.ResponseUpdate,
                          data: newText,
                        })
                      }
                      currentAnswer = parsed.answer
                    }
                  } catch (err) {
                    const errMessage = (err as Error).message
                    Logger.error(
                      err,
                      `Error while parsing LLM output ${errMessage}`,
                    )
                    continue
                  }
                }
              }
              if (chunk.cost) {
                costArr.push(chunk.cost)
              }
            }

            if (parsed.tool && !parsed.answer) {
              await logAndStreamReasoning({
                type: AgentReasoningStepType.Iteration,
                iteration: iterationCount,
              })
              await logAndStreamReasoning({
                type: AgentReasoningStepType.Planning,
                details: `Planning next step with ${gatheredFragments.length} context fragments.`,
              })
              const toolName = parsed.tool
              const toolParams = parsed.arguments
              previousToolCalls.push({
                tool: toolName,
                args: toolParams,
              })
              Logger.info(
                `Tool selection #${toolName} with params: ${JSON.stringify(
                  toolParams,
                )}`,
              )

              let toolExecutionResponse: {
                result: string
                contexts?: MinimalAgentFragment[]
                error?: string
              } | null = null

              const toolExecutionSpan = streamSpan.startSpan(
                `execute_tool_${toolName}`,
              )

              if (agentTools[toolName]) {
                if (excludedIds.length > 0) {
                  toolParams.excludedIds = excludedIds
                }
                if ("limit" in toolParams) {
                  if (
                    toolParams.limit &&
                    toolParams.limit > maxUserRequestCount
                  ) {
                    await logAndStreamReasoning({
                      type: AgentReasoningStepType.LogMessage,
                      message: `Detected perPage ${toolParams.perPage} in arguments for tool ${toolName}`,
                    })
                    toolParams.limit = maxUserRequestCount
                    await logAndStreamReasoning({
                      type: AgentReasoningStepType.LogMessage,
                      message: `Limited perPage for tool ${toolName} to 10`,
                    })
                  }
                }

                await logAndStreamReasoning({
                  type: AgentReasoningStepType.ToolExecuting,
                  toolName: toolName as AgentToolName,
                })

                try {
                  toolExecutionResponse = await agentTools[toolName].execute(
                    toolParams,
                    toolExecutionSpan,
                  )
                } catch (error) {
                  const errMessage = getErrorMessage(error)
                  Logger.error(
                    error,
                    `Critical error executing internal agent tool ${toolName}: ${errMessage}`,
                  )
                  toolExecutionResponse = {
                    result: `Execution of tool ${toolName} failed critically.`,
                    error: errMessage,
                  }
                }
              } else {
                let foundClient: Client | null = null
                let connectorId: string | null = null

                // Find the client for the requested tool (your logic is good)
                for (const [connId, { tools, client }] of Object.entries(
                  finalToolsList,
                )) {
                  if (
                    tools.some(
                      (tool) =>
                        selectToolSchema.safeParse(tool).success &&
                        selectToolSchema.safeParse(tool).data?.toolName ===
                          toolName,
                    )
                  ) {
                    foundClient = client
                    connectorId = connId
                    break
                  }
                }

                if (!foundClient || !connectorId) {
                  const errorMsg = `Tool "${toolName}" was selected by the agent but is not an available tool.`
                  Logger.error(errorMsg)
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.ValidationError,
                    details: errorMsg,
                  })
                  // Set an error response so the agent knows its plan failed and can re-plan
                  toolExecutionResponse = {
                    result: `Error: Could not find the specified tool '${toolName}'.`,
                    error: "Tool not found",
                  }
                } else {
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.ToolExecuting,
                    toolName: toolName as AgentToolName, // We can cast here as it's a string from the LLM
                  })
                  try {
                    // TODO: Implement your parameter validation logic here before calling the tool.
                    if ("perPage" in toolParams) {
                      if (toolParams.perPage && toolParams.perPage > 10) {
                        await logAndStreamReasoning({
                          type: AgentReasoningStepType.LogMessage,
                          message: `Detected perPage ${toolParams.perPage} in arguments for tool ${toolName}`,
                        })
                        toolParams.perPage = 10 // Limit to 10 per page
                        await logAndStreamReasoning({
                          type: AgentReasoningStepType.LogMessage,
                          message: `Limited perPage for tool ${toolName} to 10`,
                        })
                      }
                    }
                    const mcpToolResponse: any = await foundClient.callTool({
                      name: toolName,
                      arguments: toolParams,
                    })

                    // --- Process and Normalize the MCP Response ---
                    let formattedContent = "Tool returned no parsable content."
                    let newFragments: MinimalAgentFragment[] = []

                    // Safely parse the response text
                    try {
                      if (
                        mcpToolResponse.content &&
                        mcpToolResponse.content[0] &&
                        mcpToolResponse.content[0].text
                      ) {
                        const parsedJson = JSON.parse(
                          mcpToolResponse.content[0].text,
                        )
                        formattedContent = flattenObject(parsedJson)
                          .map(([key, value]) => `- ${key}: ${value}`)
                          .join("\n")

                        // Convert the formatted response into a standard MinimalAgentFragment
                        const fragmentId = `mcp-${connectorId}-${toolName}}`
                        newFragments.push({
                          id: fragmentId,
                          content: formattedContent,
                          source: {
                            app: Apps.GITHUB_MCP, // Or derive dynamically if possible
                            docId: "", // Use a unique ID for the doc
                            title: `Output from tool: ${toolName}`,
                            entity: SystemEntity.SystemInfo,
                          },
                          confidence: 1.0,
                        })
                      }
                    } catch (parsingError) {
                      Logger.error(
                        parsingError,
                        `Could not parse response from MCP tool ${toolName} as JSON.`,
                      )
                      formattedContent =
                        "Tool response was not valid JSON and could not be processed."
                    }

                    // Populate the unified response object for the MCP tool
                    toolExecutionResponse = {
                      result: `Tool ${toolName} executed. \n Summary: ${formattedContent.substring(0, 200)}...`,
                      contexts: newFragments,
                    }
                  } catch (error) {
                    const errMessage = getErrorMessage(error)
                    Logger.error(
                      error,
                      `Error invoking external tool ${toolName}: ${errMessage}`,
                    )
                    // Populate the unified response with the error
                    toolExecutionResponse = {
                      result: `Execution of tool ${toolName} failed.`,
                      error: errMessage,
                    }
                  }
                }
              }
              toolExecutionSpan.end()

              await logAndStreamReasoning({
                type: AgentReasoningStepType.ToolResult,
                toolName: toolName as AgentToolName,
                resultSummary: toolExecutionResponse.result,
                itemsFound: toolExecutionResponse.contexts?.length || 0,
                error: toolExecutionResponse.error,
              })

              if (toolExecutionResponse.error) {
                if (iterationCount < maxIterations) {
                  continue // Continue to the next iteration to re-plan
                } else {
                  // If we fail on the last iteration, we have to stop.
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.LogMessage,
                    message:
                      "Tool failed on the final iteration. Generating answer with available context.",
                  })
                }
              }

              if (
                toolExecutionResponse.contexts &&
                toolExecutionResponse.contexts.length > 0
              ) {
                const newFragments = toolExecutionResponse.contexts
                gatheredFragments.push(...newFragments)

                const newIds = newFragments.map((f) => f.id).filter(Boolean) // Use the fragment's own unique ID
                excludedIds = [...new Set([...excludedIds, ...newIds])]
              }

              const planningContext = gatheredFragments.length
                ? gatheredFragments
                    .map(
                      (f, i) =>
                        `[${i + 1}] ${f.source.title || `Source ${f.source.docId}`}: ${
                          f.content
                        }...`,
                    )
                    .join("\n")
                : ""

              if (planningContext.length) {
                type SynthesisResponse = {
                  synthesisState:
                    | ContextSysthesisState.Complete
                    | ContextSysthesisState.Partial
                    | ContextSysthesisState.NotFound
                  answer: string | null
                }
                let parseSynthesisOutput: SynthesisResponse | null = null

                try {
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.Synthesis,
                    details: `Synthesizing answer from ${gatheredFragments.length} fragments...`,
                  })

                  const synthesisResponse =
                    await generateSynthesisBasedOnToolOutput(
                      ctx,
                      message,
                      planningContext,
                      {
                        modelId: defaultBestModel,
                        stream: false,
                        json: true,
                        reasoning: false,
                      },
                    )

                  if (synthesisResponse.text) {
                    try {
                      parseSynthesisOutput = jsonParseLLMOutput(
                        synthesisResponse.text,
                      )
                      if (
                        !parseSynthesisOutput ||
                        !parseSynthesisOutput.synthesisState
                      ) {
                        Logger.error(
                          "Synthesis response was valid JSON but missing 'synthesisState' key.",
                        )
                        // Default to partial to force another iteration, which is safer
                        parseSynthesisOutput = {
                          synthesisState: ContextSysthesisState.Partial,
                          answer: null,
                        }
                      }
                    } catch (jsonError) {
                      Logger.error(
                        jsonError,
                        "Failed to parse synthesis LLM output as JSON.",
                      )
                      // If parsing fails, we cannot trust the context. Treat it as notFound to be safe.
                      parseSynthesisOutput = {
                        synthesisState: ContextSysthesisState.NotFound,
                        answer: parseSynthesisOutput?.answer || "",
                      }
                    }
                  } else {
                    Logger.error("Synthesis LLM call returned no text.")
                    parseSynthesisOutput = {
                      synthesisState: ContextSysthesisState.Partial,
                      answer: "",
                    }
                  }
                } catch (synthesisError) {
                  Logger.error(
                    synthesisError,
                    "Error during synthesis LLM call.",
                  )
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.LogMessage,
                    message: `Synthesis failed: No relevant information found. Attempting to gather more data.`,
                  })
                  // If the call itself fails, we must assume the context is insufficient.
                  parseSynthesisOutput = {
                    synthesisState: ContextSysthesisState.Partial,
                    answer: parseSynthesisOutput?.answer || "",
                  }
                }

                await logAndStreamReasoning({
                  type: AgentReasoningStepType.LogMessage,
                  message: `Synthesis result: ${parseSynthesisOutput.synthesisState}`,
                })
                await logAndStreamReasoning({
                  type: AgentReasoningStepType.LogMessage,
                  message: ` Synthesis: ${parseSynthesisOutput.answer || "No Synthesis details"}`,
                })
                const isContextSufficient =
                  parseSynthesisOutput.synthesisState ===
                  ContextSysthesisState.Complete

                if (isContextSufficient) {
                  // Context is complete. We can break the loop and generate the final answer.
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.LogMessage,
                    message:
                      "Context is sufficient. Proceeding to generate final answer.",
                  })
                  // The `continuationIterator` logic will now run after the loop breaks.
                } else {
                  // Context is Partial or NotFound. The loop will continue.
                  if (iterationCount < maxIterations) {
                    await logAndStreamReasoning({
                      type: AgentReasoningStepType.BroadeningSearch,
                      details: `Context is insufficient. Planning iteration ${iterationCount + 1}.`,
                    })
                    continue
                  } else {
                    // We've hit the max iterations with insufficient context
                    await logAndStreamReasoning({
                      type: AgentReasoningStepType.LogMessage,
                      message:
                        "Max iterations reached with partial context. Will generate best-effort answer.",
                    })
                  }
                }
              } else {
                // This `else` block runs if `planningContext` is empty after a tool call.
                // This means we have found nothing so far. We must continue.
                if (iterationCount < maxIterations) {
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.BroadeningSearch,
                    details: "No context found yet. Planning next iteration.",
                  })
                  continue
                }
              }

              answered = true
              const continuationIterator = getToolContinuationIterator(
                message,
                ctx,
                toolsPrompt,
                planningContext ?? "",
                gatheredFragments,
              )
              for await (const chunk of continuationIterator) {
                if (stream.closed) {
                  Logger.info(
                    "[MessageApi] Stream closed during conversation search loop. Breaking.",
                  )
                  wasStreamClosedPrematurely = true
                  break
                }
                if (chunk.text) {
                  // if (reasoning && chunk.reasoning) {
                  //   thinking += chunk.text
                  //   stream.writeSSE({
                  //     event: ChatSSEvents.Reasoning,
                  //     data: chunk.text,
                  //   })
                  //   // reasoningSpan.end()
                  // }
                  // if (!chunk.reasoning) {
                  //   answer += chunk.text
                  //   stream.writeSSE({
                  //     event: ChatSSEvents.ResponseUpdate,
                  //     data: chunk.text,
                  //   })
                  // }
                  answer += chunk.text
                  stream.writeSSE({
                    event: ChatSSEvents.ResponseUpdate,
                    data: chunk.text,
                  })
                }
                if (chunk.citation) {
                  const { index, item } = chunk.citation
                  citations.push(item)
                  citationMap[index] = citations.length - 1
                  Logger.info(
                    `Found citations and sending it, current count: ${citations.length}`,
                  )
                  stream.writeSSE({
                    event: ChatSSEvents.CitationsUpdate,
                    data: JSON.stringify({
                      contextChunks: citations,
                      citationMap,
                    }),
                  })
                  citationValues[index] = item
                }
                if (chunk.cost) {
                  costArr.push(chunk.cost)
                }
              }
              if (answer.length) {
                break
              }
            } else if (parsed.answer) {
              answer = parsed.answer
              break
            }
          }

          if (answer || wasStreamClosedPrematurely) {
            // Determine if a message (even partial) should be saved
            // TODO: incase user loses permission
            // to one of the citations what do we do?
            // somehow hide that citation and change
            // the answer to reflect that
            const reasoningLog = structuredReasoningSteps
              .map(convertReasoningStepToText)
              .join("\n")

            const msg = await insertMessage(db, {
              chatId: chat.id,
              userId: user.id,
              workspaceExternalId: workspace.externalId,
              chatExternalId: chat.externalId,
              messageRole: MessageRole.Assistant,
              email: user.email,
              sources: citations,
              message: processMessage(answer, citationMap),
              thinking: reasoningLog,
              modelId:
                ragPipelineConfig[RagPipelineStages.AnswerOrRewrite].modelId,
            })
            assistantMessageId = msg.externalId

            const traceJson = tracer.serializeToJson()
            await insertChatTrace({
              workspaceId: workspace.id,
              userId: user.id,
              chatId: chat.id,
              messageId: msg.id,
              chatExternalId: chat.externalId,
              email: user.email,
              messageExternalId: msg.externalId,
              traceJson,
            })
            Logger.info(
              `[MessageApi] Inserted trace for message ${msg.externalId} (premature: ${wasStreamClosedPrematurely}).`,
            )

            await stream.writeSSE({
              event: ChatSSEvents.ResponseMetadata,
              data: JSON.stringify({
                chatId: chat.externalId,
                messageId: assistantMessageId,
              }),
            })
          } else {
            const errorSpan = streamSpan.startSpan("handle_no_answer")
            const allMessages = await getChatMessages(db, chat?.externalId)
            const lastMessage = allMessages[allMessages.length - 1]

            await stream.writeSSE({
              event: ChatSSEvents.ResponseMetadata,
              data: JSON.stringify({
                chatId: chat.externalId,
                messageId: lastMessage.externalId,
              }),
            })
            await stream.writeSSE({
              event: ChatSSEvents.Error,
              data: "Oops, something went wrong. Please try rephrasing your question or ask something else.",
            })
            await addErrMessageToMessage(
              lastMessage,
              "Oops, something went wrong. Please try rephrasing your question or ask something else.",
            )

            const traceJson = tracer.serializeToJson()
            await insertChatTrace({
              workspaceId: workspace.id,
              userId: user.id,
              chatId: chat.id,
              messageId: lastMessage.id,
              chatExternalId: chat.externalId,
              email: user.email,
              messageExternalId: lastMessage.externalId,
              traceJson,
            })
            errorSpan.end()
          }

          const endSpan = streamSpan.startSpan("send_end_event")
          await stream.writeSSE({
            data: "",
            event: ChatSSEvents.End,
          })
          endSpan.end()
          streamSpan.end()
          rootSpan.end()
        } catch (error) {
          const streamErrorSpan = streamSpan.startSpan("handle_stream_error")
          streamErrorSpan.addEvent("error", {
            message: getErrorMessage(error),
            stack: (error as Error).stack || "",
          })
          const errFomMap = handleError(error)
          const allMessages = await getChatMessages(db, chat?.externalId)
          const lastMessage = allMessages[allMessages.length - 1]
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chat.externalId,
              messageId: lastMessage.externalId,
            }),
          })
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: errFomMap,
          })

          // Add the error message to last user message
          await addErrMessageToMessage(lastMessage, errFomMap)

          await stream.writeSSE({
            data: "",
            event: ChatSSEvents.End,
          })
          Logger.error(
            error,
            `Streaming Error: ${(error as Error).message} ${
              (error as Error).stack
            }`,
          )
          streamErrorSpan.end()
          streamSpan.end()
          rootSpan.end()
        } finally {
          // Ensure stream is removed from the map on completion or error
          if (streamKey && activeStreams.has(streamKey)) {
            activeStreams.delete(streamKey)
            Logger.info(`Removed stream ${streamKey} from active streams map.`)
          }
        }
      },
      async (err, stream) => {
        const streamErrorSpan = rootSpan.startSpan(
          "handle_stream_callback_error",
        )
        streamErrorSpan.addEvent("error", {
          message: getErrorMessage(err),
          stack: (err as Error).stack || "",
        })
        const errFromMap = handleError(err)
        // Use the stored assistant message ID if available when handling callback error
        const allMessages = await getChatMessages(db, chat?.externalId)
        const lastMessage = allMessages[allMessages.length - 1]
        const errorMsgId = assistantMessageId || lastMessage.externalId
        const errorChatId = chat?.externalId || "unknown"

        if (errorChatId !== "unknown" && errorMsgId !== "unknown") {
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: errorChatId,
              messageId: errorMsgId,
            }),
          })
          // Try to get the last message again for error reporting
          const allMessages = await getChatMessages(db, errorChatId)
          if (allMessages.length > 0) {
            const lastMessage = allMessages[allMessages.length - 1]
            await addErrMessageToMessage(lastMessage, errFromMap)
          }
        }
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: errFromMap,
        })
        await addErrMessageToMessage(lastMessage, errFromMap)

        await stream.writeSSE({
          data: "",
          event: ChatSSEvents.End,
        })
        Logger.error(
          err,
          `Streaming Error: ${err.message} ${(err as Error).stack}`,
        )
        // Ensure stream is removed from the map in the error callback too
        if (streamKey && activeStreams.has(streamKey)) {
          activeStreams.delete(streamKey)
          Logger.info(
            `Removed stream ${streamKey} from active streams map in error callback.`,
          )
        }
        streamErrorSpan.end()
        rootSpan.end()
      },
    )
  } catch (error) {
    Logger.info(`MessageApi Error occurred.. {error}`)
    const errorSpan = rootSpan.startSpan("handle_top_level_error")
    errorSpan.addEvent("error", {
      message: getErrorMessage(error),
      stack: (error as Error).stack || "",
    })
    const errMsg = getErrorMessage(error)
    // TODO: add more errors like bedrock, this is only openai
    const errFromMap = handleError(error)
    // @ts-ignore
    if (chat?.externalId) {
      const allMessages = await getChatMessages(db, chat?.externalId)
      // Add the error message to last user message
      if (allMessages.length > 0) {
        const lastMessage = allMessages[allMessages.length - 1]
        // Use the stored assistant message ID if available for metadata
        const errorMsgId = assistantMessageId || lastMessage.externalId
        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({
            chatId: chat.externalId,
            messageId: errorMsgId,
          }),
        })
        await addErrMessageToMessage(lastMessage, errFromMap)
      }
    }
    if (error instanceof APIError) {
      // quota error
      if (error.status === 429) {
        Logger.error(error, "You exceeded your current quota")
        if (stream) {
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: errFromMap,
          })
        }
      }
    } else {
      Logger.error(error, `Message Error: ${errMsg} ${(error as Error).stack}`)
      throw new HTTPException(500, {
        message: "Could not create message or Chat",
      })
    }
    // Ensure stream is removed from the map in the top-level catch block
    if (streamKey && activeStreams.has(streamKey)) {
      activeStreams.delete(streamKey)
      Logger.info(
        `Removed stream ${streamKey} from active streams map in top-level catch.`,
      )
    }
    errorSpan.end()
    rootSpan.end()
  }
}

export const AgentMessageApi = async (c: Context) => {
  // we will use this in catch
  // if the value exists then we send the error to the frontend via it
  const tracer: Tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("AgentMessageApi")

  let stream: any
  let chat: SelectChat
  let assistantMessageId: string | null = null
  let streamKey: string | null = null

  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

    // @ts-ignore
    const body = c.req.valid("query")
    let {
      message,
      chatId,
      modelId,
      isReasoningEnabled,
      agentId,
    }: MessageReqType = body
    // const agentPrompt = agentId && isCuid(agentId) ? agentId : "";
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId, // This workspaceId is the externalId from JWT
      email,
    )
    const { user, workspace } = userAndWorkspace // workspace.id is the numeric ID

    let agentPromptForLLM: string | undefined = undefined
    let agentForDb: SelectAgent | null = null
    if (agentId && isCuid(agentId)) {
      // Use the numeric workspace.id for the database query
      agentForDb = await getAgentByExternalId(db, agentId, workspace.id)
      if (agentForDb) {
        agentPromptForLLM = JSON.stringify(agentForDb)
      }
    }
    const agentIdToStore = agentForDb ? agentForDb.externalId : null
    const userRequestsReasoning = isReasoningEnabled
    if (!message) {
      throw new HTTPException(400, {
        message: "Message is required",
      })
    }
    message = decodeURIComponent(message)
    rootSpan.setAttribute("message", message)

    const isMsgWithContext = isMessageWithContext(message)
    const extractedInfo = isMsgWithContext
      ? await extractFileIdsFromMessage(message)
      : {
          totalValidFileIdsFromLinkCount: 0,
          fileIds: [],
        }
    const fileIds = extractedInfo?.fileIds
    const totalValidFileIdsFromLinkCount =
      extractedInfo?.totalValidFileIdsFromLinkCount

    let messages: SelectMessage[] = []
    const costArr: number[] = []
    const ctx = userContext(userAndWorkspace)
    let chat: SelectChat

    const chatCreationSpan = rootSpan.startSpan("chat_creation")

    let title = ""
    if (!chatId) {
      const titleSpan = chatCreationSpan.startSpan("generate_title")
      // let llm decide a title
      const titleResp = await generateTitleUsingQuery(message, {
        modelId: ragPipelineConfig[RagPipelineStages.NewChatTitle].modelId,
        stream: false,
      })
      title = titleResp.title
      const cost = titleResp.cost
      if (cost) {
        costArr.push(cost)
        titleSpan.setAttribute("cost", cost)
      }
      titleSpan.setAttribute("title", title)
      titleSpan.end()

      let [insertedChat, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage]> => {
          const chat = await insertChat(tx, {
            workspaceId: workspace.id,
            workspaceExternalId: workspace.externalId,
            userId: user.id,
            email: user.email,
            title,
            attachments: [],
            agentId: agentIdToStore,
          })

          const insertedMsg = await insertMessage(tx, {
            chatId: chat.id,
            userId: user.id,
            chatExternalId: chat.externalId,
            workspaceExternalId: workspace.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: [],
            message,
            modelId,
            fileIds: fileIds,
          })
          return [chat, insertedMsg]
        },
      )
      Logger.info(
        "First mesage of the conversation, successfully created the chat",
      )
      chat = insertedChat
      messages.push(insertedMsg) // Add the inserted message to messages array
      chatCreationSpan.end()
    } else {
      let [existingChat, allMessages, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage[], SelectMessage]> => {
          // we are updating the chat and getting it's value in one call itself

          let existingChat = await updateChatByExternalId(db, chatId, {})
          let allMessages = await getChatMessages(tx, chatId)

          let insertedMsg = await insertMessage(tx, {
            chatId: existingChat.id,
            userId: user.id,
            workspaceExternalId: workspace.externalId,
            chatExternalId: existingChat.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: [],
            message,
            modelId,
            fileIds,
          })
          return [existingChat, allMessages, insertedMsg]
        },
      )
      Logger.info("Existing conversation, fetched previous messages")
      messages = allMessages.concat(insertedMsg) // Update messages array
      chat = existingChat
      chatCreationSpan.end()
    }
    return streamSSE(
      c,
      async (stream) => {
        streamKey = `${chat.externalId}` // Create the stream key
        activeStreams.set(streamKey, stream) // Add stream to the map
        Logger.info(`Added stream ${streamKey} to active streams map.`)
        let wasStreamClosedPrematurely = false
        const streamSpan = rootSpan.startSpan("stream_response")
        streamSpan.setAttribute("chatId", chat.externalId)
        try {
          if (!chatId) {
            const titleUpdateSpan = streamSpan.startSpan("send_title_update")
            await stream.writeSSE({
              data: title,
              event: ChatSSEvents.ChatTitleUpdate,
            })
            titleUpdateSpan.end()
          }

          Logger.info("Chat stream started")
          // we do not set the message Id as we don't have it
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chat.externalId,
            }),
          })

          if (isMsgWithContext && fileIds && fileIds?.length > 0) {
            Logger.info(
              "User has selected some context with query, answering only based on that given context",
            )
            let answer = ""
            let citations = []
            let citationMap: Record<number, number> = {}
            let thinking = ""
            let reasoning =
              userRequestsReasoning &&
              ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning
            const conversationSpan = streamSpan.startSpan("conversation_search")
            conversationSpan.setAttribute("answer", answer)
            conversationSpan.end()

            const ragSpan = streamSpan.startSpan("rag_processing")

            const understandSpan = ragSpan.startSpan("understand_message")

            const iterator = UnderstandMessageAndAnswerForGivenContext(
              email,
              ctx,
              message,
              0.5,
              fileIds,
              userRequestsReasoning,
              understandSpan,
              agentPromptForLLM,
            )
            stream.writeSSE({
              event: ChatSSEvents.Start,
              data: "",
            })

            answer = ""
            thinking = ""
            reasoning = isReasoning && userRequestsReasoning
            citations = []
            citationMap = {}
            let citationValues: Record<number, string> = {}
            let count = 0
            for await (const chunk of iterator) {
              if (stream.closed) {
                Logger.info(
                  "[AgentMessageApi] Stream closed during conversation search loop. Breaking.",
                )
                wasStreamClosedPrematurely = true
                break
              }
              if (chunk.text) {
                if (
                  totalValidFileIdsFromLinkCount > maxValidLinks &&
                  count === 0
                ) {
                  stream.writeSSE({
                    event: ChatSSEvents.ResponseUpdate,
                    data: `Skipping last ${totalValidFileIdsFromLinkCount - maxValidLinks} links as it exceeds max limit of ${maxValidLinks}. `,
                  })
                }
                if (reasoning && chunk.reasoning) {
                  thinking += chunk.text
                  stream.writeSSE({
                    event: ChatSSEvents.Reasoning,
                    data: chunk.text,
                  })
                  // reasoningSpan.end()
                }
                if (!chunk.reasoning) {
                  answer += chunk.text
                  stream.writeSSE({
                    event: ChatSSEvents.ResponseUpdate,
                    data: chunk.text,
                  })
                }
              }
              if (chunk.cost) {
                costArr.push(chunk.cost)
              }
              if (chunk.citation) {
                const { index, item } = chunk.citation
                citations.push(item)
                citationMap[index] = citations.length - 1
                Logger.info(
                  `Found citations and sending it, current count: ${citations.length}`,
                )
                stream.writeSSE({
                  event: ChatSSEvents.CitationsUpdate,
                  data: JSON.stringify({
                    contextChunks: citations,
                    citationMap,
                  }),
                })
                citationValues[index] = item
              }
              count++
            }
            understandSpan.setAttribute("citation_count", citations.length)
            understandSpan.setAttribute(
              "citation_map",
              JSON.stringify(citationMap),
            )
            understandSpan.setAttribute(
              "citation_values",
              JSON.stringify(citationValues),
            )
            understandSpan.end()
            const answerSpan = ragSpan.startSpan("process_final_answer")
            answerSpan.setAttribute(
              "final_answer",
              processMessage(answer, citationMap),
            )
            answerSpan.setAttribute("actual_answer", answer)
            answerSpan.setAttribute("final_answer_length", answer.length)
            answerSpan.end()
            ragSpan.end()

            if (answer || wasStreamClosedPrematurely) {
              // TODO: incase user loses permission
              // to one of the citations what do we do?
              // somehow hide that citation and change
              // the answer to reflect that
              const msg = await insertMessage(db, {
                chatId: chat.id,
                userId: user.id,
                workspaceExternalId: workspace.externalId,
                chatExternalId: chat.externalId,
                messageRole: MessageRole.Assistant,
                email: user.email,
                sources: citations,
                message: processMessage(answer, citationMap),
                thinking: thinking,
                modelId:
                  ragPipelineConfig[RagPipelineStages.AnswerOrRewrite].modelId,
              })
              assistantMessageId = msg.externalId
              const traceJson = tracer.serializeToJson()
              await insertChatTrace({
                workspaceId: workspace.id,
                userId: user.id,
                chatId: chat.id,
                messageId: msg.id,
                chatExternalId: chat.externalId,
                email: user.email,
                messageExternalId: msg.externalId,
                traceJson,
              })
              Logger.info(
                `[AgentMessageApi] Inserted trace for message ${msg.externalId} (premature: ${wasStreamClosedPrematurely}).`,
              )
              await stream.writeSSE({
                event: ChatSSEvents.ResponseMetadata,
                data: JSON.stringify({
                  chatId: chat.externalId,
                  messageId: assistantMessageId,
                }),
              })
            } else {
              const errorSpan = streamSpan.startSpan("handle_no_answer")
              const allMessages = await getChatMessages(db, chat?.externalId)
              const lastMessage = allMessages[allMessages.length - 1]

              await stream.writeSSE({
                event: ChatSSEvents.ResponseMetadata,
                data: JSON.stringify({
                  chatId: chat.externalId,
                  messageId: lastMessage.externalId,
                }),
              })
              await stream.writeSSE({
                event: ChatSSEvents.Error,
                data: "Can you please make your query more specific?",
              })
              await addErrMessageToMessage(
                lastMessage,
                "Can you please make your query more specific?",
              )

              const traceJson = tracer.serializeToJson()
              await insertChatTrace({
                workspaceId: workspace.id,
                userId: user.id,
                chatId: chat.id,
                messageId: lastMessage.id,
                chatExternalId: chat.externalId,
                email: user.email,
                messageExternalId: lastMessage.externalId,
                traceJson,
              })
              errorSpan.end()
            }

            const endSpan = streamSpan.startSpan("send_end_event")
            await stream.writeSSE({
              data: "",
              event: ChatSSEvents.End,
            })
            endSpan.end()
            streamSpan.end()
            rootSpan.end()
          } else {
            const messagesWithNoErrResponse = messages
              .slice(0, messages.length - 1)
              .filter((msg) => !msg?.errorMessage)
              .filter(
                (msg) =>
                  !(msg.messageRole === MessageRole.Assistant && !msg.message),
              ) // filter out assistant messages with no content
              .map((msg) => {
                // If any message from the messagesWithNoErrResponse is a user message, has fileIds and its message is JSON parsable
                // then we should not give that exact stringified message as history
                // We convert it into a AI friendly string only for giving it to LLM
                const fileIds = JSON.parse(JSON.stringify(msg?.fileIds || []))
                if (
                  msg.messageRole === "user" &&
                  fileIds &&
                  fileIds.length > 0
                ) {
                  const originalMsg = msg.message
                  const selectedContext = isContextSelected(originalMsg)
                  msg.message = selectedContext
                    ? buildUserQuery(selectedContext)
                    : originalMsg
                }
                return {
                  role: msg.messageRole as ConversationRole,
                  content: [{ text: msg.message }],
                }
              })

            Logger.info(
              "Checking if answer is in the conversation or a mandatory query rewrite is needed before RAG",
            )
            const searchOrAnswerIterator =
              generateSearchQueryOrAnswerFromConversation(message, ctx, {
                modelId:
                  ragPipelineConfig[RagPipelineStages.AnswerOrSearch].modelId,
                stream: true,
                json: true,
                reasoning:
                  userRequestsReasoning &&
                  ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning,
                messages: messagesWithNoErrResponse,
                agentPrompt: agentPromptForLLM,
              })

            // TODO: for now if the answer is from the conversation itself we don't
            // add any citations for it, we can refer to the original message for citations
            // one more bug is now llm automatically copies the citation text sometimes without any reference
            // leads to [NaN] in the answer
            let currentAnswer = ""
            let answer = ""
            let citations = []
            let citationMap: Record<number, number> = {}
            let queryFilters = {
              app: "",
              entity: "",
              startTime: "",
              endTime: "",
              count: 0,
              sortDirection: "",
            }
            let parsed = {
              answer: "",
              queryRewrite: "",
              temporalDirection: null,
              filter_query: "",
              type: "",
              filters: queryFilters,
            }

            let thinking = ""
            let reasoning =
              userRequestsReasoning &&
              ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning
            let buffer = ""
            const conversationSpan = streamSpan.startSpan("conversation_search")
            for await (const chunk of searchOrAnswerIterator) {
              if (stream.closed) {
                Logger.info(
                  "[AgentMessageApi] Stream closed during conversation search loop. Breaking.",
                )
                wasStreamClosedPrematurely = true
                break
              }
              if (chunk.text) {
                if (reasoning) {
                  if (thinking && !chunk.text.includes(EndThinkingToken)) {
                    thinking += chunk.text
                    stream.writeSSE({
                      event: ChatSSEvents.Reasoning,
                      data: chunk.text,
                    })
                  } else {
                    // first time
                    if (!chunk.text.includes(StartThinkingToken)) {
                      let token = chunk.text
                      if (chunk.text.includes(EndThinkingToken)) {
                        token = chunk.text.split(EndThinkingToken)[0]
                        thinking += token
                      } else {
                        thinking += token
                      }
                      stream.writeSSE({
                        event: ChatSSEvents.Reasoning,
                        data: token,
                      })
                    }
                  }
                }
                if (reasoning && chunk.text.includes(EndThinkingToken)) {
                  reasoning = false
                  chunk.text = chunk.text.split(EndThinkingToken)[1].trim()
                }
                if (!reasoning) {
                  buffer += chunk.text
                  try {
                    parsed = jsonParseLLMOutput(buffer) || {}
                    if (parsed.answer && currentAnswer !== parsed.answer) {
                      if (currentAnswer === "") {
                        Logger.info(
                          "We were able to find the answer/respond to users query in the conversation itself so not applying RAG",
                        )
                        stream.writeSSE({
                          event: ChatSSEvents.Start,
                          data: "",
                        })
                        // First valid answer - send the whole thing
                        stream.writeSSE({
                          event: ChatSSEvents.ResponseUpdate,
                          data: parsed.answer,
                        })
                      } else {
                        // Subsequent chunks - send only the new part
                        const newText = parsed.answer.slice(
                          currentAnswer.length,
                        )
                        stream.writeSSE({
                          event: ChatSSEvents.ResponseUpdate,
                          data: newText,
                        })
                      }
                      currentAnswer = parsed.answer
                    }
                  } catch (err) {
                    const errMessage = (err as Error).message
                    Logger.error(
                      err,
                      `Error while parsing LLM output ${errMessage}`,
                    )
                    continue
                  }
                }
              }
              if (chunk.cost) {
                costArr.push(chunk.cost)
              }
            }

            conversationSpan.setAttribute("answer_found", parsed.answer)
            conversationSpan.setAttribute("answer", answer)
            conversationSpan.setAttribute("query_rewrite", parsed.queryRewrite)
            conversationSpan.end()

            if (parsed.answer === null || parsed.answer === "") {
              const ragSpan = streamSpan.startSpan("rag_processing")
              if (parsed.queryRewrite) {
                Logger.info(
                  `The query is ambigious and requires a mandatory query rewrite from the existing conversation / recent messages ${parsed.queryRewrite}`,
                )
                message = parsed.queryRewrite
                Logger.info(`Rewritten query: ${message}`)
                ragSpan.setAttribute("query_rewrite", parsed.queryRewrite)
              } else {
                Logger.info(
                  "There was no need for a query rewrite and there was no answer in the conversation, applying RAG",
                )
              }
              const classification: TemporalClassifier & QueryRouterResponse = {
                direction: parsed.temporalDirection,
                type: parsed.type as QueryType,
                filterQuery: parsed.filter_query,
                filters: {
                  ...parsed?.filters,
                  app: parsed.filters?.app as Apps,
                  entity: parsed.filters?.entity as any,
                },
              }

              Logger.info(
                `Classifying the query as:, ${JSON.stringify(classification)}`,
              )
              const understandSpan = ragSpan.startSpan("understand_message")
              const iterator = UnderstandMessageAndAnswer(
                email,
                ctx,
                message,
                classification,
                messagesWithNoErrResponse,
                0.5,
                userRequestsReasoning,
                understandSpan,
                agentPromptForLLM,
              )
              stream.writeSSE({
                event: ChatSSEvents.Start,
                data: "",
              })

              answer = ""
              thinking = ""
              reasoning = isReasoning && userRequestsReasoning
              citations = []
              citationMap = {}
              let citationValues: Record<number, string> = {}
              for await (const chunk of iterator) {
                if (stream.closed) {
                  Logger.info(
                    "[MessageApi] Stream closed during conversation search loop. Breaking.",
                  )
                  wasStreamClosedPrematurely = true
                  break
                }
                if (chunk.text) {
                  if (reasoning && chunk.reasoning) {
                    thinking += chunk.text
                    stream.writeSSE({
                      event: ChatSSEvents.Reasoning,
                      data: chunk.text,
                    })
                    // reasoningSpan.end()
                  }
                  if (!chunk.reasoning) {
                    answer += chunk.text
                    stream.writeSSE({
                      event: ChatSSEvents.ResponseUpdate,
                      data: chunk.text,
                    })
                  }
                }
                if (chunk.cost) {
                  costArr.push(chunk.cost)
                }
                if (chunk.citation) {
                  const { index, item } = chunk.citation
                  citations.push(item)
                  citationMap[index] = citations.length - 1
                  Logger.info(
                    `Found citations and sending it, current count: ${citations.length}`,
                  )
                  stream.writeSSE({
                    event: ChatSSEvents.CitationsUpdate,
                    data: JSON.stringify({
                      contextChunks: citations,
                      citationMap,
                    }),
                  })
                  citationValues[index] = item
                }
              }
              understandSpan.setAttribute("citation_count", citations.length)
              understandSpan.setAttribute(
                "citation_map",
                JSON.stringify(citationMap),
              )
              understandSpan.setAttribute(
                "citation_values",
                JSON.stringify(citationValues),
              )
              understandSpan.end()
              const answerSpan = ragSpan.startSpan("process_final_answer")
              answerSpan.setAttribute(
                "final_answer",
                processMessage(answer, citationMap),
              )
              answerSpan.setAttribute("actual_answer", answer)
              answerSpan.setAttribute("final_answer_length", answer.length)
              answerSpan.end()
              ragSpan.end()
            } else if (parsed.answer) {
              answer = parsed.answer
            }

            if (answer || wasStreamClosedPrematurely) {
              // Determine if a message (even partial) should be saved
              // TODO: incase user loses permission
              // to one of the citations what do we do?
              // somehow hide that citation and change
              // the answer to reflect that

              const msg = await insertMessage(db, {
                chatId: chat.id,
                userId: user.id,
                workspaceExternalId: workspace.externalId,
                chatExternalId: chat.externalId,
                messageRole: MessageRole.Assistant,
                email: user.email,
                sources: citations,
                message: processMessage(answer, citationMap),
                thinking: thinking,
                modelId:
                  ragPipelineConfig[RagPipelineStages.AnswerOrRewrite].modelId,
              })
              assistantMessageId = msg.externalId

              const traceJson = tracer.serializeToJson()
              await insertChatTrace({
                workspaceId: workspace.id,
                userId: user.id,
                chatId: chat.id,
                messageId: msg.id,
                chatExternalId: chat.externalId,
                email: user.email,
                messageExternalId: msg.externalId,
                traceJson,
              })
              Logger.info(
                `[AgentMessageApi] Inserted trace for message ${msg.externalId} (premature: ${wasStreamClosedPrematurely}).`,
              )

              await stream.writeSSE({
                event: ChatSSEvents.ResponseMetadata,
                data: JSON.stringify({
                  chatId: chat.externalId,
                  messageId: assistantMessageId,
                }),
              })
            } else {
              const errorSpan = streamSpan.startSpan("handle_no_answer")
              const allMessages = await getChatMessages(db, chat?.externalId)
              const lastMessage = allMessages[allMessages.length - 1]

              await stream.writeSSE({
                event: ChatSSEvents.ResponseMetadata,
                data: JSON.stringify({
                  chatId: chat.externalId,
                  messageId: lastMessage.externalId,
                }),
              })
              await stream.writeSSE({
                event: ChatSSEvents.Error,
                data: "Oops, something went wrong. Please try rephrasing your question or ask something else.",
              })
              await addErrMessageToMessage(
                lastMessage,
                "Oops, something went wrong. Please try rephrasing your question or ask something else.",
              )

              const traceJson = tracer.serializeToJson()
              await insertChatTrace({
                workspaceId: workspace.id,
                userId: user.id,
                chatId: chat.id,
                messageId: lastMessage.id,
                chatExternalId: chat.externalId,
                email: user.email,
                messageExternalId: lastMessage.externalId,
                traceJson,
              })
              errorSpan.end()
            }

            const endSpan = streamSpan.startSpan("send_end_event")
            await stream.writeSSE({
              data: "",
              event: ChatSSEvents.End,
            })
            endSpan.end()
            streamSpan.end()
            rootSpan.end()
          }
        } catch (error) {
          const streamErrorSpan = streamSpan.startSpan("handle_stream_error")
          streamErrorSpan.addEvent("error", {
            message: getErrorMessage(error),
            stack: (error as Error).stack || "",
          })
          const errFomMap = handleError(error)
          const allMessages = await getChatMessages(db, chat?.externalId)
          const lastMessage = allMessages[allMessages.length - 1]
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chat.externalId,
              messageId: lastMessage.externalId,
            }),
          })
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: errFomMap,
          })

          // Add the error message to last user message
          await addErrMessageToMessage(lastMessage, errFomMap)

          await stream.writeSSE({
            data: "",
            event: ChatSSEvents.End,
          })
          Logger.error(
            error,
            `Streaming Error: ${(error as Error).message} ${(error as Error).stack}`,
          )
          streamErrorSpan.end()
          streamSpan.end()
          rootSpan.end()
        } finally {
          // Ensure stream is removed from the map on completion or error
          if (streamKey && activeStreams.has(streamKey)) {
            activeStreams.delete(streamKey)
            Logger.info(`Removed stream ${streamKey} from active streams map.`)
          }
        }
      },
      async (err, stream) => {
        const streamErrorSpan = rootSpan.startSpan(
          "handle_stream_callback_error",
        )
        streamErrorSpan.addEvent("error", {
          message: getErrorMessage(err),
          stack: (err as Error).stack || "",
        })
        const errFromMap = handleError(err)
        // Use the stored assistant message ID if available when handling callback error
        const allMessages = await getChatMessages(db, chat?.externalId)
        const lastMessage = allMessages[allMessages.length - 1]
        const errorMsgId = assistantMessageId || lastMessage.externalId
        const errorChatId = chat?.externalId || "unknown"

        if (errorChatId !== "unknown" && errorMsgId !== "unknown") {
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: errorChatId,
              messageId: errorMsgId,
            }),
          })
          // Try to get the last message again for error reporting
          const allMessages = await getChatMessages(db, errorChatId)
          if (allMessages.length > 0) {
            const lastMessage = allMessages[allMessages.length - 1]
            await addErrMessageToMessage(lastMessage, errFromMap)
          }
        }
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: errFromMap,
        })
        await addErrMessageToMessage(lastMessage, errFromMap)

        await stream.writeSSE({
          data: "",
          event: ChatSSEvents.End,
        })
        Logger.error(
          err,
          `Streaming Error: ${err.message} ${(err as Error).stack}`,
        )
        // Ensure stream is removed from the map in the error callback too
        if (streamKey && activeStreams.has(streamKey)) {
          activeStreams.delete(streamKey)
          Logger.info(
            `Removed stream ${streamKey} from active streams map in error callback.`,
          )
        }
        streamErrorSpan.end()
        rootSpan.end()
      },
    )
  } catch (error) {
    const errorSpan = rootSpan.startSpan("handle_top_level_error")
    errorSpan.addEvent("error", {
      message: getErrorMessage(error),
      stack: (error as Error).stack || "",
    })
    const errMsg = getErrorMessage(error)
    // TODO: add more errors like bedrock, this is only openai
    const errFromMap = handleError(error)
    // @ts-ignore
    if (chat?.externalId) {
      const allMessages = await getChatMessages(db, chat?.externalId)
      // Add the error message to last user message
      if (allMessages.length > 0) {
        const lastMessage = allMessages[allMessages.length - 1]
        // Use the stored assistant message ID if available for metadata
        const errorMsgId = assistantMessageId || lastMessage.externalId
        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({
            chatId: chat.externalId,
            messageId: errorMsgId,
          }),
        })
        await addErrMessageToMessage(lastMessage, errFromMap)
      }
    }
    if (error instanceof APIError) {
      // quota error
      if (error.status === 429) {
        Logger.error(error, "You exceeded your current quota")
        if (stream) {
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: errFromMap,
          })
        }
      }
    } else {
      Logger.error(error, `Message Error: ${errMsg} ${(error as Error).stack}`)
      throw new HTTPException(500, {
        message: "Could not create message or Chat",
      })
    }
    // Ensure stream is removed from the map in the top-level catch block
    if (streamKey && activeStreams.has(streamKey)) {
      activeStreams.delete(streamKey)
      Logger.info(
        `Removed stream ${streamKey} from active streams map in top-level catch.`,
      )
    }
    errorSpan.end()
    rootSpan.end()
  }
}
