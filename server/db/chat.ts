import {
  chats,
  insertChatSchema,
  messages,
  selectChatSchema,
  selectMessageSchema,
  selectPublicChatSchema,
  type InsertChat,
  type InsertMessage,
  type SelectChat,
  type SelectMessage,
  type SelectPublicChat,
} from "@/db/schema"
import { createId } from "@paralleldrive/cuid2"
import type { TxnOrClient } from "@/types"
import { z } from "zod"
import { and, asc, desc, eq, gte, lte } from "drizzle-orm"

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

export const getChatByExternalIdWithAuth = async (
  trx: TxnOrClient,
  chatId: string,
  userEmail: string,
): Promise<SelectChat> => {
  const chatArr = await trx
    .select()
    .from(chats)
    .where(and(eq(chats.externalId, chatId), eq(chats.email, userEmail)))
  if (!chatArr || !chatArr.length) {
    throw new Error("Chat not found or access denied")
  }
  return selectChatSchema.parse(chatArr[0])
}

export const updateChatByExternalIdWithAuth = async (
  trx: TxnOrClient,
  chatId: string,
  userEmail: string,
  chat: Partial<InsertChat>,
): Promise<SelectChat> => {
  chat.updatedAt = new Date()
  const chatArr = await trx
    .update(chats)
    .set(chat)
    .where(and(eq(chats.externalId, chatId), eq(chats.email, userEmail)))
    .returning()
  if (!chatArr || !chatArr.length) {
    throw new Error("Chat not found or access denied")
  }
  return selectChatSchema.parse(chatArr[0])
}

export const updateChatBookmarkStatus = async (
  trx: TxnOrClient,
  chatId: string,
  isBookmarked: boolean,
): Promise<SelectChat> => {
  const chatArr = await trx
    .update(chats)
    .set({ isBookmarked })
    .where(eq(chats.externalId, chatId))
    .returning()
  if (!chatArr || !chatArr.length) {
    throw new Error("Chat not found")
  }
  return selectChatSchema.parse(chatArr[0])
}

export const deleteChatByExternalIdWithAuth = async (
  trx: TxnOrClient,
  chatId: string,
  userEmail: string,
): Promise<SelectChat> => {
  const chatArr = await trx
    .delete(chats)
    .where(and(eq(chats.externalId, chatId), eq(chats.email, userEmail)))
    .returning()
  if (!chatArr || !chatArr.length) {
    throw new Error("Chat not found or access denied")
  }
  return selectChatSchema.parse(chatArr[0])
}

export const deleteMessagesByChatId = async (
  trx: TxnOrClient,
  chatId: string,
): Promise<SelectMessage> => {
  const msgArr = await trx
    .delete(messages)
    .where(eq(messages.chatExternalId, chatId))
    .returning()
  if (!msgArr || !msgArr.length) {
    throw new Error("Messages not found")
  }
  return selectMessageSchema.parse(msgArr[0])
}

export const updateMessageByExternalId = async (
  trx: TxnOrClient,
  msgId: string,
  message: Partial<InsertMessage>,
): Promise<SelectMessage> => {
  message.updatedAt = new Date()
  const msgArr = await trx
    .update(messages)
    .set(message)
    .where(eq(messages.externalId, msgId))
    .returning()
  if (!msgArr || !msgArr.length) {
    throw new Error("Message not found")
  }
  return selectMessageSchema.parse(msgArr[0])
}

export const getPublicChats = async (
  trx: TxnOrClient,
  email: string,
  pageSize: number,
  offset: number,
  timeRange?: { from?: Date; to?: Date },
): Promise<SelectPublicChat[]> => {
  const conditions = [eq(chats.email, email), eq(chats.isBookmarked, false)]

  if (timeRange?.from) {
    conditions.push(gte(chats.createdAt, timeRange.from))
  }
  if (timeRange?.to) {
    conditions.push(lte(chats.createdAt, timeRange.to))
  }

  const chatsArr = await trx
    .select()
    .from(chats)
    .where(and(...conditions))
    .limit(pageSize)
    .offset(offset)
    .orderBy(desc(chats.updatedAt))
  return z.array(selectPublicChatSchema).parse(chatsArr)
}

export const getFavoriteChats = async (
  trx: TxnOrClient,
  email: string,
  pageSize: number,
  offset: number,
): Promise<SelectPublicChat[]> => {
  const chatsArr = await trx
    .select()
    .from(chats)
    .where(and(eq(chats.email, email), eq(chats.isBookmarked, true)))
    .limit(pageSize)
    .offset(offset)
    .orderBy(desc(chats.updatedAt))
  return z.array(selectPublicChatSchema).parse(chatsArr)
}

export const getAllChatsForDashboard = async (
  trx: TxnOrClient,
  email: string,
  timeRange?: { from?: Date; to?: Date },
): Promise<SelectPublicChat[]> => {
  const conditions = [eq(chats.email, email)]

  if (timeRange?.from) {
    conditions.push(gte(chats.createdAt, timeRange.from))
  }
  if (timeRange?.to) {
    conditions.push(lte(chats.createdAt, timeRange.to))
  }

  const chatsArr = await trx
    .select()
    .from(chats)
    .where(and(...conditions))
    .orderBy(desc(chats.createdAt))
  return z.array(selectPublicChatSchema).parse(chatsArr)
}
