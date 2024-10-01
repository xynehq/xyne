import type { TxnOrClient } from "@/types";
import { selectSyncJob, syncJobs, type InsertSyncJob, type SelectSyncJob } from "./schema";
import { createId } from "@paralleldrive/cuid2";
import type { Apps } from "@/shared/types";
import { eq } from "drizzle-orm";
import { z } from "zod";

export const insertSyncJob = async (trx: TxnOrClient, job: Omit<InsertSyncJob, "externalId">): Promise<SelectSyncJob> => {
    const externalId = createId();  // Generate unique external ID
    const jobWithExternalId = { ...job, externalId }
    const jobArr = await trx.insert(syncJobs).values(jobWithExternalId).returning()
    if (!jobArr || !jobArr.length) {
        throw new Error('Error in insert of sync job "returning"')
    }
    const parsedData = selectSyncJob.safeParse(jobArr[0])
    if (!parsedData.success) {
        throw new Error(`Could not get sync job after inserting: ${parsedData.error.toString()}`)
    }
    return parsedData.data
}

export const getAppSyncJobs = async (trx: TxnOrClient, app: Apps): Promise<SelectSyncJob[]> => {
    const jobs = await trx.select().from(syncJobs).where(eq(syncJobs.app, app))
    const parsedData = z.array(selectSyncJob).safeParse(jobs);
    if (!parsedData.success) {
        throw new Error(`Could not get Sync Jobs for app: ${app} ${parsedData.error.toString()}`)
    }
    return parsedData.data
}