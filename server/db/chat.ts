import {
  chats,
  insertChatSchema,
  selectChatSchema,
  selectPublicChatSchema,
  type InsertChat,
  type SelectChat,
  type SelectPublicChat,
} from "./schema"
import { createId } from "@paralleldrive/cuid2"
import type { TxnOrClient } from "@/types"
import { z } from "zod"
import { asc, desc, eq } from "drizzle-orm"

export const insertChat = async (
  trx: TxnOrClient,
  chat: Omit<InsertChat, "externalId">,
): Promise<SelectChat> => {
  const externalId = createId() // Generate unique external ID
  const chatWithExternalId = { ...chat, externalId }
  const chatArr = await trx.insert(chats).values(chatWithExternalId).returning()
  if (!chatArr || !chatArr.length) {
    throw new Error('Error in insert of chat "returning"')
  }
  return selectChatSchema.parse(chatArr[0])
}

export const getWorkspaceChats = async (
  trx: TxnOrClient,
  workspaceId: number,
): Promise<SelectChat[]> => {
  const chatsArr = await trx
    .select()
    .from(chats)
    .where(eq(chats.workspaceId, workspaceId))
    .orderBy(desc(chats.updatedAt))
  return z.array(selectChatSchema).parse(chatsArr)
}

export const getChatById = async (
  trx: TxnOrClient,
  chatId: number,
): Promise<SelectChat> => {
  const chatArr = await trx.select().from(chats).where(eq(chats.id, chatId))
  if (!chatArr || !chatArr.length) {
    throw new Error("Chat not found")
  }
  return selectChatSchema.parse(chatArr[0])
}

export const getChatByExternalId = async (
  trx: TxnOrClient,
  chatId: string,
): Promise<SelectChat> => {
  const chatArr = await trx
    .select()
    .from(chats)
    .where(eq(chats.externalId, chatId))
  if (!chatArr || !chatArr.length) {
    throw new Error("Chat not found")
  }
  return selectChatSchema.parse(chatArr[0])
}

export const updateChatByExternalId = async (
  trx: TxnOrClient,
  chatId: string,
  chat: Partial<InsertChat>,
): Promise<SelectChat> => {
  chat.updatedAt = new Date()
  const chatArr = await trx
    .update(chats)
    .set(chat)
    .where(eq(chats.externalId, chatId))
    .returning()
  if (!chatArr || !chatArr.length) {
    throw new Error("Chat not found")
  }
  return selectChatSchema.parse(chatArr[0])
}

export const getPublicChats = async (
  trx: TxnOrClient,
  email: string,
  pageSize: number,
  offset: number,
): Promise<SelectPublicChat[]> => {
  const chatsArr = await trx
    .select()
    .from(chats)
    .where(eq(chats.email, email))
    .limit(pageSize)
    .offset(offset)
    .orderBy(desc(chats.updatedAt))
  return z.array(selectPublicChatSchema).parse(chatsArr)
}
