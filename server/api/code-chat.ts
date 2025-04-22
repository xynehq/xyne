import { type Context } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import {
  selectPublicChatSchema,
  selectPublicMessagesSchema,
  type SelectChat,
  type SelectMessage,
} from "@/db/schema"
import { MessageRole, Subsystem } from "@/types"
import { getLogger } from "@/logger"
import { db } from "@/db/client"
import { ChatSSEvents, OpenAIError, type MessageReqType } from "@/shared/types"
import {
  insertChat,
  getChatByExternalId,
  updateChatByExternalId,
} from "@/db/chat"
import { insertMessage, getChatMessages, updateMessage } from "@/db/message"
import { generateApiRouteAnalysisContext, userContext } from "@/ai/context"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import {
  apiRouteAnalysis,
  generateRouteAnswer,
  generateTitleUsingQuery,
} from "@/ai/provider"
import config from "@/config"
import { HTTPException } from "hono/http-exception"
import { apiRouteAnalysisSystemPrompt } from "@/ai/prompts"
import { searchApiDocs, type ApiRouteResult } from "@/search/vespa"
import { Models } from "@/ai/types"

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

// Placeholder for your actual AI/logic functions for code chat

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
const Logger = getLogger(Subsystem.CodeChat)

// --- Export the Zod schema ---
export const codeMessageQuerySchema = z.object({
  chatId: z.string().optional(),
  message: z.string(),
  modelId: z.nativeEnum(Models).optional().default(config.defaultFastModel),
})

type CodeMessageReqType = z.infer<typeof codeMessageQuerySchema>

interface RouteAnalysisResult {
  routeIndex: number
}

/**
 * Generate a streaming response for code chat with API docs enhancement
 */
export async function* generateCodeChatResponseStream(
  userQuery: string,
  email: string,
  userCtx: string,
  modelId: Models = config.defaultBestModel,
): AsyncGenerator<
  { route?: ApiRouteResult; text?: string; cost?: number },
  void,
  unknown
> {
  Logger.info({ userQuery, modelId }, "Generating code chat response...")

  try {
    const apiRoutes = await searchApiDocs(userQuery, email)

    if (apiRoutes.length === 0) {
      yield {
        text: "I couldn't find specific API documentation for your query.",
      }
      return
    }

    const apiCtx = generateApiRouteAnalysisContext(apiRoutes)

    const response = await apiRouteAnalysis(userQuery, userCtx, apiCtx, {
      modelId,
      stream: false,
    })

    if (!response.text) {
      yield {
        text: "I couldn't find specific API documentation for your query.",
      }
    }
    console.log("Route analysis response:", response)
    const analysisResponse: RouteAnalysisResult = JSON.parse(response.text!)

    // try {
    //   analysisResult = JSON.parse(analysisResponse.content)
    // } catch (error) {
    //   Logger.error(
    //     { error, content: analysisResponse.content },
    //     "Failed to parse route analysis",
    //   )
    //   throw new Error("Failed to parse route analysis")
    // }

    const selectedRouteIndex = analysisResponse.routeIndex
    const selectedRoute = apiRoutes[selectedRouteIndex]
    yield {
      route: selectedRoute,
    }

    if (!selectedRoute) {
      throw new Error("Invalid route selected")
    }

    yield {
      text: `*Reference: \`${selectedRoute.method} ${selectedRoute.path}\`*`,
    }
  } catch (error) {
    Logger.error(error, `${userQuery} Error generating code chat response`)
    yield {
      text: "I encountered an error while processing your question. Please try again or rephrase your query.",
    }
  }
}

// --- Helper function (keep as is) ---
const addErrMessageToUserMessage = async (
  userMessage: SelectMessage,
  errorMessage: string,
) => {
  if (userMessage.messageRole === MessageRole.User) {
    await updateMessage(db, userMessage.externalId, { errorMessage })
  }
}

// --- Export the SSE Handler Function ---
export const CodeMessageApi = async (c: Context) => {
  let chat: SelectChat | null = null
  let userMessage: SelectMessage | null = null

  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub

    if (!email || !workspaceId) {
      Logger.warn("Unauthorized attempt to access code chat SSE")
      return c.body(null, 401)
    }

    const validatedData = c.req.valid("query")
    let { chatId, message, modelId }: CodeMessageReqType = validatedData

    message = decodeURIComponent(message)

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const { user, workspace } = userAndWorkspace
    const ctx = userContext(userAndWorkspace)
    let messages: SelectMessage[] = []
    const costArr: number[] = []

    let title = ""
    let isNewChat = false

    if (!chatId) {
      isNewChat = true
      const titleResp = await generateTitleUsingQuery(message, {
        modelId: config.defaultFastModel,
        stream: false,
      })
      title = titleResp.title
      if (titleResp.cost) costArr.push(titleResp.cost)
      ;[chat, userMessage] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage]> => {
          const insertedChat = await insertChat(tx, {
            title,
            workspaceId: workspace.id,
            workspaceExternalId: workspace.externalId,
            userId: user.id,
            email: user.email,
            attachments: [],
          })
          const insertedMsg = await insertMessage(tx, {
            message,
            modelId,
            chatId: insertedChat.id,
            userId: user.id,
            chatExternalId: insertedChat.externalId,
            workspaceExternalId: workspace.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: [],
          })
          return [insertedChat, insertedMsg]
        },
      )
      messages.push(userMessage)
      Logger.info(
        { chatId: chat.externalId, userMessageId: userMessage.externalId },
        "Created new code chat and inserted user message",
      )
    } else {
      ;[chat, messages, userMessage] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage[], SelectMessage]> => {
          const existingChat = await updateChatByExternalId(tx, chatId!, {})
          const existingMessages = await getChatMessages(tx, chatId!)
          const insertedMsg = await insertMessage(tx, {
            message,
            modelId,
            chatId: existingChat.id,
            userId: user.id,
            workspaceExternalId: workspace.externalId,
            chatExternalId: existingChat.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: [],
          })
          return [existingChat, existingMessages, insertedMsg]
        },
      )
      messages.push(userMessage)
      Logger.info(
        { chatId: chat.externalId, userMessageId: userMessage.externalId },
        "Fetched existing code chat and inserted user message",
      )
    }

    return streamSSE(c, async (stream) => {
      let assistantMessage: SelectMessage | null = null
      try {
        Logger.info(
          { chatId: chat!.externalId },
          "SSE stream opened for code chat",
        )

        if (isNewChat && title) {
          await stream.writeSSE({
            data: title,
            event: ChatSSEvents.ChatTitleUpdate,
          })
        }
        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({ chatId: chat!.externalId }),
        })
        await stream.writeSSE({ event: ChatSSEvents.Start, data: "" })

        const historyForAI = messages
          .slice(0, -1)
          .filter((msg) => !msg.errorMessage)
          .map((m) => ({ role: m.messageRole, content: m.message }))
        const responseStream = generateCodeChatResponseStream(
          message,
          email,
          ctx,
          modelId,
        )

        let assistantResponseContent = ""
        let streamCost = 0
        let route: ApiRouteResult | undefined

        for await (const chunk of responseStream) {
          if (chunk.text) {
            assistantResponseContent += chunk.text
            await stream.writeSSE({
              event: ChatSSEvents.ResponseUpdate,
              data: chunk.text,
            })
          }
          if (chunk.route) {
            route = chunk.route
          }
          if (chunk.cost) {
            streamCost += chunk.cost
            costArr.push(chunk.cost)
          }
        }

        console.log("route ", route)
        if (route) {
          const iterator = generateRouteAnswer(
            message,
            ctx,
            generateApiRouteAnalysisContext([route]),
            {
              stream: true,
              modelId,
            },
          )
          for await (const chunk of iterator) {
            if (chunk.text) {
              assistantResponseContent += chunk.text
              await stream.writeSSE({
                event: ChatSSEvents.ResponseUpdate,
                data: chunk.text,
              })
            }
            if (chunk.cost) {
              streamCost += chunk.cost
              costArr.push(chunk.cost)
            }
          }
          Logger.info(
            { chatId: chat!.externalId, streamCost },
            "Finished streaming AI response",
          )
        }
        if (assistantResponseContent) {
          assistantMessage = await insertMessage(db, {
            message: assistantResponseContent,
            modelId,
            chatId: chat!.id,
            userId: user!.id,
            workspaceExternalId: workspace!.externalId,
            chatExternalId: chat!.externalId,
            messageRole: MessageRole.Assistant,
            email: user!.email,
            sources: [],
            thinking: "",
          })
          Logger.info(
            {
              chatId: chat!.externalId,
              assistantMessageId: assistantMessage.externalId,
            },
            "Inserted assistant message",
          )
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chat!.externalId,
              messageId: assistantMessage.externalId,
            }),
          })
        } else {
          Logger.warn(
            { chatId: chat!.externalId },
            "AI stream finished but produced no content.",
          )
          throw new Error("Assistant did not provide a response.")
        }

        await stream.writeSSE({ event: ChatSSEvents.End, data: "Stream ended" })
      } catch (error) {
        const errorMessage = handleError(error)
        Logger.error(
          { error, chatId: chat?.externalId },
          "Error during code chat stream",
        )
        const lastMessageId =
          assistantMessage?.externalId ?? userMessage?.externalId
        if (chat && lastMessageId) {
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chat.externalId,
              messageId: lastMessageId,
            }),
          })
        }
        await stream.writeSSE({ event: ChatSSEvents.Error, data: errorMessage })
        if (userMessage) {
          await addErrMessageToUserMessage(userMessage, errorMessage)
        }
        await stream.writeSSE({
          event: ChatSSEvents.End,
          data: "Stream ended with error",
        })
      } finally {
        Logger.info(
          { chatId: chat?.externalId },
          "SSE stream connection closed for code chat",
        )
      }
    })
  } catch (error) {
    const errorMessage = handleError(error)
    Logger.error(
      { error, chatId: chat?.externalId },
      "Error before starting code chat stream",
    )
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: errorMessage })
  }
}
