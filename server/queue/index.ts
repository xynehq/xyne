import {
  handleGoogleOAuthIngestion,
  handleGoogleServiceAccountIngestion,
  syncGoogleWorkspace,
} from "@/integrations/google"
import { handleToolSync } from "./toolSync"
import { handleAttachmentCleanup } from "./attachmentCleanup"
import { Subsystem, type SaaSJob } from "@/types" // ConnectorType removed
import { ConnectorType, SlackEntity } from "@/shared/types" // ConnectorType added
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
import { handleSlackChanges } from "@/integrations/slack/sync"
import {
  syncJobDuration,
  syncJobError,
  syncJobSuccess,
} from "@/metrics/sync/sync-metrics"
import { Auth } from "googleapis"
import {
  handleMicrosoftOAuthChanges,
  handleMicrosoftServiceAccountChanges,
} from "@/integrations/microsoft/sync"
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
export const SyncGoogleWorkspace = `sync-${Apps.GoogleWorkspace}-${AuthType.ServiceAccount}`
export const CheckDownloadsFolderQueue = `check-downloads-folder`
export const SyncSlackQueue = `sync-${Apps.Slack}-${AuthType.OAuth}`
export const SyncToolsQueue = `sync-tools`
export const CleanupAttachmentsQueue = `cleanup-attachments`

const TwiceWeekly = `0 0 * * 0,3`
const Every10Minutes = `*/10 * * * *`
const EveryHour = `0 * * * *`
const Every6Hours = `0 */6 * * *`
const EveryWeek = `0 0 */7 * *`
const EveryMin = `*/1 * * * *`
const Every15Minutes = `*/15 * * * *`
const EveryDay = `0 2 * * *` // Run at 2 AM daily

export const init = async () => {
  Logger.info("Queue init")
  await boss.start()
  await boss.createQueue(SaaSQueue)
  await boss.createQueue(SyncOAuthSaaSQueue)
  await boss.createQueue(SyncServiceAccountSaaSQueue)
  await boss.createQueue(SyncGoogleWorkspace)
  await boss.createQueue(CheckDownloadsFolderQueue)
  await boss.createQueue(SyncSlackQueue)
  await boss.createQueue(SyncToolsQueue)
  await boss.createQueue(CleanupAttachmentsQueue)
  await initWorkers()
}

// when the Service account is connected
export const setupServiceAccountCronjobs = async () => {
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
}

const initWorkers = async () => {
  Logger.info("initWorkers")
  await boss.work(SaaSQueue, async ([job]) => {
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
  await boss.schedule(
    SyncSlackQueue,
    Every15Minutes,
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

  await boss.work(SyncToolsQueue, async ([job]) => {
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
        (endTime - startTime) / 1000,
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
  })

  await boss.work(SyncOAuthSaaSQueue, async ([job]) => {
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
        (endTime - startTime) / 1000,
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
  })

  // Any Service account related SaaS jobs
  await boss.work(SyncServiceAccountSaaSQueue, async ([job]) => {
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
        (endTime - startTime) / 1000,
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
  })

  await boss.work(SyncGoogleWorkspace, async ([job]) => {
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
        (endTime - startTime) / 1000,
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
  })

  await boss.work(CheckDownloadsFolderQueue, async ([job]) => {
    await checkDownloadsFolder(boss, job)
  })
  await boss.work(SyncSlackQueue, async ([job]) => {
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
        (endTime - startTime) / 1000,
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
  })
  await boss.work(CleanupAttachmentsQueue, async () => {
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
        (endTime - startTime) / 1000,
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
}

export const ProgressEvent = "progress-event"

boss.on("error", (error) => {
  console.error(`Queue error: ${error} ${(error as Error).stack}`)
})

boss.on("monitor-states", (states) => {
  Logger.info(`Queue States: ${JSON.stringify(states, null, 2)}`)
})
