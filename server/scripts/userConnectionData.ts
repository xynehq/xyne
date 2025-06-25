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

/**
 * Pages through all mail documents in Vespa, extracting sender and recipient relationships.
 * Returns a nested map: { [hashedFrom]: { [hashedTo]: count } }
 */
export const buildUserConnectionMap = async (limit = 500): Promise<void> => {
  // Simple hashing function using SHA-256
  function hashEmail(email: string): string {
    return crypto
      .createHash("sha256")
      .update(email.toLowerCase().trim())
      .digest("hex")
  }

  const connectionMap: Record<string, Record<string, number>> = {}
  let offset = 0
  const maxOffset = 1000 // Vespa's configured limit
  // Use a smaller limit to ensure we can paginate properly within Vespa's constraints
  const actualLimit = Math.min(limit, 200)

  while (offset < maxOffset) {
    const yql = encodeURIComponent(
      `select * from sources ${mailSchema} where true`,
    )
    const url = `${vespaEndpoint}/search/?yql=${yql}&hits=${actualLimit}&offset=${offset}&ranking.profile=unranked&presentation.summary=default`

    try {
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
      if (!mails || mails.length === 0) break

      for (const item of mails) {
        const fields = item.fields
        const from = fields?.from
        // Merge to, cc, and bcc into a single recipients list
        const toList = [
          ...(fields?.to || []),
          ...(fields?.cc || []),
          ...(fields?.bcc || []),
        ]

        if (!from || !Array.isArray(toList)) continue

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
      }

      // If we got fewer results than requested, we've reached the end
      if (mails.length < actualLimit) {
        break
      }

      offset += actualLimit

      // Stop if we're approaching the offset limit
      if (offset + actualLimit > maxOffset) {
        Logger.warn(
          `Reached Vespa offset limit of ${maxOffset}. Some documents may not be processed.`,
        )
        break
      }
    } catch (error) {
      const errMessage = getErrorMessage(error)
      Logger.error(error, `Error retrieving mail documents: ${errMessage}`)
      throw new ErrorRetrievingDocuments({
        cause: error as Error,
        sources: mailSchema,
      })
    }
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

await buildUserConnectionMap()
