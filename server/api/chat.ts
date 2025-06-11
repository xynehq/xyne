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
import { getToolsByConnectorId, syncConnectorTools } from "@/db/tool"
import {
  selectPublicChatSchema,
  selectPublicMessagesSchema,
  messageFeedbackEnum,
  type SelectChat,
  type SelectMessage,
  selectMessageSchema,
  selectToolSchema,
  type SelectTool,
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
} from "@/search/vespa"
import {
  Apps,
  CalendarEntity,
  chatMessageSchema,
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

// Map to store active streams: Key = "chatId", Value = SSEStreamingApi instance
const activeStreams = new Map<string, SSEStreamingApi>()

// this is not always the case but unless our router detects that we need
// these we will by default remove them
const nonWorkMailLabels = ["CATEGORY_UPDATES", "CATEGORY_PROMOTIONS"]

enum RagPipelineStages {
  QueryRouter = "QueryRouter",
  NewChatTitle = "NewChatTitle",
  AnswerOrSearch = "AnswerOrSearch",
  AnswerWithList = "AnswerWithList",
  AnswerOrRewrite = "AnswerOrRewrite",
  RewriteAndAnswer = "RewriteAndAnswer",
  UserChat = "UserChat",
  DefaultRetrieval = "DefaultRetrieval",
}

const ragPipelineConfig = {
  [RagPipelineStages.QueryRouter]: {
    modelId: defaultFastModel,
    reasoning: fastModelReasoning,
  },
  [RagPipelineStages.AnswerOrSearch]: {
    modelId: defaultBestModel, //defaultBestModel,
    reasoning: fastModelReasoning,
  },
  [RagPipelineStages.AnswerWithList]: {
    modelId: defaultBestModel,
  },
  [RagPipelineStages.NewChatTitle]: {
    modelId: defaultFastModel,
  },
  [RagPipelineStages.AnswerOrRewrite]: {
    modelId: defaultBestModel,
  },
  [RagPipelineStages.RewriteAndAnswer]: {
    modelId: defaultBestModel,
  },
  [RagPipelineStages.UserChat]: {
    modelId: defaultBestModel,
  },
  [RagPipelineStages.DefaultRetrieval]: {
    modelId: defaultBestModel,
    page: 5,
  },
}

export const GetChatApi = async (c: Context) => {
  try {
    // @ts-ignore
    const body: z.infer<typeof chatSchema> = c.req.valid("json")
    const { chatId } = body
    const [chat, messages] = await Promise.all([
      getChatByExternalId(db, chatId),
      getChatMessages(db, chatId),
    ])
    return c.json({
      chat: selectPublicChatSchema.parse(chat),
      messages: selectPublicMessagesSchema.parse(messages),
    })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(
      error,
      `Get Chat and Messages Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not fetch chat and messages",
    })
  }
}

export const ChatRenameApi = async (c: Context) => {
  try {
    // @ts-ignore
    const { title, chatId } = c.req.valid("json")
    await updateChatByExternalId(db, chatId, { title })
    return c.json({ success: true })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(
      error,
      `Chat Rename Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not rename chat",
    })
  }
}

export const ChatDeleteApi = async (c: Context) => {
  try {
    // @ts-ignore
    const { chatId } = c.req.valid("json")
    await db.transaction(async (tx) => {
      // First delete chat traces to avoid cascade violations
      await deleteChatTracesByChatExternalId(tx, chatId)
      // Second we have to delete all messages associated with that chat
      await deleteMessagesByChatId(tx, chatId)
      await deleteChatByExternalId(tx, chatId)
    })
    return c.json({ success: true })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(
      error,
      `Chat Delete Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not delete chat",
    })
  }
}

export const ChatHistory = async (c: Context) => {
  try {
    const { sub } = c.get(JwtPayloadKey)
    const email = sub
    // @ts-ignore
    const { page } = c.req.valid("query")
    const offset = page * chatHistoryPageSize
    return c.json(await getPublicChats(db, email, chatHistoryPageSize, offset))
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(
      error,
      `Chat History Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not get chat history",
    })
  }
}

export const ChatBookmarkApi = async (c: Context) => {
  try {
    // @ts-ignore
    const body = c.req.valid("json")
    const { chatId, bookmark } = body
    await updateChatByExternalId(db, chatId, { isBookmarked: bookmark })
    return c.json({})
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(
      error,
      `Chat Bookmark Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not bookmark chat",
    })
  }
}

const MinimalCitationSchema = z.object({
  docId: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  app: z.nativeEnum(Apps),
  entity: entitySchema,
})

export type Citation = z.infer<typeof MinimalCitationSchema>

interface CitationResponse {
  answer?: string
  citations?: number[]
}

export const GetChatTraceApi = async (c: Context) => {
  try {
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
    Logger.error(
      error,
      `Get Chat Trace Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not fetch chat trace",
    })
  }
}

const searchToCitation = (result: VespaSearchResults): Citation => {
  const fields = result.fields
  if (result.fields.sddocname === userSchema) {
    return {
      docId: (fields as VespaUser).docId,
      title: (fields as VespaUser).name,
      url: `https://contacts.google.com/${(fields as VespaUser).email}`,
      app: (fields as VespaUser).app,
      entity: (fields as VespaUser).entity,
    }
  } else if (result.fields.sddocname === fileSchema) {
    return {
      docId: (fields as VespaFile).docId,
      title: (fields as VespaFile).title,
      url: (fields as VespaFile).url || "",
      app: (fields as VespaFile).app,
      entity: (fields as VespaFile).entity,
    }
  } else if (result.fields.sddocname === mailSchema) {
    return {
      docId: (fields as VespaMail).docId,
      title: (fields as VespaMail).subject,
      url: `https://mail.google.com/mail/u/0/#inbox/${fields.docId}`,
      app: (fields as VespaMail).app,
      entity: (fields as VespaMail).entity,
    }
  } else if (result.fields.sddocname === eventSchema) {
    return {
      docId: (fields as VespaEvent).docId,
      title: (fields as VespaEvent).name || "No Title",
      url: (fields as VespaEvent).url,
      app: (fields as VespaEvent).app,
      entity: (fields as VespaEvent).entity,
    }
  } else if (result.fields.sddocname === mailAttachmentSchema) {
    return {
      docId: (fields as VespaMailAttachment).docId,
      title: (fields as VespaMailAttachment).filename || "No Filename",
      url: `https://mail.google.com/mail/u/0/#inbox/${
        (fields as VespaMailAttachment).mailId
      }?projector=1&messagePartId=0.${
        (fields as VespaMailAttachment).partId
      }&disp=safe&zw`,
      app: (fields as VespaMailAttachment).app,
      entity: (fields as VespaMailAttachment).entity,
    }
  } else if (result.fields.sddocname === chatMessageSchema) {
    return {
      docId: (fields as VespaChatMessage).docId,
      title: (fields as VespaChatMessage).text,
      url: `https://${(fields as VespaChatMessage).domain}.slack.com/archives/${
        (fields as VespaChatMessage).channelId
      }/p${(fields as VespaChatMessage).updatedAt}`,
      app: (fields as VespaChatMessage).app,
      entity: (fields as VespaChatMessage).entity,
    }
  } else {
    throw new Error("Invalid search result type for citation")
  }
}

const searchToCitations = (
  results: z.infer<typeof VespaSearchResultsSchema>[],
): Citation[] => {
  if (results.length === 0) {
    return []
  }
  return results.map((result) => searchToCitation(result as VespaSearchResults))
}

export const textToCitationIndex = /\[(\d+)\]/g

export const processMessage = (
  text: string,
  citationMap: Record<number, number>,
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
const checkAndYieldCitations = function* (
  textInput: string,
  yieldedCitations: Set<number>,
  results: any[],
  baseIndex: number = 0,
) {
  const text = splitGroupedCitationsWithSpaces(textInput)
  let match
  while ((match = textToCitationIndex.exec(text)) !== null) {
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
        Logger.error(
          "Found a citation index but could not find it in the search result ",
          citationIndex,
          results.length,
        )
      }
    }
  }
}

async function* processIterator(
  iterator: AsyncIterableIterator<ConverseResponse>,
  results: VespaSearchResult[],
  previousResultsLength: number = 0,
  userRequestsReasoning?: boolean,
): AsyncIterableIterator<
  ConverseResponse & { citation?: { index: number; item: any } }
> {
  let buffer = ""
  let currentAnswer = ""
  let parsed = { answer: "" }
  let thinking = ""
  let reasoning = config.isReasoning && userRequestsReasoning
  let yieldedCitations = new Set<number>()
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
            yield* checkAndYieldCitations(
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
      }
    }

    if (chunk.cost) {
      yield { cost: chunk.cost }
    }
  }
  return parsed.answer
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
): AsyncIterableIterator<
  ConverseResponse & { citation?: { index: number; item: any } }
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

  let message = input

  let userAlpha = alpha
  try {
    const personalization = await getUserPersonalizationByEmail(db, email)
    if (personalization) {
      const nativeRankParams =
        personalization.parameters?.[SearchModes.NativeRank]
      if (nativeRankParams?.alpha !== undefined) {
        userAlpha = nativeRankParams.alpha
        Logger.info(
          { email, alpha: userAlpha },
          "Using personalized alpha for iterative RAG",
        )
      } else {
        Logger.info(
          { email },
          "No personalized alpha found in settings, using default for iterative RAG",
        )
      }
    } else {
      Logger.warn(
        { email },
        "User personalization settings not found, using default alpha for iterative RAG",
      )
    }
  } catch (err) {
    Logger.error(
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
  const latestResults = (
    await searchVespa(message, email, null, null, {
      limit: userSpecifiedCount,
      alpha: userAlpha,
      timestampRange,
      span: initialSearchSpan,
    })
  ).root.children
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
      let results = await searchVespa(message, email, null, null, {
        limit: pageSize,
        alpha: userAlpha,
        span: vespaSearchSpan,
      })
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
        const latestResults: VespaSearchResult[] = (
          await searchVespa(query, email, null, null, {
            limit: pageSize,
            alpha: userAlpha,
            timestampRange: {
              from: new Date().getTime() - 4 * monthInMs,
              to: new Date().getTime(),
            },
            span: latestSearchSpan,
          })
        )?.root?.children
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

        let results = await searchVespa(query, email, null, null, {
          limit: pageSize,
          alpha: userAlpha,
          excludedIds: latestResults
            ?.map((v: VespaSearchResult) => (v.fields as any).docId)
            ?.filter((v) => !!v),
        })
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

        contextSpan?.setAttribute("context_length", initialContext?.length || 0)
        contextSpan?.setAttribute("context", initialContext || "")
        contextSpan?.setAttribute("number_of_chunks", totalResults.length)
        Logger.info(
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
          },
        )

        const answer = yield* processIterator(
          iterator,
          totalResults,
          previousResultsLength,
          config.isReasoning && userRequestsReasoning,
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
      results = await searchVespa(message, email, null, null, {
        limit: userSpecifiedCount,
        offset: pageNumber * userSpecifiedCount,
        alpha: userAlpha,
        excludedIds: latestIds,
        span: searchSpan,
      })
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
      results = await searchVespa(message, email, null, null, {
        limit: userSpecifiedCount,
        offset: pageNumber * userSpecifiedCount,
        alpha: userAlpha,
        span: searchSpan,
      })
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

    contextSpan?.setAttribute("context_length", initialContext?.length || 0)
    contextSpan?.setAttribute("context", initialContext || "")
    contextSpan?.setAttribute(
      "number_of_chunks",
      results?.root?.children?.length || 0,
    )
    Logger.info(
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
    })

    const answer = yield* processIterator(
      iterator,
      results?.root?.children,
      previousResultsLength,
      config.isReasoning && userRequestsReasoning,
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
  passedSpan?: Span,
): AsyncIterableIterator<
  ConverseResponse & { citation?: { index: number; item: any } }
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
        Logger.info(
          { email, alpha: userAlpha },
          "Using personalized alpha for iterative RAG",
        )
      } else {
        Logger.info(
          { email },
          "No personalized alpha found in settings, using default for iterative RAG",
        )
      }
    } else {
      Logger.warn(
        { email },
        "User personalization settings not found, using default alpha for iterative RAG",
      )
    }
  } catch (err) {
    Logger.error(
      err,
      "Failed to fetch personalization for iterative RAG, using default alpha",
      { email },
    )
  }

  const generateAnswerSpan = passedSpan?.startSpan(
    "generateAnswerFromGivenContext",
  )

  let previousResultsLength = 0
  const results = await GetDocumentsByDocIds(fileIds, generateAnswerSpan!)
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
            0,
            true,
          )}`,
      )
      ?.join("\n"),
  )

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

  Logger.info(
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
    },
    true,
  )

  const answer = yield* processIterator(
    iterator,
    results?.root?.children,
    previousResultsLength,
    userRequestsReasoning,
  )
  if (answer) {
    generateAnswerSpan?.setAttribute("answer_found", true)
    generateAnswerSpan?.end()
    return
  } else if (!answer) {
    // If we give the whole context then also if there's no answer then we can just search once and get the best matching chunks with the query and then make context try answering
    Logger.info(
      "No answer was found when all chunks were given, trying to answer after searching vespa now",
    )
    let results = await searchVespaInFiles(builtUserQuery, email, fileIds, {
      limit: fileIds?.length,
      alpha: userAlpha,
    })

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
    Logger.info(
      `[Selected Context Path] Number of contextual chunks being passed: ${
        results?.root?.children?.length || 0
      }`,
    )

    searchVespaSpan?.setAttribute("context_length", initialContext?.length || 0)
    searchVespaSpan?.setAttribute("context", initialContext || "")
    searchVespaSpan?.setAttribute(
      "number_of_chunks",
      results.root?.children?.length || 0,
    )

    const iterator = baselineRAGJsonStream(
      builtUserQuery,
      userCtx,
      initialContext,
      {
        stream: true,
        modelId: defaultBestModel,
        reasoning: config.isReasoning && userRequestsReasoning,
      },
      true,
    )

    const answer = yield* processIterator(
      iterator,
      results?.root?.children,
      previousResultsLength,
      userRequestsReasoning,
    )
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

const extractFileIdsFromMessage = async (
  message: string,
): Promise<{
  totalValidFileIdsFromLinkCount: number
  fileIds: string[]
}> => {
  const fileIds: string[] = []
  const jsonMessage = JSON.parse(message) as UserQuery
  let validFileIdsFromLinkCount = 0
  let totalValidFileIdsFromLinkCount = 0
  for (const obj of jsonMessage) {
    if (obj?.type === "pill") {
      fileIds.push(obj?.value?.docId)
    } else if (obj?.type === "link") {
      const fileId = getFileIdFromLink(obj?.value)
      if (fileId) {
        // Check if it's a valid Drive File Id ingested in Vespa
        // Only works for fileSchema
        const validFile = await getDocumentOrSpreadsheet(fileId)
        if (validFile) {
          totalValidFileIdsFromLinkCount++
          if (validFileIdsFromLinkCount >= maxValidLinks) {
            continue
          }
          const fields = validFile?.fields as VespaFile
          // If any of them happens to a spreadsheet, add all its subsheet ids also here
          if (
            fields?.app === Apps.GoogleDrive &&
            fields?.entity === DriveEntity.Sheets
          ) {
            const sheetsMetadata = JSON.parse(fields?.metadata as string)
            const totalSheets = sheetsMetadata?.totalSheets
            for (let i = 0; i < totalSheets; i++) {
              fileIds.push(`${fileId}_${i}`)
            }
          } else {
            fileIds.push(fileId)
          }
          validFileIdsFromLinkCount++
        }
      }
    }
  }
  return { totalValidFileIdsFromLinkCount, fileIds }
}

const getFileIdFromLink = (link: string) => {
  const regex = /(?:\/d\/|[?&]id=)([a-zA-Z0-9_-]+)/
  const match = link.match(regex)
  const fileId = match ? match[1] : null
  return fileId
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
): AsyncIterableIterator<
  ConverseResponse & { citation?: { index: number; item: any } }
> {
  const rootSpan = eventRagSpan?.startSpan("generatePointQueryTimeExpansion")
  Logger.debug(`Started rootSpan at ${new Date().toISOString()}`)
  rootSpan?.setAttribute("input", input)
  rootSpan?.setAttribute("email", email)
  rootSpan?.setAttribute("alpha", alpha)
  rootSpan?.setAttribute("pageSize", pageSize)
  rootSpan?.setAttribute("maxSummaryCount", maxSummaryCount || "none")
  rootSpan?.setAttribute("direction", classification.direction || "unknown")

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
        Logger.info(
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
        Logger.info(
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

    Logger.info(
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
    const [eventResults, results] = await Promise.all([
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
      Logger.info("No gmail or calendar events found")
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

    contextSpan?.setAttribute("context_length", initialContext?.length || 0)
    contextSpan?.setAttribute("context", initialContext || "")
    contextSpan?.setAttribute(
      "number_of_chunks",
      combinedResults?.root?.children?.length || 0,
    )
    contextSpan?.end()

    // Stream LLM response
    const ragSpan = iterationSpan?.startSpan("meeting_prompt_stream")
    Logger.info("Using meetingPromptJsonStream")
    const iterator = meetingPromptJsonStream(input, userCtx, initialContext, {
      stream: true,
      modelId: defaultBestModel,
      reasoning: config.isReasoning && userRequestsReasoning,
    })

    const answer = yield* processIterator(
      iterator,
      combinedResults?.root?.children,
      previousResultsLength,
      config.isReasoning && userRequestsReasoning,
    )
    ragSpan?.end()
    if (answer) {
      ragSpan?.setAttribute("answer_found", true)
      iterationSpan?.end()
      Logger.debug(`Ending rootSpan at ${new Date().toISOString()}`)
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
) {
  if (app === Apps.GoogleDrive) {
    chunksCount = config.maxGoogleDriveSummary
    Logger.info(`Google Drive, Chunk size: ${chunksCount}`)
    span?.setAttribute("Google Drive, chunk_size", chunksCount)
  }

  // TODO: Calculate the token count for the selected model's capacity and pass the full context accordingly.
  chunksCount = 20
  span?.setAttribute(
    "Document chunk size",
    `full_context maxed to ${chunksCount}`,
  )
  const context = buildContext(items, chunksCount)
  const streamOptions = {
    stream: true,
    modelId: defaultBestModel,
    reasoning: config.isReasoning && userRequestsReasoning,
  }

  let iterator: AsyncIterableIterator<ConverseResponse>
  if (app === Apps.Gmail) {
    Logger.info(`Using mailPromptJsonStream `)
    iterator = mailPromptJsonStream(input, userCtx, context, streamOptions)
  } else {
    Logger.info(`Using baselineRAGJsonStream`)
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
  maxIterations = 5,
): AsyncIterableIterator<
  ConverseResponse & { citation?: { index: number; item: any } }
> {
  const { app, entity, startTime, endTime, sortDirection } =
    classification.filters
  const count = classification.filters.count
  const direction = classification.direction as string
  const isGenericItemFetch = classification.type === QueryType.GetItems
  const isFilteredItemSearch =
    classification.type === QueryType.SearchWithFilters
  const isValidAppAndEntity =
    isValidApp(app as Apps) && isValidEntity(entity as Entity)

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

  Logger.info(
    `App : "${app}" , Entity : "${entity}"` +
      (timeDescription ? `, ${directionText} ${timeDescription}` : ""),
  )

  const schema = entityToSchemaMapper(entity, app) as VespaSchema
  let items: VespaSearchResult[] = []

  // Determine search strategy based on conditions
  if (
    !isValidAppAndEntity &&
    classification.filterQuery &&
    classification.filters?.sortDirection === "desc"
  ) {
    span?.setAttribute(
      "isReasoning",
      userRequestsReasoning && config.isReasoning ? true : false,
    )
    span?.setAttribute("modelId", defaultBestModel)
    Logger.info(
      "User requested recent metadata retrieval without specifying app or entity",
    )

    const searchOps = {
      limit: pageSize,
      alpha: userAlpha,
      rankProfile: SearchModes.GlobalSorted,
      timestampRange:
        timestampRange.to || timestampRange.from ? timestampRange : null,
    }

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const pageSpan = span?.startSpan(`search_iteration_${iteration}`)
      Logger.info(
        `Search Iteration - ${iteration} : ${SearchModes.GlobalSorted}`,
      )
      items =
        (
          await searchVespa(
            classification.filterQuery,
            email,
            app as Apps,
            entity as Entity,
            {
              ...searchOps,
              offset: pageSize * iteration,
              span: pageSpan,
            },
          )
        ).root.children || []

      Logger.info(
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
        Logger.info(
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
      )

      if (answer == null) {
        pageSpan?.setAttribute("answer", null)
        if (iteration == maxIterations - 1) {
          pageSpan?.end()
          yield { text: "null" }
          return
        } else {
          Logger.info(`no answer found for iteration - ${iteration}`)
          continue
        }
      } else {
        pageSpan?.setAttribute("answer", answer)
        pageSpan?.end()
        return answer
      }
    }

    span?.setAttribute("rank_profile", SearchModes.GlobalSorted)
    Logger.info(`Rank Profile : ${SearchModes.GlobalSorted}`)
  } else if (isGenericItemFetch && isValidAppAndEntity) {
    const userSpecifiedCountLimit = count
      ? Math.min(count, config.maxUserRequestCount)
      : 5
    span?.setAttribute("Search_Type", QueryType.GetItems)
    span?.setAttribute(
      "isReasoning",
      userRequestsReasoning && config.isReasoning ? true : false,
    )
    span?.setAttribute("modelId", defaultBestModel)
    Logger.info(`Search Type : ${QueryType.GetItems}`)

    items =
      (
        await getItems({
          email,
          schema,
          app,
          entity,
          timestampRange,
          limit: userSpecifiedCountLimit,
          asc: sortDirection === "asc",
        })
      ).root.children || []

    span?.setAttribute(`retrieved documents length`, items.length)
    span?.setAttribute(
      `retrieved documents id's`,
      JSON.stringify(
        items.map((v: VespaSearchResult) => (v.fields as any).docId),
      ),
    )

    span?.setAttribute("context", buildContext(items, 20))
    span?.end()
    Logger.info(`Retrieved Documents : ${QueryType.GetItems} - ${items.length}`)
    // Early return if no documents found
    if (!items.length) {
      span?.end()
      Logger.info("No documents found for unspecific metadata retrieval")
      yield { text: "no documents found" }
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
    )
    return
  } else if (
    isFilteredItemSearch &&
    isValidAppAndEntity &&
    classification.filterQuery
  ) {
    // Specific metadata retrieval
    span?.setAttribute("Search_Type", QueryType.SearchWithFilters)
    span?.setAttribute(
      "isReasoning",
      userRequestsReasoning && config.isReasoning ? true : false,
    )
    span?.setAttribute("modelId", defaultBestModel)
    Logger.info(`Search Type : ${QueryType.SearchWithFilters}`)

    const { filterQuery } = classification
    const query = filterQuery
    const rankProfile =
      sortDirection === "desc"
        ? SearchModes.GlobalSorted
        : SearchModes.NativeRank

    const searchOptions = {
      limit: pageSize,
      alpha: userAlpha,
      rankProfile,
      timestampRange:
        timestampRange.to || timestampRange.from ? timestampRange : null,
    }

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const iterationSpan = span?.startSpan(`search_iteration_${iteration}`)
      Logger.info(
        `Search ${QueryType.SearchWithFilters} Iteration - ${iteration} : ${rankProfile}`,
      )

      items =
        (
          await searchVespa(query, email, app as Apps, entity as any, {
            ...searchOptions,
            offset: pageSize * iteration,
          })
        ).root.children || []

      Logger.info(`Rank Profile : ${rankProfile}`)

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

      Logger.info(
        `Number of documents for ${QueryType.SearchWithFilters} = ${items.length}`,
      )
      if (!items.length) {
        Logger.info(
          `No documents found on iteration ${iteration}${
            hasValidTimeRange
              ? " within time range."
              : " falling back to iterative RAG"
          }`,
        )
        iterationSpan?.end()
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
      )

      if (answer == null) {
        iterationSpan?.setAttribute("answer", null)
        if (iteration == maxIterations - 1) {
          iterationSpan?.end()
          yield { text: "null" }
          return
        } else {
          Logger.info(`no answer found for iteration - ${iteration}`)
          continue
        }
      } else {
        iterationSpan?.end()
        return answer
      }
    }
  } else {
    // None of the conditions matched
    yield { text: "null" }
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
): AsyncIterableIterator<
  ConverseResponse & { citation?: { index: number; item: any } }
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
    Logger.info("Metadata Retrieval")

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
    )

    let hasYieldedAnswer = false
    for await (const answer of answerIterator) {
      if (answer.text === "no documents found") {
        return yield {
          text: `I couldn't find any ${fallbackText(
            classification,
          )}. Would you like to try a different search?`,
        }
      } else if (answer.text === "null") {
        Logger.info(
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
    Logger.info(`Direction : ${classification.direction}`)
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
    )
  } else {
    Logger.info("Iterative Rag : Query rewriting and time filtering")
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
): AsyncIterableIterator<
  ConverseResponse & { citation?: { index: number; item: any } }
> {
  passedSpan?.setAttribute("email", email)
  passedSpan?.setAttribute("message", message)
  passedSpan?.setAttribute("alpha", alpha)
  passedSpan?.setAttribute("fileIds", JSON.stringify(fileIds))
  passedSpan?.setAttribute("fileIds_count", fileIds?.length)
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
    passedSpan,
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

const isMessageWithContext = (message: string) => {
  return message?.startsWith("[{") && message?.endsWith("}]")
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
  Logger.info("MessageApi..")

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
    let { message, chatId, modelId, isReasoningEnabled }: MessageReqType = body
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
    if (!chatId) {
      Logger.info(`MessageApi before the span.. ${chatId}`)
      const titleSpan = chatCreationSpan.startSpan("generate_title")
      Logger.info(`MessageApi after the span.. ${titleSpan}`)
      // let llm decide a title
      const titleResp = await generateTitleUsingQuery(message, {
        modelId: ragPipelineConfig[RagPipelineStages.NewChatTitle].modelId,
        stream: false,
      })
      Logger.info(`MessageApi after the titleResp.. ${titleResp}`)
      title = titleResp.title
      const cost = titleResp.cost
      if (cost) {
        costArr.push(cost)
        titleSpan.setAttribute("cost", cost)
      }
      titleSpan.setAttribute("title", title)
      titleSpan.end()

      Logger.info(`MessageApi before the first message.. ${titleSpan}`)
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
    Logger.info("starting the streaming..")
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
            const answerSpan = streamSpan.startSpan("process_final_answer")
            answerSpan.setAttribute(
              "final_answer",
              processMessage(answer, citationMap),
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

            Logger.info(
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
                reasoning:
                  userRequestsReasoning &&
                  ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning,
                messages: llmFormattedMessages,
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
            const conversationSpan = streamSpan.startSpan("conversation_search")
            for await (const chunk of searchOrAnswerIterator) {
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

            console.log(buffer, "buffer")
            conversationSpan.setAttribute("answer_found", parsed.answer)
            conversationSpan.setAttribute("answer", answer)
            conversationSpan.setAttribute("query_rewrite", parsed.queryRewrite)
            conversationSpan.end()
            let classification
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

              Logger.info(
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
                  Logger.error(`Error while parsing last user message`)
                } else if (
                  parsedMessage.success &&
                  Array.isArray(parsedMessage.data.fileIds) &&
                  parsedMessage.data.fileIds.length // If the message contains fileIds then the follow up is must for @file
                ) {
                  Logger.info(
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
                    .length
                ) {
                  Logger.info(
                    `Reusing previous message classification for follow-up query ${JSON.stringify(
                      lastUserMessage.queryRouterClassification,
                    )}`,
                  )

                  classification = parsedMessage.data
                    .queryRouterClassification as QueryRouterLLMResponse
                } else {
                  Logger.info(
                    "Follow-up query detected, but no classification found in previous message.",
                  )
                }
              }

              answer = ""
              thinking = ""
              reasoning = isReasoning && userRequestsReasoning
              citations = []
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
                )
              }
              stream.writeSSE({
                event: ChatSSEvents.Start,
                data: "",
              })
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
              } else if (classification) {
                queryRouterClassification = classification
              }

              if (queryRouterClassification) {
                Logger.info(
                  `Updating queryRouter classification for last user message: ${JSON.stringify(
                    queryRouterClassification,
                  )}`,
                )

                await updateMessage(db, latestUserMessage.externalId, {
                  queryRouterClassification,
                })
              } else {
                Logger.warn(
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
  try {
    // @ts-ignore
    const body = c.req.valid("query")
    const { messageId, isReasoningEnabled }: MessageRetryReqType = body
    const userRequestsReasoning = isReasoningEnabled
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)
    rootSpan.setAttribute("messageId", messageId)

    const costArr: number[] = []
    // Fetch the original message
    const fetchMessageSpan = rootSpan.startSpan("fetch_original_message")
    const originalMessage = await getMessageByExternalId(db, messageId)
    if (!originalMessage) {
      const errorSpan = fetchMessageSpan.startSpan("message_not_found")
      errorSpan.addEvent("error", { message: "Message not found" })
      errorSpan.end()
      fetchMessageSpan.end()
      throw new HTTPException(404, { message: "Message not found" })
    }
    const isUserMessage = originalMessage.messageRole === "user"
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
          }
      totalValidFileIdsFromLinkCount =
        extractedInfo?.totalValidFileIdsFromLinkCount
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
    Logger.info(`[MessageRetryApi] Constructed streamKey: ${streamKey}`)

    return streamSSE(
      c,
      async (stream) => {
        activeStreams.set(streamKey!, stream)
        const streamSpan = rootSpan.startSpan("stream_response")
        streamSpan.setAttribute("chatId", originalMessage.chatExternalId)
        let wasStreamClosedPrematurely = false

        try {
          let message = prevUserMessage.message
          if (fileIds && fileIds?.length > 0) {
            Logger.info(
              "[RETRY] User has selected some context with query, answering only based on that given context",
            )

            let answer = ""
            let citations = []
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
            let count = 0
            let citationValues: Record<number, string> = {}
            for await (const chunk of iterator) {
              if (stream.closed) {
                Logger.info(
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
            const answerSpan = streamSpan.startSpan("process_final_answer")
            answerSpan.setAttribute(
              "final_answer",
              processMessage(answer, citationMap),
            )
            answerSpan.setAttribute("actual_answer", answer)
            answerSpan.setAttribute("final_answer_length", answer.length)
            answerSpan.end()

            // Database Update Logic
            const insertSpan = streamSpan.startSpan("insert_assistant_message")
            if (wasStreamClosedPrematurely) {
              Logger.info(
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
                    message: processMessage(answer, citationMap),
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
                  message: processMessage(answer, citationMap),
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
                      message: processMessage(answer, citationMap),
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
                  Logger.info(
                    `Updated trace for message ${originalMessage.externalId}`,
                  )
                  insertSpan.setAttribute(
                    "message_id",
                    originalMessage.externalId,
                  )
                  relevantMessageId = originalMessage.externalId
                  await updateMessage(db, messageId, {
                    message: processMessage(answer, citationMap),
                    updatedAt: new Date(),
                    sources: citations,
                    thinking,
                    errorMessage: null,
                  })
                }
              } else {
                Logger.error(
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
            Logger.info(
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
                Logger.info(
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
                        Logger.info(
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
                    Logger.error(
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
                Logger.info(
                  "retry: The query is ambiguous and requires a mandatory query rewrite from the existing conversation / recent messages",
                )
                message = parsed.queryRewrite
                ragSpan.setAttribute("query_rewrite", parsed.queryRewrite)
              } else {
                Logger.info(
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

              Logger.info(
                `Classifying the query as:, ${JSON.stringify(classification)}`,
              )

              if (conversation.length < 2) {
                classification.isFollowUp = false // First message or not enough history to be a follow-up
              } else if (classification.isFollowUp) {
                // If it's marked as a follow-up, try to reuse the last user message's classification
                const lastUserMessage = conversation[conversation.length - 3] // Assistant is at -2, last user is at -3

                if (lastUserMessage?.queryRouterClassification) {
                  Logger.info(
                    `Reusing previous message classification for follow-up query ${JSON.stringify(
                      lastUserMessage.queryRouterClassification,
                    )}`,
                  )

                  classification =
                    lastUserMessage.queryRouterClassification as any
                } else {
                  Logger.info(
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
                  Logger.info(
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
                  Logger.info(
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
                processMessage(answer, citationMap),
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
              Logger.info(
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
                    message: processMessage(answer, citationMap),
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
                  message: processMessage(answer, citationMap),
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
                      message: processMessage(answer, citationMap),
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
                  Logger.info(
                    `Updated trace for message ${originalMessage.externalId}`,
                  )
                  insertSpan.setAttribute(
                    "message_id",
                    originalMessage.externalId,
                  )
                  relevantMessageId = originalMessage.externalId
                  await updateMessage(db, messageId, {
                    message: processMessage(answer, citationMap),
                    updatedAt: new Date(),
                    sources: citations,
                    thinking,
                    errorMessage: null,
                  })
                }
              } else {
                Logger.error(
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
          if (streamKey && activeStreams.has(streamKey)) {
            activeStreams.delete(streamKey)
            Logger.info(
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
        Logger.error(
          err,
          `Streaming Error: ${err.message} ${(err as Error).stack}`,
        )
        streamErrorSpan.end()
        rootSpan.end()
        if (streamKey && activeStreams.has(streamKey)) {
          activeStreams.delete(streamKey)
          Logger.info(
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
    Logger.error(
      error,
      `Message Retry Error: ${errMsg} ${(error as Error).stack}`,
    )
    if (streamKey && activeStreams.has(streamKey)) {
      activeStreams.delete(streamKey)
      Logger.info(
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
  try {
    // @ts-ignore - Assuming validation middleware handles this
    const { chatId } = c.req.valid("json")
    Logger.info(
      `[StopStreamingApi] Received stop request. ChatId from client: ${chatId}`,
    )

    if (!chatId) {
      Logger.warn(
        "[StopStreamingApi] Received stop request with missing chatId.",
      )
      throw new HTTPException(400, { message: "chatId is required." })
    }

    const streamKey = chatId
    const stream = activeStreams.get(streamKey)

    if (stream) {
      Logger.info(`[StopStreamingApi] Closing active stream: ${streamKey}.`)
      try {
        await stream.close()
      } catch (closeError) {
        Logger.error(
          closeError,
          `[StopStreamingApi] Error closing stream ${streamKey}: ${getErrorMessage(
            closeError,
          )}`,
        )
      } finally {
        activeStreams.delete(streamKey!)
      }
    } else {
      Logger.warn(
        `[StopStreamingApi] Stop request for non-existent or already finished stream with key: ${streamKey}. No action taken.`,
      )
    }

    return c.json({ success: true })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    if (error instanceof HTTPException) {
      Logger.error(
        `[StopStreamingApi] HTTP Exception: ${error.status} - ${error.message}`,
      )
      throw error
    }
    Logger.error(
      error,
      `[StopStreamingApi] Unexpected Error: ${errMsg} ${
        (error as Error).stack
      }`,
    )
    throw new HTTPException(500, { message: "Could not stop streaming." })
  }
}
function flattenObject(obj: any, parentKey = ""): [string, string][] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const fullKey = parentKey ? `${parentKey}.${key}` : key

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return flattenObject(value, fullKey)
    } else {
      return [[fullKey, JSON.stringify(value)]]
    }
  })
}

async function* getToolContinuationIterator(
  message: string,
  userCtx: string,
  toolsPrompt: string,
  toolOutput: string,
) {
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

  let buffer = ""
  let currentAnswer = ""
  let parsed = { answer: "" }
  let thinking = ""
  let reasoning = config.isReasoning
  let yieldedCitations = new Set<number>()
  const ANSWER_TOKEN = '"answer":'

  for await (const chunk of continuationIterator) {
    if (chunk.text) {
      buffer += chunk.text
      try {
        parsed = jsonParseLLMOutput(buffer, ANSWER_TOKEN)

        if (parsed.answer === null || parsed.answer === "}") {
          break
        }

        if (parsed.answer && currentAnswer !== parsed.answer) {
          if (currentAnswer === "") {
            yield { text: parsed.answer }
          } else {
            const newText = parsed.answer.slice(currentAnswer.length)
            yield { text: newText }
          }
          currentAnswer = parsed.answer
        }
      } catch (e) {
        // JSON parsing failed — continue accumulating
        continue
      }
    }

    if (chunk.cost) {
      yield { cost: chunk.cost }
    }
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
    interface MinimalAgentFragment {
      id: string // Unique ID for the fragment
      content: string
      source: Citation
      confidence: number
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
            message: `Analyzing your query..."`,
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
                 **CRITICAL WARNING:** You have already called some tools ${previousToolCalls.map((toolCall, idx) => `[Iteration-${idx}] Tool: ${toolCall.tool}, Args: ${JSON.stringify(toolCall.args)}`).join("\n")}  and the result was insufficient. You are in a loop. You MUST choose a appropriate tool to resolve user query.
               You **MUST** change your strategy.
                For example: 
                  1.  Choose a **DIFFERENT TOOL** (e.g., use a broader 'search' instead of 'metadata_retrieval').
                  2.  Use the **SAME TOOL** but with **DIFFERENT ARGUMENTS** (e.g., change keywords, remove filters, adjust the time range).

                Do NOT make this call again. Formulate a new, distinct plan.
                 ---
              `
            }

            agentScratchpad =
              evidenceSummary +
              loopWarningPrompt +
              structuredReasoningSteps
                .map(convertReasoningStepToText)
                .join("\n")
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
                // --- BRANCH 1: INTERNAL AGENT TOOL ---
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

              // 3. UNIFIED RESPONSE PROCESSING AND STATE UPDATE
              // This block now runs for BOTH internal and external tools.

              await logAndStreamReasoning({
                type: AgentReasoningStepType.ToolResult,
                toolName: toolName as AgentToolName,
                resultSummary: toolExecutionResponse.result,
                itemsFound: toolExecutionResponse.contexts?.length || 0,
                error: toolExecutionResponse.error,
              })

              // If the tool call resulted in an error, the agent should know its plan failed.
              // It will then re-evaluate and try a different tool in the next iteration.
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

              // If the tool succeeded, update the agent's state
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

              // If we have gathered ANY context at all, we perform synthesis evaluation.
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

          let finalSources: Citation[] = []
          let finalCitationMap: Record<number, number> = {}

          // This check is important. Only process citations if the agent actually gathered some.
          if (gatheredFragments.length > 0) {
            // 1. Create a unique list of sources to avoid duplicates in the final output.
            // We use a Map keyed by docId to ensure uniqueness.
            const uniqueSourceMap = new Map<string, Citation>()
            gatheredFragments.forEach((fragment) => {
              if (fragment.source && fragment.source.docId) {
                if (!uniqueSourceMap.has(fragment.source.docId)) {
                  uniqueSourceMap.set(fragment.source.docId, fragment.source)
                }
              }
            })
            finalSources = Array.from(uniqueSourceMap.values())

            // 2. Create the map to translate from the context index to the final source index.
            // The LLM was prompted with context `[1]`, `[2]`, etc., based on the `gatheredFragments` array order.
            // We need to map that index to the index in our `finalSources` array.
            gatheredFragments.forEach((fragment, index) => {
              const finalIndex = finalSources.findIndex(
                (s) => s.docId === fragment.source.docId,
              )
              if (finalIndex !== -1) {
                // The LLM sees `[citation:N]` where N is `index + 1`.
                // We map it to the `finalIndex` in our unique source list.
                // The processMessage function expects 1-based indexing for the final citation.
                finalCitationMap[index + 1] = finalIndex + 1
              }
            })

            // 3. Stream the final, unique citations to the client.
            // This allows the UI to prepare to display citation details.
            await stream.writeSSE({
              event: ChatSSEvents.CitationsUpdate,
              data: JSON.stringify({
                contextChunks: finalSources,
                citationMap: {},
              }),
            })
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
              sources: finalSources,
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

export const messageFeedbackSchema = z.object({
  messageId: z.string(),
  feedback: z.enum(messageFeedbackEnum.enumValues).nullable(), // Allows 'like', 'dislike', or null
})

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

    Logger.info(
      `Feedback ${
        feedback ? `'${feedback}'` : "removed"
      } for message ${messageId} by user ${email}`,
    )
    return c.json({ success: true, messageId, feedback })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(
      error,
      `Message Feedback Error: ${errMsg} ${(error as Error).stack}`,
    )
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, {
      message: "Could not submit feedback",
    })
  }
}
