import { db } from "@/db/client"
import { getOAuthConnectorWithCredentials } from "@/db/connector"
import { getAppSyncJobs, updateSyncJob } from "@/db/syncJob"
import { getUserById } from "@/db/user"
import { insertSyncHistory } from "@/db/syncHistory"
import { getErrorMessage, retryWithBackoff } from "@/utils"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type {
  DriveItem,
  Calendar,
  Message,
} from "@microsoft/microsoft-graph-types"
import type { OAuthCredentials, SyncConfig } from "@/types"
import type PgBoss from "pg-boss"
import { Apps, AuthType, SyncJobStatus, DriveEntity } from "@/shared/types"
import { SyncCron } from "@/types"
import {
  createMicrosoftGraphClient,
  makeGraphApiCall,
  type MicrosoftGraphClient,
} from "./client"
import {
  insertWithRetry,
  DeleteDocument,
  getDocumentOrNull,
  UpdateDocumentPermissions,
} from "@/search/vespa"
import { fileSchema } from "@/search/types"
import type { VespaFileWithDrivePermission } from "@/search/types"
import { chunkDocument } from "@/chunks"
import { MAX_ONEDRIVE_FILE_SIZE } from "./config"
import { downloadFileFromGraph } from "./client"
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf"
import type { Document } from "@langchain/core/documents"
import fs from "node:fs/promises"
import path from "path"
import os from "os"

const Logger = getLogger(Subsystem.Integrations).child({ module: "microsoft" })

// TODO: change summary to json
// and store all the structured details
type ChangeStats = {
  added: number
  removed: number
  updated: number
  summary: string
}

// Microsoft OneDrive MIME types mapping
export const microsoftMimeTypeMap: Record<string, DriveEntity> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    DriveEntity.WordDocument,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    DriveEntity.ExcelSpreadsheet,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    DriveEntity.PowerPointPresentation,
  "application/pdf": DriveEntity.PDF,
  "text/plain": DriveEntity.Text,
  "image/jpeg": DriveEntity.Image,
  "image/png": DriveEntity.Image,
  "application/zip": DriveEntity.Zip,
  "application/msword": DriveEntity.WordDocument,
  "application/vnd.ms-excel": DriveEntity.ExcelSpreadsheet,
  "application/vnd.ms-powerpoint": DriveEntity.PowerPointPresentation,
  "text/csv": DriveEntity.CSV,
}

// OneDrive file interface based on Microsoft Graph API
interface OneDriveFile {
  id: string
  name: string
  webUrl?: string
  createdDateTime: string
  lastModifiedDateTime: string
  size?: number
  file?: {
    mimeType?: string
  }
  folder?: any
  deleted?: {
    state: string
  }
  createdBy?: {
    user?: {
      displayName?: string
      email?: string
    }
  }
  lastModifiedBy?: {
    user?: {
      displayName?: string
      email?: string
    }
  }
  parentReference?: {
    id?: string
    name?: string
    path?: string
  }
}

// Microsoft delta token type
type MicrosoftDriveDeltaToken = {
  type: "microsoftDriveDeltaToken"
  driveToken: string
  contactsToken: string
  lastSyncedAt: Date
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

// Get OneDrive delta changes using Microsoft Graph API
export const getOneDriveDelta = async (
  graphClient: MicrosoftGraphClient,
  deltaToken?: string,
): Promise<{
  changes: OneDriveFile[]
  nextDeltaToken: string | null
} | null> => {
  try {
    let endpoint = "/me/drive/root/delta"
    if (deltaToken) {
      endpoint = `/me/drive/root/delta?token=${deltaToken}`
    }

    const response = await retryWithBackoff(
      () => makeGraphApiCall(graphClient, endpoint),
      `Fetching OneDrive delta changes with token ${deltaToken || "initial"}`,
      Apps.MicrosoftDrive,
    )

    const changes = response.value || []
    const nextDeltaToken = response["@odata.deltaLink"]
      ? new URL(response["@odata.deltaLink"]).searchParams.get("token")
      : null

    return { changes, nextDeltaToken }
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
    await fs.writeFile(tempFilePath, fileBuffer)

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
      const doc = await getDocumentOrNull(fileSchema, docId)
      if (doc) {
        const permissions = (doc.fields as VespaFileWithDrivePermission)
          ?.permissions
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
          const newPermissions = permissions.filter((v) => v !== userEmail)
          await UpdateDocumentPermissions(fileSchema, docId, newPermissions)
          stats.updated += 1
          stats.summary += `user lost permission for doc: ${docId}\n`
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

// Main handler for Microsoft OAuth changes
export const handleMicrosoftOAuthChanges = async (
  boss: PgBoss,
  job: PgBoss.Job<any>,
) => {
  const data = job.data
  Logger.info("handleMicrosoftOAuthChanges", { email: data.email ?? "" })

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

      let config: MicrosoftDriveDeltaToken =
        syncJob.config as MicrosoftDriveDeltaToken

      // Get OneDrive delta changes
      const deltaResult = await getOneDriveDelta(
        graphClient,
        config.driveToken || undefined,
      )

      if (!deltaResult) {
        Logger.warn("Could not fetch OneDrive delta changes")
        continue
      }

      const { changes, nextDeltaToken } = deltaResult

      // Process changes if any exist
      if (
        changes.length > 0 &&
        nextDeltaToken &&
        nextDeltaToken !== config.driveToken
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
        const newConfig: MicrosoftDriveDeltaToken = {
          type: "microsoftDriveDeltaToken",
          driveToken: nextDeltaToken!,
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

      const config: MicrosoftDriveDeltaToken =
        syncJob.config as MicrosoftDriveDeltaToken
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
}
