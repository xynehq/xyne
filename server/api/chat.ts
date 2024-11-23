import {
  answerContextMap,
  answerMetadataContextMap,
  cleanContext,
  userContext,
} from "@/ai/context"
import { parse, Allow, STR, ARR, OBJ } from "partial-json"
import {
  analyzeInitialResultsOrRewrite,
  analyzeQueryForNamesAndEmails,
  analyzeQueryMetadata,
  askQuestionWithCitations,
  generateTitleUsingQuery,
  jsonParseLLMOutput,
  Models,
  QueryCategory,
  userChat,
  type ResultsOrRewrite,
} from "@/ai/provider/bedrock"
import config from "@/config"
import {
  getChatByExternalId,
  getPublicChats,
  insertChat,
  updateChatByExternalId,
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
  selectPublicMessageSchema,
  selectPublicMessagesSchema,
  type InternalUserWorkspace,
  type PublicUserWorkspace,
  type SelectChat,
  type SelectMessage,
} from "@/db/schema"
import {
  getPublicUserAndWorkspaceByEmail,
  getUserAndWorkspaceByEmail,
} from "@/db/user"
import { getLogger } from "@/logger"
import { ChatSSEvents, type MessageReqType } from "@/shared/types"
import { MessageRole, Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import type { ConversationRole } from "@aws-sdk/client-bedrock-runtime"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import type { chatSchema } from "@/api/search"
import { searchUsersByNamesAndEmails, searchVespa } from "@/search/vespa"
import {
  Apps,
  entitySchema,
  fileSchema,
  MailEntity,
  mailSchema,
  userSchema,
  type VespaFile,
  type VespaMail,
  type VespaSearchResponse,
  type VespaSearchResults,
  type VespaSearchResultsSchema,
  type VespaUser,
} from "@/search/types"
import llama3Tokenizer from "llama3-tokenizer-js"
import { encode } from "gpt-tokenizer"
import { getConnInfo } from "hono/bun"
const { JwtPayloadKey, maxTokenBeforeMetadataCleanup } = config
const Logger = getLogger(Subsystem.Chat)

enum RagPipelineStages {
  NewChatTitle = "NewChatTitle",
  AnswerOrRewrite = "AnswerOrRewrite",
  RewriteAndAnswer = "RewriteAndAnswer",
  UserChat = "UserChat",
  DefaultRetrieval = "DefaultRetrieval",
}
const ragPipeline = [
  { stage: RagPipelineStages.NewChatTitle, modelId: Models.Gpt_4o_mini },
  { stage: RagPipelineStages.AnswerOrRewrite, modelId: Models.Gpt_4o_mini },
  { stage: RagPipelineStages.RewriteAndAnswer, modelId: Models.Gpt_4o_mini },
]

const ragPipelineConfig = {
  [RagPipelineStages.NewChatTitle]: {
    modelId: Models.Gpt_4o_mini,
  },
  [RagPipelineStages.AnswerOrRewrite]: {
    modelId: Models.Gpt_4o_mini,
  },
  [RagPipelineStages.RewriteAndAnswer]: {
    modelId: Models.Gpt_4o_mini,
  },
  [RagPipelineStages.UserChat]: {
    modelId: Models.Gpt_4o_mini,
  },
  [RagPipelineStages.DefaultRetrieval]: {
    modelId: Models.Gpt_4o_mini,
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

const searchToCitation = (
  results: z.infer<typeof VespaSearchResultsSchema>[],
): Citation[] => {
  let citations: Citation[] = []
  if (results.length === 0) {
    return []
  }

  for (const result of results) {
    const fields = result.fields
    if (result.fields.sddocname === userSchema) {
      citations.push({
        title: (fields as VespaUser).name,
        url: `https://contacts.google.com/${(fields as VespaUser).email}`,
        app: fields.app,
        entity: fields.entity,
      })
    } else if (result.fields.sddocname === fileSchema) {
      citations.push({
        title: (fields as VespaFile).title,
        url: (fields as VespaFile).url || "",
        app: fields.app,
        entity: fields.entity,
      })
    } else if (result.fields.sddocname === mailSchema) {
      citations.push({
        title: (fields as VespaMail).subject,
        url: `https://mail.google.com/mail/u/0/#inbox/${fields.docId}`,
        app: fields.app,
        entity: fields.entity,
      })
    } else {
      throw new Error("Invalid search result type for citation")
    }
  }
  return citations
}

// this needs to be evaluated in future
// compared against V2
// export const MessageApiV1 = async (c: Context) => {
//   try {
//     const { sub, workspaceId } = c.get(JwtPayloadKey)
//     const email = sub
//     // @ts-ignore
//     const body = c.req.valid("query")
//     let { message, chatId, modelId }: MessageReqType = body
//     message = decodeURIComponent(message)

//     const [userAndWorkspace, results]: [
//       InternalUserWorkspace,
//       VespaSearchResponse,
//     ] = await Promise.all([
//       getUserAndWorkspaceByEmail(db, workspaceId, email),
//       searchVespa(message, email, null, null, config.answerPage, 0),
//     ])
//     const { user, workspace } = userAndWorkspace
//     let insertedMsg: SelectMessage
//     let chat: SelectChat
//     let messages: SelectMessage[] = []
//     const costArr: number[] = []
//     const ctx = userContext(userAndWorkspace)
//     const initialPrompt = `context about user asking the query\n${ctx}\nuser's query: ${message}`
//     // could be called parallely if not for userAndWorkspace
//     let { result, cost } = await analyzeQueryForNamesAndEmails(initialPrompt, {
//       modelId: Models.Gpt_4o_mini,
//       stream: false,
//       json: true,
//     })
//     if (cost) {
//       costArr.push(cost)
//     }
//     const initialContext = cleanContext(
//       results.root.children
//         .map((v) =>
//           answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>),
//         )
//         .join("\n"),
//     )
//     const tokenLimit = maxTokenBeforeMetadataCleanup
//     let useMetadata = false
//     Logger.info(`User Asked: ${message}`)
//     // if we don't use this, 3.4 seems like a good approx value
//     if (
//       llama3Tokenizer.encode(initialContext).length > tokenLimit ||
//       encode(initialContext).length > tokenLimit
//     ) {
//       useMetadata = true
//     }

//     let users: z.infer<typeof VespaSearchResultsSchema>[] = []
//     if (result.category === QueryCategory.Self) {
//       // here too I can talk about myself and others
//       // eg: when did I send xyz person their offer letter
//       const { mentionedNames, mentionedEmails } = result
//       users = ((
//         await searchUsersByNamesAndEmails(
//           mentionedNames,
//           mentionedEmails,
//           mentionedNames.length + 1 || mentionedEmails.length + 1 || 2,
//         )
//       )?.root?.children ?? []) as z.infer<typeof VespaSearchResultsSchema>[]
//     } else if (
//       result.category === QueryCategory.InternalPerson ||
//       result.category === QueryCategory.ExternalPerson
//     ) {
//       const { mentionedNames, mentionedEmails } = result
//       users = ((
//         await searchUsersByNamesAndEmails(
//           mentionedNames,
//           mentionedEmails,
//           mentionedNames.length + 1 || mentionedEmails.length + 1 || 2,
//         )
//       )?.root?.children ?? []) as z.infer<typeof VespaSearchResultsSchema>[]
//     }

//     let existingUserIds = new Set<string>()
//     if (users.length) {
//       existingUserIds = new Set(
//         results.root.children
//           .filter(
//             (v): v is z.infer<typeof VespaSearchResultsSchema> =>
//               (v.fields as VespaUser).sddocname === userSchema,
//           )
//           .map((v) => v.fields.docId),
//       )
//     }

//     const newUsers = users.filter(
//       (user: z.infer<typeof VespaSearchResultsSchema>) =>
//         !existingUserIds.has(user.fields.docId),
//     )
//     if (newUsers.length) {
//       newUsers.forEach((user) => {
//         results.root.children.push(user)
//       })
//     }
//     const metadataContext = results.root.children
//       .map((v, i) =>
//         cleanContext(
//           `Index ${i} \n ${answerMetadataContextMap(v as z.infer<typeof VespaSearchResultsSchema>)}`,
//         ),
//       )
//       .join("\n\n")

//     const analyseRes = await analyzeQueryMetadata(message, metadataContext, {
//       modelId: Models.Gpt_4o_mini,
//       stream: true,
//       json: true,
//     })
//     let output = analyseRes[0]
//     cost = analyseRes[1]
//     if (cost) {
//       costArr.push(cost)
//     }

//     const finalContext = cleanContext(
//       results.root.children
//         .filter((v, i) => output?.contextualChunks.includes(i))
//         .map((v) =>
//           answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>),
//         )
//         .join("\n"),
//     )
//     // create chat
//     let title = ""
//     let messageExternalId = ""
//     if (!chatId) {
//       // let llm decide a title
//       const titleResp = await generateTitleUsingQuery(message, {
//         modelId: Models.Gpt_4o_mini,
//         stream: false,
//       })
//       title = titleResp.title
//       const cost = titleResp.cost
//       if (cost) {
//         costArr.push(cost)
//       }

//       let [insertedChat, insertedMsg] = await db.transaction(
//         async (tx): Promise<[SelectChat, SelectMessage]> => {
//           const chat = await insertChat(tx, {
//             workspaceId: workspace.id,
//             workspaceExternalId: workspace.externalId,
//             userId: user.id,
//             email: user.email,
//             title,
//             attachments: [],
//           })
//           const insertedMsg = await insertMessage(tx, {
//             chatId: chat.id,
//             userId: user.id,
//             chatExternalId: chat.externalId,
//             workspaceExternalId: workspace.externalId,
//             messageRole: MessageRole.User,
//             email: user.email,
//             sources: [],
//             message,
//             modelId,
//           })
//           return [chat, insertedMsg]
//         },
//       )
//       chat = insertedChat
//       // messages.push(insertedMsg)
//       messageExternalId = insertedMsg.externalId
//     } else {
//       let [existingChat, allMessages, insertedMsg] = await db.transaction(
//         async (tx) => {
//           let existingChat = await getChatByExternalId(db, chatId)
//           let allMessages = await getChatMessages(tx, chatId)
//           let insertedMsg = await insertMessage(tx, {
//             chatId: existingChat.id,
//             userId: user.id,
//             workspaceExternalId: workspace.externalId,
//             chatExternalId: existingChat.externalId,
//             messageRole: MessageRole.User,
//             email: user.email,
//             sources: [],
//             message,
//             modelId,
//           })
//           return [existingChat, allMessages, insertedMsg]
//         },
//       )
//       // messages = allMessages.concat(insertedMsg)
//       chat = existingChat
//       messageExternalId = insertedMsg.externalId
//       messages = allMessages
//     }

//     let fullResponse = ""
//     return streamSSE(c, async (stream) => {
//       await stream.writeSSE({
//         data: "",
//         event: ChatSSEvents.Start,
//       })

//       if (!chatId) {
//         await stream.writeSSE({
//           data: title,
//           event: ChatSSEvents.ChatTitleUpdate,
//         })
//       }
//       Logger.info("Chat stream started")
//       await stream.writeSSE({
//         event: ChatSSEvents.ResponseMetadata,
//         data: JSON.stringify({
//           chatId: chat.externalId,
//           messageId: messageExternalId,
//         }),
//       })

//       const iterator = askQuestionWithCitations(message, ctx, finalContext, {
//         modelId: Models.Gpt_4o_mini,
//         userCtx: ctx,
//         stream: true,
//         json: true,
//         messages: messages.map((m) => ({
//           role: m.messageRole as ConversationRole,
//           content: [{ text: m.message }],
//         })),
//       })
//       let buffer = ""
//       let currentAnswer = ""
//       let currentCitations: number[] = []
//       let parsed

//       for await (const chunk of iterator) {
//         if (chunk.text) {
//           buffer += chunk.text
//           try {
//             parsed = parse(buffer) as CitationResponse

//             // Stream new answer content
//             if (parsed.answer && parsed.answer !== currentAnswer) {
//               const newContent = parsed.answer.slice(currentAnswer.length)
//               currentAnswer = parsed.answer
//               await stream.writeSSE({
//                 event: ChatSSEvents.ResponseUpdate,
//                 data: newContent,
//               })
//             }

//             // Stream citation updates
//             if (parsed.citations) {
//               currentCitations = parsed.citations
//               const minimalContextChunks = searchToCitation(
//                 results.root.children.filter((_, i) =>
//                   currentCitations.includes(i),
//                 ) as z.infer<typeof VespaSearchResultsSchema>[],
//               )

//               // citations count should match the minimalContext chunks

//               await stream.writeSSE({
//                 event: ChatSSEvents.CitationsUpdate,
//                 data: JSON.stringify({
//                   contextChunks: minimalContextChunks,
//                 }),
//               })
//             }
//           } catch (e) {
//             continue
//           }
//         }
//         if (parsed && parsed.answer) {
//           fullResponse = parsed.answer
//         }
//         if (chunk.metadata?.cost) {
//           costArr.push(chunk.metadata.cost)
//         }
//       }
//       const msg = await insertMessage(db, {
//         chatId: chat.id,
//         userId: user.id,
//         workspaceExternalId: workspace.externalId,
//         chatExternalId: chat.externalId,
//         messageRole: MessageRole.Assistant,
//         email: user.email,
//         sources: currentCitations,
//         message: fullResponse,
//         modelId,
//       })
//       await stream.writeSSE({
//         data: "Answer complete",
//         event: ChatSSEvents.End,
//       })
//       Logger.info(`Costs: ${costArr}`)
//     })
//   } catch (error) {
//     const errMsg = getErrorMessage(error)
//     Logger.error(`Message Error: ${errMsg} ${(error as Error).stack}`)
//     throw new HTTPException(500, {
//       message: "Could not create message or Chat",
//     })
//   }
// }

const processMessage = (text: string, citationMap: Record<number, number>) => {
  return text.replace(/\[(\d+)\]/g, (match, num) => {
    return `[${citationMap[num] + 1}]`
  })
}

export const MessageApiV2 = async (c: Context) => {
  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub
    // @ts-ignore
    const body = c.req.valid("query")
    let { message, chatId, modelId }: MessageReqType = body
    message = decodeURIComponent(message)

    const [userAndWorkspace, results] = await Promise.all([
      getUserAndWorkspaceByEmail(db, workspaceId, email),
      searchVespa(message, email, null, null, config.answerPage, 0),
    ])
    const { user, workspace } = userAndWorkspace
    let messages: SelectMessage[] = []
    const costArr: number[] = []
    const ctx = userContext(userAndWorkspace)
    let chat: SelectChat
    const initialContext = cleanContext(
      results.root.children
        .map(
          (v, i) =>
            `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>)}`,
        )
        .join("\n"),
    )

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
        async (tx) => {
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
          const iterator = analyzeInitialResultsOrRewrite(
            message,
            initialContext,
            ctx,
            {
              modelId:
                ragPipelineConfig[RagPipelineStages.AnswerOrRewrite].modelId,
              stream: true,
              json: true,
              messages: messages.map((m) => ({
                role: m.messageRole as ConversationRole,
                content: [{ text: m.message }],
              })),
            },
          )
          // prev response so we can find the diff
          let currentAnswer = ""
          // accumulator
          let buffer = ""
          let currentCitations: number[] = []
          // will contain the streamed partial json
          let parsed: ResultsOrRewrite = {
            answer: "",
            citations: [],
            dateRange: {},
            rewrittenQueries: [],
          }
          for await (const chunk of iterator) {
            try {
              if (chunk.text) {
                buffer += chunk.text
                parsed = jsonParseLLMOutput(buffer) as ResultsOrRewrite
                // answer is there and it is coming
                // we will stream it to the user
                if (parsed.answer && currentAnswer !== parsed.answer) {
                  // first time
                  if (!currentAnswer) {
                    stream.writeSSE({
                      event: ChatSSEvents.Start,
                      data: "",
                    })
                  }
                  stream.writeSSE({
                    event: ChatSSEvents.ResponseUpdate,
                    data: parsed.answer.slice(currentAnswer.length),
                  })
                  currentAnswer = parsed.answer
                }
                if (chunk.metadata?.cost) {
                  costArr.push(chunk.metadata.cost)
                }
              }
            } catch (e) {
              continue
            }
          }
          let minimalContextChunks: Citation[] = []
          const citationMap: Record<number, number> = {}
          // TODO: this is not done yet
          // we need to send all of it
          if (parsed.citations) {
            currentCitations = parsed.citations

            currentCitations.forEach((v, i) => {
              citationMap[v] = i
            })
            minimalContextChunks = searchToCitation(
              results.root.children.filter((_, i) =>
                currentCitations.includes(i),
              ) as z.infer<typeof VespaSearchResultsSchema>[],
            )
            await stream.writeSSE({
              event: ChatSSEvents.CitationsUpdate,
              data: JSON.stringify({
                contextChunks: minimalContextChunks,
                citationMap,
              }),
            })
          }
          if (parsed.answer) {
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
              sources: minimalContextChunks,
              message: processMessage(parsed.answer, citationMap),
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
          } else if (parsed.rewrittenQueries) {
            let finalContext = initialContext
            const allResults = (
              await Promise.all(
                parsed.rewrittenQueries.map((newQuery: string) =>
                  searchVespa(
                    newQuery,
                    email,
                    null,
                    null,
                    5,
                    0,
                    null,
                    results.root.children.map(
                      (v) =>
                        (v as z.infer<typeof VespaSearchResultsSchema>).fields
                          .docId,
                    ),
                  ),
                ),
              )
            )
              .map((v) => v.root.children)
              .flat()
            const idSet = new Set()
            const uniqueResults = []
            for (const res of allResults) {
              if (!idSet.has(res.id)) {
                idSet.add(res.id)
                uniqueResults.push(res)
              }
            }
            finalContext = cleanContext(
              uniqueResults
                .map(
                  (v, i) =>
                    `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>)}`,
                )
                .join("\n"),
            )
            const iterator = askQuestionWithCitations(
              message,
              ctx,
              finalContext,
              {
                modelId:
                  ragPipelineConfig[RagPipelineStages.RewriteAndAnswer].modelId,
                userCtx: ctx,
                stream: true,
                json: true,
                messages: messages.map((m) => ({
                  role: m.messageRole as ConversationRole,
                  content: [{ text: m.message }],
                })),
              },
            )
            let buffer = ""
            let currentAnswer = ""
            let currentCitations: number[] = []

            for await (const chunk of iterator) {
              try {
                if (chunk.text) {
                  buffer += chunk.text
                  parsed = jsonParseLLMOutput(buffer) as ResultsOrRewrite

                  // Stream new answer content
                  if (parsed.answer && parsed.answer !== currentAnswer) {
                    const newContent = parsed.answer.slice(currentAnswer.length)
                    currentAnswer = parsed.answer
                    await stream.writeSSE({
                      event: ChatSSEvents.ResponseUpdate,
                      data: newContent,
                    })
                  }

                  let minimalContextChunks: Citation[] = []
                  const citationMap: Record<number, number> = {}
                  // Stream citation updates
                  if (parsed.citations) {
                    currentCitations = parsed.citations
                    currentCitations.forEach((v, i) => {
                      citationMap[v] = i
                    })
                    minimalContextChunks = searchToCitation(
                      results.root.children.filter((_, i) =>
                        currentCitations.includes(i),
                      ) as z.infer<typeof VespaSearchResultsSchema>[],
                    )

                    // citations count should match the minimalContext chunks
                    await stream.writeSSE({
                      event: ChatSSEvents.CitationsUpdate,
                      data: JSON.stringify({
                        contextChunks: minimalContextChunks,
                        citationMap,
                      }),
                    })
                  }
                }
                if (chunk.metadata?.cost) {
                  costArr.push(chunk.metadata.cost)
                }
              } catch (e) {
                continue
              }
            }
            const msg = await insertMessage(db, {
              chatId: chat.id,
              userId: user.id,
              workspaceExternalId: workspace.externalId,
              chatExternalId: chat.externalId,
              messageRole: MessageRole.Assistant,
              email: user.email,
              sources: minimalContextChunks,
              message: processMessage(parsed.answer!, citationMap),
              modelId:
                ragPipelineConfig[RagPipelineStages.RewriteAndAnswer].modelId,
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
            await stream.writeSSE({
              data: "",
              event: ChatSSEvents.End,
            })
          }
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
    Logger.error(`Message Error: ${errMsg} ${(error as Error).stack}`)
    throw new HTTPException(500, {
      message: "Could not create message or Chat",
    })
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

    // Fetch the chat and previous messages
    // const chat = await getChatByExternalId(db, originalMessage.chatExternalId)
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
          // if we have citations we will have to do search again
          // and then go through the original pipeline
          if (
            originalMessage.sources &&
            (originalMessage.sources as Citation[]).length
          ) {
            const results = await searchVespa(
              prevUserMessage.message,
              email,
              null,
              null,
              config.answerPage,
              0,
            )
            const initialContext = cleanContext(
              results.root.children
                .map((v) =>
                  answerContextMap(
                    v as z.infer<typeof VespaSearchResultsSchema>,
                  ),
                )
                .join("\n"),
            )

            const iterator = analyzeInitialResultsOrRewrite(
              prevUserMessage.message,
              initialContext,
              ctx,
              {
                modelId,
                stream: true,
                json: true,
                messages: conversation.map((m) => ({
                  role: m.messageRole as ConversationRole,
                  content: [{ text: m.message }],
                })),
              },
            )
            // prev response so we can find the diff
            let currentAnswer = ""
            // accumulator
            let buffer = ""
            let currentCitations: number[] = []
            // will contain the streamed partial json
            let parsed: ResultsOrRewrite = {
              answer: "",
              citations: [],
              dateRange: {},
              rewrittenQueries: [],
            }
            for await (const chunk of iterator) {
              try {
                if (chunk.text) {
                  buffer += chunk.text
                  parsed = jsonParseLLMOutput(buffer) as ResultsOrRewrite
                  // answer is there and it is coming
                  // we will stream it to the user
                  if (parsed.answer && currentAnswer !== parsed.answer) {
                    // first time
                    if (!currentAnswer) {
                      stream.writeSSE({
                        event: ChatSSEvents.Start,
                        data: "",
                      })
                    }
                    stream.writeSSE({
                      event: ChatSSEvents.ResponseUpdate,
                      data: parsed.answer.slice(currentAnswer.length),
                    })
                    currentAnswer = parsed.answer
                  }
                  if (chunk.metadata?.cost) {
                    costArr.push(chunk.metadata.cost)
                  }
                }
              } catch (e) {
                continue
              }
            }
            let minimalContextChunks: Citation[] = []
            const citationMap: Record<number, number> = {}
            // TODO: this is not done yet
            // we need to send all of it
            if (parsed.citations) {
              currentCitations = parsed.citations
              currentCitations.forEach((v, i) => {
                citationMap[v] = i
              })
              minimalContextChunks = searchToCitation(
                results.root.children.filter((_, i) =>
                  currentCitations.includes(i),
                ) as z.infer<typeof VespaSearchResultsSchema>[],
              )
              await stream.writeSSE({
                event: ChatSSEvents.CitationsUpdate,
                data: JSON.stringify({
                  contextChunks: minimalContextChunks,
                  citationMap,
                }),
              })
            }
            if (parsed.answer) {
              let newMessageContent = parsed.answer
              // Update the assistant's message with new content and updatedAt
              await updateMessage(db, messageId, {
                message: processMessage(newMessageContent, citationMap),
                updatedAt: new Date(),
                sources: minimalContextChunks,
              })
              await stream.writeSSE({
                data: "",
                event: ChatSSEvents.End,
              })
            } else if (parsed.rewrittenQueries) {
              let finalContext = initialContext
              const allResults = (
                await Promise.all(
                  parsed.rewrittenQueries.map((newQuery: string) =>
                    searchVespa(
                      newQuery,
                      email,
                      null,
                      null,
                      5,
                      0,
                      null,
                      results.root.children.map(
                        (v) =>
                          (v as z.infer<typeof VespaSearchResultsSchema>).fields
                            .docId,
                      ),
                    ),
                  ),
                )
              )
                .map((v) => v.root.children)
                .flat()
              const idSet = new Set()
              const uniqueResults = []
              for (const res of allResults) {
                if (!idSet.has(res.id)) {
                  idSet.add(res.id)
                  uniqueResults.push(res)
                }
              }
              finalContext = cleanContext(
                uniqueResults
                  .map(
                    (v, i) =>
                      `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>)}`,
                  )
                  .join("\n"),
              )
              const iterator = askQuestionWithCitations(
                prevUserMessage.message,
                ctx,
                finalContext,
                {
                  modelId,
                  userCtx: ctx,
                  stream: true,
                  json: true,
                  messages: conversation.map((m) => ({
                    role: m.messageRole as ConversationRole,
                    content: [{ text: m.message }],
                  })),
                },
              )
              let buffer = ""
              let currentAnswer = ""
              let currentCitations: number[] = []

              for await (const chunk of iterator) {
                try {
                  if (chunk.text) {
                    buffer += chunk.text
                    parsed = jsonParseLLMOutput(buffer) as ResultsOrRewrite

                    // Stream new answer content
                    if (parsed.answer && parsed.answer !== currentAnswer) {
                      const newContent = parsed.answer.slice(
                        currentAnswer.length,
                      )
                      currentAnswer = parsed.answer
                      await stream.writeSSE({
                        event: ChatSSEvents.ResponseUpdate,
                        data: newContent,
                      })
                    }
                  }
                  if (chunk.metadata?.cost) {
                    costArr.push(chunk.metadata.cost)
                  }
                } catch (e) {
                  continue
                }
              }
              let minimalContextChunks: Citation[] = []
              const citationMap: Record<number, number> = {}
              // Stream citation updates
              if (parsed.citations) {
                currentCitations = parsed.citations
                currentCitations.forEach((v, i) => {
                  citationMap[v] = i
                })
                minimalContextChunks = searchToCitation(
                  results.root.children.filter((_, i) =>
                    currentCitations.includes(i),
                  ) as z.infer<typeof VespaSearchResultsSchema>[],
                )

                // citations count should match the minimalContext chunks
                await stream.writeSSE({
                  event: ChatSSEvents.CitationsUpdate,
                  data: JSON.stringify({
                    contextChunks: minimalContextChunks,
                    citationMap,
                  }),
                })
              }
              let newMessageContent = parsed.answer
              // Update the assistant's message with new content and updatedAt
              await updateMessage(db, messageId, {
                message: processMessage(newMessageContent!, citationMap),
                updatedAt: new Date(),
                sources: minimalContextChunks,
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
              await stream.writeSSE({
                data: "",
                event: ChatSSEvents.End,
              })
            }
          } else {
            // there were no citations so we will only use the conversation history to answer the user
            const iterator = userChat(prevUserMessage.message, {
              modelId,
              stream: true,
              messages: conversation.map((m) => ({
                role: m.messageRole as ConversationRole,
                content: [{ text: m.message }],
              })),
            })
            stream.writeSSE({
              event: ChatSSEvents.Start,
              data: "",
            })
            let newMessageContent = ""
            for await (const chunk of iterator) {
              if (chunk.text) {
                newMessageContent += chunk.text
                await stream.writeSSE({
                  event: ChatSSEvents.ResponseUpdate,
                  data: chunk.text,
                })
              }
              if (chunk.metadata?.cost) {
                costArr.push(chunk.metadata.cost)
              }
            }
            await updateMessage(db, messageId, {
              message: newMessageContent,
              updatedAt: new Date(),
              sources: [],
            })
            await stream.writeSSE({
              data: "",
              event: ChatSSEvents.End,
            })
          }
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
