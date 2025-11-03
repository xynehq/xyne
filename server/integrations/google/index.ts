import {
  admin_directory_v1,
  Auth,
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
  OperationStatus,
  Subsystem,
  SyncCron,
  WorkerResponseTypes,
  type GoogleClient,
  type GoogleServiceAccount,
  type OAuthCredentials,
  type SaaSJob,
  type SaaSOAuthJob,
} from "@/types"
import PgBoss from "pg-boss"
import { hashPdfFilename } from "@/utils"
import { getConnector, getOAuthConnectorWithCredentials } from "@/db/connector"
import {
  GetDocument,
  ifDocumentsExist,
  insert,
  insertDocument,
  insertUser,
  UpdateEventCancelledInstances,
  insertWithRetry,
} from "@/search/vespa"
import { SaaSQueue } from "@/queue"
import type { WSContext } from "hono/ws"
import { db } from "@/db/client"
import {
  connectors,
  type SelectConnector,
  type SelectOAuthProvider,
} from "@/db/schema"
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
import {
  getAppSyncJobs,
  getAppSyncJobsByEmail,
  insertSyncJob,
  updateSyncJob,
} from "@/db/syncJob"
import { GaxiosError, type GaxiosResponse } from "gaxios"
import { insertSyncHistory } from "@/db/syncHistory"
import { getErrorMessage, retryWithBackoff } from "@/utils"
import {
  createJwtClient,
  DocsParsingError,
  driveFileToIndexed,
  DriveMime,
  getFile,
  sendProgressToServer,
  toPermissionsList,
} from "@/integrations/google/utils"
import { getLogger, getLoggerWithChild } from "@/logger"
import {
  CalendarEntity,
  eventSchema,
  type VespaEvent,
  type VespaFileWithDrivePermission,
  fileSchema,
} from "@xyne/vespa-ts/types"
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
  MAX_GD_SHEET_SIZE,
  MAX_GD_SLIDES_TEXT_LEN,
  PDFProcessingConcurrency,
  ServiceAccountUserConcurrency,
} from "@/integrations/google/config"
import { handleGmailIngestion } from "@/integrations/google/gmail"
import pLimit from "p-limit"
import { GoogleDocsConcurrency } from "./config"
import {
  // getProgress,
  // markUserComplete,
  // oAuthTracker,
  // serviceAccountTracker,
  // setOAuthUser,
  // setTotalUsers,
  StatType,
  Tracker,
} from "@/integrations/tracker"
import { getOAuthProviderByConnectorId } from "@/db/oauthProvider"
import config from "@/config"
import { getConnectorByExternalId } from "@/db/connector"
import {
  blockedFilesTotal,
  contentFileSize,
  extractionDuration,
  fileExtractionErrorsTotal,
  ingestionErrorsTotal,
  totalDriveFilesToBeIngested,
  totalDurationForFileExtraction,
  totalExtractedFiles,
  totalIngestedFiles,
} from "@/metrics/google/google-drive-file-metrics"
import { v4 as uuidv4 } from "uuid"

let isScriptRunning = false

const htmlToText = require("html-to-text")
const Logger = getLogger(Subsystem.Integrations).child({ module: "google" })

// export const loggerWithChild = (email: string) => {
//   return Logger.child({ email: email })
// }

export const loggerWithChild = getLoggerWithChild(Subsystem.Integrations, {
  module: "google",
})

const gmailWorker = new Worker(new URL("gmail-worker.ts", import.meta.url).href)
Logger.info("Gmail worker initialized")

gmailWorker.onmessage
// Map to store Tracker instances for active jobs, keyed by a unique jobId.
const activeJobTrackers = new Map<string, Tracker>()

// Pending requests for operations awaiting a direct response (e.g., historyId) from the worker
const pendingRequests = new Map<
  string,
  {
    resolve: (value: string) => void
    reject: (reason?: any) => void
    userEmail: string
    jobId?: string
  }
>()

// Initialize global handlers for the Gmail worker
const initializeGmailWorker = () => {
  gmailWorker.onmessage = (event: MessageEvent) => {
    const result = event.data
    if (!result || !result.type) {
      Logger.warn(
        "Received an undefined or typeless message from Gmail worker",
        { result },
      )
      return
    }

    const jobIdFromResult = result.jobId // Stats, HistoryId, Error messages from worker now contain jobId

    if (
      result.type === WorkerResponseTypes.HistoryId ||
      result.type === WorkerResponseTypes.Error
    ) {
      const msgId = result.msgId
      const promiseHandlers = pendingRequests.get(msgId)
      if (promiseHandlers) {
        pendingRequests.delete(msgId)
        if (result.type === WorkerResponseTypes.HistoryId) {
          promiseHandlers.resolve(result.historyId)
        } else {
          // MessageTypes.Error
          promiseHandlers.reject(new Error(result.errorMessage))
        }
      } else {
        Logger.warn(
          `No pending request found for msgId: ${msgId} (jobId: ${jobIdFromResult})`,
        )
      }
    } else if (result.type === WorkerResponseTypes.Stats) {
      loggerWithChild({ email: result.userEmail }).info(
        `Main Thread: Received stats for ${result.userEmail}, type: ${result.statType}, count: ${result.count}, jobId: ${jobIdFromResult}`,
      ) // ADD THIS LOG
      if (!jobIdFromResult) {
        Logger.warn(
          "Received Gmail stats message without a jobId. Discarding.",
          { result },
        )
        return
      }
      const trackerInstance = activeJobTrackers.get(jobIdFromResult)
      if (trackerInstance) {
        trackerInstance.updateUserStats(
          result.userEmail,
          result.statType,
          result.count,
        )
      } else {
        loggerWithChild({ email: result.userEmail }).warn(
          `Main Thread: No active tracker found for jobId: ${jobIdFromResult} when trying to update stats. (User: ${result.userEmail}, StatType: ${result.statType}, Count: ${result.count})`,
        )
      }
    } else if (result.type === WorkerResponseTypes.ProgressUpdate) {
      if (isScriptRunning) {
        loggerWithChild({ email: result.email }).info(
          `Sending Progress for ingested mails`,
        )
        sendProgressToServer({
          userEmail: result.email,
          messageCount: result.stats.messageCount,
          attachmentCount: result.stats.attachmentCount,
          failedMessages: result.stats.failedMessageCount,
          failedAttachments: result.stats.failedAttottachmentCount,
          totalMailsToBeIngested: 0,
          totalMailsSkipped: 0,
          insertedEventCount: 0,
          insertedContactsCount: 0,
          insertedpdfCount: 0,
          insertedDocCount: 0,
          insertedSheetCount: 0,
          insertedSlideCount: 0,
          insertedDriveFileCount: 0,
          totalDriveflesToBeIngested: 0,
          totalBlockedPdfs: 0,
        })
      } else {
        Logger.info(
          `Main Thread: Received Progress Update for ${result.email}, type: ${result.type} jobId: ${jobIdFromResult}`,
        )
        totalIngestedMails.inc(
          {
            email: result.email,
            account_type: AuthType.ServiceAccount,
            status: OperationStatus.Success,
          },
          result.stats.messageCount,
        )
        totalAttachmentIngested.inc(
          {
            email: result.email,
            account_type: AuthType.ServiceAccount,
            status: OperationStatus.Success,
          },
          result.stats.attachmentCount,
        )
        ingestionMailErrorsTotal.inc(
          {
            email: result.email,
            account_type: AuthType.ServiceAccount,
            status: OperationStatus.Failure,
          },
          result.stats.failedMessageCount,
        )
        totalAttachmentError.inc(
          {
            email: result.email,
            account_type: AuthType.ServiceAccount,
            status: OperationStatus.Failure,
          },
          result.stats.failedAttachmentCount,
        )
      }
    }
  }

  gmailWorker.onerror = (error: ErrorEvent) => {
    Logger.error("Gmail worker error:", error)
    // Reject all pending requests. If they have a jobId, include it in the log.
    for (const [msgId, promiseHandlers] of pendingRequests.entries()) {
      pendingRequests.delete(msgId)
      let errorMessage = `Gmail worker error: ${error.message}`
      if (promiseHandlers.userEmail) {
        errorMessage += ` (User: ${promiseHandlers.userEmail}`
        if (promiseHandlers.jobId) {
          // Check if jobId was stored
          errorMessage += `, JobID: ${promiseHandlers.jobId}`
        }
        errorMessage += `)`
      }
      promiseHandlers.reject(new Error(errorMessage))
    }
  }
  Logger.info("Global Gmail worker handlers setup complete with jobId routing")
}

initializeGmailWorker()

export type GaxiosPromise<T = any> = Promise<GaxiosResponse<T>>

export const listUsersByEmails = async (
  admin: admin_directory_v1.Admin,
  emails: string[],
): Promise<admin_directory_v1.Schema$User[]> => {
  const users: admin_directory_v1.Schema$User[] = []

  try {
    for (const email of emails) {
      try {
        const res = await retryWithBackoff(
          () =>
            admin.users.get({
              userKey: email,
            }),
          `Fetching user ${email}`,
          Apps.GoogleDrive,
        )
        users.push(res.data)
      } catch (error) {
        loggerWithChild({ email: email }).warn(
          `User ${email} not found: ${error}`,
        )
        // Skip if user doesn't exist
      }
    }
    return users
  } catch (error) {
    Logger.error(
      error,
      `Error fetching users: ${error} ${(error as Error).stack}`,
    )
    throw new UserListingError({
      cause: error as Error,
      integration: Apps.GoogleWorkspace,
      entity: "user",
    })
  }
}

export const listUsers = async (
  admin: admin_directory_v1.Admin,
  domain: string,
): Promise<admin_directory_v1.Schema$User[]> => {
  let users: admin_directory_v1.Schema$User[] = []
  let nextPageToken = null
  try {
    do {
      const res: GaxiosResponse<admin_directory_v1.Schema$Users> =
        await retryWithBackoff(
          () =>
            admin.users.list({
              domain: domain,
              maxResults: 500,
              orderBy: "email",
              ...(nextPageToken! ? { pageToken: nextPageToken } : {}),
            }),
          `Fetching all users`,
          Apps.GoogleDrive,
        )
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
    const nameToAdd = attendee.displayName || attendee.email
    if (nameToAdd) {
      attendeesNames.push(nameToAdd)
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
  tracker: Tracker,
  startDate?: string,
  endDate?: string,
) => {
  let nextPageToken = ""
  let newSyncTokenCalendarEvents: string = ""
  let events: calendar_v3.Schema$Event[] = []
  const calendar = google.calendar({ version: "v3", auth: client })

  let timeMinForQuery: Date
  let timeMaxForQuery: Date

  if (startDate) {
    timeMinForQuery = new Date(startDate)
  } else {
    // Default start date: 1 year ago from today
    timeMinForQuery = new Date()
    timeMinForQuery.setFullYear(timeMinForQuery.getFullYear() - 1)
  }

  if (endDate) {
    timeMaxForQuery = new Date(endDate)
  } else {
    // Default end date: 1 year from today
    timeMaxForQuery = new Date()
    timeMaxForQuery.setFullYear(timeMaxForQuery.getFullYear() + 1)
  }

  try {
    do {
      const res = await retryWithBackoff(
        () =>
          calendar.events.list({
            calendarId: "primary",
            timeMin: timeMinForQuery.toISOString(),
            timeMax: timeMaxForQuery.toISOString(),
            maxResults: maxCalendarEventResults,
            pageToken: nextPageToken,
            fields: eventFields,
          }),
        `Fetching calendar events from ${timeMinForQuery.toISOString()} to ${timeMaxForQuery.toISOString()}`,
        Apps.GoogleCalendar,
        0,
        client,
      )
      if (res.data.items) {
        events = events.concat(res.data.items)
      }
      nextPageToken = res.data.nextPageToken ?? ""
      newSyncTokenCalendarEvents = res.data.nextSyncToken ?? ""
    } while (nextPageToken)
  } catch (error: any) {
    // Check if the error is specifically the "notACalendarUser" error
    if (error?.response?.status === 403) {
      // Log the issue and return empty results
      loggerWithChild({ email: userEmail! }).warn(
        `User ${userEmail} is not signed up for Google Calendar. Returning empty event set.`,
      )
      return { events: [], calendarEventsToken: "" }
    }
    // If it's a different error, rethrow it to be handled upstream
    throw error
  }

  if (events.length === 0) {
    return { events: [], calendarEventsToken: newSyncTokenCalendarEvents }
  }

  const confirmedEvents = events.filter((e) => e.status === "confirmed")
  const cancelledEvents = events.filter((e) => e.status === "cancelled")

  const totalDurationForEventIngestion = ingestionDuration.startTimer({
    file_type: CalendarEntity.Event,
    mime_type: "google_calendar_events",
    email: userEmail,
  })
  // Insert confirmed events
  for (const event of confirmedEvents) {
    try {
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
        url: event.htmlLink ?? "",
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

      await insertWithRetry(eventToBeIngested, eventSchema)
      tracker.updateUserStats(userEmail, StatType.Events, 1)
    } catch (error) {
      Logger.error(`Error inserting the Event:${event.id}`)
    }
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
      loggerWithChild({ email: userEmail! }).error(
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

  totalDurationForEventIngestion()
  metadataFiles.inc(
    {
      file_type: CalendarEntity.Event,
      mime_type: "google_calendar_events",
      status: "SUCCESS",
      email: userEmail,
    },
    events.length,
  )
  if (isScriptRunning) {
    loggerWithChild({ email: userEmail }).info(
      `Sending Progress for events ingested`,
    )
    sendProgressToServer({
      userEmail: userEmail,
      messageCount: 0,
      attachmentCount: 0,
      failedMessages: 0,
      failedAttachments: 0,
      totalMailsToBeIngested: 0,
      totalMailsSkipped: 0,
      insertedEventCount: events.length,
      insertedContactsCount: 0,
      insertedpdfCount: 0,
      insertedDocCount: 0,
      insertedSheetCount: 0,
      insertedSlideCount: 0,
      insertedDriveFileCount: 0,
      totalDriveflesToBeIngested: 0,
      totalBlockedPdfs: 0,
    })
  }
  return { events, calendarEventsToken: newSyncTokenCalendarEvents }
}

export const handleGoogleOAuthIngestion = async (data: SaaSOAuthJob) => {
  // Logger.info("handleGoogleOauthIngestion", job.data)
  // const data: SaaSOAuthJob = job.data as SaaSOAuthJob
  const logger = loggerWithChild({ email: data.email })
  try {
    // Update status to Connecting when ingestion starts
    try {
      await db
        .update(connectors)
        .set({
          status: ConnectorStatus.Connecting,
        })
        .where(eq(connectors.id, data.connectorId))
    } catch (error) {
      logger.error(error, `Failed to update connector status to Connecting`)
      throw error
    }
    // we will first fetch the change token
    // and poll the changes in a new Cron Job
    const connector: SelectConnector = await getOAuthConnectorWithCredentials(
      db,
      data.connectorId,
    )
    const userEmail = data.email
    const oauthTokens = (connector.oauthCredentials as OAuthCredentials).data

    const providers: SelectOAuthProvider[] =
      await getOAuthProviderByConnectorId(db, data.connectorId)

    const [googleProvider] = providers

    const oauth2Client = new google.auth.OAuth2({
      clientId: googleProvider.clientId!,
      clientSecret: googleProvider.clientSecret as string,
      redirectUri: `${config.host}/oauth/callback`,
    })

    const tracker = new Tracker(Apps.GoogleDrive, AuthType.OAuth)
    tracker.setOAuthUser(userEmail)

    const interval = setInterval(() => {
      sendWebsocketMessage(
        JSON.stringify({
          progress: tracker.getProgress(),
          userStats: tracker.getOAuthProgress().userStats,
          startTime: tracker.getStartTime(),
        }),
        connector.externalId,
      )
    }, 4000)

    // we have guarantee that when we started this job access Token at least
    // hand one hour, we should increase this time
    oauth2Client.setCredentials({
      access_token: oauthTokens.access_token,
      refresh_token: oauthTokens.refresh_token,
    })
    const driveClient = google.drive({ version: "v3", auth: oauth2Client })
    const [totalFiles, { messagesTotal, messagesExcludingPromotions }] =
      await Promise.all([
        countDriveFiles(oauth2Client, userEmail),
        getGmailCounts(oauth2Client, userEmail),
      ])

    totalGmailToBeIngestedCount.inc(
      {
        email: userEmail,
        account_type: AuthType.OAuth,
        status: OperationStatus.Success,
      },
      messagesExcludingPromotions,
    )
    totalDriveFilesToBeIngested.inc(
      {
        email: userEmail,
        status: OperationStatus.Success,
        file_type: DriveEntity.Misc,
      },
      totalFiles,
    )
    totalSkippedMails.inc(
      {
        email: userEmail,
        status: OperationStatus.Success,
        account_type: AuthType.OAuth,
      },
      messagesTotal - messagesExcludingPromotions,
    )

    tracker.updateTotal(userEmail, {
      totalDrive: totalFiles,
      totalMail: messagesExcludingPromotions,
    })
    const { contacts, otherContacts, contactsToken, otherContactsToken } =
      await listAllContacts(oauth2Client)
    await insertContactsToVespa(contacts, otherContacts, userEmail, tracker) // metadata
    // get change token for any changes during drive integration
    const { startPageToken }: drive_v3.Schema$StartPageToken = (
      await driveClient.changes.getStartPageToken()
    ).data
    if (!startPageToken) {
      throw new Error("Could not get start page token")
    }

    const [_, historyId, { calendarEventsToken }] = await Promise.all([
      insertFilesForUser(oauth2Client, userEmail, connector, tracker), // detail
      handleGmailIngestion(oauth2Client, userEmail, tracker), // detail
      insertCalendarEvents(oauth2Client, userEmail, tracker), // metadata
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
      // await boss.complete(SaaSQueue, job.id)
      logger.info("job completed")
      // wsConnections.get(connector.externalId)?.close(1000, "Job finished")
      closeWs(connector.externalId)
    })
  } catch (error) {
    logger.error(
      error,
      `could not finish job successfully: ${(error as Error).message} ${(error as Error).stack}`,
      error,
    )
    // await db.transaction(async (trx) => {
    await db
      .update(connectors)
      .set({
        status: ConnectorStatus.Failed,
      })
      .where(eq(connectors.id, data.connectorId))
    // await boss.fail(job.name, job.id)
    // })
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
import { closeWs, sendWebsocketMessage } from "@/integrations/metricStream"
import {
  ingestionDuration,
  metadataFiles,
} from "@/metrics/google/metadata_metrics"
import type { Logger } from "pino"
import {
  totalGmailToBeIngestedCount,
  totalSkippedMails,
} from "@/metrics/google/gmail-metrics"
import {
  ingestionMailErrorsTotal,
  totalAttachmentError,
  totalAttachmentIngested,
  totalIngestedMails,
} from "@/metrics/google/gmail-metrics"
import { chunkSheetWithHeaders } from "@/sheetChunk"
import { checkFileSize } from "../dataSource"

const stats = z.object({
  type: z.literal(WorkerResponseTypes.Stats),
  userEmail: z.string(),
  count: z.number(),
  statType: z.nativeEnum(StatType),
})

const historyId = z.object({
  type: z.literal(WorkerResponseTypes.HistoryId),
  msgId: z.string(),
  historyId: z.string(),
  userEmail: z.string(),
})
const messageTypes = z.discriminatedUnion("type", [stats, historyId])

type ResponseType = z.infer<typeof messageTypes>

// Define a function to handle ingestion
const handleGmailIngestionForServiceAccount = async (
  userEmail: string,
  serviceAccountKey: GoogleServiceAccount,
  jobId: string, // Added jobId
  startDate?: string,
  endDate?: string,
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const msgId = `${userEmail}_${jobId}_${uuidv4()}` // Make msgId more unique with jobId
    const timeout = setTimeout(
      () => {
        loggerWithChild({ email: userEmail! }).error(
          `Gmail ingestion timeout for user: ${userEmail} (jobId: ${jobId}, msgId: ${msgId})`,
        )
        const promiseHandlers = pendingRequests.get(msgId)
        if (promiseHandlers) {
          pendingRequests.delete(msgId)
          reject(
            new Error(
              `Gmail ingestion timeout for user: ${userEmail} (jobId: ${jobId})`,
            ),
          )
        }
      },
      60 * 60 * 60 * 1000,
    )
    // 60hrs timeout
    pendingRequests.set(msgId, {
      userEmail,
      jobId, // Store jobId with the pending request
      resolve: (historyId: string) => {
        clearTimeout(timeout)
        resolve(historyId)
      },
      reject: (error: Error) => {
        clearTimeout(timeout)
        reject(error)
      },
    })
    gmailWorker.postMessage({
      type: MessageTypes.JwtParams,
      msgId,
      jobId, // Pass jobId to the worker
      userEmail,
      serviceAccountKey,
      startDate,
      endDate,
    })
    loggerWithChild({ email: userEmail! }).info(
      `Sent message to worker for ${userEmail} (jobId: ${jobId}, msgId: ${msgId})`,
    )
  })
}

// we make 2 sync jobs
// one for drive and one for google workspace
export const handleGoogleServiceAccountIngestion = async (data: SaaSJob) => {
  const jobId = uuidv4()
  loggerWithChild({ email: data.email! }).info(
    `handleGoogleServiceAccountIngestion starting with jobId: ${jobId}`,
    data,
  )
  const tracker = new Tracker(Apps.GoogleWorkspace, AuthType.ServiceAccount)
  activeJobTrackers.set(jobId, tracker)

  let connector: SelectConnector | null = null // Defined here for access in finally block if needed

  try {
    connector = await getConnector(db, data.connectorId) // Assign to the outer scope connector
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

    let usersToQuery: admin_directory_v1.Schema$User[] = []
    const whiteListedEmails = data.whiteListedEmails || []
    if (whiteListedEmails.length) {
      usersToQuery = await listUsersByEmails(admin, whiteListedEmails)
    } else {
      usersToQuery = await listUsers(admin, workspace.domain)
    }

    // Deduplicate users based on the extracted valid email before further processing
    const uniqueUsersMap = new Map<string, admin_directory_v1.Schema$User>()
    for (const user of usersToQuery) {
      const email = getValidUserEmailFromGoogleUser(user)
      if (email && !uniqueUsersMap.has(email)) {
        uniqueUsersMap.set(email, user)
      }
    }
    const usersToProcess = Array.from(uniqueUsersMap.values())

    if (usersToProcess.length !== usersToQuery.length) {
      loggerWithChild({ email: data.email! }).warn(
        `Removed ${usersToQuery.length - usersToProcess.length} duplicate or unidentifiable (no email) users from initial query (jobId: ${jobId})`,
      )
    }

    if (usersToProcess.length === 0) {
      loggerWithChild({ email: data.email! }).warn(
        `No users with valid emails to process for connectorId: ${data.connectorId} (jobId: ${jobId}). Aborting.`,
      )
      // Potentially update connector status to Failed or Connected if no users is an acceptable state.
      // For now, just logging and exiting the main processing block.
      if (connector.externalId) closeWs(connector.externalId)
      return
    }

    loggerWithChild({ email: data.email! }).info(
      `Ingesting for ${usersToProcess.length} users (jobId: ${jobId})`,
    )
    tracker.setTotalUsers(usersToProcess.length)
    const ingestionMetadataList: IngestionMetadata[] = []

    const limit = pLimit(ServiceAccountUserConcurrency)

    const interval = setInterval(() => {
      if (connector?.externalId) {
        sendWebsocketMessage(
          JSON.stringify({
            progress: tracker.getProgress(),
            userStats: tracker.getServiceAccountProgress().userStats,
            startTime: tracker.getStartTime(),
          }),
          connector.externalId,
        )
      }
    }, 4000)

    const userProcessingPromises = usersToProcess.map((googleUser) =>
      limit(async () => {
        const userEmail = getValidUserEmailFromGoogleUser(googleUser)

        if (!userEmail) {
          loggerWithChild({ email: userEmail! }).error(
            `handleGoogleServiceAccountIngestion: Could not determine a valid email for Google user ID: ${googleUser.id || "N/A"} (jobId: ${jobId}). Skipping.`,
          )
          tracker.markUserComplete(
            googleUser.id || `UNKNOWN_ID_${Math.random()}`,
          )
          return null
        }

        loggerWithChild({ email: userEmail! }).info(
          `started for ${userEmail} (jobId: ${jobId})`,
        )
        const userJwtClient = createJwtClient(serviceAccountKey, userEmail) // Renamed
        const userDriveClient = google.drive({
          version: "v3",
          auth: userJwtClient,
        }) // Renamed for clarity

        // Use more concise names for counts
        const [driveFileCount, gmailCounts] = await Promise.all([
          countDriveFiles(userJwtClient, userEmail),
          getGmailCounts(userJwtClient, userEmail),
        ])

        const mailCountExcludingPromotions =
          gmailCounts.messagesExcludingPromotions

        totalGmailToBeIngestedCount.inc(
          {
            email: userEmail,
            account_type: AuthType.ServiceAccount,
            status: OperationStatus.Success,
          },
          gmailCounts.messagesTotal,
        )
        totalDriveFilesToBeIngested.inc(
          {
            email: userEmail,
            status: OperationStatus.Success,
            file_type: DriveEntity.Misc,
          },
          driveFileCount,
        )
        totalSkippedMails.inc(
          {
            email: userEmail,
            account_type: AuthType.ServiceAccount,
            status: OperationStatus.Cancelled,
          },
          gmailCounts.messagesTotal - gmailCounts.messagesExcludingPromotions,
        )
        tracker.updateTotal(userEmail, {
          totalMail: mailCountExcludingPromotions,
          totalDrive: driveFileCount,
        })
        loggerWithChild({ email: userEmail! }).info(
          `Total files: ${driveFileCount}, Total mail: ${mailCountExcludingPromotions} for ${userEmail} (jobId: ${jobId})`,
        )

        const { contacts, otherContacts, contactsToken, otherContactsToken } =
          await listAllContacts(userJwtClient)
        await insertContactsToVespa(contacts, otherContacts, userEmail, tracker)

        const { startPageToken } = (
          await userDriveClient.changes.getStartPageToken()
        ).data
        if (!startPageToken) {
          throw new Error(
            `Could not get start page token for user ${userEmail} (jobId: ${jobId})`,
          )
        }

        // Pass userJwtClient where appropriate if those functions use it directly, or serviceAccountKey
        const [_, historyIdResult, calendarResult] = await Promise.all([
          insertFilesForUser(userJwtClient, userEmail, connector!, tracker), // Assuming connector is valid here
          handleGmailIngestionForServiceAccount(
            userEmail,
            serviceAccountKey,
            jobId,
          ),
          insertCalendarEvents(userJwtClient, userEmail, tracker),
        ])

        loggerWithChild({ email: userEmail! }).info(
          `Ingestion completed for ${userEmail} (jobId: ${jobId})`,
        )
        tracker.markUserComplete(userEmail)
        return {
          email: userEmail,
          driveToken: startPageToken,
          contactsToken,
          otherContactsToken,
          historyId: historyIdResult, // Use the result from the promise
          calendarEventsToken: calendarResult.calendarEventsToken, // Use the result
        } as IngestionMetadata
      }),
    )

    const results = (await Promise.all(
      userProcessingPromises,
    )) as (IngestionMetadata | null)[]
    const successfulResults = results.filter(
      (meta) => meta !== null,
    ) as IngestionMetadata[]
    ingestionMetadataList.push(...successfulResults)

    // Filter users for workspace insert based on successful processing
    const usersForWorkspaceInsert = usersToProcess.filter((u) =>
      successfulResults.some(
        (sr) => sr.email === getValidUserEmailFromGoogleUser(u),
      ),
    )
    await insertUsersForWorkspace(usersForWorkspaceInsert)

    setTimeout(() => {
      clearInterval(interval)
    }, 8000)

    await db.transaction(async (trx) => {
      for (const meta of ingestionMetadataList) {
        // Iterate over successful results
        // drive and contacts per user
        await insertSyncJob(trx, {
          workspaceId: connector!.workspaceId, // Assuming connector is valid
          workspaceExternalId: connector!.workspaceExternalId,
          app: Apps.GoogleDrive,
          connectorId: connector!.id,
          authType: AuthType.ServiceAccount,
          config: {
            driveToken: meta.driveToken,
            contactsToken: meta.contactsToken,
            type: "googleDriveChangeToken",
            otherContactsToken: meta.otherContactsToken,
            lastSyncedAt: new Date().toISOString(),
          },
          email: meta.email,
          type: SyncCron.ChangeToken,
          status: SyncJobStatus.NotStarted,
        })
        // gmail per user
        await insertSyncJob(trx, {
          workspaceId: connector!.workspaceId,
          workspaceExternalId: connector!.workspaceExternalId,
          app: Apps.Gmail,
          connectorId: connector!.id,
          authType: AuthType.ServiceAccount,
          config: {
            historyId: meta.historyId,
            type: "gmailChangeToken",
            lastSyncedAt: new Date().toISOString(),
          },
          email: meta.email,
          type: SyncCron.ChangeToken,
          status: SyncJobStatus.NotStarted,
        })
        // For inserting Google CalendarEvent Change Job
        await insertSyncJob(trx, {
          workspaceId: connector!.workspaceId,
          workspaceExternalId: connector!.workspaceExternalId,
          app: Apps.GoogleCalendar,
          connectorId: connector!.id,
          authType: AuthType.ServiceAccount,
          config: {
            calendarEventsToken: meta.calendarEventsToken,
            type: "calendarEventsChangeToken",
            lastSyncedAt: new Date().toISOString(),
          },
          email: meta.email,
          type: SyncCron.ChangeToken,
          status: SyncJobStatus.NotStarted,
        })
      }
      // workspace sync for the Org
      await insertSyncJob(trx, {
        workspaceId: connector!.workspaceId,
        workspaceExternalId: connector!.workspaceExternalId,
        app: Apps.GoogleWorkspace,
        connectorId: connector!.id,
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
        .where(eq(connectors.id, connector!.id))
      loggerWithChild({ email: data.email! }).info(
        `status updated (jobId: ${jobId})`,
      )
      loggerWithChild({ email: data.email! }).info(
        `job completed (jobId: ${jobId})`,
      )
      if (connector!.externalId) closeWs(connector!.externalId)
    })
  } catch (error) {
    loggerWithChild({ email: data.email! }).error(
      error,
      `handleGoogleServiceAccountIngestion (jobId: ${jobId}) failed: ${(error as Error).message}`,
    )
    // Ensure connector is defined for error handling if possible
    if (connector && connector.externalId) {
      // Check if connector was successfully fetched
      closeWs(connector.externalId)
    }
    await db
      .update(connectors)
      .set({ status: ConnectorStatus.Failed })
      .where(eq(connectors.id, data.connectorId))
    throw new CouldNotFinishJobSuccessfully({
      message: `Could not finish Service Account ingestion (jobId: ${jobId})`,
      integration: Apps.GoogleWorkspace,
      entity: "files and users",
      cause: error as Error,
    })
  } finally {
    loggerWithChild({ email: data.email! }).info(
      `Main Thread: About to delete tracker for jobId: ${jobId} in handleGoogleServiceAccountIngestion`,
    ) // ADD THIS LOG
    activeJobTrackers.delete(jobId)
    loggerWithChild({ email: data.email! }).info(
      `handleGoogleServiceAccountIngestion (jobId: ${jobId}) finished. Tracker removed.`,
    )
  }
}

export const deleteDocument = async (filePath: string) => {
  try {
    await unlink(filePath)
    Logger.debug(`File at ${filePath} deleted successfully`)
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
  email: string,
) => {
  const slides = google.slides({ version: "v1", auth: client })
  try {
    const presentationData = await retryWithBackoff(
      () =>
        slides.presentations.get({
          presentationId: presentation.id!,
        }),
      `Fetching presentation with id ${presentation.id}`,
      Apps.GoogleDrive,
      0,
      client,
    )
    const slidesData = presentationData?.data?.slides!
    let chunks: string[] = []
    let totalTextLen = 0

    slidesData?.forEach((slide) => {
      let slideText = ""
      slide?.pageElements!?.forEach((element) => {
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
      loggerWithChild({ email: email }).error(
        `Text Length exceeded for ${presentation.name}, indexing with empty content`,
      )
      chunks = []
    }

    const parentsForMetadata = []
    let parentId = null
    if (presentation?.parents) {
      if (presentation.parents.length > 0) parentId = presentation.parents[0]
      for (const pId of presentation.parents!) {
        const parentData = await getFile(client, pId)
        const folderName = parentData?.name!
        parentsForMetadata.push({ folderName, folderId: pId })
      }
    }

    const presentationToBeIngested = {
      title: presentation.name!,
      url: presentation.webViewLink ?? "",
      app: Apps.GoogleDrive,
      docId: presentation.id!,
      parentId: parentId,
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
  } catch (error) {
    loggerWithChild({ email: email }).error(
      error,
      `Error in getting presentation data with id ${presentation?.id}`,
    )
    return null
  }
}

const googleSlidesVespa = async (
  client: GoogleClient,
  presentationMetadata: drive_v3.Schema$File[],
  connectorId: string,
  userEmail?: string,
): Promise<VespaFileWithDrivePermission[]> => {
  // sendWebsocketMessage(
  //   `Scanning ${presentationMetadata.length} Google Slides`,
  //   connectorId,
  // )
  const presentationsList: VespaFileWithDrivePermission[] = []

  const total = presentationMetadata.length
  let count = 0
  for (const presentation of presentationMetadata) {
    const endGoogleSlideExtractionDuration = extractionDuration.startTimer({
      mime_type:
        presentation.mimeType ?? "application/vnd.google-apps.presentation",
      email: userEmail,
      file_type: DriveEntity.Slides,
    })
    try {
      const presentationToBeIngested = await getPresentationToBeIngested(
        presentation,
        client,
        userEmail!,
      )
      if (presentationToBeIngested) {
        presentationsList.push(presentationToBeIngested)
      }
      count += 1
      totalExtractedFiles.inc(
        {
          mime_type:
            presentation.mimeType ?? "application/vnd.google-apps.presentation",
          status: "SUCCESS",
          file_type: DriveEntity.Slides,
        },
        1,
      )
      // if (count % 5 === 0) {
      //   sendWebsocketMessage(`${count} Google Slides scanned`, connectorId)
      // }
      endGoogleSlideExtractionDuration()
      const sizeBytes = presentation.size ? parseInt(presentation.size, 10) : 0

      contentFileSize.observe(
        {
          mime_type:
            presentation.mimeType ?? "application/vnd.google-apps.presentation",
          email: userEmail ?? "",
          file_type: DriveEntity.Slides,
        },
        isNaN(sizeBytes) ? 0 : sizeBytes,
      )
    } catch (error) {
      loggerWithChild({ email: userEmail! }).error(
        error,
        `Error getting slides: ${error} ${(error as Error).stack}`,
        error,
      )
      fileExtractionErrorsTotal.inc({
        mime_type:
          presentation.mimeType ?? "application/vnd.google-apps.presentation",
        error_type: "PRESENTATION_EXTRACTION_FAILED_ERROR",
        file_type: DriveEntity.Slides,
        email: userEmail,
      })
      continue
    }
  }
  return presentationsList
}

const filterUnchanged = (
  existenceMap: Record<string, { exists: boolean; updatedAt: number | null }>,
  files: drive_v3.Schema$File[],
) =>
  files.filter((file) => {
    const fileId = file.id!
    const driveModifiedTime = new Date(file.modifiedTime!).getTime()
    const vespaInfo = existenceMap[fileId]

    if (vespaInfo.exists && vespaInfo.updatedAt !== null) {
      return driveModifiedTime > vespaInfo.updatedAt // Process if modified
    }
    return true // Process if not in Vespa or no timestamp
  })

const insertFilesForUser = async (
  googleClient: GoogleClient,
  userEmail: string,
  connector: SelectConnector,
  tracker: Tracker,
  startDate?: string,
  endDate?: string,
) => {
  try {
    let processedFiles = 0

    const iterator = listFiles(googleClient, startDate, endDate)
    const startTimestamp = startDate ? new Date(startDate).getTime() : undefined
    const endTimestamp = endDate ? new Date(endDate).getTime() : undefined

    for await (let pageFiles of iterator) {
      loggerWithChild({ email: userEmail! }).info(
        `Processing page of ${pageFiles.length} files for user ${userEmail}`,
      )
      // Check existence and timestamps for all files in this page right away
      const fileIds = pageFiles.map((file) => file.id!)
      let initialCount = pageFiles.length
      try {
        const existenceMap = await ifDocumentsExist(fileIds)

        pageFiles = filterUnchanged(existenceMap, pageFiles)

        const skippedFilesCount = initialCount - pageFiles.length
        if (skippedFilesCount > 0) {
          processedFiles += skippedFilesCount
          tracker.updateUserStats(userEmail, StatType.Drive, skippedFilesCount)
          loggerWithChild({ email: userEmail! }).info(
            `Skipped ${skippedFilesCount} unchanged Drive files`,
          )
        }
      } catch (error) {
        Logger.error(`Could not check the file existance:Insering all files`)
      }
      const googleDocsMetadata = pageFiles.filter(
        (v: drive_v3.Schema$File) => v.mimeType === DriveMime.Docs,
      )
      let googlePDFsMetadata = pageFiles.filter(
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

      // Start timer for PDF file extraction duration
      const pdfFileExtractionDuration =
        totalDurationForFileExtraction.startTimer({
          file_type: DriveEntity.PDF,
          mime_type: "google_pdf",
          email: userEmail,
        })
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

      // End timer for PDF file extraction duration
      pdfFileExtractionDuration()

      // Metrics for ingestion duration of pdfs in google drive
      const totalTimeToIngestPDF = ingestionDuration.startTimer({
        file_type: DriveEntity.PDF,
        mime_type: "google_pdf",
        email: userEmail,
      })
      let driveFilesInserted = 0
      let pdfsInserted = 0
      for (const doc of pdfs) {
        try {
          processedFiles += 1
          await insertWithRetry(doc, fileSchema)
          totalIngestedFiles.inc({
            mime_type: doc.mimeType ?? DriveMime.PDF,
            status: OperationStatus.Success,
            email: userEmail,
            file_type: DriveEntity.PDF,
          })
          tracker.updateUserStats(userEmail, StatType.Drive, 1)
          driveFilesInserted++
          if (isScriptRunning) {
            loggerWithChild({ email: userEmail }).info(
              `Sending Progress for Ingetsed pdfs`,
            )
            sendProgressToServer({
              userEmail: userEmail,
              messageCount: 0,
              attachmentCount: 0,
              failedMessages: 0,
              failedAttachments: 0,
              totalMailsToBeIngested: 0,
              totalMailsSkipped: 0,
              insertedEventCount: 0,
              insertedContactsCount: 0,
              insertedpdfCount: 1,
              insertedDocCount: 0,
              insertedSheetCount: 0,
              insertedSlideCount: 0,
              insertedDriveFileCount: 0,
              totalDriveflesToBeIngested: 0,
              totalBlockedPdfs: 0,
            })
          }
          loggerWithChild({ email: userEmail! }).info(
            `Inserted ${driveFilesInserted} PDFs`,
          )
        } catch (error) {
          ingestionErrorsTotal.inc(
            {
              file_type: DriveEntity.PDF,
              mime_type: doc.mimeType ?? DriveMime.PDF,
              email: doc.ownerEmail ?? userEmail,
              error_type: `ERROR_INGESTING_${DriveEntity.PDF}`,
              status: OperationStatus.Failure,
            },
            1,
          )
        }
      }
      // end of duration timer for pdf ingestion
      totalTimeToIngestPDF()
      loggerWithChild({ email: userEmail }).info(
        `Inserted ${driveFilesInserted} files of type ${DriveEntity.PDF}`,
      )

      const totalDurationOfDriveFileExtraction =
        totalDurationForFileExtraction.startTimer({
          file_type: DriveEntity.Misc,
          mime_type: "application/vnd.google-apps.file",
          email: userEmail,
        })
      const [documents, slides, sheetsObj]: [
        VespaFileWithDrivePermission[],
        VespaFileWithDrivePermission[],
        { sheets: VespaFileWithDrivePermission[]; count: number },
      ] = await Promise.all([
        googleDocsVespa(
          googleClient,
          googleDocsMetadata,
          connector.externalId,
          userEmail,
        ),
        googleSlidesVespa(
          googleClient,
          googleSlidesMetadata,
          connector.externalId,
          userEmail,
        ),
        googleSheetsVespa(
          googleClient,
          googleSheetsMetadata,
          connector.externalId,
          userEmail,
        ),
      ])
      totalDurationOfDriveFileExtraction()
      const driveFiles: VespaFileWithDrivePermission[] = await driveFilesToDoc(
        googleClient,
        rest,
        userEmail,
      )

      let allFiles: VespaFileWithDrivePermission[] = [
        ...driveFiles,
        ...documents,
        ...slides,
        ...sheetsObj.sheets,
      ].map((v) => {
        v.permissions = toPermissionsList(v.permissions, userEmail)
        return v
      })

      const totalIngestionDuration = ingestionDuration.startTimer({
        file_type: DriveEntity.Misc,
        mime_type: "application/vnd.google-apps.file",
        email: userEmail,
      })

      for (const doc of allFiles) {
        // determine the  file type here so we can insert in metrics data
        const fileType =
          doc.mimeType === DriveMime.Docs
            ? DriveEntity.Docs
            : doc.mimeType === DriveMime.Sheets
              ? DriveEntity.Sheets
              : doc.mimeType === DriveMime.Slides
                ? DriveEntity.Slides
                : DriveEntity.Misc

        loggerWithChild({ email: userEmail! }).info(
          `Processing file: ID: ${doc.docId}, Name: ${doc.title}, MimeType: ${doc.mimeType}, FileType: ${fileType}`,
        )
        try {
          await insertWithRetry(doc, fileSchema)
          // do not update for Sheet as we will add the actual count later
          driveFilesInserted++
          loggerWithChild({ email: userEmail! }).info(
            `Mime type: ${doc.mimeType}`,
          )

          if (doc.mimeType !== DriveMime.Sheets) {
            processedFiles += 1
            tracker.updateUserStats(userEmail, StatType.Drive, 1)
            totalIngestedFiles.inc({
              mime_type: doc.mimeType ?? "application/vnd.google-apps.file",
              status: "SUCCESS",
              email: userEmail,
              file_type: fileType,
            })
            if (fileType == DriveEntity.Docs) {
              if (isScriptRunning) {
                loggerWithChild({ email: userEmail }).info(
                  `Sending Progress for inserted docs`,
                )
                sendProgressToServer({
                  userEmail: userEmail,
                  messageCount: 0,
                  attachmentCount: 0,
                  failedMessages: 0,
                  failedAttachments: 0,
                  totalMailsToBeIngested: 0,
                  totalMailsSkipped: 0,
                  insertedEventCount: 0,
                  insertedContactsCount: 0,
                  insertedpdfCount: 0,
                  insertedDocCount: 1,
                  insertedSheetCount: 0,
                  insertedSlideCount: 0,
                  insertedDriveFileCount: 0,
                  totalDriveflesToBeIngested: 0,
                  totalBlockedPdfs: 0,
                })
              }
            }
            if (fileType == DriveEntity.Slides) {
              if (isScriptRunning) {
                loggerWithChild({ email: userEmail }).info(
                  `Sending Progress for inserted slides`,
                )
                sendProgressToServer({
                  userEmail: userEmail,
                  messageCount: 0,
                  attachmentCount: 0,
                  failedMessages: 0,
                  failedAttachments: 0,
                  totalMailsToBeIngested: 0,
                  totalMailsSkipped: 0,
                  insertedEventCount: 0,
                  insertedContactsCount: 0,
                  insertedpdfCount: 0,
                  insertedDocCount: 0,
                  insertedSheetCount: 0,
                  insertedSlideCount: 1,
                  insertedDriveFileCount: 0,
                  totalDriveflesToBeIngested: 0,
                  totalBlockedPdfs: 0,
                })
              }
            }
            if (fileType == DriveEntity.Misc) {
              if (isScriptRunning) {
                loggerWithChild({ email: userEmail }).info(
                  `Sending Progress for inserted drive files`,
                )
                sendProgressToServer({
                  userEmail: userEmail,
                  messageCount: 0,
                  attachmentCount: 0,
                  failedMessages: 0,
                  failedAttachments: 0,
                  totalMailsToBeIngested: 0,
                  totalMailsSkipped: 0,
                  insertedEventCount: 0,
                  insertedContactsCount: 0,
                  insertedpdfCount: 0,
                  insertedDocCount: 0,
                  insertedSheetCount: 0,
                  insertedSlideCount: 0,
                  insertedDriveFileCount: 1,
                  totalDriveflesToBeIngested: 0,
                  totalBlockedPdfs: 0,
                })
              }
            }
          }
          loggerWithChild({ email: userEmail! }).info(
            `Inserted file of type ${fileType} with ID: ${doc.docId} and Name: ${doc.title},`,
          )
        } catch (error) {
          const errorMessage = getErrorMessage(error)
          loggerWithChild({ email: userEmail! }).error(
            error,
            `Could not insert file of type ${doc.mimeType} with id ${doc.docId} for user: ${errorMessage} ${(error as Error).stack}`,
          )
          ingestionErrorsTotal.inc(
            {
              file_type: fileType,
              mime_type: doc.mimeType ?? "application/vnd.google-apps.file",
              email: doc.ownerEmail ?? userEmail,
              error_type: `ERROR_INSERTING_${fileType}_file`,
              status: "FAILED",
            },
            1,
          )
        }
      }
      tracker.updateUserStats(userEmail, StatType.Drive, sheetsObj.count)
      if (isScriptRunning) {
        loggerWithChild({ email: userEmail }).info(
          `Sending Progress for inserted sheets`,
        )
        sendProgressToServer({
          userEmail: userEmail,
          messageCount: 0,
          attachmentCount: 0,
          failedMessages: 0,
          failedAttachments: 0,
          totalMailsToBeIngested: 0,
          totalMailsSkipped: 0,
          insertedEventCount: 0,
          insertedContactsCount: 0,
          insertedpdfCount: 0,
          insertedDocCount: 0,
          insertedSheetCount: sheetsObj.count,
          insertedSlideCount: 0,
          insertedDriveFileCount: 0,
          totalDriveflesToBeIngested: 0,
          totalBlockedPdfs: 0,
        })
      }
      totalIngestedFiles.inc(
        {
          mime_type: "application/vnd.google-apps.spreadsheet",
          status: "SUCCESS",
          email: userEmail,
          file_type: DriveEntity.Sheets,
        },
        sheetsObj.count,
      )

      loggerWithChild({ email: userEmail! }).info(
        `finished ${initialCount} files`,
      )
      loggerWithChild({ email: userEmail! }).info(
        `Inserted a total of ${driveFilesInserted} drive files`,
      )
      totalIngestionDuration()
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    loggerWithChild({ email: userEmail! }).error(
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
  client: GoogleClient,
  email: string,
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
        Apps.GoogleDrive,
        0,
        client,
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
      loggerWithChild({ email: email }).error(
        error,
        `Failed to fetch sheets '${ranges.join(", ")}' from spreadsheet: ${(error as Error).message}`,
      )
      continue
    }
  }
  return allSheets
}

// Function to get the whole spreadsheet
// One spreadsheet can contain multiple sheets like Sheet1, Sheet2
export const getSpreadsheet = async (
  sheets: sheets_v4.Sheets,
  id: string,
  client: GoogleClient,
  email: string,
): Promise<any | null> => {
  try {
    return retryWithBackoff(
      () => sheets.spreadsheets.get({ spreadsheetId: id }),
      `Fetching spreadsheet with ID ${id}`,
      Apps.GoogleDrive,
      0,
      client,
    )
  } catch (error) {
    if (error instanceof GaxiosError) {
      loggerWithChild({ email: email }).error(
        `GaxiosError while fetching drive changes: status ${error.response?.status}, ` +
          `statusText: ${error.response?.statusText}, data: ${JSON.stringify(error.response?.data)}`,
      )
    } else if (error instanceof Error) {
      loggerWithChild({ email: email }).error(
        `Unexpected error while fetching drive changes: ${error.message}`,
      )
    } else {
      loggerWithChild({ email: email }).error(
        `An unknown error occurred while fetching drive changes.`,
      )
    }
    return null
  }
}

export const getSheetsListFromOneSpreadsheet = async (
  sheets: sheets_v4.Sheets,
  client: GoogleClient,
  spreadsheet: drive_v3.Schema$File,
  userEmail: string,
): Promise<VespaFileWithDrivePermission[]> => {
  // Early size check before fetching spreadsheet data
  const sizeInBytes = spreadsheet.size ? parseInt(spreadsheet.size, 10) : 0
  try {
    checkFileSize(sizeInBytes, MAX_GD_SHEET_SIZE)
  } catch (error) {
    loggerWithChild({ email: userEmail }).warn(
      `Ignoring ${spreadsheet.name} as its size (${Math.round(sizeInBytes / 1024 / 1024)} MB) exceeds the limit of ${MAX_GD_SHEET_SIZE} MB`,
    )
    return []
  }

  const sheetsArr = []
  try {
    const spreadSheetData = await getSpreadsheet(
      sheets,
      spreadsheet.id!,
      client,
      userEmail,
    )

    if (spreadSheetData) {
      // Now we should get all sheets inside this spreadsheet using the spreadSheetData
      const allSheetsFromSpreadSheet = await getAllSheetsFromSpreadSheet(
        sheets,
        spreadSheetData.data,
        spreadsheet.id!,
        client,
        userEmail,
      )

      // There can be multiple parents
      // Element of parents array contains folderId and folderName
      const parentsForMetadata = []
      let parentId = null
      // Shared files cannot have parents
      // There can be some files that user has access to may not have parents as they are shared
      if (spreadsheet?.parents) {
        if (spreadsheet.parents.length > 0) parentId = spreadsheet.parents[0]
        for (const pId of spreadsheet?.parents!) {
          const parentData = await getFile(client, pId)
          const folderName = parentData?.name!
          parentsForMetadata.push({ folderName, folderId: pId })
        }
      }

      for (const [sheetIndex, sheet] of allSheetsFromSpreadSheet?.entries()) {
        const finalRows = cleanSheetAndGetValidRows(sheet?.valueRanges ?? [])

        if (finalRows?.length === 0) {
          // Logger.warn(
          //   `${spreadsheet.name} -> ${sheet.sheetTitle} found no rows. Skipping it`,
          // )
          continue
        }

        const chunks: string[] = chunkSheetWithHeaders(finalRows)

        const sheetDataToBeIngested = {
          title: `${spreadsheet.name} / ${sheet?.sheetTitle}`,
          url: sheet?.sheetId
            ? `https://docs.google.com/spreadsheets/d/${spreadsheet.id}/edit#gid=${sheet.sheetId}`
            : (spreadsheet.webViewLink ?? ""),
          app: Apps.GoogleDrive,
          // TODO Document it eveyrwhere
          // Combining spreadsheetId and sheetIndex as single spreadsheet can have multiple sheets inside it
          docId: `${spreadsheet?.id}_${sheetIndex}`,
          parentId: parentId,
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
    } else {
      return []
    }
  } catch (error) {
    loggerWithChild({ email: userEmail }).error(
      error,
      `Error getting all sheets list from spreadhseet with id ${spreadsheet.id}`,
    )
    return []
  }
}

// we send count so we can know the exact count of the actual
// files that are of type sheet
const googleSheetsVespa = async (
  client: GoogleClient,
  spreadsheetsMetadata: drive_v3.Schema$File[],
  connectorId: string,
  userEmail: string,
): Promise<{ sheets: VespaFileWithDrivePermission[]; count: number }> => {
  // sendWebsocketMessage(
  //   `Scanning ${spreadsheetsMetadata.length} Google Sheets`,
  //   connectorId,
  // )
  let sheetsList: VespaFileWithDrivePermission[] = []
  const sheets = google.sheets({ version: "v4", auth: client })
  const total = spreadsheetsMetadata.length
  let count = 0

  for (const spreadsheet of spreadsheetsMetadata) {
    const sheetSize = spreadsheet.size ? parseInt(spreadsheet.size) : 0

    contentFileSize.observe(
      {
        mime_type:
          spreadsheet.mimeType ?? "application/vnd.google-apps.spreadsheet",
        file_type: DriveEntity.Sheets,
        email: userEmail,
      },
      sheetSize,
    )
    try {
      const endSheetExtractionDuration = extractionDuration.startTimer({
        mime_type:
          spreadsheet.mimeType ?? "application/vnd.google-apps.spreadsheet",
        email: userEmail,
        file_type: DriveEntity.Sheets,
      })
      const sheetsListFromOneSpreadsheet =
        await getSheetsListFromOneSpreadsheet(
          sheets,
          client,
          spreadsheet,
          userEmail,
        )
      sheetsList.push(...sheetsListFromOneSpreadsheet)
      count += 1
      endSheetExtractionDuration()
      // if (count % 5 === 0) {
      //   sendWebsocketMessage(`${count} Google Sheets scanned`, connectorId)
      // }
    } catch (error) {
      loggerWithChild({ email: userEmail! }).error(
        error,
        `Error getting sheet files: ${error} ${(error as Error).stack}`,
        error,
      )
      fileExtractionErrorsTotal.inc({
        error_type: "SPREADSHEET_EXTRACTION_FAILED_ERROR",
        mime_type:
          spreadsheet.mimeType ?? "application/vnd.google-apps.spreadsheet",
        email: userEmail,
        file_type: DriveEntity.Sheets,
      })
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
  totalExtractedFiles.inc(
    {
      mime_type: "application/vnd.google-apps.spreadsheet",
      status: "SUCCESS",
      email: userEmail,
      file_type: DriveEntity.Sheets,
    },
    count,
  )
  return { sheets: sheetsList, count }
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
  client: GoogleClient,
): Promise<void> => {
  const filePath = path.join(downloadDir, fileName)
  const file = Bun.file(filePath)
  const writer = file.writer()
  const res = await retryWithBackoff(
    () =>
      drive.files.get(
        { fileId: fileId, alt: "media" },
        { responseType: "stream" },
      ),
    `Getting PDF content of fileId ${fileId}`,
    Apps.GoogleDrive,
    0,
    client,
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
  loggerWithChild({ email: userEmail! }).info(
    `Starting PDF processing for ${pdfsMetadata.length} files for user ${userEmail}`,
  )
  // a flag just for the error to know
  // if the file was downloaded or not
  const limit = pLimit(PDFProcessingConcurrency)
  const pdfPromises = pdfsMetadata.map((pdf) =>
    limit(async () => {
      loggerWithChild({ email: userEmail! }).info(
        `Processing PDF: ID: ${pdf.id}, Name: ${pdf.name} for user ${userEmail}`,
      )
      const pdfSizeInMB = parseInt(pdf.size!) / (1024 * 1024)
      // Ignore the PDF files larger than Max PDF Size
      if (pdfSizeInMB > MAX_GD_PDF_SIZE) {
        loggerWithChild({ email: userEmail! }).warn(
          `Ignoring ${pdf.name} as its more than ${MAX_GD_PDF_SIZE} MB`,
        )
        if (isScriptRunning) {
          loggerWithChild({ email: userEmail }).info(
            `Sending Progress for Blocked PDFs`,
          )
          sendProgressToServer({
            userEmail: userEmail,
            messageCount: 0,
            attachmentCount: 0,
            failedMessages: 0,
            failedAttachments: 0,
            totalMailsToBeIngested: 0,
            totalMailsSkipped: 0,
            insertedEventCount: 0,
            insertedContactsCount: 0,
            insertedpdfCount: 0,
            insertedDocCount: 0,
            insertedSheetCount: 0,
            insertedSlideCount: 0,
            insertedDriveFileCount: 0,
            totalDriveflesToBeIngested: 0,
            totalBlockedPdfs: 1,
          })
        }
        blockedFilesTotal.inc({
          mime_type: pdf.mimeType ?? "google_pdf",
          blocked_type: "MAX_PDF_SIZE_EXCEEDED",
          email: userEmail,
          file_type: DriveEntity.PDF,
          status: "BLOCKED",
        })
        return null
      }

      console.log(`PDF SIZE : `, pdfSizeInMB)
      contentFileSize.observe(
        {
          mime_type: pdf.mimeType ?? "google_pdf",
          file_type: DriveEntity.PDF,
          email: userEmail,
        },
        pdf.size ? parseInt(pdf.size) : 0,
      )
      const pdfFileName = `${hashPdfFilename(`${userEmail}_${pdf.id}_${pdf.name}`)}.pdf`
      const pdfPath = `${downloadDir}/${pdfFileName}`
      try {
        loggerWithChild({ email: userEmail! }).debug(
          `getting the data from the drive-> ${pdf.name}${pdfFileName}`,
        )
        const endExtractionTimer = extractionDuration.startTimer({
          mime_type: pdf.mimeType ?? "google_pdf",
          file_type: DriveEntity.PDF,
          email: userEmail,
        })
        await downloadPDF(drive, pdf.id!, pdfFileName, client)

        const docs: Document[] = await safeLoadPDF(pdfPath)
        if (!docs || docs.length === 0) {
          await deleteDocument(pdfPath)
          return null
        }

        const chunks = docs.flatMap((doc) => chunkDocument(doc.pageContent))
        let parentId = null
        const parentsForMetadata = []
        if (pdf?.parents) {
          if (pdf.parents.length) parentId = pdf.parents[0]
          for (const pId of pdf.parents!) {
            const parentData = await getFile(client, pId)
            const folderName = parentData?.name!
            parentsForMetadata.push({ folderName, folderId: pId })
          }
        }

        // Cleanup immediately after processing
        await deleteDocument(pdfPath)
        endExtractionTimer()
        totalExtractedFiles.inc(
          {
            mime_type: pdf.mimeType ?? "google_pdf",
            status: "SUCCESS",
            email: userEmail,
            file_type: DriveEntity.PDF,
          },
          1,
        )
        return {
          title: pdf.name!,
          url: pdf.webViewLink ?? "",
          app: Apps.GoogleDrive,
          docId: pdf.id!,
          parentId: parentId,
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
        loggerWithChild({ email: userEmail! }).error(
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
        fileExtractionErrorsTotal.inc({
          error_type: "PDF_EXTRACTION_FAILED_ERROR",
          mime_type: pdf.mimeType ?? "google_pdf",
          file_type: DriveEntity.PDF,
          email: userEmail,
        })
        // we cannot break the whole pdf pipeline for one error
        return null
      }
    }),
  )
  const results = await Promise.all(pdfPromises)
  const filteredResults = results.filter((v) => !!v)

  return filteredResults
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
export const listAllContacts = async (
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
    const response = await retryWithBackoff(
      () =>
        peopleService.people.connections.list({
          resourceName: "people/me",
          pageSize: maxOtherContactsPerPage,
          personFields: keys.join(","),
          pageToken,
          requestSyncToken: true,
        }),
      `Fetching contacts with pageToken ${pageToken}`,
      Apps.GoogleDrive,
      0,
      client,
    )

    if (response.data.connections) {
      contacts.push(...response.data.connections)
    }

    pageToken = response.data.nextPageToken ?? ""
    newSyncTokenContacts = response.data.nextSyncToken ?? ""
  } while (pageToken)

  // reset page token for other contacts
  pageToken = ""

  do {
    const response = await retryWithBackoff(
      () =>
        peopleService.otherContacts.list({
          pageSize: maxOtherContactsPerPage,
          readMask: keys.join(","),
          pageToken,
          requestSyncToken: true,
          sources: ["READ_SOURCE_TYPE_PROFILE", "READ_SOURCE_TYPE_CONTACT"],
        }),
      `Fetching other contacts with pageToken ${pageToken}`,
      Apps.GoogleDrive,
      0,
      client,
    )

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
    loggerWithChild({ email: owner }).error(`Id does not exist for ${entity}`)
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
  tracker: Tracker,
): Promise<void> => {
  const contactIngestionDuration = ingestionDuration.startTimer({
    file_type: GooglePeopleEntity.Contacts,
    mime_type: "google_people",
    email: owner,
  })
  try {
    loggerWithChild({ email: owner }).info(`Inserting Contacts`)
    for (const contact of contacts) {
      await insertContact(contact, GooglePeopleEntity.Contacts, owner)
      tracker.updateUserStats(owner, StatType.Contacts, 1)
    }
    loggerWithChild({ email: owner }).info(`Inserting Other Contacts`)
    for (const contact of otherContacts) {
      await insertContact(contact, GooglePeopleEntity.OtherContacts, owner)
      tracker.updateUserStats(owner, StatType.Contacts, 1)
    }
  } catch (error) {
    // error is related to vespa and not mapping
    if (error instanceof ErrorInsertingDocument) {
      loggerWithChild({ email: owner! }).error(
        error,
        `Could not insert contact: ${(error as Error).stack}`,
      )
      throw error
    } else {
      loggerWithChild({ email: owner! }).error(
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
  } finally {
    contactIngestionDuration()
    metadataFiles.inc(
      {
        file_type: GooglePeopleEntity.Contacts,
        mime_type: "google_people",
        email: owner,
      },
      contacts.length + otherContacts.length,
    )
    if (isScriptRunning) {
      loggerWithChild({ email: owner }).info(
        `Sending Progress for inserted contacts`,
      )

      sendProgressToServer({
        userEmail: owner,
        messageCount: 0,
        attachmentCount: 0,
        failedMessages: 0,
        failedAttachments: 0,
        totalMailsToBeIngested: 0,
        totalMailsSkipped: 0,
        insertedEventCount: 0,
        insertedContactsCount: contacts.length + otherContacts.length,
        insertedpdfCount: 0,
        insertedDocCount: 0,
        insertedSheetCount: 0,
        insertedSlideCount: 0,
        insertedDriveFileCount: 0,
        totalDriveflesToBeIngested: 0,
        totalBlockedPdfs: 0,
      })
    }
  }
}

export async function* listFiles(
  client: GoogleClient,
  startDate?: string,
  endDate?: string,
  q?: string,
): AsyncIterableIterator<drive_v3.Schema$File[]> {
  const drive = google.drive({ version: "v3", auth: client })
  let nextPageToken = ""

  // Build the query with date filters if provided
  let query = q ? `(${q}) and trashed = false` : "trashed = false"
  const dateFilters: string[] = []

  if (startDate) {
    const startDateObj = new Date(startDate)
    const formattedStartDate = startDateObj.toISOString().split("T")[0]
    dateFilters.push(`modifiedTime >= '${formattedStartDate}'`)
  }
  if (endDate) {
    const endDateObj = new Date(endDate) // e.g., 2024-05-20T00:00:00.000Z
    endDateObj.setDate(endDateObj.getDate() + 1) // Becomes 2024-05-21T00:00:00.000Z
    const formattedExclusiveEndDate = endDateObj.toISOString().split("T")[0] // "2024-05-21"
    dateFilters.push(`modifiedTime < '${formattedExclusiveEndDate}'`) // Includes all of 2024-05-20
  }

  if (dateFilters.length > 0) {
    query = `${query} and ${dateFilters.join(" and ")}`
  }

  do {
    const res: any = await retryWithBackoff(
      () =>
        drive.files.list({
          q: query,
          pageSize: 100,
          fields:
            "nextPageToken, files(id, webViewLink, size, parents, createdTime, modifiedTime, name, owners, fileExtension, mimeType, permissions(id, type, emailAddress))",
          pageToken: nextPageToken,
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        }),
      `Fetching all files from Google Drive`,
      Apps.GoogleDrive,
      0,
      client,
    )

    if (res.data.files) {
      yield res.data.files
    }
    nextPageToken = res.data.nextPageToken ?? ""
  } while (nextPageToken)
}

export const googleDocsVespa = async (
  client: GoogleClient,
  docsMetadata: drive_v3.Schema$File[],
  connectorId: string,
  userEmail?: string,
): Promise<VespaFileWithDrivePermission[]> => {
  loggerWithChild({ email: userEmail! }).info(
    `Starting Google Docs processing for ${docsMetadata.length} files. Connector ID: ${connectorId}`,
  )
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
      loggerWithChild({ email: userEmail! }).info(
        `Processing Google Doc: ID: ${doc.id}, Name: ${doc.name}. Connector ID: ${connectorId}`,
      )
      const endDownloadDuration = extractionDuration.startTimer({
        mime_type: doc.mimeType ?? "application/vnd.google-apps.document",
        file_type: DriveEntity.Docs,
        email: userEmail,
      })
      try {
        const docResponse: any = await retryWithBackoff(
          () =>
            docs.documents.get({
              documentId: doc.id as string,
            }),
          `Fetching document with documentId ${doc.id}`,
          Apps.GoogleDrive,
          0,
          client,
        )
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

        const sizeInBytes = Buffer.byteLength(cleanedTextContent, "utf8")
        contentFileSize.observe(
          {
            mime_type: doc.mimeType ?? "",
            file_type: DriveEntity.Docs,
            email: userEmail,
          },
          sizeInBytes,
        )
        const chunks = chunkDocument(cleanedTextContent)

        const parentsForMetadata = []
        // Shared files cannot have parents
        // There can be some files that user has access to may not have parents as they are shared
        let parentId = null
        if (doc?.parents) {
          if (doc.parents.length) parentId = doc.parents[0]
          for (const pId of doc?.parents!) {
            const parentData = await getFile(client, pId)
            const folderName = parentData?.name!
            parentsForMetadata.push({ folderName, folderId: pId })
          }
        }

        const result: VespaFileWithDrivePermission = {
          title: doc.name!,
          url: doc.webViewLink ?? "",
          app: Apps.GoogleDrive,
          docId: doc.id!,
          parentId: parentId,
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
        endDownloadDuration()
        totalExtractedFiles.inc(
          {
            mime_type: doc.mimeType ?? "",
            status: "SUCCESS",
            email: userEmail,
            file_type: DriveEntity.Docs,
          },
          1,
        )
        return result
      } catch (error) {
        const errorMessage = getErrorMessage(error)
        loggerWithChild({ email: userEmail! }).error(
          error,
          `Error processing Google Doc: ${errorMessage} ${(error as Error).stack}`,
        )
        fileExtractionErrorsTotal.inc({
          error_type: "DOCUMENT_EXTRACTION_FAILED_ERROR",
          mime_type: doc.mimeType ?? "",
          file_type: DriveEntity.Docs,
          email: userEmail,
        })
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
  userEmail?: string,
): Promise<VespaFileWithDrivePermission[]> => {
  let results: VespaFileWithDrivePermission[] = []
  for (const doc of rest) {
    const file = await driveFileToIndexed(client, doc)
    if (file) {
      results.push(file)
    }
  }
  return results
}

export async function getGmailCounts(
  client: GoogleClient,
  email?: string,
  startDate?: string,
  endDate?: string,
): Promise<{
  messagesTotal: number
  messagesExcludingPromotions: number
}> {
  const gmail = google.gmail({ version: "v1", auth: client })
  let messagesTotal = 0
  let promotionMessages = 0

  if (!startDate && !endDate) {
    // No date filters: Use direct profile and label counts for overall totals
    loggerWithChild({ email: email ?? "" }).info(
      "Gmail count: No date filters provided. Fetching overall totals.",
    )
    try {
      const profile = await retryWithBackoff(
        () => gmail.users.getProfile({ userId: "me", fields: "messagesTotal" }),
        "Fetching Gmail profile for total count",
        Apps.Gmail,
        0,
        client,
      )
      messagesTotal = profile.data.messagesTotal ?? 0
      loggerWithChild({ email: email ?? "" }).info(
        `Gmail count: Overall messagesTotal from profile: ${messagesTotal}`,
      )
    } catch (error) {
      loggerWithChild({ email: email ?? "" }).error(
        error,
        `Error fetching Gmail profile for total count: ${(error as Error).message}`,
      )
      // Fallback or rethrow depending on desired error handling for overall count failure
      messagesTotal = 0 // Or throw error
    }

    try {
      const promoLabel = await retryWithBackoff(
        () =>
          gmail.users.labels.get({
            userId: "me",
            id: "CATEGORY_PROMOTIONS",
            fields: "messagesTotal",
          }),
        "Fetching Promotions label count (overall)",
        Apps.Gmail,
        0,
        client,
      )
      promotionMessages = promoLabel.data.messagesTotal ?? 0
      loggerWithChild({ email: email ?? "" }).info(
        `Gmail count: Overall promotionMessages from label: ${promotionMessages}`,
      )
    } catch (error: any) {
      if (error.code === 404) {
        loggerWithChild({ email: email ?? "" }).warn(
          "Promotions label (CATEGORY_PROMOTIONS) not found, assuming 0 promotion messages for overall count.",
        )
      } else {
        loggerWithChild({ email: email ?? "" }).error(
          error,
          `Error fetching Promotions label count (overall): ${error.message}`,
        )
      }
      promotionMessages = 0 // Default to 0 on error
    }
  } else {
    // Date filters are present: Use messages.list with queries
    loggerWithChild({ email: email ?? "" }).info(
      `Gmail count: Date filters present (startDate: ${startDate}, endDate: ${endDate}). Using query-based counts.`,
    )
    const dateFilters: string[] = []
    let baseQuery = ""

    if (startDate) {
      const startDateObj = new Date(startDate)
      const formattedStartDate = startDateObj
        .toISOString()
        .split("T")[0]
        .replace(/-/g, "/")
      dateFilters.push(`after:${formattedStartDate}`)
    }
    if (endDate) {
      const endDateObj = new Date(endDate)
      // To make endDate inclusive, we query for messages *before* the day after endDate.
      endDateObj.setDate(endDateObj.getDate() + 1)
      const formattedExclusiveEndDate = endDateObj
        .toISOString()
        .split("T")[0]
        .replace(/-/g, "/")
      dateFilters.push(`before:${formattedExclusiveEndDate}`)
    }

    if (dateFilters.length > 0) {
      baseQuery = dateFilters.join(" AND ")
    }

    loggerWithChild({ email: email ?? "" }).info(
      `Gmail count query: Final query string for total: "${baseQuery}"`,
    )
    let nextPageToken: any = null
    try {
      do {
        const messagesResponse = await retryWithBackoff(
          () =>
            gmail.users.messages.list({
              userId: "me",
              q: baseQuery,
              maxResults: 500,
              pageToken: nextPageToken || undefined, // Pass the current page token
            }),
          "Fetching Gmail messages count (date-filtered)",
          Apps.Gmail,
          0,
          client,
        )

        // Count the actual messages in this page
        const messagesInThisPage = messagesResponse.data.messages?.length ?? 0
        messagesTotal += messagesInThisPage

        // Get the token for the next page
        nextPageToken = messagesResponse.data.nextPageToken || null
      } while (nextPageToken)

      loggerWithChild({ email: email ?? "" }).info(
        `Gmail count query: resultSizeEstimate for total (date-filtered): ${messagesTotal}`,
      )
    } catch (error) {
      loggerWithChild({ email: email ?? "" }).error(
        error,
        `Error fetching date-filtered Gmail messages count: ${(error as Error).message}`,
      )
      messagesTotal = 0 // Or throw
    }

    const promoQuery =
      dateFilters.length > 0
        ? `category:promotions AND ${dateFilters.join(" AND ")}`
        : "category:promotions"
    loggerWithChild({ email: email ?? "" }).info(
      `Gmail count query: Promotions query string (date-filtered): "${promoQuery}"`,
    )
    try {
      nextPageToken = null // Reset for promotions query
      do {
        const promoMessagesResponse = await retryWithBackoff(
          () =>
            gmail.users.messages.list({
              userId: "me",
              q: promoQuery,
              maxResults: 500,
            }),
          "Fetching Promotions messages count (date-filtered)",
          Apps.Gmail,
          0,
          client,
        )
        promotionMessages += promoMessagesResponse.data.resultSizeEstimate ?? 0
        nextPageToken = promoMessagesResponse.data.nextPageToken || null
      } while (nextPageToken)
      loggerWithChild({ email: email ?? "" }).info(
        `Gmail count query: resultSizeEstimate for promotions (date-filtered): ${promotionMessages}`,
      )
    } catch (error: any) {
      // Check if the error is specifically the "notACalendarUser" error (though this is gmail, the pattern might be similar for disabled services or specific errors)
      // For Gmail, a 404 on promotions with a query might just mean no results, or an invalid query component if not handled carefully.
      // The `category:promotions` is standard; a 404 here is less likely than with labels.get if the category itself is "missing"
      loggerWithChild({ email: email ?? "" }).error(
        error,
        `Error fetching Promotions count (date-filtered): ${error.message}`,
      )
      promotionMessages = 0 // Default to 0 on error
    }
  }

  const messagesExcludingPromotions = Math.max(
    0,
    messagesTotal - promotionMessages,
  )
  loggerWithChild({ email: email ?? "" }).info(
    `Gmail: Total=${messagesTotal}, Promotions=${promotionMessages}, Excl. Promo=${messagesExcludingPromotions} (startDate: ${startDate}, endDate: ${endDate})`,
  )
  return { messagesTotal, messagesExcludingPromotions }
}

// Count Drive Files
export async function countDriveFiles(
  client: GoogleClient,
  email?: string,
  startDate?: string,
  endDate?: string,
): Promise<number> {
  const drive = google.drive({ version: "v3", auth: client })
  let fileCount = 0
  let nextPageToken: string | undefined
  const dateFilters: string[] = []

  loggerWithChild({ email: email ?? "" }).info(`Started Counting Files`)
  if (startDate) {
    const startDateObj = new Date(startDate)
    const formattedStartDate = startDateObj.toISOString().split("T")[0]
    dateFilters.push(`modifiedTime >= '${formattedStartDate}'`)
  }
  if (endDate) {
    const endDateObj = new Date(endDate) // e.g., 2024-05-20T00:00:00.000Z
    endDateObj.setDate(endDateObj.getDate() + 1) // Becomes 2024-05-21T00:00:00.000Z
    const formattedExclusiveEndDate = endDateObj.toISOString().split("T")[0] // "2024-05-21"
    dateFilters.push(`modifiedTime < '${formattedExclusiveEndDate}'`) // Includes all of 2024-05-20
  }

  let query = "trashed = false"
  if (dateFilters.length > 0) {
    query = `${query} and ${dateFilters.join(" and ")}`
  }

  do {
    const res: any = await retryWithBackoff(
      () =>
        drive.files.list({
          q: query,
          pageSize: 1000,
          fields: "nextPageToken, files(id)",
          pageToken: nextPageToken,
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        }),
      `Counting Drive files (pageToken: ${nextPageToken || "initial"})`,
      Apps.GoogleDrive,
      0,
      client,
    )
    fileCount += res.data.files?.length || 0
    nextPageToken = res.data.nextPageToken as string | undefined
  } while (nextPageToken)

  loggerWithChild({ email: email ?? "" }).info(
    `Counted ${fileCount} Drive files`,
  )
  return fileCount
}

export type IngestMoreGoogleServiceAccountUsersPayload = {
  connectorId: string
  emailsToIngest: string[]
}

// Helper function to get a valid user email
const getValidUserEmailFromGoogleUser = (
  googleUser: admin_directory_v1.Schema$User,
): string | undefined => {
  let userEmailAddress: string | undefined =
    googleUser.primaryEmail || undefined

  if (
    !userEmailAddress &&
    googleUser.emails &&
    Array.isArray(googleUser.emails) &&
    googleUser.emails.length > 0
  ) {
    const firstEmailObject = googleUser.emails.find(
      (emailEntry: any) =>
        emailEntry &&
        typeof emailEntry.address === "string" &&
        emailEntry.address,
    )
    if (firstEmailObject) {
      userEmailAddress = firstEmailObject.address
    }
  }
  // Ensure empty string is treated as undefined
  return userEmailAddress === "" ? undefined : userEmailAddress
}

export const ServiceAccountIngestMoreUsers = async (
  payload: IngestMoreGoogleServiceAccountUsersPayload & {
    startDate: string
    endDate: string
    insertDriveAndContacts: boolean
    insertGmail: boolean
    insertCalendar: boolean
  },
  userId: number,
  isScript?: boolean,
) => {
  isScriptRunning = isScript!

  const jobId = uuidv4()
  const {
    connectorId,
    emailsToIngest,
    startDate,
    endDate,
    insertDriveAndContacts,
    insertGmail,
    insertCalendar,
  } = payload

  Logger.info(
    `ServiceAccountIngestMoreUsers called with jobId: ${jobId} for connector externalId: ${connectorId} ...`,
  )

  if (isScript) {
    Logger.info(`Script is running, initialising gmail worker`)
    initializeGmailWorker()
  }
  let connector: SelectConnector | null = null
  const tracker = new Tracker(Apps.GoogleWorkspace, AuthType.ServiceAccount)
  activeJobTrackers.set(jobId, tracker)

  try {
    connector = await getConnectorByExternalId(db, connectorId, userId)
    if (!connector) {
      throw new Error(
        `Connector with externalID ${connectorId} for authorizing user ${userId} not found or access denied.`,
      )
    }

    const serviceAccountKey: GoogleServiceAccount = JSON.parse(
      connector.credentials as string,
    )
    const subject: string = connector.subject as string

    const adminJwtClient = createJwtClient(serviceAccountKey, subject)
    const admin = google.admin({
      version: "directory_v1",
      auth: adminJwtClient,
    })

    const usersToProcess = await listUsersByEmails(admin, emailsToIngest)

    if (usersToProcess.length === 0) {
      Logger.warn(
        `No valid Google users found for the provided emails: ${emailsToIngest.join(
          ", ",
        )} (jobId: ${jobId}). Aborting ingest more operation.`,
      )
      if (connector.externalId) {
        sendWebsocketMessage(
          JSON.stringify({
            message: "No valid users found for ingestion.",
            error: true,
          }),
          connector.externalId,
        )
        closeWs(connector.externalId)
      }
      return
    }

    // Deduplicate users based on the extracted valid email
    const uniqueUsersMap = new Map<string, admin_directory_v1.Schema$User>()
    for (const user of usersToProcess) {
      const email = getValidUserEmailFromGoogleUser(user)
      if (email && !uniqueUsersMap.has(email)) {
        uniqueUsersMap.set(email, user)
      }
    }
    const uniqueUsersToProcess = Array.from(uniqueUsersMap.values())

    if (uniqueUsersToProcess.length !== usersToProcess.length) {
      Logger.warn(
        `Removed ${usersToProcess.length - uniqueUsersToProcess.length} duplicate or unidentifiable (no email) users from processing list (jobId: ${jobId})`,
      )
    }
    if (uniqueUsersToProcess.length === 0) {
      Logger.warn(
        `No users with valid emails found after deduplication for emails: ${emailsToIngest.join(
          ", ",
        )} (jobId: ${jobId}). Aborting ingest more operation.`,
      )
      if (connector.externalId) {
        sendWebsocketMessage(
          JSON.stringify({
            message:
              "No valid users with identifiable emails found for ingestion.",
            error: true,
          }),
          connector.externalId,
        )
        closeWs(connector.externalId)
      }
      return
    }

    Logger.info(
      `Ingesting for ${uniqueUsersToProcess.length} additional users (jobId: ${jobId}).`,
    )
    tracker.setTotalUsers(uniqueUsersToProcess.length)
    const ingestionMetadataList: IngestionMetadata[] = []

    const limit = pLimit(ServiceAccountUserConcurrency)
    const interval = setInterval(() => {
      if (connector?.externalId) {
        sendWebsocketMessage(
          JSON.stringify({
            progress: tracker.getProgress(),
            userStats: tracker.getServiceAccountProgress().userStats,
            startTime: tracker.getStartTime(),
            context: "ingestMore",
          }),
          connector.externalId,
        )
      }
    }, 4000)

    const userProcessingPromises = uniqueUsersToProcess.map((googleUser) =>
      limit(async () => {
        const userEmail = getValidUserEmailFromGoogleUser(googleUser)

        if (!userEmail) {
          Logger.error(
            `ServiceAccountIngestMoreUsers: Could not determine a valid email address for Google user ID: ${googleUser.id || "N/A"} (jobId: ${jobId}). Skipping this user's detailed processing.`,
          )
          tracker.markUserComplete(
            googleUser.id || `UNKNOWN_ID_${Math.random()}`,
          )
          return null // Return null for skipped users
        }

        loggerWithChild({ email: userEmail }).info(
          `Started ingestion for additional user: ${userEmail} (jobId: ${jobId})`,
        )

        const userJwtClient = createJwtClient(serviceAccountKey, userEmail)
        const userDriveClient = google.drive({
          version: "v3",
          auth: userJwtClient,
        })

        let driveFileCount = 0
        if (insertDriveAndContacts) {
          driveFileCount = await countDriveFiles(
            userJwtClient,
            userEmail,
            startDate,
            endDate,
          )
        }

        totalDriveFilesToBeIngested.inc(
          {
            email: userEmail,
            file_type: DriveEntity.Misc,
            status: OperationStatus.Success,
          },
          driveFileCount,
        )
        let mailCountExcludingPromotions = 0
        let totalMails = 0
        if (insertGmail) {
          try {
            loggerWithChild({ email: userEmail }).info(
              `Getting Gmail counts for user: ${userEmail} (jobId: ${jobId}) with date range: ${startDate} to ${endDate}`,
            )
            const gmailCounts = await getGmailCounts(
              userJwtClient,
              userEmail,
              startDate,
              endDate,
            )
            mailCountExcludingPromotions =
              gmailCounts.messagesExcludingPromotions
            totalMails = gmailCounts.messagesTotal
            loggerWithChild({ email: userEmail }).info(
              `Gmail counts for ${userEmail} (jobId: ${jobId}): Total=${gmailCounts.messagesTotal}, Excluding Promotions=${mailCountExcludingPromotions}`,
            )
          } catch (error) {
            loggerWithChild({ email: userEmail }).error(
              error,
              `Failed to get Gmail counts for user ${userEmail} (jobId: ${jobId}): ${getErrorMessage(error)}`,
            )
          }
        }

        totalGmailToBeIngestedCount.inc(
          {
            email: userEmail,
            account_type: AuthType.ServiceAccount,
            status: OperationStatus.Success,
          },
          mailCountExcludingPromotions,
        )
        totalSkippedMails.inc(
          {
            email: userEmail,
            status: OperationStatus.Success,
            account_type: AuthType.ServiceAccount,
          },
          totalMails - mailCountExcludingPromotions,
        )

        tracker.updateTotal(userEmail, {
          totalMail: mailCountExcludingPromotions,
          totalDrive: driveFileCount,
        })

        if (isScriptRunning) {
          Logger.info(`Updating Partial Progress for Script`)
          sendProgressToServer({
            userEmail: userEmail,
            messageCount: 0,
            attachmentCount: 0,
            failedMessages: 0,
            failedAttachments: 0,
            totalMailsToBeIngested: mailCountExcludingPromotions,
            totalMailsSkipped: totalMails - mailCountExcludingPromotions,
            insertedEventCount: 0,
            insertedContactsCount: 0,
            insertedpdfCount: 0,
            insertedDocCount: 0,
            insertedSheetCount: 0,
            insertedSlideCount: 0,
            insertedDriveFileCount: 0,
            totalDriveflesToBeIngested: driveFileCount,
            totalBlockedPdfs: 0,
          })
        }

        const servicePromises: Promise<any>[] = []
        let contactsTokenVal = ""
        let otherContactsTokenVal = ""
        let driveStartPageTokenVal = ""
        let capturedGmailHistoryId: string | undefined = undefined
        let capturedCalendarToken: string | undefined = undefined

        if (insertDriveAndContacts) {
          servicePromises.push(
            (async () => {
              const contactData = await listAllContacts(userJwtClient)
              contactsTokenVal = contactData.contactsToken
              otherContactsTokenVal = contactData.otherContactsToken
              await insertContactsToVespa(
                contactData.contacts,
                contactData.otherContacts,
                userEmail,
                tracker,
              )

              const driveStartPageTokenData =
                await userDriveClient.changes.getStartPageToken()
              if (!driveStartPageTokenData.data.startPageToken) {
                throw new Error(
                  `Could not get start page token for Drive for user ${userEmail} (jobId: ${jobId})`,
                )
              }
              driveStartPageTokenVal =
                driveStartPageTokenData.data.startPageToken

              await insertFilesForUser(
                userJwtClient,
                userEmail,
                connector!,
                tracker,
                startDate,
                endDate,
              )
              return "drive-contacts-completed"
            })(),
          )
        } else {
          servicePromises.push(Promise.resolve("drive-contacts-skipped"))
        }

        if (insertGmail) {
          servicePromises.push(
            handleGmailIngestionForServiceAccount(
              userEmail,
              serviceAccountKey,
              jobId,
              startDate,
              endDate,
            ).then((historyIdResult) => {
              // Renamed historyId to historyIdResult
              capturedGmailHistoryId = historyIdResult
              return historyIdResult
            }),
          )
        } else {
          servicePromises.push(Promise.resolve("gmail-skipped"))
        }

        if (insertCalendar) {
          servicePromises.push(
            insertCalendarEvents(
              userJwtClient,
              userEmail,
              tracker,
              startDate,
              endDate,
            ).then((result) => {
              capturedCalendarToken = result.calendarEventsToken
              return result.calendarEventsToken
            }),
          )
        } else {
          servicePromises.push(Promise.resolve("calendar-skipped"))
        }

        await Promise.all(servicePromises)

        tracker.markUserComplete(userEmail)

        return {
          email: userEmail,
          driveToken: driveStartPageTokenVal,
          contactsToken: contactsTokenVal,
          otherContactsToken: otherContactsTokenVal,
          historyId: capturedGmailHistoryId || "",
          calendarEventsToken: capturedCalendarToken || "",
        } as IngestionMetadata
      }),
    )

    const results = (await Promise.all(
      userProcessingPromises,
    )) as (IngestionMetadata | null)[]
    const successfulResults = results.filter(
      (r) => r !== null,
    ) as IngestionMetadata[]
    ingestionMetadataList.push(...successfulResults)

    if (uniqueUsersToProcess.length !== successfulResults.length) {
      Logger.info(
        `Adjusting tracker: ${uniqueUsersToProcess.length - successfulResults.length} users were skipped due to missing emails.`,
      )
    }

    // Only insert workspace users if they were successfully processed (had an email)
    const usersForWorkspaceInsert = uniqueUsersToProcess.filter((u) =>
      successfulResults.some(
        (sr) => sr.email === getValidUserEmailFromGoogleUser(u),
      ),
    )
    await insertUsersForWorkspace(usersForWorkspaceInsert)

    setTimeout(() => {
      clearInterval(interval)
    }, 8000)

    await db.transaction(async (trx) => {
      for (const meta of ingestionMetadataList) {
        // using email we will check that does the service account sync job for this
        // user alredy exist or not
        const apps = [
          { name: "Drive", app: Apps.GoogleDrive },
          { name: "Gmail", app: Apps.Gmail },
          { name: "Calendar", app: Apps.GoogleCalendar },
        ]

        const jobExists: Record<string, boolean> = {}
        for (const { name, app } of apps) {
          const jobs = await getAppSyncJobsByEmail(
            db,
            app,
            AuthType.ServiceAccount,
            meta.email,
          )
          jobExists[`${name}JobExist`] = jobs && jobs.length > 0
        }

        if (
          !jobExists.DriveJobExist &&
          insertDriveAndContacts &&
          (meta.driveToken || meta.contactsToken || meta.otherContactsToken)
        ) {
          await insertSyncJob(trx, {
            workspaceId: connector!.workspaceId,
            workspaceExternalId: connector!.workspaceExternalId,
            app: Apps.GoogleDrive,
            connectorId: connector!.id,
            authType: AuthType.ServiceAccount,
            config: {
              driveToken: meta.driveToken,
              contactsToken: meta.contactsToken,
              type: "googleDriveChangeToken",
              otherContactsToken: meta.otherContactsToken,
              lastSyncedAt: new Date().toISOString(),
            },
            email: meta.email,
            type: SyncCron.ChangeToken,
            status: SyncJobStatus.NotStarted,
          })
        }

        if (!jobExists.GmailJobExist && insertGmail && meta.historyId) {
          await insertSyncJob(trx, {
            workspaceId: connector!.workspaceId,
            workspaceExternalId: connector!.workspaceExternalId,
            app: Apps.Gmail,
            connectorId: connector!.id,
            authType: AuthType.ServiceAccount,
            config: {
              historyId: meta.historyId,
              type: "gmailChangeToken",
              lastSyncedAt: new Date().toISOString(),
            },
            email: meta.email,
            type: SyncCron.ChangeToken,
            status: SyncJobStatus.NotStarted,
          })
        }

        if (
          !jobExists.CalendarJobExist &&
          insertCalendar &&
          meta.calendarEventsToken
        ) {
          await insertSyncJob(trx, {
            workspaceId: connector!.workspaceId,
            workspaceExternalId: connector!.workspaceExternalId,
            app: Apps.GoogleCalendar,
            connectorId: connector!.id,
            authType: AuthType.ServiceAccount,
            config: {
              calendarEventsToken: meta.calendarEventsToken,
              type: "calendarEventsChangeToken",
              lastSyncedAt: new Date().toISOString(),
            },
            email: meta.email,
            type: SyncCron.ChangeToken,
            status: SyncJobStatus.NotStarted,
          })
        }
      }
    })

    const servicesProcessed: string[] = []
    if (payload.insertDriveAndContacts)
      servicesProcessed.push("Drive & Contacts")
    if (payload.insertGmail) servicesProcessed.push("Gmail")
    if (payload.insertCalendar) servicesProcessed.push("Calendar")

    Logger.info(
      `Successfully ingested additional users (jobId: ${jobId}). Processed services: ${servicesProcessed.join(
        ", ",
      )}. Sync job creation attempted.`,
    )

    if (connector.externalId) {
      sendWebsocketMessage(
        JSON.stringify({
          message: "Successfully ingested additional users.",
          progress: 100,
          userStats: tracker.getServiceAccountProgress().userStats,
          context: "ingestMore",
        }),
        connector.externalId,
      )
      closeWs(connector.externalId)
    }
  } catch (error) {
    Logger.error(
      error,
      `ServiceAccountIngestMoreUsers (jobId: ${jobId}) failed for connector ${connectorId}: ${(error as Error).message}`,
    )
    if (connector?.externalId) {
      sendWebsocketMessage(
        JSON.stringify({
          message: `Error ingesting additional users: ${getErrorMessage(error)}`,
          error: true,
          context: "ingestMore",
        }),
        connector.externalId,
      )
      closeWs(connector.externalId)
    }
  } finally {
    Logger.info(
      `Main Thread: About to delete tracker for jobId: ${jobId} in ServiceAccountIngestMoreUsers`,
    ) // ADD THIS LOG
    activeJobTrackers.delete(jobId)
    Logger.info(
      `ServiceAccountIngestMoreUsers (jobId: ${jobId}) for connector ${connectorId} finished. Tracker removed.`,
    )
  }
}
