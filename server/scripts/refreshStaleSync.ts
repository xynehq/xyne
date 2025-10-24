import { ServiceAccountIngestMoreUsers } from "@/scripts/refreshSyncToken"
import { getLogger } from "@/logger"
import { db } from "@/db/client"
import { getConnector } from "@/db/connector"
import { Apps, AuthType, SyncJobStatus } from "@/shared/types"
import { Subsystem } from "@/types"
import type { GoogleServiceAccount } from "@/types"
import pLimit from "p-limit"
import { google } from "googleapis"
import { getWorkspaceById } from "@/db/workspace"
import { createJwtClient } from "@/integrations/google/utils"
import { syncJobs } from "@/db/schema"
import { eq, and, lt } from "drizzle-orm"
import { getAppSyncJobsByEmail } from "@/db/syncJob"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "RefreshStaleServiceAccountSyncJobs",
})

interface ProcessingStats {
  total: number
  completed: number
  failed: number
  inProgress: number
  startTime: Date
}

interface UserSyncJobInfo {
  email: string
  connectorId: number
  workspaceId: number
  oldestLastRanOn: Date
  syncJobs: {
    drive?: any
    gmail?: any
    calendar?: any
  }
  needsRefresh: boolean
}

interface Batch {
  id: number
  users: UserSyncJobInfo[]
}

const STALE_THRESHOLD_DAYS = 7
const MAX_CONCURRENT_WORKERS = 10
const BATCH_SIZE = 10

class StaleServiceAccountSyncJobProcessor {
  private stats: ProcessingStats
  private failedUsers: { email: string; error: string }[] = []
  private batchQueue: Batch[] = []

  constructor(private users: UserSyncJobInfo[]) {
    this.stats = {
      total: users.length,
      completed: 0,
      failed: 0,
      inProgress: 0,
      startTime: new Date(),
    }

    this.initializeBatchQueue()
  }

  private initializeBatchQueue(): void {
    // Create batches and push them to the queue
    for (let i = 0; i < this.users.length; i += BATCH_SIZE) {
      const batchUsers = this.users.slice(i, i + BATCH_SIZE)

      const batch: Batch = {
        id: Math.floor(i / BATCH_SIZE) + 1,
        users: batchUsers,
      }
      this.batchQueue.push(batch)
    }

    Logger.info(`📦 Created ${this.batchQueue.length} batches in the queue`)
    Logger.info("📋 Batch Queue Overview:")
    this.batchQueue.forEach((batch) => {
      Logger.info(`  📦 Batch ${batch.id}: ${batch.users.length} users`)
      batch.users.forEach(({ email, oldestLastRanOn }) => {
        const daysSinceLastRun = Math.floor(
          (Date.now() - oldestLastRanOn.getTime()) / (1000 * 60 * 60 * 24),
        )
        Logger.info(`    👤 ${email}: last run ${daysSinceLastRun} days ago`)
      })
    })
  }

  private logProgress() {
    const { completed, failed, total, inProgress } = this.stats
    const percentage = Math.round(((completed + failed) / total) * 100)
    const elapsed = Date.now() - this.stats.startTime.getTime()
    const elapsedMinutes = Math.round(elapsed / 60000)

    Logger.info(
      `Progress: ${completed + failed}/${total} (${percentage}%) | ` +
        `Completed: ${completed} | Failed: ${failed} | In Progress: ${inProgress} | ` +
        `Batches remaining: ${this.batchQueue.length} | Elapsed: ${elapsedMinutes}m`,
    )
  }

  private async processOneUser(
    userInfo: UserSyncJobInfo,
    connector: any,
  ): Promise<void> {
    const userStartTime = Date.now()
    const { email, oldestLastRanOn, syncJobs } = userInfo

    this.stats.inProgress++

    const daysSinceLastRun = Math.floor(
      (Date.now() - oldestLastRanOn.getTime()) / (1000 * 60 * 60 * 24),
    )
    Logger.info(
      `🚀 Starting Drive refresh for: ${email} (last run ${daysSinceLastRun} days ago)`,
    )

    // Only refresh Drive and Contacts since we're focusing on Drive sync jobs
    const hasDriveJob = !!syncJobs.drive

    Logger.info(
      `📋 Refreshing Drive & Contacts for ${email}: ${hasDriveJob ? "✅" : "❌"}`,
    )

    if (!hasDriveJob) {
      Logger.warn(`⚠️  No Drive sync job found for ${email}, skipping refresh`)
      this.stats.failed++
      this.stats.inProgress--
      this.failedUsers.push({ email, error: "No Drive sync job found" })
      this.logProgress()
      return
    }

    try {
      // Use the oldest lastRanOn as start date, current date as end date
      const startDate = oldestLastRanOn.toISOString().split("T")[0] // YYYY-MM-DD format
      const endDate = new Date().toISOString().split("T")[0] // Current date in YYYY-MM-DD format

      Logger.info(`📅 Date range for ${email}: ${startDate} to ${endDate}`)

      const ingestionPayload = {
        connectorId: connector.externalId,
        emailsToIngest: [email],
        startDate,
        endDate,
        insertDriveAndContacts: true, // Only refresh Drive and Contacts
        insertGmail: false, // Skip Gmail refresh
        insertCalendar: false, // Skip Calendar refresh
      }

      await ServiceAccountIngestMoreUsers(
        ingestionPayload,
        connector.userId,
        false,
      )

      const userElapsed = Math.round((Date.now() - userStartTime) / 1000)
      this.stats.completed++
      this.stats.inProgress--
      Logger.info(
        `✅ Completed Drive refresh for: ${email} (processed in ${userElapsed}s)`,
      )
    } catch (error) {
      const userElapsed = Math.round((Date.now() - userStartTime) / 1000)
      this.stats.failed++
      this.stats.inProgress--
      const errorMessage = (error as Error).message
      this.failedUsers.push({ email, error: errorMessage })
      Logger.error(
        error,
        `❌ Failed Drive refresh for: ${email} after ${userElapsed}s - ${errorMessage}`,
      )
    }

    this.logProgress()
  }

  private async processBatch(batch: Batch, connector: any): Promise<void> {
    const batchStartTime = Date.now()

    Logger.info("=".repeat(50))
    Logger.info(`🚀 STARTING BATCH ${batch.id}`)
    Logger.info("=".repeat(50))
    Logger.info(`📊 Batch ${batch.id} Details:`)
    Logger.info(`  👥 Users: ${batch.users.length}`)
    Logger.info(`  📋 User breakdown:`)

    batch.users.forEach(({ email, oldestLastRanOn }, index) => {
      const daysSinceLastRun = Math.floor(
        (Date.now() - oldestLastRanOn.getTime()) / (1000 * 60 * 60 * 24),
      )
      Logger.info(
        `    ${index + 1}. ${email}: last run ${daysSinceLastRun} days ago`,
      )
    })

    Logger.info(`\n🎯 Processing ${batch.users.length} users concurrently...`)

    // Process all users in the batch concurrently with limit
    const limit = pLimit(MAX_CONCURRENT_WORKERS)
    const batchPromises = batch.users.map((userInfo) =>
      limit(() => this.processOneUser(userInfo, connector)),
    )

    // Wait for entire batch to complete
    await Promise.allSettled(batchPromises)

    const batchElapsed = Math.round((Date.now() - batchStartTime) / 60000)
    Logger.info("=".repeat(50))
    Logger.info(`✅ BATCH ${batch.id} COMPLETED`)
    Logger.info("=".repeat(50))
    Logger.info(`⏱️  Batch ${batch.id} processing time: ${batchElapsed} minutes`)
    Logger.info(`🎯 Moving to next batch in queue...\n`)
  }

  async processAllBatches(connector: any): Promise<void> {
    try {
      const totalBatches = this.batchQueue.length
      Logger.info(
        `🎯 Starting queue-based batch processing for ${this.users.length} users in ${totalBatches} batches`,
      )

      // Process batches one by one from the queue
      while (this.batchQueue.length > 0) {
        // Take one batch from the front of the queue
        const currentBatch = this.batchQueue.shift()!

        Logger.info(
          `📤 Dequeued Batch ${currentBatch.id} (${this.batchQueue.length} batches remaining in queue)`,
        )

        // Process the batch
        await this.processBatch(currentBatch, connector)
      }

      // Final summary
      this.logFinalSummary()
    } catch (error) {
      Logger.error(
        error,
        `Fatal error in queue-based batch processing: ${(error as Error).message}`,
      )
      throw error
    }
  }

  private logFinalSummary() {
    const { completed, failed, total } = this.stats
    const elapsed = Date.now() - this.stats.startTime.getTime()
    const elapsedMinutes = Math.round(elapsed / 60000)

    Logger.info("=".repeat(60))
    Logger.info("🎉 STALE DRIVE SYNC JOB REFRESH COMPLETED")
    Logger.info("=".repeat(60))
    Logger.info(`📊 Total users with stale Drive sync jobs: ${total}`)
    Logger.info(`✅ Successfully refreshed Drive sync: ${completed}`)
    Logger.info(`❌ Failed Drive sync refresh: ${failed}`)
    Logger.info(`⏱️  Total time: ${elapsedMinutes} minutes`)
    Logger.info(`📈 Success rate: ${Math.round((completed / total) * 100)}%`)
    Logger.info(`📦 Total batches processed: ${Math.ceil(total / BATCH_SIZE)}`)
    Logger.info(`💾 Service: Google Drive & Contacts only`)

    if (this.failedUsers.length > 0) {
      Logger.info("\n❌ Failed Drive refresh users:")
      this.failedUsers.forEach(({ email, error }) => {
        Logger.error(`  - ${email}: ${error}`)
      })
    }

    Logger.info("=".repeat(60))
  }
}

// Function to get all stale service account sync jobs (Drive only)
const getStaleServiceAccountSyncJobs = async (): Promise<UserSyncJobInfo[]> => {
  Logger.info("🔍 Fetching all Google Drive service account sync jobs...")

  // Calculate the threshold date (7 days ago)
  const thresholdDate = new Date()
  thresholdDate.setDate(thresholdDate.getDate() - STALE_THRESHOLD_DAYS)

  Logger.info(
    `📅 Threshold date: ${thresholdDate.toISOString()} (${STALE_THRESHOLD_DAYS} days ago)`,
  )

  // Get only Google Drive service account sync jobs
  const allServiceAccountSyncJobs = await db
    .select()
    .from(syncJobs)
    .where(
      and(
        eq(syncJobs.authType, AuthType.ServiceAccount),
        eq(syncJobs.app, Apps.GoogleDrive),
      ),
    )

  Logger.info(
    `📊 Found ${allServiceAccountSyncJobs.length} total Google Drive service account sync jobs`,
  )

  // Group sync jobs by email
  const syncJobsByEmail = new Map<string, any[]>()

  for (const job of allServiceAccountSyncJobs) {
    if (!syncJobsByEmail.has(job.email)) {
      syncJobsByEmail.set(job.email, [])
    }
    syncJobsByEmail.get(job.email)!.push(job)
  }

  Logger.info(`👥 Found sync jobs for ${syncJobsByEmail.size} unique users`)

  const staleUsers: UserSyncJobInfo[] = []

  // Check each user's Drive sync jobs
  for (const [email, userSyncJobs] of syncJobsByEmail.entries()) {
    // Since we're only fetching Drive sync jobs, find the oldest lastRanOn date among Drive sync jobs for this user
    let oldestLastRanOn = new Date()
    const syncJobsMap: any = {}

    for (const job of userSyncJobs) {
      // Only process Drive sync jobs (which should be all jobs since we filtered)
      if (job.app === Apps.GoogleDrive) {
        if (job.lastRanOn && job.lastRanOn < oldestLastRanOn) {
          oldestLastRanOn = job.lastRanOn
        }
        syncJobsMap.drive = job
      }
    }

    // Only proceed if we have a Drive sync job
    if (!syncJobsMap.drive) {
      Logger.warn(`⚠️  No Drive sync job found for user: ${email}, skipping`)
      continue
    }

    // Check if the Drive sync job's lastRanOn is older than threshold
    const isStale = oldestLastRanOn < thresholdDate
    const daysSinceLastRun = Math.floor(
      (Date.now() - oldestLastRanOn.getTime()) / (1000 * 60 * 60 * 24),
    )

    if (isStale) {
      Logger.info(
        `⚠️  Stale Drive sync found: ${email} (last run ${daysSinceLastRun} days ago)`,
      )

      staleUsers.push({
        email,
        connectorId: userSyncJobs[0].connectorId, // All jobs should have same connectorId
        workspaceId: userSyncJobs[0].workspaceId,
        oldestLastRanOn,
        syncJobs: syncJobsMap,
        needsRefresh: true,
      })
    } else {
      Logger.info(
        `✅ Drive sync up to date: ${email} (last run ${daysSinceLastRun} days ago)`,
      )
    }
  }

  Logger.info(
    `🎯 Found ${staleUsers.length} users with stale sync jobs that need refresh`,
  )

  return staleUsers
}

// Main execution
const runStaleServiceAccountSyncJobRefresh = async () => {
  try {
    Logger.info("🚀 Starting stale Drive sync job refresh process...")

    // Get all stale Drive service account sync jobs
    const staleUsers = await getStaleServiceAccountSyncJobs()

    if (staleUsers.length === 0) {
      Logger.info(
        "✅ No stale Drive sync jobs found. All Drive syncs are up to date!",
      )
      return
    }

    // Get connector info (assuming all users use the same service account connector)
    const firstUser = staleUsers[0]
    const connector = await getConnector(db, firstUser.connectorId)

    if (!connector) {
      throw new Error(`Connector with ID ${firstUser.connectorId} not found.`)
    }

    Logger.info(`🔗 Using connector: ${connector.externalId}`)

    // Start batch processing
    Logger.info(
      "✅ Starting queue-based batch processing for Drive sync refresh...",
    )
    const processor = new StaleServiceAccountSyncJobProcessor(staleUsers)
    await processor.processAllBatches(connector)

    Logger.info("🎉 Stale Drive sync job refresh completed successfully!")
  } catch (error) {
    Logger.error(
      error,
      `Stale Drive sync job refresh failed: ${(error as Error).message}`,
    )
    throw error
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  Logger.info("Received SIGINT, shutting down gracefully...")
  process.exit(0)
})

process.on("SIGTERM", () => {
  Logger.info("Received SIGTERM, shutting down gracefully...")
  process.exit(0)
})

// Run if this file is executed directly
if (require.main === module) {
  runStaleServiceAccountSyncJobRefresh()
    .then(() => {
      Logger.info("✅ Script completed successfully")
      process.exit(0)
    })
    .catch((error) => {
      Logger.error(error, "❌ Script failed")
      process.exit(1)
    })
}
