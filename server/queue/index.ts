import {
  handleGoogleOAuthIngestion,
  handleGoogleServiceAccountIngestion,
  syncGoogleWorkspace,
} from "@/integrations/google"
import { ConnectorType, type SaaSJob } from "@/types"
import PgBoss from "pg-boss"
import config from "@/config"
import { Apps, AuthType } from "@/shared/types"
import {
  handleGoogleOAuthChanges,
  handleGoogleServiceAccountChanges,
} from "@/integrations/google/sync"
import { checkDownloadsFolder } from "@/integrations/google/utils"

const url = `postgres://xyne:xyne@${config.postgresBaseHost}:5432/xyne`
export const boss = new PgBoss(url)

export const SaaSQueue = `ingestion-${ConnectorType.SaaS}`
export const SyncOAuthSaaSQueue = `sync-${ConnectorType.SaaS}-${AuthType.OAuth}`
export const SyncServiceAccountSaaSQueue = `sync-${ConnectorType.SaaS}-${AuthType.ServiceAccount}`
export const SyncGoogleWorkspace = `sync-${Apps.GoogleWorkspace}-${AuthType.ServiceAccount}`
export const CheckDownloadsFolderQueue = `check-downloads-folder`

const Every10Minutes = `*/1 * * * *`
const EveryHour = `0 * * * *`
const Every6Hours = `0 */6 * * *`
const EveryWeek = `0 0 */7 * *`
const EveryMin = `*/1 * * * *`

export const init = async () => {
  await boss.start()
  await boss.createQueue(SaaSQueue)
  await boss.createQueue(SyncOAuthSaaSQueue)
  await boss.createQueue(SyncServiceAccountSaaSQueue)
  await boss.createQueue(SyncGoogleWorkspace)
  await boss.createQueue(CheckDownloadsFolderQueue)
  await initWorkers()
}

// when the Service account is connected
export const setupServiceAccountCronjobs = async () => {
  await boss.schedule(
    SyncServiceAccountSaaSQueue,
    Every10Minutes,
    {},
    { retryLimit: 0 },
  )
  await boss.schedule(SyncGoogleWorkspace, Every6Hours, {}, { retryLimit: 0 })
}

const initWorkers = async () => {
  await boss.work(SaaSQueue, async ([job]) => {
    const jobData: SaaSJob = job.data as SaaSJob
    if (
      jobData.app === Apps.GoogleDrive &&
      jobData.authType === AuthType.ServiceAccount
    ) {
      await handleGoogleServiceAccountIngestion(boss, job)
    } else if (
      jobData.app === Apps.GoogleDrive &&
      jobData.authType === AuthType.OAuth
    ) {
      await handleGoogleOAuthIngestion(boss, job)
    } else {
      throw new Error("Unsupported job")
    }
  })

  // do not retry
  await boss.schedule(SyncOAuthSaaSQueue, Every10Minutes, {}, { retryLimit: 0 })
  await boss.schedule(
    CheckDownloadsFolderQueue,
    EveryWeek,
    {},
    { retryLimit: 0 },
  )

  await setupServiceAccountCronjobs()

  await boss.work(SyncOAuthSaaSQueue, async ([job]) => {
    await handleGoogleOAuthChanges(boss, job)
  })

  // Any Service account related SaaS jobs
  await boss.work(SyncServiceAccountSaaSQueue, async ([job]) => {
    // call all the service account handlers in parallel
    await handleGoogleServiceAccountChanges(boss, job)
  })

  await boss.work(SyncGoogleWorkspace, async ([job]) => {
    await syncGoogleWorkspace(boss, job)
  })

  await boss.work(CheckDownloadsFolderQueue, async ([job]) => {
    await checkDownloadsFolder(boss, job)
  })
}

export const ProgressEvent = "progress-event"

boss.on("error", (error) => {
  console.error(`Queue error: ${error}`)
})
