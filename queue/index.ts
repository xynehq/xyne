import { handleGoogleServiceAccountIngestion } from "@/integrations/google";
import { ConnectorType } from "@/types";
import PgBoss from "pg-boss";
import config from "@/config"

const url = `postgres://xyne:xyne@${config.postgresBaseHost}:5432/xyne`
export const boss = new PgBoss(url);

export const SaaSQueue = `ingestion-${ConnectorType.SaaS}`

export const init = async () => {
    await boss.start()
    await boss.createQueue(SaaSQueue)
}

await boss.work(SaaSQueue, async ([job]) => {
    await handleGoogleServiceAccountIngestion(boss, job)
})

export const ProgressEvent = 'progress-event'