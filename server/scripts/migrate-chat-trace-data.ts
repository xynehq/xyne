import { db } from "../db/client"
import { chatTrace } from "../db/schema"
import { compressTraceJson } from "@/utils/compression"
import { sql, eq } from "drizzle-orm"

async function migrateChatTraceData() {
  console.log("Starting data migration for chat_trace.trace_json...")
  let updatedCount = 0
  let failedCount = 0
  const batchSize = 100

  const oldColumnNameRaw = sql.raw("trace_json_old_jsonb")

  while (true) {
    const records: { id: number; trace_json_old_jsonb: any }[] =
      await db.execute(
        sql`SELECT id, ${oldColumnNameRaw} FROM chat_trace WHERE ${chatTrace.traceJson} IS NULL AND ${oldColumnNameRaw} IS NOT NULL LIMIT ${batchSize}`,
      )

    if (records.length === 0) {
      console.log("No more records to process.")
      break
    }
    console.log(`Processing batch of ${records.length} records...`)

    for (const record of records) {
      const id = record.id
      const oldJsonbData = record.trace_json_old_jsonb // Direct access to raw column name

      if (oldJsonbData === null || typeof oldJsonbData === "undefined") {
        // This should not be hit due to the WHERE clause, but included as a safeguard.
        console.warn(
          `Skipping record ${id} as old data is null/undefined unexpectedly.`,
        )
        continue
      }

      try {
        const jsonString = JSON.stringify(oldJsonbData)
        const compressedBuffer = compressTraceJson(jsonString)

        await db
          .update(chatTrace)
          .set({ traceJson: compressedBuffer })
          .where(eq(chatTrace.id, id))

        updatedCount++
      } catch (error) {
        failedCount++
        console.error(`Failed to migrate record ${id}:`, error)
      }
    }
  }

  console.log("Data migration for chat_trace.trace_json finished.")
  console.log(`Successfully updated records: ${updatedCount}`)
  console.log(`Failed records: ${failedCount}`)

  if (failedCount > 0) {
    console.error("Some records failed to migrate. Please check the logs.")
  }
}

migrateChatTraceData()
  .then(() => {
    console.log("Migration script completed successfully.")
    process.exit(0)
  })
  .catch((error) => {
    console.error("Unhandled error in migration script:", error)
    process.exit(1)
  })
