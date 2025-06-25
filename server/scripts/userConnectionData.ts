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
 * Pages through all mail documents in Vespa using continuation-based pagination,
 * extracting sender and recipient relationships.
 * Uses continuation tokens for efficient pagination without offset limits.
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
  // Use a reasonable limit for each request
  const actualLimit = Math.min(limit, 200)
  let continuation: string | undefined = undefined

  while (true) {
    const yql = encodeURIComponent(
      `select * from sources ${mailSchema} where true`,
    )
    let url = `${vespaEndpoint}/search/?yql=${yql}&hits=${actualLimit}&ranking.profile=unranked&presentation.summary=default`
    if (continuation) {
      url += `&continuation=${encodeURIComponent(continuation)}`
    }

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

      // Check for continuation token to determine if more results are available
      if (data.root.continuation) {
        continuation = data.root.continuation
      } else {
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

// if (require.main === module) {
//   buildUserConnectionMap().catch((error) => {
//     Logger.error(error, "Failed to build user connection map")
//     process.exit(1)
//   })
// }
