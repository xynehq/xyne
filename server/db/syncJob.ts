import type { TxnOrClient } from "@/types"
import {
  selectSyncJobSchema,
  syncJobs,
  type InsertSyncJob,
  type SelectSyncJob,
} from "@/db/schema"
import { createId } from "@paralleldrive/cuid2"
import { Apps, AuthType } from "@/shared/types"
import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"

export const insertSyncJob = async (
  trx: TxnOrClient,
  job: Omit<InsertSyncJob, "externalId">,
): Promise<SelectSyncJob> => {
  const externalId = createId() // Generate unique external ID
  const jobWithExternalId = { ...job, externalId }
  const jobArr = await trx
    .insert(syncJobs)
    .values(jobWithExternalId)
    .returning()
  if (!jobArr || !jobArr.length) {
    throw new Error('Error in insert of sync job "returning"')
  }
  const parsedData = selectSyncJobSchema.safeParse(jobArr[0])
  if (!parsedData.success) {
    throw new Error(
      `Could not get sync job after inserting: ${parsedData.error.toString()}`,
    )
  }
  return parsedData.data
}

export const getAppSyncJobs = async (
  trx: TxnOrClient,
  app: Apps,
  authType: AuthType,
): Promise<SelectSyncJob[]> => {
  const jobs = await trx
    .select()
    .from(syncJobs)
    .where(and(eq(syncJobs.app, app), eq(syncJobs.authType, authType)))
  return z.array(selectSyncJobSchema).parse(jobs)
}

export const getAppSyncJobsByEmail = async (
  trx: TxnOrClient,
  app: Apps,
  authType: AuthType,
  email: string,
): Promise<SelectSyncJob[]> => {
  const jobs = await trx
    .select()
    .from(syncJobs)
    .where(
      and(
        and(eq(syncJobs.app, app), eq(syncJobs.authType, authType)),
        eq(syncJobs.email, email),
      ),
    )
  return z.array(selectSyncJobSchema).parse(jobs)
}

export const updateSyncJob = async (
  trx: TxnOrClient,
  jobId: number,
  updateData: Partial<SelectSyncJob>,
): Promise<SelectSyncJob> => {
  const updatedSyncJobs = await trx
    .update(syncJobs)
    .set(updateData)
    .where(eq(syncJobs.id, jobId))
    .returning()

  if (!updatedSyncJobs || !updatedSyncJobs.length) {
    throw new Error("Could not update the connector")
  }
  const [connectorVal] = updatedSyncJobs
  const parsedRes = selectSyncJobSchema.safeParse(connectorVal)
  if (!parsedRes.success) {
    throw new Error(
      `zod error: Invalid connector: ${parsedRes.error.toString()}`,
    )
  }
  return parsedRes.data
}

export const clearUserSyncJob = async (
  trx: TxnOrClient,
  userEmail: string,
  appsToDelete: string[],
) => {
  // Convert app names to their corresponding Apps enum values
  appsToDelete = appsToDelete.map(
    (app: string): Apps =>
      app === "drive"
        ? Apps.GoogleDrive
        : app === "calendar"
          ? Apps.GoogleCalendar
          : (app as Apps),
  )
  try {
    await trx
      .delete(syncJobs)
      .where(
        and(
          eq(syncJobs.email, userEmail),
          inArray(syncJobs.app, appsToDelete as Apps[]),
        ),
      )
    return `Successfully Deleted ${userEmail} ${appsToDelete.join(" ,")} syncJobs`
  } catch (error) {
    throw new Error(
      `Failed to delete sync jobs for ${userEmail} ${appsToDelete.join(" , ")} syncJobs: ${error}`,
    )
  }
}
