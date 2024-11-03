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
