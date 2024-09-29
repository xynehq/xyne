import { handleGoogleOAuthIngestion, handleGoogleServiceAccountIngestion } from "@/integrations/google";
import { ConnectorType, type SaaSJob } from "@/types";
import PgBoss from "pg-boss";
import config from "@/config"
import { Apps, AuthType } from "@/shared/types";

const url = `postgres://xyne:xyne@${config.postgresBaseHost}:5432/xyne`
export const boss = new PgBoss(url);

export const SaaSQueue = `ingestion-${ConnectorType.SaaS}`

export const init = async () => {
    await boss.start()
    await boss.createQueue(SaaSQueue)
}

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

export const ProgressEvent = 'progress-event'