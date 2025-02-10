import { calendar_v3, drive_v3, gmail_v1, google, people_v1 } from "googleapis"
import {
  Subsystem,
  SyncCron,
  type CalendarEventsChangeToken,
  type ChangeToken,
  type GmailChangeToken,
  type GoogleChangeToken,
  type GoogleClient,
  type GoogleServiceAccount,
} from "@/types"
import PgBoss from "pg-boss"
import { getConnector, getOAuthConnectorWithCredentials } from "@/db/connector"
import {
  DeleteDocument,
  GetDocument,
  getDocumentOrNull,
  insert,
  insertDocument,
  UpdateDocument,
  UpdateDocumentPermissions,
  UpdateEventCancelledInstances,
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
  getSheetsFromSpreadSheet,
  MimeMapForContent,
  toPermissionsList,
} from "./utils"
import { SyncJobFailed } from "@/errors"
import { getLogger } from "@/logger"
import {
  CalendarEntity,
  eventSchema,
  fileSchema,
  mailSchema,
  userSchema,
  type VespaEvent,
  type VespaFile,
  type VespaMail,
} from "@/search/types"
import {
  eventFields,
  getAttachments,
  getAttendeesOfEvent,
  getEventStartTime,
  getJoiningLink,
  getPresentationToBeIngested,
  getSpreadsheet,
  getTextFromEventDescription,
  getUniqueEmails,
  insertContact,
} from "@/integrations/google"
import { parseMail } from "./gmail"
import { type VespaFileWithDrivePermission } from "@/search/types"
import type { GaxiosError } from "gaxios"

const Logger = getLogger(Subsystem.Integrations).child({ module: "google" })

// TODO: change summary to json
// and store all the structured details
type ChangeStats = {
  added: number
  removed: number
  updated: number
  summary: string
}

const getDocumentOrSpreadsheet = async (docId: string) => {
  try {
    const doc = await getDocumentOrNull(fileSchema, docId)
    if (!doc) {
      Logger.error(
        `Found no document with ${docId}, checking for spreadsheet with ${docId}_0`,
      )
      const sheetsForSpreadSheet = await GetDocument(fileSchema, `${docId}_0`)
      return sheetsForSpreadSheet
    }
    return doc
  } catch (err) {
    Logger.error(err, `Error getting document`)
    throw err
  }
}

const deleteUpdateStatsForGoogleSheets = async (
  docId: string,
  client: GoogleClient,
  stats: ChangeStats,
) => {
  const spreadsheetId = docId
  const sheets = google.sheets({ version: "v4", auth: client })
  const spreadsheet = await getSpreadsheet(sheets, spreadsheetId!)
  const totalSheets = spreadsheet.data.sheets?.length!

  // Case where the whole spreadsheet is not deleted but some sheets are deleted
  // If the sheets in vespa don't match the current sheets, we delete the rest of them
  // Check if the sheets we have in vespa are same as we get
  // If not, it means maybe sheet/s can be deleted
  const spreadSheetFromVespa = await GetDocument(
    fileSchema,
    `${spreadsheetId}_0`,
  )
  const metadata = JSON.parse(
    //@ts-ignore
    (spreadSheetFromVespa.fields as VespaFile)?.metadata,
  )!
  const totalSheetsFromVespa = metadata?.totalSheets!

  if (
    totalSheets !== totalSheetsFromVespa &&
    totalSheets < totalSheetsFromVespa
  ) {
    // Condition will be true, if some sheets are deleted and not whole spreadsheet
    for (let id = totalSheets; id < totalSheetsFromVespa; id++) {
      await DeleteDocument(`${spreadsheetId}_${id}`, fileSchema)
      stats.removed += 1
      stats.summary += `${spreadsheetId}_${id} sheet removed\n`
    }
  }

  // Check for each sheetIndex, if that sheet if already there in vespa or not
  for (let sheetIndex = 0; sheetIndex < totalSheets; sheetIndex++) {
    const id = `${spreadsheetId}_${sheetIndex}`
    try {
      await GetDocument(fileSchema, id)
      stats.updated += 1
      continue
    } catch (e) {
      stats.added += 1
      continue
    }
  }
}

const deleteWholeSpreadsheet = async (
  docFields: VespaFile,
  docId: string,
  stats: ChangeStats,
  email: string,
) => {
  // Get metadata from the first sheet of that spreadsheet
  // Metadata contains all sheets ids inside that specific spreadsheet
  // @ts-ignore
  const metadata = JSON.parse(docFields?.metadata)!
  const totalSheets = metadata.totalSheets!
  // A Google spreadsheet can have multiple sheets inside it
  // Admin can take away permissions from any of that sheets of the spreadsheet
  const spreadsheetId = docId
  // Remove all sheets inside that spreadsheet
  for (let sheetIndex = 0; sheetIndex < totalSheets; sheetIndex++) {
    const id = `${spreadsheetId}_${sheetIndex}`
    const doc = await GetDocument(fileSchema, id)
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
        await DeleteDocument(id, fileSchema)
        stats.removed += 1
        stats.summary += `${id} sheet removed\n`
      } catch (e) {
        // TODO: detect vespa 404 and only ignore for that case
        // otherwise throw it further
      }
    } else {
      // remove our user's permission from the email
      const newPermissions = permissions.filter((v) => v !== email)
      await UpdateDocumentPermissions(fileSchema, id, newPermissions)
      stats.updated += 1
      stats.summary += `user lost permission for sheet: ${id}\n`
    }
  }
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
        const doc = await getDocumentOrSpreadsheet(docId)
        // Check if its spreadsheet
        if ((doc.fields as VespaFile).mimeType === DriveMime.Sheets) {
          await deleteWholeSpreadsheet(
            doc.fields as VespaFile,
            docId,
            stats,
            email,
          )
        } else {
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
            await UpdateDocumentPermissions(fileSchema, docId, newPermissions)
            stats.updated += 1
            stats.summary += `user lost permission for doc: ${docId}\n`
          }
        }
      } catch (err) {
        Logger.error(err, `Failed to delete document in Vespa \n ${err}`)
      }
    }
  } else if (docId && change.file) {
    const file = await getFile(client, docId)
    // we want to check if the doc already existed in vespa
    // and we are just updating the content of it
    // or user got access to a completely new doc
    let doc = null
    try {
      if (
        file.mimeType &&
        MimeMapForContent[file.mimeType] &&
        file.mimeType === DriveMime.Sheets
      ) {
        await deleteUpdateStatsForGoogleSheets(docId, client, stats)
      } else {
        doc = await GetDocument(fileSchema, docId)
        stats.updated += 1
      }
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
        vespaData = await getPDFContent(client, file, DriveEntity.PDF)
        stats.summary += `indexed new content ${docId}\n`
      } else if (file.mimeType === DriveMime.Sheets) {
        vespaData = await getSheetsFromSpreadSheet(
          client,
          file,
          DriveEntity.Sheets,
        )
        stats.summary += `added ${stats.added} sheets & updated ${stats.updated} for ${docId}\n`
      } else if (file.mimeType === DriveMime.Slides) {
        vespaData = await getPresentationToBeIngested(file, client)
        if (doc) {
          stats.summary += `updated the content for ${docId}\n`
        } else {
          stats.summary += `indexed new content ${docId}\n`
        }
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
      vespaData = await driveFileToIndexed(client, file)
    }
    if (vespaData) {
      // If vespaData is of array type containing multiple things
      if (Array.isArray(vespaData)) {
        let allData: VespaFileWithDrivePermission[] = [...vespaData].map(
          (v) => {
            v.permissions = toPermissionsList(v.permissions, email)
            return v
          },
        )
        for (const data of allData) {
          insertDocument(data)
        }
      } else {
        vespaData.permissions = toPermissionsList(vespaData.permissions, email)
        insertDocument(vespaData)
      }
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

// TODO: check early, if new change token is same as last
// return early
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
        nextPageToken = response.data.nextPageToken ?? ""
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
        nextPageToken = response.data.nextPageToken ?? ""
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
          type: "googleDriveChangeToken",
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
        Logger.info(
          `Changes successfully synced for Drive: ${JSON.stringify(stats)}`,
        )
      } else {
        Logger.info(`No changes to sync`)
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      Logger.error(
        error,
        `Could not successfully complete sync job: ${syncJob.id} due to ${errorMessage} :  ${(error as Error).stack}`,
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
        message: `Could not complete sync job: ${stats.summary}`,
        cause: error as Error,
        integration: Apps.GoogleDrive,
        entity: "",
      })
    }
  }

  const gmailSyncJobs = await getAppSyncJobs(db, Apps.Gmail, AuthType.OAuth)
  let stats = newStats()
  for (const syncJob of gmailSyncJobs) {
    try {
      // flag to know if there were any updates
      const connector = await getOAuthConnectorWithCredentials(
        db,
        syncJob.connectorId,
      )
      const user = await getUserById(db, connector.userId)
      const oauthTokens: GoogleTokens = connector.oauthCredentials
      const oauth2Client = new google.auth.OAuth2()
      let config: GmailChangeToken = syncJob.config as GmailChangeToken
      // we have guarantee that when we started this job access Token at least
      // hand one hour, we should increase this time
      oauth2Client.setCredentials({ access_token: oauthTokens.accessToken })
      const gmail = google.gmail({ version: "v1", auth: oauth2Client })

      let { historyId, stats, changesExist } = await handleGmailChanges(
        gmail,
        config.historyId,
        syncJob.id,
        syncJob.email,
      )

      if (changesExist) {
        // update the change token
        config.historyId = historyId
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
            app: Apps.Gmail,
            status: SyncJobStatus.Successful,
            config: {
              ...config,
              lastSyncedAt: config.lastSyncedAt.toISOString(),
            },
            type: SyncCron.ChangeToken,
            lastRanOn: new Date(),
          })
        })
        Logger.info(
          `Changes successfully synced for Gmail: ${JSON.stringify(stats)}`,
        )
      } else {
        Logger.info(`No Gmail changes to sync`)
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      Logger.error(
        error,
        `Could not successfully complete Oauth sync job for Gmail: ${syncJob.id} due to ${errorMessage} ${(error as Error).stack}`,
      )
      const config: GmailChangeToken = syncJob.config as GmailChangeToken
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
        app: Apps.Gmail,
        status: SyncJobStatus.Failed,
        config: newConfig,
        type: SyncCron.ChangeToken,
        lastRanOn: new Date(),
      })
      throw new SyncJobFailed({
        message: "Could not complete sync job",
        cause: error as Error,
        integration: Apps.Gmail,
        entity: "",
      })
    }
  }

  // For Calendar Events Sync
  const gCalEventSyncJobs = await getAppSyncJobs(
    db,
    Apps.GoogleCalendar,
    AuthType.OAuth,
  )
  for (const syncJob of gCalEventSyncJobs) {
    let stats = newStats()
    try {
      // flag to know if there were any updates
      const connector = await getOAuthConnectorWithCredentials(
        db,
        syncJob.connectorId,
      )
      const oauthTokens: GoogleTokens = connector.oauthCredentials
      const oauth2Client = new google.auth.OAuth2()
      let config: CalendarEventsChangeToken =
        syncJob.config as CalendarEventsChangeToken
      // we have guarantee that when we started this job access Token at least
      // hand one hour, we should increase this time
      oauth2Client.setCredentials({ access_token: oauthTokens.accessToken })
      const calendar = google.calendar({ version: "v3", auth: oauth2Client })

      let { eventChanges, stats, newCalendarEventsSyncToken, changesExist } =
        await handleGoogleCalendarEventsChanges(
          calendar,
          config.calendarEventsToken,
          syncJob.email,
        )

      if (changesExist) {
        // update the change token
        config.calendarEventsToken = newCalendarEventsSyncToken
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
            app: Apps.GoogleCalendar,
            status: SyncJobStatus.Successful,
            config: {
              ...config,
              lastSyncedAt: config.lastSyncedAt.toISOString(),
            },
            type: SyncCron.ChangeToken,
            lastRanOn: new Date(),
          })
        })
        Logger.info(
          `Changes successfully synced for Google Calendar Events: ${JSON.stringify(stats)}`,
        )
      } else {
        Logger.info(`No Google Calendar Event changes to sync`)
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      Logger.error(
        error,
        `Could not successfully complete Oauth sync job for Google Calendar: ${syncJob.id} due to ${errorMessage} ${(error as Error).stack}`,
      )
      const config: CalendarEventsChangeToken =
        syncJob.config as CalendarEventsChangeToken
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
        app: Apps.GoogleCalendar,
        status: SyncJobStatus.Failed,
        config: newConfig,
        type: SyncCron.ChangeToken,
        lastRanOn: new Date(),
      })
      throw new SyncJobFailed({
        message: "Could not complete sync job",
        cause: error as Error,
        integration: Apps.GoogleCalendar,
        entity: "",
      })
    }
  }
}

const insertEventIntoVespa = async (event: calendar_v3.Schema$Event) => {
  const { baseUrl, joiningUrl } = getJoiningLink(event)
  const { attendeesInfo, attendeesEmails, attendeesNames } =
    getAttendeesOfEvent(event.attendees ?? [])
  const { attachmentsInfo, attachmentFilenames } = getAttachments(
    event.attachments ?? [],
  )
  const { isDefaultStartTime, startTime } = getEventStartTime(event)
  const eventToBeIngested = {
    docId: event.id ?? "",
    name: event.summary ?? "",
    description: getTextFromEventDescription(event?.description ?? ""),
    url: event.htmlLink ?? "", // eventLink, not joiningLink
    status: event.status ?? "",
    location: event.location ?? "",
    createdAt: new Date(event.created!).getTime(),
    updatedAt: new Date(event.updated!).getTime(),
    app: Apps.GoogleCalendar,
    entity: CalendarEntity.Event,
    creator: {
      email: event.creator?.email ?? "",
      displayName: event.creator?.displayName ?? "",
    },
    organizer: {
      email: event.organizer?.email ?? "",
      displayName: event.organizer?.displayName ?? "",
    },
    attendees: attendeesInfo,
    attendeesNames: attendeesNames,
    startTime: startTime,
    endTime: new Date(event.end?.dateTime!).getTime(),
    attachmentFilenames,
    attachments: attachmentsInfo,
    recurrence: event.recurrence ?? [], // Contains recurrence metadata of recurring events like RRULE, etc
    baseUrl,
    joiningLink: joiningUrl,
    permissions: getUniqueEmails([
      event.organizer?.email ?? "",
      ...attendeesEmails,
    ]),
    cancelledInstances: [],
    defaultStartTime: isDefaultStartTime,
  }

  await insert(eventToBeIngested, eventSchema)
}

const maxCalendarEventChangeResults = 2500

const handleGoogleCalendarEventsChanges = async (
  calendar: calendar_v3.Calendar,
  syncToken: string,
  userEmail: string,
) => {
  let changesExist = false
  const stats = newStats()
  let nextPageToken = ""
  // will be returned in the end
  let newSyncTokenCalendarEvents: string = ""

  let eventChanges: calendar_v3.Schema$Event[] = []

  try {
    do {
      const res = await calendar.events.list({
        calendarId: "primary", // Use 'primary' for the primary calendar
        maxResults: maxCalendarEventChangeResults, // Limit the number of results
        pageToken: nextPageToken,
        syncToken,
        fields: eventFields,
      })

      newSyncTokenCalendarEvents = res.data.nextSyncToken ?? syncToken
      // Check if there are no new changes
      if (newSyncTokenCalendarEvents === syncToken) {
        return {
          eventChanges: [],
          stats,
          newCalendarEventsSyncToken: newSyncTokenCalendarEvents,
          changesExist,
        }
      }

      if (res.data.items) {
        eventChanges = eventChanges.concat(res.data.items)
      }

      for (const eventChange of eventChanges) {
        const docId = eventChange.id
        if (docId && eventChange.status === "cancelled") {
          // We only delete the whole recurring event, when all instances are deleted
          // When the whole recurring event is deleted, GetDocument will not give error
          try {
            const event = await getDocumentOrNull(eventSchema, docId)
            // For Recurring events, when an instance/s are deleted, we just update the cancelledInstances property
            if (!event) {
              // Splitting the id into eventId and instanceDataTime
              // Breaking 5cng0k77oaakthnrr2k340lf6p_20241114T170000Z into 5cng0k77oaakthnrr2k340lf6p & 20241114T170000Z
              const splittedId = docId.split("_")
              const eventId = splittedId[0]
              const instanceDateTime = splittedId[1]
              Logger.error(
                `Found no document with ${docId}, checking for event with ${eventId}`,
              )
              // Update this event and add a instanceDateTime cancelledInstances property
              try {
                const eventFromVespa = await GetDocument(eventSchema, eventId)
                const oldCancelledInstances =
                  (eventFromVespa.fields as VespaEvent).cancelledInstances ?? []

                if (!oldCancelledInstances?.includes(instanceDateTime)) {
                  // Do this only if instanceDateTime not already inside oldCancelledInstances
                  const newCancelledInstances = [
                    ...oldCancelledInstances,
                    instanceDateTime,
                  ]

                  if (eventFromVespa) {
                    await UpdateEventCancelledInstances(
                      eventSchema,
                      eventId,
                      newCancelledInstances,
                    )
                    stats.updated += 1
                    stats.summary += `updated cancelledInstances of event: ${docId}\n`
                    changesExist = true
                  }
                }
              } catch (error) {
                Logger.error(
                  error,
                  `Can't find document to delete, probably doesn't exist`,
                )
              } finally {
                continue
              }
            }
            const permissions = (event?.fields as VespaEvent)?.permissions
            if (permissions?.length === 1) {
              // remove it
              try {
                // also ensure that we are that permission
                if (!(permissions[0] === userEmail)) {
                  throw new Error(
                    "We got a change for us that we didn't have access to in Vespa",
                  )
                }
                await DeleteDocument(docId, eventSchema)
                stats.removed += 1
                stats.summary += `${docId} event removed\n`
                changesExist = true
              } catch (e) {
                // TODO: detect vespa 404 and only ignore for that case
                // otherwise throw it further
              }
            } else {
              // remove our user's permission to change event
              const newPermissions = permissions?.filter((v) => v !== userEmail)
              await UpdateDocumentPermissions(
                eventSchema,
                docId,
                newPermissions,
              )
              stats.updated += 1
              stats.summary += `user lost permission to change event info: ${docId}\n`
              changesExist = true
            }
          } catch (err: any) {
            Logger.error(
              err,
              `Error getting document: ${err.message} ${err.stack}`,
            )
            throw err
          }
        } else if (docId) {
          let event = null
          try {
            event = await GetDocument(eventSchema, docId!)
          } catch (error) {
            Logger.error(error, `Event doesn't exist in Vepsa`)
          }

          await insertEventIntoVespa(eventChange)

          if (event) {
            stats.updated += 1
            stats.summary += `updated event ${docId}\n`
            changesExist = true
          } else {
            stats.added += 1
            stats.summary += `added new event ${docId}`
            changesExist = true
          }
        } else {
          Logger.error("Could not handle event change: ", eventChange)
        }
      }
      nextPageToken = res.data.nextPageToken ?? ""
    } while (nextPageToken)

    return {
      eventChanges,
      stats,
      newCalendarEventsSyncToken: newSyncTokenCalendarEvents,
      changesExist,
    }
  } catch (err) {
    throw err
  }
}

const maxChangeResults = 500

// TODO: handle the error case more deeply, systematically store these
// https://developers.google.com/gmail/api/reference/rest/v1/users.history/list
// "History IDs increase chronologically but are not contiguous with random gaps in between valid IDs.
// Supplying an invalid or out of date startHistoryId typically returns an HTTP 404 error code.
// A historyId is typically valid for at least a week, but in some rare circumstances may be valid for only a few hours.
// If you receive an HTTP 404 error response, your application should perform a full sync."
// errors in gmail history:
// Requested entity was not found. Error: Requested entity was not found.
// it seems history id can expire? or some issue is there hence we put multiple
// try catch internally
const handleGmailChanges = async (
  gmail: gmail_v1.Gmail,
  historyId: string,
  syncJobId: number,
  userEmail: string,
): Promise<{
  historyId: string
  stats: ChangeStats
  changesExist: boolean
}> => {
  let changesExist = false
  const stats = newStats()
  let nextPageToken = ""
  let newHistoryId = historyId

  try {
    do {
      const res = await gmail.users.history.list({
        userId: "me",
        startHistoryId: historyId,
        maxResults: maxChangeResults,
        pageToken: nextPageToken,
      })
      newHistoryId = res.data.historyId ?? historyId

      // Check if there are no new changes
      if (newHistoryId === historyId) {
        return { stats, historyId: newHistoryId, changesExist }
      }

      if (res.data.history) {
        // Sort the history records by historyId in ascending order
        res.data.history.sort((a, b) => {
          if (a.id && b.id) {
            return parseInt(a.id) - parseInt(b.id)
          }
          return 0
        })

        for (const history of res.data.history) {
          if (history.messagesAdded) {
            for (const { message } of history.messagesAdded) {
              try {
                const msgResp = await gmail.users.messages.get({
                  userId: "me",
                  id: message?.id!,
                  format: "full",
                })

                await insert(
                  await parseMail(msgResp.data, gmail, userEmail),
                  mailSchema,
                )
                stats.added += 1
                changesExist = true
              } catch (error) {
                // Handle errors if the message no longer exists
                Logger.error(
                  error,
                  `Failed to fetch added message ${message?.id} in historyId ${history.id}: ${error}`,
                )
              }
            }
          }
          if (history.messagesDeleted) {
            for (const { message } of history.messagesDeleted) {
              try {
                const mailMsg = await GetDocument(mailSchema, message?.id!)
                const permissions = (mailMsg.fields as VespaMail).permissions
                if (permissions.length === 1) {
                  await DeleteDocument(message?.id!, mailSchema)
                } else {
                  const newPermissions = permissions.filter(
                    (v) => v !== userEmail,
                  )
                  await UpdateDocumentPermissions(
                    mailSchema,
                    message?.id!,
                    newPermissions,
                  )
                }
                stats.removed += 1
                changesExist = true
              } catch (error) {
                // Handle errors if the document no longer exists
                Logger.error(
                  error,
                  `Failed to delete message ${message?.id} in historyId ${history.id}: ${error}`,
                )
              }
            }
          }
          if (history.labelsAdded) {
            for (const { message, labelIds } of history.labelsAdded) {
              try {
                const mailMsg = await GetDocument(mailSchema, message?.id!)
                let labels = (mailMsg.fields as VespaMail).labels || []
                labels = labels.concat(labelIds || [])
                await UpdateDocument(mailSchema, message?.id!, { labels })
                stats.updated += 1
                changesExist = true
              } catch (error) {
                Logger.error(
                  error,
                  `Failed to add labels to message ${message?.id} in historyId ${history.id}: ${error}`,
                )
              }
            }
          }
          if (history.labelsRemoved) {
            for (const { message, labelIds } of history.labelsRemoved) {
              try {
                const mailMsg = await GetDocument(mailSchema, message?.id!)
                let labels = (mailMsg.fields as VespaMail).labels || []
                labels = labels.filter(
                  (label) => !(labelIds || []).includes(label),
                )
                await UpdateDocument(mailSchema, message?.id!, { labels })
                stats.updated += 1
                changesExist = true
              } catch (error) {
                Logger.error(
                  error,
                  `Failed to remove labels from message ${message?.id} in historyId ${history.id}: ${error}`,
                )
              }
            }
          }
        }
      }
      nextPageToken = res.data.nextPageToken || ""
    } while (nextPageToken)
  } catch (error) {
    if (
      (error as any).code === 404 ||
      (error as any).message.includes("Requested entity was not found")
    ) {
      // Log the error and return without updating the historyId
      Logger.error(
        error,
        `Invalid historyId ${historyId}. Sync cannot proceed: ${error}`,
      )
      return { stats, historyId: newHistoryId, changesExist }
    } else {
      throw error
    }
  }

  return { historyId: newHistoryId, stats, changesExist }
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
      try {
        do {
          const response = await peopleService.people.connections.list({
            resourceName: "people/me",
            personFields: contactKeys.join(","),
            syncToken: config.contactsToken,
            requestSyncToken: true,
            pageSize: 1000, // Adjust the page size based on your quota and needs
            pageToken: nextPageToken, // Use the nextPageToken for pagination
          })
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
      } catch (error) {
        // if sync token is expired then we don't throw it further
        // we will handle this case, it will require a full sync
        if (
          (error as GaxiosError).response &&
          (error as GaxiosError).response?.status === 400 &&
          (error as GaxiosError).message ===
            "Sync token is expired. Clear local cache and retry call without the sync token."
        ) {
          Logger.warn(
            "This is an error that is not yet implemented, it requires a full sync of the contacts api",
          )
        } else {
          throw error
        }
      }
      // reset
      nextPageToken = ""
      try {
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
          if (
            response.data.otherContacts &&
            response.data.otherContacts.length
          ) {
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
      } catch (error) {
        // if sync token is expired then we don't throw it further
        // we will handle this case, it will require a full sync
        if (
          (error as GaxiosError).response &&
          (error as GaxiosError).response?.status === 400 &&
          (error as GaxiosError).message ===
            "Sync token is expired. Clear local cache and retry call without the sync token."
        ) {
          Logger.warn(
            "This is an error that is not yet implemented, it requires a full sync of the other contacts api",
          )
        } else {
          throw error
        }
      }
      if (changesExist) {
        const newConfig = {
          type: config.type,
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
        error,
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
  const gmailSyncJobs = await getAppSyncJobs(
    db,
    Apps.Gmail,
    AuthType.ServiceAccount,
  )
  let stats = newStats()
  for (const syncJob of gmailSyncJobs) {
    try {
      const connector = await getConnector(db, syncJob.connectorId)
      const serviceAccountKey: GoogleServiceAccount = JSON.parse(
        connector.credentials as string,
      )
      // const subject: string = connector.subject as string
      let jwtClient = createJwtClient(serviceAccountKey, syncJob.email)

      let config: GmailChangeToken = syncJob.config as GmailChangeToken
      // we have guarantee that when we started this job access Token at least
      // hand one hour, we should increase this time
      const gmail = google.gmail({ version: "v1", auth: jwtClient })

      let { historyId, stats, changesExist } = await handleGmailChanges(
        gmail,
        config.historyId,
        syncJob.id,
        syncJob.email,
      )

      if (changesExist) {
        // update the change token
        config.historyId = historyId
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
            authType: AuthType.ServiceAccount,
            summary: { description: stats.summary },
            errorMessage: "",
            app: Apps.Gmail,
            status: SyncJobStatus.Successful,
            config: {
              ...config,
              lastSyncedAt: config.lastSyncedAt.toISOString(),
            },
            type: SyncCron.ChangeToken,
            lastRanOn: new Date(),
          })
        })
        Logger.info(
          `Changes successfully synced for Gmail: ${JSON.stringify(stats)}`,
        )
      } else {
        Logger.info(`No Gmail changes to sync`)
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      Logger.error(
        error,
        `Could not successfully complete ServiceAccount sync job for Gmail: ${syncJob.id} due to ${errorMessage} ${(error as Error).stack}`,
      )
      const config: GmailChangeToken = syncJob.config as GmailChangeToken
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
        app: Apps.Gmail,
        status: SyncJobStatus.Failed,
        config: newConfig,
        type: SyncCron.ChangeToken,
        lastRanOn: new Date(),
      })
      throw new SyncJobFailed({
        message: "Could not complete sync job",
        cause: error as Error,
        integration: Apps.Gmail,
        entity: "",
      })
    }
  }

  // For Calendar Events Sync
  const gCalEventSyncJobs = await getAppSyncJobs(
    db,
    Apps.GoogleCalendar,
    AuthType.ServiceAccount,
  )
  for (const syncJob of gCalEventSyncJobs) {
    try {
      const connector = await getConnector(db, syncJob.connectorId)
      const serviceAccountKey: GoogleServiceAccount = JSON.parse(
        connector.credentials as string,
      )
      // const subject: string = connector.subject as string
      let jwtClient = createJwtClient(serviceAccountKey, syncJob.email)

      let config: CalendarEventsChangeToken =
        syncJob.config as CalendarEventsChangeToken
      // we have guarantee that when we started this job access Token at least
      // hand one hour, we should increase this time
      const calendar = google.calendar({ version: "v3", auth: jwtClient })

      let { eventChanges, stats, newCalendarEventsSyncToken, changesExist } =
        await handleGoogleCalendarEventsChanges(
          calendar,
          config.calendarEventsToken,
          syncJob.email,
        )

      if (changesExist) {
        // update the change token
        config.calendarEventsToken = newCalendarEventsSyncToken
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
            authType: AuthType.ServiceAccount,
            summary: { description: stats.summary },
            errorMessage: "",
            app: Apps.GoogleCalendar,
            status: SyncJobStatus.Successful,
            config: {
              ...config,
              lastSyncedAt: config.lastSyncedAt.toISOString(),
            },
            type: SyncCron.ChangeToken,
            lastRanOn: new Date(),
          })
        })
        Logger.info(
          `Changes successfully synced for Google Calendar Events: ${JSON.stringify(stats)}`,
        )
      } else {
        Logger.info(`No Google Calendar Event changes to sync`)
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      if (
        errorMessage ===
        "Sync token is no longer valid, a full sync is required."
      ) {
        console.log("continuing")
        continue
      }

      Logger.error(
        error,
        `Could not successfully complete ServiceAccount sync job for Google Calendar: ${syncJob.id} due to ${errorMessage} ${(error as Error).stack}`,
      )

      if (
        errorMessage ===
        "Sync token is no longer valid, a full sync is required."
      ) {
        continue
      }
      const config: CalendarEventsChangeToken =
        syncJob.config as CalendarEventsChangeToken
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
        app: Apps.GoogleCalendar,
        status: SyncJobStatus.Failed,
        config: newConfig,
        type: SyncCron.ChangeToken,
        lastRanOn: new Date(),
      })
      throw new SyncJobFailed({
        message: "Could not complete sync job",
        cause: error as Error,
        integration: Apps.GoogleCalendar,
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
