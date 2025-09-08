import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { MicrosoftGraphClient } from "./client"
import { makeGraphApiCall } from "./client"
import { Apps, DriveEntity } from "@/shared/types"
import { chunkDocument } from "@/chunks"
import type { VespaFileWithDrivePermission } from "@/search/types"
import { MAX_ONEDRIVE_FILE_SIZE } from "./config"

const Logger = getLogger(Subsystem.Integrations).child({ module: "microsoft" })

export enum MicrosoftMimeType {
  WordDocumentModern = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ExcelSpreadsheetModern = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  PowerPointPresentationModern = "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  PDF = "application/pdf",
  PlainText = "text/plain",
  JPEG = "image/jpeg",
  PNG = "image/png",
  Zip = "application/zip",
  WordDocumentLegacy = "application/msword",
  ExcelSpreadsheetLegacy = "application/vnd.ms-excel",
  PowerPointPresentationLegacy = "application/vnd.ms-powerpoint",
  CSV = "text/csv",
}

// Microsoft OneDrive MIME types that support content extraction
export const MimeMapForContent: Record<string, boolean> = {
  [MicrosoftMimeType.PDF]: true,
  [MicrosoftMimeType.PlainText]: true,
  [MicrosoftMimeType.CSV]: true,
  [MicrosoftMimeType.WordDocumentModern]: true,
  [MicrosoftMimeType.ExcelSpreadsheetModern]: true,
  [MicrosoftMimeType.PowerPointPresentationModern]: true,
  [MicrosoftMimeType.WordDocumentLegacy]: true,
  [MicrosoftMimeType.ExcelSpreadsheetLegacy]: true,
  [MicrosoftMimeType.PowerPointPresentationLegacy]: true,
}

// Get OneDrive file metadata
export const getOneDriveFile = async (
  graphClient: MicrosoftGraphClient,
  fileId: string,
): Promise<any | null> => {
  try {
    const file = await makeGraphApiCall(
      graphClient,
      `/me/drive/items/${fileId}`,
    )
    return file
  } catch (error) {
    Logger.error(error, `Error fetching OneDrive file ${fileId}: ${error}`)
    return null
  }
}

// Get OneDrive file content as text
export const getOneDriveFileContent = async (
  graphClient: MicrosoftGraphClient,
  fileId: string,
  fileName: string,
  mimeType: string,
): Promise<string[]> => {
  try {
    // Check if file type supports content extraction
    if (!MimeMapForContent[mimeType]) {
      Logger.debug(`File type ${mimeType} not supported for content extraction`)
      return []
    }

    // Try to get content as text
    const contentResponse = await graphClient.client
      .api(`/me/drive/items/${fileId}/content`)
      .header("Accept", "text/plain")
      .get()

    if (typeof contentResponse === "string") {
      const chunks = chunkDocument(contentResponse)
      return chunks.map((chunk) => chunk.chunk)
    }

    Logger.warn(`Could not extract text content from ${fileName}`)
    return []
  } catch (error) {
    Logger.error(
      error,
      `Error extracting content from OneDrive file ${fileId}: ${error}`,
    )
    return []
  }
}

// Convert OneDrive permissions to email list
export const toOneDrivePermissionsList = (
  permissions: any[] | undefined,
  ownerEmail: string,
): string[] => {
  if (!permissions || permissions.length === 0) {
    return [ownerEmail]
  }

  const emailList = permissions
    .filter((p) => p.grantedToV2?.user?.email || p.grantedTo?.user?.email)
    .map((p) => p.grantedToV2?.user?.email || p.grantedTo?.user?.email)
    .filter(Boolean)

  // Always include the owner email
  if (!emailList.includes(ownerEmail)) {
    emailList.push(ownerEmail)
  }

  return emailList
}

// Check if file is too large for processing
export const isFileTooLarge = (fileSize: number | undefined): boolean => {
  if (!fileSize) return false
  const fileSizeInMB = fileSize / (1024 * 1024)
  return fileSizeInMB > MAX_ONEDRIVE_FILE_SIZE
}

// Get file entity type from MIME type
export const getEntityFromMimeType = (
  mimeType: string | undefined,
): DriveEntity => {
  if (!mimeType) return DriveEntity.Misc

  return microsoftMimeTypeMap[mimeType] ?? DriveEntity.Misc
}

// Format OneDrive file metadata for Vespa
export const formatOneDriveMetadata = (file: any): string => {
  return JSON.stringify({
    parentPath: file.parentReference?.path ?? "",
    parentName: file.parentReference?.name ?? "",
    size: file.size ?? 0,
    webUrl: file.webUrl ?? "",
    downloadUrl: file["@microsoft.graph.downloadUrl"] ?? "",
    lastModifiedBy: file.lastModifiedBy?.user?.displayName ?? "",
    createdBy: file.createdBy?.user?.displayName ?? "",
  })
}

// Get OneDrive delta link token
export const extractDeltaToken = (deltaLink: string): string | null => {
  try {
    const url = new URL(deltaLink)
    return (
      url.searchParams.get("token") ||
      url.searchParams.get("$deltatoken") ||
      url.searchParams.get("$skiptoken")
    )
  } catch (error) {
    Logger.error(error, `Error extracting delta token from ${deltaLink}`)
    return null
  }
}

// Check if OneDrive change should be processed
export const shouldProcessChange = (change: any): boolean => {
  // Skip if it's a deleted item and we don't have it in our system
  if (change.deleted) {
    return true // We need to process deletions to remove from Vespa
  }

  // Skip if it's a folder (we might want to process folders differently)
  if (change.folder) {
    return false // For now, skip folders
  }

  // Skip if it's not a file
  if (!change.file) {
    return false
  }

  // Skip if file is too large
  if (isFileTooLarge(change.size)) {
    Logger.warn(
      `Skipping file ${change.name} as it's larger than ${MAX_ONEDRIVE_FILE_SIZE}MB`,
    )
    return false
  }

  return true
}

// Log sync progress
export const logSyncProgress = (
  operation: string,
  fileId: string,
  fileName: string,
  details?: any,
) => {
  Logger.info(`OneDrive Sync - ${operation}`, {
    fileId,
    fileName,
    ...details,
  })
}

// Create initial delta token config
export const createInitialDeltaConfig = () => {
  return {
    type: "microsoftDriveDeltaToken" as const,
    driveToken: "", // Will be set after first sync
    contactsToken: "", // For future contacts sync
    lastSyncedAt: new Date(),
  }
}

export interface OneDriveFile {
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

// Microsoft OneDrive MIME types mapping
export const microsoftMimeTypeMap: Record<string, DriveEntity> = {
  [MicrosoftMimeType.WordDocumentModern]: DriveEntity.WordDocument,
  [MicrosoftMimeType.ExcelSpreadsheetModern]: DriveEntity.ExcelSpreadsheet,
  [MicrosoftMimeType.PowerPointPresentationModern]:
    DriveEntity.PowerPointPresentation,
  [MicrosoftMimeType.PDF]: DriveEntity.PDF,
  [MicrosoftMimeType.PlainText]: DriveEntity.Text,
  [MicrosoftMimeType.JPEG]: DriveEntity.Image,
  [MicrosoftMimeType.PNG]: DriveEntity.Image,
  [MicrosoftMimeType.Zip]: DriveEntity.Zip,
  [MicrosoftMimeType.WordDocumentLegacy]: DriveEntity.WordDocument,
  [MicrosoftMimeType.ExcelSpreadsheetLegacy]: DriveEntity.ExcelSpreadsheet,
  [MicrosoftMimeType.PowerPointPresentationLegacy]:
    DriveEntity.PowerPointPresentation,
  [MicrosoftMimeType.CSV]: DriveEntity.CSV,
}
