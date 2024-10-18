import {
  admin_directory_v1,
  admin_reports_v1,
  docs_v1,
  drive_v3,
  google,
  people_v1,
} from "googleapis"
import {
  Subsystem,
  SyncCron,
  type ChangeToken,
  type GoogleChangeToken,
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
  fileSchema,
  GetDocument,
  insertDocument,
  UpdateDocumentPermissions,
  userSchema,
} from "@/search/vespa"
import { db } from "@/db/client"
import {
  Apps,
  AuthType,
  SyncJobStatus,
  DriveEntity,
  GooglePeopleEntity,
} from "@/shared/types"
import type { GoogleTokens } from "arctic"
import { getAppSyncJobs, updateSyncJob } from "@/db/syncJob"
import { getUserById } from "@/db/user"
import { insertSyncHistory } from "@/db/syncHistory"
import { getErrorMessage } from "@/utils"
import {
  createJwtClient,
  driveFileToIndexed,
  DriveMime,
  getFile,
  getFileContent,
  getPDFContent,
  MimeMapForContent,
  toPermissionsList,
} from "./utils"
import { SyncJobFailed } from "@/errors"
import { getLogger } from "@/logger"
import type { VespaFile } from "@/search/types"
import { insertContact } from "@/integrations/google"

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
      try {
        const doc = await GetDocument(docId)
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
            await DeleteDocument(docId, fileSchema)
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
      } catch (err) {
        Logger.error(
          `Trying to delete document that doesnt exist in Vespa`,
          err,
        )
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
      Logger.warn(
        `Could not get document ${docId}, probably does not exist, ${e}`,
      )
      stats.added += 1
    }
    // for these mime types we fetch the file
    // with the full processing
    let vespaData
    // TODO: make this generic
    if (file.mimeType && MimeMapForContent[file.mimeType]) {
      if (file.mimeType === DriveMime.PDF) {
        console.log("Running getPDFContent now...........")
        vespaData = await getPDFContent(client, file, DriveEntity.PDF)
        stats.summary += `indexed new content ${docId}\n`
      } else {
        vespaData = await getFileContent(client, file, DriveEntity.Docs)
        if (doc) {
          stats.summary += `updated the content for ${docId}\n`
        } else {
          stats.summary += `indexed new content ${docId}\n`
        }
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
    if (vespaData) {
      vespaData.permissions = toPermissionsList(vespaData.permissions, email)
      insertDocument(vespaData)
    }
  } else if (change.driveId) {
    // TODO: handle this once we support multiple drives
  } else {
    Logger.error("Could not handle change: ", change)
  }
  return stats
}

const contactKeys = [
  "names",
  "emailAddresses",
  "photos",
  "organizations",
  "metadata",
  "urls",
  "birthdays",
  "genders",
  "occupations",
  "userDefined",
]

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
      // flag to know if there were any updates
      let changesExist = false
      const connector = await getOAuthConnectorWithCredentials(
        db,
        syncJob.connectorId,
      )
      const user = await getUserById(db, connector.userId)
      const oauthTokens: GoogleTokens = connector.oauthCredentials
      const oauth2Client = new google.auth.OAuth2()
      let config: GoogleChangeToken = syncJob.config as GoogleChangeToken
      // we have guarantee that when we started this job access Token at least
      // hand one hour, we should increase this time
      oauth2Client.setCredentials({ access_token: oauthTokens.accessToken })

      const driveClient = google.drive({ version: "v3", auth: oauth2Client })
      // TODO: add pagination for all the possible changes
      const { changes, newStartPageToken } = (
        await driveClient.changes.list({ pageToken: config.driveToken })
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
        newStartPageToken !== config.driveToken
      ) {
        Logger.info(`total changes:  ${changes.length}`)
        for (const change of changes) {
          let changeStats = await handleGoogleDriveChange(
            change,
            oauth2Client,
            user.email,
          )
          stats = mergeStats(stats, changeStats)
          changesExist = true
        }
      }
      const peopleService = google.people({ version: "v1", auth: oauth2Client })
      let nextPageToken = ""
      let contactsToken = config.contactsToken
      let otherContactsToken = config.otherContactsToken
      do {
        const response = await peopleService.people.connections.list({
          resourceName: "people/me",
          personFields: contactKeys.join(","),
          syncToken: config.contactsToken,
          requestSyncToken: true,
          pageSize: 1000, // Adjust the page size based on your quota and needs
          pageToken: nextPageToken, // Use the nextPageToken for pagination
        })
        contactsToken = response.data.nextSyncToken ?? contactsToken
        nextPageToken = response.data.nextPageToken ?? nextPageToken
        if (response.data.connections) {
          let changeStats = await syncContacts(
            peopleService,
            response.data.connections,
            user.email,
            GooglePeopleEntity.Contacts,
          )
          stats = mergeStats(stats, changeStats)
          changesExist = true
        }
      } while (nextPageToken)

      // reset
      nextPageToken = ""

      do {
        const response = await peopleService.otherContacts.list({
          pageSize: 1000,
          readMask: contactKeys.join(","),
          syncToken: otherContactsToken,
          pageToken: nextPageToken,
          requestSyncToken: true,
          sources: ["READ_SOURCE_TYPE_PROFILE", "READ_SOURCE_TYPE_CONTACT"],
        })
        otherContactsToken = response.data.nextSyncToken ?? otherContactsToken
        nextPageToken = response.data.nextPageToken ?? nextPageToken
        if (response.data.otherContacts) {
          let changeStats = await syncContacts(
            peopleService,
            response.data.otherContacts,
            user.email,
            GooglePeopleEntity.OtherContacts,
          )

          stats = mergeStats(stats, changeStats)
          changesExist = true
        }
      } while (nextPageToken)
      if (changesExist) {
        config = {
          lastSyncedAt: new Date(),
          driveToken: newStartPageToken ?? config.driveToken,
          contactsToken,
          otherContactsToken,
        }

        // update this sync job and
        // create sync history
        await db.transaction(async (trx) => {
          await updateSyncJob(trx, syncJob.id, {
            config,
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
              ...config,
              lastSyncedAt: config.lastSyncedAt.toISOString(),
            },
            type: SyncCron.ChangeToken,
            lastRanOn: new Date(),
          })
        })
        Logger.info(`Changes successfully synced: ${JSON.stringify(stats)}`)
      } else {
        Logger.info(`No changes to sync`)
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      Logger.error(
        `Could not successfully complete sync job: ${syncJob.id} due to ${errorMessage}`,
      )
      const config: GoogleChangeToken = syncJob.config as GoogleChangeToken
      const newConfig = {
        ...config,
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

const syncContacts = async (
  client: people_v1.People,
  contacts: people_v1.Schema$Person[],
  email: string,
  entity: GooglePeopleEntity,
): Promise<ChangeStats> => {
  const stats = newStats()
  const connections = contacts || [] // Get contacts from current page
  // check if deleted else update/add
  for (const contact of connections) {
    // if the contact is deleted
    if (contact.metadata?.deleted && contact.resourceName) {
      await DeleteDocument(contact.resourceName, userSchema)
      stats.removed += 1
    } else {
      // TODO: distinction between insert vs update
      if (contact.resourceName) {
        if (entity === GooglePeopleEntity.Contacts) {
          // we probably don't need this get
          const contactResp = await client.people.get({
            resourceName: contact.resourceName,
            personFields: contactKeys.join(","),
          })
          await insertContact(contactResp.data, entity, email)
        } else if (entity === GooglePeopleEntity.OtherContacts) {
          // insert as is what we got for the changes
          await insertContact(contact, entity, email)
        }
        stats.added += 1
        Logger.info(`Updated contact ${contact.resourceName}`)
      }
    }
  }
  return stats
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
      // flag to know if there were any updates
      let changesExist = false
      const connector = await getConnector(db, syncJob.connectorId)
      const user = await getUserById(db, connector.userId)
      const serviceAccountKey: GoogleServiceAccount = JSON.parse(
        connector.credentials as string,
      )
      // const subject: string = connector.subject as string
      let jwtClient = createJwtClient(serviceAccountKey, syncJob.email)
      const driveClient = google.drive({ version: "v3", auth: jwtClient })
      const config: GoogleChangeToken = syncJob.config as GoogleChangeToken
      // TODO: add pagination for all the possible changes
      const { changes, newStartPageToken } = (
        await driveClient.changes.list({ pageToken: config.driveToken })
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
        newStartPageToken !== config.driveToken
      ) {
        Logger.info(`About to Sync Drive changes:  ${changes.length}`)
        for (const change of changes) {
          let changeStats = await handleGoogleDriveChange(
            change,
            jwtClient,
            user.email,
          )
          stats = mergeStats(stats, changeStats)
        }
        changesExist = true
      }
      const peopleService = google.people({
        version: "v1",
        auth: jwtClient,
      })
      let nextPageToken = ""
      let contactsToken = config.contactsToken
      let otherContactsToken = config.otherContactsToken
      do {
        const response = await peopleService.people.connections.list({
          resourceName: "people/me",
          personFields: contactKeys.join(","),
          syncToken: config.contactsToken,
          requestSyncToken: true,
          pageSize: 1000, // Adjust the page size based on your quota and needs
          pageToken: nextPageToken, // Use the nextPageToken for pagination
        })
        contactsToken = response.data.nextSyncToken ?? contactsToken
        if (response.data.connections && response.data.connections.length) {
          Logger.info(
            `About to update ${response.data.connections.length} contacts`,
          )
          let changeStats = await syncContacts(
            peopleService,
            response.data.connections,
            user.email,
            GooglePeopleEntity.Contacts,
          )
          stats = mergeStats(stats, changeStats)
          changesExist = true
        }
      } while (nextPageToken)

      // reset
      nextPageToken = ""

      do {
        const response = await peopleService.otherContacts.list({
          pageSize: 1000,
          readMask: contactKeys.join(","),
          syncToken: otherContactsToken,
          pageToken: nextPageToken,
          requestSyncToken: true,
          sources: ["READ_SOURCE_TYPE_PROFILE", "READ_SOURCE_TYPE_CONTACT"],
        })
        otherContactsToken = response.data.nextSyncToken ?? otherContactsToken
        if (response.data.otherContacts && response.data.otherContacts.length) {
          Logger.info(
            `About to update ${response.data.otherContacts.length} other contacts`,
          )
          let changeStats = await syncContacts(
            peopleService,
            response.data.otherContacts,
            user.email,
            GooglePeopleEntity.OtherContacts,
          )
          stats = mergeStats(stats, changeStats)
          changesExist = true
        }
      } while (nextPageToken)
      if (changesExist) {
        const newConfig = {
          driveToken: newStartPageToken ?? config.driveToken,
          contactsToken,
          otherContactsToken,
          lastSyncedAt: new Date(),
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
              ...newConfig,
              lastSyncedAt: newConfig.lastSyncedAt.toISOString(),
            },
            type: SyncCron.ChangeToken,
            lastRanOn: new Date(),
          })
        })
        Logger.info(`Changes successfully synced: ${JSON.stringify(stats)}`)
      } else {
        Logger.info(`No changes to sync`)
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      Logger.error(
        `Could not successfully complete sync job: ${syncJob.id} due to ${errorMessage} ${(error as Error).stack}`,
      )
      const config: ChangeToken = syncJob.config as ChangeToken
      const newConfig = {
        ...config,
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
