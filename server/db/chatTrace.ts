import { db } from "./client"
import { chatTrace } from "@/db/schema"
import type { InferInsertModel, InferSelectModel } from "drizzle-orm"
import { z } from "zod"
import { createInsertSchema } from "drizzle-zod"
import { eq, and } from "drizzle-orm"
import { compressTraceJson, decompressTraceJson } from "@/utils/compression"
import type { TxnOrClient } from "@/types"

export const insertChatTraceSchema = createInsertSchema(chatTrace, {
  traceJson: z.string().transform(compressTraceJson),
}).omit({ id: true, createdAt: true })

export type InsertChatTrace = z.infer<typeof insertChatTraceSchema>
export type SelectChatTrace = Omit<
  InferSelectModel<typeof chatTrace>,
  "traceJson"
> & {
  traceJson: string
}

export async function insertChatTrace(
  traceData: Omit<InsertChatTrace, "traceJson"> & { traceJson: string },
): Promise<SelectChatTrace> {
  const validated = insertChatTraceSchema.parse(traceData)
  const [inserted] = await db.insert(chatTrace).values(validated).returning()

  if (!inserted) throw new Error("Failed to insert chat trace")
  return {
    ...inserted,
    traceJson: JSON.parse(decompressTraceJson(inserted.traceJson as Buffer)),
  }
}

export async function getChatTraceByExternalId(
  chatExternalId: string,
  messageExternalId: string,
): Promise<SelectChatTrace | null> {
  const [trace] = await db
    .select()
    .from(chatTrace)
    .where(
      and(
        eq(chatTrace.chatExternalId, chatExternalId),
        eq(chatTrace.messageExternalId, messageExternalId),
      ),
    )

  if (!trace || !trace.traceJson) return null

  try {
    return {
      ...trace,
      traceJson: JSON.parse(decompressTraceJson(trace.traceJson as Buffer)),
    }
  } catch (err) {
    return null
  }
}

export async function updateChatTrace(
  chatExternalId: string,
  messageExternalId: string,
  traceJsonString: string,
): Promise<SelectChatTrace | null> {
  const compressed = compressTraceJson(traceJsonString)
  const [updated] = await db
    .update(chatTrace)
    .set({ traceJson: compressed })
    .where(
      and(
        eq(chatTrace.chatExternalId, chatExternalId),
        eq(chatTrace.messageExternalId, messageExternalId),
      ),
    )
    .returning()

  if (!updated || !updated.traceJson) return null

  return {
    ...updated,
    traceJson: JSON.parse(decompressTraceJson(updated.traceJson as Buffer)),
  }
}

export const deleteChatTracesByChatExternalId = async (
  tx: TxnOrClient,
  chatExternalId: string,
): Promise<void> => {
  await tx.delete(chatTrace).where(eq(chatTrace.chatExternalId, chatExternalId))
}
