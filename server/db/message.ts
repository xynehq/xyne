import { createId } from "@paralleldrive/cuid2"
import {
  messageMetadata,
  messages,
  selectMessageMetadataSchema,
  selectMessageSchema,
  type InsertMessage,
  type InsertMessageMetadata,
  type SelectMessage,
  type SelectMessageMetadata,
} from "@/db/schema"
import { MessageRole, type TxnOrClient } from "@/types"
import { and, asc, eq, lt } from "drizzle-orm"
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

export const getMessageMetadata = async (
  trx: TxnOrClient,
  messageId: string,
): Promise<SelectMessageMetadata> => {
  const metadataArr = await trx
    .select()
    .from(messageMetadata)
    .where(eq(messageMetadata.chatId, messageId))

  if (!metadataArr || !metadataArr.length) {
    throw new Error("Message metadata not found")
  }
  return selectMessageMetadataSchema.parse(metadataArr[0])
}

export const insertMessageMetadata = async (
  trx: TxnOrClient,
  classificationMetadata: Omit<InsertMessageMetadata, "id">,
  chatId: string,
): Promise<SelectMessageMetadata> => {
  const metadataArr = await trx
    .insert(messageMetadata)
    .values({ classificationMetadata, chatId })
    .onConflictDoUpdate({
      target: messageMetadata.chatId,
      set: classificationMetadata,
    })
    .returning()

  if (!metadataArr || !metadataArr.length) {
    throw new Error('Error in insert or update of message "returning"')
  }

  const parsedData = selectMessageMetadataSchema.safeParse(metadataArr[0])
  if (!parsedData.success) {
    throw new Error(
      `Could not get message after inserting/updating: ${parsedData.error.toString()}`,
    )
  }

  return parsedData.data
}
