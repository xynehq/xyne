import type { TxnOrClient } from "@/types"
import { createId } from "@paralleldrive/cuid2"
import {
  selectSyncHistorySchema,
  syncHistory,
  type InsertSyncHistory,
  type SelectSyncHistory,
} from "@/db/schema"

export const insertSyncHistory = async (
  trx: TxnOrClient,
  history: Omit<InsertSyncHistory, "externalId">,
): Promise<SelectSyncHistory> => {
  const externalId = createId() // Generate unique external ID
  const historyWithExternalId = { ...history, externalId }
  const historyArr = await trx
    .insert(syncHistory)
    .values(historyWithExternalId)
    .returning()
  if (!historyArr || !historyArr.length) {
    throw new Error('Error in insert of sync history "returning"')
  }
  const parsedData = selectSyncHistorySchema.safeParse(historyArr[0])
  if (!parsedData.success) {
    throw new Error(
      `Could not get sync history after inserting: ${parsedData.error.toString()}`,
    )
  }
  return parsedData.data
}
