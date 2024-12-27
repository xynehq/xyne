import { answerContextMap, cleanContext, userContext } from "@/ai/context"
import {
  baselineRAGJsonStream,
  generateTitleUsingQuery,
  jsonParseLLMOutput,
  Models,
  queryRewriter,
  temporalEventClassification,
  type ConverseResponse,
  type TemporalClassifier,
} from "@/ai/provider/bedrock"
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
import { ChatSSEvents, type MessageReqType } from "@/shared/types"
import { MessageRole, Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import type { ConversationRole, Message } from "@aws-sdk/client-bedrock-runtime"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import type { chatSchema } from "@/api/search"
import { searchVespa } from "@/search/vespa"
import {
  Apps,
  entitySchema,
  eventSchema,
  fileSchema,
  mailSchema,
  userSchema,
  type VespaEvent,
  type VespaEventSearch,
  type VespaFile,
  type VespaMail,
  type VespaMailSearch,
  type VespaSearchResponse,
  type VespaSearchResult,
  type VespaSearchResults,
  type VespaSearchResultsSchema,
  type VespaUser,
} from "@/search/types"
import { APIError } from "openai"
const { JwtPayloadKey } = config
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

const defaultFastModel = Models.Claude_3_5_Haiku
const defaultBestModel = Models.Claude_3_5_SonnetV2

const ragPipelineConfig = {
  [RagPipelineStages.QueryRouter]: {
    modelId: defaultFastModel,
  },
  [RagPipelineStages.AnswerOrSearch]: {
    modelId: defaultBestModel,
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
    Logger.error(`Chat Rename Error: ${errMsg} ${(error as Error).stack}`)
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
    Logger.error(`Chat Delete Error: ${errMsg} ${(error as Error).stack}`)
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
    const pageSize = 20
    const offset = page * pageSize
    return c.json(await getPublicChats(db, email, pageSize, offset))
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(`Chat History Error: ${errMsg} ${(error as Error).stack}`)
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
    Logger.error(`Chat Bookmark Error: ${errMsg} ${(error as Error).stack}`)
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

const processMessage = (text: string, citationMap: Record<number, number>) => {
  return text.replace(/\[(\d+)\]/g, (match, num) => {
    return `[${citationMap[num] + 1}]`
  })
}

async function* generateIterativeTimeFilterAndQueryRewrite(
  input: string,
  email: string,
  userCtx: string,
  alpha: number = 0.5,
  pageSize: number = 10,
  maxPageNumber: number = 3,
  maxSummaryCount: number | undefined,
): AsyncIterableIterator<
  ConverseResponse & { citation?: { index: number; item: any } }
> {
  // we are not going to do time expansion
  // we are going to do 4 months answer
  // if not found we go back to iterative page search
  const message = input

  const monthInMs = 30 * 24 * 60 * 60 * 1000
  const latestResults = (
    await searchVespa(message, email, null, null, pageSize, 0, alpha, {
      from: new Date().getTime() - 4 * monthInMs,
      to: new Date().getTime(),
    })
  ).root.children

  const latestIds = latestResults
    ?.map((v: VespaSearchResult) => (v?.fields as any).docId)
    ?.filter((v) => !!v)

  for (var pageNumber = 0; pageNumber < maxPageNumber; pageNumber++) {
    // should only do it once
    if (pageNumber === Math.floor(maxPageNumber / 2)) {
      // get the first page of results
      let results = await searchVespa(
        message,
        email,
        null,
        null,
        pageSize,
        0,
        alpha,
      )
      const initialContext = cleanContext(
        results?.root?.children
          ?.map(
            (v, i) =>
              `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, maxSummaryCount)}`,
          )
          .join("\n"),
      )
      const queryResp = await queryRewriter(input, userCtx, initialContext, {
        modelId: defaultBestModel,
        stream: false,
      })
      const queries = queryResp.queries
      for (const query of queries) {
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
        const totalResults = results?.root?.children?.concat(latestResults)
        const initialContext = cleanContext(
          totalResults
            ?.map(
              (v, i) =>
                `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, maxSummaryCount)}`,
            )
            ?.join("\n"),
        )

        const iterator = baselineRAGJsonStream(query, userCtx, initialContext, {
          stream: true,
          modelId: defaultBestModel,
        })
        let buffer = ""
        let currentAnswer = ""
        let parsed = { answer: "" }
        const citationRegex = /\[(\d+)\]/g
        let yieldedCitations = new Set<number>()
        for await (const chunk of iterator) {
          if (chunk.text) {
            buffer += chunk.text
            try {
              parsed = jsonParseLLMOutput(buffer)
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
                let match
                while ((match = citationRegex.exec(parsed.answer)) !== null) {
                  const citationIndex = parseInt(match[1], 10)
                  if (!yieldedCitations.has(citationIndex)) {
                    const item = totalResults[citationIndex]
                    if (item) {
                      yield {
                        citation: {
                          index: citationIndex,
                          item: searchToCitation(item as VespaSearchResults),
                        },
                      }
                      yieldedCitations.add(citationIndex)
                    } else {
                      // TODO: we need to handle this.
                      // either we replace the [citationIndex]
                      Logger.error(
                        "Found a citation index but could not find it in the search result ",
                        citationIndex,
                        totalResults.length,
                      )
                    }
                  }
                }
                currentAnswer = parsed.answer
              }
            } catch (err) {
              const errMessage = (err as Error).message
              Logger.error(`Error while parsing LLM output ${errMessage}`)
              continue
            }
          }
          if (chunk.cost) {
            yield { cost: chunk.cost }
          }
        }
        if (parsed.answer) {
          return
        }
      }
    }

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
      results.root.children = results?.root?.children?.concat(latestResults)
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
    }
    const initialContext = cleanContext(
      results?.root?.children
        ?.map(
          (v, i) =>
            `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, maxSummaryCount)}`,
        )
        ?.join("\n"),
    )

    const iterator = baselineRAGJsonStream(input, userCtx, initialContext, {
      stream: true,
      modelId: defaultBestModel,
    })

    let buffer = ""
    let currentAnswer = ""
    let parsed = { answer: "" }
    const citationRegex = /\[(\d+)\]/g
    let yieldedCitations = new Set<number>()
    for await (const chunk of iterator) {
      if (chunk.text) {
        buffer += chunk.text
        try {
          parsed = jsonParseLLMOutput(buffer)
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
            let match
            while ((match = citationRegex.exec(parsed.answer)) !== null) {
              const citationIndex = parseInt(match[1], 10)
              if (!yieldedCitations.has(citationIndex)) {
                const item = results.root.children[citationIndex]
                if (item) {
                  yield {
                    citation: {
                      index: citationIndex,
                      item: searchToCitation(item as VespaSearchResults),
                    },
                  }
                  yieldedCitations.add(citationIndex)
                } else {
                  // TODO: we need to handle this.
                  // either we replace the [citationIndex]
                  Logger.error(
                    "Found a citation index but could not find it in the search result ",
                    citationIndex,
                    results.root.children.length,
                  )
                }
              }
            }
            currentAnswer = parsed.answer
          }
        } catch (err) {
          const errMessage = (err as Error).message
          Logger.error(`Error while parsing LLM output ${errMessage}`)
          continue
        }
      }
      if (chunk.cost) {
        yield { cost: chunk.cost }
      }
    }
    if (parsed.answer) {
      return
    }
  }
  yield {
    text: "I could not find any information to answer it, please change your query",
  }
}

async function* generatePointQueryTimeExpansion(
  input: string,
  classification: TemporalClassifier & { cost: number },
  email: string,
  userCtx: string,
  alpha: number,
  pageSize: number = 10,
  maxSummaryCount: number | undefined,
): AsyncIterableIterator<
  ConverseResponse & { citation?: { index: number; item: any } }
> {
  const message = input
  const maxIterations = 10
  const weekInMs = 12 * 24 * 60 * 60 * 1000
  const direction = classification.direction
  let costArr: number[] = [classification.cost]

  let from = new Date().getTime()
  let to = new Date().getTime()
  let lastSearchedTime = direction === "prev" ? from : to

  for (let iteration = 0; iteration < maxIterations; iteration++) {
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

    // Search in both calendar events and emails
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

    if (!results.root.children && !eventResults.root.children) {
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

    if (!combinedResults.root.children.length) {
      Logger.info("No gmail or calendar events found")
      continue
    }

    // Prepare context for LLM
    const initialContext = cleanContext(
      combinedResults.root.children
        .map(
          (v, i) =>
            `Index ${i}: \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, maxSummaryCount)}`,
        )
        .join("\n"),
    )

    // Stream LLM response
    const iterator = baselineRAGJsonStream(input, userCtx, initialContext, {
      stream: true,
      modelId: defaultBestModel,
    })

    let buffer = ""
    let currentAnswer = ""
    let parsed = { answer: "" }
    const citationRegex = /\[(\d+)\]/g
    let yieldedCitations = new Set<number>()

    for await (const chunk of iterator) {
      if (chunk.text) {
        buffer += chunk.text
        try {
          parsed = jsonParseLLMOutput(buffer)
          // If we have a null answer, break this inner loop and continue outer loop
          if (parsed.answer === null) {
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
            let match
            while ((match = citationRegex.exec(parsed.answer)) !== null) {
              const citationIndex = parseInt(match[1], 10)
              if (!yieldedCitations.has(citationIndex)) {
                const item = combinedResults.root.children[citationIndex]
                if (item) {
                  yield {
                    citation: {
                      index: citationIndex,
                      item: searchToCitation(item as VespaSearchResults),
                    },
                  }
                  yieldedCitations.add(citationIndex)
                }
              }
            }
            currentAnswer = parsed.answer
          }
        } catch (e) {
          // If we can't parse the JSON yet, continue accumulating
          continue
        }
      }

      if (chunk.cost) {
        costArr.push(chunk.cost)
        yield { cost: chunk.cost }
      }
    }
    if (parsed.answer) {
      return
    }
  }

  // If we've exhausted all iterations without finding an answer
  yield {
    text: "I could not find any information to answer it, please change your query",
    cost: costArr.reduce((a, b) => a + b, 0),
  }
}

export async function* UnderstandMessageAndAnswer(
  email: string,
  userCtx: string,
  message: string,
  classification: TemporalClassifier & { cost: number },
  messages?: Message[],
): AsyncIterableIterator<
  ConverseResponse & { citation?: { index: number; item: any } }
> {
  // user is talking about an event
  if (classification.direction !== null) {
    return yield* generatePointQueryTimeExpansion(
      message,
      classification,
      email,
      userCtx,
      0.5,
      20,
      3,
    )
  } else {
    // default case
    return yield* generateIterativeTimeFilterAndQueryRewrite(
      message,
      email,
      userCtx,
      0.5,
      20,
      3,
      5,
    )
  }
}

const handleError = (error: any) => {
  let errorMessage = ""
  switch (error) {
    default:
      errorMessage = "Something went wrong. Please try again."
      break
  }
  return errorMessage
}

const AddErrMessageToMessage = async (
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
  let stream: any
  let chat: SelectChat
  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub
    // @ts-ignore
    const body = c.req.valid("query")
    let { message, chatId, modelId }: MessageReqType = body
    if (!message) {
      throw new HTTPException(400, {
        message: "Message is required",
      })
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
    const ctx = userContext(userAndWorkspace)
    let chat: SelectChat

    let title = ""
    if (!chatId) {
      // let llm decide a title
      const titleResp = await generateTitleUsingQuery(message, {
        modelId: ragPipelineConfig[RagPipelineStages.NewChatTitle].modelId,
        stream: false,
      })
      title = titleResp.title
      const cost = titleResp.cost
      if (cost) {
        costArr.push(cost)
      }

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
      chat = insertedChat
      messages.push(insertedMsg) // Add the inserted message to messages array
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
      messages = allMessages.concat(insertedMsg) // Update messages array
      chat = existingChat
    }

    return streamSSE(
      c,
      async (stream) => {
        try {
          if (!chatId) {
            await stream.writeSSE({
              data: title,
              event: ChatSSEvents.ChatTitleUpdate,
            })
          }

          Logger.info("Chat stream started")
          // we do not set the message Id as we don't have it
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chat.externalId,
            }),
          })

          const classification: TemporalClassifier & { cost: number } =
            await temporalEventClassification(message, {
              modelId: ragPipelineConfig[RagPipelineStages.QueryRouter].modelId,
              stream: false,
            })
          // Only send those messages here which don't have error responses
          const messagesWithNoErrResponse = messages
            .filter((msg) => !msg?.errorMessage)
            .map((m) => ({
              role: m.messageRole as ConversationRole,
              content: [{ text: m.message }],
            }))
          const iterator = UnderstandMessageAndAnswer(
            email,
            ctx,
            message,
            classification,
            messagesWithNoErrResponse,
          )

          stream.writeSSE({
            event: ChatSSEvents.Start,
            data: "",
          })
          let answer = ""
          let citations = []
          let citationMap: Record<number, number> = {}
          for await (const chunk of iterator) {
            if (chunk.text) {
              answer += chunk.text
              stream.writeSSE({
                event: ChatSSEvents.ResponseUpdate,
                data: chunk.text,
              })
            }

            if (chunk.cost) {
              costArr.push(chunk.cost)
            }
            if (chunk.citation) {
              const { index, item } = chunk.citation
              citations.push(item)
              citationMap[index] = citations.length - 1
              stream.writeSSE({
                event: ChatSSEvents.CitationsUpdate,
                data: JSON.stringify({
                  contextChunks: citations,
                  citationMap,
                }),
              })
            }
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
              modelId:
                ragPipelineConfig[RagPipelineStages.AnswerOrRewrite].modelId,
            })
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
            await stream.writeSSE({
              event: ChatSSEvents.Error,
              data: "Error while trying to answer",
            })
            // Add the error message to last user message
            const allMessages = await getChatMessages(db, chat?.externalId)
            const lastMessage = allMessages[allMessages.length - 1]
            await AddErrMessageToMessage(
              lastMessage,
              "Error while trying to answer",
            )

            await stream.writeSSE({
              data: "",
              event: ChatSSEvents.End,
            })
          }
        } catch (error) {
          const errFomMap = handleError(error)
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: errFomMap,
          })

          // Add the error message to last user message
          const allMessages = await getChatMessages(db, chat?.externalId)
          const lastMessage = allMessages[allMessages.length - 1]
          await AddErrMessageToMessage(lastMessage, errFomMap)

          await stream.writeSSE({
            data: "",
            event: ChatSSEvents.End,
          })
          Logger.error(
            `Streaming Error: ${(error as Error).message} ${(error as Error).stack}`,
          )
        }
      },
      async (err, stream) => {
        const errFromMap = handleError(err)
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: errFromMap,
        })
        // Add the error message to last user message
        const allMessages = await getChatMessages(db, chat?.externalId)
        const lastMessage = allMessages[allMessages.length - 1]
        await AddErrMessageToMessage(lastMessage, errFromMap)

        await stream.writeSSE({
          data: "",
          event: ChatSSEvents.End,
        })
        Logger.error(`Streaming Error: ${err.message} ${(err as Error).stack}`)
      },
    )
  } catch (error) {
    const errMsg = getErrorMessage(error)
    // TODO: add more errors like bedrock, this is only openai
    const errFromMap = handleError(error)
    // @ts-ignore
    if (chat?.externalId) {
      const allMessages = await getChatMessages(db, chat?.externalId)
      // Add the error message to last user message
      const lastMessage = allMessages[allMessages.length - 1]
      await AddErrMessageToMessage(lastMessage, errFromMap)
    }
    if (error instanceof APIError) {
      // quota error
      if (error.status === 429) {
        Logger.error("You exceeded your current quota")
        if (stream) {
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: errFromMap,
          })
        }
      }
    } else {
      Logger.error(`Message Error: ${errMsg} ${(error as Error).stack}`)
      throw new HTTPException(500, {
        message: "Could not create message or Chat",
      })
    }
  }
}

export const MessageRetryApi = async (c: Context) => {
  try {
    // @ts-ignore
    const body = c.req.valid("query")
    const { messageId } = body

    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub

    const costArr: number[] = []
    // Fetch the original message
    const originalMessage = await getMessageByExternalId(db, messageId)
    if (!originalMessage) {
      throw new HTTPException(404, { message: "Message not found" })
    }

    let conversation = await getChatMessagesBefore(
      db,
      originalMessage.chatId,
      originalMessage.createdAt,
    )
    if (!conversation || !conversation.length) {
      throw new HTTPException(400, {
        message: "Could not fetch previous messages",
      })
    }

    // Use the same modelId
    const modelId = originalMessage.modelId as Models

    // Get user and workspace
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const ctx = userContext(userAndWorkspace)

    let newCitations: Citation[] = []
    // the last message before our assistant's message was the user's message
    const prevUserMessage = conversation[conversation.length - 1]
    // we are trying to retry the first assistant's message
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
        try {
          const message = prevUserMessage.message
          const classification: TemporalClassifier & { cost: number } =
            await temporalEventClassification(message, {
              modelId: ragPipelineConfig[RagPipelineStages.QueryRouter].modelId,
              stream: false,
            })
          const iterator = UnderstandMessageAndAnswer(
            email,
            ctx,
            message,
            classification,
            conversation.map((m) => ({
              role: m.messageRole as ConversationRole,
              content: [{ text: m.message }],
            })),
          )

          stream.writeSSE({
            event: ChatSSEvents.Start,
            data: "",
          })
          let answer = ""
          let citations = []
          let citationMap: Record<number, number> = {}
          for await (const chunk of iterator) {
            if (chunk.text) {
              answer += chunk.text
              stream.writeSSE({
                event: ChatSSEvents.ResponseUpdate,
                data: chunk.text,
              })
            }

            if (chunk.cost) {
              costArr.push(chunk.cost)
            }
            if (chunk.citation) {
              const { index, item } = chunk.citation
              citations.push(item)
              citationMap[index] = citations.length - 1
              stream.writeSSE({
                event: ChatSSEvents.CitationsUpdate,
                data: JSON.stringify({
                  contextChunks: citations,
                  citationMap,
                }),
              })
            }
          }

          await updateMessage(db, messageId, {
            message: processMessage(answer, citationMap),
            updatedAt: new Date(),
            sources: citations,
          })
          await stream.writeSSE({
            data: "",
            event: ChatSSEvents.End,
          })
        } catch (error) {
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: (error as Error).message,
          })
          await stream.writeSSE({
            data: "",
            event: ChatSSEvents.End,
          })
          Logger.error(
            `Streaming Error: ${(error as Error).message} ${(error as Error).stack}`,
          )
        }
      },
      async (err, stream) => {
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: err.message,
        })
        await stream.writeSSE({
          data: "",
          event: ChatSSEvents.End,
        })
        Logger.error(`Streaming Error: ${err.message} ${(err as Error).stack}`)
      },
    )
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(`Message Retry Error: ${errMsg} ${(error as Error).stack}`)
    throw new HTTPException(500, {
      message: "Could not retry message",
    })
  }
}
