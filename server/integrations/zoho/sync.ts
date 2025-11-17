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
  ticketsInserted: number
  ticketsUpdated: number
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

  Logger.info("✅ ZOHO SYNC HANDLER: Job received", {
    jobId: job.id,
    specificConnectorId: specificConnectorId || "all connectors",
  })

  let connectorsToSync: SelectConnector[] = []

  if (specificConnectorId) {
    // Sync specific connector
    Logger.info("✅ ZOHO SYNC HANDLER: Fetching specific connector", {
      connectorId: specificConnectorId,
    })
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
      `✅ ZOHO SYNC HANDLER: Found ${connectorsToSync.length} connectors`,
      {
        connectorIds: connectorsToSync.map((c) => c.id),
      },
    )
  }

  if (connectorsToSync.length === 0) {
    Logger.info("⚠️  ZOHO SYNC HANDLER: No connectors found to sync")
    return
  }

  // Process each connector
  for (const connector of connectorsToSync) {
    try {
      Logger.info("🔄 ZOHO SYNC HANDLER: Processing connector", {
        connectorId: connector.id,
        userId: connector.userId,
      })
      await syncConnector(connector)
      Logger.info("✅ ZOHO SYNC HANDLER: Connector synced successfully", {
        connectorId: connector.id,
      })
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
    ticketsInserted: 0,
    ticketsUpdated: 0,
    ticketsWithAttachments: 0,
    totalAttachments: 0,
    errors: 0,
    startTime: Date.now(),
  }

  Logger.info("🔄 SYNC CONNECTOR: Starting sync", { connectorId })

  try {
    Logger.info("✅ SYNC CONNECTOR: Connector retrieved", {
      connectorId,
      workspaceId: connector.workspaceId,
      userId: connector.userId,
      app: connector.app,
    })

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

      const credentials = JSON.parse(connector.credentials as string)

      Logger.info("✅ SYNC CONNECTOR: Admin credentials loaded", {
        connectorId,
        hasOrgId: !!credentials.orgId,
        hasClientId: !!credentials.clientId,
        hasRefreshToken: !!credentials.refreshToken,
      })

      const client = new ZohoDeskClient({
        orgId: credentials.orgId || config.ZohoOrgId,
        clientId: credentials.clientId || config.ZohoClientId,
        clientSecret: credentials.clientSecret || config.ZohoClientSecret,
        refreshToken: credentials.refreshToken,
      })

      Logger.info(
        "✅ SYNC CONNECTOR: Zoho client initialized with admin token",
        { connectorId },
      )

      // 4. Get last sync time from connector state
      const state = connector.state as ZohoDeskOAuthIngestionState | {}
      let lastModifiedTime: string | undefined =
        "lastModifiedTime" in state ? state.lastModifiedTime : undefined

      const now = new Date().toISOString()

      // For first-time sync, fetch tickets from the past year
      if (!lastModifiedTime) {
        const oneYearAgo = new Date()
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
        lastModifiedTime = oneYearAgo.toISOString()
        console.log("\n🆕 FIRST-TIME SYNC - Fetching from past year")
        console.log(`   Start Date: ${lastModifiedTime}`)
        console.log(`   End Date: ${now}`)
        console.log(`   Connector ID: ${connectorId}`)
        Logger.info(
          "🆕 SYNC CONNECTOR: FIRST-TIME SYNC - Fetching from past year",
          {
            startDate: lastModifiedTime,
            endDate: now,
            connectorId,
            timeRange: `${lastModifiedTime} → ${now}`,
          },
        )
      } else {
        console.log("\n🔄 INCREMENTAL SYNC - Only fetching modified tickets")
        console.log(`   Last Sync Time: ${lastModifiedTime}`)
        console.log(`   Current Time: ${now}`)
        console.log(`   Connector ID: ${connectorId}`)
        console.log(
          `   ⏰ Will only process tickets modified AFTER: ${lastModifiedTime}\n`,
        )
        Logger.info(
          "🔄 SYNC CONNECTOR: INCREMENTAL SYNC - Only fetching modified tickets",
          {
            lastSyncTime: lastModifiedTime,
            currentTime: now,
            connectorId,
            timeRange: `${lastModifiedTime} → ${now}`,
            message:
              "⏰ Will only process tickets modified after last sync timestamp",
          },
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

      console.log("\n📝 CONNECTOR STATE UPDATED")
      console.log(`   Connector ID: ${connectorId}`)
      console.log(`   Previous sync time: ${lastModifiedTime}`)
      console.log(`   New sync time: ${newLastModifiedTime}`)
      console.log(
        `   🔄 Next sync will only process tickets modified after: ${newLastModifiedTime}\n`,
      )

      Logger.info("📝 Updated connector state with new sync timestamp", {
        connectorId,
        previousLastModifiedTime: lastModifiedTime,
        newLastModifiedTime,
        message: `🔄 Next sync will only process tickets modified after ${newLastModifiedTime}`,
      })

      // 8. Insert sync history
      metrics.endTime = Date.now()
      const duration = metrics.endTime - metrics.startTime

      await insertSyncHistory(db, {
        workspaceId: connector.workspaceId,
        workspaceExternalId: connector.workspaceExternalId,
        dataAdded: metrics.ticketsInserted,
        dataUpdated: metrics.ticketsUpdated,
        dataDeleted: 0,
        authType: AuthType.OAuth,
        app: Apps.ZohoDesk,
        type: SyncCron.Partial,
        status: SyncJobStatus.Successful,
        summary: {
          ticketsFetched: metrics.ticketsFetched,
          ticketsInserted: metrics.ticketsInserted,
          ticketsUpdated: metrics.ticketsUpdated,
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
        ticketsFetched: metrics.ticketsFetched,
        ticketsInserted: metrics.ticketsInserted,
        ticketsUpdated: metrics.ticketsUpdated,
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
        dataAdded: metrics.ticketsInserted,
        dataUpdated: metrics.ticketsUpdated,
        dataDeleted: 0,
        authType: AuthType.OAuth,
        app: Apps.ZohoDesk,
        type: SyncCron.Partial,
        status: SyncJobStatus.Failed,
        summary: {
          ticketsFetched: metrics.ticketsFetched,
          ticketsInserted: metrics.ticketsInserted,
          ticketsUpdated: metrics.ticketsUpdated,
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
  ingestion: any,
): Promise<void> {
  let from = 1
  const limit = 100
  let hasMore = true

  console.log("\n📊 TICKET SYNC START")
  console.log(
    `   Timestamp Filter: ${lastModifiedTime || "NONE (fetching all)"}`,
  )
  if (lastModifiedTime) {
    console.log(
      `   ⏰ Will SKIP tickets with modifiedTime <= ${lastModifiedTime}`,
    )
  }
  console.log("")

  Logger.info("📊 SYNC TICKETS: Starting ticket sync with timestamp filter", {
    lastModifiedTime,
    message: lastModifiedTime
      ? `⏰ Will skip tickets with modifiedTime <= ${lastModifiedTime}`
      : "📥 No timestamp filter - fetching all tickets",
  })

  while (hasMore) {
    Logger.info("📥 Fetching tickets batch", { from, limit, lastModifiedTime })

    // Fetch tickets sorted by modifiedTime descending (newest first)
    const response = await client.fetchTickets({
      limit,
      from,
    })

    const tickets = response.data || []

    Logger.info("Fetched tickets batch", {
      count: tickets.length,
      from,
      totalFetched: metrics.ticketsFetched,
    })

    if (tickets.length === 0) {
      hasMore = false
      break
    }

    // Fetch detailed info for the LAST ticket to check if we should continue
    const lastTicket = tickets[tickets.length - 1]
    console.log(`\n🔍 BATCH BOUNDARY CHECK`)
    console.log(
      `   Fetching details for last ticket in batch: ${lastTicket.ticketNumber || lastTicket.id}`,
    )

    const lastTicketDetail = await client.fetchTicketById(lastTicket.id)
    const lastTicketModifiedTime = lastTicketDetail.modifiedTime

    console.log(`   Last ticket modified: ${lastTicketModifiedTime}`)
    console.log(`   Last sync threshold: ${lastModifiedTime}`)

    // Determine if this should be the last batch
    const shouldStopAfterBatch =
      lastModifiedTime && lastTicketModifiedTime <= lastModifiedTime

    if (shouldStopAfterBatch) {
      console.log(
        `   ⏹️  Last ticket is older than threshold - will stop after this batch\n`,
      )
    } else {
      console.log(
        `   ✅ Last ticket is newer than threshold - will continue after this batch\n`,
      )
    }

    Logger.info("🔍 Batch boundary check", {
      lastTicketId: lastTicket.id,
      lastTicketNumber: lastTicket.ticketNumber,
      lastTicketModifiedTime,
      lastSyncThreshold: lastModifiedTime,
      shouldStopAfterBatch,
    })

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

        // Log first 5 and every 10th ticket to avoid spam
        if (metrics.ticketsFetched <= 5 || metrics.ticketsFetched % 10 === 0) {
          console.log(
            `✅ Queued ticket #${metrics.ticketsFetched}: ${ticket.ticketNumber || ticket.id}`,
          )
        }

        Logger.info("✅ Queued ticket for processing", {
          ticketId: ticket.id,
          ticketNumber: ticket.ticketNumber,
          queuedSoFar: metrics.ticketsFetched,
          lastModifiedTimeThreshold: lastModifiedTime,
        })
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
    console.log(`\n📊 BATCH ${batchNum} SUMMARY:`)
    console.log(`   Tickets in batch: ${tickets.length}`)
    console.log(`   Queued: ${queuedInBatch}`)
    console.log(`   Total queued so far: ${metrics.ticketsFetched}`)
    console.log(
      `   Stop after this batch? ${shouldStopAfterBatch ? "YES" : "NO"}\n`,
    )

    Logger.info("📊 Batch processing summary", {
      batchNumber: batchNum,
      ticketsInBatch: tickets.length,
      queuedInBatch,
      totalQueuedSoFar: metrics.ticketsFetched,
      shouldStopAfterBatch,
    })

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

    Logger.info("Updated ingestion metadata - tickets queued for processing", {
      ingestionId: ingestion.id,
      queuedTickets: tickets.length,
      totalFetched: metrics.ticketsFetched,
    })

    // Stop if last ticket was old
    if (shouldStopAfterBatch) {
      console.log(
        `\n🏁 SYNC COMPLETE - Last ticket in batch was older than threshold`,
      )
      console.log(`   Total tickets queued: ${metrics.ticketsFetched}`)
      console.log(`   Last sync timestamp: ${lastModifiedTime}\n`)

      Logger.info("🏁 SYNC COMPLETE: Last ticket was older than threshold", {
        totalTicketsQueued: metrics.ticketsFetched,
        lastModifiedTime,
      })
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

  console.log("\n✅ TICKET SYNC COMPLETE")
  console.log(`   Total tickets queued: ${metrics.ticketsFetched}`)
  console.log(`   Sync type: ${lastModifiedTime ? "INCREMENTAL" : "FULL"}`)
  if (lastModifiedTime) {
    console.log(`   Only processed tickets modified after: ${lastModifiedTime}`)
  }
  console.log("")

  Logger.info("✅ TICKET SYNC COMPLETE", {
    totalTicketsQueued: metrics.ticketsFetched,
    lastModifiedTimeFilter: lastModifiedTime,
    message: lastModifiedTime
      ? `📊 Incremental sync: Only processed tickets modified after ${lastModifiedTime}`
      : "📊 Full sync: Processed all tickets",
  })
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

  Logger.info("✅ Filtered to admin connectors only", {
    totalConnectors: results.length,
    adminConnectors: adminConnectors.length,
    userOAuthConnectors: results.length - adminConnectors.length,
  })

  return adminConnectors as SelectConnector[]
}
