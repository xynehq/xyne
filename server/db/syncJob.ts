import type { TxnOrClient } from "@/types";
import { selectSyncJobSchema, syncJobs, type InsertSyncJob, type SelectSyncJob } from "./schema";
import { createId } from "@paralleldrive/cuid2";
import type { Apps, AuthType } from "@/shared/types";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

export const insertSyncJob = async (trx: TxnOrClient, job: Omit<InsertSyncJob, "externalId">): Promise<SelectSyncJob> => {
    const externalId = createId();  // Generate unique external ID
    const jobWithExternalId = { ...job, externalId }
    const jobArr = await trx.insert(syncJobs).values(jobWithExternalId).returning()
    if (!jobArr || !jobArr.length) {
        throw new Error('Error in insert of sync job "returning"')
    }
    const parsedData = selectSyncJobSchema.safeParse(jobArr[0])
    if (!parsedData.success) {
        throw new Error(`Could not get sync job after inserting: ${parsedData.error.toString()}`)
    }
    return parsedData.data
}

export const getAppSyncJobs = async (trx: TxnOrClient, app: Apps, authType: AuthType): Promise<SelectSyncJob[]> => {
    const jobs = await trx.select().from(syncJobs).where(and(eq(syncJobs.app, app), eq(syncJobs.authType, authType)))
    return z.array(selectSyncJobSchema).parse(jobs)
}

export const updateSyncJob = async (trx: TxnOrClient, jobId: number, updateData: Partial<SelectSyncJob>): Promise<SelectSyncJob> => {
    const updatedSyncJobs = await trx.update(syncJobs).set(updateData)
        .where(eq(syncJobs.id, jobId))
        .returning()

    if (!updatedSyncJobs || !updatedSyncJobs.length) {
        throw new Error('Could not update the connector')
    }
    const [connectorVal] = updatedSyncJobs
    const parsedRes = selectSyncJobSchema.safeParse(connectorVal)
    if (!parsedRes.success) {
        throw new Error(`zod error: Invalid connector: ${parsedRes.error.toString()}`)
    }
    return parsedRes.data
}