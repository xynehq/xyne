import { db } from "./db/connector"

async function clearAttachmentQueue() {
  console.log("Clearing old attachment processing jobs...")

  const queueName = "process-zoho-desk-attachment"

  try {
    // Delete all jobs from the attachment queue
    const result = await db.execute(
      `DELETE FROM pgboss.job WHERE name = '${queueName}'`
    )
    console.log(`✅ Deleted attachment jobs from queue`)
    console.log("Result:", result)
  } catch (error) {
    console.error("Error clearing queue:", error)
  }

  process.exit(0)
}

clearAttachmentQueue()
