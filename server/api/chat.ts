import { userContext } from "@/ai/context"
import { Models, userChat } from "@/ai/provider/bedrock"
import config from "@/config"
import {
  getChatByExternalId,
  insertChat,
  updateChatByExternalId,
} from "@/db/chat"
import { db } from "@/db/client"
import { getChatMessages, insertMessage } from "@/db/message"
import {
  selectPublicChatSchema,
  selectPublicMessageSchema,
  selectPublicMessagesSchema,
  type SelectChat,
  type SelectMessage,
} from "@/db/schema"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getLogger } from "@/logger"
import { ChatSSEvents, type MessageReqType } from "@/shared/types"
import { MessageRole, Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import type { ConversationRole } from "@aws-sdk/client-bedrock-runtime"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import type { z } from "zod"
import type { chatSchema } from "@/api/search"
const { JwtPayloadKey } = config
const Logger = getLogger(Subsystem.Chat)

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
    const body = c.req.valid("json")
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(`Chat Rename Error: ${errMsg} ${(error as Error).stack}`)
    throw new HTTPException(500, {
      message: "Could not rename chat",
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

export const MessageApi = async (c: Context) => {
  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub
    // @ts-ignore
    const body = c.req.valid("query")
    let { message, chatId, modelId }: MessageReqType = body
    message = decodeURIComponent(message)
    const { user, workspace } = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    let insertedMsg: SelectMessage
    let chat: SelectChat
    let messages: SelectMessage[] = []
    const costArr = []
    // create chat
    if (!chatId) {
      // let llm decide a title
      const title: string = message.slice(0, 10)

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
      messages.push(insertedMsg)
    } else {
      let [existingChat, allMessages, insertedMsg] = await db.transaction(
        async (tx) => {
          let existingChat = await getChatByExternalId(db, chatId)
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
      messages = allMessages.concat(insertedMsg)
      chat = existingChat
    }

    const ctx = userContext({ user, workspace })
    let fullResponse = ""
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        data: "",
        event: ChatSSEvents.Start,
      })
      Logger.info("Chat stream started")
      await stream.writeSSE({
        event: ChatSSEvents.ResponseMetadata,
        data: JSON.stringify({
          chatId: chat.externalId,
          messageId: messages[messages.length - 1].externalId,
        }),
      })
      const iterator = userChat(ctx, {
        modelId: Models.Llama_3_1_8B,
        userCtx: ctx,
        stream: true,
        json: true,
        messages: messages.map((m) => ({
          role: m.messageRole as ConversationRole,
          content: [{ text: m.message }],
        })),
      })
      for await (const { text, metadata, cost } of iterator) {
        if (text) {
          fullResponse += text
          await stream.writeSSE({
            event: ChatSSEvents.ResponseUpdate,
            data: text,
          })
        }
        if (cost) {
          costArr.push(cost)
        }
      }
      const msg = await insertMessage(db, {
        chatId: messages[messages.length - 1].chatId,
        userId: user.id,
        workspaceExternalId: workspace.externalId,
        chatExternalId: messages[messages.length - 1].chatExternalId,
        messageRole: MessageRole.Assistant,
        email: user.email,
        sources: [],
        message: fullResponse,
        modelId,
      })
      await stream.writeSSE({
        data: "Answer complete",
        event: ChatSSEvents.End,
      })
    })
    Logger.info(`Costs: ${costArr}`)
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
    const body = c.req.valid("json")
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(`Message Retry Error: ${errMsg} ${(error as Error).stack}`)
    throw new HTTPException(500, {
      message: "Could not retry message",
    })
  }
}
