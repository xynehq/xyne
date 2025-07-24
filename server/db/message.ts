import { createId } from "@paralleldrive/cuid2"
import {
  messages,
  selectMessageSchema,
  type InsertMessage,
  type SelectMessage,
} from "@/db/schema"
import { MessageRole, type TxnOrClient } from "@/types"
import { and, asc, eq, lt, count, inArray, sql } from "drizzle-orm"
import { z } from "zod"

export const insertMessage = async (
  trx: TxnOrClient,
  message: Omit<InsertMessage, "externalId">,
): Promise<SelectMessage> => {
  const messageWithExternalId = {
    ...message,
    externalId: createId(),
  }
  const messageArr = await trx
    .insert(messages)
    .values(messageWithExternalId)
    .returning()
  if (!messageArr || !messageArr.length) {
    throw new Error('Error in insert of message "returning"')
  }
  const parsedData = selectMessageSchema.safeParse(messageArr[0])
  if (!parsedData.success) {
    throw new Error(
      `Could not get message after inserting: ${parsedData.error.toString()}`,
    )
  }
  return parsedData.data
}

export const getChatMessagesWithAuth = async (
  trx: TxnOrClient,
  chatId: string,
  email: string,
): Promise<SelectMessage[]> => {
  const messagesArr = await trx
    .select()
    .from(messages)
    .where(and(eq(messages.chatExternalId, chatId), eq(messages.email, email)))
    .orderBy(asc(messages.createdAt))
  return z.array(selectMessageSchema).parse(messagesArr)
}

export const getChatMessagesBefore = async (
  trx: TxnOrClient,
  chatId: number,
  createdAt: Date,
): Promise<SelectMessage[]> => {
  const messagesArr = await trx
    .select()
    .from(messages)
    .where(and(lt(messages.createdAt, createdAt), eq(messages.chatId, chatId)))
    .orderBy(asc(messages.createdAt))
  return z.array(selectMessageSchema).parse(messagesArr)
}

export const getMessageByExternalId = async (
  trx: TxnOrClient,
  messageId: string,
): Promise<SelectMessage> => {
  const messageArr = await trx
    .select()
    .from(messages)
    .where(eq(messages.externalId, messageId))
  if (!messageArr || !messageArr.length) {
    throw new Error("Chat not found")
  }
  return selectMessageSchema.parse(messageArr[0])
}

export const updateMessage = async (
  trx: TxnOrClient,
  messageId: string,
  updatedFields: Partial<InsertMessage>,
): Promise<void> => {
  await trx
    .update(messages)
    .set(updatedFields)
    .where(and(eq(messages.externalId, messageId)))
}

export async function getAllMessages({
  db,
  externalChatId,
}: {
  db: TxnOrClient
  externalChatId: string
}): Promise<SelectMessage[]> {
  const result = await db
    .select()
    .from(messages)
    .where(eq(messages.chatExternalId, externalChatId))
    .orderBy(asc(messages.createdAt))

  return selectMessageSchema.array().parse(result)
}

export async function getMessageCountsByChats({
  db,
  chatExternalIds,
  email,
  workspaceExternalId,
}: {
  db: TxnOrClient
  chatExternalIds: string[]
  email: string
  workspaceExternalId: string
}): Promise<Record<string, number>> {
  if (chatExternalIds.length === 0) {
    return {}
  }

  const result = await db
    .select({
      chatExternalId: messages.chatExternalId,
      messageCount: count(messages.externalId),
    })
    .from(messages)
    .where(
      and(
        inArray(messages.chatExternalId, chatExternalIds),
        eq(messages.email, email),
        eq(messages.workspaceExternalId, workspaceExternalId),
      ),
    )
    .groupBy(messages.chatExternalId)

  return result.reduce(
    (acc, row) => {
      acc[row.chatExternalId] = row.messageCount
      return acc
    },
    {} as Record<string, number>,
  )
}

export async function getMessageFeedbackStats({
  db,
  chatExternalIds,
  email,
  workspaceExternalId,
}: {
  db: TxnOrClient
  chatExternalIds: string[]
  email: string
  workspaceExternalId: string
}): Promise<{
  totalLikes: number
  totalDislikes: number
  feedbackByChat: Record<string, { likes: number; dislikes: number }>
}> {
  if (chatExternalIds.length === 0) {
    return {
      totalLikes: 0,
      totalDislikes: 0,
      feedbackByChat: {},
    }
  }

  const result = await db
    .select({
      chatExternalId: messages.chatExternalId,
      likes: sql<number>`SUM(CASE WHEN ${messages.feedback} = 'like' THEN 1 ELSE 0 END)::int`,
      dislikes: sql<number>`SUM(CASE WHEN ${messages.feedback} = 'dislike' THEN 1 ELSE 0 END)::int`,
    })
    .from(messages)
    .where(
      and(
        inArray(messages.chatExternalId, chatExternalIds),
        eq(messages.email, email),
        eq(messages.workspaceExternalId, workspaceExternalId),
        inArray(messages.feedback, ["like", "dislike"]),
      ),
    )
    .groupBy(messages.chatExternalId)

  let totalLikes = 0
  let totalDislikes = 0
  const feedbackByChat: Record<string, { likes: number; dislikes: number }> = {}

  // Initialize all chats with zero feedback
  chatExternalIds.forEach((chatId) => {
    feedbackByChat[chatId] = { likes: 0, dislikes: 0 }
  })

  // Populate with actual feedback counts
  result.forEach((row) => {
    feedbackByChat[row.chatExternalId].likes = row.likes
    feedbackByChat[row.chatExternalId].dislikes = row.dislikes
    totalLikes += row.likes
    totalDislikes += row.dislikes
  })

  return {
    totalLikes,
    totalDislikes,
    feedbackByChat,
  }
}
