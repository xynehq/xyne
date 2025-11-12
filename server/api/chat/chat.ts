import { answerContextMap, cleanContext, userContext } from "@/ai/context"
import {
  baselineRAGJsonStream,
  generateSearchQueryOrAnswerFromConversation,
  generateTitleUsingQuery,
  jsonParseLLMOutput,
  mailPromptJsonStream,
  queryRewriter,
  meetingPromptJsonStream,
  extractEmailsFromContext,
  generateFollowUpQuestions,
  webSearchQuestion,
  getDeepResearchResponse,
} from "@/ai/provider"
import { generateFollowUpQuestionsSystemPrompt } from "@/ai/prompts"
import {
  Models,
  QueryType,
  type ChainBreakClassifications,
  type ConverseResponse,
  type MailParticipant,
  type QueryRouterLLMResponse,
  type QueryRouterResponse,
  type TemporalClassifier,
  type UserQuery,
  type WebSearchSource,
} from "@/ai/types"
import config from "@/config"
import { getAvailableModels, getModelValueFromLabel } from "@/ai/modelConfig"
import {
  deleteChatByExternalIdWithAuth,
  deleteMessagesByChatId,
  getChatByExternalId,
  getChatByExternalIdWithAuth,
  getFavoriteChats,
  getPublicChats,
  getAllChatsForDashboard,
  insertChat,
  updateChatByExternalIdWithAuth,
  updateChatBookmarkStatus,
  updateMessageByExternalId,
} from "@/db/chat"
import { db } from "@/db/client"
import {
  insertMessage,
  getMessageByExternalId,
  getChatMessagesBefore,
  updateMessage,
  getChatMessagesWithAuth,
  getMessageCountsByChats,
  getMessageFeedbackStats,
  getAllMessages,
} from "@/db/message"
import { eq, and } from "drizzle-orm"
import { nanoid } from "nanoid"
import {
  selectPublicChatSchema,
  selectPublicMessagesSchema,
  selectMessageSchema,
  sharedChats,
  ChatType,
  type SelectChat,
  type SelectMessage,
} from "@/db/schema"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getLogger, getLoggerWithChild } from "@/logger"
import {
  ChatSSEvents,
  OpenAIError,
  type MessageReqType,
  DEFAULT_TEST_AGENT_ID,
  ApiKeyScopes,
} from "@/shared/types"
import { MessageRole, Subsystem, type UserMetadataType } from "@/types"
import {
  delay,
  getErrorMessage,
  getRelativeTime,
  interpretDateFromReturnedTemporalValue,
  splitGroupedCitationsWithSpaces,
} from "@/utils"
import {
  type ConversationRole,
  type Message,
} from "@aws-sdk/client-bedrock-runtime"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE, type SSEStreamingApi } from "hono/streaming"
import { z } from "zod"
import type { chatSchema, MessageRetryReqType } from "@/api/search"
import { getTracer, type Span, type Tracer } from "@/tracer"
import {
  searchVespa,
  searchVespaInFiles,
  getItems,
  GetDocumentsByDocIds,
  searchSlackInVespa,
  getDocumentOrNull,
  searchVespaAgent,
  GetDocument,
  SearchEmailThreads,
  SearchVespaThreads,
  DeleteDocument,
  searchCollectionRAG,
} from "@/search/vespa"
import {
  Apps,
  CalendarEntity,
  chatContainerSchema,
  chatUserSchema,
  dataSourceFileSchema,
  DriveEntity,
  GooglePeopleEntity,
  MailAttachmentEntity,
  MailEntity,
  mailSchema,
  SearchModes,
  SlackEntity,
  WebSearchEntity,
  type Entity,
  type VespaMail,
  type VespaMailSearch,
  type VespaEventSearch,
  type VespaSchema,
  type VespaSearchResponse,
  type VespaSearchResult,
  type VespaSearchResults,
  type VespaSearchResultsSchema,
  KnowledgeBaseEntity,
  KbItemsSchema,
  AttachmentEntity,
  fileSchema,
} from "@xyne/vespa-ts/types"
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
import { appToSchemaMapper, entityToSchemaMapper } from "@xyne/vespa-ts/mappers"
import { getDocumentOrSpreadsheet } from "@/integrations/google/sync"
import { isCuid } from "@paralleldrive/cuid2"
import {
  getAgentByExternalId,
  getAllAgents,
  getAgentsAccessibleToUser,
  type SelectAgent,
  getAllPublicAgents,
} from "@/db/agent"
import { selectToolSchema, type SelectTool } from "@/db/schema/McpConnectors"
import {
  ragPipelineConfig,
  RagPipelineStages,
  type Citation,
  type ImageCitation,
} from "./types"
import { activeStreams } from "./stream"
import { AgentMessageApi, MessageWithToolsApi } from "@/api/chat/agents"
import {
  extractFileIdsFromMessage,
  isMessageWithContext,
  searchToCitation,
  processThreadResults,
  extractImageFileNames,
  extractThreadIdsFromResults,
  mergeThreadResults,
  expandEmailThreadsInResults,
  getCitationToImage,
  mimeTypeMap,
  extractNamesFromIntent,
  getChannelIdsFromAgentPrompt,
  parseAppSelections,
  isAppSelectionMap,
  findOptimalCitationInsertionPoint,
  textToCitationIndex,
  textToImageCitationIndex,
  isValidApp,
  isValidEntity,
  collectFollowupContext,
  textToKbItemCitationIndex,
  type AppFilter,
} from "./utils"
import {
  getRecentChainBreakClassifications,
  formatChainBreaksForPrompt,
} from "./utils"
import { likeDislikeCount } from "@/metrics/app/app-metrics"
import {
  getAttachmentsByMessageId,
  storeAttachmentMetadata,
} from "@/db/attachment"
import type { AttachmentMetadata, SelectPublicAgent } from "@/shared/types"
import { parseAttachmentMetadata } from "@/utils/parseAttachment"
import {
  getAgentUsageByUsers,
  getChatCountsByAgents,
  getFeedbackStatsByAgents,
  getMessageCountsByAgents,
  getPublicAgentsByUser,
  type SharedAgentUsageData,
} from "@/db/sharedAgentUsage"
import { getCollectionFilesVespaIds } from "@/db/knowledgeBase"
import type { GroundingSupport } from "@google/genai"
import {
  processDeepSearchIterator,
  processOpenAICitations,
  processWebSearchCitations,
} from "./deepsearch"
import { getDateForAI } from "@/utils/index"
import type { User } from "@microsoft/microsoft-graph-types"
import { getAuth, safeGet } from "../agent"
import { getChunkCountPerDoc } from "./chunk-selection"
import { handleAttachmentDelete } from "../files"
import { expandSheetIds } from "@/search/utils"

const METADATA_NO_DOCUMENTS_FOUND = "METADATA_NO_DOCUMENTS_FOUND_INTERNAL"
const METADATA_FALLBACK_TO_RAG = "METADATA_FALLBACK_TO_RAG_INTERNAL"

export async function resolveNamesToEmails(
  mailParticipants: MailParticipant,
  email: string,
  userCtx: string,
  userMetadata: UserMetadataType,
  span?: Span,
): Promise<any> {
  const resolveSpan = span?.startSpan("resolve_names_to_emails")

  try {
    const extractedNames = extractNamesFromIntent(mailParticipants)

    const allNames = [
      ...(extractedNames.from || []),
      ...(extractedNames.to || []),
      ...(extractedNames.cc || []),
      ...(extractedNames.bcc || []),
    ]

    if (allNames.length === 0) {
      resolveSpan?.setAttribute("no_names_found", true)
      resolveSpan?.end()
      return mailParticipants
    }

    const isValidEmailAddress = (email: string): boolean => {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      return emailRegex.test(email)
    }

    const allNamesAreEmails = allNames.every((name) =>
      isValidEmailAddress(name),
    )
    if (allNamesAreEmails) {
      resolveSpan?.setAttribute("all_names_are_emails", true)
      resolveSpan?.setAttribute("skip_resolution", true)
      resolveSpan?.end()
      return mailParticipants
    }
    resolveSpan?.setAttribute("names_to_resolve", JSON.stringify(allNames))

    const searchSpan = resolveSpan?.startSpan("search_users")
    const searchQuery = allNames.join(" ")

    const searchResults = await searchVespa(
      searchQuery,
      email,
      Apps.Gmail,
      MailEntity.Email,
      {
        limit: 50,
        alpha: 0.5,
        span: searchSpan,
        isIntentSearch: true,
      },
    )

    searchSpan?.setAttribute("search_query", searchQuery)
    searchSpan?.setAttribute(
      "results_count",
      searchResults.root.children?.length || 0,
    )
    searchSpan?.end()

    const resultCount = searchResults.root.children?.length || 0
    Logger.info(`resolveNamesToEmails result count: ${resultCount}`)
    if (
      !searchResults.root.children ||
      searchResults.root.children.length === 0
    ) {
      return mailParticipants
    }

    const searchContext = searchResults.root.children
      .map((result, index) => {
        const fields = result.fields as VespaMail
        const contextLine = `
        [Index ${index}]: 
        Sent: ${getRelativeTime(fields.timestamp)}  (${new Date(fields.timestamp).toLocaleString("en-US", { timeZone: userMetadata.userTimezone })})
        Subject: ${fields.subject || "Unknown"}
        From: <${fields.from}>
        To: <${fields.to}>
        CC: <${fields.cc}>
        BCC: <${fields.bcc}>
        `

        return contextLine
      })
      .join("\n")

    let resolvedData: MailParticipant = {}
    const resolutionResult = await extractEmailsFromContext(
      extractedNames,
      userCtx,
      searchContext,
      { modelId: config.defaultFastModel, json: false, stream: false },
    )

    resolvedData = resolutionResult.emails || []

    searchSpan?.end()
    return resolvedData
  } catch (error) {
    resolveSpan?.end()
    return mailParticipants
  }
}

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
} = config
const Logger = getLogger(Subsystem.Chat)
const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

export const GetChatTraceApi = async (c: Context) => {
  let email = ""
  try {
    const jwtPayload = (c.get(JwtPayloadKey) ?? {}) as Record<string, unknown>
    email = typeof jwtPayload.sub === "string" ? jwtPayload.sub : ""

    // @ts-ignore - Assume validation is handled by middleware in server.ts
    const { chatId, messageId } = c.req.valid("query")

    if (!chatId || !messageId) {
      throw new HTTPException(400, {
        message: "chatId and messageId are required query parameters",
      })
    }
    const trace = await getChatTraceByExternalId(chatId, messageId)

    if (!trace) {
      // Return 404 if the trace is not found for the given IDs
      throw new HTTPException(404, { message: "Chat trace not found" })
    }

    // The traceJson is likely already a JSON object/string in the DB, return it directly
    return c.json(trace)
  } catch (error) {
    const errMsg = getErrorMessage(error)
    if (error instanceof HTTPException) {
      // Re-throw HTTPExceptions to let Hono handle them
      throw error
    }
    loggerWithChild({ email: email }).error(
      error,
      `Get Chat Trace Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not fetch chat trace",
    })
  }
}

export const processMessage = (
  text: string,
  citationMap: Record<number, number>,
  email?: string,
) => {
  if (!text) {
    return ""
  }

  text = splitGroupedCitationsWithSpaces(text)
  return text.replace(textToCitationIndex, (match, num) => {
    const index = citationMap[num]

    return typeof index === "number" ? `[${index + 1}]` : ""
  })
}

export const processWebSearchMessage = (
  text: string,
  citationMap: Record<number, number>,
  email?: string,
) => {
  if (!text) {
    return ""
  }

  text = splitGroupedCitationsWithSpaces(text)

  // Track citations used in current line to deduplicate
  let currentLineCitations = new Set<number>()
  let result = ""
  let currentLine = ""

  const lines = text.split(/(\r?\n)/)

  for (let i = 0; i < lines.length; i++) {
    const segment = lines[i]

    if (segment.match(/\r?\n/)) {
      // End of line - add deduplicated citations and reset
      const uniqueCitations = Array.from(currentLineCitations)
        .sort((a, b) => a - b)
        .map((index) => ` [${index}]`)
        .join("")
      result += currentLine + uniqueCitations + segment
      currentLine = ""
      currentLineCitations.clear()
    } else {
      // Process current line segment
      const processedSegment = segment.replace(
        textToCitationIndex,
        (match, num) => {
          const index = citationMap[num]
          if (typeof index === "number") {
            currentLineCitations.add(index + 1)
          }
          return "" // Remove citation from text, will be added at line end
        },
      )
      currentLine += processedSegment
    }
  }

  // Handle final line if no newline at end
  if (currentLine || currentLineCitations.size > 0) {
    const uniqueCitations = Array.from(currentLineCitations)
      .sort((a, b) => a - b)
      .map((index) => ` [${index}]`)
      .join("")
    result += currentLine + uniqueCitations
  }

  return result
}

// the Set is passed by reference so that singular object will get updated
// but need to be kept in mind
const checkAndYieldCitations = async function* (
  textInput: string,
  yieldedCitations: Set<number>,
  results: any[],
  baseIndex: number = 0,
  email: string,
  yieldedImageCitations: Set<number>,
  isMsgWithKbItems?: boolean,
) {
  const text = splitGroupedCitationsWithSpaces(textInput)
  let match
  let imgMatch
  let kbMatch = null
  while (
    (match = textToCitationIndex.exec(text)) !== null ||
    (imgMatch = textToImageCitationIndex.exec(text)) !== null ||
    (isMsgWithKbItems &&
      (kbMatch = textToKbItemCitationIndex.exec(text)) !== null)
  ) {
    if (match || kbMatch) {
      let citationIndex = 0
      if (match) {
        citationIndex = parseInt(match[1], 10)
      } else if (kbMatch) {
        citationIndex = parseInt(kbMatch[1].split("_")[0], 10)
      }
      if (!yieldedCitations.has(citationIndex)) {
        const item = results[citationIndex - baseIndex]
        if (item) {
          // TODO: fix this properly, empty citations making streaming broke
          const f = (item as any)?.fields
          if (
            f?.sddocname === dataSourceFileSchema ||
            Object.values(AttachmentEntity).includes(f?.entity)
          ) {
            // Skip datasource and attachment files from citations
            continue
          }
          yield {
            citation: {
              index: citationIndex,
              item: searchToCitation(item as VespaSearchResults),
            },
          }
          yieldedCitations.add(citationIndex)
        } else {
          loggerWithChild({ email: email }).error(
            `Found a citation index but could not find it in the search result: ${citationIndex}, ${results.length}`,
          )
        }
      }
    } else if (imgMatch) {
      const parts = imgMatch[1].split("_")
      if (parts.length >= 2) {
        const docIndex = parseInt(parts[0], 10)
        const imageIndex = parseInt(parts[1], 10)
        const citationIndex = docIndex + baseIndex
        if (!yieldedImageCitations.has(citationIndex)) {
          const item = results[docIndex]
          if (item) {
            try {
              const imageData = await getCitationToImage(
                imgMatch[1],
                item,
                email,
              )
              if (imageData) {
                if (!imageData.imagePath || !imageData.imageBuffer) {
                  loggerWithChild({ email: email }).error(
                    "Invalid imageData structure returned",
                    { citationKey: imgMatch[1], imageData },
                  )
                  continue
                }
                yield {
                  imageCitation: {
                    citationKey: imgMatch[1],
                    imagePath: imageData.imagePath,
                    imageData: imageData.imageBuffer.toString("base64"),
                    ...(imageData.extension
                      ? { mimeType: mimeTypeMap[imageData.extension] }
                      : {}),
                    item: searchToCitation(item as VespaSearchResults),
                  },
                }
              }
            } catch (error) {
              loggerWithChild({ email: email }).error(
                error,
                "Error processing image citation",
                { citationKey: imgMatch[1], error: getErrorMessage(error) },
              )
            }
            yieldedImageCitations.add(citationIndex)
          } else {
            loggerWithChild({ email: email }).error(
              `Found a citation index but could not find it in the search result: ${citationIndex}, ${results.length}`,
            )
            continue
          }
        }
      }
    }
  }
}

export function cleanBuffer(buffer: string): string {
  let parsableBuffer = buffer
  parsableBuffer = parsableBuffer.replace(/^```(?:json)?[\s\n]*/i, "")
  return parsableBuffer.trim()
}

export const getThreadContext = async (
  searchResults: VespaSearchResponse,
  email: string,
  span?: Span,
) => {
  if (searchResults.root.children) {
    const threadIds = [
      ...new Set(
        searchResults.root.children.map((child: any) => child.fields.threadId),
      ),
    ].filter((id) => id)
    if (threadIds.length > 0) {
      const threadSpan = span?.startSpan("fetch_slack_threads")
      const threadMessages = await SearchVespaThreads(threadIds)
      return threadMessages
    }
  }
  return null
}

async function* processIterator(
  iterator: AsyncIterableIterator<ConverseResponse>,
  results: VespaSearchResult[],
  previousResultsLength: number = 0,
  userRequestsReasoning?: boolean,
  email?: string,
  isMsgWithKbItems?: boolean,
): AsyncIterableIterator<
  ConverseResponse & {
    citation?: { index: number; item: any }
    imageCitation?: ImageCitation
  }
> {
  let buffer = ""
  let currentAnswer = ""
  let parsed = { answer: "" }
  let thinking = ""
  let reasoning = config.isReasoning && userRequestsReasoning
  let yieldedCitations = new Set<number>()
  let yieldedImageCitations = new Set<number>()
  // tied to the json format and output expected, we expect the answer key to be present
  const ANSWER_TOKEN = '"answer":'

  for await (const chunk of iterator) {
    if (chunk.text) {
      if (reasoning) {
        if (thinking && !chunk.text.includes(EndThinkingToken)) {
          thinking += chunk.text
          yield* checkAndYieldCitations(
            thinking,
            yieldedCitations,
            results,
            previousResultsLength,
            email!,
            yieldedImageCitations,
            isMsgWithKbItems,
          )
          yield { text: chunk.text, reasoning }
        } else {
          // first time
          const startThinkingIndex = chunk.text.indexOf(StartThinkingToken)
          if (
            startThinkingIndex !== -1 &&
            chunk.text.trim().length > StartThinkingToken.length
          ) {
            let token = chunk.text.slice(
              startThinkingIndex + StartThinkingToken.length,
            )
            if (chunk.text.includes(EndThinkingToken)) {
              token = chunk.text.split(EndThinkingToken)[0]
              thinking += token
            } else {
              thinking += token
            }
            yield* checkAndYieldCitations(
              thinking,
              yieldedCitations,
              results,
              previousResultsLength,
              email!,
              yieldedImageCitations,
              isMsgWithKbItems,
            )
            yield { text: token, reasoning }
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
          const parsableBuffer = cleanBuffer(buffer)

          parsed = jsonParseLLMOutput(parsableBuffer, ANSWER_TOKEN)
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
            yield* checkAndYieldCitations(
              parsed.answer,
              yieldedCitations,
              results,
              previousResultsLength,
              email!,
              yieldedImageCitations,
              isMsgWithKbItems,
            )
            currentAnswer = parsed.answer
          }
        } catch (e) {
          // If we can't parse the JSON yet, continue accumulating
          continue
        }
      }
    }

    if (chunk.cost) {
      yield { cost: chunk.cost }
    }
  }
  return parsed.answer
}

export const GetChatApi = async (c: Context) => {
  let email = ""
  try {
    const { sub } = c.get(JwtPayloadKey) ?? {}
    email = sub || ""
    // @ts-ignore
    const body: z.infer<typeof chatSchema> = c.req.valid("json")
    const { chatId } = body
    const [chat, messages] = await Promise.all([
      getChatByExternalIdWithAuth(db, chatId, email),
      getChatMessagesWithAuth(db, chatId, email),
    ])
    return c.json({
      chat: selectPublicChatSchema.parse(chat),
      messages: selectPublicMessagesSchema.parse(messages),
    })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
      error,
      `Get Chat and Messages Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not fetch chat and messages",
    })
  }
}

export const ChatRenameApi = async (c: Context) => {
  let email = ""
  try {
    const { sub } = c.get(JwtPayloadKey) ?? {}
    email = sub || ""
    // @ts-ignore
    const { title, chatId } = c.req.valid("json")
    await updateChatByExternalIdWithAuth(db, chatId, email, { title })
    return c.json({ success: true })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
      error,
      `Chat Rename Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not rename chat",
    })
  }
}

export const ChatDeleteApi = async (c: Context) => {
  let email = ""
  try {
    const { sub } = c.get(JwtPayloadKey) ?? {}
    email = sub || ""
    // @ts-ignore
    const { chatId } = c.req.valid("json")
    const attachmentsToDelete: AttachmentMetadata[] = []
    await db.transaction(async (tx) => {
      // Get the chat's internal ID first
      const chat = await getChatByExternalIdWithAuth(tx, chatId, email)
      if (!chat) {
        throw new HTTPException(404, { message: "Chat not found" })
      }

      // Get all messages for the chat to delete attachments
      const messagesToDelete = await getChatMessagesWithAuth(tx, chatId, email)

      for (const message of messagesToDelete) {
        if (message.attachments && Array.isArray(message.attachments)) {
          const attachments = message.attachments as AttachmentMetadata[]
          attachmentsToDelete.push(...attachments)
        }
      }

      // Delete shared chats associated with this chat
      await tx.delete(sharedChats).where(eq(sharedChats.chatId, chat.id))

      // First delete chat traces to avoid cascade violations
      await deleteChatTracesByChatExternalId(tx, chatId)
      // Second we have to delete all messages associated with that chat
      await deleteMessagesByChatId(tx, chatId)
      await deleteChatByExternalIdWithAuth(tx, chatId, email)
    })
    if (attachmentsToDelete.length) {
      await handleAttachmentDelete(attachmentsToDelete, email)
    }
    return c.json({ success: true })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
      error,
      `Chat Delete Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not delete chat",
    })
  }
}

export const ChatHistory = async (c: Context) => {
  const { email, via_apiKey } = getAuth(c)
  if (via_apiKey) {
    const apiKeyScopes =
      safeGet<{ scopes?: string[] }>(c, "config")?.scopes || []
    if (!apiKeyScopes.includes(ApiKeyScopes.CHAT_HISTORY)) {
      return c.json(
        { message: "API key does not have scope to view chat history" },
        403,
      )
    }
  }
  try {
    // @ts-ignore
    const { page, from, to } = c.req.valid("query")
    const offset = page * chatHistoryPageSize
    const timeRange = from || to ? { from, to } : undefined
    return c.json(
      await getPublicChats(db, email, chatHistoryPageSize, offset, timeRange),
    )
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
      error,
      `Chat History Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not get chat history",
    })
  }
}

export const DashboardDataApi = async (c: Context) => {
  let email = ""
  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    email = sub
    // @ts-ignore
    const { from, to } = c.req.valid("query")
    const timeRange = from || to ? { from, to } : undefined

    // Get user and workspace info
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const { user, workspace } = userAndWorkspace

    // Fetch all chats based on time range (no pagination)
    const chats = await getAllChatsForDashboard(db, email, timeRange)

    // Get message counts for all chats
    const chatExternalIds = chats.map((chat) => chat.externalId)
    const messageCounts = await getMessageCountsByChats({
      db,
      chatExternalIds,
    })

    // Get feedback statistics for all chats
    const feedbackStats = await getMessageFeedbackStats({
      db,
      chatExternalIds,
      email,
      workspaceExternalId: workspace.externalId,
    })

    // Fetch all agents accessible to user
    const agents = await getAgentsAccessibleToUser(
      db,
      user.id,
      workspace.id,
      1000, // limit to 1000 agents (increased from 100)
      0, // offset 0
    )

    return c.json({
      chats,
      agents,
      messageCounts,
      feedbackStats,
    })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
      error,
      `Dashboard Data Error: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Could not get dashboard data",
    })
  }
}

export const SharedAgentUsageApi = async (c: Context) => {
  let email = ""
  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    email = sub
    // @ts-ignore
    const { from, to } = c.req.valid("query")
    const timeRange = from || to ? { from, to } : undefined

    // Get user and workspace info
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const { user, workspace } = userAndWorkspace

    // Get public agents created by this user
    const publicAgents = await getPublicAgentsByUser({
      db,
      userId: user.id,
      workspaceId: workspace.id,
      email,
      workspaceExternalId: workspace.externalId,
    })

    if (publicAgents.length === 0) {
      return c.json({
        sharedAgents: [],
        totalUsage: {
          totalChats: 0,
          totalMessages: 0,
          totalLikes: 0,
          totalDislikes: 0,
          uniqueUsers: 0,
        },
      })
    }

    const agentExternalIds = publicAgents.map((agent) => agent.externalId)

    // Get usage statistics for these agents
    const [chatCounts, messageCounts, feedbackStats, userUsageData] =
      await Promise.all([
        getChatCountsByAgents({
          db,
          agentExternalIds,
          workspaceExternalId: workspace.externalId,
          timeRange,
        }),
        getMessageCountsByAgents({
          db,
          agentExternalIds,
          workspaceExternalId: workspace.externalId,
          timeRange,
        }),
        getFeedbackStatsByAgents({
          db,
          agentExternalIds,
          workspaceExternalId: workspace.externalId,
          timeRange,
        }),
        getAgentUsageByUsers({
          db,
          agentExternalIds,
          workspaceExternalId: workspace.externalId,
          timeRange,
        }),
      ])

    // Transform data into the desired format
    const sharedAgents: SharedAgentUsageData[] = publicAgents.map((agent) => {
      const agentId = agent.externalId
      const userUsage = userUsageData[agentId] || []
      const feedback = feedbackStats[agentId] || { likes: 0, dislikes: 0 }

      // Calculate total cost and tokens for this agent
      const totalCost = userUsage.reduce(
        (sum, usage) => sum + usage.totalCost,
        0,
      )
      const totalTokens = userUsage.reduce(
        (sum, usage) => sum + usage.totalTokens,
        0,
      )

      return {
        agentId,
        agentName: agent.name,
        agentDescription: agent.description,
        totalChats: chatCounts[agentId] || 0,
        totalMessages: messageCounts[agentId] || 0,
        likes: feedback.likes,
        dislikes: feedback.dislikes,
        totalCost,
        totalTokens,
        userUsage,
      }
    })

    // Calculate total usage across all shared agents
    let totalChats = 0
    let totalMessages = 0
    let totalLikes = 0
    let totalDislikes = 0
    let totalCost = 0
    let totalTokens = 0
    const uniqueUsers = new Set<number>()

    sharedAgents.forEach((agent) => {
      totalChats += agent.totalChats
      totalMessages += agent.totalMessages
      totalLikes += agent.likes
      totalDislikes += agent.dislikes
      totalCost += agent.totalCost
      totalTokens += agent.totalTokens
      agent.userUsage.forEach((usage) => uniqueUsers.add(usage.userId))
    })

    return c.json({
      sharedAgents: sharedAgents.sort(
        (a, b) => b.totalMessages - a.totalMessages,
      ),
      totalUsage: {
        totalChats,
        totalMessages,
        totalLikes,
        totalDislikes,
        totalCost,
        totalTokens,
        uniqueUsers: uniqueUsers.size,
      },
    })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
      error,
      `Shared Agent Usage Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not get shared agent usage data",
    })
  }
}

export const ChatFavoritesApi = async (c: Context) => {
  let email = ""
  try {
    const { sub } = c.get(JwtPayloadKey)
    const email = sub
    // @ts-ignore
    const { page } = c.req.valid("query")
    const offset = page * chatHistoryPageSize
    return c.json(
      await getFavoriteChats(db, email, chatHistoryPageSize, offset),
    )
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
      error,
      `Chat Favorites Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not get favorite chats",
    })
  }
}

export const ChatBookmarkApi = async (c: Context) => {
  let email = ""
  try {
    const { sub } = c.get(JwtPayloadKey) ?? {}
    email = sub || ""
    // @ts-ignore
    const body = c.req.valid("json")
    const { chatId, bookmark } = body
    await updateChatBookmarkStatus(db, chatId, bookmark)
    return c.json({})
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
      error,
      `Chat Bookmark Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not bookmark chat",
    })
  }
}
export const replaceDocIdwithUserDocId = async (
  docId: string,
  email: string,
) => {
  const res = await GetDocument(mailSchema, docId)
  // Check if userMap exists in fields and cast to any to access it
  const userMap = (res.fields as any)?.userMap ?? {}

  return userMap[email] ?? docId
}

export async function buildContext(
  results: VespaSearchResult[],
  maxSummaryCount: number | undefined,
  userMetadata: UserMetadataType,
  startIndex: number = 0,
  builtUserQuery?: string,
  isMsgWithKbItems?: boolean,
): Promise<string> {
  const contextPromises = results?.map(
    async (v, i) =>
      `Index ${i + startIndex} \n ${await answerContextMap(
        v as VespaSearchResults,
        userMetadata,
        maxSummaryCount,
        undefined,
        isMsgWithKbItems,
        builtUserQuery,
      )}`,
  )
  const contexts = await Promise.all(contextPromises || [])
  return cleanContext(contexts.join("\n"))
}

async function* generateIterativeTimeFilterAndQueryRewrite(
  input: string,
  messages: Message[],
  email: string,
  userCtx: string,
  userMetadata: UserMetadataType,
  alpha: number = 0.5,
  pageSize: number = 10,
  maxPageNumber: number = 3,
  maxSummaryCount: number | undefined,
  classification: QueryRouterLLMResponse,
  userRequestsReasoning?: boolean,
  queryRagSpan?: Span,
  agentPrompt?: string,
  pathExtractedInfo?: PathExtractedInfo,
  publicAgents?: SelectPublicAgent[],
): AsyncIterableIterator<
  ConverseResponse & {
    citation?: { index: number; item: any }
    imageCitation?: ImageCitation
  }
> {
  // we are not going to do time expansion
  // we are going to do 4 months answer
  // if not found we go back to iterative page search
  // @ts-ignore
  const rootSpan = queryRagSpan?.startSpan(
    "generateIterativeTimeFilterAndQueryRewrite",
  )
  rootSpan?.setAttribute("input", input)
  rootSpan?.setAttribute("email", email)
  rootSpan?.setAttribute("alpha", alpha)
  rootSpan?.setAttribute("pageSize", pageSize)
  rootSpan?.setAttribute("maxPageNumber", maxPageNumber)
  rootSpan?.setAttribute("maxSummaryCount", maxSummaryCount || "none")
  let agentAppEnums: Apps[] = []
  let agentSpecificDataSourceIds: string[] = []
  let agentSpecificCollectionSelections: Array<{
    collectionIds?: string[]
    collectionFolderIds?: string[]
    collectionFileIds?: string[]
  }> = []
  let channelIds: string[] = []
  let selectedItem: Partial<Record<Apps, string[]>> = {}
  let agentAppFilters: Partial<Record<Apps, AppFilter[]>> = {}
  if (agentPrompt) {
    let agentPromptData: { appIntegrations?: string[] } = {}
    try {
      agentPromptData = JSON.parse(agentPrompt)
    } catch (error) {
      loggerWithChild({ email: email }).warn(
        `Failed to parse agentPrompt JSON: ${error} - agentPrompt: ${agentPrompt}`,
      )
    }
    channelIds = getChannelIdsFromAgentPrompt(agentPrompt)
    // This is how we are parsing currently
    if (
      agentPromptData.appIntegrations &&
      Array.isArray(agentPromptData.appIntegrations)
    ) {
      for (const integration of agentPromptData.appIntegrations) {
        if (typeof integration === "string") {
          const lowerIntegration = integration.toLowerCase()
          if (
            lowerIntegration.startsWith("ds-") ||
            lowerIntegration.startsWith("ds_")
          ) {
            // ds- is the prefix for datasource externalId
            agentSpecificDataSourceIds.push(integration)
            if (!agentAppEnums.includes(Apps.DataSource)) {
              agentAppEnums.push(Apps.DataSource)
            }
          } else {
            // Handle generic app names
            switch (lowerIntegration) {
              case Apps.GoogleDrive.toLowerCase():
              case "googledrive":
                if (!agentAppEnums.includes(Apps.GoogleDrive))
                  agentAppEnums.push(Apps.GoogleDrive)
                break
              case Apps.DataSource.toLowerCase(): // 'data-source'
                if (!agentAppEnums.includes(Apps.DataSource))
                  agentAppEnums.push(Apps.DataSource)
                break
              case "googlesheets":
                if (!agentAppEnums.includes(Apps.GoogleDrive))
                  agentAppEnums.push(Apps.GoogleDrive)
                break
              case Apps.Gmail.toLowerCase():
              case "gmail":
                if (!agentAppEnums.includes(Apps.Gmail))
                  agentAppEnums.push(Apps.Gmail)
                break
              case Apps.GoogleCalendar.toLowerCase():
              case "googlecalendar":
                if (!agentAppEnums.includes(Apps.GoogleCalendar))
                  agentAppEnums.push(Apps.GoogleCalendar)
                break
              case Apps.Slack.toLowerCase():
              case "slack":
                if (!agentAppEnums.includes(Apps.Slack))
                  agentAppEnums.push(Apps.Slack)
                break
              default:
                loggerWithChild({ email: email }).warn(
                  `Unknown integration type in agent prompt: ${integration}`,
                )
                break
            }
          }
        } else {
          loggerWithChild({ email: email }).warn(
            `Invalid integration item in agent prompt (not a string): ${integration}`,
          )
        }
      }
      agentAppEnums = [...new Set(agentAppEnums)]
    } else {
      loggerWithChild({ email: email }).warn(
        `agentPromptData.appIntegrations is not an array or is missing: ${agentPromptData}`,
      )
    }

    // parsing for the new type of integration which we are going to save
    if (isAppSelectionMap(agentPromptData.appIntegrations)) {
      const { selectedApps, selectedItems, appFilters } = parseAppSelections(
        agentPromptData.appIntegrations,
      )
      // Use selectedApps and selectedItems
      selectedItem = selectedItems
      agentAppFilters = appFilters || {}
      // agentAppEnums = selectedApps.filter(isValidApp);
      agentAppEnums = [...new Set(selectedApps)]

      // Extract collection selections from knowledge_base selections
      if (selectedItems[Apps.KnowledgeBase]) {
        const collectionIds: string[] = []
        const collectionFolderIds: string[] = []
        const collectionFileIds: string[] = []
        const source = getCollectionSource(pathExtractedInfo, selectedItems)

        for (const itemId of source) {
          if (itemId.startsWith("cl-")) {
            // Entire collection - remove cl- prefix
            collectionIds.push(itemId.replace(/^cl[-_]/, ""))
          } else if (itemId.startsWith("clfd-")) {
            // Collection folder - remove clfd- prefix
            collectionFolderIds.push(itemId.replace(/^clfd[-_]/, ""))
          } else if (itemId.startsWith("clf-")) {
            // Collection file - remove clf- prefix
            collectionFileIds.push(itemId.replace(/^clf[-_]/, ""))
          }
        }

        // Create the key-value pair object
        if (
          collectionIds.length > 0 ||
          collectionFolderIds.length > 0 ||
          collectionFileIds.length > 0
        ) {
          agentSpecificCollectionSelections.push({
            collectionIds: collectionIds.length > 0 ? collectionIds : undefined,
            collectionFolderIds:
              collectionFolderIds.length > 0 ? collectionFolderIds : undefined,
            collectionFileIds:
              collectionFileIds.length > 0 ? collectionFileIds : undefined,
          })
        }
      } else {
        console.log("No KnowledgeBase items found in selectedItems")
      }
    }
  } else if (publicAgents && publicAgents.length > 0) {
    processPublicAgentsCollectionSelections(
      publicAgents,
      pathExtractedInfo,
      agentSpecificCollectionSelections,
    )
  }

  let message = input

  let userAlpha = alpha
  try {
    const personalization = await getUserPersonalizationByEmail(db, email)
    if (personalization) {
      const nativeRankParams =
        personalization.parameters?.[SearchModes.NativeRank]
      if (nativeRankParams?.alpha !== undefined) {
        userAlpha = nativeRankParams.alpha
        loggerWithChild({ email: email }).info(
          { email, alpha: userAlpha },
          "Using personalized alpha for iterative RAG",
        )
      } else {
        loggerWithChild({ email: email }).info(
          { email },
          "No personalized alpha found in settings, using default for iterative RAG",
        )
      }
    } else {
      loggerWithChild({ email: email }).warn(
        { email },
        "User personalization settings not found, using default alpha for iterative RAG",
      )
    }
  } catch (err) {
    loggerWithChild({ email: email }).error(
      err,
      "Failed to fetch personalization for iterative RAG, using default alpha",
      { email },
    )
  }
  const initialSearchSpan = rootSpan?.startSpan("latestResults_search")

  const monthInMs = 30 * 24 * 60 * 60 * 1000
  let timestampRange = {
    from: new Date().getTime() - 4 * monthInMs,
    to: new Date().getTime(),
  }
  const { startTime, endTime } = classification.filters

  if (startTime && endTime) {
    const fromMs = new Date(startTime).getTime()
    const toMs = new Date(endTime).getTime()
    if (!isNaN(fromMs) && !isNaN(toMs) && fromMs <= toMs) {
      timestampRange.from = fromMs
      timestampRange.to = toMs
    } else {
      rootSpan?.setAttribute(
        "invalidTimestampRange",
        JSON.stringify({ startTime, endTime }),
      )
    }
  }

  let userSpecifiedCount = pageSize
  if (classification.filters.count) {
    rootSpan?.setAttribute("userSpecifiedCount", classification.filters.count)
    userSpecifiedCount = Math.min(
      classification.filters.count,
      config.maxUserRequestCount,
    )
  }
  if (classification.filterQuery) {
    message = classification.filterQuery
  }
  let searchResults: VespaSearchResponse
  if (!agentPrompt) {
    searchResults = await searchVespa(message, email, null, null, {
      limit: pageSize,
      alpha: userAlpha,
      timestampRange,
      span: initialSearchSpan,
      collectionSelections: agentSpecificCollectionSelections,
    })
  } else {
    Logger.info(
      `[GENERATEITERATIVETIMEFILTERANDQUERYREWRITE] Performing agent search with apps: ${agentAppEnums.join(
        ", ",
      )}, dataSources: ${agentSpecificDataSourceIds.join(
        ", ",
      )}, channelIds: ${channelIds.join(", ")}`,
    )
    Logger.info((`agentSpecificDataSourceIds is as follows: ${JSON.stringify(agentSpecificDataSourceIds)}, channelIds is as ${JSON.stringify(channelIds)} `)  )
    searchResults = await searchVespaAgent(
      message,
      email,
      null,
      null,
      agentAppEnums,
      {
        limit: pageSize,
        alpha: userAlpha,
        timestampRange,
        span: initialSearchSpan,
        dataSourceIds: agentSpecificDataSourceIds,
        channelIds: channelIds,
        collectionSelections: agentSpecificCollectionSelections,
        selectedItem: selectedItem,
        appFilters: agentAppFilters,
      },
    )
  }

  // Expand email threads in the results
  // Skip thread expansion if original intent was GetItems (exact count requested)
  if (classification.type !== QueryType.GetItems) {
    searchResults.root.children = await expandEmailThreadsInResults(
      searchResults.root.children || [],
      email,
      initialSearchSpan,
    )
  }

  const latestResults = searchResults.root.children
  initialSearchSpan?.setAttribute("result_count", latestResults?.length || 0)
  initialSearchSpan?.setAttribute(
    "result_ids",
    JSON.stringify(
      latestResults?.map((r: VespaSearchResult) => (r.fields as any).docId) ||
        [],
    ),
  )
  initialSearchSpan?.end()
  const latestIds = latestResults
    ?.map((v: VespaSearchResult) => (v?.fields as any).docId)
    ?.filter((v) => !!v)

  // for the case of reasoning as we are streaming the tokens and the citations
  // our iterative rag has be aware of the results length(max potential citation index) that is already sent before hand
  // so this helps us avoid conflict with a previous citation index
  let previousResultsLength = 0
  for (var pageNumber = 0; pageNumber < maxPageNumber; pageNumber++) {
    const pageSpan = rootSpan?.startSpan(`page_iteration_${pageNumber}`)
    pageSpan?.setAttribute("page_number", pageNumber)
    // should only do it once
    if (pageNumber === Math.floor(maxPageNumber / 2)) {
      // get the first page of results
      const rewriteSpan = pageSpan?.startSpan("query_rewrite")
      const vespaSearchSpan = rewriteSpan?.startSpan("vespa_search")

      let results: VespaSearchResponse
      if (!agentPrompt) {
        results = await searchVespa(message, email, null, null, {
          limit: pageSize,
          alpha: userAlpha,
          span: vespaSearchSpan,
          collectionSelections: agentSpecificCollectionSelections,
        })
      } else {
        results = await searchVespaAgent(
          message,
          email,
          null,
          null,
          agentAppEnums,
          {
            limit: pageSize,
            alpha: userAlpha,
            span: vespaSearchSpan,
            dataSourceIds: agentSpecificDataSourceIds,
            channelIds: channelIds,
            collectionSelections: agentSpecificCollectionSelections,
            selectedItem: selectedItem,
            appFilters: agentAppFilters,
          },
        )
      }

      // Expand email threads in the results
      // Skip thread expansion if original intent was GetItems (exact count requested)
      if (classification.type !== QueryType.GetItems) {
        results.root.children = await expandEmailThreadsInResults(
          results.root.children || [],
          email,
          vespaSearchSpan,
        )
      }
      vespaSearchSpan?.setAttribute(
        "result_count",
        results?.root?.children?.length || 0,
      )
      vespaSearchSpan?.setAttribute(
        "result_ids",
        JSON.stringify(
          results?.root?.children?.map(
            (r: VespaSearchResult) => (r.fields as any).docId,
          ) || [],
        ),
      )
      vespaSearchSpan?.end()

      const initialContext = await buildContext(
        results?.root?.children,
        maxSummaryCount,
        userMetadata,
        0,
        message,
        agentSpecificCollectionSelections.length > 0,
      )

      const queryRewriteSpan = rewriteSpan?.startSpan("query_rewriter")
      const queryResp = await queryRewriter(input, userCtx, initialContext, {
        modelId: defaultFastModel, //defaultBestModel,
        stream: false,
        agentPrompt,
      })
      const queries = queryResp.queries
      queryRewriteSpan?.setAttribute("query_count", queries.length)
      queryRewriteSpan?.setAttribute("queries", JSON.stringify(queries))
      queryRewriteSpan?.end()
      rewriteSpan?.end()
      for (let idx = 0; idx < queries.length; idx++) {
        const query = queries[idx]
        const querySpan = pageSpan?.startSpan(`query_${idx}`)
        querySpan?.setAttribute("query_index", idx)
        querySpan?.setAttribute("query_text", query)

        const latestSearchSpan = querySpan?.startSpan("latest_results_search")
        const latestSearchResponse = await (!agentPrompt
          ? searchVespa(query, email, null, null, {
              limit: pageSize,
              alpha: userAlpha,
              timestampRange,
              span: latestSearchSpan,
              collectionSelections: agentSpecificCollectionSelections,
            })
          : searchVespaAgent(query, email, null, null, agentAppEnums, {
              limit: pageSize,
              alpha: userAlpha,
              timestampRange,
              span: latestSearchSpan,
              dataSourceIds: agentSpecificDataSourceIds,
              channelIds: channelIds,
              collectionSelections: agentSpecificCollectionSelections,
              selectedItem: selectedItem,
              appFilters: agentAppFilters,
            }))

        // Expand email threads in the results
        // Skip thread expansion if original intent was GetItems (exact count requested)
        let latestResults: VespaSearchResult[]
        if (classification.type !== QueryType.GetItems) {
          const expandedChildren = await expandEmailThreadsInResults(
            latestSearchResponse.root.children || [],
            email,
            latestSearchSpan,
          )
          latestResults = expandedChildren
        } else {
          latestResults = latestSearchResponse.root.children || []
        }
        latestSearchSpan?.setAttribute(
          "result_count",
          latestResults?.length || 0,
        )
        latestSearchSpan?.setAttribute(
          "result_ids",
          JSON.stringify(
            latestResults?.map(
              (r: VespaSearchResult) => (r.fields as any).docId,
            ) || [],
          ),
        )
        latestSearchSpan?.end()

        // let results = await searchVespa(query, email, null, null, {
        //   limit: pageSize,
        //   alpha: userAlpha,
        //   excludedIds: latestResults
        //     ?.map((v: VespaSearchResult) => (v.fields as any).docId)
        //     ?.filter((v) => !!v),
        // })
        let results: VespaSearchResponse
        if (!agentPrompt) {
          results = await searchVespa(query, email, null, null, {
            limit: pageSize,
            alpha: userAlpha,
            excludedIds: latestResults
              ?.map((v: VespaSearchResult) => (v.fields as any).docId)
              ?.filter((v) => !!v),
            collectionSelections: agentSpecificCollectionSelections,
          })
        } else {
          results = await searchVespaAgent(
            query,
            email,
            null,
            null,
            agentAppEnums,
            {
              limit: pageSize,
              alpha: userAlpha,
              excludedIds: latestResults
                ?.map((v: VespaSearchResult) => (v.fields as any).docId)
                ?.filter((v) => !!v),
              dataSourceIds: agentSpecificDataSourceIds,
              channelIds,
              collectionSelections: agentSpecificCollectionSelections,
              selectedItem: selectedItem,
              appFilters: agentAppFilters,
            },
          )
        }

        // Expand email threads in the results
        // Skip thread expansion if original intent was GetItems (exact count requested)
        if (classification.type !== QueryType.GetItems) {
          results.root.children = await expandEmailThreadsInResults(
            results.root.children || [],
            email,
            latestSearchSpan,
          )
        }

        const totalResultsSpan = querySpan?.startSpan("total_results")
        const totalResults = (results?.root?.children || []).concat(
          latestResults || [],
        )
        totalResultsSpan?.setAttribute(
          "total_result_count",
          totalResults.length,
        )
        totalResultsSpan?.setAttribute(
          "result_ids",
          JSON.stringify(
            totalResults.map((r: VespaSearchResult) => (r.fields as any).docId),
          ),
        )
        totalResultsSpan?.end()
        const contextSpan = querySpan?.startSpan("build_context")
        const initialContext = await buildContext(
          totalResults,
          maxSummaryCount,
          userMetadata,
          0,
          message,
          agentSpecificCollectionSelections.length > 0,
        )

        const { imageFileNames } = extractImageFileNames(
          initialContext,
          totalResults,
        )

        contextSpan?.setAttribute("context_length", initialContext?.length || 0)
        contextSpan?.setAttribute("context", initialContext || "")
        contextSpan?.setAttribute("number_of_chunks", totalResults.length)
        loggerWithChild({ email: email }).info(
          `[Query Rewrite Path] Number of contextual chunks being passed: ${totalResults.length}`,
        )
        contextSpan?.end()

        const ragSpan = querySpan?.startSpan("baseline_rag")

        const iterator = baselineRAGJsonStream(
          query,
          userCtx,
          userMetadata,
          initialContext,
          // pageNumber,
          // maxPageNumber,
          {
            stream: true,
            modelId: defaultBestModel,
            messages,
            reasoning: config.isReasoning && userRequestsReasoning,
            agentPrompt,
            imageFileNames,
          },
          agentSpecificCollectionSelections.length > 0,
          agentSpecificCollectionSelections.length > 0,
        )

        const answer = yield* processIterator(
          iterator,
          totalResults,
          previousResultsLength,
          config.isReasoning && userRequestsReasoning,
          email,
          agentSpecificCollectionSelections.length > 0,
        )
        if (answer) {
          ragSpan?.setAttribute("answer_found", true)
          ragSpan?.end()
          querySpan?.end()
          pageSpan?.end()
          rootSpan?.end()
          queryRagSpan?.end()
          return
        }
        if (config.isReasoning && userRequestsReasoning) {
          previousResultsLength += totalResults.length
        }
        ragSpan?.end()
        querySpan?.end()
      }
    }
    const pageSearchSpan = pageSpan?.startSpan("page_search")
    let results: VespaSearchResponse
    if (pageNumber === 0) {
      const searchSpan = pageSearchSpan?.startSpan(
        "vespa_search_with_excluded_ids",
      )
      if (!agentPrompt) {
        results = await searchVespa(message, email, null, null, {
          limit: pageSize + pageSize * pageNumber,
          offset: pageNumber * pageSize,
          alpha: userAlpha,
          excludedIds: latestIds,
          span: searchSpan,
          collectionSelections: agentSpecificCollectionSelections,
        })
      } else {
        results = await searchVespaAgent(
          message,
          email,
          null,
          null,
          agentAppEnums,
          {
            limit: pageSize + pageSize * pageNumber,
            offset: pageNumber * pageSize,
            alpha: userAlpha,
            excludedIds: latestIds,
            span: searchSpan,
            dataSourceIds: agentSpecificDataSourceIds,
            collectionSelections: agentSpecificCollectionSelections,
            channelIds: channelIds,
            selectedItem: selectedItem,
            appFilters: agentAppFilters,
          },
        )
      }

      // Expand email threads in the results
      // Skip thread expansion if original intent was GetItems (exact count requested)
      if (classification.type !== QueryType.GetItems) {
        results.root.children = await expandEmailThreadsInResults(
          results.root.children || [],
          email,
          searchSpan,
        )
      }
      searchSpan?.setAttribute(
        "result_count",
        results?.root?.children?.length || 0,
      )
      searchSpan?.setAttribute(
        "result_ids",
        JSON.stringify(
          results?.root?.children?.map(
            (r: VespaSearchResult) => (r.fields as any).docId,
          ) || [],
        ),
      )
      searchSpan?.end()
      if (!results.root.children) {
        results.root.children = []
      }
      results.root.children = results?.root?.children?.concat(
        latestResults || [],
      )
    } else {
      const searchSpan = pageSearchSpan?.startSpan("vespa_search")
      if (!agentPrompt) {
        results = await searchVespa(message, email, null, null, {
          limit: pageSize + pageSize * pageNumber,
          offset: pageNumber * pageSize,
          alpha: userAlpha,
          span: searchSpan,
          collectionSelections: agentSpecificCollectionSelections,
        })
      } else {
        results = await searchVespaAgent(
          message,
          email,
          null,
          null,
          agentAppEnums,
          {
            limit: pageSize + pageSize * pageNumber,
            offset: pageNumber * pageSize,
            alpha: userAlpha,
            span: searchSpan,
            dataSourceIds: agentSpecificDataSourceIds,
            collectionSelections: agentSpecificCollectionSelections,
            channelIds: channelIds,
            selectedItem: selectedItem,
            appFilters: agentAppFilters,
          },
        )
      }

      // Expand email threads in the results
      // Skip thread expansion if original intent was GetItems (exact count requested)
      if (classification.type !== QueryType.GetItems) {
        results.root.children = await expandEmailThreadsInResults(
          results.root.children || [],
          email,
          searchSpan,
        )
      }

      searchSpan?.setAttribute(
        "result_count",
        results?.root?.children?.length || 0,
      )
      searchSpan?.setAttribute(
        "result_ids",
        JSON.stringify(
          results?.root?.children?.map(
            (r: VespaSearchResult) => (r.fields as any).docId,
          ) || [],
        ),
      )
      searchSpan?.end()
    }
    pageSearchSpan?.setAttribute(
      "total_result_count",
      results?.root?.children?.length || 0,
    )
    pageSearchSpan?.setAttribute(
      "total_result_ids",
      JSON.stringify(
        results?.root?.children?.map(
          (r: VespaSearchResult) => (r.fields as any).docId,
        ) || [],
      ),
    )
    pageSearchSpan?.end()
    const startIndex = isReasoning ? previousResultsLength : 0
    const contextSpan = pageSpan?.startSpan("build_context")
    const initialContext = await buildContext(
      results?.root?.children,
      maxSummaryCount,
      userMetadata,
      startIndex,
      message,
      agentSpecificCollectionSelections.length > 0,
    )

    const { imageFileNames } = extractImageFileNames(
      initialContext,
      results?.root?.children,
    )

    contextSpan?.setAttribute("context_length", initialContext?.length || 0)
    contextSpan?.setAttribute("context", initialContext || "")
    contextSpan?.setAttribute(
      "number_of_chunks",
      results?.root?.children?.length || 0,
    )
    loggerWithChild({ email: email }).info(
      `[Main Search Path] Number of contextual chunks being passed: ${
        results?.root?.children?.length || 0
      }`,
    )
    contextSpan?.end()

    const ragSpan = pageSpan?.startSpan("baseline_rag")

    const iterator = baselineRAGJsonStream(
      input,
      userCtx,
      userMetadata,
      initialContext,
      {
        stream: true,
        modelId: defaultBestModel,
        reasoning: config.isReasoning && userRequestsReasoning,
        agentPrompt,
        messages,
        imageFileNames,
      },
      agentSpecificCollectionSelections.length > 0,
      agentSpecificCollectionSelections.length > 0,
    )

    const answer = yield* processIterator(
      iterator,
      results?.root?.children,
      previousResultsLength,
      config.isReasoning && userRequestsReasoning,
      email,
      agentSpecificCollectionSelections.length > 0,
    )

    if (answer) {
      ragSpan?.setAttribute("answer_found", true)
      ragSpan?.end()
      pageSpan?.end()
      rootSpan?.end()
      queryRagSpan?.end()
      return
    }
    if (config.isReasoning && userRequestsReasoning) {
      previousResultsLength += results?.root?.children?.length || 0
      pageSpan?.setAttribute("previous_results_length", previousResultsLength)
    }
    ragSpan?.end()
    pageSpan?.end()
  }
  const noAnswerSpan = rootSpan?.startSpan("no_answer_response")
  yield {
    text: "I could not find any information to answer it, please change your query",
  }
  noAnswerSpan?.end()
  rootSpan?.end()
  queryRagSpan?.end()
}

async function* generateAnswerFromGivenContext(
  input: string,
  email: string,
  userCtx: string,
  userMetadata: UserMetadataType,
  alpha: number = 0.5,
  fileIds: string[],
  userRequestsReasoning: boolean,
  agentPrompt?: string,
  passedSpan?: Span,
  threadIds?: string[],
  attachmentFileIds?: string[],
  isMsgWithKbItems?: boolean,
  modelId?: string,
  isValidPath?: boolean,
  folderIds?: string[],
  messages: Message[] = [],
): AsyncIterableIterator<
  ConverseResponse & {
    citation?: { index: number; item: any }
    imageCitation?: ImageCitation
  }
> {
  const message = input
  const messageText = parseMessageText(message)
  loggerWithChild({ email: email }).info(
    { email },
    `generateAnswerFromGivenContext - input: ${messageText}`,
  )
  let userAlpha = alpha
  try {
    const personalization = await getUserPersonalizationByEmail(db, email)
    if (personalization) {
      const nativeRankParams =
        personalization.parameters?.[SearchModes.NativeRank]
      if (nativeRankParams?.alpha !== undefined) {
        userAlpha = nativeRankParams.alpha
        loggerWithChild({ email: email }).info(
          { email, alpha: userAlpha },
          "Using personalized alpha for iterative RAG",
        )
      } else {
        loggerWithChild({ email: email }).info(
          { email },
          "No personalized alpha found in settings, using default for iterative RAG",
        )
      }
    } else {
      loggerWithChild({ email: email }).warn(
        { email },
        "User personalization settings not found, using default alpha for iterative RAG",
      )
    }
  } catch (err) {
    loggerWithChild({ email: email }).error(
      err,
      "Failed to fetch personalization for iterative RAG, using default alpha",
      { email },
    )
  }

  const generateAnswerSpan = passedSpan?.startSpan(
    "generateAnswerFromGivenContext",
  )

  const selectedContext = isContextSelected(message)
  const builtUserQuery = selectedContext
    ? buildUserQuery(selectedContext)
    : message

  let previousResultsLength = 0
  const combinedSearchResponse: VespaSearchResult[] = []
  let chunksPerDocument: number[] = []
  const targetChunks = 120

  if (fileIds.length > 0 || (folderIds && folderIds.length > 0)) {
    const fileSearchSpan = generateAnswerSpan?.startSpan("file_search")
    let results
    if (isValidPath) {
      // handle valid path casee
      if (folderIds?.length) {
        results = await searchCollectionRAG(messageText, undefined, folderIds)
      } else {
        results = await searchCollectionRAG(messageText, fileIds, undefined)
      }
      if (results.root.children) {
        combinedSearchResponse.push(...results.root.children)
      }
    } else {
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
          builtUserQuery,
          email,
          nonCollectionFileIds,
          {
            limit: fileIds?.length,
            alpha: userAlpha,
          },
        )
        if (results.root.children) {
          combinedSearchResponse.push(...results.root.children)
        }
      }
      if (collectionFileIds && collectionFileIds.length > 0) {
        results = await searchCollectionRAG(
          messageText,
          collectionFileIds,
          undefined,
        )
        if (results.root.children) {
          combinedSearchResponse.push(...results.root.children)
        }
      }
      if (attachmentFileIds && attachmentFileIds.length > 0) {
        results = await searchVespaInFiles(
          builtUserQuery,
          email,
          attachmentFileIds,
          {
            limit: fileIds?.length,
            alpha: userAlpha,
            rankProfile: SearchModes.AttachmentRank,
          },
        )
        if (results.root.children) {
          combinedSearchResponse.push(...results.root.children)
        }
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

  loggerWithChild({ email: email }).info(
    `generateAnswerFromGivenContext - threadIds received: ${JSON.stringify(
      threadIds,
    )}`,
  )

  // If we have threadIds, fetch all emails in those threads
  if (threadIds && threadIds.length > 0) {
    loggerWithChild({ email: email }).info(
      `Fetching email threads for threadIds: ${threadIds.join(", ")}`,
    )
    const threadSpan = generateAnswerSpan?.startSpan("fetch_email_threads")
    threadSpan?.setAttribute("threadIds", JSON.stringify(threadIds))

    try {
      const threadResults = await SearchEmailThreads(threadIds, email)
      loggerWithChild({ email: email }).info(
        `Thread search results: ${JSON.stringify({
          threadIds,
          resultCount: threadResults?.root?.children?.length || 0,
          hasResults: !!(
            threadResults?.root?.children &&
            threadResults.root.children.length > 0
          ),
        })}`,
      )

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
        loggerWithChild({ email: email }).info(
          `Added ${addedCount} additional emails from ${threadIds.length} threads (no limits applied)`,
        )
        threadSpan?.setAttribute("added_email_count", addedCount)
        threadSpan?.setAttribute(
          "total_thread_emails_found",
          threadResults.root.children.length,
        )
        threadSpan?.setAttribute("thread_info", JSON.stringify(threadInfo))
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
  // const initialContext = cleanContext(
  //   results?.root?.children
  //     ?.map(
  //       (v, i) =>
  //         `Index ${i + startIndex} \n ${answerContextMap(
  //           v as VespaSearchResults,
  //           0,
  //           true,
  //         )}`,
  //     )
  //     ?.join("\n"),
  // )
  const initialResults = [...(combinedSearchResponse || [])]
  for (const v of initialResults) {
    if (
      v.fields &&
      "sddocname" in v.fields &&
      v.fields.sddocname === chatContainerSchema
    ) {
      const channelId = (v.fields as any).docId
      console.log(`Processing chat container with docId: ${channelId}`)

      if (channelId) {
        const searchResults = await searchSlackInVespa(messageText, email, {
          limit: 10,
          channelIds: [channelId],
        })
        if (searchResults.root.children) {
          combinedSearchResponse.push(...searchResults.root.children)
          const threadMessages = await getThreadContext(
            searchResults,
            email,
            generateAnswerSpan,
          )
          if (threadMessages?.root?.children) {
            combinedSearchResponse.push(...threadMessages.root.children)
          }
        }
      }
    }
  }

  const startIndex = isReasoning ? previousResultsLength : 0
  const contextPromises = combinedSearchResponse?.map(async (v, i) => {
    let content = await answerContextMap(
      v as VespaSearchResults,
      userMetadata,
      i < chunksPerDocument.length ? chunksPerDocument[i] : 0,
      true,
      isMsgWithKbItems,
      message,
    )
    if (
      v.fields &&
      "sddocname" in v.fields &&
      v.fields.sddocname === chatContainerSchema &&
      (v.fields as any).creator
    ) {
      try {
        const creator = await getDocumentOrNull(
          chatUserSchema,
          (v.fields as any).creator,
        )
        if (creator) {
          content += `\nCreator: ${(creator.fields as any).name}`
        }
      } catch (error) {
        loggerWithChild({ email }).error(
          error,
          `Failed to fetch creator for chat container`,
        )
      }
    }
    return `Index ${i + startIndex} \n ${content}`
  })

  const resolvedContexts = contextPromises
    ? await Promise.all(contextPromises)
    : []

  const initialContext = cleanContext(resolvedContexts.join("\n"))
  const { imageFileNames } = extractImageFileNames(
    initialContext,
    combinedSearchResponse,
  )

  const finalImageFileNames = imageFileNames || []

  if (attachmentFileIds?.length) {
    finalImageFileNames.push(
      ...attachmentFileIds.map((fileid, index) => `${index}_${fileid}_${0}`),
    )
  }

  const initialContextSpan = generateAnswerSpan?.startSpan("initialContext")
  initialContextSpan?.setAttribute(
    "context_length",
    initialContext?.length || 0,
  )
  initialContextSpan?.setAttribute("context", initialContext || "")
  initialContextSpan?.setAttribute(
    "number_of_chunks",
    combinedSearchResponse?.length || 0,
  )
  initialContextSpan?.end()

  loggerWithChild({ email: email }).info(
    `[Selected Context Path] Number of contextual chunks being passed: ${combinedSearchResponse?.length || 0
    }`,
  )

  const iterator = baselineRAGJsonStream(
    builtUserQuery,
    userCtx,
    userMetadata,
    initialContext,
    {
      stream: true,
      modelId: modelId ? (modelId as Models) : defaultBestModel,
      reasoning: config.isReasoning && userRequestsReasoning,
      agentPrompt,
      imageFileNames: finalImageFileNames,
      messages: messages,
    },
    true,
    isMsgWithKbItems,
  )

  const answer = yield* processIterator(
    iterator,
    combinedSearchResponse,
    previousResultsLength,
    userRequestsReasoning,
    email,
    isMsgWithKbItems,
  )
  if (answer) {
    generateAnswerSpan?.setAttribute("answer_found", true)
    generateAnswerSpan?.end()
    return
  } else if (
    // If no answer found, exit and yield nothing related to selected context found
    !answer
  ) {
    const noAnswerSpan = generateAnswerSpan?.startSpan("no_answer_response")
    yield {
      text: "From the selected context, I could not find any information to answer it, please change your query",
    }
    noAnswerSpan?.end()
    generateAnswerSpan?.end()
    return
  }
  if (config.isReasoning && userRequestsReasoning) {
    previousResultsLength += combinedSearchResponse?.length || 0
  }
  generateAnswerSpan?.end()
}
/**
 * generateAnswerFromDualRag - Performs RAG on both attachments and KB
 *
 * This function combines:
 * - Attachment search (like generateAnswerFromGivenContext)
 * - KB search (like UnderstandMessageAndAnswer)
 *
 * Results are merged, ranked by relevance, and passed to the LLM.
 */

export async function* generateAnswerFromDualRag(
  input: string,
  email: string,
  userCtx: string,
  userMetadata: UserMetadataType,
  alpha: number = 0.5,
  fileIds: string[],// contains all attachement fileids
  agentAppEnums: Apps[],
  userRequestsReasoning: boolean,
  agentPrompt?: string,
  passedSpan?: Span,
  threadIds?: string[],
  attachmentFileIds?: string[],// contains image attachments 
  isMsgWithSources?: boolean,
  modelId?: string,
  isValidPath?: boolean,
  folderIds?: string[],
): AsyncIterableIterator<
  ConverseResponse & {
    citation?: { index: number; item: any }
    imageCitation?: ImageCitation
  }
> {
  const message = input
  const messageText = parseMessageText(message)
  loggerWithChild({ email: email }).info(
    { email },
    `generateAnswerFromDualRag - input: ${messageText}`,
  )
  loggerWithChild({ email: email }).info(
    `generateAnswerFromDualRag - agentAppEnums received: ${JSON.stringify(
      agentAppEnums,
    )}`,
  )
  loggerWithChild({ email: email }).info(
    `generateAnswerFromDualRag - fileIds received: ${JSON.stringify(fileIds)}`,
  )
  loggerWithChild({ email: email }).info(
    `generateAnswerFromDualRag - attachmentFileIds received: ${JSON.stringify(
      attachmentFileIds,
    )}`,
  )
  let userAlpha = alpha
  try {
    const personalization = await getUserPersonalizationByEmail(db, email)
    if (personalization) {
      const nativeRankParams =
        personalization.parameters?.[SearchModes.NativeRank]
      if (nativeRankParams?.alpha !== undefined) {
        userAlpha = nativeRankParams.alpha
        loggerWithChild({ email: email }).info(
          { email, alpha: userAlpha },
          "[Dual RAG ] Using personalized alpha for iterative RAG",
        )
      } else {
        loggerWithChild({ email: email }).info(
          { email },
          "[Dual RAG ] No personalized alpha found in settings, using default for iterative RAG",
        )
      }
    } else {
      loggerWithChild({ email: email }).warn(
        { email },
        "[Dual RAG ] User personalization settings not found, using default alpha for iterative RAG",
      )
    }
  } catch (err) {
    loggerWithChild({ email: email }).error(
      err,
      "[Dual RAG ] Failed to fetch personalization for iterative RAG, using default alpha",
      { email },
    )
  }

  const generateAnswerSpan = passedSpan?.startSpan("generateAnswerFromDualRag")

  generateAnswerSpan?.setAttribute("fileIds_count", fileIds?.length || 0)
  generateAnswerSpan?.setAttribute(
    "agentApps_count",
    agentAppEnums?.length || 0,
  )

  const selectedContext = isContextSelected(message)
  const builtUserQuery = selectedContext
    ? buildUserQuery(selectedContext)
    : message

  let previousResultsLength = 0
  const combinedSearchResponse: VespaSearchResult[] = []
  //How many chunks to take from each document
  let chunksPerDocument: number[] = []
  //Total budget of chunks (120 is empirically validated)
  const targetChunks = 120

  
  if (fileIds.length > 0 || (folderIds && folderIds.length > 0)) {
    const fileSearchSpan = generateAnswerSpan?.startSpan("file_search")
    let results
    if (isValidPath) {
      // handle valid path casee
      generateAnswerSpan?.setAttribute("valid_path", true)
      if (folderIds?.length) {
        results = await searchCollectionRAG(messageText, undefined, folderIds)
      } else {
        results = await searchCollectionRAG(messageText, fileIds, undefined)
      }
      if (results.root.children) {
        combinedSearchResponse.push(...results.root.children)
      }
    } else {
      // Split into 3 groups
      // Search each group
      // Push results to combinedSearchResponse
      const collectionFileIds = fileIds.filter(
        (fid) => fid.startsWith("clf-") || fid.startsWith("att_"),
      )
      loggerWithChild({ email }).info(
        `[Dual RAG ] Collection file IDs identified: ${JSON.stringify(
          collectionFileIds,
        )}`,
      )
      const nonCollectionFileIds = fileIds.filter(
        (fid) => !fid.startsWith("clf-") && !fid.startsWith("att"),
      )
      loggerWithChild({ email }).info(
        `[Dual RAG ] Non-collection file IDs identified: ${JSON.stringify(
          nonCollectionFileIds,
        )}`,
      )

      const allAttachmentFileIds = fileIds.filter((fid) => fid.startsWith("attf_"))

  
      loggerWithChild({ email }).info(
        `[Dual RAG ] Attachment file IDs identified: ${JSON.stringify(
          allAttachmentFileIds,
        )}`,
      )

      if (nonCollectionFileIds && nonCollectionFileIds.length > 0) {
        loggerWithChild({ email }).info(
          `[Dual RAG ] Searching non-collection file IDs: ${JSON.stringify(
            nonCollectionFileIds,
          )} and calling searchVespaInFiles`,
        )
        results = await searchVespaInFiles(
          builtUserQuery,
          email,
          nonCollectionFileIds,
          {
            limit: fileIds?.length,
            alpha: userAlpha,
          },
        )
        if (results.root.children) {
          combinedSearchResponse.push(...results.root.children)
        }
      }
      if (collectionFileIds && collectionFileIds.length > 0) {
        results = await searchCollectionRAG(
          messageText,
          collectionFileIds,
          undefined,
        )
        if (results.root.children) {
          combinedSearchResponse.push(...results.root.children)
        }
      }
      if (allAttachmentFileIds && allAttachmentFileIds.length > 0) {
        loggerWithChild({ email }).info(
          `[Dual RAG ] Searching attachment file IDs: ${JSON.stringify(
            allAttachmentFileIds,
          )} and calling searchVespaInFiles`,
        )
        results = await searchVespaInFiles(
          builtUserQuery,
          email,
          allAttachmentFileIds,
          {
            limit: fileIds?.length,
            alpha: userAlpha,
            rankProfile: SearchModes.AttachmentRank,
          },
        )
        if (results.root.children) {
          combinedSearchResponse.push(...results.root.children)
        }
      }
    }


    fileSearchSpan?.end()
  }
  loggerWithChild({ email: email }).info(
    `[DUAL RAG ] Total attachment-based results collected: ${combinedSearchResponse.length}`,
  )

  // now query the KB if agentAppEnums is provided
  if (agentAppEnums && agentAppEnums.length > 0) {
 
    // Step 1: Initialize variables to store parsed data
    let agentSpecificCollectionSelections: Array<{
      collectionIds?: string[]
      collectionFolderIds?: string[]
      collectionFileIds?: string[]
    }> = []
    let selectedItem: Partial<Record<Apps, string[]>> = {}

    // Step 2: Parse agentPrompt JSON
    if (agentPrompt) {
      loggerWithChild({ email }).info(
        `[generateAnswerFromDualRag] agentPrompt received: ${agentPrompt}`,
      )

      let agentPromptData: { appIntegrations?: any } = {}


      try {
        agentPromptData = JSON.parse(agentPrompt)
      } catch (error) {
        loggerWithChild({ email }).warn(
          "[generateAnswerFromDualRag] Failed to parse agentPrompt JSON",
          { error, agentPrompt },
        )
      }
      loggerWithChild({ email }).info(
        `[generateAnswerFromDualRag] Is app selection map: ${isAppSelectionMap(agentPromptData.appIntegrations)}`,
      )


      // Step 3: Extract collection selections
      if (isAppSelectionMap(agentPromptData.appIntegrations)) {
        const { selectedApps, selectedItems } = parseAppSelections(
          agentPromptData.appIntegrations,
        )
        
        // Debug log to see what parseAppSelections returned
        loggerWithChild({ email }).info(
          `[generateAnswerFromDualRag] selectedApps: ${JSON.stringify(selectedApps)}`,
        )
        loggerWithChild({ email }).info(
          `[generateAnswerFromDualRag] selectedItems: ${JSON.stringify(selectedItems)}`,
        )
        selectedItem = selectedItems
        
        if (selectedItems[Apps.KnowledgeBase]) {
          const kbItemIds = selectedItems[Apps.KnowledgeBase]
          
          const collectionIds: string[] = []
          const collectionFolderIds: string[] = []
          const collectionFileIds: string[] = []
          
          for (const itemId of kbItemIds) {
            if (itemId.startsWith("cl-")) {
              collectionIds.push(itemId.replace(/^cl[-_]/, ""))
            } else if (itemId.startsWith("clfd-")) {
              collectionFolderIds.push(itemId.replace(/^clfd[-_]/, ""))
            } else if (itemId.startsWith("clf-")) {
              collectionFileIds.push(
                ...expandSheetIds(itemId.replace(/^clf[-_]/, "")),
              )
            }
          }
          
          if (
            collectionIds.length > 0 ||
            collectionFolderIds.length > 0 ||
            collectionFileIds.length > 0
          ) {
            agentSpecificCollectionSelections.push({
              collectionIds: collectionIds.length > 0 ? collectionIds : undefined,
              collectionFolderIds:
                collectionFolderIds.length > 0 ? collectionFolderIds : undefined,
              collectionFileIds:
                collectionFileIds.length > 0 ? collectionFileIds : undefined,
            })
          }
          
          loggerWithChild({ email }).info(
            `[generateAnswerFromDualRag] Built collection selections: ${JSON.stringify(agentSpecificCollectionSelections)}`,
          )
        }

      }
    }

    const kbSearchSpan = generateAnswerSpan?.startSpan("kb_search")
    const channelIds = agentPrompt ? getChannelIdsFromAgentPrompt(agentPrompt) : []
    kbSearchSpan?.setAttribute("apps", agentAppEnums.join(","))
    loggerWithChild({ email: email }).info(
      `[DUAL RAG] Starting KB search. Apps to search: ${agentAppEnums.join(", ")}`,
    )

    let kbResults: VespaSearchResponse | null = null
    try {
      kbResults = await searchVespaAgent(
        builtUserQuery, // The user's question
        email, // User email for permissions
        null, // app filter - null means "use AgentApps param" (phse)
        null, // entity filter - null means "all entity types"
        agentAppEnums, // 🆕 The agent's configured apps!
        {
          limit: 6, // Max 6 results from KB
          alpha: userAlpha, // Use personalized alpha
          collectionSelections: agentSpecificCollectionSelections,
          selectedItem: selectedItem, 
          dataSourceIds: [],        // Empty array (todo: support data sources later)
          channelIds: channelIds,
          span: kbSearchSpan,       // Pass the span for tracing
        },
      )

      loggerWithChild({ email: email }).info(
        `[generateAnswerFromDualRag] KB search completed. Found ${
          kbResults?.root?.children?.length || 0
        } results`,
      )
    } catch (error) {
      loggerWithChild({ email: email }).error(
        error,
        "[generateAnswerFromDualRag] KB search failed, continuing with attachment results only",
      )
      kbResults = null // Graceful degradation
    }

    // Add KB results to the combined array
    if (kbResults?.root?.children && kbResults.root.children.length > 0) {
      combinedSearchResponse.push(...kbResults.root.children)

      loggerWithChild({ email: email }).info(
        `[DUAL RAG] Added ${kbResults.root.children.length} KB results to combined 
  array. Total results now: ${combinedSearchResponse.length}`,
      )
    } else {
      loggerWithChild({ email: email }).info(
        "[DUAL RAG] No KB results found to add",
      )
    }

    kbSearchSpan?.end()
  }


  // STEP 5: THREAD/SLACK HANDLING
  loggerWithChild({ email: email }).info(
    `generateAnswerFromDualRag - threadIds received: 
  ${JSON.stringify(threadIds)}`,
  )

  // Part A: Email thread expansion
  if (threadIds && threadIds.length > 0) {
    loggerWithChild({ email: email }).info(
      `Fetching email threads for threadIds: ${threadIds.join(", ")}`,
    )
    const threadSpan = generateAnswerSpan?.startSpan("fetch_email_threads")
    threadSpan?.setAttribute("threadIds", JSON.stringify(threadIds))

    try {
      const threadResults = await SearchEmailThreads(threadIds, email)
      loggerWithChild({ email: email }).info(
        `Thread search results: ${JSON.stringify({
          threadIds,
          resultCount: threadResults?.root?.children?.length || 0,
          hasResults: !!(
            threadResults?.root?.children &&
            threadResults.root.children.length > 0
          ),
        })}`,
      )

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
        loggerWithChild({ email: email }).info(
          `Added ${addedCount} additional emails from ${threadIds.length} threads 
  (no limits applied)`,
        )
        threadSpan?.setAttribute("added_email_count", addedCount)
        threadSpan?.setAttribute(
          "total_thread_emails_found",
          threadResults.root.children.length,
        )
        threadSpan?.setAttribute("thread_info", JSON.stringify(threadInfo))
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

  // Part B: Slack channel expansion
  const initialResults = [...(combinedSearchResponse || [])]
  for (const v of initialResults) {
    if (
      v.fields &&
      "sddocname" in v.fields &&
      v.fields.sddocname === chatContainerSchema
    ) {
      const channelId = (v.fields as any).docId
      loggerWithChild({ email: email }).info(`Processing chat container with docId: ${channelId}`)

      if (channelId) {
        const searchResults = await searchSlackInVespa(messageText, email, {
          limit: 10,
          channelIds: [channelId],
        })
        if (searchResults.root.children) {
          combinedSearchResponse.push(...searchResults.root.children)
          const threadMessages = await getThreadContext(
            searchResults,
            email,
            generateAnswerSpan,
          )
          if (threadMessages?.root?.children) {
            combinedSearchResponse.push(...threadMessages.root.children)
          }
        }
      }
    }
  }


  

  // Right now, combinedSearchResponse has:
  // [attachment1, attachment2, kb1, kb2, kb3, kb4]
  // Sort all results (both attachments and KB) by relevance score
  if (combinedSearchResponse.length > 0) {
    combinedSearchResponse.sort(
      (a, b) => Number(b.relevance ?? 0) - Number(a.relevance ?? 0),
    )

    const topScore = Number(combinedSearchResponse[0]?.relevance ?? 0).toFixed(3)
    const bottomScore = Number(combinedSearchResponse.at(-1)?.relevance ?? 0).toFixed(3)

    loggerWithChild({ email }).info(
      `[generateAnswerFromDualRag] Sorted ${combinedSearchResponse.length} results by relevance. Top: ${topScore}, Bottom: ${bottomScore}`,
    )
  }


  // STEP 6: CONTEXT BUILDING
  const startIndex = isReasoning ? previousResultsLength : 0
  // Apply intelligent chunk selection based on document relevance and chunk scores
    chunksPerDocument = await getChunkCountPerDoc(
      combinedSearchResponse,
      targetChunks,
      email,
      generateAnswerSpan,
    )
  const contextPromises = combinedSearchResponse?.map(async (v, i) => {
    let content = await answerContextMap(
      v as VespaSearchResults,
      userMetadata,
      i < chunksPerDocument.length ? chunksPerDocument[i] : 0,
      true,
      isMsgWithSources,
      message,
    )

    // Special handling for Slack channels - add creator info
    if (
      v.fields &&
      "sddocname" in v.fields &&
      v.fields.sddocname === chatContainerSchema &&
      (v.fields as any).creator
    ) {
      try {
        const creator = await getDocumentOrNull(
          chatUserSchema,
          (v.fields as any).creator,
        )
        if (creator) {
          content += `\nCreator: ${(creator.fields as any).name}`
        }
      } catch (error) {
        loggerWithChild({ email }).error(
          error,
          `Failed to fetch creator for chat container`,
        )
      }
    }
    return isMsgWithSources ? content : `Index ${i + startIndex} \n ${content}`
  })

  const resolvedContexts = contextPromises
    ? await Promise.all(contextPromises)
    : []

  const initialContext = cleanContext(resolvedContexts.join("\n"))
  const { imageFileNames } = extractImageFileNames(
    initialContext,
    combinedSearchResponse,
  )

  const finalImageFileNames = imageFileNames || []

  if (attachmentFileIds?.length) {
    finalImageFileNames.push(
      ...attachmentFileIds.map((fileid, index) => `${index}_${fileid}_${0}`),
    )
  }

  const initialContextSpan = generateAnswerSpan?.startSpan("initialContext")
  initialContextSpan?.setAttribute(
    "context_length",
    initialContext?.length || 0,
  )
  // Do not log raw context; log size/hash only
  initialContextSpan?.setAttribute("context_length_only", initialContext?.length || 0)
  initialContextSpan?.setAttribute(
    "number_of_chunks",
    combinedSearchResponse?.length || 0,
  )
  initialContextSpan?.end()


  loggerWithChild({ email: email }).info(
    `[DUAL RAG] Number of contextual chunks being passed: ${
      combinedSearchResponse.length || 0
    }`,
  )

  // STEP 7: LLM STREAMING
  const iterator = baselineRAGJsonStream(
    builtUserQuery,
    userCtx,
    userMetadata,
    initialContext,
    {
      stream: true,
      modelId: modelId ? (modelId as Models) : defaultBestModel,
      reasoning: config.isReasoning && userRequestsReasoning,
      agentPrompt,
      imageFileNames: finalImageFileNames,
    },
    true,
    isMsgWithSources,
  )

  const answer = yield* processIterator(
    iterator,
    combinedSearchResponse,
    previousResultsLength,
    userRequestsReasoning,
    email,
    isMsgWithSources,
  )

  if (answer) {
    generateAnswerSpan?.setAttribute("answer_found", true)
    generateAnswerSpan?.end()
    return
  } else if (!answer) {
    const noAnswerSpan = generateAnswerSpan?.startSpan("no_answer_response")
    yield {
      text: "From the selected context, I could not find any information to answer it, please change your query",
    }
    noAnswerSpan?.end()
    generateAnswerSpan?.end()
    return
  }

  if (config.isReasoning && userRequestsReasoning) {
    previousResultsLength += combinedSearchResponse?.length || 0
  }
  generateAnswerSpan?.end()
}

// Checks if the user has selected context
// Meaning if the query contains Pill info
export const isContextSelected = (str: string) => {
  try {
    if (str.startsWith("[{")) {
      return JSON.parse(str)
    } else {
      return null
    }
  } catch {
    return null
  }
}

export const buildUserQuery = (userQuery: UserQuery) => {
  let builtQuery = ""
  userQuery?.map((obj) => {
    if (obj?.type === "text") {
      builtQuery += `${obj?.value} `
    } else if (obj?.type === "pill") {
      builtQuery += `<User referred a file with title "${obj?.value?.title}" here> `
    } else if (obj?.type === "link") {
      builtQuery += `<User added a link with url here, this url's content is already available to you in the prompt> `
    }
  })
  return builtQuery
}

export const parseMessageText = (message: string): string => {
  if (!message.startsWith("[{")) {
    return message
  }
  try {
    const messageArray = JSON.parse(message)
    if (Array.isArray(messageArray)) {
      return messageArray
        .filter((item) => item.type === "text")
        .map((item) => item.value)
        .join(" ")
        .trim()
    }
    return message
  } catch (e) {
    return message
  }
}

const getSearchRangeSummary = (
  from: number,
  to: number,
  direction: string,
  userMetadata: UserMetadataType,
  parentSpan?: Span,
) => {
  const summarySpan = parentSpan?.startSpan("getSearchRangeSummary")
  summarySpan?.setAttribute("from", from)
  summarySpan?.setAttribute("to", to)
  summarySpan?.setAttribute("direction", direction)
  const now = Date.now()
  if ((direction === "next" || direction === "prev") && from && to) {
    // Ensure from is earlier than to
    if (from > to) {
      ;[from, to] = [to, from]
    }

    const fromDate = new Date(from)
    const toDate = new Date(to)

    const format = (date: Date) =>
      `${date.toLocaleString("default", {
        month: "long",
        timeZone: userMetadata.userTimezone,
      })} ${date.getDate()}, ${date.getFullYear()} - ${formatTime(date)}`

    const formatTime = (date: Date) => {
      const hours = date.getHours()
      const minutes = date.getMinutes()
      const ampm = hours >= 12 ? "PM" : "AM"
      const hour12 = hours % 12 === 0 ? 12 : hours % 12
      const paddedMinutes = minutes.toString().padStart(2, "0")
      return `${hour12}:${paddedMinutes} ${ampm}`
    }

    fromDate.setHours(0, 0, 0, 0)
    toDate.setHours(23, 59, 0, 0)

    return `from ${format(fromDate)} to ${format(toDate)}`
  }
  // For "next" direction, we usually start from now
  else if (direction === "next") {
    // Start from today/now
    const endDate = new Date(to)
    // Format end date to month/year if it's far in future
    const endStr =
      Math.abs(to - now) > 30 * 24 * 60 * 60 * 1000
        ? `${endDate.toLocaleString("default", {
            month: "long",
            timeZone: userMetadata.userTimezone,
          })} ${endDate.getFullYear()}`
        : getRelativeTime(to)
    const result = `from today until ${endStr}`
    summarySpan?.setAttribute("result", result)
    summarySpan?.end()
    return result
  }
  // For "prev" direction
  else {
    const startDate = new Date(from)
    const startStr =
      Math.abs(now - from) > 30 * 24 * 60 * 60 * 1000
        ? `${startDate.toLocaleString("default", {
            month: "long",
            timeZone: userMetadata.userTimezone,
          })} ${startDate.getFullYear()}`
        : getRelativeTime(from)
    const result = `from today back to ${startStr}`
    summarySpan?.setAttribute("result", result)
    summarySpan?.end()
    return result
  }
}

async function* generatePointQueryTimeExpansion(
  input: string,
  messages: Message[],
  classification: QueryRouterLLMResponse,
  email: string,
  userCtx: string,
  userMetadata: UserMetadataType,
  alpha: number,
  pageSize: number = 10,
  maxSummaryCount: number | undefined,
  userRequestsReasoning: boolean,
  eventRagSpan?: Span,
  agentPrompt?: string,
  pathExtractedInfo?: PathExtractedInfo,
  publicAgents?: SelectPublicAgent[],
): AsyncIterableIterator<
  ConverseResponse & {
    citation?: { index: number; item: any }
    imageCitation?: ImageCitation
  }
> {
  const rootSpan = eventRagSpan?.startSpan("generatePointQueryTimeExpansion")
  loggerWithChild({ email: email }).debug(
    `Started rootSpan at ${new Date().toISOString()}`,
  )
  rootSpan?.setAttribute("input", input)
  rootSpan?.setAttribute("email", email)
  rootSpan?.setAttribute("alpha", alpha)
  rootSpan?.setAttribute("pageSize", pageSize)
  rootSpan?.setAttribute("maxSummaryCount", maxSummaryCount || "none")
  rootSpan?.setAttribute("direction", classification.direction || "unknown")

  let agentAppEnums: Apps[] = []
  let agentSpecificDataSourceIds: string[] = []
  let agentSpecificCollectionSelections: Array<{
    collectionIds?: string[]
    collectionFolderIds?: string[]
    collectionFileIds?: string[]
  }> = []
  let selectedItem: Partial<Record<Apps, string[]>> = {}
  let agentAppFilters: any = {}
  if (agentPrompt) {
    let agentPromptData: { appIntegrations?: string[] } = {}
    try {
      agentPromptData = JSON.parse(agentPrompt)
    } catch (error) {
      loggerWithChild({ email: email }).warn(
        "Failed to parse agentPrompt JSON",
        { error, agentPrompt },
      )
    }

    if (
      agentPromptData.appIntegrations &&
      Array.isArray(agentPromptData.appIntegrations)
    ) {
      for (const integration of agentPromptData.appIntegrations) {
        if (typeof integration === "string") {
          const lowerIntegration = integration.toLowerCase()
          if (
            lowerIntegration.startsWith("ds-") ||
            lowerIntegration.startsWith("ds_")
          ) {
            agentSpecificDataSourceIds.push(integration)
            if (!agentAppEnums.includes(Apps.DataSource)) {
              agentAppEnums.push(Apps.DataSource)
            }
          } else {
            switch (lowerIntegration) {
              case Apps.GoogleDrive.toLowerCase():
              case "googledrive":
                if (!agentAppEnums.includes(Apps.GoogleDrive))
                  agentAppEnums.push(Apps.GoogleDrive)
                break
              case Apps.DataSource.toLowerCase():
                if (!agentAppEnums.includes(Apps.DataSource))
                  agentAppEnums.push(Apps.DataSource)
                break
              case "googlesheets":
                if (!agentAppEnums.includes(Apps.GoogleDrive))
                  agentAppEnums.push(Apps.GoogleDrive)
                break
              case Apps.Gmail.toLowerCase():
              case "gmail":
                if (!agentAppEnums.includes(Apps.Gmail))
                  agentAppEnums.push(Apps.Gmail)
                break
              case Apps.GoogleCalendar.toLowerCase():
              case "googlecalendar":
                if (!agentAppEnums.includes(Apps.GoogleCalendar))
                  agentAppEnums.push(Apps.GoogleCalendar)
                break
              case Apps.Slack.toLowerCase():
              case "slack":
                if (!agentAppEnums.includes(Apps.Slack))
                  agentAppEnums.push(Apps.Slack)
                break
              default:
                Logger.warn(
                  `Unknown integration type in agent prompt: ${integration}`,
                )
                break
            }
          }
        } else {
          loggerWithChild({ email: email }).warn(
            `Invalid integration item in agent prompt (not a string): ${integration}`,
          )
        }
      }
      agentAppEnums = [...new Set(agentAppEnums)]
    } else {
      loggerWithChild({ email: email }).warn(
        `agentPromptData.appIntegrations is not an array or is missing: ${agentPromptData}`,
      )
    }

    // parsing for the new type of integration which we are going to save
    if (isAppSelectionMap(agentPromptData.appIntegrations)) {
      const { selectedApps, selectedItems, appFilters } = parseAppSelections(
        agentPromptData.appIntegrations,
      )
      // Use selectedApps and selectedItems
      selectedItem = selectedItems
      agentAppFilters = appFilters || {}
      // agentAppEnums = selectedApps.filter(isValidApp);
      agentAppEnums = [...new Set(selectedApps)]

      // Extract collection selections from knowledge_base selections
      if (selectedItems[Apps.KnowledgeBase]) {
        const collectionIds: string[] = []
        const collectionFolderIds: string[] = []
        const collectionFileIds: string[] = []
        const source = getCollectionSource(pathExtractedInfo, selectedItems)
        for (const itemId of source) {
          if (itemId.startsWith("cl-")) {
            // Entire collection - remove cl- prefix
            collectionIds.push(itemId.replace(/^cl[-_]/, ""))
          } else if (itemId.startsWith("clfd-")) {
            // Collection folder - remove clfd- prefix
            collectionFolderIds.push(itemId.replace(/^clfd[-_]/, ""))
          } else if (itemId.startsWith("clf-")) {
            // Collection file - remove clf- prefix
            collectionFileIds.push(itemId.replace(/^clf[-_]/, ""))
          }
        }

        // Create the key-value pair object
        if (
          collectionIds.length > 0 ||
          collectionFolderIds.length > 0 ||
          collectionFileIds.length > 0
        ) {
          agentSpecificCollectionSelections.push({
            collectionIds: collectionIds.length > 0 ? collectionIds : undefined,
            collectionFolderIds:
              collectionFolderIds.length > 0 ? collectionFolderIds : undefined,
            collectionFileIds:
              collectionFileIds.length > 0 ? collectionFileIds : undefined,
          })
        }
      }
    }
  } else if (publicAgents && publicAgents.length > 0) {
    processPublicAgentsCollectionSelections(
      publicAgents,
      pathExtractedInfo,
      agentSpecificCollectionSelections,
    )
  }

  let userAlpha = await getUserPersonalizationAlpha(db, email, alpha)
  const direction = classification.direction as string

  const message = input
  const maxIterations = 10
  const weekInMs = 12 * 24 * 60 * 60 * 1000
  let costArr: number[] = []

  const { fromDate, toDate } = interpretDateFromReturnedTemporalValue(
    classification.filters,
  )

  let from = fromDate ? fromDate.getTime() : new Date().getTime()
  let to = toDate ? toDate.getTime() : new Date().getTime()
  let lastSearchedTime = direction === "prev" ? from : to

  let previousResultsLength = 0
  const loopLimit = fromDate && toDate ? 2 : maxIterations
  let starting_iteration_date = from

  for (let iteration = 0; iteration < loopLimit; iteration++) {
    // Taking the starting iteration date in a variable
    if (iteration == 0) {
      starting_iteration_date = from
    }

    const iterationSpan = rootSpan?.startSpan(`iteration_${iteration}`)
    iterationSpan?.setAttribute("iteration", iteration)
    const windowSize = (2 + iteration) * weekInMs

    if (direction === "prev") {
      // If we have both the from and to time range we search only for that range
      if (fromDate && toDate) {
        loggerWithChild({ email: email }).info(
          `Direction is ${direction} and time range is provided : from ${from} and ${to}`,
        )
      }
      // If we have either no fromDate and toDate, or a to date but no from date - then we set the from date
      else {
        to = toDate ? to : lastSearchedTime
        from = to - windowSize
        lastSearchedTime = from
      }
    } else {
      if (fromDate && toDate) {
        loggerWithChild({ email: email }).info(
          `Direction is ${direction} and time range is provided : from ${from} and ${to}`,
        )
      }
      // If we have either no fromDate and toDate, or a from date but no to date - then we set the from date
      else {
        from = fromDate ? from : lastSearchedTime
        to = from + windowSize
        lastSearchedTime = to
      }
    }

    loggerWithChild({ email: email }).info(
      `Iteration ${iteration}, searching from ${new Date(from)} to ${new Date(
        to,
      )}`,
    )
    iterationSpan?.setAttribute(
      "from",
      new Date(from).toLocaleString("en-US", {
        timeZone: userMetadata.userTimezone,
      }),
    )
    iterationSpan?.setAttribute(
      "to",
      new Date(to).toLocaleString("en-US", {
        timeZone: userMetadata.userTimezone,
      }),
    )
    // Search in both calendar events and emails
    const searchSpan = iterationSpan?.startSpan("search_vespa")
    const emailSearchSpan = searchSpan?.startSpan("email_search")
    // TODO: How to combine promise.all with spans?
    // emailSearchSpan?.setAttribute(`promise.all[eventResults, results]-${iteration}`, true)

    const calenderSearchSpan = searchSpan?.startSpan("calender_search")
    let results: VespaSearchResponse = {
      root: {
        id: "",
        relevance: 0,
        coverage: {
          coverage: 0,
          documents: 0,
          full: false,
          nodes: 0,
          results: 0,
          resultsFull: 0,
        },
        children: [],
      },
      trace: undefined,
    }
    let eventResults: VespaSearchResponse = {
      root: {
        id: "",
        relevance: 0,
        coverage: {
          coverage: 0,
          documents: 0,
          full: false,
          nodes: 0,
          results: 0,
          resultsFull: 0,
        },
        children: [],
      },
      trace: undefined,
    }
    if (!agentPrompt) {
      ;[results, eventResults] = await Promise.all([
        searchVespa(message, email, Apps.GoogleCalendar, null, {
          limit: pageSize,
          alpha: userAlpha,
          timestampRange: { from, to },
          span: calenderSearchSpan,
        }),
        searchVespa(message, email, null, null, {
          limit: pageSize,
          alpha: userAlpha,
          timestampRange: { to, from },
          notInMailLabels: ["CATEGORY_PROMOTIONS"],
          span: emailSearchSpan,
          collectionSelections: agentSpecificCollectionSelections,
        }),
      ])
    }

    if (agentPrompt) {
      if (agentAppEnums.length > 0 || agentSpecificDataSourceIds.length > 0) {
        const channelIds = getChannelIdsFromAgentPrompt(agentPrompt)
        const [agentResults, agentEventResults] = await Promise.all([
          searchVespaAgent(
            message,
            email,
            Apps.GoogleCalendar,
            null,
            agentAppEnums,
            {
              limit: pageSize,
              alpha: userAlpha,
              timestampRange: { from, to },
              span: calenderSearchSpan,
              dataSourceIds: agentSpecificDataSourceIds,
              channelIds: channelIds,
              selectedItem: selectedItem,
              appFilters: agentAppFilters,
            },
          ),
          searchVespaAgent(message, email, null, null, agentAppEnums, {
            limit: pageSize,
            alpha: userAlpha,
            timestampRange: { to, from },
            notInMailLabels: ["CATEGORY_PROMOTIONS"],
            span: emailSearchSpan,
            dataSourceIds: agentSpecificDataSourceIds,
            channelIds: channelIds,
            selectedItem: selectedItem,
            collectionSelections: agentSpecificCollectionSelections,
            appFilters: agentAppFilters,
          }),
        ])
        results.root.children = [
          ...(results.root.children || []),
          ...(agentResults.root.children || []),
        ]
        eventResults.root.children = [
          ...(eventResults.root.children || []),
          ...(agentEventResults.root.children || []),
        ]
      }
    }

    emailSearchSpan?.setAttribute(
      "result_count",
      results?.root?.children?.length || 0,
    )
    emailSearchSpan?.setAttribute(
      "result_ids",
      JSON.stringify(
        results?.root?.children?.map(
          (r: VespaSearchResult) => (r.fields as any).docId,
        ) || [],
      ),
    )
    emailSearchSpan?.setAttribute("result", JSON.stringify(results))
    emailSearchSpan?.end()
    calenderSearchSpan?.setAttribute(
      "result_count",
      eventResults?.root?.children?.length || 0,
    )
    calenderSearchSpan?.setAttribute(
      "result_ids",
      JSON.stringify(
        eventResults?.root?.children?.map(
          (r: VespaSearchResult) => (r.fields as any).docId,
        ) || [],
      ),
    )
    calenderSearchSpan?.setAttribute("result", JSON.stringify(eventResults))
    calenderSearchSpan?.end()
    searchSpan?.end()

    if (!results.root.children && !eventResults.root.children) {
      iterationSpan?.end()
      continue
    }

    // Combine and filter results
    const combineSpan = iterationSpan?.startSpan("combine_results")
    const combinedResults = {
      root: {
        children: [
          ...(results.root.children || []),
          ...(eventResults.root.children || []),
        ].filter(
          (v: VespaSearchResult) =>
            (v.fields as VespaMailSearch).app === Apps.Gmail ||
            (v.fields as VespaEventSearch).app === Apps.GoogleCalendar,
        ),
      },
    }

    combineSpan?.setAttribute(
      "combined_result_count",
      combinedResults?.root?.children?.length || 0,
    )
    combineSpan?.setAttribute(
      "combined_result_ids",
      JSON.stringify(
        combinedResults?.root?.children?.map(
          (r: VespaSearchResult) => (r.fields as any).docId,
        ) || [],
      ),
    )
    combineSpan?.end()

    if (!combinedResults.root.children.length) {
      loggerWithChild({ email: email }).info(
        "No gmail or calendar events found",
      )
      iterationSpan?.end()
      continue
    }

    // Prepare context for LLM
    const contextSpan = iterationSpan?.startSpan("build_context")
    const startIndex = isReasoning ? previousResultsLength : 0
    const initialContext = await buildContext(
      combinedResults?.root?.children,
      maxSummaryCount,
      userMetadata,
      startIndex,
      message,
    )

    const { imageFileNames } = extractImageFileNames(
      initialContext,
      combinedResults?.root?.children,
    )

    contextSpan?.setAttribute("context_length", initialContext?.length || 0)
    contextSpan?.setAttribute("context", initialContext || "")
    contextSpan?.setAttribute(
      "number_of_chunks",
      combinedResults?.root?.children?.length || 0,
    )
    contextSpan?.end()

    // Stream LLM response
    const ragSpan = iterationSpan?.startSpan("meeting_prompt_stream")
    loggerWithChild({ email: email }).info("Using meetingPromptJsonStream")
    const iterator = meetingPromptJsonStream(
      input,
      userCtx,
      userMetadata.dateForAI,
      initialContext,
      {
        stream: true,
        modelId: defaultBestModel,
        reasoning: config.isReasoning && userRequestsReasoning,
        agentPrompt,
        imageFileNames,
      },
    )

    const answer = yield* processIterator(
      iterator,
      combinedResults?.root?.children,
      previousResultsLength,
      config.isReasoning && userRequestsReasoning,
      email,
    )
    ragSpan?.end()
    if (answer) {
      ragSpan?.setAttribute("answer_found", true)
      iterationSpan?.end()
      loggerWithChild({ email: email }).debug(
        `Ending rootSpan at ${new Date().toISOString()}`,
      )
      rootSpan?.end()
      eventRagSpan?.end()
      return
    }
    // only increment in the case of reasoning
    if (config.isReasoning && userRequestsReasoning) {
      previousResultsLength += combinedResults?.root?.children?.length || 0
      iterationSpan?.setAttribute(
        "previous_results_length",
        previousResultsLength,
      )
    }

    iterationSpan?.end()
  }

  const noAnswerSpan = rootSpan?.startSpan("no_answer_response")
  const searchSummary = getSearchRangeSummary(
    starting_iteration_date,
    to,
    direction,
    userMetadata,
    noAnswerSpan,
  )
  const totalCost = costArr.reduce((a, b) => a + b, 0)
  noAnswerSpan?.setAttribute("search_summary", searchSummary)
  noAnswerSpan?.setAttribute("total_cost", totalCost)
  yield {
    text: `I searched your calendar events and emails ${searchSummary} but couldn't find any relevant meetings. Please try rephrasing your query.`,
    cost: totalCost,
  }
  noAnswerSpan?.end()
  rootSpan?.end()
  eventRagSpan?.end()
}

const formatTimeDuration = (from: number | null, to: number | null): string => {
  if (from === null && to === null) {
    return ""
  }

  const diffMs = Math.abs((to as number) - (from as number))
  const minutes = Math.floor(diffMs / (1000 * 60)) % 60
  const hours = Math.floor(diffMs / (1000 * 60 * 60)) % 24
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  let readable = ""

  if (days > 0) {
    readable += `${days} day${days !== 1 ? "s" : ""} `
  }

  if (hours > 0 || (days > 0 && minutes > 0)) {
    readable += `${hours} hour${hours !== 1 ? "s" : ""} `
  }

  if (minutes > 0 && days === 0) {
    readable += `${minutes} minute${minutes !== 1 ? "s" : ""} `
  }

  return readable.trim()
}

async function* processResultsForMetadata(
  items: VespaSearchResult[],
  input: string,
  userCtx: string,
  userMetadata: UserMetadataType,
  app: Apps[] | null,
  entity: any,
  chunksCount: number | undefined,
  userRequestsReasoning?: boolean,
  span?: Span,
  email?: string,
  agentContext?: string,
  modelId?: string,
  isMsgWithKbItems?: boolean,
) {
  if (app?.length == 1 && app[0] === Apps.GoogleDrive) {
    chunksCount = config.maxGoogleDriveSummary
    loggerWithChild({ email: email ?? "" }).info(
      `Google Drive, Chunk size: ${chunksCount}`,
    )
    span?.setAttribute("Google Drive, chunk_size", chunksCount)
  }

  // TODO: Calculate the token count for the selected model's capacity and pass the full context accordingly.
  chunksCount = 20
  span?.setAttribute(
    "Document chunk size",
    `full_context maxed to ${chunksCount}`,
  )
  const context = await buildContext(
    items,
    chunksCount,
    userMetadata,
    0,
    input,
    isMsgWithKbItems,
  )
  const { imageFileNames } = extractImageFileNames(context, items)
  const streamOptions = {
    stream: true,
    modelId: modelId ? (modelId as Models) : defaultBestModel,
    reasoning: config.isReasoning && userRequestsReasoning,
    imageFileNames,
    agentPrompt: agentContext,
  }

  let iterator: AsyncIterableIterator<ConverseResponse>
  if (app?.length == 1 && app[0] === Apps.Gmail) {
    loggerWithChild({ email: email ?? "" }).info(`Using mailPromptJsonStream `)
    iterator = mailPromptJsonStream(
      input,
      userCtx,
      userMetadata.dateForAI,
      context,
      streamOptions,
    )
  } else {
    loggerWithChild({ email: email ?? "" }).info(`Using baselineRAGJsonStream`)
    iterator = baselineRAGJsonStream(
      input,
      userCtx,
      userMetadata,
      context,
      streamOptions,
      isMsgWithKbItems,
      isMsgWithKbItems,
    )
  }

  return yield* processIterator(
    iterator,
    items,
    0,
    config.isReasoning && userRequestsReasoning,
    email,
    isMsgWithKbItems,
  )
}

async function* generateMetadataQueryAnswer(
  input: string,
  messages: Message[],
  email: string,
  userCtx: string,
  userMetadata: UserMetadataType,
  userAlpha: number = 0.5,
  pageSize: number = 10,
  maxSummaryCount: number | undefined,
  classification: QueryRouterLLMResponse,
  userRequestsReasoning?: boolean,
  span?: Span,
  agentPrompt?: string,
  maxIterations = 5,
  modelId?: string,
  pathExtractedInfo?: PathExtractedInfo,
  publicAgents?: SelectPublicAgent[],
): AsyncIterableIterator<
  ConverseResponse & {
    citation?: { index: number; item: any }
    imageCitation?: ImageCitation
  }
> {
  const {
    apps,
    entities,
    startTime,
    endTime,
    sortDirection,
    mailParticipants,
  } = classification.filters
  const count = classification.filters.count
  const direction = classification.direction as string
  const isGenericItemFetch = classification.type === QueryType.GetItems
  const isFilteredItemSearch =
    classification.type === QueryType.SearchWithFilters
  const isValidAppOrEntity =
    (apps && apps.every((a) => isValidApp(a))) ||
    (entities && entities.every((e) => isValidEntity(e)))

  let agentAppEnums: Apps[] = []
  let agentSpecificDataSourceIds: string[] = []
  let agentSpecificCollectionSelections: Array<{
    collectionIds?: string[]
    collectionFolderIds?: string[]
    collectionFileIds?: string[]
  }> = []
  let selectedItem = {}
  let agentAppFilters: any = {}
  if (agentPrompt) {
    let agentPromptData: { appIntegrations?: string[] } = {}
    try {
      agentPromptData = JSON.parse(agentPrompt)
    } catch (error) {
      loggerWithChild({ email: email }).warn(
        `Failed to parse agentPrompt JSON: ${error}, ${agentPrompt}`,
      )
    }

    if (
      agentPromptData.appIntegrations &&
      Array.isArray(agentPromptData.appIntegrations)
    ) {
      for (const integration of agentPromptData.appIntegrations) {
        if (typeof integration === "string") {
          const lowerIntegration = integration.toLowerCase()
          if (
            lowerIntegration.startsWith("ds-") ||
            lowerIntegration.startsWith("ds_")
          ) {
            agentSpecificDataSourceIds.push(integration)
            if (!agentAppEnums.includes(Apps.DataSource)) {
              agentAppEnums.push(Apps.DataSource)
            }
          } else {
            switch (lowerIntegration) {
              case Apps.GoogleDrive.toLowerCase():
              case "googledrive":
                if (!agentAppEnums.includes(Apps.GoogleDrive))
                  agentAppEnums.push(Apps.GoogleDrive)
                break
              case Apps.DataSource.toLowerCase():
                if (!agentAppEnums.includes(Apps.DataSource))
                  agentAppEnums.push(Apps.DataSource)
                break
              case "googlesheets":
                if (!agentAppEnums.includes(Apps.GoogleDrive))
                  agentAppEnums.push(Apps.GoogleDrive)
                break
              case Apps.Gmail.toLowerCase():
              case "gmail":
                if (!agentAppEnums.includes(Apps.Gmail))
                  agentAppEnums.push(Apps.Gmail)
                break
              case Apps.GoogleCalendar.toLowerCase():
              case "googlecalendar":
                if (!agentAppEnums.includes(Apps.GoogleCalendar))
                  agentAppEnums.push(Apps.GoogleCalendar)
                break
              case Apps.Slack.toLowerCase():
              case "slack":
                if (!agentAppEnums.includes(Apps.Slack))
                  agentAppEnums.push(Apps.Slack)
                break
              case Apps.KnowledgeBase.toLowerCase():
                if (!agentAppEnums.includes(Apps.KnowledgeBase))
                  agentAppEnums.push(Apps.KnowledgeBase)
                break
              default:
                loggerWithChild({ email: email }).warn(
                  `Unknown integration type in agent prompt: ${integration}`,
                )
                break
            }
          }
        } else {
          loggerWithChild({ email: email }).warn(
            `Invalid integration item in agent prompt (not a string): ${integration}`,
          )
        }
      }
      agentAppEnums = [...new Set(agentAppEnums)]
    } else {
      loggerWithChild({ email: email }).warn(
        `agentPromptData.appIntegrations is not an array or is missing: ${agentPromptData}`,
      )
    }
    // parsing for the new type of integration which we are going to save

    if (isAppSelectionMap(agentPromptData.appIntegrations)) {
      const { selectedApps, selectedItems, appFilters } = parseAppSelections(
        agentPromptData.appIntegrations,
      )
      agentAppFilters = appFilters
      // Use selectedApps and selectedItems
      selectedItem = selectedItems
      // agentAppEnums = selectedApps.filter(isValidApp);
      agentAppEnums = [...new Set(selectedApps)]

      // Extract collection selections from knowledge_base selections
      if (selectedItems[Apps.KnowledgeBase]) {
        const collectionIds: string[] = []
        const collectionFolderIds: string[] = []
        const collectionFileIds: string[] = []
        const source = getCollectionSource(pathExtractedInfo, selectedItems)
        for (const itemId of source) {
          if (itemId.startsWith("cl-")) {
            // Entire collection - remove cl- prefix
            collectionIds.push(itemId.replace(/^cl[-_]/, ""))
          } else if (itemId.startsWith("clfd-")) {
            // Collection folder - remove clfd- prefix
            collectionFolderIds.push(itemId.replace(/^clfd[-_]/, ""))
          } else if (itemId.startsWith("clf-")) {
            // Collection file - remove clf- prefix
            collectionFileIds.push(itemId.replace(/^clf[-_]/, ""))
          }
        }

        // Create the key-value pair object
        if (
          collectionIds.length > 0 ||
          collectionFolderIds.length > 0 ||
          collectionFileIds.length > 0
        ) {
          agentSpecificCollectionSelections.push({
            collectionIds: collectionIds.length > 0 ? collectionIds : undefined,
            collectionFolderIds:
              collectionFolderIds.length > 0 ? collectionFolderIds : undefined,
            collectionFileIds:
              collectionFileIds.length > 0 ? collectionFileIds : undefined,
          })
        }
      }
    }
  } else if (publicAgents && publicAgents.length > 0) {
    processPublicAgentsCollectionSelections(
      publicAgents,
      pathExtractedInfo,
      agentSpecificCollectionSelections,
    )
  }

  // Process timestamp
  const from = startTime ? new Date(startTime).getTime() : null
  const to = endTime ? new Date(endTime).getTime() : null
  const hasValidTimeRange =
    from !== null && !isNaN(from) && to !== null && !isNaN(to)

  let timestampRange: { from: number | null; to: number | null } = {
    from: null,
    to: null,
  }
  if (hasValidTimeRange) {
    // If we have a valid time range, use the provided dates
    timestampRange.from = from
    timestampRange.to = to
  } else if (direction === "next") {
    // For "next/upcoming" requests without a valid range, search from now into the future
    timestampRange.from = new Date().getTime()
  }

  const timeDescription = formatTimeDuration(
    timestampRange.from,
    timestampRange.to,
  )
  const directionText = direction === "prev" ? "going back" : "up to"

  loggerWithChild({ email: email }).info(
    `Apps : "${apps?.join(", ")}" , Entities : "${entities?.join(", ")}"` +
      (timeDescription ? `, ${directionText} ${timeDescription}` : ""),
  )
  let schema: VespaSchema[] | null = null
  if (!entities?.length && apps?.length) {
    schema = [
      ...new Set(
        apps.map((app) => appToSchemaMapper(app)).filter((s) => s !== null),
      ),
    ]
  } else if (entities?.length) {
    schema = [
      ...new Set(
        entities
          .map((entity) => entityToSchemaMapper(entity))
          .filter((s) => s !== null),
      ),
    ]
  }

  let items: VespaSearchResult[] = []

  // Determine search strategy based on conditions
  if (
    !isValidAppOrEntity &&
    classification.filterQuery &&
    classification.filters?.sortDirection === "desc"
  ) {
    let resolvedMailParticipants = mailParticipants || {}
    if (
      mailParticipants &&
      Object.keys(mailParticipants).length > 0 &&
      apps?.includes(Apps.Gmail)
    ) {
      loggerWithChild({ email: email }).info(
        `[${QueryType.SearchWithoutFilters}] Detected names in mailParticipants, resolving to emails: ${JSON.stringify(mailParticipants)}`,
      )
      resolvedMailParticipants = await resolveNamesToEmails(
        mailParticipants,
        email,
        userCtx,
        userMetadata,
        span,
      )
      loggerWithChild({ email: email }).info(
        `[${QueryType.SearchWithoutFilters}] Resolved mailParticipants: ${JSON.stringify(resolvedMailParticipants)}`,
      )
    }
    span?.setAttribute(
      "isReasoning",
      userRequestsReasoning && config.isReasoning ? true : false,
    )
    span?.setAttribute("modelId", defaultBestModel)
    loggerWithChild({ email: email }).info(
      "User requested recent metadata retrieval without specifying app or entity",
    )

    const searchOps = {
      limit: pageSize,
      alpha: userAlpha,
      rankProfile: SearchModes.GlobalSorted,
      timestampRange:
        timestampRange.to || timestampRange.from ? timestampRange : null,
      mailParticipants: resolvedMailParticipants,
    }

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const pageSpan = span?.startSpan(`search_iteration_${iteration}`)
      loggerWithChild({ email: email }).info(
        `Search Iteration - ${iteration} : ${SearchModes.GlobalSorted}`,
      )

      let searchResults: VespaSearchResponse
      if (!agentPrompt) {
        searchResults = await searchVespa(
          classification.filterQuery,
          email,
          apps ?? null,
          entities ?? null,
          {
            ...searchOps,
            limit: pageSize + pageSize * iteration,
            offset: pageSize * iteration,
            span: pageSpan,
            collectionSelections: agentSpecificCollectionSelections,
          },
        )
      } else {
        const channelIds = getChannelIdsFromAgentPrompt(agentPrompt)
        searchResults = await searchVespaAgent(
          classification.filterQuery,
          email,
          apps ?? null,
          entities ?? null,
          agentAppEnums,
          {
            ...searchOps,
            limit: pageSize + pageSize * iteration,
            offset: pageSize * iteration,
            span: pageSpan,
            dataSourceIds: agentSpecificDataSourceIds,
            channelIds: channelIds,
            selectedItem: selectedItem,
            collectionSelections: agentSpecificCollectionSelections,
            appFilters: agentAppFilters,
          },
        )
      }

      // Expand email threads in the results
      searchResults.root.children = await expandEmailThreadsInResults(
        searchResults.root.children || [],
        email,
        pageSpan,
      )

      items = searchResults.root.children || []

      loggerWithChild({ email: email }).info(
        `iteration-${iteration} retrieved documents length - ${items.length}`,
      )
      pageSpan?.setAttribute("offset", pageSize * iteration)
      pageSpan?.setAttribute(
        `iteration-${iteration} retrieved documents length`,
        items.length,
      )
      pageSpan?.setAttribute(
        `iteration-${iteration} retrieved documents id's`,
        JSON.stringify(
          items.map((v: VespaSearchResult) => (v.fields as any).docId),
        ),
      )

      pageSpan?.setAttribute(
        "context",
        await buildContext(
          items,
          20,
          userMetadata,
          0,
          input,
          agentSpecificCollectionSelections.length > 0,
        ),
      )
      if (!items.length) {
        loggerWithChild({ email: email }).info(
          `No documents found on iteration ${iteration}${
            hasValidTimeRange
              ? " within time range."
              : " falling back to iterative RAG"
          }`,
        )
        pageSpan?.end()
        yield { text: METADATA_FALLBACK_TO_RAG }
        return
      }

      const answer = yield* processResultsForMetadata(
        items,
        input,
        userCtx,
        userMetadata,
        apps,
        entities,
        undefined,
        userRequestsReasoning,
        span,
        email,
        agentPrompt,
        modelId,
        agentSpecificCollectionSelections.length > 0,
      )

      if (answer == null) {
        pageSpan?.setAttribute("answer", null)
        if (iteration == maxIterations - 1) {
          pageSpan?.end()
          yield { text: METADATA_FALLBACK_TO_RAG }
          return
        } else {
          loggerWithChild({ email: email }).info(
            `no answer found for iteration - ${iteration}`,
          )
          continue
        }
      } else {
        pageSpan?.setAttribute("answer", answer)
        pageSpan?.end()
        return answer
      }
    }

    span?.setAttribute("rank_profile", SearchModes.GlobalSorted)
    loggerWithChild({ email: email }).info(
      `Rank Profile : ${SearchModes.GlobalSorted}`,
    )
  } else if (isGenericItemFetch && isValidAppOrEntity) {
    const userSpecifiedCountLimit = count
      ? Math.min(
          count + (classification.filters.offset || 0),
          config.maxUserRequestCount,
        )
      : 5
    span?.setAttribute("Search_Type", QueryType.GetItems)
    span?.setAttribute(
      "isReasoning",
      userRequestsReasoning && config.isReasoning ? true : false,
    )
    span?.setAttribute("modelId", defaultBestModel)
    loggerWithChild({ email: email }).info(
      `Search Type : ${QueryType.GetItems}`,
    )

    let resolvedMailParticipants = mailParticipants || {}
    if (
      mailParticipants &&
      Object.keys(mailParticipants).length > 0 &&
      apps?.includes(Apps.Gmail)
    ) {
      loggerWithChild({ email: email }).info(
        `[${QueryType.SearchWithoutFilters}] Detected names in mailParticipants, resolving to emails: ${JSON.stringify(mailParticipants)}`,
      )
      resolvedMailParticipants = await resolveNamesToEmails(
        mailParticipants,
        email,
        userCtx,
        userMetadata,
        span,
      )
      loggerWithChild({ email: email }).info(
        `[${QueryType.SearchWithoutFilters}] Resolved mailParticipants: ${JSON.stringify(resolvedMailParticipants)}`,
      )
    }

    if (!schema) {
      loggerWithChild({ email: email }).error(
        `[generateMetadataQueryAnswer] Could not determine a valid schema for apps: ${JSON.stringify(apps)}, entities: ${JSON.stringify(entities)}`,
      )
      span?.setAttribute("error", "Schema determination failed")
      span?.setAttribute("apps_for_schema_failure", JSON.stringify(apps))
      span?.setAttribute(
        "entities_for_schema_failure",
        JSON.stringify(entities),
      )

      yield { text: METADATA_FALLBACK_TO_RAG }
      return
    }
    let searchResults
    items = []
    if (agentPrompt) {
      const agentApps = agentAppEnums.filter((a) => apps?.includes(a))
      if (agentSpecificCollectionSelections.length) {
        agentApps.push(Apps.KnowledgeBase)
        schema.push(KbItemsSchema)
      }
      if (agentApps.length) {
        loggerWithChild({ email: email }).info(
          `[GetItems] Calling getItems with agent prompt - Schema: ${schema}, App: ${agentApps?.map((a) => a).join(", ")}, Entity: ${entities?.map((e) => e).join(", ")}, mailParticipants: ${JSON.stringify(classification.filters.mailParticipants)}`,
        )
        const channelIds = getChannelIdsFromAgentPrompt(agentPrompt)
        searchResults = await getItems({
          email,
          schema,
          app: agentApps ?? null,
          entity: entities ?? null,
          timestampRange,
          limit: userSpecifiedCountLimit + (classification.filters.offset || 0),
          offset: classification.filters.offset || 0,
          asc: sortDirection === "asc",
          mailParticipants: resolvedMailParticipants || {},
          channelIds,
          selectedItem: selectedItem,
          collectionSelections: agentSpecificCollectionSelections,
          appFilters: agentAppFilters,
        })
        items = searchResults!.root.children || []
        loggerWithChild({ email: email }).info(
          `[GetItems] Agent query completed - Retrieved ${items.length} items`,
        )
      }
    } else {
      loggerWithChild({ email: email }).info(
        `[GetItems] Calling getItems - Schema: ${schema}, App: ${apps?.map((a) => a).join(", ")}, Entity: ${entities?.map((e) => e).join(", ")}, mailParticipants: ${JSON.stringify(classification.filters.mailParticipants)}`,
      )

      const getItemsParams = {
        email,
        schema,
        app: apps ?? null,
        entity: entities ?? null,
        timestampRange,
        limit: userSpecifiedCountLimit + (classification.filters.offset || 0),
        offset: classification.filters.offset || 0,
        asc: sortDirection === "asc",
        mailParticipants: resolvedMailParticipants || {},
        collectionSelections: agentSpecificCollectionSelections,
        selectedItem: selectedItem,
      }

      loggerWithChild({ email: email }).info(
        `[GetItems] Query parameters: ${JSON.stringify(getItemsParams)}`,
      )

      searchResults = (await getItems(getItemsParams)) as VespaSearchResponse
      items = searchResults!.root.children || []
      loggerWithChild({ email: email }).info(
        `[GetItems] Query completed - Retrieved ${items.length} items`,
      )
    }

    // Skip thread expansion for GetItems - we want exactly what was requested
    // Thread expansion is only for search-based queries, not concrete item retrieval
    if (!isGenericItemFetch && searchResults) {
      searchResults.root.children = await expandEmailThreadsInResults(
        searchResults.root.children || [],
        email,
        span,
      )
      items = searchResults.root.children || []
    }

    span?.setAttribute(`retrieved documents length`, items.length)
    span?.setAttribute(
      `retrieved documents id's`,
      JSON.stringify(
        items.map((v: VespaSearchResult) => (v.fields as any).docId),
      ),
    )

    span?.setAttribute(
      "context",
      await buildContext(
        items,
        20,
        userMetadata,
        0,
        input,
        agentSpecificCollectionSelections.length > 0,
      ),
    )
    span?.end()
    loggerWithChild({ email: email }).info(
      `Retrieved Documents : ${QueryType.GetItems} - ${items.length}`,
    )
    // Early return if no documents found
    if (!items.length) {
      span?.end()
      loggerWithChild({ email: email }).info(
        "No documents found for unspecific metadata retrieval",
      )
      yield { text: METADATA_NO_DOCUMENTS_FOUND }
      return
    }

    span?.end()
    yield* processResultsForMetadata(
      items,
      input,
      userCtx,
      userMetadata,
      apps,
      entities,
      maxSummaryCount,
      userRequestsReasoning,
      span,
      email,
      agentPrompt,
      modelId,
      agentSpecificCollectionSelections.length > 0,
    )
    return
  } else if (
    isFilteredItemSearch &&
    isValidAppOrEntity &&
    classification.filterQuery
  ) {
    // Specific metadata retrieval
    span?.setAttribute("Search_Type", QueryType.SearchWithFilters)
    span?.setAttribute(
      "isReasoning",
      userRequestsReasoning && config.isReasoning ? true : false,
    )
    span?.setAttribute("modelId", defaultBestModel)
    loggerWithChild({ email: email }).info(
      `Search Type : ${QueryType.SearchWithFilters}`,
    )

    const { filterQuery } = classification
    const query = filterQuery
    const rankProfile =
      sortDirection === "desc"
        ? SearchModes.GlobalSorted
        : SearchModes.NativeRank

    let resolvedMailParticipants = {} as MailParticipant
    if (
      mailParticipants &&
      Object.keys(mailParticipants).length > 0 &&
      apps?.includes(Apps.Gmail)
    ) {
      loggerWithChild({ email: email }).info(
        `[SearchWithFilters] Detected names in mailParticipants, resolving to emails: ${JSON.stringify(mailParticipants)}`,
      )
      resolvedMailParticipants = await resolveNamesToEmails(
        mailParticipants,
        email,
        userCtx,
        userMetadata,
        span,
      )
      loggerWithChild({ email: email }).info(
        `[SearchWithFilters] Resolved mailParticipants: ${JSON.stringify(resolvedMailParticipants)}`,
      )
    }

    const searchOptions = {
      limit: pageSize,
      alpha: userAlpha,
      rankProfile,
      timestampRange:
        timestampRange.to || timestampRange.from ? timestampRange : null,
      mailParticipants: resolvedMailParticipants,
    }

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const iterationSpan = span?.startSpan(`search_iteration_${iteration}`)
      loggerWithChild({ email: email }).info(
        `Search ${QueryType.SearchWithFilters} Iteration - ${iteration} : ${rankProfile}`,
      )

      let searchResults: VespaSearchResponse
      if (!agentPrompt) {
        searchResults = await searchVespa(
          query,
          email,
          apps ?? null,
          entities ?? null,
          {
            ...searchOptions,
            limit: pageSize + pageSize * iteration,
            offset: pageSize * iteration,
            collectionSelections: agentSpecificCollectionSelections,
          },
        )
      } else {
        const channelIds = getChannelIdsFromAgentPrompt(agentPrompt)
        searchResults = await searchVespaAgent(
          query,
          email,
          apps ?? null,
          entities ?? null,
          agentAppEnums,
          {
            ...searchOptions,
            offset: pageSize * iteration,
            limit: pageSize + pageSize * iteration,
            dataSourceIds: agentSpecificDataSourceIds,
            channelIds: channelIds,
            selectedItem: selectedItem,
            collectionSelections: agentSpecificCollectionSelections,
            appFilters: agentAppFilters,
          },
        )
      }

      // Expand email threads in the results
      searchResults.root.children = await expandEmailThreadsInResults(
        searchResults.root.children || [],
        email,
        iterationSpan,
      )

      items = searchResults.root.children || []

      loggerWithChild({ email: email }).info(`Rank Profile : ${rankProfile}`)

      iterationSpan?.setAttribute("offset", pageSize * iteration)
      iterationSpan?.setAttribute("rank_profile", rankProfile)

      iterationSpan?.setAttribute(
        `iteration - ${iteration} retrieved documents length`,
        items.length,
      )
      iterationSpan?.setAttribute(
        `iteration-${iteration} retrieved documents id's`,
        JSON.stringify(
          items.map((v: VespaSearchResult) => (v.fields as any).docId),
        ),
      )
      iterationSpan?.setAttribute(
        `context`,
        await buildContext(
          items,
          20,
          userMetadata,
          0,
          input,
          agentSpecificCollectionSelections.length > 0,
        ),
      )
      iterationSpan?.end()

      loggerWithChild({ email: email }).info(
        `Number of documents for ${QueryType.SearchWithFilters} = ${items.length}`,
      )
      if (!items.length) {
        loggerWithChild({ email: email }).info(
          `No documents found on iteration ${iteration}${
            hasValidTimeRange
              ? " within time range."
              : " falling back to iterative RAG"
          }`,
        )
        iterationSpan?.end()
        yield { text: METADATA_FALLBACK_TO_RAG }
        return
      }

      const answer = yield* processResultsForMetadata(
        items,
        input,
        userCtx,
        userMetadata,
        apps,
        entities,
        undefined,
        userRequestsReasoning,
        span,
        email,
        agentPrompt,
        modelId,
        agentSpecificCollectionSelections.length > 0,
      )

      if (answer == null) {
        iterationSpan?.setAttribute("answer", null)
        if (iteration == maxIterations - 1) {
          iterationSpan?.end()
          yield { text: METADATA_FALLBACK_TO_RAG }
          return
        } else {
          loggerWithChild({ email: email }).info(
            `no answer found for iteration - ${iteration}`,
          )
          continue
        }
      } else {
        iterationSpan?.end()
        return answer
      }
    }
  } else {
    // None of the conditions matched
    yield { text: METADATA_FALLBACK_TO_RAG }
    return
  }
}

const fallbackText = (classification: QueryRouterLLMResponse): string => {
  const { apps, entities } = classification.filters
  const direction = classification.direction || ""
  const { startTime, endTime } = classification.filters
  const from = new Date(startTime ?? "").getTime()
  const to = new Date(endTime ?? "").getTime()
  const timePhrase = formatTimeDuration(from, to)

  let searchDescription = ""

  // Handle apps array
  if (apps && apps.length > 0) {
    const appNames = apps
      .map((a) => {
        switch (a) {
          case Apps.Gmail:
            return "emails"
          case Apps.GoogleCalendar:
            return "calendar events"
          case Apps.GoogleDrive:
            return "files"
          case Apps.GoogleWorkspace:
            return "contacts"
          default:
            return "items"
        }
      })
      .join(", ")
    searchDescription = appNames
  } else if (entities && entities.length > 0) {
    const entityNames = entities
      .map((e) => {
        switch (e) {
          case "mail":
            return "emails"
          case "event":
            return "calendar events"
          case "driveFile":
            return "files"
          case "docs":
            return "Google Docs"
          case "sheets":
            return "Google Sheets"
          case "slides":
            return "Google Slides"
          case "pdf":
            return "PDF files"
          case "folder":
            return "folders"
          case GooglePeopleEntity.Contacts:
            return "contacts"
          default:
            return "items"
        }
      })
      .join(", ")
    searchDescription = entityNames
  } else {
    searchDescription = "information"
  }

  let timeDescription = ""
  if (timePhrase) {
    if (direction === "prev") {
      timeDescription = ` from the past ${timePhrase}`
    } else if (direction === "next") {
      timeDescription = ` for the next ${timePhrase}`
    } else {
      timeDescription = ` within that time period`
    }
  }

  return `${searchDescription}${timeDescription}`
}

export type PathExtractedInfo = {
  collectionFileIds: string[]
  collectionFolderIds: string[]
  collectionIds: string[]
}

export function getCollectionSource(
  pathExtractedInfo: PathExtractedInfo | undefined,
  selectedItems: Record<string, any>,
): string[] {
  if (
    pathExtractedInfo &&
    (pathExtractedInfo.collectionFileIds.length ||
      pathExtractedInfo.collectionFolderIds.length ||
      pathExtractedInfo.collectionIds.length)
  ) {
    if (pathExtractedInfo.collectionFolderIds.length) {
      return pathExtractedInfo.collectionFolderIds
    } else if (pathExtractedInfo.collectionFileIds.length) {
      return pathExtractedInfo.collectionFileIds
    } else {
      return pathExtractedInfo.collectionIds
    }
  } else {
    return selectedItems[Apps.KnowledgeBase] || []
  }
}

function processPublicAgentsCollectionSelections(
  publicAgents: SelectPublicAgent[],
  pathExtractedInfo: PathExtractedInfo | undefined,
  agentSpecificCollectionSelections: Array<{
    collectionIds?: string[]
    collectionFolderIds?: string[]
    collectionFileIds?: string[]
  }>,
): void {
  // Iterate through all public agent prompts and gather app integrations
  for (const publicAgent of publicAgents) {
    if (!publicAgent) continue

    // parsing for the new type of integration which we are going to save
    if (isAppSelectionMap(publicAgent.appIntegrations)) {
      const { selectedItems } = parseAppSelections(publicAgent.appIntegrations)

      // Extract collection selections from knowledge_base selections
      if (selectedItems[Apps.KnowledgeBase]) {
        const collectionIds: string[] = []
        const collectionFolderIds: string[] = []
        const collectionFileIds: string[] = []
        const source = getCollectionSource(pathExtractedInfo, selectedItems)
        for (const itemId of source) {
          if (itemId.startsWith("cl-")) {
            // Entire collection - remove cl- prefix
            collectionIds.push(itemId.replace(/^cl[-_]/, ""))
          } else if (itemId.startsWith("clfd-")) {
            // Collection folder - remove clfd- prefix
            collectionFolderIds.push(itemId.replace(/^clfd[-_]/, ""))
          } else if (itemId.startsWith("clf-")) {
            // Collection file - remove clf- prefix
            collectionFileIds.push(itemId.replace(/^clf[-_]/, ""))
          }
        }

        // Create or add to the first agent specific collection selection in the key-value pair object
        if (
          collectionIds.length > 0 ||
          collectionFolderIds.length > 0 ||
          collectionFileIds.length > 0
        ) {
          if (agentSpecificCollectionSelections.length === 0) {
            // Create the first agent specific collection selection if it doesn't exist
            agentSpecificCollectionSelections.push({
              collectionIds:
                collectionIds.length > 0 ? collectionIds : undefined,
              collectionFolderIds:
                collectionFolderIds.length > 0
                  ? collectionFolderIds
                  : undefined,
              collectionFileIds:
                collectionFileIds.length > 0 ? collectionFileIds : undefined,
            })
          } else {
            // Add the other agent specific collection selections with deduplication using Sets
            const collectionSelection = agentSpecificCollectionSelections[0]
            if (collectionIds.length > 0) {
              const existingIds = new Set(
                collectionSelection.collectionIds || [],
              )
              collectionIds.forEach((id) => existingIds.add(id))
              collectionSelection.collectionIds = Array.from(existingIds)
            }
            if (collectionFolderIds.length > 0) {
              const existingFolderIds = new Set(
                collectionSelection.collectionFolderIds || [],
              )
              collectionFolderIds.forEach((id) => existingFolderIds.add(id))
              collectionSelection.collectionFolderIds =
                Array.from(existingFolderIds)
            }
            if (collectionFileIds.length > 0) {
              const existingFileIds = new Set(
                collectionSelection.collectionFileIds || [],
              )
              collectionFileIds.forEach((id) => existingFileIds.add(id))
              collectionSelection.collectionFileIds =
                Array.from(existingFileIds)
            }
          }
        }
      }
    }
  }
}

export async function* UnderstandMessageAndAnswer(
  email: string,
  userCtx: string,
  userMetadata: UserMetadataType,
  message: string,
  classification: QueryRouterLLMResponse,
  messages: Message[],
  alpha: number,
  userRequestsReasoning: boolean,
  passedSpan?: Span,
  agentPrompt?: string,
  modelId?: string,
  pathExtractedInfo?: PathExtractedInfo,
  publicAgents?: SelectPublicAgent[],
): AsyncIterableIterator<
  ConverseResponse & {
    citation?: { index: number; item: any }
    imageCitation?: ImageCitation
  }
> {
  passedSpan?.setAttribute("email", email)
  passedSpan?.setAttribute("message", message)
  passedSpan?.setAttribute(
    "temporal_direction",
    classification.direction || "none",
  )
  passedSpan?.setAttribute("alpha", alpha)
  passedSpan?.setAttribute("message_count", messages.length)

  const isGenericItemFetch = classification.type === QueryType.GetItems

  const isFilteredItemSearch =
    classification.type === QueryType.SearchWithFilters

  const isFilteredSearchSortedByRecency =
    classification.filterQuery &&
    classification.filters.sortDirection === "desc"

  if (isGenericItemFetch || isFilteredItemSearch) {
    loggerWithChild({ email: email }).info("Metadata Retrieval")

    const metadataRagSpan = passedSpan?.startSpan("metadata_rag")
    metadataRagSpan?.setAttribute("comment", "metadata retrieval")
    metadataRagSpan?.setAttribute(
      "classification",
      JSON.stringify(classification),
    )

    const count = classification.filters.count || chatPageSize

    const answerIterator = generateMetadataQueryAnswer(
      message,
      messages,
      email,
      userCtx,
      userMetadata,
      alpha,
      count,
      maxDefaultSummary,
      classification,
      config.isReasoning && userRequestsReasoning,
      metadataRagSpan,
      agentPrompt,
      5,
      modelId,
      pathExtractedInfo,
      publicAgents,
    )

    let hasYieldedAnswer = false
    for await (const answer of answerIterator) {
      if (answer.text === METADATA_NO_DOCUMENTS_FOUND) {
        return yield {
          text: `I couldn't find any ${fallbackText(
            classification,
          )}. Would you like to try a different search?`,
        }
      } else if (answer.text === METADATA_FALLBACK_TO_RAG) {
        loggerWithChild({ email: email }).info(
          "No context found for metadata retrieval, moving to iterative RAG",
        )
        hasYieldedAnswer = false
      } else {
        hasYieldedAnswer = true
        yield answer
      }
    }

    metadataRagSpan?.end()
    if (hasYieldedAnswer) return
  }

  if (
    classification.direction !== null &&
    classification.filters.apps?.includes(Apps.GoogleCalendar)
  ) {
    // user is talking about an event
    loggerWithChild({ email: email }).info(
      `Direction : ${classification.direction}`,
    )
    const eventRagSpan = passedSpan?.startSpan("event_time_expansion")
    eventRagSpan?.setAttribute("comment", "event time expansion")
    return yield* generatePointQueryTimeExpansion(
      message,
      messages,
      classification,
      email,
      userCtx,
      userMetadata,
      alpha,
      chatPageSize,
      maxDefaultSummary,
      userRequestsReasoning,
      eventRagSpan,
      agentPrompt,
      pathExtractedInfo,
      publicAgents,
    )
  } else {
    loggerWithChild({ email: email }).info(
      "Iterative Rag : Query rewriting and time filtering",
    )
    const ragSpan = passedSpan?.startSpan("iterative_rag")
    ragSpan?.setAttribute("comment", "iterative rag")
    // default case
    return yield* generateIterativeTimeFilterAndQueryRewrite(
      message,
      messages,
      email,
      userCtx,
      userMetadata,
      alpha,
      chatPageSize,
      3,
      maxDefaultSummary,
      classification,
      userRequestsReasoning,
      ragSpan,
      agentPrompt, // Pass agentPrompt to generateIterativeTimeFilterAndQueryRewrite
      pathExtractedInfo,
      publicAgents,
    )
  }
}

export async function* UnderstandMessageAndAnswerForGivenContext(
  email: string,
  userCtx: string,
  userMetadata: UserMetadataType,
  message: string,
  alpha: number,
  fileIds: string[],
  userRequestsReasoning: boolean,
  passedSpan?: Span,
  threadIds?: string[],
  attachmentFileIds?: string[],
  agentPrompt?: string,
  isMsgWithKbItems?: boolean,
  modelId?: string,
  isValidPath?: boolean,
  folderIds?: string[],
  messages: Message[] = [],
): AsyncIterableIterator<
  ConverseResponse & {
    citation?: { index: number; item: any }
    imageCitation?: ImageCitation
  }
> {
  passedSpan?.setAttribute("email", email)
  passedSpan?.setAttribute("message", message)
  passedSpan?.setAttribute("alpha", alpha)
  passedSpan?.setAttribute("fileIds", JSON.stringify(fileIds))
  passedSpan?.setAttribute("fileIds_count", fileIds?.length)
  passedSpan?.setAttribute("threadIds", JSON.stringify(threadIds))
  passedSpan?.setAttribute("threadIds_count", threadIds?.length || 0)
  passedSpan?.setAttribute(
    "userRequestsReasoning",
    userRequestsReasoning || false,
  )

  return yield* generateAnswerFromGivenContext(
    message,
    email,
    userCtx,
    userMetadata,
    alpha,
    fileIds,
    userRequestsReasoning,
    agentPrompt,
    passedSpan,
    threadIds,
    attachmentFileIds,
    isMsgWithKbItems,
    modelId,
    isValidPath,
    folderIds,
    messages,
  )
}

const handleError = (error: any) => {
  let errorMessage = "Something went wrong. Please try again."
  if (error?.code === OpenAIError.RateLimitError) {
    errorMessage = "Rate limit exceeded. Please try again later."
  } else if (error?.code === OpenAIError.InvalidAPIKey) {
    errorMessage =
      "Invalid API key provided. Please check your API key and ensure it is correct."
  } else if (
    error?.name === "ThrottlingException" ||
    error?.message === "Too many tokens, please wait before trying again." ||
    error?.$metadata?.httpStatusCode === 429
  ) {
    errorMessage = "Rate limit exceeded. Please try again later."
  } else if (
    error?.name === "ValidationException" ||
    error?.message ===
      "The model returned the following errors: Input is too long for requested model."
  ) {
    errorMessage = "Input context is too large."
  }
  return errorMessage
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

function formatMessagesForLLM(
  msgs: SelectMessage[],
): { role: ConversationRole; content: { text: string }[] }[] {
  return msgs.map((msg) => {
    // If any message from the messagesWithNoErrResponse is a user message, has fileIds and its message is JSON parsable
    // then we should not give that exact stringified message as history
    // We convert it into a AI friendly string only for giving it to LLM
    const fileIds = Array.isArray(msg?.fileIds) ? msg.fileIds : []
    if (msg.messageRole === "user" && fileIds && fileIds.length > 0) {
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
}

function buildTopicConversationThread(
  messages: SelectMessage[],
  currentMessageIndex: number,
) {
  const conversationThread = []
  let index = currentMessageIndex

  while (index >= 0) {
    const message = messages[index]

    if (
      message.messageRole === MessageRole.User &&
      message.queryRouterClassification
    ) {
      const classification =
        typeof message.queryRouterClassification === "string"
          ? JSON.parse(message.queryRouterClassification)
          : message.queryRouterClassification

      // If this message is NOT a follow-up, it means we've hit a topic boundary
      if (!classification.isFollowUp) {
        // Include this message as it's the start of the current topic thread
        conversationThread.unshift(message)
        break
      }
    }

    conversationThread.unshift(message)
    index--
  }

  return conversationThread
}
/**
 * MessageApi - Main chat endpoint with intelligent routing
 *
 * Routes chat requests to specialized handlers based on configuration:
 * - MessageWithToolsApi: For agentic mode without web search
 * - AgentMessageApi: For agent conversations
 * - Default RAG flow: For standard chat with search capabilities
 *
 * Features:
 * - Model config parsing (reasoning, websearch, deepResearch)
 * - Attachment handling (images and documents)
 * - Real-time streaming with Server-Sent Events
 * - Agent permission checks and context extraction
 * - Cost tracking and comprehensive error handling
 *
 * @param c - Hono context with request data and JWT payload
 * @returns StreamSSE response with real-time chat data
 * @throws HTTPException(400) - Invalid model or missing parameters
 * @throws HTTPException(403) - Agent access denied
 * @throws HTTPException(500) - Server errors or model failures
 */
export const MessageApi = async (c: Context) => {
  // we will use this in catch
  // if the value exists then we send the error to the frontend via it

  const tracer: Tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("MessageApi")

  let stream: any
  let chat: SelectChat
  let assistantMessageId: string | null = null
  let streamKey: string | null = null
  let email = ""

  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    email = sub
    loggerWithChild({ email: email }).info("MessageApi Chats..")
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

    // @ts-ignore
    const body = c.req.valid("query")
    const isAgentic = c.req.query("agentic") === "true"
    let { message, chatId, selectedModelConfig, agentId }: MessageReqType = body

    // Parse selectedModelConfig JSON to extract individual values
    let modelId: string | undefined = undefined
    let isReasoningEnabled = false
    let enableWebSearch = false
    let isDeepResearchEnabled = false

    if (selectedModelConfig) {
      try {
        const config = JSON.parse(selectedModelConfig)
        modelId = config.model

        // Handle new direct boolean format
        isReasoningEnabled = config.reasoning === true
        enableWebSearch = config.websearch === true
        isDeepResearchEnabled = config.deepResearch === true

        // For deep research, always use Claude Sonnet 4 regardless of UI selection
        if (isDeepResearchEnabled) {
          modelId = "Claude Sonnet 4"
          loggerWithChild({ email: email }).info(
            `Deep research enabled - forcing model to Claude Sonnet 4`,
          )
        }

        // Check capabilities - handle both array and object formats for backward compatibility
        if (
          config.capabilities &&
          !isReasoningEnabled &&
          !enableWebSearch &&
          !isDeepResearchEnabled
        ) {
          if (Array.isArray(config.capabilities)) {
            // Array format: ["reasoning", "websearch"]
            isReasoningEnabled = config.capabilities.includes("reasoning")
            enableWebSearch = config.capabilities.includes("websearch")
            isDeepResearchEnabled = config.capabilities.includes("deepResearch")
          } else if (typeof config.capabilities === "object") {
            // Object format: { reasoning: true, websearch: false }
            isReasoningEnabled = config.capabilities.reasoning === true
            enableWebSearch = config.capabilities.websearch === true
            isDeepResearchEnabled = config.capabilities.deepResearch === true
          }

          // For deep research from old format, also force Claude Sonnet 4
          if (isDeepResearchEnabled) {
            modelId = "Claude Sonnet 4"
          }
        }

        loggerWithChild({ email: email }).info(
          `Parsed model config: model="${modelId}", reasoning=${isReasoningEnabled}, websearch=${enableWebSearch}, deepResearch=${isDeepResearchEnabled}`,
        )
      } catch (e) {
        loggerWithChild({ email: email }).warn(
          `Failed to parse selectedModelConfig JSON: ${e}. Using defaults.`,
        )
        modelId = config.defaultBestModel // fallback
      }
    } else {
      // Fallback if no model config provided
      modelId = config.defaultBestModel
      loggerWithChild({ email: email }).info(
        "No model config provided, using default",
      )
    }
    // Convert modelId from friendly label to actual model value
    let actualModelId: string = modelId || config.defaultBestModel // Ensure we always have a string
    if (modelId) {
      const convertedModelId = getModelValueFromLabel(modelId)
      if (convertedModelId) {
        actualModelId = convertedModelId as string // Can be Models enum or string
        loggerWithChild({ email: email }).info(
          `Converted model label "${modelId}" to value "${actualModelId}"`,
        )
      } else if (modelId in Models) {
        actualModelId = modelId // Use the raw model ID if it exists in Models enum
        loggerWithChild({ email: email }).info(
          `Using model ID "${modelId}" directly as it exists in Models enum`,
        )
      } else {
        loggerWithChild({ email: email }).error(
          `Invalid model: ${modelId}. Model not found in label mappings or Models enum.`,
        )
        throw new HTTPException(400, { message: `Invalid model: ${modelId}` })
      }
    }
    const webSearchEnabled = enableWebSearch ?? false
    const deepResearchEnabled = isDeepResearchEnabled ?? false
    const agentPromptValue =
      agentId && (isCuid(agentId) || agentId === DEFAULT_TEST_AGENT_ID)
        ? agentId
        : undefined // Use undefined if not a valid CUID
    if (isAgentic && !enableWebSearch && !deepResearchEnabled) {
      Logger.info(`Routing to MessageWithToolsApi`)
      return MessageWithToolsApi(c)
    }

    let attachmentMetadata = parseAttachmentMetadata(c)
    let imageAttachmentFileIds = attachmentMetadata
      .filter((m) => m.isImage)
      .map((m) => m.fileId)
    const nonImageAttachmentFileIds = attachmentMetadata
      .filter((m) => !m.isImage)
      .flatMap((m) => expandSheetIds(m.fileId))

    if (agentPromptValue) {
      const userAndWorkspaceCheck = await getUserAndWorkspaceByEmail(
        db,
        workspaceId,
        email,
      )
      const agentDetails = await getAgentByExternalId(
        db,
        agentPromptValue,
        userAndWorkspaceCheck.workspace.id,
      )

      if (
        !isAgentic &&
        !enableWebSearch &&
        !deepResearchEnabled &&
        (agentDetails || agentPromptValue === DEFAULT_TEST_AGENT_ID)
      ) {
        Logger.info(`Routing to AgentMessageApi for agent ${agentPromptValue}.`)
        return AgentMessageApi(c)
      }
    }

    let agentDetails: SelectAgent | null = null
    let numericWorkspaceId: number | undefined
    if (agentPromptValue) {
      const userAndWorkspaceCheck = await getUserAndWorkspaceByEmail(
        db,
        workspaceId,
        email,
      )
      numericWorkspaceId = userAndWorkspaceCheck.workspace.id
      agentDetails = await getAgentByExternalId(
        db,
        agentPromptValue,
        numericWorkspaceId,
      )
    } else {
      // Get workspace ID even if we don't have an agent prompt value
      const userAndWorkspaceCheck = await getUserAndWorkspaceByEmail(
        db,
        workspaceId,
        email,
      )
      numericWorkspaceId = userAndWorkspaceCheck.workspace.id
    }

    // get all the public agents for the workspace
    // here we are using workspaceId instead of workspaceExternalId as agents table has workspaceId as foreign key
    const publicAgents: SelectPublicAgent[] = numericWorkspaceId
      ? await getAllPublicAgents(db, numericWorkspaceId)
      : []

    // If none of the above, proceed with default RAG flow
    const userRequestsReasoning = isReasoningEnabled
    if (!message) {
      throw new HTTPException(400, {
        message: "Message is required",
      })
    }
    message = decodeURIComponent(message)
    rootSpan.setAttribute("message", message)

    // Extract sources from search parameters
    const kbItems = c.req.query("selectedKbItems")
    const isMsgWithKbItems = !!kbItems
    let fileIds: string[] = []
    if (kbItems) {
      try {
        const resp = await getCollectionFilesVespaIds(JSON.parse(kbItems), db)
        fileIds = resp
          .flatMap((file) => expandSheetIds(file.vespaDocId || ""))
          .filter((id) => id !== "")
      } catch {
        fileIds = []
      }
    }
    const isMsgWithContext = isMessageWithContext(message)
    const extractedInfo = isMsgWithContext
      ? await extractFileIdsFromMessage(message, email)
      : {
          totalValidFileIdsFromLinkCount: 0,
          fileIds: [],
          threadIds: [],
        }
    if (extractedInfo?.fileIds.length > 0) {
      fileIds = fileIds.concat(extractedInfo?.fileIds)
    }
    if (nonImageAttachmentFileIds && nonImageAttachmentFileIds.length > 0) {
      fileIds = fileIds.concat(nonImageAttachmentFileIds)
    }
    const threadIds = extractedInfo?.threadIds || []
    const totalValidFileIdsFromLinkCount =
      extractedInfo?.totalValidFileIdsFromLinkCount

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const { user, workspace } = userAndWorkspace
    let messages: SelectMessage[] = []
    const costArr: number[] = []
    const tokenArr: { inputTokens: number; outputTokens: number }[] = []
    const ctx = userContext(userAndWorkspace)
    const userTimezone = user?.timeZone || "Asia/Kolkata"
    const dateForAI = getDateForAI({ userTimeZone: userTimezone })
    const userMetadata: UserMetadataType = { userTimezone, dateForAI }
    let chat: SelectChat

    const chatCreationSpan = rootSpan.startSpan("chat_creation")

    let title = ""
    let attachmentStorageError: Error | null = null
    if (!chatId) {
      let [insertedChat, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage]> => {
          const chat = await insertChat(tx, {
            workspaceId: workspace.id,
            workspaceExternalId: workspace.externalId,
            userId: user.id,
            email: user.email,
            title: "Untitled",
            attachments: [],
            agentId: agentPromptValue,
            chatType: isMsgWithKbItems ? ChatType.KbChat : ChatType.Default,
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
            modelId: actualModelId || config.defaultBestModel,
            fileIds: fileIds,
          })

          // Store attachment metadata for user message if attachments exist
          if (attachmentMetadata && attachmentMetadata.length > 0) {
            try {
              await storeAttachmentMetadata(
                tx,
                insertedMsg.externalId,
                attachmentMetadata,
                email,
              )
            } catch (error) {
              attachmentStorageError = error as Error
              loggerWithChild({ email: email }).error(
                error,
                `Failed to store attachment metadata for user message ${insertedMsg.externalId}`,
              )
            }
          }

          return [chat, insertedMsg]
        },
      )
      loggerWithChild({ email: email }).info(
        "First mesage of the conversation, successfully created the chat",
      )
      chat = insertedChat
      messages.push(insertedMsg) // Add the inserted message to messages array
      chatCreationSpan.end()
    } else {
      let [existingChat, allMessages, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage[], SelectMessage]> => {
          // we are updating the chat and getting it's value in one call itself

          let existingChat = await updateChatByExternalIdWithAuth(
            db,
            chatId,
            email,
            {},
          )
          let allMessages = await getChatMessagesWithAuth(tx, chatId, email)

          let insertedMsg = await insertMessage(tx, {
            chatId: existingChat.id,
            userId: user.id,
            workspaceExternalId: workspace.externalId,
            chatExternalId: existingChat.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: [],
            message,
            modelId: actualModelId || config.defaultBestModel,
            fileIds,
          })

          // Store attachment metadata for user message if attachments exist
          if (attachmentMetadata && attachmentMetadata.length > 0) {
            try {
              await storeAttachmentMetadata(
                tx,
                insertedMsg.externalId,
                attachmentMetadata,
                email,
              )
            } catch (error) {
              attachmentStorageError = error as Error
              loggerWithChild({ email: email }).error(
                error,
                `Failed to store attachment metadata for user message ${insertedMsg.externalId}`,
              )
            }
          }

          return [existingChat, allMessages, insertedMsg]
        },
      )
      loggerWithChild({ email: email }).info(
        "Existing conversation, fetched previous messages",
      )
      messages = allMessages.concat(insertedMsg) // Update messages array
      chat = existingChat
      chatCreationSpan.end()
    }
    loggerWithChild({ email: email }).info("starting the streaming..")
    return streamSSE(
      c,
      async (stream) => {
        streamKey = `${chat.externalId}` // Create the stream key
        activeStreams.set(streamKey, { stream }) // Add stream to the map
        loggerWithChild({ email: email }).info(
          `Added stream ${streamKey} to active streams map.`,
        )
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

          loggerWithChild({ email: email }).info("Chat stream started")
          // we do not set the message Id as we don't have it
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chat.externalId,
            }),
          })

          // Send attachment metadata immediately if attachments exist
          if (attachmentMetadata && attachmentMetadata.length > 0) {
            const userMessage = messages[messages.length - 1]
            await stream.writeSSE({
              event: ChatSSEvents.AttachmentUpdate,
              data: JSON.stringify({
                messageId: userMessage.externalId,
                attachments: attachmentMetadata,
              }),
            })
          }
          // Notify client if attachment storage failed
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
          // Build conversation history (exclude current message)
          const filteredMessages =
            messages.length > 1
              ? messages
                  .slice(0, messages.length - 1)
                  .filter((msg) => !msg?.errorMessage)
                  .filter(
                    (msg) =>
                      !(
                        msg.messageRole === MessageRole.Assistant &&
                        !msg.message
                      ),
                  )
              : []

          const topicConversationThread =
            filteredMessages.length > 0
              ? buildTopicConversationThread(
                  filteredMessages,
                  filteredMessages.length - 1,
                )
              : []

          const llmFormattedMessages: Message[] = formatMessagesForLLM(
            topicConversationThread,
          )

          if (
            (fileIds && fileIds?.length > 0) ||
            (imageAttachmentFileIds && imageAttachmentFileIds?.length > 0)
          ) {
            let answer = ""
            let citations = []
            let imageCitations: any[] = []
            let citationMap: Record<number, number> = {}
            let thinking = ""
            let reasoning =
              userRequestsReasoning &&
              ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning

            const understandSpan = streamSpan.startSpan("understand_message")
            understandSpan?.setAttribute(
              "totalValidFileIdsFromLinkCount",
              totalValidFileIdsFromLinkCount,
            )
            understandSpan?.setAttribute("maxValidLinks", maxValidLinks)

            const iterator = UnderstandMessageAndAnswerForGivenContext(
              email,
              ctx,
              userMetadata,
              message,
              0.5,
              fileIds,
              userRequestsReasoning,
              understandSpan,
              threadIds,
              imageAttachmentFileIds,
              agentPromptValue,
              isMsgWithKbItems,
              actualModelId || config.defaultBestModel,
              false,
              [],
              llmFormattedMessages,
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
                loggerWithChild({ email: email }).info(
                  "[MessageApi] Stream closed during conversation search loop. Breaking.",
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
                    data: `Skipping last ${
                      totalValidFileIdsFromLinkCount - maxValidLinks
                    } links as it exceeds max limit of ${maxValidLinks}. `,
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
              // Track token usage from metadata
              if (chunk.metadata?.usage) {
                tokenArr.push({
                  inputTokens: chunk.metadata.usage.inputTokens || 0,
                  outputTokens: chunk.metadata.usage.outputTokens || 0,
                })
              }
              if (chunk.citation) {
                const { index, item } = chunk.citation
                if (
                  item &&
                  item.app == Apps.Gmail &&
                  !Object.values(MailAttachmentEntity).includes(item.entity)
                ) {
                  item.docId = await replaceDocIdwithUserDocId(
                    item.docId,
                    email,
                  )
                  if (item.url) {
                    item.url = item.url.replace(
                      /inbox\/[^/]+/,
                      `inbox/${item.docId}`,
                    )
                  }
                }
                citations.push(item)
                citationMap[index] = citations.length - 1
                loggerWithChild({ email: email }).info(
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
              if (chunk.imageCitation) {
                imageCitations.push(chunk.imageCitation)
                loggerWithChild({ email: email }).info(
                  `Found image citation, sending it`,
                  { citationKey: chunk.imageCitation.citationKey },
                )
                stream.writeSSE({
                  event: ChatSSEvents.ImageCitationUpdate,
                  data: JSON.stringify(chunk.imageCitation),
                })
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
            const answerSpan = streamSpan.startSpan("process_final_answer")
            answerSpan.setAttribute(
              "final_answer",
              webSearchEnabled
                ? processWebSearchMessage(answer, citationMap, email)
                : processMessage(answer, citationMap, email),
            )
            answerSpan.setAttribute("actual_answer", answer)
            answerSpan.setAttribute("final_answer_length", answer.length)
            answerSpan.end()

            if (answer || wasStreamClosedPrematurely) {
              // Calculate total cost and tokens
              const totalCost = costArr.reduce((a, b) => a + b, 0)
              const totalTokens = tokenArr.reduce(
                (acc, curr) => ({
                  inputTokens: acc.inputTokens + curr.inputTokens,
                  outputTokens: acc.outputTokens + curr.outputTokens,
                }),
                { inputTokens: 0, outputTokens: 0 },
              )

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
                imageCitations: imageCitations,
                message: webSearchEnabled
                  ? processWebSearchMessage(answer, citationMap, email)
                  : processMessage(answer, citationMap, email),
                thinking: thinking,
                modelId: actualModelId,
                cost: totalCost.toString(),
                tokensUsed: totalTokens.inputTokens + totalTokens.outputTokens,
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
              loggerWithChild({ email: email }).info(
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
              const allMessages = await getChatMessagesWithAuth(
                db,
                chat?.externalId,
                email,
              )
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
            loggerWithChild({ email: email }).info(
              "Checking if answer is in the conversation or a mandatory query rewrite is needed before RAG",
            )

            // Extract previous classification for pagination and follow-up queries
            let previousClassification: QueryRouterLLMResponse | null = null
            if (filteredMessages.length >= 1) {
              const previousUserMessage =
                filteredMessages[filteredMessages.length - 2]
              if (
                previousUserMessage?.queryRouterClassification &&
                previousUserMessage.messageRole === "user"
              ) {
                try {
                  const parsedClassification =
                    typeof previousUserMessage.queryRouterClassification ===
                    "string"
                      ? JSON.parse(
                          previousUserMessage.queryRouterClassification,
                        )
                      : previousUserMessage.queryRouterClassification
                  previousClassification =
                    parsedClassification as QueryRouterLLMResponse
                  Logger.info(
                    `Found previous classification: ${JSON.stringify(previousClassification)}`,
                  )
                } catch (error) {
                  Logger.error(
                    `Error parsing previous classification: ${error}`,
                  )
                }
              }
            }

            // Get chain break classifications for context
            const chainBreakClassifications =
              getRecentChainBreakClassifications(messages)
            const formattedChainBreaks = formatChainBreaksForPrompt(
              chainBreakClassifications,
            )

            loggerWithChild({ email: email }).info(
              `Chain break analysis complete: Found ${chainBreakClassifications.length} chain break classifications, Formatted: ${formattedChainBreaks ? "YES" : "NO"}`,
            )

            loggerWithChild({ email: email }).info(
              `Found ${chainBreakClassifications.length} chain break classifications for context`,
            )

            let searchOrAnswerIterator
            if (deepResearchEnabled) {
              loggerWithChild({ email: email }).info(
                "Using deep research for the question",
              )
              searchOrAnswerIterator = getDeepResearchResponse(message, ctx, {
                modelId: Models.o3_Deep_Research,
                stream: true,
                json: false,
                agentPrompt: JSON.stringify(agentDetails),
                reasoning:
                  userRequestsReasoning &&
                  ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning,
                messages: llmFormattedMessages,
                webSearch: false,
                deepResearchEnabled: true,
              })
            } else if (webSearchEnabled) {
              loggerWithChild({ email: email }).info(
                "Using web search for the question",
              )
              searchOrAnswerIterator = webSearchQuestion(
                message,
                ctx,
                {
                  modelId: Models.Gemini_2_5_Flash,
                  stream: true,
                  json: false,
                  agentPrompt: JSON.stringify(agentDetails),
                  reasoning:
                    userRequestsReasoning &&
                    ragPipelineConfig[RagPipelineStages.AnswerOrSearch]
                      .reasoning,
                  messages: llmFormattedMessages,
                  webSearch: true,
                },
                extractedInfo.webSearchResults,
              )
            } else {
              searchOrAnswerIterator =
                generateSearchQueryOrAnswerFromConversation(
                  message,
                  ctx,
                  userMetadata,
                  {
                    modelId: actualModelId
                      ? (actualModelId as Models)
                      : config.defaultBestModel,
                    stream: true,
                    json: true,
                    agentPrompt: agentPromptValue,
                    reasoning:
                      userRequestsReasoning &&
                      ragPipelineConfig[RagPipelineStages.AnswerOrSearch]
                        .reasoning,
                    messages: llmFormattedMessages,
                    // agentPrompt: agentPrompt, // agentPrompt here is the original from request, might be empty string
                    // AgentMessageApi/CombinedAgentSlackApi handle fetching full agent details
                    // For this non-agent RAG path, we don't pass an agent prompt.
                  },
                  undefined,
                  previousClassification,
                  formattedChainBreaks,
                )
            }

            // TODO: for now if the answer is from the conversation itself we don't
            // add any citations for it, we can refer to the original message for citations
            // one more bug is now llm automatically copies the citation text sometimes without any reference
            // leads to [NaN] in the answer
            let currentAnswer = ""
            let answer = ""
            let citations: Citation[] = []
            let imageCitations: any[] = []
            let citationMap: Record<number, number> = {}
            let deepResearchSteps: any[] = []
            let queryFilters = {
              apps: [],
              entities: [],
              startTime: "",
              endTime: "",
              count: 0,
              sortDirection: "",
              mailParticipants: {},
              offset: 0,
            }
            let parsed = {
              isFollowUp: false,
              answer: "",
              queryRewrite: "",
              temporalDirection: null,
              filterQuery: "",
              type: "",
              mailParticipants: {},
              filters: queryFilters,
            }

            let thinking = ""
            let reasoning =
              userRequestsReasoning &&
              ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning
            let buffer = ""
            const conversationSpan = streamSpan.startSpan("conversation_search")
            if (deepResearchEnabled) {
              loggerWithChild({ email: email }).info(
                "Processing deep research response",
              )

              stream.writeSSE({
                event: ChatSSEvents.Start,
                data: "",
              })

              let sourceIndex = 0
              let finalText = ""
              let finalAnnotations: any[] = []

              const deepSearchIterator = await processDeepSearchIterator({
                iterator: searchOrAnswerIterator,
                answer,
                costArr,
                deepResearchSteps,
                email,
                finalAnnotations,
                finalText,
                stream,
                tokenArr,
                wasStreamClosedPrematurely,
              })

              // Process citations if we have final text and annotations
              if (deepSearchIterator.finalText) {
                const citationResult = processOpenAICitations(
                  deepSearchIterator.answer,
                  deepSearchIterator.finalText,
                  deepSearchIterator.finalAnnotations,
                  citations,
                  citationMap,
                  sourceIndex,
                )

                if (citationResult) {
                  answer = citationResult.updatedAnswer
                  sourceIndex = citationResult.updatedSourceIndex
                  if (citationResult.newCitations.length > 0) {
                    citations.push(...citationResult.newCitations)
                    Object.assign(citationMap, citationResult.newCitationMap)

                    stream.writeSSE({
                      event: ChatSSEvents.CitationsUpdate,
                      data: JSON.stringify({
                        contextChunks: citations,
                        citationMap: citationMap,
                        updatedResponse: answer,
                      }),
                    })
                  }
                }
              }
              parsed.answer = answer
            } else if (webSearchEnabled) {
              loggerWithChild({ email: email }).info(
                "Processing web search response",
              )

              stream.writeSSE({
                event: ChatSSEvents.Start,
                data: "",
              })

              let sourceIndex = 0
              let allSources: WebSearchSource[] = []
              let finalGroundingSupports: GroundingSupport[] = []

              for await (const chunk of searchOrAnswerIterator) {
                if (stream.closed) {
                  loggerWithChild({ email: email }).info(
                    "[MessageApi] Stream closed during web search loop. Breaking.",
                  )
                  wasStreamClosedPrematurely = true
                  break
                }
                // TODO: Handle websearch reasoning
                if (chunk.text) {
                  answer += chunk.text
                  stream.writeSSE({
                    event: ChatSSEvents.ResponseUpdate,
                    data: chunk.text,
                  })
                }

                if (chunk.sources && chunk.sources.length > 0) {
                  const uniqueSources = chunk.sources.filter(
                    (source) =>
                      !allSources.some(
                        (existing) => existing.uri === source.uri,
                      ),
                  )
                  allSources.push(...uniqueSources)
                }

                if (
                  chunk.groundingSupports &&
                  chunk.groundingSupports.length > 0
                ) {
                  finalGroundingSupports = chunk.groundingSupports
                }

                if (chunk.cost) {
                  costArr.push(chunk.cost)
                }
                if (chunk.metadata?.usage) {
                  tokenArr.push({
                    inputTokens: chunk.metadata.usage.inputTokens || 0,
                    outputTokens: chunk.metadata.usage.outputTokens || 0,
                  })
                }
              }

              // Web search citations from Gemini are provided only in the final streamed chunk,
              // so processing them after streaming completes
              const citationResult = processWebSearchCitations(
                answer,
                allSources,
                finalGroundingSupports,
                citations,
                citationMap,
                sourceIndex,
              )

              if (citationResult) {
                answer = citationResult.updatedAnswer
                sourceIndex = citationResult.updatedSourceIndex

                if (citationResult.newCitations.length > 0) {
                  citations.push(...citationResult.newCitations)
                  Object.assign(citationMap, citationResult.newCitationMap)

                  stream.writeSSE({
                    event: ChatSSEvents.CitationsUpdate,
                    data: JSON.stringify({
                      contextChunks: citations,
                      citationMap: citationMap,
                      updatedResponse: answer,
                    }),
                  })
                }
              }

              parsed.answer = answer
            } else {
              for await (const chunk of searchOrAnswerIterator) {
                if (stream.closed) {
                  loggerWithChild({ email: email }).info(
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
                          loggerWithChild({ email: email }).info(
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
                      loggerWithChild({ email: email }).error(
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
                // Track token usage from metadata
                if (chunk.metadata?.usage) {
                  tokenArr.push({
                    inputTokens: chunk.metadata.usage.inputTokens || 0,
                    outputTokens: chunk.metadata.usage.outputTokens || 0,
                  })
                }
              }
            }

            conversationSpan.setAttribute("answer_found", parsed.answer)
            conversationSpan.setAttribute("answer", answer)
            conversationSpan.setAttribute("query_rewrite", parsed.queryRewrite)
            conversationSpan.end()
            let classification
            const {
              apps,
              count,
              endTime,
              entities,
              sortDirection,
              startTime,
              mailParticipants,
              offset,
            } = parsed?.filters || {}
            classification = {
              direction: parsed.temporalDirection,
              type: parsed.type,
              filterQuery: parsed.filterQuery,
              isFollowUp: parsed.isFollowUp,
              filters: {
                apps: apps as Apps[] | undefined,
                entities: entities as Entity[] | undefined,
                endTime,
                sortDirection,
                startTime,
                count,
                offset: offset || 0,
                mailParticipants: mailParticipants || {},
              },
            } as QueryRouterLLMResponse

            if (parsed.answer === null || parsed.answer === "") {
              const ragSpan = streamSpan.startSpan("rag_processing")
              if (parsed.queryRewrite) {
                loggerWithChild({ email: email }).info(
                  `The query is ambigious and requires a mandatory query rewrite from the existing conversation / recent messages ${parsed.queryRewrite}`,
                )
                message = parsed.queryRewrite
                loggerWithChild({ email: email }).info(
                  `Rewritten query: ${message}`,
                )
                ragSpan.setAttribute("query_rewrite", parsed.queryRewrite)
              } else {
                loggerWithChild({ email: email }).info(
                  "There was no need for a query rewrite and there was no answer in the conversation, applying RAG",
                )
              }

              loggerWithChild({ email: email }).info(
                `Classifying the query as:, ${JSON.stringify(classification)}`,
              )

              ragSpan.setAttribute(
                "isFollowUp",
                classification.isFollowUp ?? false,
              )
              const understandSpan = ragSpan.startSpan("understand_message")

              let iterator:
                | AsyncIterableIterator<
                    ConverseResponse & {
                      citation?: { index: number; item: any }
                      imageCitation?: ImageCitation
                    }
                  >
                | undefined = undefined

              if (messages.length < 2) {
                classification.isFollowUp = false // First message or not enough history to be a follow-up
              } else if (classification.isFollowUp) {
                // Use the NEW classification that already contains:
                // - Updated filters (with proper offset calculation)
                // - Preserved app/entity from previous query
                // - Updated count/pagination info
                // - All the smart follow-up logic from the LLM

                // Check for follow-up context carry-forward
                const workingSet = collectFollowupContext(filteredMessages)

                const hasCarriedContext =
                  workingSet.fileIds.length > 0 ||
                  workingSet.attachmentFileIds.length > 0
                if (hasCarriedContext) {
                  fileIds = workingSet.fileIds
                  imageAttachmentFileIds = workingSet.attachmentFileIds
                  loggerWithChild({ email: email }).info(
                    `Carried forward context from follow-up: ${JSON.stringify(workingSet)}`,
                  )
                }

                if (
                  (fileIds && fileIds.length > 0) ||
                  (imageAttachmentFileIds && imageAttachmentFileIds.length > 0)
                ) {
                  loggerWithChild({ email: email }).info(
                    `Follow-up query with file context detected. Using file-based context with NEW classification: ${JSON.stringify(classification)}, FileIds: ${JSON.stringify([fileIds, imageAttachmentFileIds])}`,
                  )
                  iterator = UnderstandMessageAndAnswerForGivenContext(
                    email,
                    ctx,
                    userMetadata,
                    message,
                    0.5,
                    fileIds as string[],
                    userRequestsReasoning,
                    understandSpan,
                    undefined,
                    imageAttachmentFileIds as string[],
                    agentPromptValue,
                    fileIds.some((fileId) => fileId.startsWith("clf-")),
                    actualModelId || config.defaultBestModel,
                  )
                } else {
                  loggerWithChild({ email: email }).info(
                    `Follow-up query detected.`,
                  )
                  // Use the new classification directly - it already has all the smart follow-up logic
                  // No need to reuse old classification, the LLM has generated an updated one
                }
              }

              // If no iterator was set above (non-file-context scenario), use the regular flow with the new classification
              if (!iterator) {
                iterator = UnderstandMessageAndAnswer(
                  email,
                  ctx,
                  userMetadata,
                  message,
                  classification,
                  llmFormattedMessages,
                  0.5,
                  userRequestsReasoning,
                  understandSpan,
                  agentPromptValue,
                  actualModelId || config.defaultBestModel,
                  undefined,
                  publicAgents,
                )
              }

              answer = ""
              thinking = ""
              reasoning = isReasoning && userRequestsReasoning
              citations = []
              let imageCitations: any[] = []
              citationMap = {}
              let citationValues: Record<number, string> = {}

              stream.writeSSE({
                event: ChatSSEvents.Start,
                data: "",
              })
              for await (const chunk of iterator) {
                if (stream.closed) {
                  loggerWithChild({ email: email }).info(
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
                // Track token usage from metadata
                if (chunk.metadata?.usage) {
                  tokenArr.push({
                    inputTokens: chunk.metadata.usage.inputTokens || 0,
                    outputTokens: chunk.metadata.usage.outputTokens || 0,
                  })
                }
                if (chunk.citation) {
                  const { index, item } = chunk.citation
                  if (
                    item &&
                    item.app == Apps.Gmail &&
                    !Object.values(MailAttachmentEntity).includes(item.entity)
                  ) {
                    item.docId = await replaceDocIdwithUserDocId(
                      item.docId,
                      email,
                    )
                    if (item.url) {
                      item.url = item.url.replace(
                        /inbox\/[^/]+/,
                        `inbox/${item.docId}`,
                      )
                    }
                  }
                  citations.push(item)
                  citationMap[index] = citations.length - 1
                  loggerWithChild({ email: email }).info(
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
                if (chunk.imageCitation) {
                  // Collect image citation for database persistence
                  imageCitations.push(chunk.imageCitation)
                  Logger.info("Found image citation, sending it")
                  loggerWithChild({ email: email }).info(
                    `Found image citation, sending it`,
                    { citationKey: chunk.imageCitation.citationKey },
                  )
                  stream.writeSSE({
                    event: ChatSSEvents.ImageCitationUpdate,
                    data: JSON.stringify(chunk.imageCitation),
                  })
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
                webSearchEnabled
                  ? processWebSearchMessage(answer, citationMap, email)
                  : processMessage(answer, citationMap, email),
              )
              answerSpan.setAttribute("actual_answer", answer)
              answerSpan.setAttribute("final_answer_length", answer.length)
              answerSpan.end()
              ragSpan.end()
            } else if (parsed.answer) {
              answer = parsed.answer
            }

            const latestUserMessage = messages[messages.length - 1]
            if (latestUserMessage && answer) {
              const isFollowUp = parsed?.isFollowUp
              const lastMessageIndex = messages.length - 1
              const referenceIndex = lastMessageIndex - 2

              const previousClassification = messages[referenceIndex]
                ?.queryRouterClassification as Record<string, any> | undefined

              let queryRouterClassification: Record<string, any> | undefined

              // Always use the LLM-generated classification (no more overrides)
              if (Object.keys(classification).length > 2) {
                queryRouterClassification = classification
              }

              if (queryRouterClassification) {
                loggerWithChild({ email: email }).info(
                  `Query Router Classification : ${JSON.stringify(
                    queryRouterClassification,
                  )}`,
                )

                await updateMessage(db, latestUserMessage.externalId, {
                  queryRouterClassification,
                })
              } else {
                loggerWithChild({ email: email }).warn(
                  "queryRouterClassification is undefined, skipping update.",
                )
              }
            }

            if (answer || wasStreamClosedPrematurely) {
              // Calculate total cost and tokens
              const totalCost = costArr.reduce((a, b) => a + b, 0)
              const totalTokens = tokenArr.reduce(
                (acc, curr) => ({
                  inputTokens: acc.inputTokens + curr.inputTokens,
                  outputTokens: acc.outputTokens + curr.outputTokens,
                }),
                { inputTokens: 0, outputTokens: 0 },
              )

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
                queryRouterClassification: JSON.stringify(classification),
                email: user.email,
                sources: citations,
                imageCitations: imageCitations,
                message: webSearchEnabled
                  ? processWebSearchMessage(answer, citationMap, email)
                  : processMessage(answer, citationMap, email),
                thinking: thinking,
                deepResearchSteps: deepResearchSteps,
                modelId: actualModelId || config.defaultBestModel,
                cost: totalCost.toString(),
                tokensUsed: totalTokens.inputTokens + totalTokens.outputTokens,
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
              loggerWithChild({ email: email }).info(
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
              const allMessages = await getChatMessagesWithAuth(
                db,
                chat?.externalId,
                email,
              )
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
          const allMessages = await getChatMessagesWithAuth(
            db,
            chat?.externalId,
            email,
          )
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
          loggerWithChild({ email: email }).error(
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
            loggerWithChild({ email: email }).info(
              `Removed stream ${streamKey} from active streams map.`,
            )
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
        const allMessages = await getChatMessagesWithAuth(
          db,
          chat?.externalId,
          email,
        )
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
          const allMessages = await getChatMessagesWithAuth(
            db,
            errorChatId,
            email,
          )
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
        loggerWithChild({ email: email }).error(
          err,
          `Streaming Error: ${err.message} ${(err as Error).stack}`,
        )
        // Ensure stream is removed from the map in the error callback too
        if (streamKey && activeStreams.has(streamKey)) {
          activeStreams.delete(streamKey)
          loggerWithChild({ email: email }).info(
            `Removed stream ${streamKey} from active streams map in error callback.`,
          )
        }
        streamErrorSpan.end()
        rootSpan.end()
      },
    )
  } catch (error) {
    loggerWithChild({ email: email }).info(
      `MessageApi Error occurred.. {error}`,
    )
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
      const allMessages = await getChatMessagesWithAuth(
        db,
        chat?.externalId,
        email,
      )
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
        loggerWithChild({ email: email }).error(
          error,
          "You exceeded your current quota",
        )
        if (stream) {
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: errFromMap,
          })
        }
      }
    } else {
      loggerWithChild({ email: email }).error(
        error,
        `Message Error: ${errMsg} ${(error as Error).stack}`,
      )
      throw new HTTPException(500, {
        message: "Could not create message or Chat",
      })
    }
    // Ensure stream is removed from the map in the top-level catch block
    if (streamKey && activeStreams.has(streamKey)) {
      activeStreams.delete(streamKey)
      loggerWithChild({ email: email }).info(
        `Removed stream ${streamKey} from active streams map in top-level catch.`,
      )
    }
    errorSpan.end()
    rootSpan.end()
  }
}

// We support both retrying of already valid assistant respone & retrying of an error
// When the assitant gives error, that error message is stored in the user query's message object of that respective user query
// On the frontend, an error message can be seen from the assistant's side, but it is not really present in the DB, it is taken from the user query's errorMessage property
// On retry of that error, we send the user message itself again (like asking the same query again)
// If the retry is successful and we get a valid response, we store that message inside DB with a 'createdAt' value just 1 unit ahead of the respective user query's createdAt value
// This is done to maintain the order of user-assistant message pattern in messages which helps both in the frontend and server logic
// If the retry also fails, we do the same thing, storing error message in the user query's respective message object
// If a retry fails on a completely valid assistant response, the error is shown in the UI but not stored anywhere, we retain the valid response (can be seen after reload)
export const MessageRetryApi = async (c: Context) => {
  const tracer: Tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("MessageRetryApi")
  let streamKey: string | null = null // Add stream key for stop functionality
  let relevantMessageId: string | null = null // Track message ID being generated/updated
  let email = ""
  try {
    // @ts-ignore
    const body = c.req.valid("query")
    const { messageId, selectedModelConfig }: MessageRetryReqType = body
    // Parse the model configuration JSON
    let extractedModelId: string | null = null
    let isReasoningEnabled = false

    if (selectedModelConfig) {
      try {
        // Decode the URL-encoded string first
        const modelConfig = JSON.parse(selectedModelConfig)
        extractedModelId = modelConfig.model || null

        // Check capabilities - handle both array and object formats
        if (modelConfig.capabilities) {
          if (Array.isArray(modelConfig.capabilities)) {
            isReasoningEnabled = modelConfig.capabilities.includes("reasoning")
          } else if (typeof modelConfig.capabilities === "object") {
            isReasoningEnabled = modelConfig.capabilities.reasoning === true
          }
        }
      } catch (error) {
        console.error("Failed to parse selectedModelConfig in retry:", error)
      }
    }

    const userRequestsReasoning = isReasoningEnabled
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    email = sub ?? ""

    // Get the original message first to determine if it's a user or assistant message
    const originalMessage = await getMessageByExternalId(db, messageId)
    if (!originalMessage) {
      throw new HTTPException(404, { message: "Message not found" })
    }

    const isUserMessage = originalMessage.messageRole === "user"

    // If it's an assistant message, we need to get attachments from the previous user message
    let attachmentMetadata: AttachmentMetadata[] = []
    let ImageAttachmentFileIds: string[] = []

    if (isUserMessage) {
      // If retrying a user message, get attachments from that message
      attachmentMetadata = await getAttachmentsByMessageId(db, messageId, email)
      ImageAttachmentFileIds = attachmentMetadata
        .filter((m) => m.isImage)
        .map((m) => m.fileId)
    }

    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)
    rootSpan.setAttribute("messageId", messageId)

    const costArr: number[] = []
    const tokenArr: { inputTokens: number; outputTokens: number }[] = []
    // Fetch the original message
    const fetchMessageSpan = rootSpan.startSpan("fetch_original_message")
    if (!originalMessage) {
      const errorSpan = fetchMessageSpan.startSpan("message_not_found")
      errorSpan.addEvent("error", { message: "Message not found" })
      errorSpan.end()
      fetchMessageSpan.end()
      throw new HTTPException(404, { message: "Message not found" })
    }
    fetchMessageSpan.setAttribute("isUserMessage", isUserMessage)
    fetchMessageSpan.end()

    // Fetch conversation history
    const conversationSpan = rootSpan.startSpan("fetch_conversation")
    let conversation = await getChatMessagesBefore(
      db,
      originalMessage.chatId,
      originalMessage.createdAt,
    )
    // This !isUserMessage is useful for the case when the user retries the error he gets on the very first user query
    // Becoz on retry of the error, there will be no conversation availble as there wouldn't be anything before the very first query
    // And for retry on error, we use the user query itself
    if (!isUserMessage && (!conversation || !conversation.length)) {
      const errorSpan = conversationSpan.startSpan("no_conversation")
      errorSpan.addEvent("error", {
        message: "Could not fetch previous messages",
      })
      errorSpan.end()
      conversationSpan.end()
      throw new HTTPException(400, {
        message: "Could not fetch previous messages",
      })
    }
    conversationSpan.setAttribute("conversationLength", conversation.length)
    conversationSpan.end()

    // If retrying an assistant message, get attachments from the previous user message
    if (!isUserMessage && conversation && conversation.length > 0) {
      const prevUserMessage = conversation[conversation.length - 1]
      if (prevUserMessage.messageRole === "user") {
        attachmentMetadata = await getAttachmentsByMessageId(
          db,
          prevUserMessage.externalId,
          email,
        )
        ImageAttachmentFileIds = attachmentMetadata
          .map((m: AttachmentMetadata) => (m.isImage ? m.fileId : null))
          .filter((m: string | null) => m !== null)
      }
    }

    // Use the extracted modelId if provided, otherwise use the original message's modelId
    let convertedModelId = extractedModelId
      ? getModelValueFromLabel(extractedModelId)
      : null
    if (extractedModelId) {
      if (!convertedModelId && extractedModelId in Models) {
        convertedModelId = extractedModelId as Models
      } else if (!convertedModelId) {
        throw new HTTPException(400, {
          message: `Invalid model: ${extractedModelId}`,
        })
      }
    }
    const modelId = convertedModelId
      ? (convertedModelId as Models)
      : (originalMessage.modelId as Models)

    // Get user and workspace
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const { user, workspace } = userAndWorkspace
    const ctx = userContext(userAndWorkspace)
    const userTimezone = user?.timeZone || "Asia/Kolkata"
    const dateForAI = getDateForAI({ userTimeZone: userTimezone })
    const userMetadata = { userTimezone, dateForAI }

    // Extract sources from search parameters
    const kbItems = c.req.query("selectedKbItems")
    const isMsgWithKbItems = !!kbItems

    let newCitations: Citation[] = []
    // the last message before our assistant's message was the user's message
    const prevUserMessage = isUserMessage
      ? originalMessage
      : conversation[conversation.length - 1]
    let fileIds: string[] = []
    let threadIds: string[] = []
    const fileIdsFromDB = JSON.parse(
      JSON.stringify(prevUserMessage?.fileIds || []),
    )
    let totalValidFileIdsFromLinkCount = 0
    if (
      prevUserMessage.messageRole === "user" &&
      fileIdsFromDB &&
      fileIdsFromDB.length > 0
    ) {
      fileIds = fileIdsFromDB
      const isMsgWithContext = isMessageWithContext(prevUserMessage.message)
      const extractedInfo = isMsgWithContext
        ? await extractFileIdsFromMessage(prevUserMessage.message, email)
        : {
            totalValidFileIdsFromLinkCount: 0,
            fileIds: [],
            threadIds: [],
          }
      totalValidFileIdsFromLinkCount =
        extractedInfo?.totalValidFileIdsFromLinkCount
      threadIds = extractedInfo?.threadIds || []
    }
    // we are trying to retry the first assistant's message
    if (conversation.length === 1) {
      conversation = []
    }
    if (!prevUserMessage.message) {
      const errorSpan = rootSpan.startSpan("invalid_user_chat")
      errorSpan.addEvent("error", {
        message: "Cannot retry the message, invalid user chat",
      })
      errorSpan.end()
      throw new HTTPException(400, {
        message: "Cannot retry the message, invalid user chat",
      })
    }

    // Set stream key before streaming
    streamKey = originalMessage.chatExternalId
    loggerWithChild({ email: email }).info(
      `[MessageRetryApi] Constructed streamKey: ${streamKey}`,
    )

    return streamSSE(
      c,
      async (stream) => {
        activeStreams.set(streamKey!, { stream })
        const streamSpan = rootSpan.startSpan("stream_response")
        streamSpan.setAttribute("chatId", originalMessage.chatExternalId)
        let wasStreamClosedPrematurely = false

        try {
          let message = prevUserMessage.message
          if (
            (fileIds && fileIds?.length > 0) ||
            (ImageAttachmentFileIds && ImageAttachmentFileIds?.length > 0)
          ) {
            loggerWithChild({ email: email }).info(
              "[RETRY] User has selected some context with query, answering only based on that given context",
            )

            let answer = ""
            let citations = []
            let imageCitations: any[] = []
            let citationMap: Record<number, number> = {}
            let thinking = ""
            let reasoning =
              userRequestsReasoning &&
              ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning

            const understandSpan = streamSpan.startSpan("understand_message")
            understandSpan?.setAttribute(
              "totalValidFileIdsFromLinkCount",
              totalValidFileIdsFromLinkCount,
            )
            understandSpan?.setAttribute("maxValidLinks", maxValidLinks)

            const iterator = UnderstandMessageAndAnswerForGivenContext(
              email,
              ctx,
              userMetadata,
              message,
              0.5,
              fileIds,
              userRequestsReasoning,
              understandSpan,
              threadIds,
              ImageAttachmentFileIds,
              undefined,
              isMsgWithKbItems,
              modelId,
            )
            stream.writeSSE({
              event: ChatSSEvents.Start,
              data: "",
            })

            answer = ""
            thinking = ""
            reasoning = isReasoning && userRequestsReasoning
            citations = []
            imageCitations = []
            citationMap = {}
            let count = 0
            let citationValues: Record<number, string> = {}
            for await (const chunk of iterator) {
              if (stream.closed) {
                loggerWithChild({ email: email }).info(
                  "[MessageRetryApi] Stream closed during conversation search loop. Breaking.",
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
                    data: `Skipping last ${
                      totalValidFileIdsFromLinkCount - maxValidLinks
                    } valid link/s as it exceeds max limit of ${maxValidLinks}. `,
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
              // Track token usage from metadata
              if (chunk.metadata?.usage) {
                tokenArr.push({
                  inputTokens: chunk.metadata.usage.inputTokens || 0,
                  outputTokens: chunk.metadata.usage.outputTokens || 0,
                })
              }
              if (chunk.citation) {
                const { index, item } = chunk.citation
                citations.push(item)
                citationMap[index] = citations.length - 1
                loggerWithChild({ email: email }).info(
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
              if (chunk.imageCitation) {
                imageCitations.push(chunk.imageCitation)
                loggerWithChild({ email: email }).info(
                  `Found image citation, sending it`,
                  { citationKey: chunk.imageCitation.citationKey },
                )
                stream.writeSSE({
                  event: ChatSSEvents.ImageCitationUpdate,
                  data: JSON.stringify(chunk.imageCitation),
                })
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
            const answerSpan = streamSpan.startSpan("process_final_answer")
            answerSpan.setAttribute(
              "final_answer",
              processMessage(answer, citationMap, email),
            )
            answerSpan.setAttribute("actual_answer", answer)
            answerSpan.setAttribute("final_answer_length", answer.length)
            answerSpan.end()

            // Database Update Logic
            const insertSpan = streamSpan.startSpan("insert_assistant_message")
            // Calculate total cost and tokens
            const totalCost = costArr.reduce((a, b) => a + b, 0)
            const totalTokens = tokenArr.reduce(
              (acc, curr) => ({
                inputTokens: acc.inputTokens + curr.inputTokens,
                outputTokens: acc.outputTokens + curr.outputTokens,
              }),
              { inputTokens: 0, outputTokens: 0 },
            )

            if (wasStreamClosedPrematurely) {
              loggerWithChild({ email: email }).info(
                `[MessageRetryApi] Stream closed prematurely. Saving partial state.`,
              )
              if (isUserMessage) {
                await db.transaction(async (tx) => {
                  await updateMessage(tx, messageId, { errorMessage: "" })
                  const msg = await insertMessage(tx, {
                    chatId: originalMessage.chatId,
                    userId: user.id,
                    workspaceExternalId: workspace.externalId,
                    chatExternalId: originalMessage.chatExternalId,
                    messageRole: MessageRole.Assistant,
                    email: user.email,
                    sources: citations,
                    imageCitations: imageCitations,
                    message: processMessage(answer, citationMap, email),
                    thinking,
                    modelId,
                    cost: totalCost.toString(),
                    tokensUsed:
                      totalTokens.inputTokens + totalTokens.outputTokens,
                    createdAt: new Date(
                      new Date(originalMessage.createdAt).getTime() + 1,
                    ),
                  })
                  relevantMessageId = msg.externalId
                })
              } else {
                relevantMessageId = originalMessage.externalId
                await updateMessage(db, messageId, {
                  message: processMessage(answer, citationMap, email),
                  updatedAt: new Date(),
                  sources: citations,
                  imageCitations: imageCitations,
                  thinking,
                  errorMessage: null,
                })
              }
            } else {
              if (answer) {
                if (isUserMessage) {
                  let msg = await db.transaction(async (tx) => {
                    await updateMessage(tx, messageId, { errorMessage: "" })
                    const msg = await insertMessage(tx, {
                      chatId: originalMessage.chatId,
                      userId: user.id,
                      workspaceExternalId: workspace.externalId,
                      chatExternalId: originalMessage.chatExternalId,
                      messageRole: MessageRole.Assistant,
                      email: user.email,
                      sources: citations,
                      message: processMessage(answer, citationMap, email),
                      thinking,
                      modelId:
                        ragPipelineConfig[RagPipelineStages.AnswerOrRewrite]
                          .modelId,
                      cost: totalCost.toString(),
                      tokensUsed:
                        totalTokens.inputTokens + totalTokens.outputTokens,
                      // The createdAt for this response which was error before
                      // should be just 1 unit more than the respective user query's createdAt value
                      // This is done to maintain order of user-assistant pattern of messages in UI
                      createdAt: new Date(
                        new Date(originalMessage.createdAt).getTime() + 1,
                      ),
                    })
                    return msg
                  })
                  relevantMessageId = msg.externalId
                } else {
                  loggerWithChild({ email: email }).info(
                    `Updated trace for message ${originalMessage.externalId}`,
                  )
                  insertSpan.setAttribute(
                    "message_id",
                    originalMessage.externalId,
                  )
                  relevantMessageId = originalMessage.externalId
                  await updateMessage(db, messageId, {
                    message: processMessage(answer, citationMap, email),
                    updatedAt: new Date(),
                    sources: citations,
                    thinking,
                    errorMessage: null,
                  })
                }
              } else {
                loggerWithChild({ email: email }).error(
                  `[MessageRetryApi] Stream finished but no answer generated.`,
                )
                const failureErrorMsg =
                  "Assistant failed to generate a response on retry."
                await addErrMessageToMessage(originalMessage, failureErrorMsg)
                relevantMessageId = originalMessage.externalId
                await stream.writeSSE({
                  event: ChatSSEvents.Error,
                  data: failureErrorMsg,
                })
              }
            }

            await stream.writeSSE({
              event: ChatSSEvents.ResponseMetadata,
              data: JSON.stringify({
                chatId: originalMessage.chatExternalId,
                messageId: relevantMessageId,
              }),
            })

            const endSpan = streamSpan.startSpan("send_end_event")
            await stream.writeSSE({
              data: "",
              event: ChatSSEvents.End,
            })
            endSpan.end()
            streamSpan.end()
            rootSpan.end()
            const traceJson = tracer.serializeToJson()
            await updateChatTrace(
              originalMessage.chatExternalId,
              originalMessage.externalId,
              traceJson,
            )
          } else {
            const topicConversationThread = buildTopicConversationThread(
              conversation,
              conversation.length - 1,
            )

            const convWithNoErrMsg = isUserMessage
              ? formatMessagesForLLM(
                  topicConversationThread
                    .filter((con) => !con?.errorMessage)
                    .filter(
                      (msg) =>
                        !(
                          (
                            msg.messageRole === MessageRole.Assistant &&
                            !msg.message
                          ) // filter out assistant messages with no content
                        ),
                    ),
                )
              : formatMessagesForLLM(
                  topicConversationThread
                    .slice(0, topicConversationThread.length - 1)
                    .filter((con) => !con?.errorMessage)
                    .filter(
                      (msg) =>
                        !(
                          msg.messageRole === MessageRole.Assistant &&
                          !msg.message
                        ),
                    ),
                )
            loggerWithChild({ email: email }).info(
              "retry: Checking if answer is in the conversation or a mandatory query rewrite is needed before RAG",
            )

            // Extract previous classification for pagination and follow-up queries
            let previousClassification: QueryRouterLLMResponse | null = null
            if (conversation.length > 0) {
              const previousUserMessage = conversation[conversation.length - 1] // In retry context, previous user message is at -1
              if (
                previousUserMessage?.queryRouterClassification &&
                previousUserMessage.messageRole === "user"
              ) {
                try {
                  const parsedClassification =
                    typeof previousUserMessage.queryRouterClassification ===
                    "string"
                      ? JSON.parse(
                          previousUserMessage.queryRouterClassification,
                        )
                      : previousUserMessage.queryRouterClassification
                  previousClassification =
                    parsedClassification as QueryRouterLLMResponse
                  Logger.info(
                    `Found previous classification in retry: ${JSON.stringify(previousClassification)}`,
                  )
                } catch (error) {
                  Logger.error(
                    `Error parsing previous classification in retry: ${error}`,
                  )
                }
              }
            }

            // Add chain break analysis for retry context
            const messagesForChainBreak = isUserMessage
              ? [...conversation, originalMessage] // Include the user message being retried
              : conversation // For assistant retry, conversation already has the right scope

            const chainBreakClassifications =
              getRecentChainBreakClassifications(messagesForChainBreak)
            const formattedChainBreaks = formatChainBreaksForPrompt(
              chainBreakClassifications,
            )

            const searchSpan = streamSpan.startSpan("conversation_search")
            const searchOrAnswerIterator =
              generateSearchQueryOrAnswerFromConversation(
                message,
                ctx,
                userMetadata,
                {
                  modelId: modelId
                    ? (modelId as Models)
                    : config.defaultBestModel,
                  stream: true,
                  json: true,
                  reasoning:
                    userRequestsReasoning &&
                    ragPipelineConfig[RagPipelineStages.AnswerOrSearch]
                      .reasoning,
                  messages: formatMessagesForLLM(topicConversationThread),
                },
                undefined,
                previousClassification,
                formattedChainBreaks,
              )
            let currentAnswer = ""
            let answer = ""
            let citations: Citation[] = [] // Changed to Citation[] for consistency
            let citationMap: Record<number, number> = {}
            let queryFilters = {
              apps: [],
              entities: [],
              startTime: "",
              endTime: "",
              count: 0,
              sortDirection: "",
              mailParticipants: {},
              offset: 0,
            }
            let parsed = {
              isFollowUp: false,
              answer: "",
              queryRewrite: "",
              temporalDirection: null,
              filterQuery: "",
              type: "",
              filters: queryFilters,
            }
            let thinking = ""
            let reasoning =
              userRequestsReasoning &&
              ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning
            let buffer = ""
            for await (const chunk of searchOrAnswerIterator) {
              if (stream.closed) {
                loggerWithChild({ email: email }).info(
                  "[MessageRetryApi] Stream closed during conversation search loop. Breaking.",
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
                buffer += chunk.text
                if (!reasoning) {
                  try {
                    parsed = jsonParseLLMOutput(buffer) || {}
                    if (parsed.answer && currentAnswer !== parsed.answer) {
                      if (currentAnswer === "") {
                        loggerWithChild({ email: email }).info(
                          "retry: We were able to find the answer/respond to users query in the conversation itself so not applying RAG",
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
                    loggerWithChild({ email: email }).error(
                      err,
                      `Error while parsing LLM output ${
                        (err as Error).message
                      }`,
                    )
                    continue
                  }
                }
              }
              if (chunk.cost) {
                costArr.push(chunk.cost)
              }
              // Track token usage from metadata
              if (chunk.metadata?.usage) {
                tokenArr.push({
                  inputTokens: chunk.metadata.usage.inputTokens || 0,
                  outputTokens: chunk.metadata.usage.outputTokens || 0,
                })
              }
            }
            searchSpan.setAttribute("answer_found", parsed.answer)
            searchSpan.setAttribute("answer", answer)
            searchSpan.setAttribute("query_rewrite", parsed.queryRewrite)
            searchSpan.end()
            let classification: QueryRouterLLMResponse
            if (parsed.answer === null) {
              const ragSpan = streamSpan.startSpan("rag_processing")
              if (parsed.queryRewrite) {
                loggerWithChild({ email: email }).info(
                  "retry: The query is ambiguous and requires a mandatory query rewrite from the existing conversation / recent messages",
                )
                message = parsed.queryRewrite
                ragSpan.setAttribute("query_rewrite", parsed.queryRewrite)
              } else {
                loggerWithChild({ email: email }).info(
                  "retry: There was no need for a query rewrite and there was no answer in the conversation, applying RAG",
                )
              }
              const {
                apps,
                count,
                endTime,
                entities,
                sortDirection,
                startTime,
              } = parsed?.filters || {}
              classification = {
                direction: parsed.temporalDirection,
                type: parsed.type,
                filterQuery: parsed.filterQuery,
                isFollowUp: parsed.isFollowUp,
                filters: {
                  apps: apps,
                  entities: entities as Entity[],
                  endTime,
                  sortDirection,
                  startTime,
                  count,
                  offset: parsed?.filters?.offset || 0,
                  mailParticipants: parsed?.filters?.mailParticipants || {},
                },
              } as QueryRouterLLMResponse

              loggerWithChild({ email: email }).info(
                `Classifying the query as:, ${JSON.stringify(classification)}`,
              )

              const understandSpan = ragSpan.startSpan("understand_message")
              const iterator = UnderstandMessageAndAnswer(
                email,
                ctx,
                userMetadata,
                message,
                classification,
                convWithNoErrMsg,
                0.5,
                userRequestsReasoning,
                understandSpan,
                undefined,
                modelId,
              )
              // throw new Error("Hello, how are u doing?")
              stream.writeSSE({
                event: ChatSSEvents.Start,
                data: "",
              })
              answer = ""
              thinking = ""
              reasoning = config.isReasoning && userRequestsReasoning
              citations = []
              citationMap = {}
              let citationValues: Record<number, string> = {}
              for await (const chunk of iterator) {
                if (stream.closed) {
                  loggerWithChild({ email: email }).info(
                    "[MessageRetryApi] Stream closed during RAG loop. Breaking.",
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
                // Track token usage from metadata
                if (chunk.metadata?.usage) {
                  tokenArr.push({
                    inputTokens: chunk.metadata.usage.inputTokens || 0,
                    outputTokens: chunk.metadata.usage.outputTokens || 0,
                  })
                }
                if (chunk.citation) {
                  const { index, item } = chunk.citation
                  citations.push(item)
                  citationMap[index] = citations.length - 1
                  loggerWithChild({ email: email }).info(
                    `retry: Found citations and sending it, current count: ${citations.length}`,
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
                processMessage(answer, citationMap, email),
              )
              answerSpan.setAttribute("actual_answer", answer)
              answerSpan.setAttribute("final_answer_length", answer.length)
              answerSpan.end()
              ragSpan.end()
            } else if (parsed.answer) {
              answer = parsed.answer
            }

            // Database Update Logic
            const insertSpan = streamSpan.startSpan("insert_assistant_message")
            // Calculate total cost and tokens
            const totalCost = costArr.reduce((a, b) => a + b, 0)
            const totalTokens = tokenArr.reduce(
              (acc, curr) => ({
                inputTokens: acc.inputTokens + curr.inputTokens,
                outputTokens: acc.outputTokens + curr.outputTokens,
              }),
              { inputTokens: 0, outputTokens: 0 },
            )

            if (wasStreamClosedPrematurely) {
              loggerWithChild({ email: email }).info(
                `[MessageRetryApi] Stream closed prematurely. Saving partial state.`,
              )
              if (isUserMessage) {
                await db.transaction(async (tx) => {
                  await updateMessage(tx, messageId, { errorMessage: "" })
                  const msg = await insertMessage(tx, {
                    chatId: originalMessage.chatId,
                    userId: user.id,
                    workspaceExternalId: workspace.externalId,
                    chatExternalId: originalMessage.chatExternalId,
                    messageRole: MessageRole.Assistant,
                    email: user.email,
                    sources: citations,
                    message: processMessage(answer, citationMap, email),
                    queryRouterClassification: JSON.stringify(classification),
                    thinking,
                    modelId:
                      ragPipelineConfig[RagPipelineStages.AnswerOrRewrite]
                        .modelId,
                    cost: totalCost.toString(),
                    tokensUsed:
                      totalTokens.inputTokens + totalTokens.outputTokens,
                    createdAt: new Date(
                      new Date(originalMessage.createdAt).getTime() + 1,
                    ),
                  })
                  relevantMessageId = msg.externalId
                })
              } else {
                relevantMessageId = originalMessage.externalId
                await updateMessage(db, messageId, {
                  message: processMessage(answer, citationMap, email),
                  updatedAt: new Date(),
                  sources: citations,
                  thinking,
                  errorMessage: null,
                })
              }
            } else {
              if (answer) {
                if (isUserMessage) {
                  let msg = await db.transaction(async (tx) => {
                    await updateMessage(tx, messageId, { errorMessage: "" })
                    const msg = await insertMessage(tx, {
                      chatId: originalMessage.chatId,
                      userId: user.id,
                      workspaceExternalId: workspace.externalId,
                      chatExternalId: originalMessage.chatExternalId,
                      messageRole: MessageRole.Assistant,
                      email: user.email,
                      sources: citations,
                      message: processMessage(answer, citationMap, email),
                      queryRouterClassification: JSON.stringify(classification),
                      thinking,
                      modelId:
                        ragPipelineConfig[RagPipelineStages.AnswerOrRewrite]
                          .modelId,
                      cost: totalCost.toString(),
                      tokensUsed:
                        totalTokens.inputTokens + totalTokens.outputTokens,
                      // The createdAt for this response which was error before
                      // should be just 1 unit more than the respective user query's createdAt value
                      // This is done to maintain order of user-assistant pattern of messages in UI
                      createdAt: new Date(
                        new Date(originalMessage.createdAt).getTime() + 1,
                      ),
                    })
                    return msg
                  })
                  relevantMessageId = msg.externalId
                } else {
                  loggerWithChild({ email: email }).info(
                    `Updated trace for message ${originalMessage.externalId}`,
                  )
                  insertSpan.setAttribute(
                    "message_id",
                    originalMessage.externalId,
                  )
                  relevantMessageId = originalMessage.externalId
                  await updateMessage(db, messageId, {
                    message: processMessage(answer, citationMap, email),
                    updatedAt: new Date(),
                    sources: citations,
                    thinking,
                    errorMessage: null,
                  })
                }
              } else {
                loggerWithChild({ email: email }).error(
                  `[MessageRetryApi] Stream finished but no answer generated.`,
                )
                const failureErrorMsg =
                  "Assistant failed to generate a response on retry."
                await addErrMessageToMessage(originalMessage, failureErrorMsg)
                relevantMessageId = originalMessage.externalId
                await stream.writeSSE({
                  event: ChatSSEvents.Error,
                  data: failureErrorMsg,
                })
              }
            }

            await stream.writeSSE({
              event: ChatSSEvents.ResponseMetadata,
              data: JSON.stringify({
                chatId: originalMessage.chatExternalId,
                messageId: relevantMessageId,
              }),
            })

            const endSpan = streamSpan.startSpan("send_end_event")
            await stream.writeSSE({
              data: "",
              event: ChatSSEvents.End,
            })
            endSpan.end()
            streamSpan.end()
            rootSpan.end()
            const traceJson = tracer.serializeToJson()
            await updateChatTrace(
              originalMessage.chatExternalId,
              originalMessage.externalId,
              traceJson,
            )
          }
        } catch (error) {
          const streamErrorSpan = streamSpan.startSpan("handle_stream_error")
          streamErrorSpan.addEvent("error", {
            message: getErrorMessage(error),
            stack: (error as Error).stack || "",
          })
          const errFromMap = handleError(error)
          relevantMessageId = relevantMessageId || originalMessage.externalId
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: originalMessage.chatExternalId,
              messageId: relevantMessageId,
            }),
          })
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: errFromMap,
          })
          await addErrMessageToMessage(originalMessage, errFromMap)
          await stream.writeSSE({
            data: "",
            event: ChatSSEvents.End,
          })
          loggerWithChild({ email: email }).error(
            error,
            `Streaming Error: ${(error as Error).message} ${
              (error as Error).stack
            }`,
          )
          streamErrorSpan.end()
          streamSpan.end()
          rootSpan.end()
        } finally {
          if (streamKey && activeStreams.has(streamKey)) {
            activeStreams.delete(streamKey)
            loggerWithChild({ email: email }).info(
              `[MessageRetryApi] Removed stream ${streamKey} from active streams map.`,
            )
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
        relevantMessageId = relevantMessageId || originalMessage.externalId
        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({
            chatId: originalMessage.chatExternalId,
            messageId: relevantMessageId,
          }),
        })
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: errFromMap,
        })
        await addErrMessageToMessage(originalMessage, errFromMap)
        await stream.writeSSE({
          data: "",
          event: ChatSSEvents.End,
        })
        loggerWithChild({ email: email }).error(
          err,
          `Streaming Error: ${err.message} ${(err as Error).stack}`,
        )
        streamErrorSpan.end()
        rootSpan.end()
        if (streamKey && activeStreams.has(streamKey)) {
          activeStreams.delete(streamKey)
          loggerWithChild({ email: email }).info(
            `[MessageRetryApi] Removed stream ${streamKey} from active streams map in error callback.`,
          )
        }
      },
    )
  } catch (error) {
    const errorSpan = rootSpan.startSpan("handle_top_level_error")
    errorSpan.addEvent("error", {
      message: getErrorMessage(error),
      stack: (error as Error).stack || "",
    })
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
      error,
      `Message Retry Error: ${errMsg} ${(error as Error).stack}`,
    )
    if (streamKey && activeStreams.has(streamKey)) {
      activeStreams.delete(streamKey)
      loggerWithChild({ email: email }).info(
        `[MessageRetryApi] Removed stream ${streamKey} from active streams map in top-level catch.`,
      )
    }
    throw new HTTPException(500, {
      message: "Could not retry message",
    })
  }
}

// New API Endpoint to stop streaming
export const StopStreamingApi = async (c: Context) => {
  const { email, via_apiKey } = getAuth(c)

  if (via_apiKey) {
    const apiKeyScopes =
      safeGet<{ scopes?: string[] }>(c, "config")?.scopes || []
    if (!apiKeyScopes.includes(ApiKeyScopes.AGENT_CHAT_STOP)) {
      return c.json(
        { message: "API key does not have scope to stop agent chat" },
        403,
      )
    }
  }

  try {
    // @ts-ignore - Assuming validation middleware handles this
    const { chatId } = c.req.valid("json")
    loggerWithChild({ email: email }).info(
      `[StopStreamingApi] Received stop request. ChatId from client: ${chatId}`,
    )

    if (!chatId) {
      loggerWithChild({ email: email }).warn(
        "[StopStreamingApi] Received stop request with missing chatId.",
      )
      throw new HTTPException(400, { message: "chatId is required." })
    }

    const streamKey = chatId
    const activeStream = activeStreams.get(streamKey)
    const stream = activeStream?.stream
    if (stream) {
      loggerWithChild({ email: email }).info(
        `[StopStreamingApi] Closing active stream: ${streamKey}.`,
      )
      try {
        await stream.close()
      } catch (closeError) {
        loggerWithChild({ email: email }).error(
          closeError,
          `[StopStreamingApi] Error closing stream ${streamKey}: ${getErrorMessage(
            closeError,
          )}`,
        )
      } finally {
        activeStreams.delete(streamKey!)
      }
    } else {
      loggerWithChild({ email: email }).warn(
        `[StopStreamingApi] Stop request for non-existent or already finished stream with key: ${streamKey}. No action taken.`,
      )
    }

    return c.json({ success: true })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    if (error instanceof HTTPException) {
      loggerWithChild({ email: email }).error(
        `[StopStreamingApi] HTTP Exception: ${error.status} - ${error.message}`,
      )
      throw error
    }
    loggerWithChild({ email: email }).error(
      error,
      `[StopStreamingApi] Unexpected Error: ${errMsg} ${
        (error as Error).stack
      }`,
    )
    throw new HTTPException(500, { message: "Could not stop streaming." })
  }
}

export const MessageFeedbackApi = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  const email = sub
  const Logger = getLogger(Subsystem.Chat)

  try {
    //@ts-ignore - Assuming validation middleware handles this
    const { messageId, feedback } = await c.req.valid("json")

    const message = await getMessageByExternalId(db, messageId)
    if (!message) {
      throw new HTTPException(404, { message: "Message not found" })
    }
    if (
      message.email !== email ||
      message.workspaceExternalId !== workspaceId
    ) {
      throw new HTTPException(403, { message: "Forbidden" })
    }

    // Convert legacy feedback to new JSON format for consistency
    const feedbackData = feedback
      ? {
          type: feedback,
          feedback: [""], // Empty array for legacy feedback
        }
      : null

    await updateMessageByExternalId(db, messageId, {
      feedback: feedbackData,
      updatedAt: new Date(),
    })

    loggerWithChild({ email: email }).info(
      `Feedback ${
        feedback ? `'${feedback}'` : "removed"
      } for message ${messageId} by user ${email}`,
    )
    likeDislikeCount.inc({ email: email, feedback: feedback })
    return c.json({ success: true, messageId, feedback })
  } catch (error) {
    const errMsg = getErrorMessage(error)

    loggerWithChild({ email: email }).error(
      error,
      `Message Feedback Error: ${errMsg} ${(error as Error).stack}`,
    )
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, {
      message: "Could not submit feedback",
    })
  }
}

// New Enhanced Feedback API
export const EnhancedMessageFeedbackApi = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  const email = sub
  const Logger = getLogger(Subsystem.Chat)

  try {
    //@ts-ignore - Assuming validation middleware handles this
    const requestData = await c.req.valid("json")
    const { messageId, type, customFeedback, selectedOptions, shareChat } =
      requestData as {
        messageId: string
        type: "like" | "dislike"
        customFeedback?: string
        selectedOptions?: string[]
        shareChat?: boolean
      }

    // Debug logging
    loggerWithChild({ email: email }).info(
      `Enhanced feedback request received
      ${JSON.stringify(
        {
          messageId,
          type,
          shareChat,
          customFeedback: !!customFeedback,
          selectedOptionsCount: selectedOptions?.length || 0,
        },
        null,
        2,
      )}
      },`,
    )

    const message = await getMessageByExternalId(db, messageId)
    if (!message) {
      throw new HTTPException(404, { message: "Message not found" })
    }
    if (
      message.email !== email ||
      message.workspaceExternalId !== workspaceId
    ) {
      throw new HTTPException(403, { message: "Forbidden" })
    }

    // Get user and chat info for potential share token generation
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const { user } = userAndWorkspace

    const chat = await getChatByExternalId(db, message.chatExternalId)
    if (!chat) {
      throw new HTTPException(404, { message: "Chat not found" })
    }

    // Create enhanced feedback data
    const feedbackData: any = {
      type,
      feedback: [],
      share_chat: null,
    }

    // Add custom feedback as first element if provided
    if (customFeedback && customFeedback.trim()) {
      feedbackData.feedback.push(customFeedback.trim())
    }

    // Add selected predefined options
    if (selectedOptions && selectedOptions.length > 0) {
      feedbackData.feedback.push(...selectedOptions)
    }

    // Ensure at least one feedback item
    if (feedbackData.feedback.length === 0) {
      feedbackData.feedback.push("") // Empty string placeholder
    }

    // Generate share token if user opted to share
    if (shareChat) {
      try {
        // Check if share already exists for this chat+message combination
        const existingShare = await db
          .select()
          .from(sharedChats)
          .where(
            and(
              eq(sharedChats.chatId, chat.id),
              eq(sharedChats.messageId, message.id),
            ),
          )
          .limit(1)

        let shareToken: string

        if (existingShare.length > 0) {
          // If it exists but is deleted, reactivate it
          if (existingShare[0].deletedAt) {
            await db
              .update(sharedChats)
              .set({
                deletedAt: null,
                updatedAt: new Date(),
              })
              .where(eq(sharedChats.id, existingShare[0].id))
          }
          shareToken = existingShare[0].shareToken
        } else {
          // Generate unique share token
          shareToken = nanoid(15)

          // Create shared chat
          await db.insert(sharedChats).values({
            chatId: chat.id,
            messageId: message.id,
            workspaceId: chat.workspaceId,
            userId: user.id,
            shareToken,
            title: chat.title,
          })
        }

        feedbackData.share_chat = shareToken

        loggerWithChild({ email: email }).info(
          `Share token generated for feedback submission: ${shareToken}`,
          { messageId, chatId: chat.externalId },
        )
      } catch (shareError) {
        // Log error but don't fail the feedback submission
        loggerWithChild({ email: email }).error(
          shareError,
          `Failed to generate share token for message ${messageId}, continuing with feedback submission`,
        )
        // Set share_chat to null if token generation fails
        feedbackData.share_chat = null
      }
    }

    await updateMessageByExternalId(db, messageId, {
      feedback: feedbackData, // Store enhanced feedback with share token
      updatedAt: new Date(),
    })

    loggerWithChild({ email: email }).info(
      `Enhanced feedback '${type}' submitted for message ${messageId} by user ${email}`,
      { feedbackData, shareRequested: shareChat },
    )

    likeDislikeCount.inc({ email: email, feedback: type })
    return c.json({
      success: true,
      messageId,
      feedbackData,
      shareToken: feedbackData.share_chat,
    })
  } catch (error) {
    const errMsg = getErrorMessage(error)

    loggerWithChild({ email: email }).error(
      error,
      `Enhanced Message Feedback Error: ${errMsg} ${(error as Error).stack}`,
    )
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, {
      message: "Could not submit enhanced feedback",
    })
  }
}

export const GenerateFollowUpQuestionsApi = async (c: Context) => {
  let email = ""
  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey) ?? {}
    email = sub || ""

    // @ts-ignore - Validation handled by middleware
    const { chatId, messageId } = c.req.valid("json")

    if (!chatId || !messageId) {
      throw new HTTPException(400, {
        message: "chatId and messageId are required",
      })
    }

    // Get user and workspace info
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const { user, workspace } = userAndWorkspace

    // Get chat messages for context
    const messages = await getChatMessagesWithAuth(db, chatId, email)

    if (!messages || messages.length === 0) {
      throw new HTTPException(404, { message: "No messages found in chat" })
    }

    // Find the specific message to ensure it exists
    const messageIndex = messages.findIndex(
      (msg) => msg.externalId === messageId,
    )
    if (messageIndex === -1) {
      throw new HTTPException(404, { message: "Message not found" })
    }

    // Use all messages from the chat for better context
    const contextMessages = messages

    // Format conversation context with all messages
    const conversationContext = contextMessages
      .map(
        (msg) =>
          `${msg.messageRole === "user" ? "User" : "Assistant"}: ${msg.message}`,
      )
      .join("\n\n")

    // Generate user context
    const ctx = userContext(userAndWorkspace)
    // Use the follow-up questions prompt
    const systemPrompt = generateFollowUpQuestionsSystemPrompt(ctx)

    const userPrompt = `Based on this conversation, generate 3 relevant follow-up questions:

${conversationContext}

The follow-up questions should be specific to this conversation and help the user explore related topics or get more detailed information about what was discussed.`

    // Call LLM to generate follow-up questions
    const response = await generateFollowUpQuestions(userPrompt, systemPrompt, {
      modelId: config.defaultFastModel,
      json: true,
      stream: false,
    })

    loggerWithChild({ email: email }).info(
      `Generated follow-up questions for message ${messageId} in chat ${chatId}`,
    )

    return c.json(response)
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
      error,
      `Generate Follow-Up Questions Error: ${errMsg} ${(error as Error).stack}`,
    )
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, {
      message: "Could not generate follow-up questions",
    })
  }
}

export const GetAvailableModelsApi = async (c: Context) => {
  let email = ""
  try {
    const { sub } = c.get(JwtPayloadKey) ?? {}
    email = sub || ""

    if (!email) {
      throw new HTTPException(400, { message: "Email is required" })
    }

    const availableModels = getAvailableModels({
      AwsAccessKey: config.AwsAccessKey,
      AwsSecretKey: config.AwsSecretKey,
      OpenAIKey: config.OpenAIKey,
      OllamaModel: config.OllamaModel,
      TogetherAIModel: config.TogetherAIModel,
      TogetherApiKey: config.TogetherApiKey,
      FireworksAIModel: config.FireworksAIModel,
      FireworksApiKey: config.FireworksApiKey,
      GeminiAIModel: config.GeminiAIModel,
      GeminiApiKey: config.GeminiApiKey,
      VertexAIModel: config.VertexAIModel,
      VertexProjectId: config.VertexProjectId,
      VertexRegion: config.VertexRegion,
    })

    // Filter out actualName and provider fields before sending to frontend
    const filteredModels = availableModels.map((model) => ({
      labelName: model.labelName,
      reasoning: model.reasoning,
      websearch: model.websearch,
      deepResearch: model.deepResearch,
      description: model.description,
    }))

    return c.json({ models: filteredModels })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email }).error(
      error,
      `Get Available Models Error: ${errMsg}`,
    )
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, {
      message: "Could not fetch available models",
    })
  }
}

// Generate chat title API - called after first response to update dummy title
export const GenerateChatTitleApi = async (c: Context) => {
  let email = ""
  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    email = sub

    // @ts-ignore
    const { chatId, message } = c.req.valid("json")

    const currentChat = await getChatMessagesWithAuth(db, chatId, email)
    let assistantResponse = ""
    if (
      currentChat[1]?.messageRole === "assistant" &&
      currentChat[1]?.message
    ) {
      assistantResponse = currentChat[1].message
    }

    const { user, workspace } = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )

    // Generate proper title using LLM
    loggerWithChild({ email: email }).info(
      `Generating title for chat ${chatId} with message: ${String(message).substring(0, 100)}...`,
    )

    const titleResp = await generateTitleUsingQuery(
      message,
      {
        modelId: defaultFastModel,
        stream: false,
      },
      assistantResponse,
    )

    loggerWithChild({ email: email }).info(
      `Generated title: ${titleResp.title}`,
    )

    // Update chat with proper title
    await updateChatByExternalIdWithAuth(db, chatId, email, {
      title: titleResp.title,
    })

    return c.json({
      success: true,
      title: titleResp.title,
    })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
      error,
      `Chat Title Generation Error: ${errMsg} ${(error as Error).stack}`,
    )
    // Return error but don't throw - this is background operation
    return c.json({ success: false, error: errMsg }, 500)
  }
}
