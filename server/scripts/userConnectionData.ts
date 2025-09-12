import crypto from "crypto"
import { mailSchema } from "@xyne/vespa-ts/types"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import { ErrorRetrievingDocuments } from "@/errors"

const Logger = getLogger(Subsystem.Utils).child({
  module: "useConnectionData",
})

const vespaEndpoint = `http://${config.vespaBaseHost}:8080`

/**
 * Fetches all mail documents using parallel batching approach,
 * extracting sender and recipient relationships efficiently.
 */
export const buildUserConnectionMap = async (): Promise<void> => {
  // Simple hashing function using SHA-256
  function hashEmail(email: string): string {
    return crypto
      .createHash("sha256")
      .update(email.toLowerCase().trim())
      .digest("hex")
  }

  // Helper function to fetch a batch of documents
  async function fetchBatch(offset: number, limit: number): Promise<any[]> {
    const searchPayload = {
      yql: `select * from sources ${mailSchema} where true`,
      hits: limit,
      offset,
      "ranking.profile": "unranked",
      "presentation.summary": "default",
      maxOffset: 1000000, // Same as VespaClient - bypass the 1000 limit!
      maxHits: 1000000, // Also bypass the hits limit!
      timeout: "10s",
    }

    const response = await fetch(`${vespaEndpoint}/search/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(searchPayload),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(
        `Failed to fetch batch: ${response.status} - ${errorText}`,
      )
    }

    const data = await response.json()
    return data.root?.children || []
  }

  // First get total count
  async function getTotalCount(): Promise<number> {
    const searchPayload = {
      yql: `select * from sources ${mailSchema} where true`,
      hits: 0,
      summary: "count",
      maxOffset: 1000000,
      timeout: "10s",
    }

    const response = await fetch(`${vespaEndpoint}/search/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(searchPayload),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Failed to get count: ${response.status} - ${errorText}`)
    }

    const data = await response.json()
    return data.root?.fields?.totalCount || 0
  }

  const connectionMap: Record<string, Record<string, number>> = {}

  try {
    Logger.info("Getting total document count...")
    const totalCount = await getTotalCount()
    Logger.info(`Total mails in Vespa: ${totalCount}`)

    if (totalCount === 0) {
      Logger.info("No mails found in Vespa")
      return
    }

    // Use parallel batching with safe batch size that respects hits limit
    const batchSize = 400 // Keep at 400 to respect the hits limit
    const maxConcurrency = 3
    const allMails: any[] = []

    // Create batch tasks for ALL documents, not just first 1000
    const batchTasks = []
    for (let offset = 0; offset < totalCount; offset += batchSize) {
      batchTasks.push(async () => {
        Logger.info(`Fetching batch at offset ${offset}...`)
        return await fetchBatch(
          offset,
          Math.min(batchSize, totalCount - offset),
        )
      })
    }

    // Execute batches with concurrency limit
    const pLimit = (await import("p-limit")).default
    const limit = pLimit(maxConcurrency)

    Logger.info(
      `Executing ${batchTasks.length} batch tasks with concurrency ${maxConcurrency} to fetch ALL ${totalCount} mails...`,
    )
    const batchResults = await Promise.all(
      batchTasks.map((task) => limit(task)),
    )

    // Flatten results
    for (const batch of batchResults) {
      allMails.push(...batch)
    }

    Logger.info(
      `Retrieved ${allMails.length} total mails from Vespa (should be close to ${totalCount})`,
    )

    // Process mails for connection mapping
    let processedCount = 0
    for (const mail of allMails) {
      const fields = mail.fields
      const from = fields?.from
      // Merge to, cc, and bcc into a single recipients list
      const toList = [
        ...(fields?.to || []),
        ...(fields?.cc || []),
        ...(fields?.bcc || []),
      ]

      if (
        !from ||
        typeof from !== "string" ||
        !Array.isArray(toList) ||
        toList.length === 0
      )
        continue

      // Validate that all recipients are strings
      const validRecipients = toList.filter(
        (recipient) =>
          typeof recipient === "string" && recipient.trim().length > 0,
      )
      if (validRecipients.length === 0) continue

      const hashedFrom = hashEmail(from)

      if (!connectionMap[hashedFrom]) {
        connectionMap[hashedFrom] = {}
      }

      for (const to of validRecipients) {
        const hashedTo = hashEmail(to)
        if (!connectionMap[hashedFrom][hashedTo]) {
          connectionMap[hashedFrom][hashedTo] = 0
        }
        connectionMap[hashedFrom][hashedTo] += 1
      }

      processedCount++
    }

    Logger.info(`Processed ${processedCount} mails for connection mapping`)
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(error, `Error retrieving mail documents: ${errMessage}`)
    throw new ErrorRetrievingDocuments({
      cause: error as Error,
      sources: mailSchema,
    })
  }

  // Write the connectionMap to a CSV file in the root project directory
  const fs = await import("fs/promises")
  const path = await import("path")
  const outputPath = path.join(process.cwd(), "user_connection_map.csv")

  try {
    const lines = ["user1hash,user2hash,count"]
    for (const from in connectionMap) {
      for (const to in connectionMap[from]) {
        lines.push(`${from},${to},${connectionMap[from][to]}`)
      }
    }
    await fs.writeFile(outputPath, lines.join("\n"), "utf-8")
    Logger.info(`User connection map saved to ${outputPath}`)
  } catch (fileError) {
    Logger.error(fileError, "Failed to save user connection map to CSV file")
  }
}

if (require.main === module) {
  buildUserConnectionMap().catch((error) => {
    Logger.error(error, "Failed to build user connection map")
    process.exit(1)
  })
}
