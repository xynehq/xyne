import { db } from "./client"
import { chatTrace } from "@/db/schema"
import type { InferInsertModel, InferSelectModel } from "drizzle-orm"
import { z } from "zod"
import { createInsertSchema } from "drizzle-zod"
import { eq } from "drizzle-orm"
import type { TxnOrClient } from "@/types"

// Infer the schema, including workspaceId, userId, external IDs, and non-null traceJson
export const insertChatTraceSchema = createInsertSchema(chatTrace).omit({
  id: true,
  createdAt: true,
})

export type InsertChatTrace = z.infer<typeof insertChatTraceSchema>

/**
 * Inserts a new chat trace record into the database.
 * @param traceData - The data for the new chat trace record.
 * @returns The newly created chat trace record.
 */
export async function insertChatTrace(
  traceData: InsertChatTrace,
): Promise<InferInsertModel<typeof chatTrace>> {
  const [newTrace] = await db.insert(chatTrace).values(traceData).returning()

  if (!newTrace) {
    throw new Error("Failed to insert chat trace")
  }

  return newTrace
}

export async function getChatTraceByExternalId(
  chatExternalId: string,
  messageExternalId: string,
): Promise<InferSelectModel<typeof chatTrace> | undefined> {
  const [trace] = await db
    .select()
    .from(chatTrace)
    .where(
      eq(chatTrace.chatExternalId, chatExternalId) &&
        eq(chatTrace.messageExternalId, messageExternalId),
    )
  return trace
}

export const deleteChatTracesByChatExternalId = async (
  tx: TxnOrClient,
  chatExternalId: string,
): Promise<void> => {
  await tx.delete(chatTrace).where(eq(chatTrace.chatExternalId, chatExternalId))
}

export async function updateChatTrace(
  chatExternalId: string,
  messageExternalId: string,
  traceJson: string,
): Promise<InferSelectModel<typeof chatTrace> | undefined> {
  const [updatedTrace] = await db
    .update(chatTrace)
    .set({ traceJson })
    .where(
      eq(chatTrace.chatExternalId, chatExternalId) &&
        eq(chatTrace.messageExternalId, messageExternalId),
    )
    .returning()

  return updatedTrace
}
