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
  text: string,
  yieldedCitations: Set<number>,
  results: any[],
  baseIndex: number = 0,
) {
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

async function* generateIterativeTimeFilterAndQueryRewrite(
  input: string,
  messages: Message[],
  email: string,
  userCtx: string,
  alpha: number = 0.5,
  pageSize: number = 10,
  maxPageNumber: number = 3,
  maxSummaryCount: number | undefined,
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
  const initialSearchSpan = rootSpan?.startSpan("latestResults_search")

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

  // Ensure we have search terms even after stopword removal
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

      const initialContext = cleanContext(
        results?.root?.children
          ?.map(
            (v, i) =>
              `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, maxSummaryCount)}`,
          )
          ?.join("\n"),
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
        const initialContext = cleanContext(
          totalResults
            ?.map(
              (v, i) =>
                `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, maxSummaryCount)}`,
            )
            ?.join("\n"),
        )
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
            reasoning: isReasoning,
          },
        )
        let buffer = ""
        let currentAnswer = ""
        let parsed = { answer: "" }
        let thinking = ""
        let reasoning = isReasoning
        let yieldedCitations = new Set<number>()
        const ANSWER_TOKEN = '"answer":'
        for await (const chunk of iterator) {
          if (chunk.text) {
            if (reasoning) {
              if (thinking && !chunk.text.includes(EndThinkingToken)) {
                thinking += chunk.text
                yield* checkAndYieldCitations(
                  thinking,
                  yieldedCitations,
                  totalResults,
                  previousResultsLength,
                )
                yield { text: chunk.text, reasoning }
              } else {
                // first time
                const startThinkingIndex =
                  chunk.text.indexOf(StartThinkingToken)
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
                    totalResults,
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
                parsed = jsonParseLLMOutput(buffer, ANSWER_TOKEN) || {}
                if (parsed.answer === null) {
                  break
                }
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
                    totalResults,
                    previousResultsLength,
                  )
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
            yield { cost: chunk.cost }
          }
        }
        if (parsed.answer) {
          ragSpan?.setAttribute("answer_found", true)
          ragSpan?.end()
          querySpan?.end()
          pageSpan?.end()
          rootSpan?.end()
          queryRagSpan?.end()
          return
        }
        if (isReasoning) {
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
    const initialContext = cleanContext(
      results?.root?.children
        ?.map(
          (v, i) =>
            `Index ${i + startIndex} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, maxSummaryCount)}`,
        )
        ?.join("\n"),
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
      reasoning: isReasoning,
    })

    let buffer = ""
    let currentAnswer = ""
    let parsed = { answer: "" }
    let thinking = ""
    let reasoning = isReasoning
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
              results?.root?.children,
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
                results?.root?.children,
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
            parsed = jsonParseLLMOutput(buffer, ANSWER_TOKEN) || {}
            if (parsed.answer === null) {
              break
            }
            if (parsed.answer && currentAnswer !== parsed.answer) {
              if (currentAnswer === "") {
                // First valid answer - send the whole thing
                yield { text: parsed.answer }
              } else {
                // Subsequent chunks - send only the new part
                const newText = parsed.answer.slice(currentAnswer.length)
                yield { text: newText }
              }
              // Extract all citations from the parsed answer
              // const citationSpan = chunkSpan.startSpan("check_citations")
              yield* checkAndYieldCitations(
                parsed.answer,
                yieldedCitations,
                results?.root?.children,
                previousResultsLength,
              )
              currentAnswer = parsed.answer
            }
          } catch (err: any) {
            // Continue accumulating chunks if we can't parse yet
            Logger.debug(`Partial JSON parse error: ${getErrorMessage(err)}`)
            continue
          }
        }
      }
      if (chunk.cost) {
        yield { cost: chunk.cost }
      }
    }
    if (parsed.answer) {
      ragSpan?.setAttribute("answer_found", true)
      ragSpan?.end()
      pageSpan?.end()
      rootSpan?.end()
      queryRagSpan?.end()
      return
    }
    if (isReasoning) {
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
  // For "next" direction, we usually start from now
  if (direction === "next") {
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
  classification: TemporalClassifier,
  email: string,
  userCtx: string,
  alpha: number,
  pageSize: number = 10,
  maxSummaryCount: number | undefined,
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

  const message = input
  const maxIterations = 10
  const weekInMs = 12 * 24 * 60 * 60 * 1000
  const direction = classification.direction as string
  let costArr: number[] = []

  let from = new Date().getTime()
  let to = new Date().getTime()
  let lastSearchedTime = direction === "prev" ? from : to

  let previousResultsLength = 0
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const iterationSpan = rootSpan?.startSpan(`iteration_${iteration}`)
    iterationSpan?.setAttribute("iteration", iteration)
    const windowSize = (2 + iteration) * weekInMs

    if (direction === "prev") {
      to = lastSearchedTime
      from = to - windowSize
      lastSearchedTime = from
    } else {
      from = lastSearchedTime
      to = from + windowSize
      lastSearchedTime = to
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
    const initialContext = cleanContext(
      combinedResults?.root?.children
        ?.map(
          (v, i) =>
            `Index ${i + startIndex} \n ${answerContextMap(
              v as z.infer<typeof VespaSearchResultsSchema>,
              maxSummaryCount,
            )}`,
        )
        ?.join("\n"),
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
    const iterator = meetingPromptJsonStream(input, userCtx, initialContext, {
      stream: true,
      modelId: defaultBestModel,
      reasoning: isReasoning,
    })

    let buffer = ""
    let currentAnswer = ""
    let parsed = { answer: "" }
    let thinking = ""
    let reasoning = isReasoning
    let yieldedCitations = new Set<number>()
    const ANSWER_TOKEN = '"answer":'
    for await (const chunk of iterator) {
      if (chunk.text) {
        if (reasoning) {
          if (thinking && !chunk.text.includes(EndThinkingToken)) {
            thinking += chunk.text
            yield* checkAndYieldCitations(
              thinking,
              yieldedCitations,
              combinedResults?.root?.children,
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
                combinedResults?.root?.children,
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
            parsed = jsonParseLLMOutput(buffer, ANSWER_TOKEN) || {}
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
                combinedResults?.root?.children,
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
        costArr.push(chunk.cost)
        yield { cost: chunk.cost }
      }
    }
    ragSpan?.end()
    if (parsed.answer) {
      ragSpan?.setAttribute("answer_found", true)
      iterationSpan?.end()
      Logger.debug(`Ending rootSpan at ${new Date().toISOString()}`)
      rootSpan?.end()
      eventRagSpan?.end()
      return
    }
    // only increment in the case of reasoning
    if (isReasoning) {
      previousResultsLength += combinedResults?.root?.children?.length || 0
      iterationSpan?.setAttribute(
        "previous_results_length",
        previousResultsLength,
      )
    }
    iterationSpan?.end()
  }

  const noAnswerSpan = rootSpan?.startSpan("no_answer_response")
  const searchSummary = getSearchRangeSummary(from, to, direction, noAnswerSpan)
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

export async function* UnderstandMessageAndAnswer(
  email: string,
  userCtx: string,
  message: string,
  classification: TemporalClassifier,
  messages: Message[],
  alpha: number,
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
  // user is talking about an event
  if (classification.direction !== null) {
    Logger.info(
      `User is talking about an event in calendar, so going to look at calendar with direction: ${classification.direction}`,
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
      eventRagSpan,
    )
  } else {
    Logger.info(
      "default case, trying to do iterative RAG with query rewriting and time filtering for answering users query",
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
      ragSpan,
    )
  }
}

const handleError = (error: any) => {
  let errorMessage = "Something went wrong. Please try again."
  if (error?.code === OpenAIError.RateLimitError) {
    errorMessage = "Rate limit exceeded. Please try again later."
  } else if (error?.code === OpenAIError.InvalidAPIKey) {
    errorMessage =
      "Invalid API key provided. Please check your API key and ensure it is correct."
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

export const MessageApi = async (c: Context) => {
  // we will use this in catch
  // if the value exists then we send the error to the frontend via it
  const tracer: Tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("MessageApi")

  // Check if we're in agentic mode
  const isAgentic = c.req.query("agentic") === "true"
  rootSpan.setAttribute("isAgentic", isAgentic)
  Logger.info(
    `MessageApi called with agentic mode: ${isAgentic ? "enabled" : "disabled"}`,
  )

  // If we're in agentic mode, call the agentic handler directly
  if (isAgentic) {
    // Call the Agentic handler function here
    return MessageApiAgenticMinimal(c, rootSpan)
  }

  // Continue with regular non-agentic message processing
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
    let { message, chatId, modelId }: MessageReqType = body
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

          // Different flow for agentic vs non-agentic mode
          if (isAgentic) {
            Logger.info("Using agentic flow for message processing")
            // Placeholder for agentic flow
            await stream.writeSSE({
              event: ChatSSEvents.Reasoning,
              data: "Using agentic mode to process your request...",
            })

            // For now, we'll use the regular flow but add a note about agentic mode
            // Normal flow continues below...
          } else {
            Logger.info("Using regular non-agentic flow for message processing")
          }

          const messagesWithNoErrResponse = messages
            .slice(0, messages.length - 1)
            .filter((msg) => !msg?.errorMessage)
            .map((m) => ({
              role: m.messageRole as ConversationRole,
              content: [{ text: m.message }],
            }))

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
          let parsed = { answer: "", queryRewrite: "", temporalDirection: null }
          let thinking = ""
          let reasoning =
            ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning
          let buffer = ""
          const conversationSpan = streamSpan.startSpan("conversation_search")
          for await (const chunk of searchOrAnswerIterator) {
            if (stream.closed) {
              Logger.info(
                "[MessageApi] Stream closed during conversation search loop. Breaking.",
              )
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
                      const newText = parsed.answer.slice(currentAnswer.length)
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
            const classification: TemporalClassifier = {
              direction: parsed.temporalDirection,
            }
            const understandSpan = ragSpan.startSpan("understand_message")
            const iterator = UnderstandMessageAndAnswer(
              email,
              ctx,
              message,
              classification,
              messagesWithNoErrResponse,
              0.5,
              understandSpan,
            )
            stream.writeSSE({
              event: ChatSSEvents.Start,
              data: "",
            })

            answer = ""
            thinking = ""
            reasoning = isReasoning
            citations = []
            citationMap = {}
            let citationValues: Record<number, string> = {}
            for await (const chunk of iterator) {
              if (stream.closed) {
                Logger.info(
                  "[MessageApi] Stream closed during conversation search loop. Breaking.",
                )
                break
              }
              if (chunk.text) {
                if (chunk.reasoning) {
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
          if (answer) {
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
              thinking,
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
            Logger.info(`Inserted trace for message ${msg.externalId}`)
            await stream.writeSSE({
              event: ChatSSEvents.ResponseMetadata,
              data: JSON.stringify({
                chatId: chat.externalId,
                messageId: msg.externalId, // Use the stored assistant message ID
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
          } else {
            const errorSpan = streamSpan.startSpan("handle_no_answer")
            const allMessages = await getChatMessages(db, chat?.externalId)
            const lastMessage = allMessages[allMessages.length - 1]
            // Store potential assistant message ID even on error for metadata
            await stream.writeSSE({
              event: ChatSSEvents.ResponseMetadata,
              data: JSON.stringify({
                chatId: chat.externalId,
                messageId: lastMessage.externalId,
              }),
            })
            await stream.writeSSE({
              event: ChatSSEvents.Error,
              data: "Error while trying to answer",
            })
            // Add the error message to last user message
            await addErrMessageToMessage(
              lastMessage,
              "Error while trying to answer",
            )

            await stream.writeSSE({
              data: "",
              event: ChatSSEvents.End,
            })
            errorSpan.end()
            streamSpan.end()
            rootSpan.end()
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
    const { messageId } = body
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
          const convWithNoErrMsg = isUserMessage
            ? conversation
                .filter((con) => !con?.errorMessage)
                .map((m) => ({
                  role: m.messageRole as ConversationRole,
                  content: [{ text: m.message }],
                }))
            : conversation
                .slice(0, conversation.length - 1)
                .filter((con) => !con?.errorMessage)
                .map((m) => ({
                  role: m.messageRole as ConversationRole,
                  content: [{ text: m.message }],
                }))
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
                ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning,
              messages: convWithNoErrMsg,
            })
          let currentAnswer = ""
          let answer = ""
          let citations: Citation[] = [] // Changed to Citation[] for consistency
          let citationMap: Record<number, number> = {}
          let parsed = { answer: "", queryRewrite: "", temporalDirection: null }
          let thinking = ""
          let reasoning =
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
                      const newText = parsed.answer.slice(currentAnswer.length)
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
            const classification: TemporalClassifier = {
              direction: parsed.temporalDirection,
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
            )
            // throw new Error("Hello, how are u doing?")
            stream.writeSSE({
              event: ChatSSEvents.Start,
              data: "",
            })
            answer = ""
            thinking = ""
            reasoning = isReasoning
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
                if (chunk.reasoning) {
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
        // Add the error message to last user message
        // await addErrMessageToMessage(lastMessage, errFromMap)

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

// ==================================================
// === NEW Agentic Handler with Tool-Using Capabilities ===
// ==================================================

// --- Minimal Agent State Type ---
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
  let finalReasoning = ""
  const MOST_RECENT_CANDIDATE_COUNT = 3 // Define the constant here
  const costArr: number[] = [] // ***** Declare costArr here *****

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
          const summaryText = `Found ${fragments.length} results matching '${params.query}'. Top items: ${fragments
            .slice(0, 3)
            .map((f) => `[${f.source.title || "Untitled"}]`)
            .join(", ")}`
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
          const summaryText = `Found ${fragments.length} results in ${lowerCaseApp}. Top items: ${fragments
            .slice(0, 3)
            .map((f) => `[${f.source.title || "Untitled"}]`)
            .join(", ")}`
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
          const summaryText = `Found ${fragments.length} results in time range (${params.from_days_ago} to ${params.to_days_ago} days ago). Top items: ${fragments
            .slice(0, 3)
            .map((f) => `[${f.source.title || "Untitled"}]`)
            .join(", ")}`
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
          execSpan?.setAttribute("final_app_to_use", appToUse ? appToUse.toString() : "null")

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
              lowerCaseProvidedApp || (appToUse ? appToUse.toString() : null) || "any app"
            if (params.app) {
              responseText += ` in ${appNameForText}`
            }
            if (params.offset && params.offset > 0) {
              const currentOffset = params.offset || 0
              responseText += ` (showing items ${currentOffset + 1} to ${currentOffset + fragments.length})`
            }
            responseText += `. Top items: ${fragments
              .slice(0, 3)
              .map((f) => `"${f.source.title || "Untitled"}"`)
              .join(", ")}`

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
              lowerCaseProvidedApp || (appToUse ? appToUse.toString() : null) || "any app"
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
      const logAndStreamReasoning = async (reasoningText: string) => {
        agentLog.push(reasoningText)
        finalReasoning += reasoningText + "\n" // Append to finalReasoning log
        await stream.writeSSE({
          event: ChatSSEvents.Reasoning,
          data: reasoningText,
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
        await logAndStreamReasoning("Analyzing your question...")

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
              await logAndStreamReasoning(
                `Specific search failed validation ${consecutiveValidationFailures} times. Attempting to broaden search.`,
              )
              planSpan.setAttribute("broadening_search", true)
              planSpan.setAttribute(
                "excludedIds_for_broadening",
                JSON.stringify(excludedIds),
              )
              consecutiveValidationFailures = 0 // Reset after deciding to broaden
            }
            // --- End NEW ---

            await logAndStreamReasoning(
              `Iteration ${iteration}: Planning next step...`,
            )

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
              await logAndStreamReasoning(
                "LLM determined enough information is available. Proceeding to synthesis.",
              )
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
                  await logAndStreamReasoning(
                    `Adjusting parameters for '${isMostRecent ? "most recent" : "oldest"}' request...`,
                  )
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
              const planLog = `Selected tool: ${currentToolSelection.tool} with parameters: ${JSON.stringify(parameters)}`
              await logAndStreamReasoning(planLog)
              planSpan.setAttribute("selected_tool", currentToolSelection.tool)
              planSpan.setAttribute(
                "tool_parameters",
                JSON.stringify(parameters),
              )

              await logAndStreamReasoning(
                `Executing ${currentToolSelection.tool} tool...`,
              )
              toolResult = await selectedTool.execute(parameters, planSpan)

              // Process Tool Result
              if (toolResult.error) {
                agentLog.push(
                  `Tool execution error (${currentToolSelection.tool}): ${toolResult.error}`,
                )
                await logAndStreamReasoning(
                  `Search error with ${currentToolSelection.tool}: ${toolResult.error}`,
                )
                planSpan.setAttribute("tool_error", toolResult.error)
                // Reset consecutive failures on tool error? Maybe not, let it try again.
              } else {
                // --- Fix Start: Standardize successful tool log message ---
                const itemsFoundCount = toolResult.contexts?.length || 0
                const logMessage = `Tool result (${currentToolSelection.tool}): Found ${itemsFoundCount} item(s). ${toolResult.result}`
                agentLog.push(logMessage)
                await logAndStreamReasoning(toolResult.result) // Stream original result summary
                // --- Fix End ---
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
            agentLog.push(`Planning/Execution error: ${errMsg}`)
            await logAndStreamReasoning(
              `Error in planning/execution: ${errMsg}`,
            )
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
            await logAndStreamReasoning(
              `Tool returned a single item: "${singleFragment.source.title || "Untitled"}". Validating relevance...`,
            )
            const validationSpan = iterSpan.startSpan("validate_single_result")
            const isGoodMatch = await validateSingleResultQuality(
              currentQuery,
              singleFragment,
              validationSpan,
            )
            validationSpan.end()

            if (isGoodMatch) {
              shouldSynthesize = true
              await logAndStreamReasoning(
                "Single result validation passed. Synthesizing answer.",
              )
              consecutiveValidationFailures = 0 // Reset counter on success
            } else {
              shouldSynthesize = false // Do not synthesize
              consecutiveValidationFailures++ // Increment failure counter
              await logAndStreamReasoning(
                `Single result validation failed (POOR_MATCH #${consecutiveValidationFailures}). Will continue searching.`,
              )
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
                await logAndStreamReasoning(
                  `Found ${foundCount} items, which satisfies the requested count of ${requestedLimit}. Synthesizing answer.`,
                )
                consecutiveValidationFailures = 0
              } else if (
                iteration > 1 &&
                gatheredFragments.length >= requestedLimit
              ) {
                // If we have enough items after multiple iterations
                shouldSynthesize = true
                await logAndStreamReasoning(
                  `Found total of ${gatheredFragments.length} items across searches, which satisfies the requested count of ${requestedLimit}. Synthesizing answer.`,
                )
                consecutiveValidationFailures = 0
              }
            } else if (
              currentToolSelection?.tool === "metadata_retrieval" &&
              iteration > 1
            ) {
              // If this is a repeated metadata_retrieval call and we found multiple items, synthesize
              // to avoid repeating the same search over and over
              shouldSynthesize = true
              await logAndStreamReasoning(
                `Multiple search results found and we've completed multiple iterations. Synthesizing answer.`,
              )
              consecutiveValidationFailures = 0
            }
          } else if (
            iteration === maxIterations &&
            gatheredFragments.length > 0
          ) {
            // Synthesize on last iteration if we have *any* fragments
            shouldSynthesize = true
            await logAndStreamReasoning(
              "Max iterations reached. Attempting synthesis.",
            )
            consecutiveValidationFailures = 0 // Reset counter if synthesizing
          } else {
            // If tool ran successfully but didn't return 1 fragment, or if tool failed, reset counter
            consecutiveValidationFailures = 0
          }

          if (shouldSynthesize) {
            const synthSpan = iterSpan.startSpan("agent_synthesis")
            try {
              await logAndStreamReasoning(
                `Synthesizing answer from ${gatheredFragments.length} fragments...`,
              )
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
                await logAndStreamReasoning("Synthesis successful.")
                synthSpan.setAttribute("success", true)
                synthSpan.setAttribute("answer_length", finalAnswer.length)
                synthSpan.setAttribute(
                  "citations_found",
                  Object.keys(finalCitationMap).length,
                )
              } else {
                await logAndStreamReasoning(
                  "Synthesis did not produce a definitive answer from the context.",
                )
                synthSpan.setAttribute("success", false)
                synthSpan.setAttribute("reason", "Answer not found in context")
                // If synthesis failed after metadata success, maybe we should error out?
                if (toolSuccessAttr === true && newFragmentsCountAttr === 1) {
                  // Only error out if the *single validated* result failed synthesis
                  finalAnswer = "" // Clear any potentially bad answer
                  loopError =
                    "Relevant item found, but failed to synthesize a good answer from it."
                  await logAndStreamReasoning(loopError)
                }
              }
            } catch (synthErr) {
              const errMsg = getErrorMessage(synthErr)
              synthSpan.setAttribute("error", errMsg)
              Logger.error(synthErr, `Error during agent synthesis: ${errMsg}`)
              await logAndStreamReasoning(`Synthesis error: ${errMsg}`)
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
          await logAndStreamReasoning(loopError)
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
              thinking: finalReasoning,
              modelId: modelId || defaultBestModel,
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
          if (userMessageExternalId) {
            try {
              const userMsg = await getMessageByExternalId(
                db,
                userMessageExternalId,
              )
              if (userMsg) {
                await addErrMessageToMessage(userMsg, finalError)
                await stream.writeSSE({
                  event: ChatSSEvents.ResponseMetadata,
                  data: JSON.stringify({
                    chatId: chat!.externalId,
                    messageId: userMessageExternalId,
                  }),
                })
                Logger.warn(
                  `Agentic processing failed, error stored in user message ${userMessageExternalId}: ${finalError}`,
                )
              }
            } catch (dbErr) {
              Logger.error(dbErr, "Failed to add error message to user message")
            }
          }
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
