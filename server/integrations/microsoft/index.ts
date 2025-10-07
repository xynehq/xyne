import {
  Subsystem,
  SyncCron,
  type MicrosoftServiceCredentials,
  type OAuthCredentials,
  type SaaSJob,
  type SaaSOAuthJob,
} from "@/types"
import { getConnector, getOAuthConnectorWithCredentials } from "@/db/connector"
import { v4 as uuidv4 } from "uuid"
import { insertUser, insertWithRetry } from "@/search/vespa"
import { db } from "@/db/client"
import {
  connectors,
  type SelectConnector,
  type SelectOAuthProvider,
} from "@/db/schema"
import { eq } from "drizzle-orm"
import {
  Apps,
  AuthType,
  ConnectorStatus,
  SyncJobStatus,
  DriveEntity,
} from "@/shared/types"
import { MicrosoftPeopleEntity } from "@xyne/vespa-ts/types"
import { insertSyncJob } from "@/db/syncJob"
import { getErrorMessage, hashPdfFilename } from "@/utils"
import { getLogger, getLoggerWithChild } from "@/logger"
import {
  CalendarEntity,
  eventSchema,
  type VespaFileWithDrivePermission,
  fileSchema,
  MailEntity,
  mailSchema,
} from "@xyne/vespa-ts/types"
import {
  CouldNotFinishJobSuccessfully,
  ContactListingError,
  ContactMappingError,
  ErrorInsertingDocument,
  DeleteDocumentError,
  CalendarEventsListingError,
} from "@/errors"
import fs from "node:fs"
import path from "node:path"
import { unlink } from "node:fs/promises"
import type { Document } from "@langchain/core/documents"
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf"
import { chunkDocument } from "@/chunks"
import { extractTextAndImagesWithChunksFromDocx } from "@/docxChunks"
import { StatType, Tracker } from "@/integrations/tracker"
import { getOAuthProviderByConnectorId } from "@/db/oauthProvider"
import { closeWs, sendWebsocketMessage } from "@/integrations/metricStream"
import {
  ingestionDuration,
  metadataFiles,
} from "@/metrics/google/metadata_metrics"
import {
  createMicrosoftGraphClient,
  downloadFileFromGraph,
  makeGraphApiCall,
  makeGraphApiCallWithHeaders,
  makePagedGraphApiCall,
  type MicrosoftGraphClient,
} from "./client"
import { Client } from "@microsoft/microsoft-graph-client"
import type { DriveItem } from "@microsoft/microsoft-graph-types"
import { handleOutlookIngestion } from "./outlook"
import { getUniqueEmails } from "../google"
import { htmlToText } from "html-to-text"
import type { InvokeModelResponseFilterSensitiveLog } from "@aws-sdk/client-bedrock-runtime"
import {
  discoverSharePointSites,
  discoverSiteDrives,
  processSiteDrives,
} from "./sharepoint"
import { getFilePermissions, processFileContent, loggerWithChild } from "./utils"
const Logger = getLogger(Subsystem.Integrations).child({ module: "microsoft" })

export const getTextFromEventDescription = (description: string): string => {
  return htmlToText(description, { wordwrap: 130 })
}

// Get attendees from Microsoft event
export const getAttendeesOfEvent = (allAttendees: any[]) => {
  if (allAttendees.length === 0) {
    return { attendeesInfo: [], attendeesEmails: [], attendeesNames: [] }
  }

  const attendeesInfo: { email: string; displayName: string }[] = []
  const attendeesNames: string[] = []
  const attendeesEmails: string[] = []

  for (const attendee of allAttendees) {
    if (attendee.emailAddress?.name) {
      attendeesNames.push(attendee.emailAddress.name)
    }

    if (attendee.emailAddress?.address) {
      attendeesEmails.push(attendee.emailAddress.address)
    }

    const oneAttendee = { email: "", displayName: "" }
    oneAttendee.email = attendee.emailAddress?.address ?? ""
    oneAttendee.displayName = attendee.emailAddress?.name ?? ""

    attendeesInfo.push(oneAttendee)
  }

  return { attendeesInfo, attendeesEmails, attendeesNames }
}

// Get attachments from Microsoft event
export const getAttachments = (allAttachments: any[]) => {
  if (allAttachments.length === 0) {
    return { attachmentsInfo: [], attachmentFilenames: [] }
  }

  const attachmentsInfo = []
  const attachmentFilenames = []

  for (const attachment of allAttachments) {
    attachmentFilenames.push(attachment.name ?? "")

    const oneAttachment = { fileId: "", title: "", mimeType: "", fileUrl: "" }
    oneAttachment.fileId = attachment.id ?? ""
    oneAttachment.title = attachment.name ?? ""
    oneAttachment.mimeType = attachment.contentType ?? ""
    oneAttachment.fileUrl = attachment.contentLocation ?? ""

    attachmentsInfo.push(oneAttachment)
  }

  return { attachmentsInfo, attachmentFilenames }
}

// Get event start time
export const getEventStartTime = (event: any) => {
  if (event?.start?.dateTime) {
    return {
      isDefaultStartTime: false,
      startTime: new Date(event.start.dateTime).getTime(),
    }
  } else if (event?.start?.date) {
    return {
      isDefaultStartTime: true,
      startTime: new Date(event.start.date).getTime(),
    }
  } else {
    return { isDefaultStartTime: true, startTime: new Date().getTime() }
  }
}

// Get joining link from Microsoft event
export const getJoiningLink = (event: any) => {
  const onlineMeeting = event?.onlineMeeting
  if (onlineMeeting?.joinUrl) {
    return {
      baseUrl: new URL(onlineMeeting.joinUrl).origin,
      joiningUrl: onlineMeeting.joinUrl,
    }
  }
  return {
    baseUrl: "",
    joiningUrl: "",
  }
}

// Insert calendar events from Microsoft using /me/calendar/events/delta for proper delta token
const insertCalendarEvents = async (
  client: MicrosoftGraphClient,
  userEmail: string,
  tracker: Tracker,
): Promise<{ events: any[]; calendarEventsToken: string }> => {
  let events: any[] = []
  let deltaToken: string = ""

  try {
    loggerWithChild({ email: userEmail }).info(
      `Performing initial calendar sync using /me/calendar/events/delta`,
    )

    // Use /me/calendar/events/delta to get event IDs with proper delta token
    const endpoint = `/me/calendar/events/delta?`

    let nextLink: string | undefined = endpoint

    // Process events with pagination to get event IDs
    while (nextLink) {
      const response: any = await makeGraphApiCallWithHeaders(
        client,
        nextLink,
        {
          Prefer: "odata.maxpagesize=999",
        },
      )

      if (response.value) {
        // Process event IDs from response
        for (const eventRef of response.value) {
          if (eventRef.id && !eventRef["@removed"]) {
            try {
              // Fetch full event data using /me/events/{id}
              const fullEvent = await makeGraphApiCall(
                client,
                `/me/events/${eventRef.id}?$select=id,subject,body,webLink,start,end,location,createdDateTime,lastModifiedDateTime,organizer,attendees,onlineMeeting,attachments,recurrence,isCancelled`,
              )

              if (fullEvent && fullEvent.type !== "occurrence") {
                events.push(fullEvent)
              }
            } catch (eventError) {
              loggerWithChild({ email: userEmail }).warn(
                `Could not fetch event details for ${eventRef.id}: ${eventError}`,
              )
            }
          }
        }
      }

      // Check for next page
      deltaToken = response["@odata.deltaLink"]
        ? response["@odata.deltaLink"]
        : deltaToken
      if (response["@odata.nextLink"]) {
        // More pages available, continue with next page
        nextLink = response["@odata.nextLink"]
      } else {
        // No more data
        nextLink = undefined
      }
    }
  } catch (error: any) {
    if (error?.code === "Forbidden" || error?.status === 403) {
      loggerWithChild({ email: userEmail }).warn(
        `User ${userEmail} does not have calendar access. Returning empty event set.`,
      )
      return { events: [], calendarEventsToken: "" }
    }
    throw error
  }

  loggerWithChild({ email: userEmail }).info(
    `Initial calendar sync completed with delta token: ${deltaToken ? "received" : "not received"}. Fetched ${events.length} events.`,
  )

  const confirmedEvents = events.filter((e) => !e.isCancelled)

  const totalDurationForEventIngestion = ingestionDuration.startTimer({
    file_type: CalendarEntity.Event,
    mime_type: "microsoft_calendar_events",
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
        name: event.subject ?? "",
        description: getTextFromEventDescription(event?.body?.content ?? ""),
        url: event.webLink ?? "",
        status: event.isCancelled ? "cancelled" : "confirmed",
        location: event.location?.displayName ?? "",
        createdAt: new Date(event.createdDateTime).getTime(),
        updatedAt: new Date(event.lastModifiedDateTime).getTime(),
        app: Apps.MicrosoftCalendar,
        entity: CalendarEntity.Event,
        creator: {
          email: event.organizer?.emailAddress?.address ?? "",
          displayName: event.organizer?.emailAddress?.name ?? "",
        },
        organizer: {
          email: event.organizer?.emailAddress?.address ?? "",
          displayName: event.organizer?.emailAddress?.name ?? "",
        },
        attendees: attendeesInfo,
        attendeesNames: attendeesNames,
        startTime: startTime,
        endTime: new Date(event.end?.dateTime).getTime(),
        attachmentFilenames,
        attachments: attachmentsInfo,
        recurrence: event.recurrence ? [JSON.stringify(event.recurrence)] : [],
        baseUrl,
        joiningLink: joiningUrl,
        permissions: getUniqueEmails([
          event.organizer?.emailAddress?.address ?? "",
          ...attendeesEmails,
        ]),
        cancelledInstances: [],
        defaultStartTime: isDefaultStartTime,
      }

      await insertWithRetry(eventToBeIngested, eventSchema)
      tracker.updateUserStats(userEmail, StatType.Events, 1)
    } catch (error) {
      Logger.error(`Error inserting Microsoft Event: ${event.id}`)
    }
  }

  totalDurationForEventIngestion()
  metadataFiles.inc(
    {
      file_type: CalendarEntity.Event,
      mime_type: "microsoft_calendar_events",
      status: "SUCCESS",
      email: userEmail,
    },
    events.length,
  )

  return { events, calendarEventsToken: deltaToken }
}

// List all contacts from Microsoft
export const listAllContacts = async (
  client: MicrosoftGraphClient,
): Promise<{
  contacts: any[]
  otherContacts: any[]
  contactsToken: string
  otherContactsToken: string
}> => {
  const contacts: any[] = []
  const otherContacts: any[] = []
  let contactsToken: string = ""
  let otherContactsToken: string = ""

  try {
    // Get contacts
    let nextLink: string | undefined
    do {
      const response = nextLink
        ? await makeGraphApiCall(client, nextLink)
        : await makeGraphApiCall(
            client,
            "/me/contacts?$select=id,displayName,emailAddresses,businessPhones,homePhones,mobilePhone,jobTitle,companyName,department,officeLocation,birthday,personalNotes&$top=1000",
          )

      if (response.value) {
        contacts.push(...response.value)
      }

      nextLink = response["@odata.nextLink"]
      contactsToken = response["@odata.deltaLink"] || contactsToken
    } while (nextLink)

    // For Microsoft, "other contacts" might be people from the organization
    // We'll use the same contacts for now, but this could be expanded
    otherContactsToken = contactsToken
  } catch (error) {
    throw new ContactListingError({
      message: "Could not get contacts from Microsoft Graph",
      integration: Apps.MicrosoftDrive,
      entity: MicrosoftPeopleEntity.Contacts,
    })
  }

  return {
    contacts,
    otherContacts: [], // Microsoft doesn't have the same "other contacts" concept
    contactsToken,
    otherContactsToken,
  }
}

// Insert Microsoft contact
export const insertContact = async (
  contact: any,
  entity: MicrosoftPeopleEntity,
  owner: string,
) => {
  const docId = contact.id || ""
  if (!docId) {
    loggerWithChild({ email: owner }).error(`Id does not exist for ${entity}`)
    return
  }

  const name = contact.displayName ?? ""
  const email = contact.emailAddresses?.[0]?.address ?? ""
  if (!email) {
    return
  }

  const app = Apps.MicrosoftDrive

  const photoLink = "" // Microsoft Graph would require separate API call for photo
  const aliases =
    contact.emailAddresses?.slice(1)?.map((e: any) => e.address ?? "") || []

  const orgName = contact.companyName ?? ""
  const orgJobTitle = contact.jobTitle ?? ""
  const orgDepartment = contact.department ?? ""
  const orgLocation = contact.officeLocation ?? ""
  const orgDescription = contact.personalNotes ?? ""

  const creationTime = contact.createdDateTime
    ? new Date(contact.createdDateTime).getTime()
    : Date.now()

  const birthday = contact.birthday
    ? new Date(contact.birthday).getTime()
    : undefined

  const vespaContact = {
    docId,
    name,
    email,
    app,
    entity,
    gender: "", // Microsoft Graph doesn't provide gender in basic contact info
    photoLink,
    aliases,
    urls: [], // Would need separate API call
    orgName,
    orgJobTitle,
    orgDepartment,
    orgLocation,
    orgDescription,
    creationTime,
    birthday,
    occupations: [orgJobTitle].filter(Boolean),
    userDefined: [],
    owner,
    sddocname: "user" as const,
    relevance: 1.0,
    source: "microsoft",
    documentid: docId,
  }

  await insertUser(vespaContact)
}

// Insert contacts to Vespa
const insertContactsToVespa = async (
  contacts: any[],
  otherContacts: any[],
  owner: string,
  tracker: Tracker,
): Promise<void> => {
  const contactIngestionDuration = ingestionDuration.startTimer({
    file_type: MicrosoftPeopleEntity.Contacts,
    mime_type: "microsoft_people",
    email: owner,
  })

  try {
    loggerWithChild({ email: owner }).info(`Inserting Microsoft Contacts`)
    for (const contact of contacts) {
      await insertContact(contact, MicrosoftPeopleEntity.Contacts, owner)
      tracker.updateUserStats(owner, StatType.Contacts, 1)
    }

    loggerWithChild({ email: owner }).info(`Inserting Microsoft Other Contacts`)
    for (const contact of otherContacts) {
      await insertContact(contact, MicrosoftPeopleEntity.OtherContacts, owner)
      tracker.updateUserStats(owner, StatType.Contacts, 1)
    }
  } catch (error) {
    if (error instanceof ErrorInsertingDocument) {
      loggerWithChild({ email: owner }).error(
        error,
        `Could not insert Microsoft contact: ${(error as Error).stack}`,
      )
      throw error
    } else {
      loggerWithChild({ email: owner }).error(
        error,
        `Error mapping Microsoft contact: ${error} ${(error as Error).stack}`,
        error,
      )
      throw new ContactMappingError({
        message: "Error in the catch of mapping Microsoft contact",
        integration: Apps.MicrosoftDrive,
        entity: MicrosoftPeopleEntity.Contacts,
        cause: error as Error,
      })
    }
  } finally {
    contactIngestionDuration()
    metadataFiles.inc(
      {
        file_type: MicrosoftPeopleEntity.Contacts,
        mime_type: "microsoft_people",
        email: owner,
      },
      contacts.length + otherContacts.length,
    )
  }
}

// Count OneDrive files
export async function countOneDriveFiles(
  client: MicrosoftGraphClient,
  email?: string,
  startDate?: string,
  endDate?: string,
): Promise<number> {
  loggerWithChild({ email: email || " " }).info(
    `Started Counting OneDrive Files`,
  )

  const queryParams: any = {
    $top: 1000,
    $select: "id,file,folder",
  }

  if (startDate || endDate) {
    const filters: string[] = []
    if (startDate) {
      const startDateObj = new Date(startDate)
      filters.push(`lastModifiedDateTime ge ${startDateObj.toISOString()}`)
    }
    if (endDate) {
      const endDateObj = new Date(endDate)
      endDateObj.setDate(endDateObj.getDate() + 1)
      filters.push(`lastModifiedDateTime lt ${endDateObj.toISOString()}`)
    }
    if (filters.length > 0) {
      queryParams.$filter = filters.join(" and ")
    }
  }

  try {
    const allItems = await getAllOneDriveFiles(client, queryParams, email)

    const fileCount = allItems.filter((item) => item.file).length

    loggerWithChild({ email: email || " " }).info(
      `Counted ${fileCount} OneDrive files`,
    )
    return fileCount
  } catch (error) {
    loggerWithChild({ email: email || " " }).error(
      error,
      `Error counting OneDrive files: ${(error as Error).message}`,
    )
    return 0
  }
}

// Get Outlook email counts
export async function getOutlookCounts(
  client: MicrosoftGraphClient,
  email?: string,
  startDate?: string,
  endDate?: string,
): Promise<{
  messagesTotal: number
  messagesExcludingPromotions: number
}> {
  let messagesTotal = 0
  let promotionMessages = 0

  loggerWithChild({ email: email ?? "" }).info(
    `Getting Outlook message counts for date range: ${startDate} to ${endDate}`,
  )

  try {
    const queryParams: any = {
      $top: 1000,
      $select: "id",
    }

    if (startDate || endDate) {
      const filters: string[] = []
      if (startDate) {
        const startDateObj = new Date(startDate)
        filters.push(`receivedDateTime ge ${startDateObj.toISOString()}`)
      }
      if (endDate) {
        const endDateObj = new Date(endDate)
        endDateObj.setDate(endDateObj.getDate() + 1)
        filters.push(`receivedDateTime lt ${endDateObj.toISOString()}`)
      }
      if (filters.length > 0) {
        queryParams.$filter = filters.join(" and ")
      }
    }

    // Count total messages
    let nextLink: string | undefined
    do {
      const response = nextLink
        ? await makeGraphApiCall(client, nextLink)
        : await makeGraphApiCall(
            client,
            `/me/messages?${new URLSearchParams(queryParams).toString()}`,
          )

      messagesTotal += response.value?.length || 0
      nextLink = response["@odata.nextLink"]
    } while (nextLink)

    // For promotions, we'll use a simple heuristic or skip for now
    // Microsoft doesn't have the same category system as Gmail
    promotionMessages = 0
  } catch (error) {
    loggerWithChild({ email: email ?? "" }).error(
      error,
      `Error fetching Outlook message counts: ${(error as Error).message}`,
    )
    messagesTotal = 0
  }

  const messagesExcludingPromotions = Math.max(
    0,
    messagesTotal - promotionMessages,
  )

  loggerWithChild({ email: email ?? "" }).info(
    `Outlook: Total=${messagesTotal}, Promotions=${promotionMessages}, Excl. Promo=${messagesExcludingPromotions}`,
  )

  return { messagesTotal, messagesExcludingPromotions }
}

// OneDrive file processing implementation
const insertFilesForUser = async (
  client: MicrosoftGraphClient,
  userEmail: string,
  connector: SelectConnector,
  tracker: Tracker,
  startDate?: string,
  endDate?: string,
) => {
  try {
    let processedFiles = 0

    const queryParams: any = {
      $top: 1000,
      $select:
        "id,name,size,createdDateTime,lastModifiedDateTime,webUrl,file,folder,@microsoft.graph.downloadUrl",
    }

    if (startDate || endDate) {
      const filters: string[] = []
      if (startDate) {
        const startDateObj = new Date(startDate)
        filters.push(`lastModifiedDateTime ge ${startDateObj.toISOString()}`)
      }
      if (endDate) {
        const endDateObj = new Date(endDate)
        endDateObj.setDate(endDateObj.getDate() + 1)
        filters.push(`lastModifiedDateTime lt ${endDateObj.toISOString()}`)
      }
      if (filters.length > 0) {
        queryParams.$filter = filters.join(" and ")
      }
    }

    const allFiles = await getAllOneDriveFiles(client, queryParams, userEmail)

    for (const file of allFiles) {
      try {
        if (file.id === "") {
          continue
        }
        const permissions: string[] = await getFilePermissions(client, file.id)

        const fileToBeIngested = {
          title: file.name ?? "",
          url: file.webUrl ?? "",
          app: Apps.MicrosoftDrive,
          docId: file.id,
          parentId: file.parentReference?.id ?? null,
          owner: file.createdBy?.user?.displayName ?? userEmail,
          photoLink: "",
          ownerEmail: userEmail,
          entity: DriveEntity.Misc,
          chunks: await processFileContent(client, file, userEmail),
          permissions,
          mimeType: file.file?.mimeType ?? "application/octet-stream",
          metadata: JSON.stringify({
            size: file.size,
            downloadUrl: file["@microsoft.graph.downloadUrl"],
            parentFolderType: file.parentReference?.driveType ?? "personal",
            parentId: file.parentReference?.id ?? "",
            parentPath: file.parentReference?.path ?? "/",
            siteId: file.parentReference?.siteId ?? "",
            eTag: file.eTag ?? "",
          }),
          createdAt: new Date(file.createdDateTime).getTime(),
          updatedAt: new Date(file.lastModifiedDateTime).getTime(),
        }

        //             try {
        //   const responsesDir = path.join(__dirname, "responses")
        //   if (!fs.existsSync(responsesDir)) {
        //     fs.mkdirSync(responsesDir, { recursive: true })
        //   }
        //   const filename = `one-drive.json`
        //   fs.appendFileSync(
        //     path.join(responsesDir, filename),
        //     JSON.stringify(fileToBeIngested, null, 2)
        //   )
        //   loggerWithChild({ email: userEmail }).info(
        //     `Saved calendar events response to ${filename}`
        //   )
        // } catch (saveError) {
        //   loggerWithChild({ email: userEmail }).warn(
        //     `Could not save calendar events response: ${saveError}`
        //   )
        // }

        await insertWithRetry(fileToBeIngested, fileSchema)
        tracker.updateUserStats(userEmail, StatType.Drive, 1)
        processedFiles++

        loggerWithChild({ email: userEmail }).info(
          `Processed OneDrive file: ${file.name}`,
        )
      } catch (error) {
        loggerWithChild({ email: userEmail }).error(
          error,
          `Error processing OneDrive file ${file.id}: ${(error as Error).message}`,
        )
      }
    }

    loggerWithChild({ email: userEmail }).info(
      `Processed ${processedFiles} OneDrive files`,
    )
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Could not insert OneDrive files for user: ${errorMessage} ${(error as Error).stack}`,
    )
  }
}

// Get all OneDrive files and folders using delta API
async function getAllOneDriveFiles(
  client: MicrosoftGraphClient,
  queryParams: any,
  userEmail?: string,
): Promise<any[]> {
  const logger = userEmail ? loggerWithChild({ email: userEmail }) : Logger
  let allItems: any[] = []

  try {
    // Build the delta endpoint with query parameters for initial sync
    // Select only the fields we need for Vespa insertion based on the actual API response structure
    const deltaParams = new URLSearchParams({
      $select:
        "id,name,size,createdDateTime,lastModifiedDateTime,webUrl,file,folder,parentReference,createdBy,lastModifiedBy,@microsoft.graph.downloadUrl",
      $top: (queryParams.$top || 1000).toString(),
    })

    // Add filter if provided
    if (queryParams.$filter) {
      deltaParams.set("$filter", queryParams.$filter)
    }

    let endpoint = `/me/drive/root/delta?${deltaParams.toString()}`

    logger.info(`Performing initial OneDrive sync using delta API`)

    // Process delta responses with pagination
    while (endpoint) {
      logger.info(
        `Fetching OneDrive items from: ${endpoint.substring(0, 100)}...`,
      )

      const response = await makeGraphApiCall(client, endpoint)

      if (response.value && Array.isArray(response.value)) {
        for (const item of response.value) {
          // Skip removed items (shouldn't happen in initial sync, but just in case)
          if (item["@removed"]) {
            logger.debug(`Skipping removed item: ${item.id}`)
            continue
          }

          allItems.push(item)
        }
      }

      // Check for pagination
      if (response["@odata.nextLink"]) {
        endpoint = response["@odata.nextLink"]
        logger.info(`Continuing with next page of OneDrive items`)
      } else {
        logger.info(`OneDrive initial sync complete`)
        endpoint = ""
      }
    }

    logger.info(
      `Retrieved ${allItems.length} OneDrive items (files and folders)`,
    )
    return allItems
  } catch (error) {
    logger.error(
      error,
      `Error getting OneDrive files using delta API: ${(error as Error).message}`,
    )
    throw error
  }
}

export const handleMicrosoftServiceAccountIngestion = async (
  email: string,
  connector: SelectConnector,
) => {
  const jobId = uuidv4()
  loggerWithChild({ email: email! }).info(
    `handleMicrosoftServiceAccountIngestion starting with jobId: ${jobId}`,
  )
  const tracker = new Tracker(Apps.MicrosoftSharepoint, AuthType.ServiceAccount)

  try {
    const credentials: MicrosoftServiceCredentials = JSON.parse(
      connector.credentials as string,
    )

    const graphClient = createMicrosoftGraphClient(
      credentials.access_token,
      credentials.clientId,
      credentials.clientSecret,
      undefined,
      credentials.tenantId,
    )

    const interval = setInterval(() => {
      sendWebsocketMessage(
        JSON.stringify({
          progress: tracker.getProgress(),
          userStats: tracker.getServiceAccountProgress().userStats,
          startTime: tracker.getStartTime(),
        }),
        connector!.externalId,
      )
    }, 4000)

    //Discover all SharePoint sites
    let sites = await discoverSharePointSites(graphClient, email!)

    //For each site, discover all drives
    const siteDrives = await discoverSiteDrives(graphClient, sites, email!)

    // Step 3: Process each drive and collect delta tokens
    const deltaLinks = await processSiteDrives(
      graphClient,
      siteDrives,
      email!,
      tracker,
    )

    // const driveTokens = {}
    setTimeout(() => {
      clearInterval(interval)
    }, 8000)

    //Store sync jobs with delta tokens for each drive
    await db.transaction(async (trx) => {
      await trx
        .update(connectors)
        .set({
          status: ConnectorStatus.Connected,
        })
        .where(eq(connectors.id, connector!.id))

      // Create sync job with all drive delta tokens
      await insertSyncJob(trx, {
        workspaceId: connector!.workspaceId,
        workspaceExternalId: connector!.workspaceExternalId,
        app: Apps.MicrosoftSharepoint,
        connectorId: connector!.id,
        authType: AuthType.ServiceAccount,
        config: {
          deltaLinks, // Store all drive delta Links as a record
          type: "microsoftSharepointDeltaTokens",
          lastSyncedAt: new Date().toISOString(),
        },
        email: email!,
        type: SyncCron.ChangeToken,
        status: SyncJobStatus.NotStarted,
      })

      loggerWithChild({ email: email! }).info(
        `Microsoft SharePoint service account ingestion completed (jobId: ${jobId})`,
      )
      closeWs(connector!.externalId)
    })
  } catch (error) {
    loggerWithChild({ email: email! }).error(
      error,
      `handleMicrosoftServiceAccountIngestion (jobId: ${jobId}) failed: ${(error as Error).message}`,
    )

    if (connector) {
      await db
        .update(connectors)
        .set({
          status: ConnectorStatus.Failed,
        })
        .where(eq(connectors.id, connector.id))
      closeWs(connector.externalId)
    }

    throw new CouldNotFinishJobSuccessfully({
      message: `Could not finish Microsoft SharePoint service account ingestion (jobId: ${jobId})`,
      integration: Apps.MicrosoftSharepoint,
      entity: "sites and drives",
      cause: error as Error,
    })
  }
}

// Main Microsoft OAuth ingestion handler
export const handleMicrosoftOAuthIngestion = async (data: SaaSOAuthJob) => {
  const logger = loggerWithChild({ email: data.email })
  try {
    const connector: SelectConnector = await getOAuthConnectorWithCredentials(
      db,
      data.connectorId,
    )
    const userEmail = data.email
    const oauthTokens = (connector.oauthCredentials as OAuthCredentials).data

    const providers: SelectOAuthProvider[] =
      await getOAuthProviderByConnectorId(db, data.connectorId)

    const [microsoftProvider] = providers

    const tracker = new Tracker(Apps.MicrosoftDrive, AuthType.OAuth)
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

    // Create Microsoft Graph client
    const graphClient = createMicrosoftGraphClient(
      oauthTokens.access_token,
      oauthTokens.refresh_token,
      microsoftProvider.clientId!,
      microsoftProvider.clientSecret! as string,
    )

    const [totalFiles, { messagesTotal, messagesExcludingPromotions }] =
      await Promise.all([
        countOneDriveFiles(graphClient, userEmail),
        getOutlookCounts(graphClient, userEmail),
      ])

    tracker.updateTotal(userEmail, {
      totalDrive: totalFiles,
      totalMail: messagesExcludingPromotions,
    })

    const { contacts, otherContacts, contactsToken, otherContactsToken } =
      await listAllContacts(graphClient)
    await insertContactsToVespa(contacts, otherContacts, userEmail, tracker)

    // Get initial delta token for OneDrive changes
    const driveResponse = await makeGraphApiCall(
      graphClient,
      "/me/drive/root/delta?$select=id",
    )
    const driveDeltaToken = driveResponse["@odata.deltaLink"] || ""

    const [_, outlookDeltaTokens, { calendarEventsToken }] = await Promise.all([
      insertFilesForUser(graphClient, userEmail, connector, tracker),
      handleOutlookIngestion(graphClient, userEmail, tracker),
      insertCalendarEvents(graphClient, userEmail, tracker),
    ])

    setTimeout(() => {
      clearInterval(interval)
    }, 8000)

    const changeTokens = {
      driveToken: driveDeltaToken,
      type: "microsoftDriveDeltaToken",
      contactsToken,
      lastSyncedAt: new Date().toISOString(),
    }

    await db.transaction(async (trx) => {
      await trx
        .update(connectors)
        .set({
          status: ConnectorStatus.Connected,
        })
        .where(eq(connectors.id, connector.id))

      // Create sync jobs for Microsoft services
      await insertSyncJob(trx, {
        workspaceId: connector.workspaceId,
        workspaceExternalId: connector.workspaceExternalId,
        app: Apps.MicrosoftDrive,
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
        app: Apps.MicrosoftOutlook,
        connectorId: connector.id,
        authType: AuthType.OAuth,
        config: {
          deltaToken: JSON.stringify(outlookDeltaTokens), // Backward compatibility: store as JSON string
          deltaTokens: outlookDeltaTokens, // New format: store as object
          type: "microsoftOutlookDeltaToken",
          lastSyncedAt: new Date().toISOString(),
        },
        email: userEmail,
        type: SyncCron.ChangeToken,
        status: SyncJobStatus.NotStarted,
      })

      await insertSyncJob(trx, {
        workspaceId: connector.workspaceId,
        workspaceExternalId: connector.workspaceExternalId,
        app: Apps.MicrosoftCalendar,
        connectorId: connector.id,
        authType: AuthType.OAuth,
        config: {
          calendarDeltaToken: calendarEventsToken,
          type: "microsoftCalendarDeltaToken",
          lastSyncedAt: new Date().toISOString(),
        },
        email: userEmail,
        type: SyncCron.ChangeToken,
        status: SyncJobStatus.NotStarted,
      })

      logger.info("Microsoft OAuth ingestion job completed")
      closeWs(connector.externalId)
    })
  } catch (error) {
    logger.error(
      error,
      `Could not finish Microsoft OAuth ingestion: ${(error as Error).message} ${(error as Error).stack}`,
      error,
    )

    await db
      .update(connectors)
      .set({
        status: ConnectorStatus.Failed,
      })
      .where(eq(connectors.id, data.connectorId))

    throw new CouldNotFinishJobSuccessfully({
      message: "Could not finish Microsoft OAuth ingestion",
      integration: Apps.MicrosoftDrive,
      entity: "files",
      cause: error as Error,
    })
  }
}
