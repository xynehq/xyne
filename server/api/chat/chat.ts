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
  extractEmailsFromContext,
} from "@/ai/provider"
import { getConnectorByExternalId, getConnectorByApp } from "@/db/connector"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import {
  Models,
  QueryType,
  type ConverseResponse,
  type Intent,
  type QueryRouterLLMResponse,
  type QueryRouterResponse,
  type TemporalClassifier,
  type UserQuery,
} from "@/ai/types"
import config from "@/config"
import {
  deleteChatByExternalIdWithAuth,
  deleteMessagesByChatId,
  getChatByExternalId,
  getChatByExternalIdWithAuth,
  getFavoriteChats,
  getPublicChats,
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
} from "@/db/message"
import { eq } from "drizzle-orm"
import { getToolsByConnectorId, syncConnectorTools } from "@/db/tool"
import {
  selectPublicChatSchema,
  selectPublicMessagesSchema,
  messageFeedbackEnum,
  type SelectChat,
  type SelectMessage,
  selectMessageSchema,
  sharedChats,
} from "@/db/schema"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getLogger, getLoggerWithChild } from "@/logger"
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
  GetDocument,
  SearchEmailThreads,
} from "@/search/vespa"
import {
  Apps,
  CalendarEntity,
  chatMessageSchema,
  dataSourceFileSchema,
  DriveEntity,
  entitySchema,
  eventSchema,
  fileSchema,
  GooglePeopleEntity,
  isValidApp,
  isValidEntity,
  MailAttachmentEntity,
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
import { appToSchemaMapper, entityToSchemaMapper } from "@/search/mappers"
import { getDocumentOrSpreadsheet } from "@/integrations/google/sync"
// import type { S } from "ollama/dist/shared/ollama.6319775f.mjs"
import { isCuid } from "@paralleldrive/cuid2"
import { getAgentByExternalId, type SelectAgent } from "@/db/agent"
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
} from "./utils"
import { likeDislikeCount } from "@/metrics/app/app-metrics"
import {
  getAttachmentsByMessageId,
  storeAttachmentMetadata,
} from "@/db/attachment"
import type { AttachmentMetadata } from "@/shared/types"
import { parseAttachmentMetadata } from "@/utils/parseAttachment"
import { isImageFile } from "@/utils/image"
import { promises as fs } from "node:fs"
import path from "node:path"
import { nameToEmailResolutionPrompt } from "@/ai/prompts"
import { get } from "node:http"

const METADATA_NO_DOCUMENTS_FOUND = "METADATA_NO_DOCUMENTS_FOUND_INTERNAL"
const METADATA_FALLBACK_TO_RAG = "METADATA_FALLBACK_TO_RAG_INTERNAL"

export async function resolveNamesToEmails(
  intent: Intent,
  email: string,
  userCtx: string,
  span?: Span,
): Promise<any> {
  const resolveSpan = span?.startSpan("resolve_names_to_emails")

  try {
    const extractedNames = extractNamesFromIntent(intent)

    const allNames = [
      ...(extractedNames.from || []),
      ...(extractedNames.to || []),
      ...(extractedNames.cc || []),
      ...(extractedNames.bcc || []),
      ...(extractedNames.subject || []),
    ]

    if (allNames.length === 0) {
      resolveSpan?.setAttribute("no_names_found", true)
      resolveSpan?.end()
      return intent
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
      return intent
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

    console.log(searchResults.root.children.length, "search results length")
    searchSpan?.setAttribute("search_query", searchQuery)
    searchSpan?.setAttribute(
      "results_count",
      searchResults.root.children?.length || 0,
    )
    searchSpan?.end()

    const resultCount = searchResults.root.children?.length || 0

    if (
      !searchResults.root.children ||
      searchResults.root.children.length === 0
    ) {
      return intent
    }

    const searchContext = searchResults.root.children
      .map((result, index) => {
        const fields = result.fields as VespaMail
        const contextLine = `
        [Index ${index}]: 
        Sent: ${getRelativeTime(fields.timestamp)}  (${new Date(fields.timestamp).toLocaleString()})
        Subject: ${fields.subject || "Unknown"}
        From: <${fields.from}>
        To: <${fields.to}>
        CC: <${fields.cc}>
        BCC: <${fields.bcc}>
        `

        return contextLine
      })
      .join("\n")

    let resolvedData: Intent = {}
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
    return intent
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
      throw new HTTPException(500, { message: "Chat trace not found" })
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

export const textToCitationIndex = /\[(\d+)\]/g
export const textToImageCitationIndex = /\[(\d+_\d+)\]/g
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

// the Set is passed by reference so that singular object will get updated
// but need to be kept in mind
const checkAndYieldCitations = async function* (
  textInput: string,
  yieldedCitations: Set<number>,
  results: any[],
  baseIndex: number = 0,
  email: string,
  yieldedImageCitations: Set<number>,
) {
  const text = splitGroupedCitationsWithSpaces(textInput)
  let match
  let imgMatch
  while (
    (match = textToCitationIndex.exec(text)) !== null ||
    (imgMatch = textToImageCitationIndex.exec(text)) !== null
  ) {
    if (match) {
      const citationIndex = parseInt(match[1], 10)
      if (!yieldedCitations.has(citationIndex)) {
        const item = results[citationIndex - baseIndex]
        if (item) {
          yield {
            citation: {
              index: citationIndex,
              item: searchToCitation(item as VespaSearchResults),
            },
          }
          yieldedCitations.add(citationIndex)
        } else {
          loggerWithChild({ email: email }).error(
            "Found a citation index but could not find it in the search result ",
            citationIndex,
            results.length,
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
              "Found a citation index but could not find it in the search result ",
              citationIndex,
              results.length,
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

async function* processIterator(
  iterator: AsyncIterableIterator<ConverseResponse>,
  results: VespaSearchResult[],
  previousResultsLength: number = 0,
  userRequestsReasoning?: boolean,
  email?: string,
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
    await db.transaction(async (tx) => {
      // Get the chat's internal ID first
      const chat = await getChatByExternalIdWithAuth(tx, chatId, email)
      if (!chat) {
        throw new HTTPException(404, { message: "Chat not found" })
      }

      // Get all messages for the chat to find attachments
      const messagesToDelete = await getChatMessagesWithAuth(tx, chatId, email)

      // Collect all attachment file IDs that need to be deleted
      const imageAttachmentFileIds: string[] = []
      const nonImageAttachmentFileIds: string[] = []

      for (const message of messagesToDelete) {
        if (message.attachments && Array.isArray(message.attachments)) {
          const attachments =
            message.attachments as unknown as AttachmentMetadata[]
          for (const attachment of attachments) {
            if (attachment && typeof attachment === "object") {
              if (attachment.fileId) {
                // Check if this is an image attachment using both isImage field and fileType
                const isImageAttachment =
                  attachment.isImage ||
                  (attachment.fileType && isImageFile(attachment.fileType))

                if (isImageAttachment) {
                  imageAttachmentFileIds.push(attachment.fileId)
                } else {
                  // TODO: Handle non-image attachments in future implementation
                  nonImageAttachmentFileIds.push(attachment.fileId)
                  loggerWithChild({ email: email }).info(
                    `Non-image attachment ${attachment.fileId} (${attachment.fileType}) found - TODO: implement deletion logic for non-image attachments`,
                  )
                }
              }
            }
          }
        }
      }

      // Delete image attachments and their thumbnails from disk
      if (imageAttachmentFileIds.length > 0) {
        loggerWithChild({ email: email }).info(
          `Deleting ${imageAttachmentFileIds.length} image attachment files and their thumbnails for chat ${chatId}`,
        )

        for (const fileId of imageAttachmentFileIds) {
          try {
            // Validate fileId to prevent path traversal
            if (
              fileId.includes("..") ||
              fileId.includes("/") ||
              fileId.includes("\\")
            ) {
              loggerWithChild({ email: email }).error(
                `Invalid fileId detected: ${fileId}. Skipping deletion for security.`,
              )
              continue
            }
            const imageBaseDir = path.resolve(
              process.env.IMAGE_DIR || "downloads/xyne_images_db",
            )

            const imageDir = path.join(imageBaseDir, fileId)
            try {
              await fs.access(imageDir)
              await fs.rm(imageDir, { recursive: true, force: true })
              loggerWithChild({ email: email }).info(
                `Deleted image attachment directory: ${imageDir}`,
              )
            } catch (attachmentError) {
              loggerWithChild({ email: email }).warn(
                `Image attachment file ${fileId} not found in either directory during chat deletion`,
              )
            }
          } catch (error) {
            loggerWithChild({ email: email }).error(
              error,
              `Failed to delete image attachment file ${fileId} during chat deletion: ${getErrorMessage(error)}`,
            )
          }
        }
      }

      // TODO: Implement deletion logic for non-image attachments
      if (nonImageAttachmentFileIds.length > 0) {
        loggerWithChild({ email: email }).info(
          `Found ${nonImageAttachmentFileIds.length} non-image attachments that need deletion logic implementation`,
        )
        // TODO: Add specific deletion logic for different types of non-image attachments
        // This could include:
        // - PDFs: Delete from document storage directories
        // - Documents (DOCX, DOC): Delete from document storage directories
        // - Spreadsheets (XLSX, XLS): Delete from document storage directories
        // - Presentations (PPTX, PPT): Delete from document storage directories
        // - Text files: Delete from text storage directories
        // - Other file types: Implement based on file type and storage location
        // For now, we just log that we found them but don't delete them to avoid data loss
      }

      // Delete shared chats associated with this chat
      await tx.delete(sharedChats).where(eq(sharedChats.chatId, chat.id))

      // First delete chat traces to avoid cascade violations
      await deleteChatTracesByChatExternalId(tx, chatId)
      // Second we have to delete all messages associated with that chat
      await deleteMessagesByChatId(tx, chatId)
      await deleteChatByExternalIdWithAuth(tx, chatId, email)
    })
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
  let email = ""
  try {
    const { sub } = c.get(JwtPayloadKey)
    const email = sub
    // @ts-ignore
    const { page } = c.req.valid("query")
    const offset = page * chatHistoryPageSize
    return c.json(await getPublicChats(db, email, chatHistoryPageSize, offset))
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

function buildContext(
  results: VespaSearchResult[],
  maxSummaryCount: number | undefined,
  startIndex: number = 0,
): string {
  return cleanContext(
    results
      ?.map(
        (v, i) =>
          `Index ${i + startIndex} \n ${answerContextMap(
            v as z.infer<typeof VespaSearchResultsSchema>,
            maxSummaryCount,
          )}`,
      )
      ?.join("\n"),
  )
}

async function* generateIterativeTimeFilterAndQueryRewrite(
  input: string,
  messages: Message[],
  email: string,
  userCtx: string,
  alpha: number = 0.5,
  pageSize: number = 10,
  maxPageNumber: number = 3,
  maxSummaryCount: number | undefined,
  classification: QueryRouterLLMResponse,
  userRequestsReasoning?: boolean,
  queryRagSpan?: Span,
  agentPrompt?: string,
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
        "agentPromptData.appIntegrations is not an array or is missing",
        { agentPromptData },
      )
    }
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
  let searchResults
  if (!agentPrompt) {
    searchResults = await searchVespa(message, email, null, null, {
      limit: pageSize,
      alpha: userAlpha,
      timestampRange,
      span: initialSearchSpan,
    })
  } else {
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
      },
    )
  }

  // Expand email threads in the results
  searchResults.root.children = await expandEmailThreadsInResults(
    searchResults.root.children || [],
    email,
    initialSearchSpan,
  )

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
      let results
      if (!agentPrompt) {
        results = await searchVespa(message, email, null, null, {
          limit: pageSize,
          alpha: userAlpha,
          span: vespaSearchSpan,
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
          },
        )
      }

      // Expand email threads in the results
      results.root.children = await expandEmailThreadsInResults(
        results.root.children || [],
        email,
        vespaSearchSpan,
      )
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

      const initialContext = buildContext(
        results?.root?.children,
        maxSummaryCount,
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
            })
          : searchVespaAgent(query, email, null, null, agentAppEnums, {
              limit: pageSize,
              alpha: userAlpha,
              timestampRange,
              span: latestSearchSpan,
              dataSourceIds: agentSpecificDataSourceIds,
            }))

        // Expand email threads in the results
        const expandedChildren = await expandEmailThreadsInResults(
          latestSearchResponse.root.children || [],
          email,
          latestSearchSpan,
        )
        const latestResults: VespaSearchResult[] = expandedChildren
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
        let results
        if (!agentPrompt) {
          results = await searchVespa(query, email, null, null, {
            limit: pageSize,
            alpha: userAlpha,
            excludedIds: latestResults
              ?.map((v: VespaSearchResult) => (v.fields as any).docId)
              ?.filter((v) => !!v),
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
            },
          )
        }

        // Expand email threads in the results
        results.root.children = await expandEmailThreadsInResults(
          results.root.children || [],
          email,
          vespaSearchSpan,
        )

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
        const initialContext = buildContext(totalResults, maxSummaryCount)

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
        )

        const answer = yield* processIterator(
          iterator,
          totalResults,
          previousResultsLength,
          config.isReasoning && userRequestsReasoning,
          email,
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
          limit: pageSize,
          offset: pageNumber * pageSize,
          alpha: userAlpha,
          excludedIds: latestIds,
          span: searchSpan,
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
            offset: pageNumber * pageSize,
            alpha: userAlpha,
            excludedIds: latestIds,
            span: searchSpan,
            dataSourceIds: agentSpecificDataSourceIds,
          },
        )
      }

      // Expand email threads in the results
      results.root.children = await expandEmailThreadsInResults(
        results.root.children || [],
        email,
        searchSpan,
      )
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
          limit: pageSize,
          offset: pageNumber * pageSize,
          alpha: userAlpha,
          span: searchSpan,
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
            offset: pageNumber * pageSize,
            alpha: userAlpha,
            span: searchSpan,
            dataSourceIds: agentSpecificDataSourceIds,
          },
        )
      }

      // Expand email threads in the results
      results.root.children = await expandEmailThreadsInResults(
        results.root.children || [],
        email,
        searchSpan,
      )

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
    const initialContext = buildContext(
      results?.root?.children,
      maxSummaryCount,
      startIndex,
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

    const iterator = baselineRAGJsonStream(input, userCtx, initialContext, {
      stream: true,
      modelId: defaultBestModel,
      reasoning: config.isReasoning && userRequestsReasoning,
      agentPrompt,
      messages,
      imageFileNames,
    })

    const answer = yield* processIterator(
      iterator,
      results?.root?.children,
      previousResultsLength,
      config.isReasoning && userRequestsReasoning,
      email,
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
  alpha: number = 0.5,
  fileIds: string[],
  userRequestsReasoning: boolean,
  agentPrompt?: string,
  passedSpan?: Span,
  threadIds?: string[],
  attachmentFileIds?: string[],
): AsyncIterableIterator<
  ConverseResponse & {
    citation?: { index: number; item: any }
    imageCitation?: ImageCitation
  }
> {
  const message = input
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

  let previousResultsLength = 0
  const results =
    fileIds.length > 0
      ? await GetDocumentsByDocIds(fileIds, generateAnswerSpan!)
      : { root: { children: [] } }
  if (!results.root.children) {
    results.root.children = []
  }
  loggerWithChild({ email: email }).info(
    `generateAnswerFromGivenContext - threadIds received: ${JSON.stringify(threadIds)}`,
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
          results.root.children.map((child: any) => child.fields.docId),
        )

        // Use the helper function to process thread results
        const { addedCount, threadInfo } = processThreadResults(
          threadResults.root.children,
          existingDocIds,
          results.root.children,
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
  const startIndex = isReasoning ? previousResultsLength : 0
  const initialContext = cleanContext(
    results?.root?.children
      ?.map(
        (v, i) =>
          `Index ${i + startIndex} \n ${answerContextMap(
            v as z.infer<typeof VespaSearchResultsSchema>,
            0,
            true,
          )}`,
      )
      ?.join("\n"),
  )

  const { imageFileNames } = extractImageFileNames(
    initialContext,
    results?.root?.children,
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
    results.root?.children?.length || 0,
  )
  initialContextSpan?.end()

  loggerWithChild({ email: email }).info(
    `[Selected Context Path] Number of contextual chunks being passed: ${
      results?.root?.children?.length || 0
    }`,
  )

  const selectedContext = isContextSelected(message)
  const builtUserQuery = selectedContext
    ? buildUserQuery(selectedContext)
    : message
  const iterator = baselineRAGJsonStream(
    builtUserQuery,
    userCtx,
    initialContext,
    {
      stream: true,
      modelId: defaultBestModel,
      reasoning: config.isReasoning && userRequestsReasoning,
      agentPrompt,
      imageFileNames: finalImageFileNames,
    },
    true,
  )

  const answer = yield* processIterator(
    iterator,
    results?.root?.children,
    previousResultsLength,
    userRequestsReasoning,
    email,
  )
  if (answer) {
    generateAnswerSpan?.setAttribute("answer_found", true)
    generateAnswerSpan?.end()
    return
  } else if (!answer) {
    // If we give the whole context then also if there's no answer then we can just search once and get the best matching chunks with the query and then make context try answering
    loggerWithChild({ email: email }).info(
      "No answer was found when all chunks were given, trying to answer after searching vespa now",
    )
    let results =
      fileIds.length > 0
        ? await searchVespaInFiles(builtUserQuery, email, fileIds, {
            limit: fileIds?.length,
            alpha: userAlpha,
          })
        : { root: { children: [] } }

    const searchVespaSpan = generateAnswerSpan?.startSpan("searchVespaSpan")
    searchVespaSpan?.setAttribute("parsed_message", message)
    searchVespaSpan?.setAttribute("msgToSearch", builtUserQuery)
    searchVespaSpan?.setAttribute("limit", fileIds?.length)
    searchVespaSpan?.setAttribute(
      "results length",
      results?.root?.children?.length || 0,
    )

    if (!results.root.children) {
      results.root.children = []
    }
    const startIndex = isReasoning ? previousResultsLength : 0
    const initialContext = cleanContext(
      results?.root?.children
        ?.map(
          (v, i) =>
            `Index ${i + startIndex} \n ${answerContextMap(
              v as z.infer<typeof VespaSearchResultsSchema>,
              20,
              true,
            )}`,
        )
        ?.join("\n"),
    )
    loggerWithChild({ email: email }).info(
      `[Selected Context Path] Number of contextual chunks being passed: ${
        results?.root?.children?.length || 0
      }`,
    )

    const { imageFileNames } = extractImageFileNames(
      initialContext,
      results?.root?.children,
    )

    searchVespaSpan?.setAttribute("context_length", initialContext?.length || 0)
    searchVespaSpan?.setAttribute("context", initialContext || "")
    searchVespaSpan?.setAttribute(
      "number_of_chunks",
      results.root?.children?.length || 0,
    )

    const iterator =
      fileIds.length > 0
        ? baselineRAGJsonStream(
            builtUserQuery,
            userCtx,
            initialContext,
            {
              stream: true,
              modelId: defaultBestModel,
              reasoning: config.isReasoning && userRequestsReasoning,
              imageFileNames,
            },
            true,
          )
        : null

    const answer = iterator
      ? yield* processIterator(
          iterator,
          results?.root?.children,
          previousResultsLength,
          userRequestsReasoning,
          email,
        )
      : null
    if (answer) {
      searchVespaSpan?.setAttribute("answer_found", true)
      searchVespaSpan?.end()
      generateAnswerSpan?.end()
      return
    } else if (
      // If no answer found, exit and yield nothing related to selected context found
      !answer
    ) {
      const noAnswerSpan = searchVespaSpan?.startSpan("no_answer_response")
      yield {
        text: "From the selected context, I could not find any information to answer it, please change your query",
      }
      noAnswerSpan?.end()
      searchVespaSpan?.end()
      generateAnswerSpan?.end()
      return
    }
    if (config.isReasoning && userRequestsReasoning) {
      previousResultsLength += results?.root?.children?.length || 0
    }
  }
  if (config.isReasoning && userRequestsReasoning) {
    previousResultsLength += results?.root?.children?.length || 0
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

const getSearchRangeSummary = (
  from: number,
  to: number,
  direction: string,
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
  alpha: number,
  pageSize: number = 10,
  maxSummaryCount: number | undefined,
  userRequestsReasoning: boolean,
  eventRagSpan?: Span,
  agentPrompt?: string,
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
        "agentPromptData.appIntegrations is not an array or is missing",
        { agentPromptData },
      )
    }
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
    iterationSpan?.setAttribute("from", new Date(from).toLocaleString())
    iterationSpan?.setAttribute("to", new Date(to).toLocaleString())
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
        }),
      ])
    }

    if (agentPrompt) {
      if (agentAppEnums.length > 0 || agentSpecificDataSourceIds.length > 0) {
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
            },
          ),
          searchVespaAgent(message, email, null, null, agentAppEnums, {
            limit: pageSize,
            alpha: userAlpha,
            timestampRange: { to, from },
            notInMailLabels: ["CATEGORY_PROMOTIONS"],
            span: emailSearchSpan,
            dataSourceIds: agentSpecificDataSourceIds,
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
    const initialContext = buildContext(
      combinedResults?.root?.children,
      maxSummaryCount,
      startIndex,
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
    const iterator = meetingPromptJsonStream(input, userCtx, initialContext, {
      stream: true,
      modelId: defaultBestModel,
      reasoning: config.isReasoning && userRequestsReasoning,
      agentPrompt,
      imageFileNames,
    })

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
  app: Apps,
  entity: any,
  chunksCount: number | undefined,
  userRequestsReasoning?: boolean,
  span?: Span,
  email?: string,
  agentContext?: string,
) {
  if (app === Apps.GoogleDrive) {
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
  const context = buildContext(items, chunksCount)
  const { imageFileNames } = extractImageFileNames(context, items)
  const streamOptions = {
    stream: true,
    modelId: defaultBestModel,
    reasoning: config.isReasoning && userRequestsReasoning,
    imageFileNames,
    agentPrompt: agentContext,
  }

  let iterator: AsyncIterableIterator<ConverseResponse>
  if (app === Apps.Gmail) {
    loggerWithChild({ email: email ?? "" }).info(`Using mailPromptJsonStream `)
    iterator = mailPromptJsonStream(input, userCtx, context, streamOptions)
  } else {
    loggerWithChild({ email: email ?? "" }).info(`Using baselineRAGJsonStream`)
    iterator = baselineRAGJsonStream(input, userCtx, context, streamOptions)
  }

  return yield* processIterator(
    iterator,
    items,
    0,
    config.isReasoning && userRequestsReasoning,
  )
}

async function* generateMetadataQueryAnswer(
  input: string,
  messages: Message[],
  email: string,
  userCtx: string,
  userAlpha: number = 0.5,
  pageSize: number = 10,
  maxSummaryCount: number | undefined,
  classification: QueryRouterLLMResponse,
  userRequestsReasoning?: boolean,
  span?: Span,
  agentPrompt?: string,
  maxIterations = 5,
): AsyncIterableIterator<
  ConverseResponse & {
    citation?: { index: number; item: any }
    imageCitation?: ImageCitation
  }
> {
  const { app, entity, startTime, endTime, sortDirection, intent } =
    classification.filters
  const count = classification.filters.count
  const direction = classification.direction as string
  const isGenericItemFetch = classification.type === QueryType.GetItems
  const isFilteredItemSearch =
    classification.type === QueryType.SearchWithFilters
  const isValidAppOrEntity =
    isValidApp(app as Apps) || isValidEntity(entity as any)
  let agentAppEnums: Apps[] = []
  let agentSpecificDataSourceIds: string[] = []
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
        "agentPromptData.appIntegrations is not an array or is missing",
        { agentPromptData },
      )
    }
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
    `App : "${app}" , Entity : "${entity}"` +
      (timeDescription ? `, ${directionText} ${timeDescription}` : ""),
  )
  let schema: VespaSchema | null
  if (!entity && app) {
    schema = appToSchemaMapper(app)
  } else {
    schema = entityToSchemaMapper(entity, app)
  }

  let items: VespaSearchResult[] = []

  // Determine search strategy based on conditions
  if (
    !isValidAppOrEntity &&
    classification.filterQuery &&
    classification.filters?.sortDirection === "desc"
  ) {
    let resolvedIntent = intent || {}
    if (intent && Object.keys(intent).length > 0 && app === Apps.Gmail) {
      loggerWithChild({ email: email }).info(
        `[${QueryType.SearchWithoutFilters}] Detected names in intent, resolving to emails: ${JSON.stringify(intent)}`,
      )
      resolvedIntent = await resolveNamesToEmails(intent, email, userCtx, span)
      loggerWithChild({ email: email }).info(
        `[${QueryType.SearchWithoutFilters}] Resolved intent: ${JSON.stringify(resolvedIntent)}`,
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
      intent: resolvedIntent,
    }

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const pageSpan = span?.startSpan(`search_iteration_${iteration}`)
      loggerWithChild({ email: email }).info(
        `Search Iteration - ${iteration} : ${SearchModes.GlobalSorted}`,
      )

      let searchResults
      if (!agentPrompt) {
        searchResults = await searchVespa(
          classification.filterQuery,
          email,
          app ?? null,
          entity ?? null,
          {
            ...searchOps,
            offset: pageSize * iteration,
            span: pageSpan,
          },
        )
      } else {
        searchResults = await searchVespaAgent(
          classification.filterQuery,
          email,
          app ?? null,
          entity ?? null,
          agentAppEnums,
          {
            ...searchOps,
            offset: pageSize * iteration,
            span: pageSpan,
            dataSourceIds: agentSpecificDataSourceIds,
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

      pageSpan?.setAttribute("context", buildContext(items, 20))
      if (!items.length) {
        loggerWithChild({ email: email }).info(
          `No documents found on iteration ${iteration}${
            hasValidTimeRange
              ? " within time range."
              : " falling back to iterative RAG"
          }`,
        )
        pageSpan?.end()
        yield { text: "null" }
        return
      }

      const answer = yield* processResultsForMetadata(
        items,
        input,
        userCtx,
        app as Apps,
        entity,
        undefined,
        userRequestsReasoning,
        span,
        email,
        agentPrompt,
      )

      if (answer == null) {
        pageSpan?.setAttribute("answer", null)
        if (iteration == maxIterations - 1) {
          pageSpan?.end()
          yield { text: "null" }
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
      ? Math.min(count, config.maxUserRequestCount)
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

    let resolvedIntent = intent || {}
    if (intent && Object.keys(intent).length > 0 && app === Apps.Gmail) {
      loggerWithChild({ email: email }).info(
        `[${QueryType.SearchWithoutFilters}] Detected names in intent, resolving to emails: ${JSON.stringify(intent)}`,
      )
      resolvedIntent = await resolveNamesToEmails(intent, email, userCtx, span)
      loggerWithChild({ email: email }).info(
        `[${QueryType.SearchWithoutFilters}] Resolved intent: ${JSON.stringify(resolvedIntent)}`,
      )
    }

    if (!schema) {
      loggerWithChild({ email: email }).error(
        `[generateMetadataQueryAnswer] Could not determine a valid schema for app: ${app}, entity: ${entity}`,
      )
      span?.setAttribute("error", "Schema determination failed")
      span?.setAttribute("app_for_schema_failure", app || "undefined")
      span?.setAttribute("entity_for_schema_failure", entity || "undefined")

      yield { text: METADATA_FALLBACK_TO_RAG }
      return
    }
    let searchResults
    items = []
    if (agentPrompt) {
      if (agentAppEnums.find((x) => x == app)) {
        loggerWithChild({ email: email }).info(
          `[GetItems] Calling getItems with agent prompt - Schema: ${schema}, App: ${app}, Entity: ${entity}, Intent: ${JSON.stringify(classification.filters.intent)}`,
        )
        searchResults = await getItems({
          email,
          schema,
          app: app ?? null,
          entity: entity ?? null,
          timestampRange,
          limit: userSpecifiedCountLimit,
          asc: sortDirection === "asc",
          intent: resolvedIntent || {},
        })
        items = searchResults!.root.children || []
        loggerWithChild({ email: email }).info(
          `[GetItems] Agent query completed - Retrieved ${items.length} items`,
        )
      }
    } else {
      loggerWithChild({ email: email }).info(
        `[GetItems] Calling getItems - Schema: ${schema}, App: ${app}, Entity: ${entity}, Intent: ${JSON.stringify(classification.filters.intent)}`,
      )

      const getItemsParams = {
        email,
        schema,
        app: app ?? null,
        entity: entity ?? null,
        timestampRange,
        limit: userSpecifiedCountLimit,
        asc: sortDirection === "asc",
        intent: resolvedIntent || {},
      }

      loggerWithChild({ email: email }).info(
        `[GetItems] Query parameters: ${JSON.stringify(getItemsParams)}`,
      )

      searchResults = await getItems(getItemsParams)
      items = searchResults!.root.children || []
      loggerWithChild({ email: email }).info(
        `[GetItems] Query completed - Retrieved ${items.length} items`,
      )
    }

    span?.setAttribute(`retrieved documents length`, items.length)
    span?.setAttribute(
      `retrieved documents id's`,
      JSON.stringify(
        items.map((v: VespaSearchResult) => (v.fields as any).docId),
      ),
    )

    span?.setAttribute("context", buildContext(items, 20))
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
      app as Apps,
      entity,
      maxSummaryCount,
      userRequestsReasoning,
      span,
      email,
      agentPrompt,
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
    let query = filterQuery
    const rankProfile =
      sortDirection === "desc"
        ? SearchModes.GlobalSorted
        : SearchModes.NativeRank

    let resolvedIntent = {} as any
    if (intent && Object.keys(intent).length > 0) {
      loggerWithChild({ email: email }).info(
        `[SearchWithFilters] Detected names in intent, resolving to emails: ${JSON.stringify(intent)}`,
      )
      resolvedIntent = await resolveNamesToEmails(intent, email, userCtx, span)
      loggerWithChild({ email: email }).info(
        `[SearchWithFilters] Resolved intent: ${JSON.stringify(resolvedIntent)}`,
      )
    }

    const searchOptions = {
      limit: pageSize,
      alpha: userAlpha,
      rankProfile,
      timestampRange:
        timestampRange.to || timestampRange.from ? timestampRange : null,
      intent: resolvedIntent,
    }

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const iterationSpan = span?.startSpan(`search_iteration_${iteration}`)
      loggerWithChild({ email: email }).info(
        `Search ${QueryType.SearchWithFilters} Iteration - ${iteration} : ${rankProfile}`,
      )

      let searchResults
      if (!agentPrompt) {
        searchResults = await searchVespa(
          query,
          email,
          app ?? null,
          entity ?? null,
          {
            ...searchOptions,
            offset: pageSize * iteration,
          },
        )
      } else {
        searchResults = await searchVespaAgent(
          query,
          email,
          app ?? null,
          entity ?? null,
          agentAppEnums,
          {
            ...searchOptions,
            offset: pageSize * iteration,
            dataSourceIds: agentSpecificDataSourceIds,
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
      iterationSpan?.setAttribute(`context`, buildContext(items, 20))
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
        app as Apps,
        entity,
        undefined,
        userRequestsReasoning,
        span,
        email,
        agentPrompt,
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
  const { app, entity } = classification.filters
  const direction = classification.direction || ""
  const { startTime, endTime } = classification.filters
  const from = new Date(startTime ?? "").getTime()
  const to = new Date(endTime ?? "").getTime()
  const timePhrase = formatTimeDuration(from, to)

  let searchDescription = ""

  if (app === Apps.GoogleCalendar && entity === "event") {
    searchDescription = "calendar events"
  } else if (app === Apps.Gmail) {
    if (entity === "mail") {
      searchDescription = "emails"
    } else if (entity === "pdf") {
      searchDescription = "email attachments"
    }
  } else if (app === Apps.GoogleDrive) {
    if (entity === "driveFile") {
      searchDescription = "files"
    } else if (entity === "docs") {
      searchDescription = "Google Docs"
    } else if (entity === "sheets") {
      searchDescription = "Google Sheets"
    } else if (entity === "slides") {
      searchDescription = "Google Slides"
    } else if (entity === "pdf") {
      searchDescription = "PDF files"
    } else if (entity === "folder") {
      searchDescription = "folders"
    }
  } else if (
    app === Apps.GoogleWorkspace &&
    entity === GooglePeopleEntity.Contacts
  ) {
    searchDescription = "contacts"
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

export async function* UnderstandMessageAndAnswer(
  email: string,
  userCtx: string,
  message: string,
  classification: QueryRouterLLMResponse,
  messages: Message[],
  alpha: number,
  userRequestsReasoning: boolean,
  passedSpan?: Span,
  agentPrompt?: string,
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
      alpha,
      count,
      maxDefaultSummary,
      classification,
      config.isReasoning && userRequestsReasoning,
      metadataRagSpan,
      agentPrompt,
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
    classification.filters.app === Apps.GoogleCalendar
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
      alpha,
      chatPageSize,
      maxDefaultSummary,
      userRequestsReasoning,
      eventRagSpan,
      agentPrompt,
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
      alpha,
      chatPageSize,
      3,
      maxDefaultSummary,
      classification,
      userRequestsReasoning,
      ragSpan,
      agentPrompt, // Pass agentPrompt to generateIterativeTimeFilterAndQueryRewrite
    )
  }
}

export async function* UnderstandMessageAndAnswerForGivenContext(
  email: string,
  userCtx: string,
  message: string,
  alpha: number,
  fileIds: string[],
  userRequestsReasoning: boolean,
  passedSpan?: Span,
  threadIds?: string[],
  attachmentFileIds?: string[],
  agentPrompt?: string,
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
    alpha,
    fileIds,
    userRequestsReasoning,
    agentPrompt,
    passedSpan,
    threadIds,
    attachmentFileIds,
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
    loggerWithChild({ email: email }).info("MessageApi..")
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

    // @ts-ignore
    const body = c.req.valid("query")
    const isAgentic = c.req.query("agentic") === "true"
    let {
      message,
      chatId,
      modelId,
      isReasoningEnabled,
      agentId,
    }: MessageReqType = body
    const agentPromptValue = agentId && isCuid(agentId) ? agentId : undefined // Use undefined if not a valid CUID
    if (isAgentic) {
      Logger.info(`Routing to MessageWithToolsApi`)
      return MessageWithToolsApi(c)
    }
    const attachmentMetadata = parseAttachmentMetadata(c)
    const attachmentFileIds = attachmentMetadata.map(
      (m: AttachmentMetadata) => m.fileId,
    )

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
      if (!isAgentic && agentDetails) {
        Logger.info(`Routing to AgentMessageApi for agent ${agentPromptValue}.`)
        return AgentMessageApi(c)
      }
    }

    // If none of the above, proceed with default RAG flow
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
          threadIds: [],
        }
    const fileIds = extractedInfo?.fileIds
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
    const ctx = userContext(userAndWorkspace)
    let chat: SelectChat

    const chatCreationSpan = rootSpan.startSpan("chat_creation")

    let title = ""
    let attachmentStorageError: Error | null = null
    if (!chatId) {
      loggerWithChild({ email: email }).info(
        `MessageApi before the span.. ${chatId}`,
      )
      const titleSpan = chatCreationSpan.startSpan("generate_title")
      loggerWithChild({ email: email }).info(
        `MessageApi after the span.. ${titleSpan}`,
      )
      // let llm decide a title
      const titleResp = await generateTitleUsingQuery(message, {
        modelId: ragPipelineConfig[RagPipelineStages.NewChatTitle].modelId,
        stream: false,
      })
      loggerWithChild({ email: email }).info(
        `MessageApi after the titleResp.. ${titleResp}`,
      )
      title = titleResp.title
      const cost = titleResp.cost
      if (cost) {
        costArr.push(cost)
        titleSpan.setAttribute("cost", cost)
      }
      titleSpan.setAttribute("title", title)
      titleSpan.end()

      loggerWithChild({ email: email }).info(
        `MessageApi before the first message.. ${titleSpan}`,
      )
      let [insertedChat, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage]> => {
          const chat = await insertChat(tx, {
            workspaceId: workspace.id,
            workspaceExternalId: workspace.externalId,
            userId: user.id,
            email: user.email,
            title,
            attachments: [],
            agentId: agentPromptValue,
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
            modelId,
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
        activeStreams.set(streamKey, stream) // Add stream to the map
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

          if (
            (isMsgWithContext && fileIds && fileIds?.length > 0) ||
            (attachmentFileIds && attachmentFileIds?.length > 0)
          ) {
            loggerWithChild({ email: email }).info(
              "User has selected some context with query, answering only based on that given context",
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
              message,
              0.5,
              fileIds || [],
              userRequestsReasoning,
              understandSpan,
              threadIds,
              attachmentFileIds,
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
              processMessage(answer, citationMap, email),
            )
            answerSpan.setAttribute("actual_answer", answer)
            answerSpan.setAttribute("final_answer_length", answer.length)
            answerSpan.end()

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
                imageCitations: imageCitations,
                message: processMessage(answer, citationMap, email),
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
            const filteredMessages = messages
              .slice(0, messages.length - 1)
              .filter((msg) => !msg?.errorMessage)
              .filter(
                (msg) =>
                  !(msg.messageRole === MessageRole.Assistant && !msg.message),
              )

            loggerWithChild({ email: email }).info(
              "Checking if answer is in the conversation or a mandatory query rewrite is needed before RAG",
            )

            const topicConversationThread = buildTopicConversationThread(
              filteredMessages,
              filteredMessages.length - 1,
            )
            const llmFormattedMessages: Message[] = formatMessagesForLLM(
              topicConversationThread,
            )

            const searchOrAnswerIterator =
              generateSearchQueryOrAnswerFromConversation(message, ctx, {
                modelId:
                  ragPipelineConfig[RagPipelineStages.AnswerOrSearch].modelId,
                stream: true,
                json: true,
                agentPrompt: agentPromptValue,
                reasoning:
                  userRequestsReasoning &&
                  ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning,
                messages: llmFormattedMessages,
                // agentPrompt: agentPrompt, // agentPrompt here is the original from request, might be empty string
                // AgentMessageApi/CombinedAgentSlackApi handle fetching full agent details
                // For this non-agent RAG path, we don't pass an agent prompt.
              })

            // TODO: for now if the answer is from the conversation itself we don't
            // add any citations for it, we can refer to the original message for citations
            // one more bug is now llm automatically copies the citation text sometimes without any reference
            // leads to [NaN] in the answer
            let currentAnswer = ""
            let answer = ""
            let citations = []
            let imageCitations: any[] = []
            let citationMap: Record<number, number> = {}
            let queryFilters = {
              app: "",
              entity: "",
              startTime: "",
              endTime: "",
              count: 0,
              sortDirection: "",
              intent: {},
            }
            let parsed = {
              isFollowUp: false,
              answer: "",
              queryRewrite: "",
              temporalDirection: null,
              filterQuery: "",
              type: "",
              intent: {},
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
            }

            conversationSpan.setAttribute("answer_found", parsed.answer)
            conversationSpan.setAttribute("answer", answer)
            conversationSpan.setAttribute("query_rewrite", parsed.queryRewrite)
            conversationSpan.end()
            let classification
            const {
              app,
              count,
              endTime,
              entity,
              sortDirection,
              startTime,
              intent,
            } = parsed?.filters
            classification = {
              direction: parsed.temporalDirection,
              type: parsed.type,
              filterQuery: parsed.filterQuery,
              isFollowUp: parsed.isFollowUp,
              filters: {
                app: app as Apps,
                entity: entity as Entity,
                endTime,
                sortDirection,
                startTime,
                count,
                intent: intent || {},
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
                // If it's marked as a follow-up, try to reuse the last user message's classification
                const lastUserMessage = messages[messages.length - 3] // Assistant is at -2, last user is at -3
                const parsedMessage =
                  selectMessageSchema.safeParse(lastUserMessage)

                if (parsedMessage.error) {
                  loggerWithChild({ email: email }).error(
                    `Error while parsing last user message`,
                  )
                } else if (
                  parsedMessage.success &&
                  Array.isArray(parsedMessage.data.fileIds) &&
                  parsedMessage.data.fileIds.length // If the message contains fileIds then the follow up is must for @file
                ) {
                  loggerWithChild({ email: email }).info(
                    `Reusing file-based classification from previous message Classification: ${JSON.stringify(parsedMessage.data.queryRouterClassification)}, FileIds: ${JSON.stringify(parsedMessage.data.fileIds)}`,
                  )
                  iterator = UnderstandMessageAndAnswerForGivenContext(
                    email,
                    ctx,
                    message,
                    0.5,
                    parsedMessage.data.fileIds as string[],
                    userRequestsReasoning,
                    understandSpan,
                  )
                } else if (
                  parsedMessage.data.queryRouterClassification &&
                  Object.keys(parsedMessage.data.queryRouterClassification)
                    .length > 2
                ) {
                  loggerWithChild({ email: email }).info(
                    `Reusing previous message classification for follow-up query ${JSON.stringify(
                      lastUserMessage.queryRouterClassification,
                    )}`,
                  )

                  classification = parsedMessage.data
                    .queryRouterClassification as QueryRouterLLMResponse
                } else {
                  loggerWithChild({ email: email }).info(
                    "Follow-up query detected, but no classification found in previous message.",
                  )
                }
              }

              answer = ""
              thinking = ""
              reasoning = isReasoning && userRequestsReasoning
              citations = []
              let imageCitations: any[] = []
              citationMap = {}
              let citationValues: Record<number, string> = {}
              if (iterator === undefined) {
                iterator = UnderstandMessageAndAnswer(
                  email,
                  ctx,
                  message,
                  classification,
                  llmFormattedMessages,
                  0.5,
                  userRequestsReasoning,
                  understandSpan,
                  agentPromptValue,
                )
              }
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
                  console.log("Found image citation, sending it")
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
                processMessage(answer, citationMap, email),
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

              if (isFollowUp && previousClassification) {
                queryRouterClassification = {
                  ...previousClassification,
                  isFollowUp,
                }
              } else if (Object.keys(classification).length > 2) {
                queryRouterClassification = classification
              }

              if (queryRouterClassification) {
                loggerWithChild({ email: email }).info(
                  `Updating queryRouter classification for last user message: ${JSON.stringify(
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
                message: processMessage(answer, citationMap, email),
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
    const { messageId, isReasoningEnabled }: MessageRetryReqType = body
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
    let attachmentFileIds: string[] = []

    if (isUserMessage) {
      // If retrying a user message, get attachments from that message
      attachmentMetadata = await getAttachmentsByMessageId(db, messageId, email)
      attachmentFileIds = attachmentMetadata.map(
        (m: AttachmentMetadata) => m.fileId,
      )
    }

    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)
    rootSpan.setAttribute("messageId", messageId)

    const costArr: number[] = []
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
        attachmentFileIds = attachmentMetadata.map(
          (m: AttachmentMetadata) => m.fileId,
        )
      }
    }

    // Use the same modelId
    const modelId = originalMessage.modelId as Models

    // Get user and workspace
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const { user, workspace } = userAndWorkspace
    const ctx = userContext(userAndWorkspace)

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
        ? await extractFileIdsFromMessage(prevUserMessage.message)
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
        activeStreams.set(streamKey!, stream)
        const streamSpan = rootSpan.startSpan("stream_response")
        streamSpan.setAttribute("chatId", originalMessage.chatExternalId)
        let wasStreamClosedPrematurely = false

        try {
          let message = prevUserMessage.message
          if (
            (fileIds && fileIds?.length > 0) ||
            (attachmentFileIds && attachmentFileIds?.length > 0)
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
              message,
              0.5,
              fileIds,
              userRequestsReasoning,
              understandSpan,
              threadIds,
              attachmentFileIds,
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
                    modelId:
                      ragPipelineConfig[RagPipelineStages.AnswerOrRewrite]
                        .modelId,
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
            const searchSpan = streamSpan.startSpan("conversation_search")
            const searchOrAnswerIterator =
              generateSearchQueryOrAnswerFromConversation(message, ctx, {
                modelId:
                  ragPipelineConfig[RagPipelineStages.AnswerOrSearch].modelId,
                stream: true,
                json: true,
                reasoning:
                  userRequestsReasoning &&
                  ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning,
                messages: formatMessagesForLLM(topicConversationThread),
              })
            let currentAnswer = ""
            let answer = ""
            let citations: Citation[] = [] // Changed to Citation[] for consistency
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
              const { app, count, endTime, entity, sortDirection, startTime } =
                parsed?.filters
              classification = {
                direction: parsed.temporalDirection,
                type: parsed.type,
                filterQuery: parsed.filterQuery,
                isFollowUp: parsed.isFollowUp,
                filters: {
                  app: app as Apps,
                  entity: entity as Entity,
                  endTime,
                  sortDirection,
                  startTime,
                  count,
                },
              } as QueryRouterLLMResponse

              loggerWithChild({ email: email }).info(
                `Classifying the query as:, ${JSON.stringify(classification)}`,
              )

              if (conversation.length < 2) {
                classification.isFollowUp = false // First message or not enough history to be a follow-up
              } else if (classification.isFollowUp) {
                // If it's marked as a follow-up, try to reuse the last user message's classification
                const lastUserMessage = conversation[conversation.length - 3] // Assistant is at -2, last user is at -3

                if (lastUserMessage?.queryRouterClassification) {
                  loggerWithChild({ email: email }).info(
                    `Reusing previous message classification for follow-up query ${JSON.stringify(
                      lastUserMessage.queryRouterClassification,
                    )}`,
                  )

                  classification =
                    lastUserMessage.queryRouterClassification as any
                } else {
                  loggerWithChild({ email: email }).info(
                    "Follow-up query detected, but no classification found in previous message.",
                  )
                }
              }

              const understandSpan = ragSpan.startSpan("understand_message")
              const iterator = UnderstandMessageAndAnswer(
                email,
                ctx,
                message,
                classification,
                convWithNoErrMsg,
                0.5,
                userRequestsReasoning,
                understandSpan,
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
  const { sub } = c.get(JwtPayloadKey) ?? {}
  let email = sub || ""
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
    const stream = activeStreams.get(streamKey)

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

    await updateMessageByExternalId(db, messageId, {
      feedback: feedback, // feedback can be 'like', 'dislike', or null
      updatedAt: new Date(), // Update the updatedAt timestamp
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
