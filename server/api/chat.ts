import { answerContextMap, cleanContext, userContext } from "@/ai/context"
import {
  // baselineRAGIterationJsonStream,
  baselineRAGJsonStream,
  generateSearchQueryOrAnswerFromConversation,
  generateTitleUsingQuery,
  jsonParseLLMOutput,
  mailPromptJsonStream,
  temporalPromptJsonStream,
  queryRewriter,
} from "@/ai/provider"
import {
  Models,
  QueryType,
  type ConverseResponse,
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
  chatMessageSchema,
  DriveEntity,
  entitySchema,
  eventSchema,
  fileSchema,
  GooglePeopleEntity,
  isValidApp,
  isValidEntity,
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
    modelId: defaultFastModel, //defaultBestModel,
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
      url: `https://mail.google.com/mail/u/0/#inbox/${(fields as VespaMailAttachment).mailId}?projector=1&messagePartId=0.${(fields as VespaMailAttachment).partId}&disp=safe&zw`,
      app: (fields as VespaMailAttachment).app,
      entity: (fields as VespaMailAttachment).entity,
    }
  } else if (result.fields.sddocname === chatMessageSchema) {
    return {
      docId: (fields as VespaChatMessage).docId,
      title: (fields as VespaChatMessage).text,
      url: `https://${(fields as VespaChatMessage).domain}.slack.com/archives/${(fields as VespaChatMessage).channelId}/p${(fields as VespaChatMessage).updatedAt}`,
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
  classification: TemporalClassifier & QueryRouterResponse,
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
  const initialSearchSpan = rootSpan?.startSpan("latestResults_search")

  const monthInMs = 30 * 24 * 60 * 60 * 1000
  const timestampRange = {
    from: new Date().getTime() - 4 * monthInMs,
    to: new Date().getTime(),
  }
  const latestResults = (
    await searchVespa(message, email, null, null, {
      limit: pageSize,
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
        limit: pageSize,
        offset: pageNumber * pageSize,
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
        limit: pageSize,
        offset: pageNumber * pageSize,
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
      `[Main Search Path] Number of contextual chunks being passed: ${results?.root?.children?.length || 0}`,
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
  userRequestsReasoning?: boolean,
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

  let previousResultsLength = 0
  const results = await GetDocumentsByDocIds(fileIds)
  if (!results.root.children) {
    results.root.children = []
  }
  const startIndex = isReasoning ? previousResultsLength : 0
  const initialContext = cleanContext(
    results?.root?.children
      ?.map(
        (v, i) =>
          `Index ${i + startIndex} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, 0, true)}`,
      )
      ?.join("\n"),
  )
  Logger.info(
    `[Selected Context Path] Number of contextual chunks being passed: ${results?.root?.children?.length || 0}`,
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
    if (!results.root.children) {
      results.root.children = []
    }
    const startIndex = isReasoning ? previousResultsLength : 0
    const initialContext = cleanContext(
      results?.root?.children
        ?.map(
          (v, i) =>
            `Index ${i + startIndex} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, 20, true)}`,
        )
        ?.join("\n"),
    )
    Logger.info(
      `[Selected Context Path] Number of contextual chunks being passed: ${results?.root?.children?.length || 0}`,
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
      return
    } else if (
      // If no answer found, exit and yield nothing related to selected context found
      !answer
    ) {
      yield {
        text: "From the selected context, I could not find any information to answer it, please change your query",
      }
      return
    }
    if (config.isReasoning && userRequestsReasoning) {
      previousResultsLength += results?.root?.children?.length || 0
    }
  }
  if (config.isReasoning && userRequestsReasoning) {
    previousResultsLength += results?.root?.children?.length || 0
  }
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
      `${date.toLocaleString("default", { month: "long" })} ${date.getDate()}, ${date.getFullYear()} - ${formatTime(date)}`

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
        ? `${endDate.toLocaleString("default", { month: "long" })} ${endDate.getFullYear()}`
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
        ? `${startDate.toLocaleString("default", { month: "long" })} ${startDate.getFullYear()}`
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
  classification: TemporalClassifier & QueryRouterResponse,
  email: string,
  userCtx: string,
  alpha: number,
  pageSize: number = 10,
  maxSummaryCount: number | undefined,
  userRequestsReasoning?: boolean,
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
      `Iteration ${iteration}, searching from ${new Date(from)} to ${new Date(to)}`,
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
    Logger.info("Using temporalPromptJsonStream")
    const iterator = temporalPromptJsonStream(input, userCtx, initialContext, {
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
  span?: Span,
  userRequestsReasoning?: boolean,
) {
  if (app === Apps.GoogleDrive) {
    chunksCount = 100
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
  classification: TemporalClassifier & QueryRouterResponse,
  userRequestsReasoning?: boolean,
  span?: Span,
  maxIterations = 5,
): AsyncIterableIterator<
  ConverseResponse & { citation?: { index: number; item: any } }
> {
  const { app, entity, startTime, endTime, sortDirection } =
    classification.filters
  const count =
    "count" in classification.filters ? classification.filters.count : undefined
  const direction = classification.direction as string
  const isUnspecificMetadataRetrieval =
    classification.type === QueryType.RetrieveUnspecificMetadata
  const isMetadataRetrieval = classification.type === QueryType.RetrieveMetadata
  const isValidAppAndEntity =
    isValidApp(app as Apps) && isValidEntity(entity as any)

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
    classification.filter_query &&
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

    Logger.info(
      `Multiple App Entity - ${classification.filters.multipleAppAndEntity}`,
    )
    const searchOps = {
      limit: pageSize,
      alpha: userAlpha,
      rankProfile: SearchModes.GlobalSorted,
      timestampRange:
        timestampRange.to || timestampRange.from ? timestampRange : null,
    }

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const pageSpan = span?.startSpan(`metadata_iteration_${iteration}`)
      Logger.info(
        `Retrieve Metadata Iteration - ${iteration} : ${SearchModes.GlobalSorted}`,
      )
      items =
        (
          await searchVespa(
            classification.filter_query,
            email,
            app as Apps,
            entity as any,
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
        span,
        userRequestsReasoning,
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
  } else if (isUnspecificMetadataRetrieval && isValidAppAndEntity) {
    const userSpecifiedCountLimit = count ? Math.min(count, 50) : 5
    span?.setAttribute("metadata_type", QueryType.RetrieveUnspecificMetadata)
    span?.setAttribute(
      "isReasoning",
      userRequestsReasoning && config.isReasoning ? true : false,
    )
    span?.setAttribute("modelId", defaultBestModel)
    Logger.info(`Search Type : ${QueryType.RetrieveUnspecificMetadata}`)

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
    Logger.info(
      `Retrieved Documents : ${QueryType.RetrieveUnspecificMetadata} - ${items.length}`,
    )
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
      span,
      userRequestsReasoning,
    )
    return
  } else if (
    isMetadataRetrieval &&
    isValidAppAndEntity &&
    classification.filter_query
  ) {
    // Specific metadata retrieval
    span?.setAttribute("metadata_type", QueryType.RetrieveMetadata)
    span?.setAttribute(
      "isReasoning",
      userRequestsReasoning && config.isReasoning ? true : false,
    )
    span?.setAttribute("modelId", defaultBestModel)
    Logger.info(`Search Type : ${QueryType.RetrieveMetadata}`)

    const { filter_query } = classification
    const query = filter_query
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
      const iterationSpan = span?.startSpan(`metadata_iteration_${iteration}`)
      Logger.info(`Retrieve Metadata Iteration - ${iteration} : ${rankProfile}`)

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
        `Number of documents for ${QueryType.RetrieveMetadata} = ${items.length}`,
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
        span,
        userRequestsReasoning,
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

const fallbackText = (
  classification: TemporalClassifier & QueryRouterResponse,
): string => {
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
  classification: TemporalClassifier & QueryRouterResponse,
  messages: Message[],
  alpha: number,
  passedSpan?: Span,
  userRequestsReasoning?: boolean,
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

  const isUnspecificMetadataRetrieval =
    classification.type == QueryType.RetrieveUnspecificMetadata
  const isMetadataRetrieval = classification.type == QueryType.RetrieveMetadata

  if (
    isMetadataRetrieval ||
    isUnspecificMetadataRetrieval ||
    classification.filters.multipleAppAndEntity === false
  ) {
    Logger.info("Metadata Retrieval")

    const metadataRagSpan = passedSpan?.startSpan("metadata_rag")
    metadataRagSpan?.setAttribute("comment", "metadata retrieval")
    metadataRagSpan?.setAttribute(
      "classification",
      JSON.stringify(classification),
    )

    const count =
      isMetadataRetrieval || isUnspecificMetadataRetrieval
        ? classification.filters.count || chatPageSize
        : chatPageSize
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
          text: `I couldn't find any ${fallbackText(classification)}. Would you like to try a different search?`,
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

  if (classification.direction !== null) {
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
  passedSpan?: Span,
  userRequestsReasoning?: boolean,
): AsyncIterableIterator<
  ConverseResponse & { citation?: { index: number; item: any } }
> {
  passedSpan?.setAttribute("email", email)
  passedSpan?.setAttribute("message", message)
  passedSpan?.setAttribute("alpha", alpha)

  return yield* generateAnswerFromGivenContext(
    message,
    email,
    userCtx,
    alpha,
    fileIds,
    userRequestsReasoning,
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

export const MessageApi = async (c: Context) => {
  // we will use this in catch
  // if the value exists then we send the error to the frontend via it
  const tracer: Tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("MessageApi")

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
              understandSpan,
              userRequestsReasoning,
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
                filter_query: parsed.filter_query,
                filters: {
                  ...parsed.filters,
                  app: parsed.filters.app as Apps,
                  entity: parsed.filters.entity as any,
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
                understandSpan,
                userRequestsReasoning,
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
              understandSpan,
              userRequestsReasoning,
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
                    data: `Skipping last ${totalValidFileIdsFromLinkCount - maxValidLinks} valid link/s as it exceeds max limit of ${maxValidLinks}. `,
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
            const convWithNoErrMsg = isUserMessage
              ? conversation
                  .filter((con) => !con?.errorMessage)
                  .filter(
                    (msg) =>
                      !(
                        msg.messageRole === MessageRole.Assistant &&
                        !msg.message
                      ),
                  ) // filter out assistant messages with no content
                  .map((m) => {
                    // If any message from the messagesWithNoErrResponse is a user message, has fileIds and its message is JSON parsable
                    // then we should not give that exact stringified message as history
                    // We convert it into a AI friendly string only for giving it to LLM
                    const fileIds = JSON.parse(JSON.stringify(m?.fileIds || []))
                    if (
                      m.messageRole === "user" &&
                      fileIds &&
                      fileIds.length > 0
                    ) {
                      const originalMsg = m.message
                      const selectedContext = isContextSelected(originalMsg)
                      m.message = selectedContext
                        ? buildUserQuery(selectedContext)
                        : originalMsg
                    }
                    return {
                      role: m.messageRole as ConversationRole,
                      content: [{ text: m.message }],
                    }
                  })
              : conversation
                  .slice(0, conversation.length - 1)
                  .filter((con) => !con?.errorMessage)
                  .filter(
                    (msg) =>
                      !(
                        msg.messageRole === MessageRole.Assistant &&
                        !msg.message
                      ),
                  )
                  .map((m) => {
                    // If any message from the messagesWithNoErrResponse is a user message, has fileIds and its message is JSON parsable
                    // then we should not give that exact stringified message as history
                    // We convert it into a AI friendly string only for giving it to LLM
                    const fileIds = JSON.parse(JSON.stringify(m?.fileIds || []))
                    if (
                      m.messageRole === "user" &&
                      fileIds &&
                      fileIds.length > 0
                    ) {
                      const originalMsg = m.message
                      const selectedContext = isContextSelected(originalMsg)
                      m.message = selectedContext
                        ? buildUserQuery(selectedContext)
                        : originalMsg
                    }
                    return {
                      role: m.messageRole as ConversationRole,
                      content: [{ text: m.message }],
                    }
                  })

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
                messages: convWithNoErrMsg,
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
                      `Error while parsing LLM output ${(err as Error).message}`,
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
              const classification: TemporalClassifier & QueryRouterResponse = {
                direction: parsed.temporalDirection,
                type: parsed.type as QueryType,
                filter_query: parsed.filter_query,
                filters: {
                  ...parsed.filters,
                  app: parsed.filters.app as Apps,
                  entity: parsed.filters.entity as any,
                },
              }
              const understandSpan = ragSpan.startSpan("understand_message")
              const iterator = UnderstandMessageAndAnswer(
                email,
                ctx,
                message,
                classification,
                convWithNoErrMsg,
                0.5,
                understandSpan,
                userRequestsReasoning,
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
            `Streaming Error: ${(error as Error).message} ${(error as Error).stack}`,
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
          `[StopStreamingApi] Error closing stream ${streamKey}: ${getErrorMessage(closeError)}`,
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
      `[StopStreamingApi] Unexpected Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, { message: "Could not stop streaming." })
  }
}
