import {
  admin_directory_v1,
  calendar_v3,
  docs_v1,
  drive_v3,
  google,
  people_v1,
  sheets_v4,
} from "googleapis"
import {
  extractFootnotes,
  extractHeadersAndFooters,
  extractText,
  postProcessText,
} from "@/doc"
import { chunkDocument } from "@/chunks"
import {
  MessageTypes,
  Subsystem,
  SyncCron,
  WorkerResponseTypes,
  type GoogleClient,
  type GoogleServiceAccount,
  type SaaSJob,
  type SaaSOAuthJob,
} from "@/types"
import PgBoss from "pg-boss"
import { getConnector, getOAuthConnectorWithCredentials } from "@/db/connector"
import {
  GetDocument,
  insert,
  insertDocument,
  insertUser,
  UpdateEventCancelledInstances,
} from "@/search/vespa"
import { SaaSQueue } from "@/queue"
import { wsConnections } from "@/integrations/google/ws"
import type { WSContext } from "hono/ws"
import { db } from "@/db/client"
import { connectors, type SelectConnector } from "@/db/schema"
import { eq } from "drizzle-orm"
import { getWorkspaceById } from "@/db/workspace"
import {
  Apps,
  AuthType,
  ConnectorStatus,
  SyncJobStatus,
  DriveEntity,
  GooglePeopleEntity,
} from "@/shared/types"
import type { GoogleTokens } from "arctic"
import { getAppSyncJobs, insertSyncJob, updateSyncJob } from "@/db/syncJob"
import type { GaxiosResponse } from "gaxios"
import { insertSyncHistory } from "@/db/syncHistory"
import { getErrorMessage, retryWithBackoff } from "@/utils"
import {
  createJwtClient,
  DocsParsingError,
  driveFileToIndexed,
  DriveMime,
  getFile,
  toPermissionsList,
} from "@/integrations/google/utils"
import { getLogger } from "@/logger"
import {
  CalendarEntity,
  eventSchema,
  type VespaEvent,
  type VespaFileWithDrivePermission,
} from "@/search/types"
import {
  UserListingError,
  CouldNotFinishJobSuccessfully,
  ContactListingError,
  ContactMappingError,
  ErrorInsertingDocument,
  DeleteDocumentError,
  DownloadDocumentError,
  CalendarEventsListingError,
} from "@/errors"
import fs, { existsSync, mkdirSync } from "node:fs"
import path, { join } from "node:path"
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf"
import { unlink } from "node:fs/promises"
import type { Document } from "@langchain/core/documents"
import {
  MAX_GD_PDF_SIZE,
  MAX_GD_SHEET_ROWS,
  MAX_GD_SHEET_TEXT_LEN,
  MAX_GD_SLIDES_TEXT_LEN,
  PDFProcessingConcurrency,
  ServiceAccountUserConcurrency,
} from "@/integrations/google/config"
import { handleGmailIngestion } from "@/integrations/google/gmail"
import pLimit from "p-limit"
import { GoogleDocsConcurrency } from "./config"
import {
  getProgress,
  markUserComplete,
  oAuthTracker,
  serviceAccountTracker,
  setOAuthUser,
  setTotalUsers,
  StatType,
  updateUserStats,
} from "./tracking"
const htmlToText = require("html-to-text")
const Logger = getLogger(Subsystem.Integrations).child({ module: "google" })

const gmailWorker = new Worker(new URL("gmail-worker.ts", import.meta.url).href)

export type GaxiosPromise<T = any> = Promise<GaxiosResponse<T>>

const listUsers = async (
  admin: admin_directory_v1.Admin,
  domain: string,
): Promise<admin_directory_v1.Schema$User[]> => {
  let users: admin_directory_v1.Schema$User[] = []
  let nextPageToken = null
  try {
    do {
      const res: GaxiosResponse<admin_directory_v1.Schema$Users> =
        await admin.users.list({
          domain: domain,
          maxResults: 500,
          orderBy: "email",
          ...(nextPageToken ? { pageToken: nextPageToken } : {}),
        })
      if (res.data.users) {
        users = users.concat(res.data.users)
      }

      nextPageToken = res.data.nextPageToken
    } while (nextPageToken)
    return users
  } catch (error) {
    Logger.error(
      error,
      `Error listing users: ${error} ${(error as Error).stack}`,
    )
    throw new UserListingError({
      cause: error as Error,
      integration: Apps.GoogleWorkspace,
      entity: "user",
    })
  }
}

class SyncJobsCountError extends Error {}

export const syncGoogleWorkspace = async (
  boss: PgBoss,
  job: PgBoss.Job<any>,
) => {
  // catch needs access to this
  const syncJobs = await getAppSyncJobs(
    db,
    Apps.GoogleWorkspace,
    AuthType.ServiceAccount,
  )
  try {
    // there should only be 1 job for syncing the google workspace
    if (syncJobs.length > 1 || !syncJobs.length) {
      throw new SyncJobsCountError(
        "Could not sync Google Workspace invalid sync job count",
      )
    }
    const syncJob = syncJobs[0]
    const data = job.data
    const connector = await getConnector(db, data.connectorId)
    const serviceAccountKey: GoogleServiceAccount = JSON.parse(
      connector.credentials as string,
    )
    const subject: string = connector.subject as string
    let jwtClient = createJwtClient(serviceAccountKey, subject)
    const admin = google.admin({ version: "directory_v1", auth: jwtClient })

    const workspace = await getWorkspaceById(db, connector.workspaceId)
    // TODO: handle multiple domains
    const users = await listUsers(admin, workspace.domain)

    const updatedCount = users.length
    // TODO: better handle the data stats
    await insertUsersForWorkspace(users)
    await db.transaction(async (trx) => {
      await updateSyncJob(trx, syncJob.id, {
        config: { updatedAt: new Date(), type: "updatedAt" },
        lastRanOn: new Date(),
        status: SyncJobStatus.Successful,
      })
      // make it compatible with sync history config type
      await insertSyncHistory(trx, {
        workspaceId: syncJob.workspaceId,
        workspaceExternalId: syncJob.workspaceExternalId,
        dataAdded: 0,
        dataDeleted: 0,
        dataUpdated: updatedCount,
        authType: AuthType.ServiceAccount,
        summary: { description: `updated ${updatedCount} users` },
        errorMessage: "",
        app: Apps.GoogleWorkspace,
        status: SyncJobStatus.Successful,
        config: { updatedAt: new Date().toISOString(), type: "updatedAt" },
        type: SyncCron.FullSync,
        lastRanOn: new Date(),
      })
    })
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    Logger.error(
      error,
      `Could not sync Google workspace: , ${errorMessage} ${(error as Error).stack}`,
    )
    if (error instanceof SyncJobsCountError) {
      boss.fail(job.name, job.id)
      return
    }
    const syncJob = syncJobs[0]
    // sync job has to exist
    await insertSyncHistory(db, {
      workspaceId: syncJob.workspaceId,
      workspaceExternalId: syncJob.workspaceExternalId,
      dataAdded: 0,
      dataDeleted: 0,
      dataUpdated: 0,
      authType: AuthType.ServiceAccount,
      summary: { description: "" },
      errorMessage,
      app: Apps.GoogleWorkspace,
      status: SyncJobStatus.Failed,
      config: { updatedAt: new Date().toISOString(), type: "updatedAt" },
      type: SyncCron.FullSync,
      lastRanOn: new Date(),
    })
    boss.fail(job.name, job.id)
    throw new CouldNotFinishJobSuccessfully({
      integration: Apps.GoogleWorkspace,
      entity: "",
      cause: error as Error,
    })
  }
}

export const getTextFromEventDescription = (description: string): string => {
  return htmlToText.convert(description, { wordwrap: 130 })
}

const getBaseUrlFromUrl = (url: string) => {
  try {
    if (url) {
      const parsedUrl = new URL(url)
      return `${parsedUrl.protocol}//${parsedUrl.host}`
    }
  } catch (error) {
    console.error("Invalid URL:", error)
    return ""
  }
}

const getLinkFromDescription = (description: string): string => {
  // Check if the description is provided and not empty
  if (description) {
    const htmlString = htmlToText.convert(description, {
      // If html is normally parsed, an `a` tag is parsed like below:
      // <---- Link Title [https://actualLink.com] ----> OR <---- https://actualLink.com [https://actualLink.com] ---->
      // This gives us only => https://actualLink.com
      selectors: [
        {
          selector: "a",
          options: {
            hideLinkHrefIfSameAsText: true, // Hide href if it's the same as text
            linkBrackets: false, // Exclude brackets around links
          },
        },
      ],
    })

    // Regular expression to match URLs
    const urlRegex = /(https?:\/\/[^\s]+)/g

    // Extract all possible links from the htmlString
    const links = htmlString.match(urlRegex) || []

    // Define the Zoom link identifier
    const zoomLinkIdentifier = "zoom.us"

    if (links?.length !== 0) {
      // Search through each link to find a Zoom link
      for (const link of links) {
        const url = new URL(link)
        const hostname = url.hostname
        if (
          hostname.endsWith(zoomLinkIdentifier) ||
          hostname === zoomLinkIdentifier
        ) {
          return link // Return the href if it contains 'zoom.us'
        }
      }
    }
  }
  return "" // Return "" if no Zoom link is found
}

export const getJoiningLink = (event: calendar_v3.Schema$Event) => {
  const conferenceLink = event?.conferenceData?.entryPoints![0]?.uri
  if (conferenceLink) {
    return {
      baseUrl: getBaseUrlFromUrl(conferenceLink) ?? "",
      joiningUrl: conferenceLink ?? "",
    }
  } else {
    // Check if any joining Link is there in description
    // By deafult only Google meet links are there in confereneData
    const description = event.description ?? ""
    const linkFromDesc = getLinkFromDescription(description)
    return {
      baseUrl: getBaseUrlFromUrl(linkFromDesc) ?? "",
      joiningUrl: linkFromDesc ?? "",
    }
  }
}

export const getAttendeesOfEvent = (
  allAttendes: calendar_v3.Schema$EventAttendee[],
) => {
  if (allAttendes.length === 0) {
    return { attendeesInfo: [], attendeesEmails: [], attendeesNames: [] }
  }

  const attendeesInfo: { email: string; displayName: string }[] = []
  const attendeesNames: string[] = []
  const attendeesEmails: string[] = []
  for (const attendee of allAttendes) {
    if (attendee.displayName) {
      attendeesNames.push(attendee.displayName ?? "")
    }

    if (attendee.email) {
      attendeesEmails.push(attendee.email)
    }

    const oneAttendee = { email: "", displayName: "" }
    oneAttendee.email = attendee.email ?? ""
    if (attendee.displayName) {
      oneAttendee.displayName = attendee.displayName ?? ""
    }

    attendeesInfo.push(oneAttendee)
  }

  return { attendeesInfo, attendeesEmails, attendeesNames }
}

export const getAttachments = (
  allAttachments: calendar_v3.Schema$EventAttachment[],
) => {
  if (allAttachments.length === 0) {
    return { attachmentsInfo: [], attachmentFilenames: [] }
  }

  const attachmentsInfo = []
  const attachmentFilenames = []

  for (const attachment of allAttachments) {
    attachmentFilenames.push(attachment.title ?? "")

    const oneAttachment = { fileId: "", title: "", mimeType: "", fileUrl: "" }
    oneAttachment.fileId = attachment.fileId ?? ""
    oneAttachment.title = attachment.title ?? ""
    oneAttachment.mimeType = attachment.mimeType ?? ""
    oneAttachment.fileUrl = attachment.fileUrl ?? ""

    attachmentsInfo.push(oneAttachment)
  }

  return { attachmentsInfo, attachmentFilenames }
}

export const getUniqueEmails = (permissions: string[]): string[] => {
  return Array.from(new Set(permissions.filter((email) => email.trim() !== "")))
}

export const getEventStartTime = (event: calendar_v3.Schema$Event) => {
  if (event?.start?.dateTime) {
    return {
      isDefaultStartTime: false,
      startTime: new Date(event.start?.dateTime!).getTime(),
    }
  } else if (event?.start?.date) {
    return {
      isDefaultStartTime: true,
      startTime: new Date(event.start.date!).getTime(),
    }
  } else {
    return { isDefaultStartTime: true, startTime: new Date().getTime() }
  }
}

export const eventFields =
  "nextPageToken, nextSyncToken, items(id, status, htmlLink, created, updated, location, summary, description, creator(email, displayName), organizer(email, displayName), start, end, recurrence, attendees(email, displayName), conferenceData, attachments)"

export const maxCalendarEventResults = 2500

const insertCalendarEvents = async (
  client: GoogleClient,
  userEmail: string,
) => {
  let nextPageToken = ""
  // will be returned in the end
  let newSyncTokenCalendarEvents: string = ""

  let events: calendar_v3.Schema$Event[] = []
  const calendar = google.calendar({ version: "v3", auth: client })

  const currentDateTime = new Date()
  const nextYearDateTime = new Date(currentDateTime)

  // Set the date one year later
  // To get all events from current Date to One Year later
  nextYearDateTime.setFullYear(currentDateTime.getFullYear() + 1)

  // we will fetch from one year back
  currentDateTime.setFullYear(currentDateTime.getFullYear() - 1)
  do {
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: currentDateTime.toISOString(),
      timeMax: nextYearDateTime.toISOString(),
      maxResults: maxCalendarEventResults, // Limit the number of results
      pageToken: nextPageToken,
      fields: eventFields,
    })
    if (res.data.items) {
      events = events.concat(res.data.items)
    }
    nextPageToken = res.data.nextPageToken ?? ""
    newSyncTokenCalendarEvents = res.data.nextSyncToken ?? ""
  } while (nextPageToken)

  if (events.length === 0) {
    return { events: [], calendarEventsToken: newSyncTokenCalendarEvents }
  }

  const confirmedEvents = events.filter((e) => e.status === "confirmed")
  // Handle cancelledEvents separately
  const cancelledEvents = events.filter((e) => e.status === "cancelled")

  // First insert only the confirmed events
  for (const event of confirmedEvents) {
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
    updateUserStats(userEmail, StatType.Events, 1)
  }

  // Add the cancelled events into cancelledInstances array of their respective main event
  for (const event of cancelledEvents) {
    // add this instance to the cancelledInstances arr of main recurring event
    // don't add it as seperate event
    const instanceEventId = event.id ?? ""
    const splittedId = instanceEventId?.split("_") ?? ""
    const mainEventId = splittedId[0]
    const instanceDateTime = splittedId[1]

    try {
      // Get the main event from Vespa
      // Add the new instanceDateTime to its cancelledInstances
      const eventFromVespa = await GetDocument(eventSchema, mainEventId)
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
            mainEventId,
            newCancelledInstances,
          )
        }
      }
    } catch (error) {
      Logger.error(
        error,
        `Main Event ${mainEventId} not found in Vespa to update cancelled instance ${instanceDateTime} of ${instanceEventId}`,
      )
    }
  }

  if (!newSyncTokenCalendarEvents) {
    throw new CalendarEventsListingError({
      message: "Could not get sync tokens for Google Calendar Events",
      integration: Apps.GoogleCalendar,
      entity: CalendarEntity.Event,
    })
  }

  return { events, calendarEventsToken: newSyncTokenCalendarEvents }
}

export const handleGoogleOAuthIngestion = async (
  boss: PgBoss,
  job: PgBoss.Job<any>,
) => {
  Logger.info("handleGoogleOauthIngestion", job.data)
  const data: SaaSOAuthJob = job.data as SaaSOAuthJob
  try {
    // we will first fetch the change token
    // and poll the changes in a new Cron Job
    const connector: SelectConnector = await getOAuthConnectorWithCredentials(
      db,
      data.connectorId,
    )
    const userEmail = job.data.email
    const oauthTokens: GoogleTokens = connector.oauthCredentials
    const oauth2Client = new google.auth.OAuth2()

    setOAuthUser(userEmail)
    const interval = setInterval(() => {
      sendWebsocketMessage(
        JSON.stringify({
          progress: () => {},
          userStats: oAuthTracker.userStats,
        }),
        connector.externalId,
      )
    }, 4000)

    // we have guarantee that when we started this job access Token at least
    // hand one hour, we should increase this time
    oauth2Client.setCredentials({ access_token: oauthTokens.accessToken })
    const driveClient = google.drive({ version: "v3", auth: oauth2Client })
    const { contacts, otherContacts, contactsToken, otherContactsToken } =
      await listAllContacts(oauth2Client)
    await insertContactsToVespa(contacts, otherContacts, userEmail)
    // get change token for any changes during drive integration
    const { startPageToken }: drive_v3.Schema$StartPageToken = (
      await driveClient.changes.getStartPageToken()
    ).data
    if (!startPageToken) {
      throw new Error("Could not get start page token")
    }

    const [_, historyId, { calendarEventsToken }] = await Promise.all([
      insertFilesForUser(oauth2Client, userEmail, connector),
      handleGmailIngestion(oauth2Client, userEmail),
      insertCalendarEvents(oauth2Client, userEmail),
    ])

    setTimeout(() => {
      clearInterval(interval)
    }, 8000)

    const changeTokens = {
      driveToken: startPageToken,
      type: "googleDriveChangeToken",
      contactsToken,
      otherContactsToken,
      lastSyncedAt: new Date().toISOString(),
    }
    await db.transaction(async (trx) => {
      await trx
        .update(connectors)
        .set({
          status: ConnectorStatus.Connected,
        })
        .where(eq(connectors.id, connector.id))
      // create the SyncJob
      await insertSyncJob(trx, {
        workspaceId: connector.workspaceId,
        workspaceExternalId: connector.workspaceExternalId,
        app: Apps.GoogleDrive,
        connectorId: connector.id,
        authType: AuthType.OAuth,
        config: changeTokens,
        email: userEmail,
        type: SyncCron.ChangeToken,
        status: SyncJobStatus.NotStarted,
      })
      await insertSyncJob(trx, {
        workspaceId: connector.workspaceId,
        workspaceExternalId: connector.workspaceExternalId,
        app: Apps.Gmail,
        connectorId: connector.id,
        authType: AuthType.OAuth,
        config: {
          historyId,
          type: "gmailChangeToken",
          lastSyncedAt: new Date().toISOString(),
        },
        email: userEmail,
        type: SyncCron.ChangeToken,
        status: SyncJobStatus.NotStarted,
      })
      // For inserting Google CalendarEvent Change Job
      await insertSyncJob(trx, {
        workspaceId: connector.workspaceId,
        workspaceExternalId: connector.workspaceExternalId,
        app: Apps.GoogleCalendar,
        connectorId: connector.id,
        authType: AuthType.OAuth,
        config: {
          calendarEventsToken,
          type: "calendarEventsChangeToken",
          lastSyncedAt: new Date().toISOString(),
        },
        email: userEmail,
        type: SyncCron.ChangeToken,
        status: SyncJobStatus.NotStarted,
      })
      await boss.complete(SaaSQueue, job.id)
      Logger.info("job completed")
    })
  } catch (error) {
    Logger.error(
      error,
      `could not finish job successfully: ${(error as Error).message} ${(error as Error).stack}`,
      error,
    )
    await db.transaction(async (trx) => {
      trx
        .update(connectors)
        .set({
          status: ConnectorStatus.Failed,
        })
        .where(eq(connectors.id, data.connectorId))
      await boss.fail(job.name, job.id)
    })
    throw new CouldNotFinishJobSuccessfully({
      message: "Could not finish Oauth ingestion",
      integration: Apps.GoogleDrive,
      entity: "files",
      cause: error as Error,
    })
  }
}

type IngestionMetadata = {
  email: string
  driveToken: string
  contactsToken: string
  otherContactsToken: string
  // gmail
  historyId: string
  // calendar events token
  calendarEventsToken: string
}

import { z } from "zod"

const stats = z.object({
  type: z.literal(WorkerResponseTypes.Stats),
  userEmail: z.string(),
  count: z.number(),
  statType: z.nativeEnum(StatType),
})

const historyId = z.object({
  type: z.literal(WorkerResponseTypes.HistoryId),
  historyId: z.string(),
  userEmail: z.string(),
})
const messageTypes = z.discriminatedUnion("type", [stats, historyId])

type ResponseType = z.infer<typeof messageTypes>

gmailWorker.onerror = (error: ErrorEvent) => {
  Logger.error(error, `Error in main thread: worker: ${JSON.stringify(error)}`)
}

const pendingRequests = new Map<
  string,
  { resolve: Function; reject: Function }
>()

// Set up a centralized `onmessage` handler
gmailWorker.onmessage = (message: MessageEvent<ResponseType>) => {
  const { type, userEmail } = message.data

  if (type === WorkerResponseTypes.HistoryId) {
    const { historyId } = message.data
    const promiseHandlers = pendingRequests.get(userEmail)
    if (promiseHandlers) {
      promiseHandlers.resolve(historyId)
      pendingRequests.delete(userEmail)
    }
  } else if (message.data.type === WorkerResponseTypes.Stats) {
    const { userEmail, count, statType } = message.data
    updateUserStats(userEmail, statType, count)
  }

  // else if (type === WorkerResponseTypes.Error) {
  //     const { error } = message.data;
  //     const promiseHandlers = pendingRequests.get(userEmail);
  //     if (promiseHandlers) {
  //         promiseHandlers.reject(new Error(error));
  //         pendingRequests.delete(userEmail);
  //     }
  // }
}

// Define a function to handle ingestion
const handleGmailIngestionForServiceAccount = async (
  userEmail: string,
  serviceAccountKey: GoogleServiceAccount,
): Promise<string> => {
  return new Promise((resolve, reject) => {
    pendingRequests.set(userEmail, { resolve, reject })
    gmailWorker.postMessage({
      type: MessageTypes.JwtParams,
      userEmail,
      serviceAccountKey,
    })
    Logger.info(`Sent message to worker for ${userEmail}`)
  })
}

// we make 2 sync jobs
// one for drive and one for google workspace
export const handleGoogleServiceAccountIngestion = async (
  boss: PgBoss,
  job: PgBoss.Job<any>,
) => {
  Logger.info("handleGoogleServiceAccountIngestion", job.data)
  const data: SaaSJob = job.data as SaaSJob
  try {
    const connector = await getConnector(db, data.connectorId)
    const serviceAccountKey: GoogleServiceAccount = JSON.parse(
      connector.credentials as string,
    )
    const subject: string = connector.subject as string
    const adminJwtClient = createJwtClient(serviceAccountKey, subject)
    const admin = google.admin({
      version: "directory_v1",
      auth: adminJwtClient,
    })

    const workspace = await getWorkspaceById(db, connector.workspaceId)
    const users = await listUsers(admin, workspace.domain)
    setTotalUsers(users.length)
    const ingestionMetadata: IngestionMetadata[] = []

    // Use p-limit to handle concurrency
    const limit = pLimit(ServiceAccountUserConcurrency)

    const interval = setInterval(() => {
      sendWebsocketMessage(
        JSON.stringify({
          progress: getProgress(),
          userStats: serviceAccountTracker.userStats,
        }),
        connector.externalId,
      )
    }, 4000)

    // Map each user to a promise but limit concurrent execution
    const promises = users.map((user) =>
      limit(async () => {
        const userEmail = user.primaryEmail || user.emails[0]
        const jwtClient = createJwtClient(serviceAccountKey, userEmail)
        const driveClient = google.drive({ version: "v3", auth: jwtClient })

        const { contacts, otherContacts, contactsToken, otherContactsToken } =
          await listAllContacts(jwtClient)
        await insertContactsToVespa(contacts, otherContacts, userEmail)

        const { startPageToken }: drive_v3.Schema$StartPageToken = (
          await driveClient.changes.getStartPageToken()
        ).data
        if (!startPageToken) {
          throw new Error("Could not get start page token")
        }

        const [_, historyId, { calendarEventsToken }] = await Promise.all([
          insertFilesForUser(jwtClient, userEmail, connector),
          handleGmailIngestionForServiceAccount(userEmail, serviceAccountKey),
          insertCalendarEvents(jwtClient, userEmail),
        ])

        markUserComplete(userEmail)
        return {
          email: userEmail,
          driveToken: startPageToken,
          contactsToken,
          otherContactsToken,
          historyId,
          calendarEventsToken,
        }
      }),
    )

    // Wait for all promises to complete
    const results = await Promise.all(promises)
    ingestionMetadata.push(...results)

    // Rest of the function remains the same...
    // insert all the workspace users
    await insertUsersForWorkspace(users)

    setTimeout(() => {
      clearInterval(interval)
    }, 8000)
    await db.transaction(async (trx) => {
      for (const {
        email,
        driveToken,
        contactsToken,
        otherContactsToken,
        historyId,
        calendarEventsToken,
      } of ingestionMetadata) {
        // drive and contacts per user
        await insertSyncJob(trx, {
          workspaceId: connector.workspaceId,
          workspaceExternalId: connector.workspaceExternalId,
          app: Apps.GoogleDrive,
          connectorId: connector.id,
          authType: AuthType.ServiceAccount,
          config: {
            driveToken,
            contactsToken,
            type: "googleDriveChangeToken",
            otherContactsToken,
            lastSyncedAt: new Date().toISOString(),
          },
          email,
          type: SyncCron.ChangeToken,
          status: SyncJobStatus.NotStarted,
        })
        // gmail per user
        await insertSyncJob(trx, {
          workspaceId: connector.workspaceId,
          workspaceExternalId: connector.workspaceExternalId,
          app: Apps.Gmail,
          connectorId: connector.id,
          authType: AuthType.ServiceAccount,
          config: {
            historyId,
            type: "gmailChangeToken",
            lastSyncedAt: new Date().toISOString(),
          },
          email,
          type: SyncCron.ChangeToken,
          status: SyncJobStatus.NotStarted,
        })
        // For inserting Google CalendarEvent Change Job
        await insertSyncJob(trx, {
          workspaceId: connector.workspaceId,
          workspaceExternalId: connector.workspaceExternalId,
          app: Apps.GoogleCalendar,
          connectorId: connector.id,
          authType: AuthType.ServiceAccount,
          config: {
            calendarEventsToken,
            type: "calendarEventsChangeToken",
            lastSyncedAt: new Date().toISOString(),
          },
          email,
          type: SyncCron.ChangeToken,
          status: SyncJobStatus.NotStarted,
        })
      }
      // workspace sync for the Org
      await insertSyncJob(trx, {
        workspaceId: connector.workspaceId,
        workspaceExternalId: connector.workspaceExternalId,
        app: Apps.GoogleWorkspace,
        connectorId: connector.id,
        authType: AuthType.ServiceAccount,
        config: { updatedAt: new Date().toISOString(), type: "updatedAt" },
        email: "",
        type: SyncCron.FullSync,
        status: SyncJobStatus.NotStarted,
      })

      await trx
        .update(connectors)
        .set({
          status: ConnectorStatus.Connected,
        })
        .where(eq(connectors.id, connector.id))
      Logger.info("status updated")
      await boss.complete(SaaSQueue, job.id)
      Logger.info("job completed")
    })
  } catch (error) {
    Logger.error(
      error,
      `could not finish job successfully: ${(error as Error).message} ${(error as Error).stack}`,
      error,
    )
    await db.transaction(async (trx) => {
      trx
        .update(connectors)
        .set({
          status: ConnectorStatus.Failed,
        })
        .where(eq(connectors.id, data.connectorId))
      await boss.fail(job.name, job.id)
    })
    throw new CouldNotFinishJobSuccessfully({
      message: "Could not finish Service Account ingestion",
      integration: Apps.GoogleWorkspace,
      entity: "files and users",
      cause: error as Error,
    })
  }
}

export const deleteDocument = async (filePath: string) => {
  try {
    await unlink(filePath)
    Logger.info(`File at ${filePath} deleted successfully`)
  } catch (err) {
    Logger.error(
      err,
      `Error deleting file at ${filePath}: ${err} ${(err as Error).stack}`,
      err,
    )
    throw new DeleteDocumentError({
      message: "Error in the catch of deleting file",
      cause: err as Error,
      integration: Apps.GoogleDrive,
      entity: DriveEntity.PDF,
    })
  }
}

export const getPresentationToBeIngested = async (
  presentation: drive_v3.Schema$File,
  client: GoogleClient,
) => {
  const slides = google.slides({ version: "v1", auth: client })
  const presentationData = await slides.presentations.get({
    presentationId: presentation.id!,
  })
  const slidesData = presentationData.data.slides!
  let chunks: string[] = []
  let totalTextLen = 0

  slidesData.forEach((slide) => {
    let slideText = ""
    slide.pageElements!.forEach((element) => {
      if (
        element.shape &&
        element.shape.text &&
        element.shape.text.textElements
      ) {
        element.shape.text.textElements.forEach((textElement) => {
          if (textElement.textRun) {
            const textContent = textElement.textRun.content!.trim()
            slideText += textContent + " "
            totalTextLen += textContent.length
          }
        })
      }
    })

    if (totalTextLen <= MAX_GD_SLIDES_TEXT_LEN) {
      // Only chunk if the total text length is within the limit
      const slideChunks = chunkDocument(slideText)
      chunks.push(...slideChunks.map((c) => c.chunk))
    }
  })

  // Index with empty content if totalTextLen exceeds MAX_GD_SLIDES_TEXT_LEN
  if (totalTextLen > MAX_GD_SLIDES_TEXT_LEN) {
    Logger.error(
      `Text Length excedded for ${presentation.name}, indexing with empty content`,
    )
    chunks = []
  }

  const parentsForMetadata = []
  if (presentation?.parents) {
    for (const parentId of presentation.parents!) {
      const parentData = await getFile(client, parentId)
      const folderName = parentData.name!
      parentsForMetadata.push({ folderName, folderId: parentId })
    }
  }

  const presentationToBeIngested = {
    title: presentation.name!,
    url: presentation.webViewLink ?? "",
    app: Apps.GoogleDrive,
    docId: presentation.id!,
    owner: presentation.owners
      ? (presentation.owners[0].displayName ?? "")
      : "",
    photoLink: presentation.owners
      ? (presentation.owners[0].photoLink ?? "")
      : "",
    ownerEmail: presentation.owners
      ? (presentation.owners[0]?.emailAddress ?? "")
      : "",
    entity: DriveEntity.Slides,
    chunks,
    permissions: presentation.permissions ?? [],
    mimeType: presentation.mimeType ?? "",
    metadata: JSON.stringify({ parents: parentsForMetadata }),
    createdAt: new Date(presentation.createdTime!).getTime(),
    updatedAt: new Date(presentation.modifiedTime!).getTime(),
  }

  return presentationToBeIngested
}

const googleSlidesVespa = async (
  client: GoogleClient,
  presentationMetadata: drive_v3.Schema$File[],
  connectorId: string,
): Promise<VespaFileWithDrivePermission[]> => {
  // sendWebsocketMessage(
  //   `Scanning ${presentationMetadata.length} Google Slides`,
  //   connectorId,
  // )
  const presentationsList: VespaFileWithDrivePermission[] = []

  const total = presentationMetadata.length
  let count = 0

  for (const presentation of presentationMetadata) {
    try {
      const presentationToBeIngested = await getPresentationToBeIngested(
        presentation,
        client,
      )
      presentationsList.push(presentationToBeIngested)
      count += 1

      // if (count % 5 === 0) {
      //   sendWebsocketMessage(`${count} Google Slides scanned`, connectorId)
      // }
    } catch (error) {
      Logger.error(
        error,
        `Error getting slides: ${error} ${(error as Error).stack}`,
        error,
      )
      continue
    }
  }
  return presentationsList
}

const insertFilesForUser = async (
  googleClient: GoogleClient,
  userEmail: string,
  connector: SelectConnector,
) => {
  try {
    let processedFiles = 0
    const iterator = listFiles(googleClient)
    for await (const pageFiles of iterator) {
      const googleDocsMetadata = pageFiles.filter(
        (v: drive_v3.Schema$File) => v.mimeType === DriveMime.Docs,
      )
      const googlePDFsMetadata = pageFiles.filter(
        (v: drive_v3.Schema$File) => v.mimeType === DriveMime.PDF,
      )
      const googleSheetsMetadata = pageFiles.filter(
        (v: drive_v3.Schema$File) => v.mimeType === DriveMime.Sheets,
      )
      const googleSlidesMetadata = pageFiles.filter(
        (v: drive_v3.Schema$File) => v.mimeType === DriveMime.Slides,
      )
      const rest = pageFiles.filter(
        (v: drive_v3.Schema$File) =>
          v.mimeType !== DriveMime.Docs &&
          v.mimeType !== DriveMime.PDF &&
          v.mimeType !== DriveMime.Sheets &&
          v.mimeType !== DriveMime.Slides,
      )
      const pdfs = (
        await googlePDFsVespa(
          googleClient,
          googlePDFsMetadata,
          connector.externalId,
          userEmail,
        )
      ).map((v) => {
        v.permissions = toPermissionsList(v.permissions, userEmail)
        return v
      })
      for (const doc of pdfs) {
        processedFiles += 1
        await insertDocument(doc)
        updateUserStats(userEmail, StatType.Drive, 1)
      }
      const [documents, slides, sheets]: [
        VespaFileWithDrivePermission[],
        VespaFileWithDrivePermission[],
        VespaFileWithDrivePermission[],
      ] = await Promise.all([
        googleDocsVespa(googleClient, googleDocsMetadata, connector.externalId),
        googleSlidesVespa(
          googleClient,
          googleSlidesMetadata,
          connector.externalId,
        ),
        googleSheetsVespa(
          googleClient,
          googleSheetsMetadata,
          connector.externalId,
          userEmail,
        ),
      ])
      const driveFiles: VespaFileWithDrivePermission[] = await driveFilesToDoc(
        googleClient,
        rest,
      )

      let allFiles: VespaFileWithDrivePermission[] = [
        ...driveFiles,
        ...documents,
        ...slides,
        ...sheets,
      ].map((v) => {
        v.permissions = toPermissionsList(v.permissions, userEmail)
        return v
      })

      for (const doc of allFiles) {
        processedFiles += 1
        await insertDocument(doc)
        updateUserStats(userEmail, StatType.Drive, 1)
      }

      Logger.info(`finished ${pageFiles.length} files`)
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    Logger.error(
      error,
      `Could not insert files for user: ${errorMessage} ${(error as Error).stack}`,
    )
  }
}

export const cleanSheetAndGetValidRows = (allRows: string[][]) => {
  const rowsWithData = allRows?.filter((row) =>
    row.some((r) => r.trim() !== ""),
  )

  if (!rowsWithData || rowsWithData.length === 0) {
    // If no row is filled, no data is there
    // Logger.warn("No data in any row. Skipping it")
    return []
  }

  let noOfCols = 0
  for (const row of rowsWithData) {
    if (row.length > noOfCols) {
      noOfCols = row.length
    }
  }

  // If some cells are empty in a row, and there are less values compared to the noOfCols
  // Put "" string in them
  const processedRows: string[][] = rowsWithData.map((row) =>
    row.length < noOfCols
      ? row.concat(Array(noOfCols - row.length).fill(""))
      : row,
  )

  if (processedRows.length < 2) {
    // One row is assumed to be headers/column names
    // Atleast one additional row for the data should be there
    // So there should be atleast two rows to continue further
    // Logger.warn("Not enough data to process further. Skipping it")
    return []
  }

  return processedRows
}

export const getAllSheetsFromSpreadSheet = async (
  sheets: sheets_v4.Sheets,
  spreadsheet: sheets_v4.Schema$Spreadsheet,
  spreadsheetId: string,
) => {
  const allSheets = []

  const gridSheets = spreadsheet.sheets!.filter(
    (sheet) => sheet.properties?.sheetType === "GRID",
  )

  const batchSize = 100
  for (let i = 0; i < gridSheets.length; i += batchSize) {
    const batchSheets = gridSheets.slice(i, i + batchSize)
    const ranges = batchSheets.map((sheet) => `'${sheet.properties!.title}'`)

    try {
      const response = await retryWithBackoff(
        () =>
          sheets.spreadsheets.values.batchGet({
            spreadsheetId,
            ranges,
            valueRenderOption: "FORMATTED_VALUE",
          }),
        `Fetching sheets '${ranges.join(", ")}' from spreadsheet`,
      )

      const valueRanges = response?.data?.valueRanges

      if (valueRanges) {
        for (let j = 0; j < valueRanges.length; j++) {
          const sheet = batchSheets[j]
          const sheetProp = sheet.properties
          const sheetId = sheetProp?.sheetId
          const sheetTitle = sheetProp?.title
          const values = valueRanges[j].values

          allSheets.push({
            sheetId,
            sheetTitle,
            valueRanges: values,
          })
        }
      }
    } catch (error) {
      Logger.error(
        error,
        `Failed to fetch sheets '${ranges.join(", ")}' from spreadsheet: ${(error as Error).message}`,
      )
    }
  }
  return allSheets
}

// Function to get the whole spreadsheet
// One spreadsheet can contain multiple sheets like Sheet1, Sheet2
export const getSpreadsheet = async (
  sheets: sheets_v4.Sheets,
  id: string,
): Promise<GaxiosResponse<sheets_v4.Schema$Spreadsheet>> => {
  return retryWithBackoff(
    () => sheets.spreadsheets.get({ spreadsheetId: id }),
    `Fetching spreadsheet with ID ${id}`,
  )
}

// Function to chunk rows of text data into manageable batches
// Excludes numerical data, assuming users do not typically search by numbers
// Concatenates all textual cells in a row into a single string
// Adds rows' string data to a chunk until the 512-character limit is exceeded
// If adding a row exceeds the limit, the chunk is added to the next chunk
// Otherwise, the row is added to the current chunk
const chunkFinalRows = (allRows: string[][]): string[] => {
  const chunks: string[] = []
  let currentChunk = ""
  let totalTextLength = 0

  for (const row of allRows) {
    // Filter out numerical cells and empty strings
    const textualCells = row.filter(
      (cell) => isNaN(Number(cell)) && cell.trim().length > 0,
    )

    if (textualCells.length === 0) continue // Skip if no textual data

    const rowText = textualCells.join(" ")

    // Check if adding this rowText would exceed the maximum text length
    if (totalTextLength + rowText.length > MAX_GD_SHEET_TEXT_LEN) {
      // Logger.warn(`Text length excedded, indexing with empty content`)
      // Return an empty array if the total text length exceeds the limit
      return []
    }

    totalTextLength += rowText.length

    if ((currentChunk + " " + rowText).trim().length > 512) {
      // Add the current chunk to the list and start a new chunk
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim())
      }
      currentChunk = rowText
    } else {
      // Append the row text to the current chunk
      currentChunk += " " + rowText
    }
  }

  if (currentChunk.trim().length > 0) {
    // Add any remaining text as the last chunk
    chunks.push(currentChunk.trim())
  }

  return chunks
}

export const getSheetsListFromOneSpreadsheet = async (
  sheets: sheets_v4.Sheets,
  client: GoogleClient,
  spreadsheet: drive_v3.Schema$File,
): Promise<VespaFileWithDrivePermission[]> => {
  const sheetsArr = []
  const spreadSheetData = await getSpreadsheet(sheets, spreadsheet.id!)

  // Now we should get all sheets inside this spreadsheet using the spreadSheetData
  const allSheetsFromSpreadSheet = await getAllSheetsFromSpreadSheet(
    sheets,
    spreadSheetData.data,
    spreadsheet.id!,
  )

  // There can be multiple parents
  // Element of parents array contains folderId and folderName
  const parentsForMetadata = []
  // Shared files cannot have parents
  // There can be some files that user has access to may not have parents as they are shared
  if (spreadsheet?.parents) {
    for (const parentId of spreadsheet?.parents!) {
      const parentData = await getFile(client, parentId)
      const folderName = parentData.name!
      parentsForMetadata.push({ folderName, folderId: parentId })
    }
  }

  for (const [sheetIndex, sheet] of allSheetsFromSpreadSheet.entries()) {
    const finalRows = cleanSheetAndGetValidRows(sheet.valueRanges ?? [])

    if (finalRows.length === 0) {
      // Logger.warn(
      //   `${spreadsheet.name} -> ${sheet.sheetTitle} found no rows. Skipping it`,
      // )
      continue
    }

    let chunks: string[] = []

    if (finalRows.length > MAX_GD_SHEET_ROWS) {
      // If there are more rows than MAX_GD_SHEET_ROWS, still index it but with empty content
      // Logger.warn(
      //   `Large no. of rows in ${spreadsheet.name} -> ${sheet.sheetTitle}, indexing with empty content`,
      // )
      chunks = []
    } else {
      chunks = chunkFinalRows(finalRows)
    }

    const sheetDataToBeIngested = {
      title: `${spreadsheet.name} / ${sheet?.sheetTitle}`,
      url: spreadsheet.webViewLink ?? "",
      app: Apps.GoogleDrive,
      // TODO Document it eveyrwhere
      // Combining spreadsheetId and sheetIndex as single spreadsheet can have multiple sheets inside it
      docId: `${spreadsheet?.id}_${sheetIndex}`,
      owner: spreadsheet.owners
        ? (spreadsheet.owners[0].displayName ?? "")
        : "",
      photoLink: spreadsheet.owners
        ? (spreadsheet.owners[0].photoLink ?? "")
        : "",
      ownerEmail: spreadsheet.owners
        ? (spreadsheet.owners[0]?.emailAddress ?? "")
        : "",
      entity: DriveEntity.Sheets,
      chunks,
      permissions: spreadsheet.permissions ?? [],
      mimeType: spreadsheet.mimeType ?? "",
      metadata: JSON.stringify({
        parents: parentsForMetadata,
        ...(sheetIndex === 0 && {
          spreadsheetId: spreadsheet.id!,
          totalSheets: spreadSheetData.data.sheets?.length!,
        }),
      }),
      createdAt: new Date(spreadsheet.createdTime!).getTime(),
      updatedAt: new Date(spreadsheet.modifiedTime!).getTime(),
    }
    sheetsArr.push(sheetDataToBeIngested)
  }
  return sheetsArr
}

const googleSheetsVespa = async (
  client: GoogleClient,
  spreadsheetsMetadata: drive_v3.Schema$File[],
  connectorId: string,
  userEmail: string,
): Promise<VespaFileWithDrivePermission[]> => {
  // sendWebsocketMessage(
  //   `Scanning ${spreadsheetsMetadata.length} Google Sheets`,
  //   connectorId,
  // )
  let sheetsList: VespaFileWithDrivePermission[] = []
  const sheets = google.sheets({ version: "v4", auth: client })
  const total = spreadsheetsMetadata.length
  let count = 0

  for (const spreadsheet of spreadsheetsMetadata) {
    try {
      const sheetsListFromOneSpreadsheet =
        await getSheetsListFromOneSpreadsheet(sheets, client, spreadsheet)
      sheetsList.push(...sheetsListFromOneSpreadsheet)
      count += 1

      // if (count % 5 === 0) {
      //   sendWebsocketMessage(`${count} Google Sheets scanned`, connectorId)
      // }
    } catch (error) {
      Logger.error(
        error,
        `Error getting sheet files: ${error} ${(error as Error).stack}`,
        error,
      )
      // throw new DownloadDocumentError({
      //   message: "Error in the catch of getting sheet files",
      //   cause: error as Error,
      //   integration: Apps.GoogleDrive,
      //   entity: DriveEntity.Sheets,
      // })
    }
  }
  // sheetsList = sheetsList.map((v) => {
  //   v.permissions = toPermissionsList(v.permissions, userEmail)
  //   return v
  // })
  // for (const doc of sheetsList) {
  //   await insertDocument(doc)
  //   updateUserStats(userEmail, StatType.Drive, 1)
  // }
  return sheetsList
}

export const downloadDir = path.resolve(__dirname, "../../downloads")

if (process.env.NODE_ENV !== "production") {
  const init = () => {
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true })
    }
  }

  init()
}

export const downloadPDF = async (
  drive: drive_v3.Drive,
  fileId: string,
  fileName: string,
): Promise<void> => {
  const filePath = path.join(downloadDir, fileName)
  const file = Bun.file(filePath)
  const writer = file.writer()
  const res = await drive.files.get(
    { fileId: fileId, alt: "media" },
    { responseType: "stream" },
  )
  return new Promise((resolve, reject) => {
    res.data.on("data", (chunk) => {
      writer.write(chunk)
    })
    res.data.on("end", () => {
      writer.end()
      resolve()
    })
    res.data.on("error", (err) => {
      writer.end()
      reject(err)
    })
  })
}

// Helper function for safer PDF loading
export async function safeLoadPDF(pdfPath: string): Promise<Document[]> {
  try {
    const loader = new PDFLoader(pdfPath)
    return await loader.load()
  } catch (error) {
    const { name, message } = error as Error
    if (
      message.includes("PasswordException") ||
      name.includes("PasswordException")
    ) {
      Logger.warn("Password protected PDF, skipping")
    } else {
      Logger.error(error, `PDF load error: ${error}`)
    }
    return []
  }
}

export const googlePDFsVespa = async (
  client: GoogleClient,
  pdfsMetadata: drive_v3.Schema$File[],
  connectorId: string,
  userEmail: string,
): Promise<VespaFileWithDrivePermission[]> => {
  const drive = google.drive({ version: "v3", auth: client })
  // a flag just for the error to know
  // if the file was downloaded or not
  const limit = pLimit(PDFProcessingConcurrency)
  const pdfPromises = pdfsMetadata.map((pdf) =>
    limit(async () => {
      const pdfSizeInMB = parseInt(pdf.size!) / (1024 * 1024)
      // Ignore the PDF files larger than Max PDF Size
      if (pdfSizeInMB > MAX_GD_PDF_SIZE) {
        Logger.warn(`Ignoring ${pdf.name} as its more than 20 MB`)
        return null
      }
      const pdfFileName = `${userEmail}_${pdf.id}_${pdf.name}`
      const pdfPath = `${downloadDir}/${pdfFileName}`
      try {
        await downloadPDF(drive, pdf.id!, pdfFileName)

        const docs: Document[] = await safeLoadPDF(pdfPath)
        if (!docs || docs.length === 0) {
          await deleteDocument(pdfPath)
          return null
        }

        const chunks = docs.flatMap((doc) => chunkDocument(doc.pageContent))

        const parentsForMetadata = []
        if (pdf?.parents) {
          for (const parentId of pdf.parents!) {
            const parentData = await getFile(client, parentId)
            const folderName = parentData.name!
            parentsForMetadata.push({ folderName, folderId: parentId })
          }
        }

        // Cleanup immediately after processing
        await deleteDocument(pdfPath)

        return {
          title: pdf.name!,
          url: pdf.webViewLink ?? "",
          app: Apps.GoogleDrive,
          docId: pdf.id!,
          owner: pdf.owners ? (pdf.owners[0].displayName ?? "") : "",
          photoLink: pdf.owners ? (pdf.owners[0].photoLink ?? "") : "",
          ownerEmail: pdf.owners ? (pdf.owners[0]?.emailAddress ?? "") : "",
          entity: DriveEntity.PDF,
          chunks: chunks.map((v) => v.chunk),
          permissions: pdf.permissions ?? [],
          mimeType: pdf.mimeType ?? "",
          metadata: JSON.stringify({ parents: parentsForMetadata }),
          createdAt: new Date(pdf.createdTime!).getTime(),
          updatedAt: new Date(pdf.modifiedTime!).getTime(),
        }
      } catch (error) {
        Logger.error(
          error,
          `Error getting PDF files: ${error} ${(error as Error).stack}`,
          error,
        )
        if (pdfPath && fs.existsSync(pdfPath)) {
          try {
            await deleteDocument(pdfPath)
          } catch (deleteError) {
            // Logger.warn(`Could not delete PDF file ${pdfPath}: ${deleteError}`)
          }
        }
        // we cannot break the whole pdf pipeline for one error
        return null
      }
    }),
  )

  return (await Promise.all(pdfPromises)).filter((v) => !!v)
}

type Org = { endDate: null | string }
type Lang = { preference: string; languageCode: string }

// insert all the people data into vespa
const insertUsersForWorkspace = async (
  users: admin_directory_v1.Schema$User[],
) => {
  for (const user of users) {
    const currentOrg =
      user.organizations?.find((org: Org) => !org.endDate) ||
      user.organizations?.[0]
    const preferredLanguage =
      user.languages?.find((lang: Lang) => lang.preference === "preferred")
        ?.languageCode ?? user.languages?.[0]?.languageCode
    // TODO: remove ts-ignore and fix correctly
    // @ts-ignore
    await insertUser({
      docId: user.id!,
      name: user.name?.displayName ?? user.name?.fullName ?? "",
      email: user.primaryEmail ?? user.emails?.[0],
      app: Apps.GoogleWorkspace,
      entity: GooglePeopleEntity.AdminDirectory,
      gender: user.gender,
      photoLink: user.thumbnailPhotoUrl ?? "",
      aliases: user.aliases ?? [],
      language: preferredLanguage,
      includeInGlobalAddressList: user.includeInGlobalAddressList ?? false,
      isAdmin: user.isAdmin ?? false,
      isDelegatedAdmin: user.isDelegatedAdmin ?? false,
      suspended: user.suspended ?? false,
      archived: user.archived ?? false,
      orgName: currentOrg?.name,
      orgJobTitle: currentOrg?.title,
      orgDepartment: currentOrg?.department,
      orgLocation: currentOrg?.location,
      orgDescription: currentOrg?.description,
      creationTime:
        (user.creationTime && new Date(user.creationTime).getTime()) || 0,
      lastLoggedIn:
        (user.lastLoginTime && new Date(user.lastLoginTime).getTime()) || 0,
      customerId: user.customerId ?? "",
    })
  }
}

type ContactsResponse = {
  contacts: people_v1.Schema$Person[]
  otherContacts: people_v1.Schema$Person[]
  contactsToken: string
  otherContactsToken: string
}

// get both contacts and other contacts and return the sync tokens
const listAllContacts = async (
  client: GoogleClient,
): Promise<ContactsResponse> => {
  const peopleService = google.people({ version: "v1", auth: client })
  const keys = [
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
  const maxOtherContactsPerPage = 1000
  let pageToken: string = ""
  const contacts: any[] = []
  const otherContacts: any[] = []

  // will be returned in the end
  let newSyncTokenContacts: string = ""
  let newSyncTokenOtherContacts: string = ""

  do {
    const response = await peopleService.people.connections.list({
      resourceName: "people/me",
      pageSize: maxOtherContactsPerPage,
      personFields: keys.join(","),
      pageToken,
      requestSyncToken: true,
    })

    if (response.data.connections) {
      contacts.push(...response.data.connections)
    }

    pageToken = response.data.nextPageToken ?? ""
    newSyncTokenContacts = response.data.nextSyncToken ?? ""
  } while (pageToken)

  // reset page token for other contacts
  pageToken = ""

  do {
    const response = await peopleService.otherContacts.list({
      pageSize: maxOtherContactsPerPage,
      readMask: keys.join(","),
      pageToken,
      requestSyncToken: true,
      sources: ["READ_SOURCE_TYPE_PROFILE", "READ_SOURCE_TYPE_CONTACT"],
    })

    if (response.data.otherContacts) {
      otherContacts.push(...response.data.otherContacts)
    }

    pageToken = response.data.nextPageToken ?? ""
    newSyncTokenOtherContacts = response.data.nextSyncToken ?? ""
  } while (pageToken)

  if (!newSyncTokenContacts || !newSyncTokenOtherContacts) {
    throw new ContactListingError({
      message: "Could not get sync tokens for contact",
      integration: Apps.GoogleDrive,
      entity: GooglePeopleEntity.Contacts,
    })
  }

  return {
    contacts,
    otherContacts,
    contactsToken: newSyncTokenContacts,
    otherContactsToken: newSyncTokenOtherContacts,
  }
}

export const insertContact = async (
  contact: people_v1.Schema$Person,
  entity: GooglePeopleEntity,
  owner: string,
) => {
  const docId = contact.resourceName || ""
  if (!docId) {
    Logger.error(`Id does not exist for ${entity}`)
    return
    // throw new ContactMappingError({
    //   integration: Apps.GoogleDrive,
    //   entity: GooglePeopleEntity.Contacts,
    // })
  }

  const name = contact.names?.[0]?.displayName ?? ""
  const email = contact.emailAddresses?.[0]?.value ?? ""
  if (!email) {
    // Logger.warn(`Email does not exist for ${entity}`)
    return
    // throw new ContactMappingError({
    //   integration: Apps.GoogleDrive,
    //   entity: GooglePeopleEntity.Contacts,
    // })
  }

  const app = Apps.GoogleDrive

  const gender = contact.genders?.[0]?.value ?? ""
  const photoLink = contact.photos?.[0]?.url ?? ""
  const aliases =
    contact.emailAddresses?.slice(1)?.map((e) => e.value ?? "") || []
  const urls = contact.urls?.map((url) => url.value ?? "") || []

  const currentOrg =
    contact.organizations?.find((org) => !org.endDate) ||
    contact.organizations?.[0]

  const orgName = currentOrg?.name ?? ""
  const orgJobTitle = currentOrg?.title ?? ""
  const orgDepartment = currentOrg?.department ?? ""
  const orgLocation = currentOrg?.location ?? ""
  const orgDescription = ""

  const updateTimeStr = contact.metadata?.sources?.[0]?.updateTime
  const creationTime = updateTimeStr
    ? new Date(updateTimeStr).getTime()
    : Date.now()

  const birthdayObj = contact.birthdays?.[0]?.date
  const birthday = birthdayObj
    ? new Date(
        `${birthdayObj.year || "1970"}-${birthdayObj.month || "01"}-${birthdayObj.day || "01"}`,
      ).getTime()
    : undefined

  const occupations = contact.occupations?.map((o) => o.value ?? "") || []
  const userDefined =
    contact.userDefined?.map((u) => `${u.key}: ${u.value}`) || []

  // TODO: remove ts-ignore and fix correctly
  const vespaContact = {
    docId,
    name,
    email,
    app,
    entity,
    gender,
    photoLink,
    aliases,
    urls,
    orgName,
    orgJobTitle,
    orgDepartment,
    orgLocation,
    orgDescription,
    creationTime,
    birthday,
    occupations,
    userDefined,
    owner,
  }
  // @ts-ignore
  await insertUser(vespaContact)
}

const insertContactsToVespa = async (
  contacts: people_v1.Schema$Person[],
  otherContacts: people_v1.Schema$Person[],
  owner: string,
): Promise<void> => {
  try {
    for (const contact of contacts) {
      await insertContact(contact, GooglePeopleEntity.Contacts, owner)
      updateUserStats(owner, StatType.Contacts, 1)
    }
    for (const contact of otherContacts) {
      await insertContact(contact, GooglePeopleEntity.OtherContacts, owner)
      updateUserStats(owner, StatType.Contacts, 1)
    }
  } catch (error) {
    // error is related to vespa and not mapping
    if (error instanceof ErrorInsertingDocument) {
      Logger.error(error, `Could not insert contact: ${(error as Error).stack}`)
      throw error
    } else {
      Logger.error(
        error,
        `Error mapping contact: ${error} ${(error as Error).stack}`,
        error,
      )
      throw new ContactMappingError({
        message: "Error in the catch of mapping google contact",
        integration: Apps.GoogleDrive,
        entity: GooglePeopleEntity.Contacts,
        cause: error as Error,
      })
    }
  }
}

export async function* listFiles(
  client: GoogleClient,
): AsyncIterableIterator<drive_v3.Schema$File[]> {
  const drive = google.drive({ version: "v3", auth: client })
  let nextPageToken = ""
  do {
    const res: GaxiosResponse<drive_v3.Schema$FileList> =
      await drive.files.list({
        // TODO: prevent Google AI studio from getting indexed or add limits
        // that don't cause that issue.
        // anyone who uses Google AI Studio, AI Studio creates a folder
        // and all the pdf's they upload on it is part of this folder
        // these can be quite large and for now we should just avoid it
        // this does not guarantee that this folder is only created by AI studio
        // so that edge case is not handled
        // or just depend on the size limit of pdfs, we don't want to index books as of now
        q: "trashed = false",
        pageSize: 100,
        fields:
          "nextPageToken, files(id, webViewLink, size, parents, createdTime, modifiedTime, name, owners, fileExtension, mimeType, permissions(id, type, emailAddress))",
        pageToken: nextPageToken,
      })

    if (res.data.files) {
      yield res.data.files
    }
    nextPageToken = res.data.nextPageToken ?? ""
  } while (nextPageToken)
}

const sendWebsocketMessage = (message: string, connectorId: string) => {
  const ws: WSContext = wsConnections.get(connectorId)
  if (ws) {
    ws.send(JSON.stringify({ message }))
  }
}

export const googleDocsVespa = async (
  client: GoogleClient,
  docsMetadata: drive_v3.Schema$File[],
  connectorId: string,
): Promise<VespaFileWithDrivePermission[]> => {
  // sendWebsocketMessage(
  //   `Scanning ${docsMetadata.length} Google Docs`,
  //   connectorId,
  // )
  const docs = google.docs({ version: "v1", auth: client })
  const total = docsMetadata.length
  let count = 0
  const limit = pLimit(GoogleDocsConcurrency)
  const docsPromises = docsMetadata.map((doc) =>
    limit(async () => {
      try {
        const docResponse: GaxiosResponse<docs_v1.Schema$Document> =
          await docs.documents.get({
            documentId: doc.id as string,
          })
        if (!docResponse || !docResponse.data) {
          throw new DocsParsingError(
            `Could not get document content for file: ${doc.id}`,
          )
        }
        const documentContent: docs_v1.Schema$Document = docResponse.data

        const rawTextContent = documentContent?.body?.content
          ?.map((e) => extractText(documentContent, e))
          .join("")

        const footnotes = extractFootnotes(documentContent)
        const headerFooter = extractHeadersAndFooters(documentContent)

        const cleanedTextContent = postProcessText(
          rawTextContent + "\n\n" + footnotes + "\n\n" + headerFooter,
        )

        const chunks = chunkDocument(cleanedTextContent)

        const parentsForMetadata = []
        // Shared files cannot have parents
        // There can be some files that user has access to may not have parents as they are shared
        if (doc?.parents) {
          for (const parentId of doc?.parents!) {
            const parentData = await getFile(client, parentId)
            const folderName = parentData.name!
            parentsForMetadata.push({ folderName, folderId: parentId })
          }
        }

        const result: VespaFileWithDrivePermission = {
          title: doc.name!,
          url: doc.webViewLink ?? "",
          app: Apps.GoogleDrive,
          docId: doc.id!,
          owner: doc.owners ? (doc.owners[0].displayName ?? "") : "",
          photoLink: doc.owners ? (doc.owners[0].photoLink ?? "") : "",
          ownerEmail: doc.owners ? (doc.owners[0]?.emailAddress ?? "") : "",
          entity: DriveEntity.Docs,
          chunks: chunks.map((v) => v.chunk),
          permissions: doc.permissions ?? [],
          mimeType: doc.mimeType ?? "",
          metadata: JSON.stringify({ parents: parentsForMetadata }),
          createdAt: new Date(doc.createdTime!).getTime(),
          updatedAt: new Date(doc.modifiedTime!).getTime(),
        }
        count += 1

        // if (count % 5 === 0) {
        //   sendWebsocketMessage(`${count} Google Docs scanned`, connectorId)
        // }
        return result
      } catch (error) {
        const errorMessage = getErrorMessage(error)
        Logger.error(
          error,
          `Error processing Google Doc: ${errorMessage} ${(error as Error).stack}`,
        )
        return null
      }
    }),
  )
  const docsList: (VespaFileWithDrivePermission | null)[] =
    await Promise.all(docsPromises)
  return docsList.filter((doc) => doc !== null)
}

export const driveFilesToDoc = async (
  client: GoogleClient,
  rest: drive_v3.Schema$File[],
): Promise<VespaFileWithDrivePermission[]> => {
  let results: VespaFileWithDrivePermission[] = []
  for (const doc of rest) {
    results.push(await driveFileToIndexed(client, doc))
  }
  return results
}
