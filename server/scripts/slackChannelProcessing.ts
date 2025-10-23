// Slack Channel Processing with re-ingestion for existing channels
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { Apps, chatContainerSchema } from "@xyne/vespa-ts/types"
import { db } from "@/db/client"
import pLimit from "p-limit"
import type { TxnOrClient } from "@/types"
import { syncJobs } from "@/db/schema"
import { eq } from "drizzle-orm"
import { z } from "zod"
import config, { NAMESPACE, CLUSTER } from "@/config"
import { handleSlackChannelIngestion } from "@/integrations/slack/channelIngest"
import { getConnectorByAppAndEmailId } from "@/db/connector"
import { AuthType } from "@/shared/types"

const logger = getLogger(Subsystem.Api)

// Types
export interface SlackChannelProcessingStats {
  totalChannels: number
  channelsProcessed: number
  channelsWithoutValidUser: number
  channelsAlreadyProcessed: number
  errors: number
  skippedChannels: number
}

export interface SlackChannelProcessingOptions {
  batchSize?: number
  concurrency?: number
  skipProcessed?: boolean
  initialContinuationToken?: string
}

const userSchema = z.object({ email: z.string() })

// VespaClient with visit functionality for slack containers
class SlackContainerVespaClient {
  private vespaEndpoint: string

  constructor() {
    this.vespaEndpoint = config.vespaEndpoint
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries = 3,
  ): Promise<Response> {
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, options)
        return response
      } catch (error) {
        lastError = error as Error
        logger.warn(`Fetch attempt ${attempt} failed: ${lastError.message}`)

        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000)
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }

    throw lastError || new Error("Max retries exceeded")
  }

  async visit(options: {
    namespace?: string
    schema?: string
    continuation?: string
    wantedDocumentCount?: number
    fieldSet?: string
    concurrency?: number
  }): Promise<{ documents: any[]; continuation?: string }> {
    const {
      namespace = NAMESPACE,
      schema = chatContainerSchema,
      continuation,
      wantedDocumentCount = 100,
      fieldSet = "[all]",
      concurrency = 1,
    } = options

    const params = new URLSearchParams({
      wantedDocumentCount: wantedDocumentCount.toString(),
      cluster: CLUSTER || "search",
      selection: schema,
      fieldSet: fieldSet,
      concurrency: concurrency.toString(),
      ...(continuation ? { continuation } : {}),
    })

    const url = `${this.vespaEndpoint}/document/v1/${namespace}/${schema}/docid?${params.toString()}`

    try {
      logger.info(`Visiting slack containers: ${url}`)
      if (continuation) {
        logger.info(`Using continuation token: ${continuation}`)
      }

      const response = await this.fetchWithRetry(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `Visit failed: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }

      const data = await response.json()
      // Log the continuation token for recovery purposes
      if (data.continuation) {
        logger.info(`Received continuation token: ${data.continuation}`)
      } else {
        logger.info(
          "No continuation token received - this might be the last batch",
        )
      }

      return {
        documents: data.documents || [],
        continuation: data.continuation,
      }
    } catch (error) {
      const errMessage = (error as Error).message
      logger.error(error, `Error visiting slack containers: ${errMessage}`)
      throw new Error(`Error visiting slack containers: ${errMessage}`)
    }
  }
}

const slackContainerVespaClient = new SlackContainerVespaClient()

// Fetch slack container documents with continuation using custom vespa client
export const fetchSlackContainerDocumentsWithContinuation = async (
  limit: number = 100,
  continuation?: string,
): Promise<{ documents: any[]; continuation?: string }> => {
  return await slackContainerVespaClient.visit({
    namespace: NAMESPACE,
    schema: chatContainerSchema,
    continuation: continuation,
    wantedDocumentCount: limit,
    fieldSet: "[all]",
    concurrency: 1,
  })
}

// Database Operations
async function getUsersWithSlackSyncJobs(
  trx: TxnOrClient,
  app: Apps,
): Promise<Set<string>> {
  const jobs = await trx
    .select({ email: syncJobs.email })
    .from(syncJobs)
    .where(eq(syncJobs.app, app))

  const users = z.array(userSchema).parse(jobs)
  return new Set(users.map((user) => user.email))
}

// Get connector ID for a user with Slack connection
async function getSlackConnectorForUser(email: string): Promise<number | null> {
  try {
    const connector = await getConnectorByAppAndEmailId(
      db,
      Apps.Slack,
      AuthType.OAuth,
      email,
    )
    return connector?.id || null
  } catch (error) {
    logger.warn({ email, error }, "Failed to get Slack connector for user")
    return null
  }
}

// Main function to process a slack channel document
async function processSlackChannel(
  doc: any,
  validUsers: Set<string>,
): Promise<{
  processed: boolean
  error?: Error
  reason?: string
}> {
  const docId = doc.fields.docId

  try {
    // Get permissions array from the document
    const permissions = doc.fields.permissions || []
    if (!permissions.length) {
      logger.warn({ docId }, "Channel has no permissions, skipping")
      return { processed: false, reason: "no_permissions" }
    }

    // Find a user from permissions who has Slack connected
    let selectedUser: string | null = null
    let connectorId: number | null = null

    for (const email of permissions) {
      if (validUsers.has(email)) {
        const userConnectorId = await getSlackConnectorForUser(email)
        if (userConnectorId) {
          selectedUser = email
          connectorId = userConnectorId
          break
        }
      }
    }

    if (!selectedUser || !connectorId) {
      logger.warn(
        { docId, permissions },
        "No valid user with Slack connector found in permissions",
      )
      return { processed: false, reason: "no_valid_user_with_connector" }
    }

    // Call channel ingestion with no time range (empty strings for start/end date)
    await handleSlackChannelIngestion(
      connectorId,
      [docId], // Array with single channel ID
      "", // No start date - full ingestion
      "", // No end date - full ingestion
      selectedUser,
      false,
    )

    logger.info(
      {
        docId,
        selectedUser,
        connectorId,
      },
      "Processed slack channel re-ingestion",
    )

    return { processed: true }
  } catch (error) {
    logger.error({ docId, error }, "Failed to process slack channel")
    return { processed: false, error: error as Error }
  }
}

// Main Function to Process Slack Channels
export async function processSlackChannels(
  app: Apps = Apps.Slack,
  options: SlackChannelProcessingOptions = {},
): Promise<SlackChannelProcessingStats> {
  const {
    batchSize = 100,
    concurrency = 3, // Lower concurrency to avoid overwhelming Slack API
    skipProcessed = true,
    initialContinuationToken,
  } = options

  logger.info(
    {
      app,
      batchSize,
      concurrency,
      skipProcessed,
      initialContinuationToken: initialContinuationToken ? "PROVIDED" : "NONE",
    },
    "Starting slack channel processing",
  )

  if (initialContinuationToken) {
    logger.info("=== RESUMING FROM CONTINUATION TOKEN ===")
    logger.info("Initial continuation token:", initialContinuationToken)
    logger.info("==========================================")
    logger.info(
      { initialContinuationToken },
      "Resuming from provided continuation token",
    )
  }

  const stats: SlackChannelProcessingStats = {
    totalChannels: 0,
    channelsProcessed: 0,
    channelsWithoutValidUser: 0,
    channelsAlreadyProcessed: 0,
    errors: 0,
    skippedChannels: 0,
  }

  let continuation: string | undefined = initialContinuationToken

  try {
    // Get users with Slack sync jobs
    const validUsers = await getUsersWithSlackSyncJobs(db, app)

    if (validUsers.size === 0) {
      logger.warn("No users with Slack sync jobs found")
      return stats
    }

    logger.info(
      { userCount: validUsers.size },
      "Found users with Slack sync jobs",
    )

    const processLimit = pLimit(concurrency)
    let batchCounter = 0

    // Process in batches using vespa.visit
    do {
      batchCounter++
      const batchId = `batch-${batchCounter}-${Date.now()}`

      logger.info(`=== BATCH ${batchCounter} CONTINUATION TOKEN ===`)
      logger.info("Current continuation token:", continuation || "NONE")
      logger.info("=========================================")

      const { documents, continuation: nextContinuation } =
        await fetchSlackContainerDocumentsWithContinuation(
          batchSize,
          continuation,
        )
      logger.info(`=== BATCH ${batchCounter} NEXT CONTINUATION TOKEN ===`)
      logger.info("Next continuation token:", nextContinuation || "NONE")
      logger.info("===============================================")

      continuation = nextContinuation

      if (documents.length === 0) break

      // Filter only Slack app containers
      const slackChannels = documents.filter(
        (doc) =>
          doc?.fields?.app === Apps.Slack && doc?.fields?.entity === "channel",
      )

      stats.totalChannels += slackChannels.length

      if (slackChannels.length === 0) {
        logger.info(
          {
            batchId,
            totalDocuments: documents.length,
            slackChannels: slackChannels.length,
          },
          "No Slack channels in batch, skipping",
        )
        continue
      }

      logger.info(
        {
          batchId,
          totalDocuments: documents.length,
          slackChannels: slackChannels.length,
          continuationToken: continuation ? "HAS_TOKEN" : "NO_TOKEN",
        },
        "Processing batch",
      )

      // Process channels concurrently
      const results = await Promise.allSettled(
        slackChannels.map((doc: any) =>
          processLimit(() => processSlackChannel(doc, validUsers)),
        ),
      )

      // Update statistics
      results.forEach((result) => {
        if (result.status === "fulfilled") {
          const { processed, error, reason } = result.value
          if (processed) {
            stats.channelsProcessed++
          } else if (
            reason === "no_permissions" ||
            reason === "no_valid_user_with_connector"
          ) {
            stats.channelsWithoutValidUser++
          } else {
            stats.skippedChannels++
          }
          if (error) stats.errors++
        } else {
          stats.errors++
          logger.error(result.reason, "Processing failed")
        }
      })

      logger.info(
        {
          batchId,
          processed: slackChannels.length,
          ...stats,
        },
        "Batch completed",
      )

      if (continuation) {
        logger.info(`=== BATCH ${batchCounter} COMPLETED - SAVE THIS TOKEN ===`)
        logger.info("Continuation token for next run:", continuation)
        logger.info("=================================================")
      }
    } while (continuation)

    logger.info(
      {
        ...stats,
      },
      "Slack channel processing completed",
    )

    return stats
  } catch (error) {
    logger.info("=== ERROR OCCURRED - SAVE THIS TOKEN FOR RECOVERY ===")
    logger.info("Last continuation token:", continuation || "NONE")
    logger.info("====================================================")

    logger.error(
      { error, lastContinuationToken: continuation },
      "Fatal error during slack channel processing",
    )
    throw error
  }
}

// Single entry point function
export async function runSlackChannelProcessing(
  continuationToken?: string,
): Promise<void> {
  logger.info(
    continuationToken
      ? `Resuming slack channel processing from token: ${continuationToken}`
      : "Starting slack channel processing from the beginning",
  )

  const stats = await processSlackChannels(Apps.Slack, {
    batchSize: 50, // Smaller batches for Slack to avoid rate limits
    concurrency: 2, // Lower concurrency for Slack API
    skipProcessed: false, // We want to re-process all channels
    initialContinuationToken: continuationToken,
  })

  logger.info("Slack channel processing completed:", stats)
  logger.info("Channels processed:", stats.channelsProcessed)
}

// Run the processing if this file is executed directly
if (require.main === module) {
  runSlackChannelProcessing()
    .then(() => {
      logger.info("Slack channel processing completed successfully")
      process.exit(0)
    })
    .catch((error) => {
      logger.error({ error }, "Slack channel processing failed")
      process.exit(1)
    })
}
