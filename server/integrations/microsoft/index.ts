import {
  Subsystem,
  SyncCron,
  type OAuthCredentials,
  type SaaSOAuthJob,
} from "@/types"
import { getOAuthConnectorWithCredentials } from "@/db/connector"
import {
  insertUser,
  insertWithRetry,
} from "@/search/vespa"
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
import { MicrosoftPeopleEntity } from "@/search/types"
import {
  insertSyncJob,
} from "@/db/syncJob"
import { getErrorMessage, hashPdfFilename } from "@/utils"
import { getLogger, getLoggerWithChild } from "@/logger"
import {
  CalendarEntity,
  eventSchema,
  type VespaFileWithDrivePermission,
  fileSchema,
  MailEntity,
  mailSchema,
} from "@/search/types"
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
import {
  StatType,
  Tracker,
} from "@/integrations/tracker"
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
  makePagedGraphApiCall,
  type MicrosoftGraphClient,
} from "./client"
import type { Client } from "@microsoft/microsoft-graph-client"
import type { DriveItem } from "@microsoft/microsoft-graph-types"
import { Schema } from "zod"

const Logger = getLogger(Subsystem.Integrations).child({ module: "microsoft" })

export const loggerWithChild = getLoggerWithChild(Subsystem.Integrations, {
  module: "microsoft",
})


// Get unique emails from permissions
export const getUniqueEmails = (permissions: string[]): string[] => {
  return Array.from(new Set(permissions.filter((email) => email.trim() !== "")))
}

// Convert HTML to text 
const htmlToText = require("html-to-text")

export const getTextFromEventDescription = (description: string): string => {
  return htmlToText.convert(description, { wordwrap: 130 })
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

// Insert calendar events from Microsoft
const insertCalendarEvents = async (
  client: MicrosoftGraphClient,
  userEmail: string,
  tracker: Tracker,
  startDate?: string,
  endDate?: string,
) => {
  let events: any[] = []
  let deltaToken: string = ""

  // Build query parameters
  const queryParams: any = {
    $top: 1000,
    $select: "id,subject,body,start,end,location,createdDateTime,lastModifiedDateTime,organizer,attendees,onlineMeeting,attachments,recurrence,isCancelled",
  }

  if (startDate) {
    const startDateObj = new Date(startDate)
    queryParams.$filter = `start/dateTime ge '${startDateObj.toISOString()}'`
  }

  if (endDate) {
    const endDateObj = new Date(endDate)
    const existingFilter = queryParams.$filter || ""
    const endFilter = `end/dateTime le '${endDateObj.toISOString()}'`
    queryParams.$filter = existingFilter
      ? `${existingFilter} and ${endFilter}`
      : endFilter
  }

  try {
    const endpoint = `/me/events?${new URLSearchParams(queryParams).toString()}`
    const response: any = await makeGraphApiCall(client, endpoint)

    // Save the actual response to a file for analysis
    try {
      const responsesDir = path.join(__dirname, "responses")
      if (!fs.existsSync(responsesDir)) {
        fs.mkdirSync(responsesDir, { recursive: true })
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
      const filename = `calendar-events-${timestamp}.json`
      fs.writeFileSync(
        path.join(responsesDir, filename),
        JSON.stringify(response, null, 2)
      )
      loggerWithChild({ email: userEmail }).info(
        `Saved calendar events response to ${filename}`
      )
    } catch (saveError) {
      loggerWithChild({ email: userEmail }).warn(
        `Could not save calendar events response: ${saveError}`
      )
    }

    if (response.value) {
      events = response.value
    }

    deltaToken = response["@odata.deltaLink"] || ""
  } catch (error: any) {
    // Check if user doesn't have calendar access
    if (error?.code === "Forbidden" || error?.status === 403) {
      loggerWithChild({ email: userEmail }).warn(
        `User ${userEmail} does not have calendar access. Returning empty event set.`,
      )
      return { events: [], calendarEventsToken: "" }
    }
    throw error
  }

  if (events.length === 0) {
    return { events: [], calendarEventsToken: deltaToken }
  }

  const confirmedEvents = events.filter((e) => !e.isCancelled)
  const cancelledEvents = events.filter((e) => e.isCancelled)

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

  // Handle cancelled events (similar to Google implementation)
  for (const event of cancelledEvents) {
    // For Microsoft, we might need different logic for recurring event cancellations
    // This is a simplified version - Microsoft handles recurring events differently
    try {
      const eventId = event.id ?? ""
      // For now, we'll just log cancelled events
      loggerWithChild({ email: userEmail }).info(
        `Cancelled event found: ${eventId}`,
      )
    } catch (error) {
      loggerWithChild({ email: userEmail }).error(
        error,
        `Error handling cancelled Microsoft event ${event.id}`,
      )
    }
  }

  if (!deltaToken) {
    throw new CalendarEventsListingError({
      message: "Could not get delta token for Microsoft Calendar Events",
      integration: Apps.MicrosoftCalendar,
      entity: CalendarEntity.Event,
    })
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
        : await makeGraphApiCall(client, "/me/contacts?$select=id,displayName,emailAddresses,businessPhones,homePhones,mobilePhone,jobTitle,companyName,department,officeLocation,birthday,personalNotes&$top=1000")

      // Save the actual response to a file for analysis
      try {
        const responsesDir = path.join(__dirname, "responses")
        if (!fs.existsSync(responsesDir)) {
          fs.mkdirSync(responsesDir, { recursive: true })
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
        const filename = `contacts-${timestamp}.json`
        fs.writeFileSync(
          path.join(responsesDir, filename),
          JSON.stringify(response, null, 2)
        )
        Logger.info(`Saved contacts response to ${filename}`)
      } catch (saveError) {
        Logger.warn(`Could not save contacts response: ${saveError}`)
      }

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
  const logger = loggerWithChild({ email: email ?? "" })
  logger.info(`Started Counting OneDrive Files`)

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
    // Use the recursive function to get all files
    const allFiles = await getAllOneDriveFiles(client, queryParams, email)
    
    // Count only actual files (not folders)
    const fileCount = allFiles.filter(item => item.file).length
    
    logger.info(`Counted ${fileCount} OneDrive files`)
    return fileCount
  } catch (error) {
    logger.error(
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
        : await makeGraphApiCall(client, `/me/messages?${new URLSearchParams(queryParams).toString()}`)

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
      $select: "id,name,size,createdDateTime,lastModifiedDateTime,webUrl,file,folder,@microsoft.graph.downloadUrl",
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

    const allFiles = await getAllOneDriveFiles(client, queryParams, userEmail);
    
    // Save all retrieved files metadata to a JSON file for reference
    try {
      const responsesDir = path.join(__dirname, "responses")
      if (!fs.existsSync(responsesDir)) {
        fs.mkdirSync(responsesDir, { recursive: true })
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
      const filename = `onedrive-all-files-${timestamp}.json`
      fs.writeFileSync(
        path.join(responsesDir, filename),
        JSON.stringify({
          totalFiles: allFiles.length,
          retrievedAt: new Date().toISOString(),
          userEmail: userEmail,
          files: allFiles
        }, null, 2)
      )
      loggerWithChild({ email: userEmail }).info(
        `Saved all OneDrive files metadata to ${filename} (${allFiles.length} files)`
      )
    } catch (saveError) {
      loggerWithChild({ email: userEmail }).warn(
        `Could not save OneDrive files metadata: ${saveError}`
      )
    }
    
    for (const file of allFiles) {
      try {
        // Skip folders for now
        if (file.folder) {
          continue
        }

        // Process only files with content
        if (file.file && file.size > 0) {
          const fileToBeIngested = {
            title: file.name ?? "",
            url: file.webUrl ?? "",
            app: Apps.MicrosoftDrive,
            docId: file.id ?? "",
            parentId: file.parentFolderId ?? null, // Now includes parent folder ID from traversal
            owner: userEmail,
            photoLink: "",
            ownerEmail: userEmail,
            entity: DriveEntity.Misc,
            chunks: await processFileContent(client, file, userEmail), // For now, we'll index metadata only
            permissions: [userEmail], // Basic permission - could be enhanced
            mimeType: file.file?.mimeType ?? "application/octet-stream",
            metadata: JSON.stringify({
              size: file.size,
              downloadUrl: file["@microsoft.graph.downloadUrl"],
              folderPath: file.parentFolderPath ?? "/", // Include the full folder path
              parentFolderId: file.parentFolderId ?? null, // Include parent folder ID in metadata
            }),
            createdAt: new Date(file.createdDateTime).getTime(),
            updatedAt: new Date(file.lastModifiedDateTime).getTime(),
          }

          await insertWithRetry(fileToBeIngested, fileSchema)
          tracker.updateUserStats(userEmail, StatType.Drive, 1)
          processedFiles++

          loggerWithChild({ email: userEmail }).info(
            `Processed OneDrive file: ${file.name}`,
          )
        }
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

// Recursive function to get all OneDrive files with pagination support
const getAllOneDriveFiles = async (
  client: MicrosoftGraphClient,
  queryParams: any,
  userEmail?: string,
  folderId: string = 'root',
  folderPath: string = '/',
  parentFolderId?: string,
): Promise<any[]> => {
  const logger = userEmail ? loggerWithChild({ email: userEmail }) : Logger
  
  try {
    // Fix the typo: "chidren" should be "children"
    const baseUrl = folderId === 'root' 
      ? `/me/drive/root/children`
      : `/me/drive/items/${folderId}/children`
    
    const url = `${baseUrl}?${new URLSearchParams(queryParams).toString()}`
    
    logger.info(`Fetching files from folder: ${folderPath} (ID: ${folderId})`)
    
    // Get all items in current folder with pagination
    const items = await makePagedGraphApiCall(client, url)
    
    let allFiles: any[] = []
    
    for (const item of items) {
      if (item.folder) {
        // If it's a folder, recursively get files from it
        logger.info(`Recursively processing folder: ${item.name}`)
        try {
          const subFolderFiles = await getAllOneDriveFiles(
            client,
            queryParams,
            userEmail,
            item.id,
            `${folderPath}${item.name}/`,
            item.id // Pass the current folder ID as parent for its children
          )
          allFiles.push(...subFolderFiles)
        } catch (error) {
          logger.warn(`Failed to process subfolder ${item.name}: ${(error as Error).message}`)
          // Continue processing other folders even if one fails
        }
      } else if (item.file) {
        // If it's a file, add it to our collection with parent information
        allFiles.push({
          ...item,
          folderPath: folderPath,
          parentFolderId: folderId === 'root' ? null : folderId, // Track the immediate parent folder ID
          parentFolderPath: folderPath, // Track the full parent folder path
        })
      }
    }
    
    logger.info(`Retrieved ${allFiles.length} files from ${folderPath}`)
    return allFiles
    
  } catch (error) {
    logger.error(`Error getting files from folder ${folderPath}: ${(error as Error).message}`)
    throw error
  }
}


// Outlook email ingestion implementation
const handleOutlookIngestion = async (
  client: MicrosoftGraphClient,
  userEmail: string,
  tracker: Tracker,
  startDate?: string,
  endDate?: string,
): Promise<string> => {
  try {
    let totalMails = 0
    let deltaToken = ""

    const queryParams: any = {
      $top: 1000,
      $select: "id,subject,body,receivedDateTime,sentDateTime,from,toRecipients,ccRecipients,bccRecipients,hasAttachments,internetMessageId,conversationId",
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

    let nextLink: string | undefined
    do {
      const response = nextLink
        ? await makeGraphApiCall(client, nextLink)
        : await makeGraphApiCall(client, `/me/messages?${new URLSearchParams(queryParams).toString()}`)

      // Save the actual response to a file for analysis
      try {
        const responsesDir = path.join(__dirname, "responses")
        if (!fs.existsSync(responsesDir)) {
          fs.mkdirSync(responsesDir, { recursive: true })
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
        const filename = `outlook-messages-${timestamp}.json`
        fs.writeFileSync(
          path.join(responsesDir, filename),
          JSON.stringify(response, null, 2)
        )
        loggerWithChild({ email: userEmail }).info(
          `Saved Outlook messages response to ${filename}`
        )
      } catch (saveError) {
        loggerWithChild({ email: userEmail }).warn(
          `Could not save Outlook messages response: ${saveError}`
        )
      }

      if (response.value) {
        for (const message of response.value) {
          try {
            const mailData = {
              docId: message.id ?? "",
              threadId: message.conversationId ?? "",
              mailId: message.internetMessageId ?? message.id ?? "",
              subject: message.subject ?? "",
              chunks: message.body?.content
                ? chunkDocument(getTextFromEventDescription(message.body.content)).map(c => c.chunk)
                : [],
              timestamp: new Date(message.receivedDateTime || message.sentDateTime).getTime(),
              app: Apps.MicrosoftOutlook,
              userMap: { [userEmail]: message.id },
              entity: MailEntity.Email,
              permissions: [
                message.from?.emailAddress?.address,
                ...(message.toRecipients?.map((r: any) => r.emailAddress?.address) || []),
                ...(message.ccRecipients?.map((r: any) => r.emailAddress?.address) || []),
                ...(message.bccRecipients?.map((r: any) => r.emailAddress?.address) || []),
              ].filter(Boolean),
              from: message.from?.emailAddress?.address ?? "",
              to: message.toRecipients?.map((r: any) => r.emailAddress?.address) || [],
              cc: message.ccRecipients?.map((r: any) => r.emailAddress?.address) || [],
              bcc: message.bccRecipients?.map((r: any) => r.emailAddress?.address) || [],
              mimeType: "text/html",
              attachmentFilenames: [], // Could be enhanced to get attachment info
              attachments: [],
              labels: [],
            }

            await insertWithRetry(mailData, mailSchema)
            tracker.updateUserStats(userEmail, StatType.Gmail, 1)
            totalMails++

            loggerWithChild({ email: userEmail }).info(
              `Processed Outlook email: ${message.subject}`,
            )
          } catch (error) {
            loggerWithChild({ email: userEmail }).error(
              error,
              `Error processing Outlook message ${message.id}: ${(error as Error).message}`,
            )
          }
        }
      }

      nextLink = response["@odata.nextLink"]
      deltaToken = response["@odata.deltaLink"] || deltaToken
    } while (nextLink)

    loggerWithChild({ email: userEmail }).info(
      `Processed ${totalMails} Outlook emails`,
    )

    return deltaToken || "outlook-delta-token"
  } catch (error) {
    loggerWithChild({ email: userEmail }).error(
      error,
      `Error in Outlook email ingestion: ${(error as Error).message}`,
    )
    return "outlook-delta-token-error"
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
      microsoftProvider.clientSecret!,
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
    const driveResponse = await makeGraphApiCall(graphClient, "/me/drive/root/delta?$select=id")
    const driveDeltaToken = driveResponse["@odata.deltaLink"] || ""

    const [_, outlookDeltaToken, { calendarEventsToken }] = await Promise.all([
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
          deltaToken: outlookDeltaToken,
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

// Download directory setup 
export const downloadDir = path.resolve(__dirname, "../../downloads")

if (process.env.NODE_ENV !== "production") {
  const init = () => {
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true })
    }
  }
  init()
}

// Helper function to delete files 
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
      integration: Apps.MicrosoftDrive,
      entity: DriveEntity.PDF,
    })
  }
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



// Process Microsoft PDF files (similar to googlePDFsVespa)
async function processMicrosoftPDFs(
  graphClient: Client,
  pdfFiles: DriveItem[],
  userEmail: string
): Promise<VespaFileWithDrivePermission[]> {
  const results: VespaFileWithDrivePermission[] = []
  
  for (const file of pdfFiles) {
    try {
      // Download PDF content
      const pdfBuffer = await downloadFileFromGraph(graphClient, file.id!)
      
      // Save temporarily (reuse Google's download directory pattern)
      const pdfFileName = `${hashPdfFilename(`${userEmail}_${file.id}_${file.name}`)}.pdf`
      const pdfPath = `${downloadDir}/${pdfFileName}`
      
      // Write buffer to file
      await fs.promises.writeFile(pdfPath, pdfBuffer)
      
      // Use existing PDF processing utilities
      const docs = await safeLoadPDF(pdfPath)
      if (!docs || docs.length === 0) {
        await deleteDocument(pdfPath)
        continue
      }
      
      // Use existing chunking utilities
      const chunks = docs.flatMap((doc: Document) => chunkDocument(doc.pageContent))
      
      // Cleanup
      await deleteDocument(pdfPath)
      
      // Create Vespa document structure
      results.push({
        title: file.name!,
        url: file.webUrl ?? "",
        app: Apps.MicrosoftDrive,
        docId: file.id!,
        parentId: file.parentReference?.id ?? null,
        owner: "", // Extract from file.createdBy if available
        photoLink: "",
        ownerEmail: userEmail,
        entity: DriveEntity.PDF,
        chunks: chunks.map((c: any) => c.chunk),
        permissions: [], // Process file.permissions if available
        mimeType: file.file?.mimeType ?? "",
        metadata: JSON.stringify({ 
          parentPath: file.parentReference?.path,
          size: file.size 
        }),
        createdAt: new Date(file.createdDateTime!).getTime(),
        updatedAt: new Date(file.lastModifiedDateTime!).getTime(),
      })
    } catch (error) {
      console.error(`Error processing PDF ${file.name}:`, error)
      continue
    }
  }
  
  return results
}

// Process Microsoft Word documents
async function processMicrosoftWord(
  graphClient: Client,
  wordFiles: DriveItem[],
  userEmail: string
): Promise<VespaFileWithDrivePermission[]> {
  const results: VespaFileWithDrivePermission[] = []
  
  for (const file of wordFiles) {
    try {
      // Download DOCX content
      const docxBuffer = await downloadFileFromGraph(graphClient, file.id!)
      
      // Use existing DOCX processing utilities from server/docxChunks.ts
      const extractedContent = await extractTextAndImagesWithChunksFromDocx(docxBuffer)
      
      results.push({
        title: file.name!,
        url: file.webUrl ?? "",
        app: Apps.MicrosoftDrive,
        docId: file.id!,
        parentId: file.parentReference?.id ?? null,
        owner: "",
        photoLink: "",
        ownerEmail: userEmail,
        entity: DriveEntity.Docs, // Reuse Google's entity types
        chunks: extractedContent.text_chunks || [], // Use text_chunks property
        permissions: [],
        mimeType: file.file?.mimeType ?? "",
        metadata: JSON.stringify({ 
          parentPath: file.parentReference?.path,
          size: file.size,
          images: extractedContent.image_chunks?.length || 0 // Use image_chunks property
        }),
        createdAt: new Date(file.createdDateTime!).getTime(),
        updatedAt: new Date(file.lastModifiedDateTime!).getTime(),
      })
    } catch (error) {
      console.error(`Error processing Word document ${file.name}:`, error)
      continue
    }
  }
  
  return results
}

// Process Microsoft Excel files
async function processMicrosoftExcel(
  graphClient: Client,
  excelFiles: DriveItem[],
  userEmail: string
): Promise<VespaFileWithDrivePermission[]> {
  const results: VespaFileWithDrivePermission[] = []
  
  for (const file of excelFiles) {
    try {
      // Use Microsoft Graph API to get workbook data
      const workbook = await graphClient
        .api(`/me/drive/items/${file.id}/workbook/worksheets`)
        .get()
      
      const chunks: string[] = []
      
      for (const worksheet of workbook.value) {
        try {
          // Get worksheet data
          const worksheetData = await graphClient
            .api(`/me/drive/items/${file.id}/workbook/worksheets/${worksheet.id}/usedRange`)
            .get()
          
          if (worksheetData.values) {
            // Process similar to Google Sheets - filter textual content
            const textualContent = worksheetData.values
              .flat()
              .filter((cell: any) => cell && typeof cell === 'string' && isNaN(Number(cell)))
              .join(' ')
            
            if (textualContent.length > 0) {
              const worksheetChunks = chunkDocument(textualContent)
              chunks.push(...worksheetChunks.map((c: any) => c.chunk))
            }
          }
        } catch (worksheetError) {
          console.error(`Error processing worksheet ${worksheet.name}:`, worksheetError)
          continue
        }
      }
      
      results.push({
        title: file.name!,
        url: file.webUrl ?? "",
        app: Apps.MicrosoftDrive,
        docId: file.id!,
        parentId: file.parentReference?.id ?? null,
        owner: "",
        photoLink: "",
        ownerEmail: userEmail,
        entity: DriveEntity.Sheets,
        chunks,
        permissions: [],
        mimeType: file.file?.mimeType ?? "",
        metadata: JSON.stringify({ 
          parentPath: file.parentReference?.path,
          size: file.size,
          worksheetCount: workbook.value?.length || 0
        }),
        createdAt: new Date(file.createdDateTime!).getTime(),
        updatedAt: new Date(file.lastModifiedDateTime!).getTime(),
      })
    } catch (error) {
      console.error(`Error processing Excel file ${file.name}:`, error)
      continue
    }
  }
  
  return results
}


async function processFileContent(
  graphClient: MicrosoftGraphClient,
  file: DriveItem,
  userEmail: string
): Promise<string[]> {
  const mimeType = file.file?.mimeType;
  
  try {
    switch (mimeType) {
      case 'application/pdf':
        const pdfResults = await processMicrosoftPDFs(graphClient.client, [file], userEmail);
        return pdfResults[0]?.chunks || [];
        
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        const wordResults = await processMicrosoftWord(graphClient.client, [file], userEmail);
        return wordResults[0]?.chunks || [];
        
      case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        const excelResults = await processMicrosoftExcel(graphClient.client, [file], userEmail);
        return excelResults[0]?.chunks || [];
        
      default:
        // For unsupported file types, return empty chunks (metadata only)
        return [];
    }
  } catch (error) {
    console.error(`Error processing file content for ${file.name}:`, error);
    return []; // Fallback to metadata only on error
  }
}
