import {
  admin_directory_v1,
  admin_reports_v1,
  docs_v1,
  drive_v3,
  google,
} from "googleapis"
import {
  Subsystem,
  SyncCron,
  type ChangeToken,
  type GoogleClient,
  type GoogleServiceAccount,
  type SaaSJob,
  type SaaSOAuthJob,
} from "@/types"
import { JWT } from "google-auth-library"
import PgBoss from "pg-boss"
import { getConnector, getOAuthConnectorWithCredentials } from "@/db/connector"
import {
  DeleteDocument,
  GetDocument,
  insertDocument,
  UpdateDocumentPermissions,
} from "@/search/vespa"
import { db } from "@/db/client"
import { Apps, AuthType, SyncJobStatus, DriveEntity } from "@/shared/types"
import type { GoogleTokens } from "arctic"
import { getAppSyncJobs, updateSyncJob } from "@/db/syncJob"
import { getUserById } from "@/db/user"
import { insertSyncHistory } from "@/db/syncHistory"
import { getErrorMessage } from "@/utils"
import {
  createJwtClient,
  driveFileToIndexed,
  getFile,
  getFileContent,
  MimeMapForContent,
  toPermissionsList,
} from "./utils"
import { SyncJobFailed } from "@/errors"
import { getLogger } from "@/shared/logger"
import type { VespaFile } from "@/search/types"

const Logger = getLogger(Subsystem.Integrations).child({ module: "google" })

// TODO: change summary to json
// and store all the structured details
type ChangeStats = {
  added: number
  removed: number
  updated: number
  summary: string
}

const handleGoogleDriveChange = async (
  change: drive_v3.Schema$Change,
  client: GoogleClient,
  email: string,
): Promise<ChangeStats> => {
  const stats = newStats()
  const docId = change.fileId
  // remove item
  if (change.removed) {
    if (docId) {
      const doc = await GetDocument(docId)
      if (doc.fields.sddocname === "file") {
        const permissions = (doc.fields as VespaFile).permissions
        if (permissions.length === 1) {
          // remove it
          try {
            // also ensure that we are that permission
            if (!(permissions[0] === email)) {
              throw new Error(
                "We got a change for us that we didn't have access to in Vespa",
              )
            }
            await DeleteDocument(docId)
            stats.removed += 1
            stats.summary += `${docId} removed\n`
          } catch (e) {
            // TODO: detect vespa 404 and only ignore for that case
            // otherwise throw it further
          }
        } else {
          // remove our user's permission from the email
          const newPermissions = permissions.filter((v) => v !== email)
          await UpdateDocumentPermissions(docId, newPermissions)
          stats.updated += 1
          stats.summary += `user lost permission for doc: ${docId}\n`
        }
      }
    }
  } else if (docId && change.file) {
    const file = await getFile(client, docId)
    // we want to check if the doc already existed in vespa
    // and we are just updating the content of it
    // or user got access to a completely new doc
    let doc = null
    try {
      doc = await GetDocument(docId)
      stats.updated += 1
    } catch (e) {
      // catch the 404 error
      Logger.error(
        `Could not get document ${docId}, probably does not exist, ${e}`,
      )
      stats.added += 1
    }
    // for these mime types we fetch the file
    // with the full processing
    let vespaData
    if (file.mimeType && MimeMapForContent[file.mimeType]) {
      // TODO: make this generic
      vespaData = await getFileContent(client, file, DriveEntity.Docs)
      if (doc) {
        stats.summary += `updated the content for ${docId}\n`
      } else {
        stats.summary += `indexed new content ${docId}\n`
      }
    } else {
      if (doc) {
        stats.summary += `updated file ${docId}\n`
      } else {
        stats.summary += `added new file ${docId}\n`
      }
      // just update it as is
      vespaData = driveFileToIndexed(file)
    }
    vespaData.permissions = toPermissionsList(vespaData.permissions, email)
    if (vespaData) {
      insertDocument(vespaData)
    }
  } else if (change.driveId) {
    // TODO: handle this once we support multiple drives
  } else {
    Logger.error("Could not handle change: ", change)
  }
  return stats
}

export const handleGoogleOAuthChanges = async (
  boss: PgBoss,
  job: PgBoss.Job<any>,
) => {
  Logger.info("handleGoogleOAuthChanges")
  const data = job.data
  const syncJobs = await getAppSyncJobs(db, Apps.GoogleDrive, AuthType.OAuth)
  for (const syncJob of syncJobs) {
    let stats = newStats()
    try {
      const connector = await getOAuthConnectorWithCredentials(
        db,
        syncJob.connectorId,
      )
      const user = await getUserById(db, connector.userId)
      const oauthTokens: GoogleTokens = connector.oauthCredentials
      const oauth2Client = new google.auth.OAuth2()
      const config: ChangeToken = syncJob.config as ChangeToken
      // we have guarantee that when we started this job access Token at least
      // hand one hour, we should increase this time
      oauth2Client.setCredentials({ access_token: oauthTokens.accessToken })
      const driveClient = google.drive({ version: "v3", auth: oauth2Client })
      // TODO: add pagination for all the possible changes
      const { changes, newStartPageToken } = (
        await driveClient.changes.list({ pageToken: config.token })
      ).data
      // there are changes

      // Potential issues:
      // we remove the doc but don't update the syncJob
      // leading to us trying to remove the doc again which throws error
      // as it is already removed
      // we should still update it in that case?
      if (
        changes?.length &&
        newStartPageToken &&
        newStartPageToken !== config.token
      ) {
        Logger.info(`total changes:  ${changes.length}`)
        for (const change of changes) {
          let changeStats = await handleGoogleDriveChange(
            change,
            oauth2Client,
            user.email,
          )
          stats = mergeStats(stats, changeStats)
        }
        const newConfig = {
          lastSyncedAt: new Date(),
          token: newStartPageToken,
        }
        // update this sync job and
        // create sync history
        await db.transaction(async (trx) => {
          await updateSyncJob(trx, syncJob.id, {
            config: newConfig,
            lastRanOn: new Date(),
            status: SyncJobStatus.Successful,
          })
          // make it compatible with sync history config type
          await insertSyncHistory(trx, {
            workspaceId: syncJob.workspaceId,
            workspaceExternalId: syncJob.workspaceExternalId,
            dataAdded: stats.added,
            dataDeleted: stats.removed,
            dataUpdated: stats.updated,
            authType: AuthType.OAuth,
            summary: { description: stats.summary },
            errorMessage: "",
            app: Apps.GoogleDrive,
            status: SyncJobStatus.Successful,
            config: {
              token: newConfig.token,
              lastSyncedAt: newConfig.lastSyncedAt.toISOString(),
            },
            type: SyncCron.ChangeToken,
            lastRanOn: new Date(),
          })
        })
        Logger.info(`Changes successfully synced: ${JSON.stringify(stats)}`)
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      Logger.error(
        `Could not successfully complete sync job: ${syncJob.id} due to ${errorMessage}`,
      )
      const config: ChangeToken = syncJob.config as ChangeToken
      const newConfig = {
        token: config.token as string,
        lastSyncedAt: config.lastSyncedAt.toISOString(),
      }
      await insertSyncHistory(db, {
        workspaceId: syncJob.workspaceId,
        workspaceExternalId: syncJob.workspaceExternalId,
        dataAdded: stats.added,
        dataDeleted: stats.removed,
        dataUpdated: stats.updated,
        authType: AuthType.OAuth,
        summary: { description: stats.summary },
        errorMessage,
        app: Apps.GoogleDrive,
        status: SyncJobStatus.Failed,
        config: newConfig,
        type: SyncCron.ChangeToken,
        lastRanOn: new Date(),
      })
      throw new SyncJobFailed({
        message: "Could not complete sync job",
        cause: error as Error,
        integration: Apps.GoogleDrive,
        entity: "",
      })
    }
  }
}
export const handleGoogleServiceAccountChanges = async (
  boss: PgBoss,
  job: PgBoss.Job<any>,
) => {
  Logger.info("handleGoogleServiceAccountChanges")
  const data = job.data
  const syncJobs = await getAppSyncJobs(
    db,
    Apps.GoogleDrive,
    AuthType.ServiceAccount,
  )
  for (const syncJob of syncJobs) {
    let stats = newStats()
    try {
      const connector = await getConnector(db, syncJob.connectorId)
      const user = await getUserById(db, connector.userId)
      const serviceAccountKey: GoogleServiceAccount = JSON.parse(
        connector.credentials as string,
      )
      // const subject: string = connector.subject as string
      let jwtClient = createJwtClient(serviceAccountKey, syncJob.email)
      const driveClient = google.drive({ version: "v3", auth: jwtClient })
      const config: ChangeToken = syncJob.config as ChangeToken
      // TODO: add pagination for all the possible changes
      const { changes, newStartPageToken } = (
        await driveClient.changes.list({ pageToken: config.token })
      ).data
      // there are changes

      // Potential issues:
      // we remove the doc but don't update the syncJob
      // leading to us trying to remove the doc again which throws error
      // as it is already removed
      // we should still update it in that case?
      if (
        changes?.length &&
        newStartPageToken &&
        newStartPageToken !== config.token
      ) {
        Logger.info(`total changes:  ${changes.length}`)
        for (const change of changes) {
          let changeStats = await handleGoogleDriveChange(
            change,
            jwtClient,
            user.email,
          )
          stats = mergeStats(stats, changeStats)
        }
        const newConfig = {
          lastSyncedAt: new Date(),
          token: newStartPageToken,
        }
        // update this sync job and
        // create sync history
        await db.transaction(async (trx) => {
          await updateSyncJob(trx, syncJob.id, {
            config: newConfig,
            lastRanOn: new Date(),
            status: SyncJobStatus.Successful,
          })
          // make it compatible with sync history config type
          await insertSyncHistory(trx, {
            workspaceId: syncJob.workspaceId,
            workspaceExternalId: syncJob.workspaceExternalId,
            dataAdded: stats.added,
            dataDeleted: stats.removed,
            dataUpdated: stats.updated,
            authType: AuthType.ServiceAccount,
            summary: { description: stats.summary },
            errorMessage: "",
            app: Apps.GoogleDrive,
            status: SyncJobStatus.Successful,
            config: {
              token: newConfig.token,
              lastSyncedAt: newConfig.lastSyncedAt.toISOString(),
            },
            type: SyncCron.ChangeToken,
            lastRanOn: new Date(),
          })
        })
        Logger.info(`Changes successfully synced: ${JSON.stringify(stats)}`)
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      Logger.error(
        `Could not successfully complete sync job: ${syncJob.id} due to ${errorMessage}`,
      )
      const config: ChangeToken = syncJob.config as ChangeToken
      const newConfig = {
        token: config.token as string,
        lastSyncedAt: config.lastSyncedAt.toISOString(),
      }
      await insertSyncHistory(db, {
        workspaceId: syncJob.workspaceId,
        workspaceExternalId: syncJob.workspaceExternalId,
        dataAdded: stats.added,
        dataDeleted: stats.removed,
        dataUpdated: stats.updated,
        authType: AuthType.ServiceAccount,
        summary: { description: stats.summary },
        errorMessage,
        app: Apps.GoogleDrive,
        status: SyncJobStatus.Failed,
        config: newConfig,
        type: SyncCron.ChangeToken,
        lastRanOn: new Date(),
      })
      throw new SyncJobFailed({
        message: "Could not complete sync job",
        cause: error as Error,
        integration: Apps.GoogleDrive,
        entity: "",
      })
    }
  }
}

const newStats = (): ChangeStats => {
  return {
    added: 0,
    removed: 0,
    updated: 0,
    summary: "",
  }
}

const mergeStats = (prev: ChangeStats, current: ChangeStats): ChangeStats => {
  prev.added += current.added
  prev.updated += current.updated
  prev.removed += current.removed
  prev.summary += `\n${current.summary}`
  return prev
}
