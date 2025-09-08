import {
  Subsystem,
  SyncCron,
  type OAuthCredentials,
  type SyncConfig,
} from "@/types"
import PgBoss from "pg-boss"
import { getOAuthConnectorWithCredentials } from "@/db/connector"
import {
  DeleteDocument,
  getDocumentOrNull,
  insertWithRetry,
  UpdateDocumentPermissions,
  UpdateEventCancelledInstances,
  IfMailDocExist,
  insert,
} from "@/search/vespa"
import { db } from "@/db/client"
import { Apps, AuthType, SyncJobStatus, DriveEntity } from "@/shared/types"
import {
  MicrosoftPeopleEntity,
  type VespaFileWithDrivePermission,
} from "@/search/types"
import { getAppSyncJobs, updateSyncJob } from "@/db/syncJob"
import { getUserById } from "@/db/user"
import { insertSyncHistory } from "@/db/syncHistory"
import { getErrorMessage, retryWithBackoff } from "@/utils"
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
  createMicrosoftGraphClient,
  downloadFileFromGraph,
  makeBetaGraphApiCall,
  makeGraphApiCall,
  makePagedGraphApiCall,
  type MicrosoftGraphClient,
} from "./client"
import {
  getTextFromEventDescription,
  getAttendeesOfEvent,
  getAttachments,
  getEventStartTime,
  getJoiningLink,
  insertContact,
  loggerWithChild,
} from "./index"
import { MAX_ONEDRIVE_FILE_SIZE, skipMailExistCheck } from "./config"
import { microsoftMimeTypeMap, type OneDriveFile } from "./utils"
import { chunkDocument } from "@/chunks"
import fs from "node:fs/promises"
import path from "path"
import os from "os"
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf"
import type { Document } from "@langchain/core/documents"
import { extractTextAndImagesWithChunksFromDocx } from "@/docxChunks"
import { processSpreadsheetFileWithSheetInfo } from "./attachment-utils"
import { discoverMailFolders } from "./outlook"
import { getUniqueEmails } from "../google"
import { deleteWholeSpreadsheet } from "../google/sync"
import { DriveMime } from "../google/utils"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "microsoft-sync",
})

// Microsoft-specific change token types
type MicrosoftDriveChangeToken = {
  type: "microsoftDriveDeltaToken"
  driveToken: string
  contactsToken: string
  lastSyncedAt: Date
}

type MicrosoftOutlookChangeToken = {
  type: "microsoftOutlookDeltaToken"
  deltaToken?: string // Backward compatibility
  deltaTokens?: Record<string, string> // New multi-folder approach
  lastSyncedAt: Date
}

type MicrosoftCalendarChangeToken = {
  type: "microsoftCalendarDeltaToken"
  calendarDeltaToken: string
  lastSyncedAt: Date
}

// TODO: change summary to json
// and store all the structured details
type ChangeStats = {
  added: number
  removed: number
  updated: number
  summary: string
}

// Helper function to create new stats
const newStats = (): ChangeStats => {
  return {
    added: 0,
    removed: 0,
    updated: 0,
    summary: "",
  }
}

// Helper function to merge stats
const mergeStats = (prev: ChangeStats, current: ChangeStats): ChangeStats => {
  prev.added += current.added
  prev.updated += current.updated
  prev.removed += current.removed
  prev.summary += `\n${current.summary}`
  return prev
}

export const getOneDriveDelta = async (
  graphClient: MicrosoftGraphClient,
  deltaTokenUrl?: string,
): Promise<{
  changes: OneDriveFile[]
  nextDeltaTokenUrl: string | null
} | null> => {
  try {
    let endpoint =
      deltaTokenUrl && deltaTokenUrl.startsWith("http")
        ? deltaTokenUrl
        : "/me/drive/root/delta" +
          (deltaTokenUrl ? `?token=${deltaTokenUrl}` : "")

    const changes: OneDriveFile[] = []
    let nextDeltaTokenUrl: string | null = null

    while (endpoint) {
      const response = await retryWithBackoff(
        () => makeGraphApiCall(graphClient, endpoint),
        `Fetching OneDrive delta changes`,
        Apps.MicrosoftDrive,
      )
      if (Array.isArray(response.value)) {
        changes.push(...response.value)
      }
      if (response["@odata.nextLink"]) {
        endpoint = response["@odata.nextLink"]
      } else {
        nextDeltaTokenUrl = response["@odata.deltaLink"] ?? null
        break
      }
    }
    return { changes, nextDeltaTokenUrl }
  } catch (error: unknown) {
    Logger.error(
      error,
      `Error fetching OneDrive delta changes, but continuing sync engine execution.`,
    )
    return null
  }
}

// Convert OneDrive file to Vespa format
const oneDriveFileToVespa = async (
  file: OneDriveFile,
  userEmail: string,
): Promise<VespaFileWithDrivePermission | null> => {
  try {
    const entity = file.file?.mimeType
      ? (microsoftMimeTypeMap[file.file.mimeType] ?? DriveEntity.Misc)
      : file.folder
        ? DriveEntity.Folder
        : DriveEntity.Misc

    // For folders, we don't process content
    if (entity === DriveEntity.Folder) {
      return {
        title: file.name,
        url: file.webUrl ?? "",
        app: Apps.MicrosoftDrive,
        docId: file.id,
        parentId: file.parentReference?.id ?? null,
        entity,
        chunks: [],
        owner: file.createdBy?.user?.displayName ?? "",
        photoLink: "",
        ownerEmail: file.createdBy?.user?.email ?? userEmail,
        permissions: [userEmail], // For now, just the user's email
        mimeType: file.file?.mimeType ?? "",
        metadata: JSON.stringify({
          parentPath: file.parentReference?.path ?? "",
          parentName: file.parentReference?.name ?? "",
        }),
        createdAt: new Date(file.createdDateTime).getTime(),
        updatedAt: new Date(file.lastModifiedDateTime).getTime(),
      }
    }

    return {
      title: file.name,
      url: file.webUrl ?? "",
      app: Apps.MicrosoftDrive,
      docId: file.id,
      parentId: file.parentReference?.id ?? null,
      entity,
      chunks: [], // Will be populated by content extraction
      owner: file.createdBy?.user?.displayName ?? "",
      photoLink: "",
      ownerEmail: file.createdBy?.user?.email ?? userEmail,
      permissions: [userEmail], // For now, just the user's email
      mimeType: file.file?.mimeType ?? "",
      metadata: JSON.stringify({
        parentPath: file.parentReference?.path ?? "",
        parentName: file.parentReference?.name ?? "",
        size: file.size ?? 0,
      }),
      createdAt: new Date(file.createdDateTime).getTime(),
      updatedAt: new Date(file.lastModifiedDateTime).getTime(),
    }
  } catch (error) {
    Logger.error(
      error,
      `Error converting OneDrive file ${file.id} to Vespa format`,
    )
    return null
  }
}

// Extract content from OneDrive files
const extractOneDriveFileContent = async (
  graphClient: MicrosoftGraphClient,
  file: OneDriveFile,
): Promise<string[]> => {
  try {
    // Skip large files
    const fileSizeInMB = (file.size || 0) / (1024 * 1024)
    if (fileSizeInMB > MAX_ONEDRIVE_FILE_SIZE) {
      Logger.warn(
        `Skipping file ${file.name} as it's larger than ${MAX_ONEDRIVE_FILE_SIZE}MB`,
      )
      return []
    }

    // Only extract content from supported file types
    const mimeType = file.file?.mimeType
    if (!mimeType) return []

    // For PDF files, download and extract text
    if (mimeType === "application/pdf") {
      return await extractPDFContent(graphClient, file)
    }

    // For DOCX files, download and extract using docxChunks helper
    if (
      mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      try {
        Logger.info(`Processing DOCX file: ${file.name}`)
        const fileBuffer = await downloadFileFromGraph(
          graphClient.client,
          file.id,
        )
        const docxResult = await extractTextAndImagesWithChunksFromDocx(
          new Uint8Array(fileBuffer),
          file.id,
          false, // Don't extract images for OneDrive sync
        )
        return docxResult.text_chunks.filter((chunk) => chunk.trim())
      } catch (error) {
        Logger.error(error, `Error processing DOCX file ${file.name}`)
        // Fall back to Graph API text extraction
      }
    }

    // For XLSX files, download and extract using spreadsheet helper
    if (
      mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      try {
        Logger.info(`Processing XLSX file: ${file.name}`)
        const fileBuffer = await downloadFileFromGraph(
          graphClient.client,
          file.id,
        )
        const sheetsData = await processSpreadsheetFileWithSheetInfo(
          fileBuffer,
          file.name,
        )

        // Combine all sheet chunks into a single array
        const allChunks: string[] = []
        for (const sheet of sheetsData) {
          // Add sheet name as a header if there are multiple sheets
          if (sheetsData.length > 1) {
            allChunks.push(`Sheet: ${sheet.sheetName}`)
          }
          allChunks.push(...sheet.chunks)
        }

        return allChunks.filter((chunk) => chunk.trim())
      } catch (error) {
        Logger.error(error, `Error processing XLSX file ${file.name}`)
        // Fall back to Graph API text extraction
      }
    }

    // For Office documents, try to get content via Graph API
    if (
      mimeType.includes("officedocument") ||
      mimeType === "text/plain" ||
      mimeType === "text/csv"
    ) {
      try {
        // Try to get the content as text
        const contentResponse = await graphClient.client
          .api(`/me/drive/items/${file.id}/content`)
          .header("Accept", "text/plain")
          .get()

        if (typeof contentResponse === "string") {
          return chunkDocument(contentResponse).map((chunk) => chunk.chunk)
        }
      } catch (error) {
        Logger.warn(
          `Could not extract text content from ${file.name}: ${error}`,
        )
      }
    }

    return []
  } catch (error) {
    Logger.error(
      error,
      `Error extracting content from OneDrive file ${file.id}`,
    )
    return []
  }
}

// Extract PDF content
const extractPDFContent = async (
  graphClient: MicrosoftGraphClient,
  file: OneDriveFile,
): Promise<string[]> => {
  const tempDir = os.tmpdir()
  const tempFilePath = path.join(tempDir, `${file.id}.pdf`)

  try {
    // Download the PDF file
    const fileBuffer = await downloadFileFromGraph(graphClient.client, file.id)
    await fs.writeFile(tempFilePath, new Uint8Array(fileBuffer))

    // Extract text using PDFLoader
    const loader = new PDFLoader(tempFilePath)
    const docs: Document[] = await loader.load()

    if (!docs || docs.length === 0) {
      Logger.warn(`Could not extract content from PDF: ${file.name}`)
      return []
    }

    const chunks = docs.flatMap((doc) => chunkDocument(doc.pageContent))
    return chunks.map((chunk) => chunk.chunk)
  } catch (error) {
    Logger.error(error, `Error extracting PDF content from ${file.name}`)
    return []
  } finally {
    // Clean up temp file
    try {
      await fs.unlink(tempFilePath)
    } catch (cleanupError) {
      Logger.warn(`Could not clean up temp file ${tempFilePath}`)
    }
  }
}

// Handle individual OneDrive file change
export const handleOneDriveChange = async (
  change: OneDriveFile,
  graphClient: MicrosoftGraphClient,
  userEmail: string,
): Promise<ChangeStats> => {
  const stats = newStats()
  const docId = change.id

  // Handle deleted files
  if (change.deleted) {
    try {
      const doc = await getDocumentOrSpreadsheet(docId)
      if (doc) {
        // Check if its spreadsheet
        if ((doc?.fields as VespaFile).mimeType === DriveMime.Sheets) {
          await deleteWholeSpreadsheet(
            doc?.fields as VespaFile,
            docId,
            stats,
            userEmail,
          )
        } else {
          const permissions =
            (doc.fields as VespaFileWithDrivePermission)?.permissions ?? []
          if (permissions.length === 1) {
            // Remove the document entirely
            if (permissions[0] === userEmail) {
              await DeleteDocument(docId, fileSchema)
              stats.removed += 1
              stats.summary += `${docId} removed\n`
            } else {
              throw new Error(
                "We got a change for us that we didn't have access to in Vespa",
              )
            }
          } else {
            // Remove our user's permission from the document
            const newPermissions = permissions.filter(
              (v) => v && v !== userEmail,
            )
            await UpdateDocumentPermissions(fileSchema, docId, newPermissions)
            stats.updated += 1
            stats.summary += `user lost permission for doc: ${docId}\n`
          }
        }
      } else {
        Logger.error(`No document with docId ${docId} found to delete in Vespa`)
      }
    } catch (err) {
      Logger.error(
        err,
        `Failed to delete document in Vespa: ${err}, but continuing sync engine execution.`,
      )
    }
    return stats
  }
  // Handle file additions/updates
  try {
    // Check if document already exists
    const existingDoc = await getDocumentOrNull(fileSchema, docId)
    if (existingDoc) {
      stats.updated += 1
    } else {
      stats.added += 1
    }

    // Convert to Vespa format
    let vespaData = await oneDriveFileToVespa(change, userEmail)
    if (!vespaData) {
      Logger.error(`Could not convert OneDrive file ${docId} to Vespa format`)
      return stats
    }

    // Extract content for supported file types
    if (change.file && !change.folder) {
      const chunks = await extractOneDriveFileContent(graphClient, change)
      vespaData.chunks = chunks
    }

    // Insert into Vespa
    await insertWithRetry(vespaData, fileSchema)

    if (existingDoc) {
      stats.summary += `updated file ${docId}\n`
    } else {
      stats.summary += `added new file ${docId}\n`
    }
  } catch (err) {
    Logger.error(
      err,
      `Couldn't add or update document with docId ${docId}, but continuing sync engine execution.`,
    )
  }

  return stats
}

// Get document or spreadsheet (similar to Google implementation)
export const getDocumentOrSpreadsheet = async (docId: string) => {
  try {
    const doc = await getDocumentOrNull(fileSchema, docId)
    if (!doc) {
      Logger.error(
        `Found no document with ${docId}, checking for spreadsheet with ${docId}_0`,
      )
      const sheetsForSpreadSheet = await getDocumentOrNull(
        fileSchema,
        `${docId}_0`,
      )
      return sheetsForSpreadSheet
    }
    return doc
  } catch (err) {
    Logger.error(err, `Error getting document`)
    throw err
  }
}

// Discover current folders and detect changes
const handleMicrosoftFolderChanges = async (
  client: MicrosoftGraphClient,
  userEmail: string,
  existingFolders: Record<string, string>,
): Promise<{
  currentFolders: Array<{ name: string; id: string; endpoint: string }>
  newFolders: Array<{ name: string; id: string; endpoint: string }>
  deletedFolderIds: string[]
}> => {
  try {
    const currentFolders = await discoverMailFolders(client, userEmail)

    const currentFolderIds = new Set(currentFolders.map((f) => f.id))
    const existingFolderIds = new Set(Object.keys(existingFolders))

    // Find new folders (in current but not in existing)
    const newFolders = currentFolders.filter(
      (f) => !existingFolderIds.has(f.id),
    )

    // Find deleted folders (in existing but not in current)
    const deletedFolderIds = Array.from(existingFolderIds).filter(
      (id) => !currentFolderIds.has(id),
    )

    loggerWithChild({ email: userEmail }).info(
      `Folder changes detected: ${newFolders.length} new, ${deletedFolderIds.length} deleted`,
    )

    return { currentFolders, newFolders, deletedFolderIds }
  } catch (error) {
    Logger.error(error, `Error discovering folder changes: ${error}`)
    return { currentFolders: [], newFolders: [], deletedFolderIds: [] }
  }
}

// Handle Outlook changes using multi-folder delta tokens
const handleOutlookChanges = async (
  client: MicrosoftGraphClient,
  config: MicrosoftOutlookChangeToken,
  userEmail: string,
): Promise<{
  newDeltaTokens: Record<string, string>
  stats: ChangeStats
  changesExist: boolean
}> => {
  const stats = newStats()
  let changesExist = false
  let newDeltaTokens: Record<string, string> = {}

  try {
    // Handle backward compatibility
    let currentDeltaTokens: Record<string, string> = {}

    if (config.deltaTokens) {
      // New format: use deltaTokens object
      currentDeltaTokens = config.deltaTokens
    } else if (config.deltaToken) {
      // Backward compatibility: parse JSON string
      try {
        currentDeltaTokens = JSON.parse(config.deltaToken)
      } catch {
        // If parsing fails, treat as empty (will trigger folder discovery)
        currentDeltaTokens = {}
      }
    }

    // Discover folder changes
    const { currentFolders, newFolders, deletedFolderIds } =
      await handleMicrosoftFolderChanges(client, userEmail, currentDeltaTokens)

    // Handle deleted folders
    if (deletedFolderIds.length > 0) {
      stats.summary += `Detected ${deletedFolderIds.length} deleted folders: ${deletedFolderIds.join(", ")}\n`
      changesExist = true

      // Remove delta tokens for deleted folders
      for (const folderId of deletedFolderIds) {
        try {
          loggerWithChild({ email: userEmail }).info(
            `Removing delta token for deleted folder: ${folderId}`,
          )

          // Remove delta token for deleted folder
          delete currentDeltaTokens[folderId]

          stats.summary += `Removed delta token for deleted folder ${folderId}\n`
        } catch (error) {
          Logger.error(
            error,
            `Error removing delta token for deleted folder ${folderId}: ${error}`,
          )
          stats.summary += `Error removing delta token for deleted folder ${folderId}: ${error}\n`
        }
      }
    }

    // Handle new folders
    if (newFolders.length > 0) {
      stats.summary += `Detected ${newFolders.length} new folders: ${newFolders.map((f) => f.name).join(", ")}\n`
      changesExist = true
      // New folders will get delta tokens when we process them
    }

    // Process delta changes for each folder
    for (const folder of currentFolders) {
      try {
        const deltaToken = currentDeltaTokens[folder.id]
        let endpoint: string

        let search: string
        if (deltaToken && deltaToken.startsWith("http")) {
          // Use existing delta token URL
          const url = new URL(deltaToken)
          endpoint = folder.endpoint
          search = url.search
        } else {
          // Start fresh delta sync for this folder
          endpoint = folder.endpoint
          search =
            "?$top=100&$select=id,subject,body,receivedDateTime,sentDateTime,from,toRecipients,ccRecipients,bccRecipients,hasAttachments,internetMessageId,conversationId"
        }
        // Process all pages of results for this folder
        let nextLink: string | null = endpoint + search
        let folderDeltaToken: string | undefined
        let allMessages: any[] = []

        // Loop through all pages until no more data
        while (nextLink) {
          const response = await makeBetaGraphApiCall(client, nextLink)

          // Collect all messages from this page
          if (response.value && response.value.length > 0) {
            allMessages.push(...response.value)
          }

          // Update the delta token and next link
          folderDeltaToken =
            response["@odata.deltaLink"] || response["@odata.nextLink"]

          // If we have a deltaLink, we're done with pagination
          if (response["@odata.deltaLink"]) {
            nextLink = null
          } else if (response["@odata.nextLink"]) {
            // Continue with next page
            nextLink = response["@odata.nextLink"]
          } else {
            // No more pages
            nextLink = null
          }
        }

        if (folderDeltaToken) {
          newDeltaTokens[folder.id] = folderDeltaToken
        }

        // Process all messages collected from all pages
        if (allMessages.length > 0) {
          let folderStats = newStats()

          for (const message of allMessages) {
            try {
              // Handle all messages in regular folders (new/updated)
              // Deletions are handled separately by DeletedItems folder processing
              const { parseMail } = await import("./outlook")
              const { mailData } = await parseMail(message, client, userEmail)

              // Check if message already exists
              const existingMail = await getDocumentOrNull(
                mailSchema,
                mailData.docId,
              )

              await insertWithRetry(mailData, mailSchema)

              if (existingMail) {
                folderStats.updated += 1
                folderStats.summary += `Updated message ${mailData.docId} in ${folder.name}\n`
              } else {
                folderStats.added += 1
                folderStats.summary += `Added message ${mailData.docId} in ${folder.name}\n`
              }
            } catch (error) {
              Logger.error(
                error,
                `Error processing message in folder ${folder.name}: ${error}`,
              )
            }
          }

          // Merge folder stats into overall stats
          stats.added += folderStats.added
          stats.updated += folderStats.updated
          stats.removed += folderStats.removed
          stats.summary += folderStats.summary

          if (
            folderStats.added > 0 ||
            folderStats.updated > 0 ||
            folderStats.removed > 0
          ) {
            changesExist = true
          }
        }

        // Check if delta token changed (indicates changes occurred)
        if (folderDeltaToken && folderDeltaToken !== deltaToken) {
          changesExist = true
        }
      } catch (error) {
        Logger.error(error, `Error processing folder ${folder.name}: ${error}`)
        // Keep the existing delta token for this folder if processing failed
        if (currentDeltaTokens[folder.id]) {
          newDeltaTokens[folder.id] = currentDeltaTokens[folder.id]
        }
      }
    }

    // Process DeletedItems folder separately to handle deleted messages
    try {
      const deletedItemsFolderId = "deleteditems"
      const deletedItemsDeltaToken = currentDeltaTokens[deletedItemsFolderId]
      let deletedItemsEndpoint: string = ""

      if (deletedItemsDeltaToken && deletedItemsDeltaToken.startsWith("http")) {
        // Use existing delta token URL
        const url = new URL(deletedItemsDeltaToken)
        deletedItemsEndpoint = url.pathname + url.search
      }

      const deletedItemsResponse = await makeGraphApiCall(
        client,
        deletedItemsEndpoint,
      )
      const deletedItemsFolderDeltaToken =
        deletedItemsResponse["@odata.deltaLink"] ||
        deletedItemsResponse["@odata.nextLink"]

      if (deletedItemsFolderDeltaToken) {
        newDeltaTokens[deletedItemsFolderId] = deletedItemsFolderDeltaToken
      }

      // Process messages in DeletedItems folder
      if (deletedItemsResponse.value && deletedItemsResponse.value.length > 0) {
        let deletedItemsStats = newStats()

        for (const message of deletedItemsResponse.value) {
          try {
            // Any message in DeletedItems delta (whether @removed or newly moved) should be deleted from Vespa
            const messageId = message.id
            if (messageId) {
              try {
                await DeleteDocument(messageId, mailSchema)
                deletedItemsStats.removed += 1

                const action = message["@removed"]
                  ? "permanently deleted"
                  : "moved to DeletedItems"
                deletedItemsStats.summary += `Deleted message ${messageId} (${action})\n`

                // Also try to delete by internetMessageId if it exists and is different
                if (
                  message.internetMessageId &&
                  message.internetMessageId !== messageId
                ) {
                  try {
                    await DeleteDocument(message.internetMessageId, mailSchema)
                  } catch (error) {
                    // Ignore if document doesn't exist with internetMessageId
                  }
                }
              } catch (error) {
                Logger.warn(
                  `Could not delete message ${messageId} from DeletedItems: ${error}`,
                )
              }
            }
          } catch (error) {
            Logger.error(
              error,
              `Error processing message in DeletedItems folder: ${error}`,
            )
          }
        }

        // Merge DeletedItems stats into overall stats
        stats.removed += deletedItemsStats.removed
        stats.summary += deletedItemsStats.summary

        if (deletedItemsStats.removed > 0) {
          changesExist = true
        }

        loggerWithChild({ email: userEmail }).info(
          `Processed ${deletedItemsStats.removed} deleted messages from DeletedItems folder`,
        )
      }

      // Check if delta token changed (indicates changes occurred)
      if (
        deletedItemsFolderDeltaToken &&
        deletedItemsFolderDeltaToken !== deletedItemsDeltaToken
      ) {
        changesExist = true
      }
    } catch (error) {
      Logger.error(error, `Error processing DeletedItems folder: ${error}`)
      // Keep the existing delta token for DeletedItems folder if processing failed
      if (currentDeltaTokens["deleteditems"]) {
        newDeltaTokens["deleteditems"] = currentDeltaTokens["deleteditems"]
      }
    }

    return { newDeltaTokens, stats, changesExist }
  } catch (error) {
    Logger.error(
      error,
      `Error handling Outlook changes using delta API, but continuing sync engine execution.`,
    )
    return { newDeltaTokens: {}, stats, changesExist: false }
  }
}

// Handle Microsoft Calendar Events changes using /me/calendar/events/delta approach
const handleMicrosoftCalendarEventsChanges = async (
  client: MicrosoftGraphClient,
  syncTokenUrl: string,
  userEmail: string,
) => {
  let changesExist = false
  const stats = newStats()
  let newSyncTokenUrl = syncTokenUrl

  try {
    let endpoint = `/me/calendar/events/delta`
    let search = ""

    // Use the delta token URL if available
    if (syncTokenUrl && syncTokenUrl.startsWith("http")) {
      const url = new URL(syncTokenUrl)
      search = url.search
      loggerWithChild({ email: userEmail }).info(
        `Using existing delta token for events/delta`,
      )
    } else {
      loggerWithChild({ email: userEmail }).info(
        `Starting fresh events/delta sync`,
      )
    }

    // Get delta changes from Microsoft Graph API
    const deltaResponse = await makeGraphApiCall(client, endpoint + search)
    newSyncTokenUrl =
      deltaResponse["@odata.deltaLink"] ||
      deltaResponse["@odata.nextLink"] ||
      syncTokenUrl

    // Early return if no changes
    if (newSyncTokenUrl === syncTokenUrl || !deltaResponse.value?.length) {
      loggerWithChild({ email: userEmail }).info(`No calendar changes detected`)
      return {
        eventChanges: [],
        stats,
        newCalendarEventsSyncToken: newSyncTokenUrl,
        changesExist,
      }
    }

    loggerWithChild({ email: userEmail }).info(
      `Found ${deltaResponse.value.length} calendar event changes`,
    )

    // Process each event change
    for (const eventChange of deltaResponse.value) {
      const docId = eventChange.id
      if (!docId) continue

      if (eventChange["@removed"]) {
        // Handle removed events
        try {
          const event = await getDocumentOrNull(eventSchema, docId)
          if (event) {
            const permissions = (event?.fields as VespaEvent)?.permissions
            if (permissions?.length === 1 && permissions[0] === userEmail) {
              await DeleteDocument(docId, eventSchema)
              stats.removed += 1
              stats.summary += `${docId} event removed\n`
              changesExist = true
            } else if (permissions?.length > 1) {
              const newPermissions = permissions.filter((v) => v !== userEmail)
              await UpdateDocumentPermissions(
                eventSchema,
                docId,
                newPermissions,
              )
              stats.updated += 1
              stats.summary += `user lost permission to event: ${docId}\n`
              changesExist = true
            }
          }
        } catch (err: any) {
          Logger.error(
            err,
            `Error handling removed event ${docId}: ${err.message}`,
          )
        }
      } else {
        // Handle added/updated events - fetch full event data using /me/events/{id}
        try {
          const fullEvent = await makeGraphApiCall(
            client,
            `/me/events/${docId}?$select=id,subject,body,webLink,start,end,location,createdDateTime,lastModifiedDateTime,organizer,attendees,onlineMeeting,attachments,recurrence,isCancelled`,
          )

          if (fullEvent) {
            const existingEvent = await getDocumentOrNull(eventSchema, docId)
            await insertMicrosoftCalendarEventIntoVespa(fullEvent, userEmail)

            if (existingEvent) {
              stats.updated += 1
              stats.summary += `updated event ${docId}\n`
            } else {
              stats.added += 1
              stats.summary += `added new event ${docId}\n`
            }
            changesExist = true
          }
        } catch (eventError) {
          loggerWithChild({ email: userEmail }).warn(
            `Could not fetch event details for ${docId}: ${eventError}`,
          )
        }
      }
    }

    loggerWithChild({ email: userEmail }).info(
      `Calendar sync completed: ${stats.added} added, ${stats.updated} updated, ${stats.removed} removed`,
    )

    return {
      eventChanges: deltaResponse.value,
      stats,
      newCalendarEventsSyncToken: newSyncTokenUrl,
      changesExist,
    }
  } catch (err) {
    Logger.error(
      err,
      `Error handling Calendar event changes, but continuing sync engine execution.`,
    )
    return {
      eventChanges: [],
      stats,
      newCalendarEventsSyncToken: newSyncTokenUrl,
      changesExist,
    }
  }
}

// Fetch full event details using batch API
const fetchEventsBatch = async (
  client: MicrosoftGraphClient,
  eventIds: string[],
): Promise<any[]> => {
  try {
    // Create batch request
    const batchRequests = eventIds.map((eventId, index) => ({
      id: index.toString(),
      method: "GET",
      url: `/me/events/${eventId}?$select=id,subject,body,webLink,start,end,location,createdDateTime,lastModifiedDateTime,organizer,attendees,onlineMeeting,attachments,recurrence,isCancelled`,
    }))

    const batchRequestBody = {
      requests: batchRequests,
    }

    // Make batch request
    const batchResponse = await client.client
      .api("/$batch")
      .post(batchRequestBody)

    const events: any[] = []

    if (batchResponse.responses) {
      for (const response of batchResponse.responses) {
        if (response.status === 200 && response.body) {
          events.push(response.body)
        } else if (response.status === 404) {
          // Event was deleted between delta and batch fetch
          Logger.info(
            `Event ${eventIds[parseInt(response.id)]} was deleted between delta and batch fetch`,
          )
        } else {
          Logger.warn(
            `Failed to fetch event ${eventIds[parseInt(response.id)]}: ${response.status}`,
          )
        }
      }
    }

    return events
  } catch (error) {
    Logger.error(error, `Error in batch fetch of events: ${error}`)

    // Fallback: fetch events individually
    const events: any[] = []
    for (const eventId of eventIds) {
      try {
        const event = await makeGraphApiCall(
          client,
          `/me/events/${eventId}?$select=id,subject,body,webLink,start,end,location,createdDateTime,lastModifiedDateTime,organizer,attendees,onlineMeeting,attachments,recurrence,isCancelled`,
        )
        events.push(event)
      } catch (individualError) {
        Logger.warn(
          `Failed to fetch individual event ${eventId}: ${individualError}`,
        )
      }
    }

    return events
  }
}

// Insert Microsoft event into Vespa
const insertMicrosoftCalendarEventIntoVespa = async (
  event: any,
  userEmail: string,
) => {
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
  } catch (e) {
    Logger.error(
      e,
      `Error inserting Microsoft Calendar event with id ${event?.id} into Vespa`,
    )
  }
}

// Sync Microsoft contacts
const syncMicrosoftContacts = async (
  client: MicrosoftGraphClient,
  contacts: any[],
  email: string,
  entity: MicrosoftPeopleEntity,
): Promise<ChangeStats> => {
  const stats = newStats()

  for (const contact of contacts) {
    try {
      if (contact["@removed"]) {
        // Handle deleted contacts
        await DeleteDocument(contact.id, userSchema)
        stats.removed += 1
      } else {
        // Handle added/updated contacts
        await insertContact(contact, entity, email)
        stats.added += 1
        Logger.info(`Updated contact ${contact.id}`)
      }
    } catch (e) {
      Logger.error(
        e,
        `Error in syncing contact, but continuing sync engine execution.`,
      )
    }
  }

  return stats
}

// Main Microsoft OAuth changes handler
export const handleMicrosoftOAuthChanges = async (
  boss: PgBoss,
  job: PgBoss.Job<any>,
) => {
  const data = job.data
  loggerWithChild({ email: data.email ?? "" }).info(
    "handleMicrosoftOAuthChanges",
  )

  // Handle OneDrive sync jobs
  const syncJobs = await getAppSyncJobs(db, Apps.MicrosoftDrive, AuthType.OAuth)
  for (const syncJob of syncJobs) {
    let stats = newStats()
    try {
      let changesExist = false
      const connector = await getOAuthConnectorWithCredentials(
        db,
        syncJob.connectorId,
      )
      const user = await getUserById(db, connector.userId)
      const oauthTokens = (connector.oauthCredentials as OAuthCredentials).data

      // Create Microsoft Graph client
      const graphClient = createMicrosoftGraphClient(
        oauthTokens.access_token,
        oauthTokens.refresh_token,
        process.env.MICROSOFT_CLIENT_ID!,
        process.env.MICROSOFT_CLIENT_SECRET!,
      )

      let config: MicrosoftDriveChangeToken =
        syncJob.config as MicrosoftDriveChangeToken

      // Get OneDrive delta changes
      const deltaResult = await getOneDriveDelta(
        graphClient,
        config.driveToken || undefined,
      )

      if (!deltaResult) {
        Logger.warn("Could not fetch OneDrive delta changes")
        continue
      }

      const { changes, nextDeltaTokenUrl } = deltaResult

      // Process changes if any exist
      if (
        changes.length > 0 &&
        nextDeltaTokenUrl &&
        nextDeltaTokenUrl !== config.driveToken
      ) {
        Logger.info(`Processing ${changes.length} OneDrive changes`)

        for (const change of changes) {
          try {
            const changeStats = await handleOneDriveChange(
              change,
              graphClient,
              user.email,
            )
            stats = mergeStats(stats, changeStats)
            changesExist = true
          } catch (err) {
            Logger.error(
              err,
              `Error syncing OneDrive change, but continuing sync engine execution.`,
            )
          }
        }
      }

      // Update sync job if changes were processed
      if (changesExist) {
        const newConfig: MicrosoftDriveChangeToken = {
          type: "microsoftDriveDeltaToken",
          driveToken: nextDeltaTokenUrl!,
          contactsToken: config.contactsToken || "",
          lastSyncedAt: new Date(),
        }

        // Update sync job and create sync history
        await db.transaction(async (trx) => {
          await updateSyncJob(trx, syncJob.id, {
            config: newConfig,
            lastRanOn: new Date(),
            status: SyncJobStatus.Successful,
          })

          await insertSyncHistory(trx, {
            workspaceId: syncJob.workspaceId,
            workspaceExternalId: syncJob.workspaceExternalId,
            dataAdded: stats.added,
            dataDeleted: stats.removed,
            dataUpdated: stats.updated,
            authType: AuthType.OAuth,
            summary: { description: stats.summary },
            errorMessage: "",
            app: Apps.MicrosoftDrive,
            status: SyncJobStatus.Successful,
            config: {
              ...newConfig,
              lastSyncedAt: newConfig.lastSyncedAt.toISOString(),
            },
            type: SyncCron.ChangeToken,
            lastRanOn: new Date(),
          })
        })

        Logger.info(
          `Changes successfully synced for Microsoft OneDrive: ${JSON.stringify(stats)}`,
        )
      } else {
        Logger.info(`No Microsoft OneDrive changes to sync`)
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      Logger.error(
        error,
        `Could not successfully complete sync for Microsoft OneDrive, but continuing sync engine execution: ${syncJob.id} due to ${errorMessage}: ${(error as Error).stack}`,
      )

      const config: MicrosoftDriveChangeToken =
        syncJob.config as MicrosoftDriveChangeToken
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
        app: Apps.MicrosoftDrive,
        status: SyncJobStatus.Failed,
        config: newConfig,
        type: SyncCron.ChangeToken,
        lastRanOn: new Date(),
      })
    }
  }

  // Handle Outlook sync jobs
  const outlookSyncJobs = await getAppSyncJobs(
    db,
    Apps.MicrosoftOutlook,
    AuthType.OAuth,
  )
  for (const syncJob of outlookSyncJobs) {
    let stats = newStats()
    try {
      const connector = await getOAuthConnectorWithCredentials(
        db,
        syncJob.connectorId,
      )
      const user = await getUserById(db, connector.userId)
      const oauthTokens = (connector.oauthCredentials as OAuthCredentials).data

      let config: MicrosoftOutlookChangeToken =
        syncJob.config as MicrosoftOutlookChangeToken

      const graphClient = createMicrosoftGraphClient(
        oauthTokens.access_token,
        oauthTokens.refresh_token,
        process.env.MICROSOFT_CLIENT_ID!,
        process.env.MICROSOFT_CLIENT_SECRET!,
      )

      let {
        newDeltaTokens,
        stats: outlookStats,
        changesExist,
      } = await handleOutlookChanges(graphClient, config, user.email)

      if (changesExist) {
        // Update config with new delta tokens
        const updatedConfig: MicrosoftOutlookChangeToken = {
          type: "microsoftOutlookDeltaToken",
          deltaTokens: newDeltaTokens,
          // For backward compatibility, also store as JSON string
          deltaToken: JSON.stringify(newDeltaTokens),
          lastSyncedAt: new Date(),
        }

        await db.transaction(async (trx) => {
          await updateSyncJob(trx, syncJob.id, {
            config: updatedConfig,
            lastRanOn: new Date(),
            status: SyncJobStatus.Successful,
          })

          await insertSyncHistory(trx, {
            workspaceId: syncJob.workspaceId,
            workspaceExternalId: syncJob.workspaceExternalId,
            dataAdded: outlookStats.added,
            dataDeleted: outlookStats.removed,
            dataUpdated: outlookStats.updated,
            authType: AuthType.OAuth,
            summary: { description: outlookStats.summary },
            errorMessage: "",
            app: Apps.MicrosoftOutlook,
            status: SyncJobStatus.Successful,
            config: {
              ...updatedConfig,
              lastSyncedAt: updatedConfig.lastSyncedAt.toISOString(),
            },
            type: SyncCron.ChangeToken,
            lastRanOn: new Date(),
          })
        })

        loggerWithChild({ email: data.email ?? "" }).info(
          `Changes successfully synced for Microsoft Outlook: ${JSON.stringify(outlookStats)}`,
        )
      } else {
        Logger.info(`No Outlook changes to sync`)
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      loggerWithChild({ email: data.email ?? "" }).error(
        error,
        `Could not successfully complete sync for Microsoft Outlook, but continuing sync engine execution: ${syncJob.id} due to ${errorMessage} ${(error as Error).stack}`,
      )

      const config: MicrosoftOutlookChangeToken =
        syncJob.config as MicrosoftOutlookChangeToken
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
        app: Apps.MicrosoftOutlook,
        status: SyncJobStatus.Failed,
        config: newConfig,
        type: SyncCron.ChangeToken,
        lastRanOn: new Date(),
      })
    }
  }

  // Handle Calendar sync jobs
  const calendarSyncJobs = await getAppSyncJobs(
    db,
    Apps.MicrosoftCalendar,
    AuthType.OAuth,
  )
  for (const syncJob of calendarSyncJobs) {
    let stats = newStats()
    try {
      const connector = await getOAuthConnectorWithCredentials(
        db,
        syncJob.connectorId,
      )
      const oauthTokens = (connector.oauthCredentials as OAuthCredentials).data

      let config: MicrosoftCalendarChangeToken =
        syncJob.config as MicrosoftCalendarChangeToken

      const graphClient = createMicrosoftGraphClient(
        oauthTokens.access_token,
        oauthTokens.refresh_token,
        process.env.MICROSOFT_CLIENT_ID!,
        process.env.MICROSOFT_CLIENT_SECRET!,
      )

      let {
        eventChanges,
        stats: calendarStats,
        newCalendarEventsSyncToken,
        changesExist,
      } = await handleMicrosoftCalendarEventsChanges(
        graphClient,
        config.calendarDeltaToken,
        syncJob.email,
      )

      if (changesExist) {
        config.calendarDeltaToken = newCalendarEventsSyncToken

        await db.transaction(async (trx) => {
          await updateSyncJob(trx, syncJob.id, {
            config,
            lastRanOn: new Date(),
            status: SyncJobStatus.Successful,
          })

          await insertSyncHistory(trx, {
            workspaceId: syncJob.workspaceId,
            workspaceExternalId: syncJob.workspaceExternalId,
            dataAdded: calendarStats.added,
            dataDeleted: calendarStats.removed,
            dataUpdated: calendarStats.updated,
            authType: AuthType.OAuth,
            summary: { description: calendarStats.summary },
            errorMessage: "",
            app: Apps.MicrosoftCalendar,
            status: SyncJobStatus.Successful,
            config: {
              ...config,
              lastSyncedAt: config.lastSyncedAt.toISOString(),
            },
            type: SyncCron.ChangeToken,
            lastRanOn: new Date(),
          })
        })

        loggerWithChild({ email: data.email ?? "" }).info(
          `Changes successfully synced for Microsoft Calendar: ${JSON.stringify(calendarStats)}`,
        )
      } else {
        loggerWithChild({ email: data.email ?? "" }).info(
          `No Microsoft Calendar changes to sync`,
        )
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      loggerWithChild({ email: data.email ?? "" }).error(
        error,
        `Could not successfully complete sync for Microsoft Calendar, but continuing sync engine execution: ${syncJob.id} due to ${errorMessage} ${(error as Error).stack}`,
      )

      const config: MicrosoftCalendarChangeToken =
        syncJob.config as MicrosoftCalendarChangeToken
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
        app: Apps.MicrosoftCalendar,
        status: SyncJobStatus.Failed,
        config: newConfig,
        type: SyncCron.ChangeToken,
        lastRanOn: new Date(),
      })
    }
  }
}
