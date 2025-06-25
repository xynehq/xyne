import crypto from "crypto"
import { mailSchema } from "@/search/types"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import { ErrorRetrievingDocuments } from "@/errors"

const Logger = getLogger(Subsystem.Utils).child({
  module: "useConnectionData",
})

// Define your Vespa endpoint
const vespaEndpoint = `http://${config.vespaBaseHost}:8080`

export const buildUserConnectionMap = async (): Promise<void> => {
  // Simple hashing function using SHA-256
  function hashEmail(email: string): string {
    return crypto
      .createHash("sha256")
      .update(email.toLowerCase().trim())
      .digest("hex")
  }

  const connectionMap: Record<string, Record<string, number>> = {}
  const processedMailIds = new Set<string>() // Track processed mails to avoid duplicates
  // Use a reasonable limit for each request to avoid Vespa errors
  const actualLimit = 400
  let totalMailsProcessed = 0
  let requestCount = 0
  const maxOffset = 1000

  // Multiple query strategies to capture all mails within the 1000 offset limit
  const queryStrategies = [
    {
      query: `select * from sources ${mailSchema} where true order by timestamp desc`,
      name: "timestamp_desc",
    },
    {
      query: `select * from sources ${mailSchema} where true order by timestamp asc`,
      name: "timestamp_asc",
    },
    {
      query: `select * from sources ${mailSchema} where true order by docId desc`,
      name: "docId_desc",
    },
    {
      query: `select * from sources ${mailSchema} where true order by docId asc`,
      name: "docId_asc",
    },
    {
      query: `select * from sources ${mailSchema} where true order by threadId desc`,
      name: "threadId_desc",
    },
    {
      query: `select * from sources ${mailSchema} where true order by threadId asc`,
      name: "threadId_asc",
    },
  ]

  for (const strategy of queryStrategies) {
    let offset = 0
    Logger.info(`Starting pass with strategy: ${strategy.name}`)

    while (offset < maxOffset) {
      requestCount++
      const yql = encodeURIComponent(strategy.query)
      let url = `${vespaEndpoint}/search/?yql=${yql}&hits=${actualLimit}&ranking.profile=unranked&presentation.summary=default&offset=${offset}`

      try {
        Logger.info(
          `Request ${requestCount}: Fetching batch of up to ${actualLimit} mails at offset ${offset} (${strategy.name})...`,
        )
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(
            `Failed to fetch documents: ${response.status} - ${errorText}`,
          )
        }

        const data = await response.json()
        const mails = data.root.children
        if (!mails || mails.length === 0) {
          Logger.info(
            `No more mails found at offset ${offset} for ${strategy.name}. Moving to next strategy.`,
          )
          break
        }

        Logger.info(`Received ${mails.length} mails in batch ${requestCount}`)
        let newMailsProcessed = 0

        for (const item of mails) {
          const fields = item.fields
          const mailId = fields?.id || fields?.messageId

          // Skip if we've already processed this mail
          if (mailId && processedMailIds.has(mailId)) {
            continue
          }

          if (mailId) {
            processedMailIds.add(mailId)
          }

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

          for (const to of toList) {
            const hashedTo = hashEmail(to)
            if (!connectionMap[hashedFrom][hashedTo]) {
              connectionMap[hashedFrom][hashedTo] = 0
            }
            connectionMap[hashedFrom][hashedTo] += 1
          }

          newMailsProcessed++
        }

        totalMailsProcessed += newMailsProcessed
        offset += actualLimit
      } catch (error) {
        const errMessage = getErrorMessage(error)
        Logger.error(error, `Error retrieving mail documents: ${errMessage}`)
        throw new ErrorRetrievingDocuments({
          cause: error as Error,
          sources: mailSchema,
        })
      }
    }
  }

  Logger.info(
    `Completed all strategies. Total unique mails processed: ${totalMailsProcessed}, Total requests: ${requestCount}`,
  )

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
