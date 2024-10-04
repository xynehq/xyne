import { handleGoogleOAuthChanges, handleGoogleOAuthIngestion, handleGoogleServiceAccountChanges, handleGoogleServiceAccountIngestion } from "@/integrations/google";
import { ConnectorType, type SaaSJob } from "@/types";
import PgBoss from "pg-boss";
import config from "@/config"
import { Apps, AuthType } from "@/shared/types";

const url = `postgres://xyne:xyne@${config.postgresBaseHost}:5432/xyne`
export const boss = new PgBoss(url);

export const SaaSQueue = `ingestion-${ConnectorType.SaaS}`
export const SyncOAuthSaaSQueue = `sync-${ConnectorType.SaaS}-${AuthType.OAuth}`
export const SyncServiceAccountSaaSQueue = `sync-${ConnectorType.SaaS}-${AuthType.ServiceAccount}`

const Every10Minutes = `*/10 * * * *`

export const init = async () => {
    await boss.start()
    await boss.createQueue(SaaSQueue)
    await boss.createQueue(SyncOAuthSaaSQueue)
    await boss.createQueue(SyncServiceAccountSaaSQueue)
    await initWorkers()
}
const initWorkers = async () => {
    await boss.work(SaaSQueue, async ([job]) => {
        const jobData: SaaSJob = job.data as SaaSJob
        if (jobData.app === Apps.GoogleDrive && jobData.authType === AuthType.ServiceAccount) {
            await handleGoogleServiceAccountIngestion(boss, job)
        } else if (jobData.app === Apps.GoogleDrive && jobData.authType === AuthType.OAuth) {
            await handleGoogleOAuthIngestion(boss, job)
        } else {
            throw new Error('Unsupported job')
        }
    })

    // do not retry
    await boss.schedule(SyncOAuthSaaSQueue, Every10Minutes, {}, { retryLimit: 0 })
    await boss.schedule(SyncServiceAccountSaaSQueue, Every10Minutes, {}, { retryLimit: 0 })

    await boss.work(SyncOAuthSaaSQueue, async ([job]) => {
        await handleGoogleOAuthChanges(boss, job)
    })

    await boss.work(SyncServiceAccountSaaSQueue, async ([job]) => {
        await handleGoogleServiceAccountChanges(boss, job)
    })

}
export const ProgressEvent = 'progress-event'