import { createId } from "@paralleldrive/cuid2"
import {
  chats,
  messages,
  selectChatSchema,
  selectMessageSchema,
  type InsertMessage,
  type SelectChat,
  type SelectMessage,
} from "./schema"
import type { TxnOrClient } from "@/types"
import { asc, desc, eq } from "drizzle-orm"
import { z } from "zod"

export const insertMessage = async (
  trx: TxnOrClient,
  message: Omit<InsertMessage, "externalId" | "chatExternalId">,
): Promise<SelectMessage> => {
  const messageWithExternalId = {
    ...message,
    externalId: createId(),
    chatExternalId: createId(),
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

export const getChatMessages = async (
  trx: TxnOrClient,
  chatId: string,
): Promise<SelectMessage[]> => {
  const messagesArr = await trx
    .select()
    .from(messages)
    .where(eq(messages.chatExternalId, chatId))
    .orderBy(asc(messages.createdAt))
  return z.array(selectMessageSchema).parse(messagesArr)
}

export const getChatById = async (
  trx: TxnOrClient,
  chatId: number,
): Promise<SelectChat> => {
  const chatArr = await trx.select().from(chats).where(eq(messages.id, chatId))
  if (!chatArr || !chatArr.length) {
    throw new Error("Chat not found")
  }
  return selectChatSchema.parse(chatArr[0])
}

export const getChatByExternalId = async (
  trx: TxnOrClient,
  chatId: string,
): Promise<SelectChat> => {
  const chatArr = await trx.select().from(chats).where(eq(chats.externalId, chatId))
  if (!chatArr || !chatArr.length) {
    throw new Error("Chat not found")
  }
  return selectChatSchema.parse(chatArr[0])
}
