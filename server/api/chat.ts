import { answerContextMap, cleanContext, userContext } from "@/ai/context"
import { getTracer, type Tracer, type Span } from "@/tracer"
import {
  // baselineRAGIterationJsonStream,
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
import type { ConversationRole, Message } from "@aws-sdk/client-bedrock-runtime"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import type { chatSchema } from "@/api/search"
import { insertChatTrace } from "@/db/chatTrace"
import { searchVespa } from "@/search/vespa"
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
  type VespaSearchResponse,
  type VespaSearchResult,
  type VespaSearchResults,
  type VespaSearchResultsSchema,
  type VespaUser,
} from "@/search/types"
import { APIError } from "openai"
const {
  JwtPayloadKey,
  chatHistoryPageSize,
  defaultBestModel,
  defaultFastModel,
  maxDefaultSummary,
  isReasoning,
  fastModelReasoning,
  StartThinkingToken,
  EndThinkingToken,
} = config
const Logger = getLogger(Subsystem.Chat)

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
      // First will have to delete all messages associated with that chat
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

const searchToCitation = (result: VespaSearchResults): Citation => {
  const fields = result.fields
  if (result.fields.sddocname === userSchema) {
    return {
      title: (fields as VespaUser).name,
      url: `https://contacts.google.com/${(fields as VespaUser).email}`,
      app: (fields as VespaUser).app,
      entity: (fields as VespaUser).entity,
    }
  } else if (result.fields.sddocname === fileSchema) {
    return {
      title: (fields as VespaFile).title,
      url: (fields as VespaFile).url || "",
      app: (fields as VespaFile).app,
      entity: (fields as VespaFile).entity,
    }
  } else if (result.fields.sddocname === mailSchema) {
    return {
      title: (fields as VespaMail).subject,
      url: `https://mail.google.com/mail/u/0/#inbox/${fields.docId}`,
      app: (fields as VespaMail).app,
      entity: (fields as VespaMail).entity,
    }
  } else if (result.fields.sddocname === eventSchema) {
    return {
      title: (fields as VespaEvent).name || "No Title",
      url: (fields as VespaEvent).url,
      app: (fields as VespaEvent).app,
      entity: (fields as VespaEvent).entity,
    }
  } else if (result.fields.sddocname === mailAttachmentSchema) {
    return {
      title: (fields as VespaMailAttachment).filename || "No Filename",
      url: `https://mail.google.com/mail/u/0/#inbox/${(fields as VespaMailAttachment).mailId}?projector=1&messagePartId=0.${(fields as VespaMailAttachment).partId}&disp=safe&zw`,
      app: (fields as VespaMailAttachment).app,
      entity: (fields as VespaMailAttachment).entity,
    }
  } else if (result.fields.sddocname === chatMessageSchema) {
    return {
      title: (fields as VespaChatMessage).text,
      url: `https://google.com`,
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
  span: Span,
): AsyncIterableIterator<
  ConverseResponse & { citation?: { index: number; item: any } }
> {
  const tracer: Tracer = getTracer("chat") // Use custom tracer
  const ragSpan: Span = tracer.startSpan("iterative-rag", { parentSpan: span }) // Start span with custom tracer
  tracer.setAttribute(ragSpan, "input_query", input)
  tracer.setAttribute(ragSpan, "max_page_number", maxPageNumber)

  const message = input
  const monthInMs = 30 * 24 * 60 * 60 * 1000

  const recentSearchSpan: Span = tracer.startSpan("recent-search", {
    parentSpan: ragSpan,
  })
  const latestResults = (
    await searchVespa(message, email, null, null, pageSize, 0, alpha, {
      from: new Date().getTime() - 4 * monthInMs,
      to: new Date().getTime(),
    })
  ).root.children

  tracer.setAttribute(
    recentSearchSpan,
    "results_count",
    latestResults?.length || 0,
  )
  tracer.endSpan(recentSearchSpan)

  const latestIds = latestResults
    ?.map((v: VespaSearchResult) => (v?.fields as any).docId)
    ?.filter((v) => !!v)

  let previousResultsLength = 0
  for (let pageNumber = 0; pageNumber < maxPageNumber; pageNumber++) {
    const pageSpan: Span = tracer.startSpan("page-iteration", {
      parentSpan: ragSpan,
    })
    tracer.setAttribute(pageSpan, "page_number", pageNumber)

    if (pageNumber === Math.floor(maxPageNumber / 2)) {
      const queryRewriteSpan: Span = tracer.startSpan("query-rewrite", {
        parentSpan: pageSpan,
      })

      let results = await searchVespa(
        message,
        email,
        null,
        null,
        pageSize,
        0,
        alpha,
      )

      tracer.setAttribute(
        queryRewriteSpan,
        "initial_results_count",
        results?.root?.children?.length || 0,
      )

      const initialContext = cleanContext(
        results?.root?.children
          ?.map(
            (v, i) =>
              `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, maxSummaryCount)}`,
          )
          ?.join("\n"),
      )

      tracer.setAttribute(
        queryRewriteSpan,
        "context_length",
        initialContext.length,
      )

      const queryResp = await queryRewriter(input, userCtx, initialContext, {
        modelId: defaultFastModel,
        stream: false,
      })

      const queries = queryResp.queries
      tracer.setAttribute(
        queryRewriteSpan,
        "generated_queries_count",
        queries.length,
      )

      for (const query of queries) {
        const queryExecSpan: Span = tracer.startSpan("query-execution", {
          parentSpan: queryRewriteSpan,
        })
        tracer.setAttribute(queryExecSpan, "rewritten_query", query)

        const latestResults: VespaSearchResult[] = (
          await searchVespa(query, email, null, null, pageSize, 0, alpha, {
            from: new Date().getTime() - 4 * monthInMs,
            to: new Date().getTime(),
          })
        )?.root?.children

        let results = await searchVespa(
          query,
          email,
          null,
          null,
          pageSize,
          0,
          alpha,
          null,
          latestResults
            ?.map((v: VespaSearchResult) => (v.fields as any).docId)
            ?.filter((v) => !!v),
        )

        const totalResults = (results?.root?.children || []).concat(
          latestResults || [],
        )

        tracer.setAttribute(
          queryExecSpan,
          "total_results_count",
          totalResults.length,
        )

        const initialContext = cleanContext(
          totalResults
            ?.map(
              (v, i) =>
                `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, maxSummaryCount)}`,
            )
            ?.join("\n"),
        )

        const ragStreamSpan: Span = tracer.startSpan("rag-stream", {
          parentSpan: queryExecSpan,
        })
        tracer.setAttribute(
          ragStreamSpan,
          "context_length",
          initialContext.length,
        )

        const iterator = baselineRAGJsonStream(query, userCtx, initialContext, {
          stream: true,
          modelId: defaultBestModel,
          messages,
          reasoning: isReasoning,
        })

        let buffer = ""
        let currentAnswer = ""
        let parsed = { answer: "" }
        let thinking = ""
        let reasoning = isReasoning
        let yieldedCitations = new Set<number>()

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
                if (!chunk.text.includes(StartThinkingToken)) {
                  let token = chunk.text
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
                parsed = jsonParseLLMOutput(buffer)
                if (parsed.answer === null) {
                  break
                }
                if (parsed.answer && currentAnswer !== parsed.answer) {
                  if (currentAnswer === "") {
                    yield { text: parsed.answer }
                  } else {
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

        tracer.setAttribute(
          ragStreamSpan,
          "citations_count",
          yieldedCitations.size,
        )
        tracer.setAttribute(
          ragStreamSpan,
          "has_answer",
          parsed.answer ? true : false,
        )
        tracer.endSpan(ragStreamSpan)

        if (parsed.answer) {
          tracer.setAttribute(queryExecSpan, "result", "success")
          tracer.endSpan(queryExecSpan)
          tracer.setAttribute(queryRewriteSpan, "result", "success")
          tracer.endSpan(queryRewriteSpan)
          tracer.setAttribute(pageSpan, "result", "success")
          tracer.endSpan(pageSpan)
          tracer.setAttribute(ragSpan, "result", "success")
          tracer.endSpan(ragSpan)
          return
        }

        tracer.setAttribute(queryExecSpan, "result", "no_answer")
        tracer.endSpan(queryExecSpan)

        if (isReasoning) {
          previousResultsLength += totalResults.length
        }
      }

      tracer.setAttribute(queryRewriteSpan, "result", "no_answer")
      tracer.endSpan(queryRewriteSpan)
    }

    const searchSpan: Span = tracer.startSpan("vespa-search", {
      parentSpan: pageSpan,
    })
    let results: VespaSearchResponse

    if (pageNumber === 0) {
      results = await searchVespa(
        message,
        email,
        null,
        null,
        pageSize,
        pageNumber * pageSize,
        alpha,
        null,
        latestIds,
      )

      if (!results.root.children) {
        results.root.children = []
      }

      results.root.children = results?.root?.children?.concat(
        latestResults || [],
      )

      tracer.setAttribute(
        searchSpan,
        "combined_results_count",
        results?.root?.children?.length || 0,
      )
    } else {
      results = await searchVespa(
        message,
        email,
        null,
        null,
        pageSize,
        pageNumber * pageSize,
        alpha,
      )

      tracer.setAttribute(
        searchSpan,
        "results_count",
        results?.root?.children?.length || 0,
      )
    }
    tracer.endSpan(searchSpan)

    const startIndex = isReasoning ? previousResultsLength : 0
    const initialContext = cleanContext(
      results?.root?.children
        ?.map(
          (v, i) =>
            `Index ${i + startIndex} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, maxSummaryCount)}`,
        )
        ?.join("\n"),
    )

    const llmSpan: Span = tracer.startSpan("llm-response", {
      parentSpan: pageSpan,
    })
    tracer.setAttribute(llmSpan, "context_length", initialContext.length)

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
            if (!chunk.text.includes(StartThinkingToken)) {
              let token = chunk.text
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
            parsed = jsonParseLLMOutput(buffer)
            if (parsed.answer === null) {
              break
            }
            if (parsed.answer && currentAnswer !== parsed.answer) {
              if (currentAnswer === "") {
                yield { text: parsed.answer }
              } else {
                const newText = parsed.answer.slice(currentAnswer.length)
                yield { text: newText }
              }
              yield* checkAndYieldCitations(
                parsed.answer,
                yieldedCitations,
                results?.root?.children,
                previousResultsLength,
              )
              currentAnswer = parsed.answer
            }
          } catch (err) {
            const errMessage = (err as Error).message
            Logger.error(err, `Error while parsing LLM output ${errMessage}`)
            continue
          }
        }
      }
      if (chunk.cost) {
        yield { cost: chunk.cost }
      }
    }

    tracer.setAttribute(llmSpan, "has_answer", parsed.answer ? true : false)
    tracer.setAttribute(llmSpan, "citations_count", yieldedCitations.size)
    tracer.endSpan(llmSpan)

    if (parsed.answer) {
      tracer.setAttribute(pageSpan, "result", "success")
      tracer.endSpan(pageSpan)
      tracer.setAttribute(ragSpan, "result", "success")
      tracer.endSpan(ragSpan)
      return
    }

    tracer.setAttribute(pageSpan, "result", "no_answer")
    tracer.endSpan(pageSpan)

    if (isReasoning) {
      previousResultsLength += results?.root?.children?.length || 0
    }
  }

  tracer.setAttribute(ragSpan, "result", "no_answer_found")
  tracer.endSpan(ragSpan)

  yield {
    text: "I could not find any information to answer it, please change your query",
  }
}
const getSearchRangeSummary = (from: number, to: number, direction: string) => {
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
    return `from today until ${endStr}`
  }
  // For "prev" direction
  else {
    const startDate = new Date(from)
    const startStr =
      Math.abs(now - from) > 30 * 24 * 60 * 60 * 1000
        ? `${startDate.toLocaleString("default", { month: "long" })} ${startDate.getFullYear()}`
        : getRelativeTime(from)
    return `from today back to ${startStr}`
  }
}

async function* generatePointQueryTimeExpansion(
  input: string,
  messages: Message[],
  classification: TemporalClassifier & { cost: number },
  email: string,
  userCtx: string,
  alpha: number,
  pageSize: number = 10,
  maxSummaryCount: number | undefined,
  span: Span,
): AsyncIterableIterator<
  ConverseResponse & { citation?: { index: number; item: any } }
> {
  const message = input
  const maxIterations = 10
  const weekInMs = 12 * 24 * 60 * 60 * 1000
  const direction = classification.direction as string
  let costArr: number[] = [classification.cost]

  const tracer: Tracer = getTracer("chat") // Use custom tracer
  const expansionSpan: Span = tracer.startSpan("time-expansion", {
    parentSpan: span,
  }) // Start span with custom tracer
  tracer.setAttribute(expansionSpan, "direction", direction)
  tracer.setAttribute(expansionSpan, "max_iterations", maxIterations)

  let from = new Date().getTime()
  let to = new Date().getTime()
  let lastSearchedTime = direction === "prev" ? from : to

  let previousResultsLength = 0
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const iterationSpan: Span = tracer.startSpan("time-expansion-iteration", {
      parentSpan: expansionSpan,
    })
    tracer.setAttribute(iterationSpan, "iteration", iteration)

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

    tracer.setAttribute(
      iterationSpan,
      "from_date",
      new Date(from).toISOString(),
    )
    tracer.setAttribute(iterationSpan, "to_date", new Date(to).toISOString())

    Logger.info(
      `Iteration ${iteration}, searching from ${new Date(from)} to ${new Date(to)}`,
    )

    const searchSpan: Span = tracer.startSpan("vespa-search", {
      parentSpan: iterationSpan,
    })

    const [eventResults, results] = await Promise.all([
      searchVespa(
        message,
        email,
        Apps.GoogleCalendar,
        null,
        pageSize,
        0,
        alpha,
        { from, to },
      ),
      searchVespa(
        message,
        email,
        null,
        null,
        pageSize,
        0,
        alpha,
        { to, from },
        ["CATEGORY_PROMOTIONS", "UNREAD"],
      ),
    ])

    tracer.setAttribute(
      searchSpan,
      "calendar_results_count",
      eventResults?.root?.children?.length || 0,
    )
    tracer.setAttribute(
      searchSpan,
      "email_results_count",
      results?.root?.children?.length || 0,
    )
    tracer.endSpan(searchSpan)

    if (!results.root.children && !eventResults.root.children) {
      tracer.setAttribute(iterationSpan, "result", "no_results")
      tracer.endSpan(iterationSpan)
      continue
    }

    // Combine and filter results
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

    tracer.setAttribute(
      iterationSpan,
      "combined_results_count",
      combinedResults.root.children.length,
    )

    if (!combinedResults.root.children.length) {
      Logger.info("No gmail or calendar events found")
      tracer.setAttribute(iterationSpan, "result", "no_matching_results")
      tracer.endSpan(iterationSpan)
      continue
    }

    // Prepare context for LLM
    const startIndex = isReasoning ? previousResultsLength : 0
    const initialContext = cleanContext(
      combinedResults?.root?.children
        ?.map(
          (v, i) =>
            `Index ${i + startIndex} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, maxSummaryCount)}`,
        )
        ?.join("\n"),
    )

    const llmSpan: Span = tracer.startSpan("llm-response", {
      parentSpan: iterationSpan,
    })
    tracer.setAttribute(llmSpan, "context_length", initialContext.length)

    const iterator = meetingPromptJsonStream(input, userCtx, initialContext, {
      stream: true,
      modelId: defaultBestModel,
    })

    let buffer = ""
    let currentAnswer = ""
    let parsed = { answer: "" }
    let thinking = ""
    let reasoning = isReasoning
    let yieldedCitations = new Set<number>()

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
            if (!chunk.text.includes(StartThinkingToken)) {
              let token = chunk.text
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
            parsed = jsonParseLLMOutput(buffer)
            if (parsed.answer === null) {
              break
            }
            if (parsed.answer && currentAnswer !== parsed.answer) {
              if (currentAnswer === "") {
                yield { text: parsed.answer }
              } else {
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
            continue
          }
        }
      }
      if (chunk.cost) {
        costArr.push(chunk.cost)
        yield { cost: chunk.cost }
      }
    }

    tracer.setAttribute(llmSpan, "has_answer", parsed.answer ? true : false)
    tracer.setAttribute(llmSpan, "citations_count", yieldedCitations.size)
    tracer.endSpan(llmSpan)

    if (parsed.answer) {
      tracer.setAttribute(iterationSpan, "result", "success")
      tracer.endSpan(iterationSpan)
      tracer.setAttribute(expansionSpan, "result", "success")
      tracer.endSpan(expansionSpan)
      return
    }

    tracer.setAttribute(iterationSpan, "result", "no_answer")
    tracer.endSpan(iterationSpan)

    if (isReasoning) {
      previousResultsLength += combinedResults?.root?.children?.length || 0
    }
  }

  const searchSummary = getSearchRangeSummary(from, to, direction)
  tracer.setAttribute(expansionSpan, "result", "no_relevant_data")
  tracer.setAttribute(expansionSpan, "search_summary", searchSummary)
  tracer.endSpan(expansionSpan)

  yield {
    text: `I searched your calendar events and emails ${searchSummary} but couldn't find any relevant meetings. Please try rephrasing your query.`,
    cost: costArr.reduce((a, b) => a + b, 0),
  }
}

export async function* UnderstandMessageAndAnswer(
  email: string,
  userCtx: string,
  message: string,
  classification: TemporalClassifier & { cost: number },
  messages: Message[],
  span: Span,
): AsyncIterableIterator<
  ConverseResponse & { citation?: { index: number; item: any } }
> {
  const tracer: Tracer = getTracer("chat") // Use custom tracer
  const understandSpan: Span = tracer.startSpan("understand-message", {
    parentSpan: span,
  }) // Use custom tracer’s startSpan

  // Set attributes using the custom tracer
  tracer.setAttribute(understandSpan, "message", message)
  tracer.setAttribute(
    understandSpan,
    "temporal_classification",
    classification.direction || "null",
  )
  tracer.setAttribute(
    understandSpan,
    "has_cost",
    classification.cost ? true : false,
  )

  // User is talking about an event
  if (classification.direction !== null) {
    Logger.info(
      `User is talking about an event in calendar, so going to look at calendar with direction: ${classification.direction}`,
    )
    tracer.setAttribute(understandSpan, "approach", "temporal_event_search")

    const result = yield* generatePointQueryTimeExpansion(
      message,
      messages,
      classification,
      email,
      userCtx,
      0.5,
      20,
      5,
      understandSpan,
    )
    tracer.endSpan(understandSpan)
    return result
  } else {
    Logger.info(
      "default case, trying to do iterative RAG with query rewriting and time filtering for answering users query",
    )
    tracer.setAttribute(understandSpan, "approach", "iterative_rag")

    // Default case
    const result = yield* generateIterativeTimeFilterAndQueryRewrite(
      message,
      messages,
      email,
      userCtx,
      0.5,
      20,
      3,
      maxDefaultSummary,
      understandSpan,
    )
    tracer.endSpan(understandSpan)
    return result
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
  const tracer: Tracer = getTracer("chat") // Use custom tracer
  const parentSpan: Span = tracer.startSpan("handleMessageApi")
  let stream: any
  let chat: SelectChat

  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub
    tracer.setAttribute(parentSpan, "user.email", sub) // Use tracer.setAttribute
    tracer.setAttribute(parentSpan, "workspace.id", workspaceId)
    // @ts-ignore
    const body = c.req.valid("query")
    let { message, chatId, modelId }: MessageReqType = body
    tracer.setAttribute(parentSpan, "user_message", message)
    if (!message) {
      throw new HTTPException(400, { message: "Message is required" })
    }
    message = decodeURIComponent(message)

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const { user, workspace } = userAndWorkspace
    let messages: SelectMessage[] = []
    const costArr: number[] = []
    const userCtx = userContext(userAndWorkspace)

    const chatSpan: Span = tracer.startSpan("chat-handling", { parentSpan })
    tracer.setAttribute(chatSpan, "chat.id", chatId || "new")
    let title = ""
    if (!chatId) {
      const titleResp = await generateTitleUsingQuery(message, {
        modelId: ragPipelineConfig[RagPipelineStages.NewChatTitle].modelId,
        stream: false,
      })
      title = titleResp.title
      if (titleResp.cost) costArr.push(titleResp.cost)

      const [insertedChat, insertedMsg] = await db.transaction(
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
        "First message of the conversation, successfully created the chat",
      )
      chat = insertedChat
      messages.push(insertedMsg)
    } else {
      const [existingChat, allMessages, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage[], SelectMessage]> => {
          const existingChat = await updateChatByExternalId(db, chatId, {})
          const allMessages = await getChatMessages(tx, chatId)
          const insertedMsg = await insertMessage(tx, {
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
      messages = allMessages.concat(insertedMsg)
      chat = existingChat
    }
    tracer.endSpan(chatSpan)

    return streamSSE(c, async (stream) => {
      const streamSpan: Span = tracer.startSpan("stream-response", {
        parentSpan,
      })
      tracer.setAttribute(streamSpan, "chat.id", chat.externalId)

      try {
        if (!chatId) {
          await stream.writeSSE({
            data: title,
            event: ChatSSEvents.ChatTitleUpdate,
          })
        }

        Logger.info("Chat stream started")
        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({ chatId: chat.externalId }),
        })

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
        const answerSpan: Span = tracer.startSpan("generate-answer", {
          parentSpan: streamSpan,
        })
        const searchOrAnswerIterator =
          generateSearchQueryOrAnswerFromConversation(message, userCtx, {
            modelId:
              ragPipelineConfig[RagPipelineStages.AnswerOrSearch].modelId,
            stream: true,
            json: true,
            reasoning:
              ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning,
            messages: messagesWithNoErrResponse,
          })

        let currentAnswer = ""
        let answer = ""
        let citations = []
        let citationMap: Record<number, number> = {}
        let parsed = { answer: "", queryRewrite: "" }
        let thinking = ""
        let reasoning =
          ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning
        let buffer = ""
        for await (const chunk of searchOrAnswerIterator) {
          if (chunk.text) {
            if (reasoning) {
              if (thinking && !chunk.text.includes(EndThinkingToken)) {
                thinking += chunk.text
                stream.writeSSE({
                  event: ChatSSEvents.Reasoning,
                  data: chunk.text,
                })
              } else {
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
                parsed = jsonParseLLMOutput(buffer)
                if (parsed.answer && currentAnswer !== parsed.answer) {
                  if (currentAnswer === "") {
                    Logger.info(
                      "We were able to find the answer/respond to users query in the conversation itself so not applying RAG",
                    )
                    stream.writeSSE({
                      event: ChatSSEvents.Start,
                      data: "",
                    })
                    stream.writeSSE({
                      event: ChatSSEvents.ResponseUpdate,
                      data: parsed.answer,
                    })
                  } else {
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
          if (chunk.cost) costArr.push(chunk.cost)
        }

        if (parsed.answer === null || parsed.answer === "") {
          tracer.setAttribute(answerSpan, "answer", "none")
          if (parsed.queryRewrite) {
            tracer.setAttribute(answerSpan, "rewrite", parsed.queryRewrite)
            Logger.info(
              "The query is ambigious and requires a mandatory query rewrite from the existing conversation / recent messages",
            )
            message = parsed.queryRewrite
          } else {
            tracer.setAttribute(answerSpan, "rewrite", "none")
            Logger.info(
              "There was no need for a query rewrite and there was no answer in the conversation, applying RAG",
            )
          }

          const temporalSpan: Span = tracer.startSpan("temporal", {
            parentSpan: answerSpan,
          })
          const classification: TemporalClassifier & { cost: number } =
            await temporalEventClassification(message, {
              modelId: ragPipelineConfig[RagPipelineStages.QueryRouter].modelId,
              stream: false,
            })
          tracer.setAttribute(
            temporalSpan,
            "classification",
            classification.direction || "null",
          )
          tracer.endSpan(temporalSpan)

          const understandAnswerSpan: Span = tracer.startSpan(
            "understandAnswer",
            { parentSpan: answerSpan },
          )
          const iterator = UnderstandMessageAndAnswer(
            email,
            userCtx,
            message,
            classification,
            messagesWithNoErrResponse,
            understandAnswerSpan,
          ) // parentTraceCtx is null since we're not mixing with OpenTelemetry here
          tracer.endSpan(understandAnswerSpan)

          stream.writeSSE({
            event: ChatSSEvents.Start,
            data: "",
          })
          answer = ""
          thinking = ""
          reasoning = isReasoning
          citations = []
          citationMap = {}
          for await (const chunk of iterator) {
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
            if (chunk.cost) costArr.push(chunk.cost)
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
            }
          }
        } else if (parsed.answer) {
          answer = parsed.answer
        }

        if (answer) {
          tracer.setAttribute(answerSpan, "answer", parsed.answer)
          tracer.endSpan(answerSpan)
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

          const traceJson = tracer.serializeToJson()
          // Assuming you have an insertChatTrace function to store the trace
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
              messageId: msg.externalId,
            }),
          })
          await stream.writeSSE({
            data: "",
            event: ChatSSEvents.End,
          })
        } else {
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
            data: "Error while trying to answer",
          })
          await addErrMessageToMessage(
            lastMessage,
            "Error while trying to answer",
          )
          await stream.writeSSE({
            data: "",
            event: ChatSSEvents.End,
          })
        }
      } catch (error) {
        const errFromMap = handleError(error)
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
          data: errFromMap,
        })
        await addErrMessageToMessage(lastMessage, errFromMap)
        await stream.writeSSE({
          data: "",
          event: ChatSSEvents.End,
        })
        Logger.error(
          error,
          `Streaming Error: ${(error as Error).message} ${(error as Error).stack}`,
        )
      } finally {
        tracer.endSpan(streamSpan)
      }
    })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    const errFromMap = handleError(error)
    // @ts-ignore
    if (chat?.externalId) {
      const allMessages = await getChatMessages(db, chat?.externalId)
      const lastMessage = allMessages[allMessages.length - 1]
      await stream.writeSSE({
        event: ChatSSEvents.ResponseMetadata,
        data: JSON.stringify({
          chatId: chat.externalId,
          messageId: lastMessage.externalId,
        }),
      })
      await addErrMessageToMessage(lastMessage, errFromMap)
    }
    if (error instanceof APIError && error.status === 429) {
      Logger.error(error, "You exceeded your current quota")
      if (stream) {
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: errFromMap,
        })
      }
    } else {
      Logger.error(error, `Message Error: ${errMsg} ${(error as Error).stack}`)
      throw new HTTPException(500, {
        message: "Could not create message or Chat",
      })
    }
  } finally {
    tracer.endSpan(parentSpan)
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
  const tracer: Tracer = getTracer("chat") // Use custom tracer
  const parentSpan: Span = tracer.startSpan("handleMessageRetryApi")

  try {
    // @ts-ignore
    const body = c.req.valid("query")
    const { messageId } = body

    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub
    tracer.setAttribute(parentSpan, "user.email", sub)
    tracer.setAttribute(parentSpan, "workspace.id", workspaceId)
    tracer.setAttribute(parentSpan, "message.id", messageId)

    const costArr: number[] = []
    const originalMessage = await getMessageByExternalId(db, messageId)
    if (!originalMessage) {
      throw new HTTPException(404, { message: "Message not found" })
    }
    const isUserMessage = originalMessage.messageRole === "user"
    tracer.setAttribute(parentSpan, "is_user_message", isUserMessage)

    let conversation = await getChatMessagesBefore(
      db,
      originalMessage.chatId,
      originalMessage.createdAt,
    )
    if (!isUserMessage && (!conversation || !conversation.length)) {
      throw new HTTPException(400, {
        message: "Could not fetch previous messages",
      })
    }

    const modelId = originalMessage.modelId as Models
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const { user, workspace } = userAndWorkspace
    const ctx = userContext(userAndWorkspace)

    let newCitations: Citation[] = []
    const prevUserMessage = isUserMessage
      ? originalMessage
      : conversation[conversation.length - 1]
    if (conversation.length === 1) {
      conversation = []
    }
    if (!prevUserMessage.message) {
      throw new HTTPException(400, {
        message: "Cannot retry the message, invalid user chat",
      })
    }

    return streamSSE(
      c,
      async (stream) => {
        const streamSpan: Span = tracer.startSpan("stream-response", {
          parentSpan,
        })
        tracer.setAttribute(
          streamSpan,
          "chat.id",
          originalMessage.chatExternalId,
        )

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
          const answerSpan: Span = tracer.startSpan("generate-answer", {
            parentSpan: streamSpan,
          })

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
          let citations: number[] = []
          let citationMap: Record<number, number> = {}
          let parsed = { answer: "", queryRewrite: "" }
          let thinking = ""
          let reasoning =
            ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning
          let buffer = ""

          for await (const chunk of searchOrAnswerIterator) {
            if (chunk.text) {
              if (reasoning) {
                if (thinking && !chunk.text.includes(EndThinkingToken)) {
                  thinking += chunk.text
                  stream.writeSSE({
                    event: ChatSSEvents.Reasoning,
                    data: chunk.text,
                  })
                } else {
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
                  parsed = jsonParseLLMOutput(buffer)
                  if (parsed.answer && currentAnswer !== parsed.answer) {
                    if (currentAnswer === "") {
                      Logger.info(
                        "retry: We were able to find the answer/respond to users query in the conversation itself so not applying RAG",
                      )
                      stream.writeSSE({ event: ChatSSEvents.Start, data: "" })
                      stream.writeSSE({
                        event: ChatSSEvents.ResponseUpdate,
                        data: parsed.answer,
                      })
                    } else {
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

          tracer.setAttribute(
            answerSpan,
            "has_answer",
            parsed.answer ? true : false,
          )
          if (parsed.answer === null || parsed.answer === "") {
            if (parsed.queryRewrite) {
              tracer.setAttribute(answerSpan, "rewrite", parsed.queryRewrite)
              Logger.info(
                "retry: The query is ambiguous and requires a mandatory query rewrite from the existing conversation / recent messages",
              )
              message = parsed.queryRewrite
            } else {
              tracer.setAttribute(answerSpan, "rewrite", "none")
              Logger.info(
                "retry: There was no need for a query rewrite and there was no answer in the conversation, applying RAG",
              )
            }

            const temporalSpan: Span = tracer.startSpan("temporal", {
              parentSpan: answerSpan,
            })
            const classification: TemporalClassifier & { cost: number } =
              await temporalEventClassification(message, {
                modelId:
                  ragPipelineConfig[RagPipelineStages.QueryRouter].modelId,
                stream: false,
              })
            tracer.setAttribute(
              temporalSpan,
              "classification",
              classification.direction || "null",
            )
            if (classification.cost) costArr.push(classification.cost)
            tracer.endSpan(temporalSpan)

            const understandSpan: Span = tracer.startSpan("understandAnswer", {
              parentSpan: answerSpan,
            })
            const iterator = UnderstandMessageAndAnswer(
              email,
              ctx,
              message,
              classification,
              convWithNoErrMsg,
              understandSpan,
            )
            tracer.endSpan(understandSpan)

            stream.writeSSE({ event: ChatSSEvents.Start, data: "" })
            answer = ""
            thinking = ""
            reasoning = isReasoning
            citations = []
            citationMap = {}

            for await (const chunk of iterator) {
              if (chunk.text) {
                if (chunk.reasoning) {
                  thinking += chunk.text
                  stream.writeSSE({
                    event: ChatSSEvents.Reasoning,
                    data: chunk.text,
                  })
                } else {
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
              }
            }
          } else if (parsed.answer) {
            answer = parsed.answer
          }
          tracer.endSpan(answerSpan)

          if (answer) {
            if (isUserMessage) {
              let msg = await db.transaction(
                async (tx): Promise<SelectMessage> => {
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
                  return msg
                },
              )

              await stream.writeSSE({
                event: ChatSSEvents.ResponseMetadata,
                data: JSON.stringify({
                  chatId: originalMessage.chatExternalId,
                  messageId: msg.externalId,
                }),
              })
            } else {
              await updateMessage(db, messageId, {
                message: processMessage(answer, citationMap),
                updatedAt: new Date(),
                sources: citations,
              })
            }
            await stream.writeSSE({ data: "", event: ChatSSEvents.End })
          } else {
            throw new Error("No answer generated after retry")
          }
        } catch (error) {
          const errFromMap = handleError(error)
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: originalMessage.chatExternalId,
              messageId: originalMessage.externalId,
            }),
          })
          await stream.writeSSE({ event: ChatSSEvents.Error, data: errFromMap })
          await addErrMessageToMessage(originalMessage, errFromMap)
          await stream.writeSSE({ data: "", event: ChatSSEvents.End })
          Logger.error(
            error,
            `Streaming Error: ${(error as Error).message} ${(error as Error).stack}`,
          )
        } finally {
          tracer.endSpan(streamSpan)
        }
      },
      async (err, stream) => {
        const errFromMap = handleError(err)
        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({
            chatId: originalMessage.chatExternalId,
            messageId: originalMessage.externalId,
          }),
        })
        await stream.writeSSE({ event: ChatSSEvents.Error, data: errFromMap })
        await addErrMessageToMessage(originalMessage, errFromMap)
        await stream.writeSSE({ data: "", event: ChatSSEvents.End })
        Logger.error(
          err,
          `Streaming Error: ${err.message} ${(err as Error).stack}`,
        )
      },
    )
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(
      error,
      `Message Retry Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, { message: "Could not retry message" })
  } finally {
    tracer.endSpan(parentSpan)
  }
}
