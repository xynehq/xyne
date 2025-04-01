import {
  chats,
  insertChatSchema,
  messages,
  selectChatSchema,
  selectMessageSchema,
  selectPublicChatSchema,
} from "./schema.js"
import { createId } from "@paralleldrive/cuid2";
import { z } from "zod";
import { asc, desc, eq } from "drizzle-orm";
export const insertChat = async (trx, chat) => {
    const externalId = createId(); // Generate unique external ID
    const chatWithExternalId = { ...chat, externalId };
    const chatArr = await trx.insert(chats).values(chatWithExternalId).returning();
    if (!chatArr || !chatArr.length) {
        throw new Error('Error in insert of chat "returning"');
    }
    return selectChatSchema.parse(chatArr[0]);
};
export const getWorkspaceChats = async (trx, workspaceId) => {
    const chatsArr = await trx
        .select()
        .from(chats)
        .where(eq(chats.workspaceId, workspaceId))
        .orderBy(desc(chats.updatedAt));
    return z.array(selectChatSchema).parse(chatsArr);
};
export const getChatById = async (trx, chatId) => {
    const chatArr = await trx.select().from(chats).where(eq(chats.id, chatId));
    if (!chatArr || !chatArr.length) {
        throw new Error("Chat not found");
    }
    return selectChatSchema.parse(chatArr[0]);
};
export const getChatByExternalId = async (trx, chatId) => {
    const chatArr = await trx
        .select()
        .from(chats)
        .where(eq(chats.externalId, chatId));
    if (!chatArr || !chatArr.length) {
        throw new Error("Chat not found");
    }
    return selectChatSchema.parse(chatArr[0]);
};
export const updateChatByExternalId = async (trx, chatId, chat) => {
    chat.updatedAt = new Date();
    const chatArr = await trx
        .update(chats)
        .set(chat)
        .where(eq(chats.externalId, chatId))
        .returning();
    if (!chatArr || !chatArr.length) {
        throw new Error("Chat not found");
    }
    return selectChatSchema.parse(chatArr[0]);
};
export const deleteChatByExternalId = async (trx, chatId) => {
    const chatArr = await trx
        .delete(chats)
        .where(eq(chats.externalId, chatId))
        .returning();
    if (!chatArr || !chatArr.length) {
        throw new Error("Chat not found");
    }
    return selectChatSchema.parse(chatArr[0]);
};
export const deleteMessagesByChatId = async (trx, chatId) => {
    const msgArr = await trx
        .delete(messages)
        .where(eq(messages.chatExternalId, chatId))
        .returning();
    if (!msgArr || !msgArr.length) {
        throw new Error("Messages not found");
    }
    return selectMessageSchema.parse(msgArr[0]);
};
export const updateMessageByExternalId = async (trx, msgId, message) => {
    message.updatedAt = new Date();
    const msgArr = await trx
        .update(messages)
        .set(message)
        .where(eq(messages.externalId, msgId))
        .returning();
    if (!msgArr || !msgArr.length) {
        throw new Error("Message not found");
    }
    return selectMessageSchema.parse(msgArr[0]);
};
export const getPublicChats = async (trx, email, pageSize, offset) => {
    const chatsArr = await trx
        .select()
        .from(chats)
        .where(eq(chats.email, email))
        .limit(pageSize)
        .offset(offset)
        .orderBy(desc(chats.updatedAt));
    return z.array(selectPublicChatSchema).parse(chatsArr);
};
