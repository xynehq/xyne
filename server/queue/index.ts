import {
  handleGoogleOAuthIngestion,
  handleGoogleServiceAccountIngestion,
  syncGoogleWorkspace,
} from "@/integrations/google"
import { ConnectorType, Subsystem, type SaaSJob } from "@/types"
import PgBoss from "pg-boss"
import config from "@/config"
import { Apps, AuthType } from "@/shared/types"
import {
  handleGoogleOAuthChanges,
  handleGoogleServiceAccountChanges,
} from "@/integrations/google/sync"
import { checkDownloadsFolder } from "@/integrations/google/utils"
import { getLogger } from "@/logger"
import { getErrorMessage } from "@/utils"
import { handleSlackIngestion } from "@/integrations/slack"
import { handleWhatsAppIngestion } from "@/integrations/whatsapp"
import type { Job } from "pg-boss"

const Logger = getLogger(Subsystem.Queue)
const JobExpiryHours = config.JobExpiryHours

const url = `postgres://xyne:xyne@${config.postgresBaseHost}:5432/xyne`
export const boss = new PgBoss({
  connectionString: url,
  monitorStateIntervalMinutes: 1, // Monitor state every minute
  archiveCompletedAfterSeconds: 3600, // Archive completed jobs after 1 hour
})

// run it if we are re-doing ingestion
// await boss.clearStorage()

export const SaaSQueue = `ingestion-${ConnectorType.SaaS}`
export const SyncOAuthSaaSQueue = `sync-${ConnectorType.SaaS}-${AuthType.OAuth}`
export const SyncServiceAccountSaaSQueue = `sync-${ConnectorType.SaaS}-${AuthType.ServiceAccount}`
export const SyncGoogleWorkspace = `sync-${Apps.GoogleWorkspace}-${AuthType.ServiceAccount}`
export const CheckDownloadsFolderQueue = `check-downloads-folder`

const Every10Minutes = `*/10 * * * *`
const EveryHour = `0 * * * *`
const Every6Hours = `0 */6 * * *`
const EveryWeek = `0 0 */7 * *`
const EveryMin = `*/1 * * * *`

export const init = async () => {
  Logger.info("Starting queue initialization...")
  
  Logger.info("Starting pg-boss...")
  await boss.start()
  Logger.info("pg-boss started successfully")
  
  Logger.info("Creating queues...")
  await boss.createQueue(SaaSQueue)
  await boss.createQueue(SyncOAuthSaaSQueue)
  await boss.createQueue(SyncServiceAccountSaaSQueue)
  await boss.createQueue(SyncGoogleWorkspace)
  await boss.createQueue(CheckDownloadsFolderQueue)
  Logger.info("All queues created successfully")
  
  Logger.info("Initializing workers...")
  await initWorkers()
  Logger.info("Workers initialized successfully")
  
  Logger.info("Queue system fully initialized")
}

// when the Service account is connected
export const setupServiceAccountCronjobs = async () => {
  Logger.info("Setting up service account cronjobs...")
  await boss.schedule(
    SyncServiceAccountSaaSQueue,
    Every10Minutes,
    {},
    { retryLimit: 0, expireInHours: JobExpiryHours },
  )
  await boss.schedule(
    SyncGoogleWorkspace,
    Every6Hours,
    {},
    { retryLimit: 0, expireInHours: JobExpiryHours },
  )
  Logger.info("Service account cronjobs set up successfully")
}

const initWorkers = async () => {
  Logger.info("Starting worker initialization...")
  await boss.work(SaaSQueue, async ([job]) => {
    const start = new Date()
    Logger.info(`Processing SaaSQueue job ${job.id} started at ${start}`)
    const jobData: SaaSJob = job.data as SaaSJob
    Logger.info(`Job data: ${JSON.stringify(jobData, null, 2)}`)
    
    try {
      if (
        jobData.app === Apps.GoogleDrive &&
        jobData.authType === AuthType.ServiceAccount
      ) {
        Logger.info("Handling Google Service Account Ingestion from Queue")
        // await handleGoogleServiceAccountIngestion(boss, job)
      } else if (
        jobData.app === Apps.GoogleDrive &&
        jobData.authType === AuthType.OAuth
      ) {
        Logger.info("Handling Google OAuth Ingestion from Queue")
        // await handleGoogleOAuthIngestion(boss, job)
      } else if (
        jobData.app == Apps.Slack &&
        jobData.authType === AuthType.OAuth
      ) {
        Logger.info("Handling Slack Ingestion from Queue")
        await handleSlackIngestion(boss, job)
      } else if (jobData.app === Apps.WhatsApp && jobData.authType === AuthType.Custom) {
        Logger.info(`Starting WhatsApp Ingestion for job ${job.id} with connector ${jobData.externalId}`)
        await handleWhatsAppIngestion(boss, job)
        Logger.info(`Completed WhatsApp Ingestion for job ${job.id}`)
      } else {
        Logger.error(`Unsupported job type: ${jobData.app} with auth type ${jobData.authType}`)
        throw new Error("Unsupported job")
      }
      
      const end = new Date()
      const duration = end.getTime() - start.getTime()
      Logger.info(`Job ${job.id} completed successfully in ${duration}ms`)
    } catch (error: any) {
      Logger.error(error, `Error processing job ${job.id}: ${error.message}`)
      await boss.fail(job.name, job.id)
      throw error;
    }
  })

  // do not retry
  Logger.info("Setting up scheduled jobs...")
  await boss.schedule(
    SyncOAuthSaaSQueue,
    Every10Minutes,
    {},
    { retryLimit: 0, expireInHours: JobExpiryHours },
  )
  await boss.schedule(
    CheckDownloadsFolderQueue,
    EveryWeek,
    {},
    { retryLimit: 0, expireInHours: JobExpiryHours },
  )

  await setupServiceAccountCronjobs()

  Logger.info("Setting up SyncOAuthSaaSQueue worker...")
  await boss.work(SyncOAuthSaaSQueue, async ([job]) => {
    try {
      await handleGoogleOAuthChanges(boss, job)
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      Logger.error(
        error,
        `Unhandled Error while syncing OAuth SaaS ${errorMessage} ${(error as Error).stack}`,
      )
    }
  })

  Logger.info("Setting up SyncServiceAccountSaaSQueue worker...")
  await boss.work(SyncServiceAccountSaaSQueue, async ([job]) => {
    await handleGoogleServiceAccountChanges(boss, job)
  })

  Logger.info("Setting up SyncGoogleWorkspace worker...")
  await boss.work(SyncGoogleWorkspace, async ([job]) => {
    await syncGoogleWorkspace(boss, job)
  })

  Logger.info("Setting up CheckDownloadsFolderQueue worker...")
  await boss.work(CheckDownloadsFolderQueue, async ([job]) => {
    await checkDownloadsFolder(boss, job)
  })
  
  Logger.info("All workers initialized successfully")
}

export const ProgressEvent = "progress-event"

boss.on("error", (error) => {
  Logger.error(error, `Queue error: ${error} ${(error as Error).stack}`)
})

boss.on("monitor-states", (states) => {
  Logger.info(`Queue States: ${JSON.stringify(states, null, 2)}`)
})

boss.on("job", (job: Job) => {
  Logger.info(`New job received: ${JSON.stringify({
    id: job.id,
    name: job.name,
    data: job.data
  }, null, 2)}`)
})

boss.on("failed", (job: Job) => {
  Logger.error(`Job failed: ${JSON.stringify({
    id: job.id,
    name: job.name,
    data: job.data
  }, null, 2)}`)
})

boss.on("completed", (job: Job) => {
  Logger.info(`Job completed: ${JSON.stringify({
    id: job.id,
    name: job.name,
    data: job.data
  }, null, 2)}`)
})
