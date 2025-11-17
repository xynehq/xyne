import { db } from "./db/connector"

async function checkAttachmentQueue() {
  console.log("Checking attachment queue status...\n")

  const queueName = "process-zoho-desk-attachment"

  try {
    // Count jobs in the attachment queue
    const result = await db.execute(
      `SELECT state, COUNT(*) as count FROM pgboss.job WHERE name = '${queueName}' GROUP BY state`
    )

    console.log(`📊 Queue: ${queueName}`)
    console.log("================================================================================")

    if (result.rows && result.rows.length > 0) {
      console.log("\nJobs by state:")
      for (const row of result.rows) {
        console.log(`  ${row.state}: ${row.count} jobs`)
      }

      // Get total count
      const totalResult = await db.execute(
        `SELECT COUNT(*) as total FROM pgboss.job WHERE name = '${queueName}'`
      )
      console.log(`\n  TOTAL: ${totalResult.rows[0].total} jobs`)
    } else {
      console.log("\n✅ Queue is empty - no jobs found")
    }

    console.log("================================================================================\n")
  } catch (error) {
    console.error("Error checking queue:", error)
  }

  process.exit(0)
}

checkAttachmentQueue()
