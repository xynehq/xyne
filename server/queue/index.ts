import config from "@/config"
import { db } from "@/db/client"
import { getAppSyncJobs } from "@/db/syncJob"
import {
  handleGoogleOAuthIngestion,
  handleGoogleServiceAccountIngestion,
  syncGoogleWorkspace,
} from "@/integrations/google"
import {
  handleGoogleOAuthChanges,
  handleGoogleServiceAccountChanges,
} from "@/integrations/google/sync"
import { checkDownloadsFolder } from "@/integrations/google/utils"
import {
  handleMicrosoftOAuthChanges,
  handleMicrosoftServiceAccountChanges,
} from "@/integrations/microsoft/sync"
import { handleSlackIngestion } from "@/integrations/slack"
import { handleSlackChanges } from "@/integrations/slack/sync"
import { getLogger } from "@/logger"
import {
  syncJobDuration,
  syncJobError,
  syncJobSuccess,
} from "@/metrics/sync/sync-metrics"
import { ConnectorType, SlackEntity } from "@/shared/types" // ConnectorType added
import { Apps, AuthType } from "@/shared/types"
import { type SaaSJob, Subsystem } from "@/types" // ConnectorType removed
import { getErrorMessage } from "@/utils"
import { Auth } from "googleapis"
import PgBoss from "pg-boss"
import { handleAttachmentCleanup } from "./attachmentCleanup"
import { handleToolSync } from "./toolSync"

import {
  type AttachmentJob,
  type TicketJob,
  processAttachmentJob,
  processTicketJob,
} from "@/integrations/zoho/queue"
import { handleZohoDeskSync } from "@/integrations/zoho/sync"
import { checkSyncControl } from "@/sync-control/checkpoint"
import { getQueueDefinition } from "@/sync-control/registry"
import { registerBossWorker } from "@/sync-control/workerControl"
import { startChatMemoryWorker } from "@/workers/chat-memory-worker"
import { startEpisodicMemoryWorker } from "@/workers/episodic-memory-worker"
import { startSummaryWorker } from "@/workers/summary-worker"
import { CHAT_MEMORY_INDEXING_QUEUE_NAME } from "./chat-memory-indexing"
import { EPISODIC_MEMORY_QUEUE_NAME } from "./episodic-memory-extraction"
import { SUMMARY_QUEUE_NAME } from "./summary-generation"
const Logger = getLogger(Subsystem.Queue)
const JobExpiryHours = config.JobExpiryHours
const SYNC_JOB_AUTH_TYPE_CLEANUP = "cleanup"

import { boss } from "./boss"

export { boss }

// run it if we are re-doing ingestion
// await boss.clearStorage()

export const SaaSQueue = `ingestion-${ConnectorType.SaaS}`
export const SyncOAuthSaaSQueue = `sync-${ConnectorType.SaaS}-${AuthType.OAuth}`
export const SyncServiceAccountSaaSQueue = `sync-${ConnectorType.SaaS}-${AuthType.ServiceAccount}`
export const SyncServiceAccountPerUserQueue = `sync-${ConnectorType.SaaS}-${AuthType.ServiceAccount}-per-user`
export const SyncServiceAccountSchedulerQueue = `sync-${ConnectorType.SaaS}-${AuthType.ServiceAccount}-scheduler`
export const SyncGoogleWorkspace = `sync-${Apps.GoogleWorkspace}-${AuthType.ServiceAccount}`
export const CheckDownloadsFolderQueue = `check-downloads-folder`
export const SyncSlackQueue = `sync-${Apps.Slack}-${AuthType.OAuth}`
export const SyncSlackPerUserQueue = `sync-${Apps.Slack}-${AuthType.OAuth}-per-user`
export const SyncSlackSchedulerQueue = `sync-${Apps.Slack}-${AuthType.OAuth}-scheduler`
export const SyncZohoDeskQueue = `sync-${Apps.ZohoDesk}-${AuthType.OAuth}`
export const ProcessZohoDeskTicketQueue = `process-${Apps.ZohoDesk}-ticket`
export const ProcessZohoDeskAttachmentQueue = `process-${Apps.ZohoDesk}-attachment`
export const SyncToolsQueue = `sync-tools`
export const CleanupAttachmentsQueue = `cleanup-attachments`

const TwiceWeekly = `0 0 * * 0,3`
const Every10Minutes = `*/10 * * * *`
const EveryHour = `0 * * * *`
const Every6Hours = `0 */6 * * *`
const EveryWeek = `0 0 */7 * *`
const EveryMin = `*/1 * * * *`
const Every15Minutes = `*/15 * * * *`
const Every20Minutes = `*/20 * * * *`
const EveryDay = `0 2 * * *` // Run at 2 AM daily

export const init = async () => {
  Logger.info("Queue init")
  await boss.start()
  await boss.createQueue(SaaSQueue)
  await boss.createQueue(SyncOAuthSaaSQueue)
  await boss.createQueue(SyncServiceAccountSaaSQueue)
  await boss.createQueue(SyncServiceAccountPerUserQueue)
  await boss.createQueue(SyncServiceAccountSchedulerQueue)
  await boss.createQueue(SyncGoogleWorkspace)
  await boss.createQueue(CheckDownloadsFolderQueue)
  await boss.createQueue(SyncSlackQueue)
  await boss.createQueue(SyncSlackPerUserQueue)
  await boss.createQueue(SyncSlackSchedulerQueue)
  await boss.createQueue(SyncZohoDeskQueue)
  await boss.createQueue(ProcessZohoDeskTicketQueue)
  await boss.createQueue(ProcessZohoDeskAttachmentQueue)
  await boss.createQueue(SyncToolsQueue)
  await boss.createQueue(CleanupAttachmentsQueue)
  await boss.createQueue(SUMMARY_QUEUE_NAME)
  await boss.createQueue(EPISODIC_MEMORY_QUEUE_NAME)
  await boss.createQueue(CHAT_MEMORY_INDEXING_QUEUE_NAME)
  await initWorkers()
}

// when the Service account is connected
export const setupServiceAccountCronjobs = async () => {
  if (!config.useLegacyServiceAccountSync) {
    Logger.info("Using per-user service account sync mode")

    // Unschedule the legacy batch sync if it exists
    await boss.unschedule(SyncServiceAccountSaaSQueue)
    Logger.info("Unscheduled legacy batch service account sync")

    // Schedule the user job scheduler every 20 minutes
    await boss.schedule(
      SyncServiceAccountSchedulerQueue,
      Every20Minutes,
      {},
      { retryLimit: 0, expireInHours: JobExpiryHours },
    )
  } else {
    Logger.info("Using batch service account sync mode (legacy)")

    // Unschedule the per-user scheduler if it exists
    await boss.unschedule(SyncServiceAccountSchedulerQueue)
    Logger.info("Unscheduled per-user service account scheduler")

    await boss.schedule(
      SyncServiceAccountSaaSQueue,
      Every10Minutes,
      {},
      { retryLimit: 0, expireInHours: JobExpiryHours },
    )
  }

  // Always setup Google Workspace sync (unchanged)
  await boss.schedule(
    SyncGoogleWorkspace,
    Every6Hours,
    {},
    { retryLimit: 0, expireInHours: JobExpiryHours },
  )
}

const registerQueueWorker = async (
  queueName: string,
  workOptionsOrHandler: any,
  maybeHandler?: any,
) => {
  const definition = getQueueDefinition(queueName)
  return registerBossWorker({
    queueName,
    workerGroup: definition.workerGroup,
    ...(maybeHandler
      ? { workOptions: workOptionsOrHandler, handler: maybeHandler }
      : { handler: workOptionsOrHandler }),
  })
}

const initWorkers = async () => {
  Logger.info("initWorkers")
  await registerBossWorker({
    queueName: SaaSQueue,
    workerGroup: "ingestion-saas",
    handler: async ([job]) => {
      const start = new Date()
      Logger.info(`boss.work SaaSQueue Job ${job.id} started at ${start}`)
      const jobData: SaaSJob = job.data as SaaSJob
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
        // await handleGoogleOAuthIngestion(boss, job)
      } else if (
        jobData.app === Apps.Slack &&
        jobData.authType === AuthType.OAuth
      ) {
        Logger.info("Handling Slack Ingestion from Queue")
        // await handleSlackIngestion(boss, job)
      } else {
        throw new Error("Unsupported job")
      }
    },
  })

  // do not retry
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
  // Slack sync scheduling - conditional based on per-user mode

  if (!config.useLegacySlackSync) {
    Logger.info("Using per-user Slack sync mode")

    // Unschedule the legacy batch sync if it exists
    await boss.unschedule(SyncSlackQueue)
    Logger.info("Unscheduled legacy batch Slack sync")

    await boss.schedule(
      SyncSlackSchedulerQueue,
      Every20Minutes,
      {},
      { retryLimit: 0, expireInHours: JobExpiryHours },
    )
  } else {
    Logger.info("Using batch Slack sync mode (legacy)")

    // Unschedule the per-user scheduler if it exists
    await boss.unschedule(SyncSlackSchedulerQueue)
    Logger.info("Unscheduled per-user Slack scheduler")

    await boss.schedule(
      SyncSlackQueue,
      Every15Minutes,
      {},
      { retryLimit: 0, expireInHours: JobExpiryHours },
    )
  }

  await boss.schedule(
    SyncZohoDeskQueue,
    EveryDay,
    {},
    { retryLimit: 0, expireInHours: JobExpiryHours },
  )

  await boss.schedule(
    SyncToolsQueue,
    EveryWeek,
    {},
    { retryLimit: 0, expireInHours: JobExpiryHours },
  )

  await boss.schedule(
    CleanupAttachmentsQueue,
    EveryDay,
    {},
    { retryLimit: 0, expireInHours: JobExpiryHours },
  )

  await setupServiceAccountCronjobs()

  await registerBossWorker({
    queueName: SyncToolsQueue,
    workerGroup: "sync-tools",
    handler: async ([job]) => {
      const startTime = Date.now()
      try {
        await handleToolSync()
        const endTime = Date.now()
        syncJobSuccess.inc(
          {
            sync_job_name: SyncToolsQueue,
            sync_job_auth_type: "sync_tool",
          },
          1,
        )
        syncJobDuration.observe(
          {
            sync_job_name: SyncToolsQueue,
            sync_job_auth_type: "sync_tool",
          },
          endTime - startTime,
        )
      } catch (error) {
        const errorMessage = getErrorMessage(error)
        Logger.error(
          error,
          `Unhandled Error while syncing Tools ${errorMessage} ${(error as Error).stack}`,
        )
        syncJobError.inc(
          {
            sync_job_name: SyncToolsQueue,
            sync_job_auth_type: "sync_tool",
            sync_job_error_type: `${errorMessage}`,
          },
          1,
        )
      }
    },
  })

  await registerBossWorker({
    queueName: SyncOAuthSaaSQueue,
    workerGroup: "sync-saas-oauth",
    handler: async ([job]) => {
      const startTime = Date.now()
      try {
        await handleGoogleOAuthChanges(boss, job)
        await handleMicrosoftOAuthChanges(boss, job)
        const endTime = Date.now()
        syncJobSuccess.inc(
          {
            sync_job_name: SyncOAuthSaaSQueue,
            sync_job_auth_type: AuthType.OAuth,
          },
          1,
        )
        syncJobDuration.observe(
          {
            sync_job_name: SyncOAuthSaaSQueue,
            sync_job_auth_type: AuthType.OAuth,
          },
          endTime - startTime,
        )
      } catch (error) {
        const errorMessage = getErrorMessage(error)
        Logger.error(
          error,
          `Unhandled Error while syncing OAuth SaaS ${errorMessage} ${(error as Error).stack}`,
        )
        syncJobError.inc(
          {
            sync_job_name: SyncOAuthSaaSQueue,
            sync_job_auth_type: AuthType.OAuth,
            sync_job_error_type: `${errorMessage}`,
          },
          1,
        )
      }
    },
  })

  // Any Service account related SaaS jobs
  await registerBossWorker({
    queueName: SyncServiceAccountSaaSQueue,
    workerGroup: "sync-service-account",
    handler: async ([job]) => {
      // call all the service account handlers in parallel
      const startTime = Date.now()
      try {
        await handleGoogleServiceAccountChanges(boss, job)
        await handleMicrosoftServiceAccountChanges()
        const endTime = Date.now()
        syncJobSuccess.inc(
          {
            sync_job_name: SyncServiceAccountSaaSQueue,
            sync_job_auth_type: AuthType.ServiceAccount,
          },
          1,
        )
        syncJobDuration.observe(
          {
            sync_job_name: SyncServiceAccountSaaSQueue,
            sync_job_auth_type: AuthType.ServiceAccount,
          },
          endTime - startTime,
        )
      } catch (error) {
        const errorMessage = getErrorMessage(error)
        Logger.error(
          error,
          `Unhandled Error while syncing Service Account Changes: Error :\n ${errorMessage} ${(error as Error).stack}`,
        )
        syncJobError.inc(
          {
            sync_job_name: SyncServiceAccountSaaSQueue,
            sync_job_auth_type: AuthType.ServiceAccount,
            sync_job_error_type: `${errorMessage}`,
          },
          1,
        )
      }
    },
  })

  // NEW: Scheduler worker - runs every 20 minutes and queues individual user jobs
  await registerBossWorker({
    queueName: SyncServiceAccountSchedulerQueue,
    workerGroup: "sync-service-account-scheduler",
    handler: async ([job]) => {
      const startTime = Date.now()
      try {
        Logger.info(
          "Service Account Scheduler: Starting to queue per-user jobs",
        )

        // Get all service account sync jobs for Google Drive, Gmail, and Calendar
        const [googleDriveSyncJobs, gmailSyncJobs, calendarSyncJobs] =
          await Promise.all([
            getAppSyncJobs(db, Apps.GoogleDrive, AuthType.ServiceAccount),
            getAppSyncJobs(db, Apps.Gmail, AuthType.ServiceAccount),
            getAppSyncJobs(db, Apps.GoogleCalendar, AuthType.ServiceAccount),
          ])

        // Combine all sync jobs and get unique users
        const allSyncJobs = [
          ...googleDriveSyncJobs,
          ...gmailSyncJobs,
          ...calendarSyncJobs,
        ]
        const uniqueUserJobs = new Map<string, (typeof allSyncJobs)[number]>()
        for (const syncJob of allSyncJobs) {
          const key = `${syncJob.workspaceId}:${syncJob.email}`
          if (!uniqueUserJobs.has(key)) uniqueUserJobs.set(key, syncJob)
        }

        Logger.info(
          `Service Account Scheduler: Found ${uniqueUserJobs.size} unique users to queue`,
        )

        // Queue individual jobs for each user
        let queuedCount = 0
        let failedCount = 0
        for (const syncJob of uniqueUserJobs.values()) {
          const userEmail = syncJob.email
          try {
            const decision = await checkSyncControl({
              queueName: SyncServiceAccountPerUserQueue,
              jobData: {
                email: userEmail,
                workspaceId: syncJob.workspaceId,
                connectorId: syncJob.connectorId,
                app: syncJob.app,
                authType: syncJob.authType,
              },
              checkpoint: "scheduler_item",
            })
            if (decision !== "allowed") continue

            await boss.send(
              SyncServiceAccountPerUserQueue,
              {
                email: userEmail,
                workspaceId: syncJob.workspaceId,
                workspaceExternalId: syncJob.workspaceExternalId,
                connectorId: syncJob.connectorId,
                syncOnlyCurrentUser: true,
              },
              {
                retryLimit: 0,
                expireInHours: JobExpiryHours,
                singletonKey: `${syncJob.workspaceId}:${userEmail}`,
              },
            )
            queuedCount++
          } catch (error) {
            failedCount++
            Logger.error(
              error,
              `Service Account Scheduler: Failed to queue sync job for user ${userEmail}: ${getErrorMessage(error)}`,
            )
            // Continue to next user instead of failing the entire scheduler
          }
        }

        Logger.info(
          `Service Account Scheduler: Successfully queued ${queuedCount} user sync jobs, ${failedCount} failed`,
        )

        const endTime = Date.now()
        syncJobSuccess.inc(
          {
            sync_job_name: SyncServiceAccountSchedulerQueue,
            sync_job_auth_type: "scheduler",
          },
          1,
        )
        syncJobDuration.observe(
          {
            sync_job_name: SyncServiceAccountSchedulerQueue,
            sync_job_auth_type: "scheduler",
          },
          endTime - startTime,
        )
      } catch (error) {
        const errorMessage = getErrorMessage(error)
        Logger.error(
          error,
          `Service Account Scheduler: Error queuing user jobs: ${errorMessage} ${(error as Error).stack}`,
        )
        syncJobError.inc(
          {
            sync_job_name: SyncServiceAccountSchedulerQueue,
            sync_job_auth_type: "scheduler",
            sync_job_error_type: `${errorMessage}`,
          },
          1,
        )
      }
    },
  })

  // NEW: Per-User Service Account sync worker (processes 2 jobs concurrently via batchSize)
  await registerBossWorker({
    queueName: SyncServiceAccountPerUserQueue,
    workerGroup: "sync-service-account-per-user",
    workOptions: { batchSize: 2 },
    handler: async (jobs) => {
      // Process all jobs in parallel using Promise.all
      await Promise.all(
        jobs.map(async (job) => {
          const startTime = Date.now()
          const jobData = job.data as any

          // Validate job data
          if (!jobData || typeof jobData !== "object" || !jobData.email) {
            Logger.error("Invalid job data for Service Account sync", {
              jobData,
            })
            syncJobError.inc(
              {
                sync_job_name: SyncServiceAccountPerUserQueue,
                sync_job_auth_type: AuthType.ServiceAccount,
                sync_job_error_type: "invalid_job_data",
              },
              1,
            )
            return
          }

          const userEmail = jobData.email

          try {
            Logger.info(`Per-User Worker: Starting sync for user ${userEmail}`)

            await handleGoogleServiceAccountChanges(boss, job)

            Logger.info(`Per-User Worker: Completed sync for user ${userEmail}`)

            const endTime = Date.now()
            syncJobSuccess.inc(
              {
                sync_job_name: SyncServiceAccountPerUserQueue,
                sync_job_auth_type: AuthType.ServiceAccount,
              },
              1,
            )
            syncJobDuration.observe(
              {
                sync_job_name: SyncServiceAccountPerUserQueue,
                sync_job_auth_type: AuthType.ServiceAccount,
              },
              endTime - startTime,
            )
          } catch (error) {
            const errorMessage = getErrorMessage(error)
            Logger.error(
              error,
              `Per-User Worker: Error syncing user ${userEmail}: ${errorMessage} ${(error as Error).stack}`,
            )
            syncJobError.inc(
              {
                sync_job_name: SyncServiceAccountPerUserQueue,
                sync_job_auth_type: AuthType.ServiceAccount,
                sync_job_error_type: `${errorMessage}`,
              },
              1,
            )
          }
        }),
      )
    },
  })

  await registerBossWorker({
    queueName: SyncGoogleWorkspace,
    workerGroup: "sync-google-workspace",
    handler: async ([job]) => {
      const startTime = Date.now()
      try {
        await syncGoogleWorkspace(boss, job)
        const endTime = Date.now()
        syncJobSuccess.inc(
          {
            sync_job_name: SyncGoogleWorkspace,
            sync_job_auth_type: AuthType.ServiceAccount,
          },
          1,
        )
        syncJobDuration.observe(
          {
            sync_job_name: SyncGoogleWorkspace,
            sync_job_auth_type: AuthType.ServiceAccount,
          },
          endTime - startTime,
        )
      } catch (error) {
        const errorMessage = getErrorMessage(error)
        Logger.error(
          error,
          `Unhandled Error while syncing Google Workspace ${errorMessage} ${(error as Error).stack}`,
        )
        syncJobError.inc(
          {
            sync_job_name: SyncGoogleWorkspace,
            sync_job_auth_type: AuthType.ServiceAccount,
            sync_job_error_type: `${errorMessage}`,
          },
          1,
        )
      }
    },
  })

  await registerBossWorker({
    queueName: CheckDownloadsFolderQueue,
    workerGroup: "check-downloads-folder",
    handler: async ([job]) => {
      await checkDownloadsFolder(boss, job)
    },
  })

  // NEW: Slack Scheduler worker - runs every 20 minutes and queues individual user jobs
  await registerBossWorker({
    queueName: SyncSlackSchedulerQueue,
    workerGroup: "sync-slack-scheduler",
    handler: async ([job]) => {
      const startTime = Date.now()
      try {
        Logger.info("Slack Scheduler: Starting to queue per-user jobs")

        // Get all Slack sync jobs
        const slackSyncJobs = await getAppSyncJobs(
          db,
          Apps.Slack,
          AuthType.OAuth,
        )
        const uniqueUserJobs = new Map<string, (typeof slackSyncJobs)[number]>()
        for (const syncJob of slackSyncJobs) {
          const key = `${syncJob.workspaceId}:${syncJob.email}`
          if (!uniqueUserJobs.has(key)) uniqueUserJobs.set(key, syncJob)
        }

        Logger.info(
          `Slack Scheduler: Found ${uniqueUserJobs.size} unique users to queue`,
        )

        // Queue individual jobs for each user
        let queuedCount = 0
        let failedCount = 0
        for (const syncJob of uniqueUserJobs.values()) {
          const userEmail = syncJob.email
          try {
            const decision = await checkSyncControl({
              queueName: SyncSlackPerUserQueue,
              jobData: {
                email: userEmail,
                workspaceId: syncJob.workspaceId,
                connectorId: syncJob.connectorId,
                app: syncJob.app,
                authType: syncJob.authType,
              },
              checkpoint: "scheduler_item",
            })
            if (decision !== "allowed") continue

            await boss.send(
              SyncSlackPerUserQueue,
              {
                email: userEmail,
                workspaceId: syncJob.workspaceId,
                workspaceExternalId: syncJob.workspaceExternalId,
                connectorId: syncJob.connectorId,
                syncOnlyCurrentUser: true,
              },
              {
                retryLimit: 0,
                expireInHours: JobExpiryHours,
                singletonKey: `${syncJob.workspaceId}:${userEmail}`,
              },
            )
            queuedCount++
          } catch (error) {
            failedCount++
            Logger.error(
              error,
              `Slack Scheduler: Failed to queue sync job for user ${userEmail}: ${getErrorMessage(error)}`,
            )
            // Continue to next user instead of failing the entire scheduler
          }
        }

        Logger.info(
          `Slack Scheduler: Successfully queued ${queuedCount} user sync jobs, ${failedCount} failed`,
        )

        const endTime = Date.now()
        syncJobSuccess.inc(
          {
            sync_job_name: SyncSlackSchedulerQueue,
            sync_job_auth_type: "scheduler",
          },
          1,
        )
        syncJobDuration.observe(
          {
            sync_job_name: SyncSlackSchedulerQueue,
            sync_job_auth_type: "scheduler",
          },
          endTime - startTime,
        )
      } catch (error) {
        const errorMessage = getErrorMessage(error)
        Logger.error(
          error,
          `Slack Scheduler: Error queuing user jobs: ${errorMessage} ${(error as Error).stack}`,
        )
        syncJobError.inc(
          {
            sync_job_name: SyncSlackSchedulerQueue,
            sync_job_auth_type: "scheduler",
            sync_job_error_type: `${errorMessage}`,
          },
          1,
        )
      }
    },
  })

  // NEW: Per-User Slack sync worker (processes 2 jobs concurrently via batchSize)
  await registerQueueWorker(
    SyncSlackPerUserQueue,
    { batchSize: 2 },
    async (jobs: PgBoss.Job<any>[]) => {
      // Process all jobs in parallel using Promise.all
      await Promise.all(
        jobs.map(async (job: PgBoss.Job<any>) => {
          const startTime = Date.now()
          const jobData = job.data as any

          // Validate job data
          if (!jobData || typeof jobData !== "object" || !jobData.email) {
            Logger.error("Invalid job data for Slack sync", { jobData })
            syncJobError.inc(
              {
                sync_job_name: SyncSlackPerUserQueue,
                sync_job_auth_type: SlackEntity.User,
                sync_job_error_type: "invalid_job_data",
              },
              1,
            )
            return
          }

          const userEmail = jobData.email

          try {
            Logger.info(`Slack Worker: Starting sync for user ${userEmail}`)

            await handleSlackChanges(boss, job)

            Logger.info(`Slack Worker: Completed sync for user ${userEmail}`)

            const endTime = Date.now()
            syncJobSuccess.inc(
              {
                sync_job_name: SyncSlackPerUserQueue,
                sync_job_auth_type: SlackEntity.User,
              },
              1,
            )
            syncJobDuration.observe(
              {
                sync_job_name: SyncSlackPerUserQueue,
                sync_job_auth_type: SlackEntity.User,
              },
              endTime - startTime,
            )
          } catch (error) {
            const errorMessage = getErrorMessage(error)
            Logger.error(
              error,
              `Slack Worker: Error syncing user ${userEmail}: ${errorMessage} ${(error as Error).stack}`,
            )
            syncJobError.inc(
              {
                sync_job_name: SyncSlackPerUserQueue,
                sync_job_auth_type: SlackEntity.User,
                sync_job_error_type: `${errorMessage}`,
              },
              1,
            )
          }
        }),
      )
    },
  )

  await registerQueueWorker(
    SyncSlackQueue,
    async ([job]: PgBoss.Job<any>[]) => {
      const startTime = Date.now()
      try {
        await handleSlackChanges(boss, job)
        const endTime = Date.now()
        syncJobSuccess.inc(
          {
            sync_job_name: SyncSlackQueue,
            sync_job_auth_type: SlackEntity.User,
          },
          1,
        )
        syncJobDuration.observe(
          {
            sync_job_name: SyncSlackQueue,
            sync_job_auth_type: SlackEntity.User,
          },
          endTime - startTime,
        )
      } catch (error) {
        const errorMessage = getErrorMessage(error)
        Logger.error(
          error,
          `Unhandled Error while syncing Slack ${errorMessage} ${(error as Error).stack}`,
        )
        syncJobError.inc(
          {
            sync_job_name: SyncSlackQueue,
            sync_job_auth_type: SlackEntity.User,
            sync_job_error_type: `${errorMessage}`,
          },
          1,
        )
      }
    },
  )

  await registerQueueWorker(
    SyncZohoDeskQueue,
    async ([job]: PgBoss.Job<any>[]) => {
      const startTime = Date.now()
      try {
        await handleZohoDeskSync(job as PgBoss.Job<{ connectorId: number }>)
        const endTime = Date.now()
        syncJobSuccess.inc(
          {
            sync_job_name: SyncZohoDeskQueue,
            sync_job_auth_type: AuthType.OAuth,
          },
          1,
        )
        syncJobDuration.observe(
          {
            sync_job_name: SyncZohoDeskQueue,
            sync_job_auth_type: AuthType.OAuth,
          },
          endTime - startTime,
        )
      } catch (error) {
        const errorMessage = getErrorMessage(error)
        Logger.error(
          error,
          `Unhandled Error while syncing Zoho Desk ${errorMessage} ${(error as Error).stack}`,
        )
        syncJobError.inc(
          {
            sync_job_name: SyncZohoDeskQueue,
            sync_job_auth_type: AuthType.OAuth,
            sync_job_error_type: `${errorMessage}`,
          },
          1,
        )
      }
    },
  )

  // Zoho Desk Ticket Processing Worker - processes individual tickets
  await registerQueueWorker(
    ProcessZohoDeskTicketQueue,
    {
      batchSize: 3,
    },
    async (jobs: PgBoss.Job<TicketJob>[]) => {
      await Promise.all(
        jobs.map(async (job: PgBoss.Job<TicketJob>) => {
          const startTime = Date.now()
          try {
            await processTicketJob(job as PgBoss.Job<TicketJob>)
            const endTime = Date.now()
            syncJobSuccess.inc(
              {
                sync_job_name: ProcessZohoDeskTicketQueue,
                sync_job_auth_type: AuthType.OAuth,
              },
              1,
            )
            syncJobDuration.observe(
              {
                sync_job_name: ProcessZohoDeskTicketQueue,
                sync_job_auth_type: AuthType.OAuth,
              },
              endTime - startTime,
            )
          } catch (error) {
            const errorMessage = getErrorMessage(error)
            Logger.error(
              error,
              `Error processing Zoho Desk ticket ${errorMessage} ${(error as Error).stack}`,
            )
            syncJobError.inc(
              {
                sync_job_name: ProcessZohoDeskTicketQueue,
                sync_job_auth_type: AuthType.OAuth,
                sync_job_error_type: `${errorMessage}`,
              },
              1,
            )
          }
        }),
      )
    },
  )

  //Zoho Desk Attachment Processing Worker - processes OCR for attachments
  await registerQueueWorker(
    ProcessZohoDeskAttachmentQueue,
    {
      batchSize: 5,
    },
    async (jobs: PgBoss.Job<AttachmentJob>[]) => {
      await Promise.all(
        jobs.map(async (job: PgBoss.Job<AttachmentJob>) => {
          const startTime = Date.now()
          try {
            await processAttachmentJob(job as PgBoss.Job<AttachmentJob>)
            const endTime = Date.now()
            syncJobSuccess.inc(
              {
                sync_job_name: ProcessZohoDeskAttachmentQueue,
                sync_job_auth_type: AuthType.OAuth,
              },
              1,
            )
            syncJobDuration.observe(
              {
                sync_job_name: ProcessZohoDeskAttachmentQueue,
                sync_job_auth_type: AuthType.OAuth,
              },
              endTime - startTime,
            )
          } catch (error) {
            const errorMessage = getErrorMessage(error)
            Logger.error(
              error,
              `Error processing Zoho Desk attachment ${errorMessage} ${(error as Error).stack}`,
            )
            syncJobError.inc(
              {
                sync_job_name: ProcessZohoDeskAttachmentQueue,
                sync_job_auth_type: AuthType.OAuth,
                sync_job_error_type: `${errorMessage}`,
              },
              1,
            )
          }
        }),
      )
    },
  )

  await registerQueueWorker(CleanupAttachmentsQueue, async () => {
    const startTime = Date.now()
    try {
      const result = await handleAttachmentCleanup()
      const endTime = Date.now()

      Logger.info(
        `Attachment cleanup completed: ${result.chatsProcessed} chats, ${result.messagesProcessed} messages, ${result.attachmentsDeleted} attachments deleted`,
      )

      syncJobSuccess.inc(
        {
          sync_job_name: CleanupAttachmentsQueue,
          sync_job_auth_type: SYNC_JOB_AUTH_TYPE_CLEANUP,
        },
        1,
      )
      syncJobDuration.observe(
        {
          sync_job_name: CleanupAttachmentsQueue,
          sync_job_auth_type: SYNC_JOB_AUTH_TYPE_CLEANUP,
        },
        endTime - startTime,
      )
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      Logger.error(
        error,
        `Unhandled Error while cleaning up attachments ${errorMessage} ${(error as Error).stack}`,
      )
      syncJobError.inc(
        {
          sync_job_name: CleanupAttachmentsQueue,
          sync_job_auth_type: SYNC_JOB_AUTH_TYPE_CLEANUP,
          sync_job_error_type: `${errorMessage}`,
        },
        1,
      )
    }
  })

  // Initialize summary generation worker
  await startSummaryWorker()

  // Initialize episodic memory extraction worker
  await startEpisodicMemoryWorker()

  // Initialize chat memory indexing worker
  await startChatMemoryWorker()
}

export const ProgressEvent = "progress-event"

boss.on("error", (error) => {
  console.error(`Queue error: ${error} ${(error as Error).stack}`)
})

boss.on("monitor-states", (states) => {
  Logger.info(`Queue States: ${JSON.stringify(states, null, 2)}`)
})
