import { db } from "../db/client"
import { chatTrace } from "../db/schema"
import { compressTraceJson } from "../utils/compression" // Corrected import path
import { sql, eq } from "drizzle-orm"

async function migrateChatTraceData() {
  console.log("Starting data migration for chat_trace.trace_json...")
  const batchSize = 100
  const oldColumnNameRaw = sql.raw("trace_json_old_jsonb")

  let finalUpdatedCount = 0 // This will hold the count if transaction is successful

  try {
    await db.transaction(async (tx) => {
      console.log("Transaction started for data migration.")
      let updatedInCurrentTransaction = 0

      while (true) {
        const records: { id: number; trace_json_old_jsonb: any }[] =
          await tx.execute(
            // Use tx for operations within the transaction
            sql`SELECT id, ${oldColumnNameRaw} FROM chat_trace WHERE ${chatTrace.traceJson} IS NULL AND ${oldColumnNameRaw} IS NOT NULL LIMIT ${batchSize}`,
          )

        if (records.length === 0) {
          console.log("No more records to process.")
          break
        }
        console.log(`Processing batch of ${records.length} records...`)

        for (const record of records) {
          const id = record.id
          const oldJsonbData = record.trace_json_old_jsonb

          if (oldJsonbData === null || typeof oldJsonbData === "undefined") {
            console.warn(
              `Skipping record ${id} as old data is null/undefined unexpectedly.`,
            )
            continue
          }

          try {
            const jsonString = JSON.stringify(oldJsonbData)
            const compressedBuffer = compressTraceJson(jsonString)

            await tx // Use tx
              .update(chatTrace)
              .set({ traceJson: compressedBuffer })
              .where(eq(chatTrace.id, id))

            updatedInCurrentTransaction++
          } catch (error) {
            console.error(
              `Failed to migrate record ${id} during transaction:`,
              error,
            )
            // Re-throw to ensure the transaction rolls back
            throw new Error(
              `Migration failed for record ${id}. Rolling back transaction. Original error: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
      } // End of while loop

      // If loop completes without error, transaction will commit.
      // Set finalUpdatedCount to the number of records processed in the successful transaction.
      finalUpdatedCount = updatedInCurrentTransaction
      console.log(
        `Transaction phase completed. ${updatedInCurrentTransaction} records processed and will be committed.`,
      )
    }) // End of db.transaction

    // If we reach here, the transaction was successful and committed.
    console.log("Data migration transaction committed successfully.")
    console.log(`Successfully updated records: ${finalUpdatedCount}`)
    // If transaction committed, failed records that would cause rollback is 0.
    // Any skipped records (e.g. oldJsonbData is null) are not "failed" in a transactional sense.
    console.log("Failed records (that would cause rollback): 0.")
  } catch (transactionError) {
    console.error(
      "Data migration transaction failed and was rolled back:",
      transactionError,
    )
    console.log("Successfully updated records: 0.")
    console.error(
      "Migration failed. No records were updated due to transaction rollback.",
    )
    // Propagate the error so the main script catcher can handle process.exit
    throw transactionError
  }
}

migrateChatTraceData()
  .then(() => {
    console.log(
      "Migration script completed successfully (transaction committed).",
    )
    process.exit(0)
  })
  .catch((error) => {
    // Error logging is already done inside migrateChatTraceData for transaction errors
    // This will catch errors from transaction or other unexpected errors
    console.error("Unhandled error in migration script execution:", error)
    process.exit(1)
  })
