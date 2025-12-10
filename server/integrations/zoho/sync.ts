import type PgBoss from "pg-boss"
import { db } from "@/db/client"
import { eq } from "drizzle-orm"
import { getLogger } from "@/logger"
import { Subsystem, SyncCron } from "@/types"
import { Apps, AuthType, SyncJobStatus } from "@/shared/types"
import config from "@/config"
import {
  connectors,
  type SelectConnector,
  type SelectIngestion,
  type ZohoDeskOAuthIngestionState,
  type ZohoDeskIngestionMetadata,
} from "@/db/schema"
import { insertSyncHistory } from "@/db/syncHistory"
import {
  createIngestion,
  updateIngestionStatus,
  updateIngestionMetadata,
} from "@/db/ingestion"
import { ZohoDeskClient } from "./client"
import { boss } from "@/queue/boss"
import { ProcessZohoDeskTicketQueue } from "@/queue"
import type { TicketJob } from "./queue"

const Logger = getLogger(Subsystem.Integrations).child({ module: "zoho" })

interface ZohoSyncMetrics {
  ticketsFetched: number
  ticketsWithAttachments: number
  totalAttachments: number
  errors: number
  startTime: number
  endTime?: number
}

/**
 * Main sync handler for Zoho Desk
 * Runs daily at 2 AM via cron job
 */
export async function handleZohoDeskSync(
  job: PgBoss.Job<{ connectorId?: number }>,
): Promise<void> {
  Logger.info("🚀 ZOHO SYNC HANDLER: Starting")

  // Get all Zoho Desk connectors if no specific connector ID provided
  const specificConnectorId = job.data?.connectorId

  let connectorsToSync: SelectConnector[] = []

  if (specificConnectorId) {
    const connector = await getZohoConnector(specificConnectorId)
    if (!connector) {
      Logger.error("❌ ZOHO SYNC HANDLER: Connector not found", {
        connectorId: specificConnectorId,
      })
      throw new Error(`Connector not found: ${specificConnectorId}`)
    }
    connectorsToSync = [connector]
  } else {
    // Sync all Zoho Desk connectors
    Logger.info("✅ ZOHO SYNC HANDLER: Fetching all Zoho Desk connectors")
    connectorsToSync = await getAllZohoDeskConnectors()
    Logger.info(
      `✅ ZOHO SYNC HANDLER: Found ${connectorsToSync.length} connectors`
    )
  }

  if (connectorsToSync.length === 0) {
    Logger.info("⚠️  ZOHO SYNC HANDLER: No connectors found to sync")
    return
  }

  // Process each connector
  for (const connector of connectorsToSync) {
    try {
      Logger.info("🔄 ZOHO SYNC HANDLER: Processing connector")
      await syncConnector(connector)
      Logger.info("✅ ZOHO SYNC HANDLER: Connector synced successfully")
    } catch (error) {
      Logger.error("❌ ZOHO SYNC HANDLER: Error syncing connector", {
        connectorId: connector.id,
        error: error instanceof Error ? error.message : String(error),
      })
      // Continue with other connectors
    }
  }

  Logger.info("✅ ZOHO SYNC HANDLER: All connectors processed")
}

/**
 * Sync a single Zoho Desk connector
 */
async function syncConnector(connector: SelectConnector): Promise<void> {
  const connectorId = connector.id
  const metrics: ZohoSyncMetrics = {
    ticketsFetched: 0,
    ticketsWithAttachments: 0,
    totalAttachments: 0,
    errors: 0,
    startTime: Date.now(),
  }

  Logger.info("🔄 SYNC CONNECTOR: Starting sync", { connectorId })

  try {

    // 2. Create new ingestion record
    Logger.info("✅ SYNC CONNECTOR: Creating ingestion record", { connectorId })

    const initialMetadata: { zohoDesk: ZohoDeskIngestionMetadata } = {
      zohoDesk: {
        websocketData: {
          connectorId: connector.id.toString(),
          progress: {
            totalTickets: 0,
            processedTickets: 0,
            ticketsWithAttachments: 0,
            totalAttachments: 0,
            errors: 0,
          },
        },
      },
    }

    const ingestion = await createIngestion(db, {
      userId: connector.userId,
      connectorId: connector.id,
      workspaceId: connector.workspaceId,
      status: "in_progress",
      metadata: initialMetadata,
    })

    try {
      // 3. Initialize Zoho client (admin credentials only)
      Logger.info("✅ SYNC CONNECTOR: Initializing Zoho client", {
        connectorId,
      })

      // Verify this is an admin connector (not a user OAuth connector)
      if (!connector.credentials) {
        Logger.error("❌ SYNC CONNECTOR: Not an admin connector, skipping", {
          connectorId,
          hasOAuthCredentials: !!connector.oauthCredentials,
        })
        throw new Error(
          "Connector does not have admin credentials - only admin connectors can sync",
        )
      }

      let credentials
      try {
        credentials = JSON.parse(connector.credentials as string)
      } catch (error) {
        Logger.error("❌ SYNC CONNECTOR: Failed to parse credentials", {
          connectorId,
          error: error instanceof Error ? error.message : String(error),
        })
        throw new Error("Invalid connector credentials format")
      }

      const client = new ZohoDeskClient({
        orgId: credentials.orgId ?? config.ZohoOrgId,
        clientId: credentials.clientId ?? config.ZohoClientId,
        clientSecret: credentials.clientSecret ?? config.ZohoClientSecret,
        refreshToken: credentials.refreshToken,
      })

      Logger.info(
        "✅ SYNC CONNECTOR: Zoho client initialized with admin token",
        { connectorId },
      )

      // 4. Get last sync time from connector state
      const rawState = connector.state as
        | ZohoDeskOAuthIngestionState
        | null
        | undefined
      const hasState =
        rawState &&
        typeof rawState === "object" &&
        "lastModifiedTime" in rawState
      let lastModifiedTime: string | undefined = hasState
        ? rawState.lastModifiedTime
        : undefined

      const now = new Date().toISOString()

      // For first-time sync, fetch tickets from the past year
      if (!lastModifiedTime) {
        const oneYearAgo = new Date()
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
        lastModifiedTime = oneYearAgo.toISOString()
        Logger.info(
          "🆕 SYNC CONNECTOR: FIRST-TIME SYNC - Fetching from past year"
        )
      } else {
        Logger.info(
          "🔄 SYNC CONNECTOR: INCREMENTAL SYNC - Only fetching modified tickets",
        )
      }

      // 5. Check if queue is ready
      if (!boss) {
        Logger.error("❌ SYNC CONNECTOR: PgBoss instance not available", {
          connectorId,
        })
        throw new Error("Queue system not initialized")
      }

      // 6. Sync tickets
      Logger.info("🎫 SYNC CONNECTOR: Starting ticket sync", { connectorId })
      await syncTickets(client, connector, lastModifiedTime, metrics, ingestion)
      Logger.info("✅ SYNC CONNECTOR: Ticket sync completed", {
        connectorId,
        ticketsFetched: metrics.ticketsFetched,
      })

      // 7. Update connector state with new timestamp
      const newLastModifiedTime = new Date().toISOString()
      const newState: ZohoDeskOAuthIngestionState = {
        app: Apps.ZohoDesk,
        authType: AuthType.OAuth,
        lastModifiedTime: newLastModifiedTime,
        lastUpdated: newLastModifiedTime,
      }

      await db
        .update(connectors)
        .set({ state: newState })
        .where(eq(connectors.id, connector.id))

      Logger.info(
        "📝 Updated connector state with new sync timestamp"
      )

      // 8. Insert sync history
      metrics.endTime = Date.now()
      const duration = metrics.endTime - metrics.startTime

      await insertSyncHistory(db, {
        workspaceId: connector.workspaceId,
        workspaceExternalId: connector.workspaceExternalId,
        dataAdded: 0, // Tickets are processed asynchronously by workers
        dataUpdated: 0, // Tickets are processed asynchronously by workers
        dataDeleted: 0,
        authType: AuthType.OAuth,
        app: Apps.ZohoDesk,
        type: SyncCron.Partial,
        status: SyncJobStatus.Successful,
        summary: {
          ticketsQueued: metrics.ticketsFetched, // Tickets queued for async processing
          ticketsWithAttachments: metrics.ticketsWithAttachments,
          totalAttachments: metrics.totalAttachments,
          errors: metrics.errors,
          duration,
        },
        errorMessage: "",
        config: {
          type: "updatedAt" as const,
          updatedAt: new Date(),
        },
      })

      // 9. Mark ingestion as completed
      Logger.info("✅ SYNC CONNECTOR: Marking ingestion as completed", {
        connectorId,
        ingestionId: ingestion.id,
      })
      await updateIngestionStatus(db, ingestion.id, "completed")

      Logger.info("✅✅✅ SYNC CONNECTOR: Sync completed successfully!", {
        connectorId,
        duration: `${duration}ms`,
        ticketsQueued: metrics.ticketsFetched,
        errors: metrics.errors,
      })
    } catch (error) {
      // Handle sync job failure
      // Pino logger expects: logger.error(obj, msg) - object FIRST
      Logger.error(
        {
          connectorId,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
          errorType:
            error instanceof Error ? error.constructor.name : typeof error,
        },
        "❌ ZOHO DESK SYNC FAILED - DETAILS BELOW",
      )

      // Mark ingestion as failed if it exists
      if (ingestion) {
        await updateIngestionStatus(
          db,
          ingestion.id,
          "failed",
          error instanceof Error ? error.message : String(error),
        )
      }

      // Insert failure in sync history
      await insertSyncHistory(db, {
        workspaceId: connector.workspaceId,
        workspaceExternalId: connector.workspaceExternalId,
        dataAdded: 0, // Tickets are processed asynchronously by workers
        dataUpdated: 0, // Tickets are processed asynchronously by workers
        dataDeleted: 0,
        authType: AuthType.OAuth,
        app: Apps.ZohoDesk,
        type: SyncCron.Partial,
        status: SyncJobStatus.Failed,
        summary: {
          ticketsQueued: metrics.ticketsFetched, // Tickets queued before failure
          errors: metrics.errors + 1,
        },
        errorMessage: error instanceof Error ? error.message : String(error),
        config: {
          type: "updatedAt" as const,
          updatedAt: new Date(),
        },
      })

      throw error
    }
  } catch (error) {
    Logger.error(
      {
        connectorId,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        errorType:
          error instanceof Error ? error.constructor.name : typeof error,
      },
      "❌ FATAL ERROR IN ZOHO DESK SYNC - DETAILS BELOW",
    )
    throw error
  }
}

/**
 * Sync tickets from Zoho Desk
 */
async function syncTickets(
  client: ZohoDeskClient,
  connector: SelectConnector,
  lastModifiedTime: string | undefined,
  metrics: ZohoSyncMetrics,
  ingestion: SelectIngestion,
): Promise<void> {
  let from = 1
  const limit = 100
  let hasMore = true

  Logger.info(
    "📊 SYNC TICKETS: Starting ticket sync with timestamp filter"
  )

  while (hasMore) {
    Logger.info("📥 Fetching tickets batch")

    // Fetch tickets sorted by modifiedTime descending (newest first)
    const response = await client.fetchTickets({
      limit,
      from,
    })

    const tickets = response.data || []

    Logger.info(
      "Fetched tickets batch"
    )

    if (tickets.length === 0) {
      hasMore = false
      break
    }

    // Fetch detailed info for the LAST ticket to check if we should continue
    const lastTicket = tickets[tickets.length - 1]
  

    const lastTicketDetail = await client.fetchTicketById(lastTicket.id)
    const lastTicketModifiedTime = lastTicketDetail.modifiedTime

   

    // Determine if this should be the last batch
    const shouldStopAfterBatch =
      lastModifiedTime && lastTicketModifiedTime <= lastModifiedTime


    Logger.info(
      "🔍 Batch boundary check"
    )

    // Queue all tickets in this batch (workers will filter when processing)
    let queuedInBatch = 0

    for (const ticket of tickets) {
      try {
        const ticketJob: TicketJob = {
          ticketId: ticket.id,
          connectorId: connector.id,
          workspaceExternalId: connector.workspaceExternalId!,
          ingestionId: ingestion.id,
          lastModifiedTime: lastModifiedTime, // Pass sync threshold for worker filtering
        }

        await boss.send(ProcessZohoDeskTicketQueue, ticketJob, {
          retryLimit: 2,
          expireInHours: 23,
          singletonKey: `zoho-ticket-${ticket.id}`,
        })

        metrics.ticketsFetched++
        queuedInBatch++

      } catch (error) {
        metrics.errors++
        Logger.error(
          {
            ticketId: ticket.id,
            ticketNumber: ticket.ticketNumber,
            errorMessage:
              error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            ticketJobData: {
              ticketId: ticket.id,
              connectorId: connector.id,
              workspaceExternalId: connector.workspaceExternalId,
              ingestionId: ingestion.id,
              lastModifiedTime: lastModifiedTime,
            },
          },
          "❌ ERROR QUEUING TICKET - DETAILS",
        )
        // Continue queuing other tickets
      }
    }

    const batchNum = Math.floor((from - 1) / limit) + 1
  
    Logger.info(
      `📊 Batch ${batchNum} summary: Queued ${queuedInBatch} tickets`
    )

    // Update ingestion metadata after processing each batch
    const updatedMetadata: { zohoDesk: ZohoDeskIngestionMetadata } = {
      zohoDesk: {
        websocketData: {
          connectorId: connector.id.toString(),
          progress: {
            totalTickets: metrics.ticketsFetched,
            processedTickets: 0, // Will be updated by workers
            ticketsWithAttachments: 0, // Will be updated by workers
            totalAttachments: 0, // Will be updated by workers
            processedAttachments: 0, // Will be updated by workers
            errors: metrics.errors,
          },
        },
      },
    }

    await updateIngestionMetadata(db, ingestion.id, updatedMetadata)

    // Stop if last ticket was old
    if (shouldStopAfterBatch) {

      Logger.info(
        `🏁 SYNC COMPLETE: Queued ${metrics.ticketsFetched} tickets`
      )
      hasMore = false
      break
    }

    // Check if we need to fetch more
    if (tickets.length < limit) {
      hasMore = false
    } else {
      from += limit
    }
  }

  Logger.info(
    `✅ TICKET SYNC COMPLETE: Queued ${metrics.ticketsFetched} tickets`
  )
}

/**
 * Get Zoho connector with credentials
 */
async function getZohoConnector(
  connectorId: number,
): Promise<SelectConnector | null> {
  const results = await db
    .select()
    .from(connectors)
    .where(eq(connectors.id, connectorId))
    .limit(1)

  return (results[0] as SelectConnector) || null
}

/**
 * Get all Zoho Desk connectors
 * Only returns ADMIN connectors (with credentials field) for syncing
 * User OAuth connectors (with only oauthCredentials) are skipped
 */
async function getAllZohoDeskConnectors(): Promise<SelectConnector[]> {
  const results = await db
    .select()
    .from(connectors)
    .where(eq(connectors.app, Apps.ZohoDesk))

  // Filter to only admin connectors (those with credentials field)
  const adminConnectors = results.filter(
    (c) => c.credentials !== null && c.credentials !== undefined,
  )

  return adminConnectors as SelectConnector[]
}
