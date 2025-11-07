import {
  Subsystem,
  SyncCron,
  type MicrosoftServiceCredentials,
  type OAuthCredentials,
  type SyncConfig,
} from "@/types"
import PgBoss from "pg-boss"
import {
  getMicrosoftAuthConnectorWithCredentials,
  getOAuthConnectorWithCredentials,
} from "@/db/connector"
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
} from "@xyne/vespa-ts/types"
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
} from "@xyne/vespa-ts/types"
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
} from "./index"
import { MAX_ONEDRIVE_FILE_SIZE, skipMailExistCheck } from "./config"
import {
  getFilePermissionsSharepoint,
  MicrosoftMimeType,
  microsoftMimeTypeMap,
  processFileContent,
  loggerWithChild,
  type OneDriveFile,
  getFilePermissions,
} from "./utils"
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
import {
  deleteWholeSpreadsheet,
  getDocumentOrSpreadsheet,
} from "../google/sync"
import { DriveMime } from "../google/utils"
import {
  discoverSharePointSites,
  discoverSiteDrives,
  processSiteDrives,
} from "./sharepoint"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "microsoft-sync",
})

// Validate Microsoft client credentials at module load time
const validateMicrosoftCredentials = () => {
  const clientId = process.env.MICROSOFT_CLIENT_ID
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    Logger.warn(
      "Microsoft integration disabled: MICROSOFT_CLIENT_ID and/or MICROSOFT_CLIENT_SECRET environment variables not set",
    )
    return { clientId: null, clientSecret: null }
  }

  return { clientId, clientSecret }
}

const { clientId: MICROSOFT_CLIENT_ID, clientSecret: MICROSOFT_CLIENT_SECRET } =
  validateMicrosoftCredentials()

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

type MicrosoftSharepointChangeToken = {
  type: "microsoftSharepointDeltaTokens"
  deltaLinks: Record<string, string>
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
      const response = await makeGraphApiCall(graphClient, endpoint)
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
  updatedPermissions: string[],
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
        permissions: updatedPermissions,
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
      permissions: updatedPermissions,
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
    if (mimeType === MicrosoftMimeType.PDF) {
      return await extractPDFContent(graphClient, file)
    }

    // For DOCX files, download and extract using docxChunks helper
    if (mimeType === MicrosoftMimeType.WordDocumentModern) {
      try {
        Logger.info(`Processing DOCX file: ${file.name}`)
        const fileBuffer = await downloadFileFromGraph(graphClient, file.id)
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
    if (mimeType === MicrosoftMimeType.ExcelSpreadsheetModern) {
      try {
        Logger.info(`Processing XLSX file: ${file.name}`)
        const fileBuffer = await downloadFileFromGraph(graphClient, file.id)
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
      mimeType === MicrosoftMimeType.PlainText ||
      mimeType === MicrosoftMimeType.CSV
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
    const fileBuffer = await downloadFileFromGraph(graphClient, file.id)
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
        if (
          (doc?.fields as VespaFile).mimeType ===
          MicrosoftMimeType.ExcelSpreadsheetModern
        ) {
          await deleteWholeSpreadsheet(
            doc?.fields as VespaFile,
            docId,
            stats,
            userEmail,
          )
        } else {
          // Safe to remove: change.deleted only appears for owners,
          // meaning the file is permanently deleted
          await DeleteDocument(docId, fileSchema)
          stats.removed += 1
          stats.summary += `${docId} removed\n`
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
  // Handle file additions/updates including permission updates
  try {
    // Check if document already exists
    const existingDoc = await getDocumentOrNull(fileSchema, docId)
    if (existingDoc) {
      stats.updated += 1
    } else {
      stats.added += 1
    }

    const currentPermissions =
      (existingDoc?.fields as VespaFileWithDrivePermission)?.permissions ?? []
    const updatedPermissions = await getFilePermissions(graphClient, change.id)

    if (updatedPermissions.length === 0) {
      Logger.error(`No user found for the OneDrive file ${docId}`)
      return stats
    }

    const newUsers = updatedPermissions.filter(
      (email) => !currentPermissions.includes(email),
    )
    const removedUsers = currentPermissions.filter(
      (email) => !updatedPermissions.includes(email),
    )

    if (existingDoc) {
      if (newUsers.length) {
        stats.summary += `new user(s): ${newUsers} added to doc: ${docId}\n`
      }
      if (removedUsers.length) {
        stats.summary += `user(s): ${removedUsers} lost permission for doc: ${docId}\n`
      }
    }

    // Convert to Vespa format
    let vespaData = await oneDriveFileToVespa(
      change,
      userEmail,
      updatedPermissions,
    )
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

    // Collect all event changes from all pages
    const allEventChanges: any[] = []
    let nextLink: string | null = endpoint + search

    // Loop through all pages until no more data
    while (nextLink) {
      const deltaResponse = await makeGraphApiCall(client, nextLink)

      // Collect all events from this page
      if (deltaResponse.value && deltaResponse.value.length > 0) {
        allEventChanges.push(...deltaResponse.value)
      }

      // Update the sync token and next link
      newSyncTokenUrl =
        deltaResponse["@odata.deltaLink"] ||
        deltaResponse["@odata.nextLink"] ||
        syncTokenUrl

      // If we have a deltaLink, we're done with pagination
      if (deltaResponse["@odata.deltaLink"]) {
        nextLink = null
      } else if (deltaResponse["@odata.nextLink"]) {
        // Continue with next page
        nextLink = deltaResponse["@odata.nextLink"]
      } else {
        // No more pages
        nextLink = null
      }
    }

    // Early return if no changes
    if (newSyncTokenUrl === syncTokenUrl || !allEventChanges.length) {
      loggerWithChild({ email: userEmail }).info(`No calendar changes detected`)
      return {
        eventChanges: [],
        stats,
        newCalendarEventsSyncToken: newSyncTokenUrl,
        changesExist,
      }
    }

    loggerWithChild({ email: userEmail }).info(
      `Found ${allEventChanges.length} calendar event changes across all pages`,
    )

    // Process each event change from all collected pages
    for (const eventChange of allEventChanges) {
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
      eventChanges: allEventChanges,
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

const updateSharepointDeltaLinks = async (
  graphClient: MicrosoftGraphClient,
  deltaLinks: Record<string, string>,
  email: string,
): Promise<{
  deletedDrives: string[]
  newDeltaLinks: Record<string, string>
}> => {
  let sites = await discoverSharePointSites(graphClient, email)
  let drives = await discoverSiteDrives(graphClient, sites, email)

  const driveSet = new Set(
    drives.map((drive) => `${drive.sharePointIds?.siteId}::${drive.id}`),
  )

  let deletedDrives: string[] = []

  //Filters out newly added drives
  drives = drives.filter(
    (drive) =>
      drive.id &&
      !(`${drive.sharePointIds?.siteId}::${drive.id}` in deltaLinks),
  )

  //Filters out deleted drives
  for (const key in deltaLinks) {
    if (!driveSet.has(key)) {
      deletedDrives.push(key)
      delete deltaLinks[key]
    }
  }

  //TODO: remove files from deleted drives
  // await deleteDrives(graphClient, deletedDrives, email)

  //perform initial ingestion of new drives
  const newDeltaLinks = await processSiteDrives(graphClient, drives, email)

  for (const [key, value] of Object.entries(newDeltaLinks))
    deltaLinks[key] = value

  return { deletedDrives, newDeltaLinks }
}

const handleSharepointChanges = async (
  graphClient: MicrosoftGraphClient,
  deltaLinks: Record<string, string>,
  email: string,
): Promise<{
  stats: ChangeStats
  changesExist: boolean
}> => {
  const stats = newStats()
  let changesExist = false

  // For tracking newly added or removed drives
  const { deletedDrives, newDeltaLinks } = await updateSharepointDeltaLinks(
    graphClient,
    deltaLinks,
    email,
  )

  if (deletedDrives.length > 0) {
    stats.summary += `Removed ${deletedDrives.length} SharePoint drives: ${deletedDrives.join(", ")}\n`
    changesExist = true
  }

  if (Object.keys(newDeltaLinks).length > 0) {
    stats.summary += `Discovered ${Object.keys(newDeltaLinks).length} new SharePoint drives\n`
    changesExist = true
  }

  // Process delta changes for each existing drive
  for (const [driveKey, deltaToken] of Object.entries(deltaLinks)) {
    try {
      // Skip newly added drives
      if (driveKey in newDeltaLinks) {
        continue
      }

      loggerWithChild({ email }).info(
        `Processing delta changes for drive: ${driveKey}`,
      )

      // Extract siteId and driveId from the composite key
      const [siteId, driveId] = driveKey.split("::")
      if (!siteId || !driveId) {
        Logger.warn(`Invalid drive key format: ${driveKey}`)
        continue
      }

      const { driveStats, newDeltaLink } =
        await processSharePointDriveDeltaChanges(
          graphClient,
          siteId,
          driveId,
          deltaToken,
          email,
        )
      if (newDeltaLink !== "") {
        //update with new Link
        deltaLinks[driveKey] = newDeltaLink
      }

      // Merge drive stats into overall stats
      stats.added += driveStats.added
      stats.updated += driveStats.updated
      stats.removed += driveStats.removed
      stats.summary += driveStats.summary

      if (
        driveStats.added > 0 ||
        driveStats.updated > 0 ||
        driveStats.removed > 0
      ) {
        changesExist = true
      }

      loggerWithChild({ email }).info(
        `Processed drive ${driveKey}: ${driveStats.added} added, ${driveStats.updated} updated, ${driveStats.removed} removed`,
      )
    } catch (error) {
      Logger.error(
        error,
        `Error processing SharePoint drive ${driveKey}: ${error}`,
      )
      stats.summary += `Error processing drive ${driveKey}: ${getErrorMessage(error)}\n`
    }
  }

  return { stats, changesExist }
}

// Process delta changes for a specific SharePoint drive
const processSharePointDriveDeltaChanges = async (
  graphClient: MicrosoftGraphClient,
  siteId: string,
  driveId: string,
  deltaLink: string,
  email: string,
): Promise<{ driveStats: ChangeStats; newDeltaLink: string }> => {
  const stats = newStats()
  let newDeltaLink: string = ""

  try {
    // Use delta token to get changes for this specific drive
    let nextLink: string | undefined = deltaLink

    loggerWithChild({ email }).info(
      `Fetching delta changes from: ${nextLink.substring(0, 100)}...`,
    )

    while (nextLink) {
      const response = await makeGraphApiCall(graphClient, nextLink)

      if (response.value && Array.isArray(response.value)) {
        for (const item of response.value) {
          try {
            if (item.deleted || item["@removed"]) {
              // Handle deleted files
              await handleSharePointFileDelete(item.id, email, stats)
            } else if (item.file) {
              // Handle added/updated files (skip folders)
              await handleSharePointFileChange(
                graphClient,
                item,
                siteId,
                driveId,
                email,
                stats,
              )
            }
          } catch (itemError) {
            Logger.error(
              itemError,
              `Error processing SharePoint item ${item.id}: ${itemError}`,
            )
          }
        }
      }

      // Check for pagination
      if (response["@odata.nextLink"]) {
        nextLink = response["@odata.nextLink"]
      } else if (response["@odata.deltaLink"]) {
        newDeltaLink = response["@odata.deltaLink"]
        nextLink = undefined
      } else {
        nextLink = undefined
      }
    }
  } catch (error) {
    Logger.error(
      error,
      `Error processing delta changes for drive ${driveId} in site ${siteId}`,
    )
    throw error
  }

  return {
    driveStats: stats,
    newDeltaLink,
  }
}

// Handle SharePoint file deletion
const handleSharePointFileDelete = async (
  fileId: string,
  email: string,
  stats: ChangeStats,
): Promise<void> => {
  try {
    const existingDoc = await getDocumentOrNull(fileSchema, fileId)
    if (existingDoc) {
      // "deleted or @removed" in delta implies the file was deleted, not just permission changes.
      // Safe to delete from Vespa regardless of ACLs or user-specific permissions.
      await DeleteDocument(fileId, fileSchema)
      stats.removed += 1
      stats.summary += `Deleted SharePoint file ${fileId}\n`
    } else {
      throw new Error("File not found in vespa")
    }
  } catch (error) {
    Logger.error(error, `Error deleting SharePoint file ${fileId}: ${error}`)
  }
}

// Handle SharePoint file addition/update
const handleSharePointFileChange = async (
  graphClient: MicrosoftGraphClient,
  item: any,
  siteId: string,
  driveId: string,
  email: string,
  stats: ChangeStats,
): Promise<void> => {
  try {
    const fileId = item.id
    const existingDoc = await getDocumentOrNull(fileSchema, fileId)

    // Get file permissions
    const permissions: string[] = await getFilePermissionsSharepoint(
      graphClient,
      fileId,
      driveId,
    )

    // Process file content
    const chunks = await processFileContent(graphClient, item, email)

    // Create Vespa file object
    const vespaFile = {
      title: item.name ?? "",
      url: item.webUrl ?? "",
      app: Apps.MicrosoftSharepoint,
      docId: fileId,
      parentId: item.parentReference?.id ?? null,
      owner: item.createdBy?.user?.displayName ?? email,
      photoLink: "",
      ownerEmail: email,
      entity: DriveEntity.Misc,
      chunks,
      permissions,
      mimeType: item.file?.mimeType ?? "application/octet-stream",
      metadata: JSON.stringify({
        size: item.size,
        downloadUrl: item["@microsoft.graph.downloadUrl"],
        siteId: siteId,
        driveId: driveId,
        parentId: item.parentReference?.id ?? "",
        parentPath: item.parentReference?.path ?? "/",
        eTag: item.eTag ?? "",
      }),
      createdAt: new Date(item.createdDateTime).getTime(),
      updatedAt: new Date(item.lastModifiedDateTime).getTime(),
    }

    // Insert into Vespa
    await insertWithRetry(vespaFile, fileSchema)

    if (existingDoc) {
      stats.updated += 1
      stats.summary += `Updated SharePoint file ${fileId}\n`
    } else {
      stats.added += 1
      stats.summary += `Added SharePoint file ${fileId}\n`
    }
  } catch (error) {
    Logger.error(error, `Error processing SharePoint file ${item.id}: ${error}`)
  }
}

// Main Microsoft OAuth changes handler
export const handleMicrosoftOAuthChanges = async (
  boss: PgBoss,
  job: PgBoss.Job<any>,
) => {
  // Skip if Microsoft credentials are not configured
  if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET) {
    Logger.warn(
      "Skipping Microsoft sync job - Microsoft integration not configured",
    )
    return
  }

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
        MICROSOFT_CLIENT_ID,
        MICROSOFT_CLIENT_SECRET,
        oauthTokens.refresh_token,
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
        MICROSOFT_CLIENT_ID,
        MICROSOFT_CLIENT_SECRET,
        oauthTokens.refresh_token,
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
        MICROSOFT_CLIENT_ID,
        MICROSOFT_CLIENT_SECRET,
        oauthTokens.refresh_token,
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

export async function handleMicrosoftServiceAccountChanges() {
  Logger.info("handleMicrosoftServiceAccountChanges")
  const syncJobs = await getAppSyncJobs(
    db,
    Apps.MicrosoftSharepoint,
    AuthType.ServiceAccount,
  )

  for (const syncJob of syncJobs) {
    let stats = newStats()
    try {
      const connector = await getMicrosoftAuthConnectorWithCredentials(
        db,
        syncJob.connectorId,
      )

      const authTokens = JSON.parse(
        connector.credentials as string,
      ) as MicrosoftServiceCredentials

      const graphClient = createMicrosoftGraphClient(
        authTokens.access_token,
        authTokens.clientId,
        authTokens.clientSecret,
        undefined,
        authTokens.tenantId,
      )

      let config: MicrosoftSharepointChangeToken =
        syncJob.config as MicrosoftSharepointChangeToken

      //handles delta changes and updates deltaLinks in-place
      const { stats: changeStats, changesExist } =
        await handleSharepointChanges(
          graphClient,
          config.deltaLinks,
          syncJob.email,
        )

      if (changesExist) {
        const newConfig: MicrosoftSharepointChangeToken = {
          type: "microsoftSharepointDeltaTokens",
          deltaLinks: config.deltaLinks,
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
            dataAdded: changeStats.added,
            dataDeleted: changeStats.removed,
            dataUpdated: changeStats.updated,
            authType: AuthType.ServiceAccount,
            summary: { description: changeStats.summary },
            errorMessage: "",
            app: Apps.MicrosoftSharepoint,
            status: SyncJobStatus.Successful,
            config: {
              ...newConfig,
              lastSyncedAt: newConfig.lastSyncedAt.toISOString(),
            },
            type: SyncCron.ChangeToken,
            lastRanOn: new Date(),
          })
        })

        Logger.info(`SharePoint changes synced: ${JSON.stringify(changeStats)}`)
      } else {
        Logger.info("No SharePoint changes to sync")
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      Logger.error(error, `SharePoint sync failed: ${errorMessage}`)

      // Insert failed sync history
      await insertSyncHistory(db, {
        workspaceId: syncJob.workspaceId,
        workspaceExternalId: syncJob.workspaceExternalId,
        dataAdded: stats.added,
        dataDeleted: stats.removed,
        dataUpdated: stats.updated,
        authType: AuthType.ServiceAccount,
        summary: { description: stats.summary },
        errorMessage,
        app: Apps.MicrosoftSharepoint,
        status: SyncJobStatus.Failed,
        config: syncJob.config,
        type: SyncCron.ChangeToken,
        lastRanOn: new Date(),
      })
    }
  }
}
