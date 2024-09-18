import { handleGoogleServiceAccountIngestion } from "@/integrations/google";
import { ConnectorType } from "@/types";
import PgBoss from "pg-boss";

export const boss = new PgBoss(process.env.DATABASE_URL!);

export const SaaSQueue = `ingestion-${ConnectorType.SaaS}`

export const init = async () => {
    await boss.start()
    await boss.createQueue(SaaSQueue)
}

await boss.work(SaaSQueue, async ([job]) => {
    await handleGoogleServiceAccountIngestion(boss, job)
})