import {
  chats,
  insertChatSchema,
  selectChatSchema,
  type InsertChat,
  type SelectChat,
} from "./schema"
import { createId } from "@paralleldrive/cuid2"
import type { TxnOrClient } from "@/types"
import { z } from "zod"
import { eq } from "drizzle-orm"

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
  return z.array(selectChatSchema).parse(chatsArr)
}
