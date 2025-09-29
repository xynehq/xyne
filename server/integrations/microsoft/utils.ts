import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import type { MicrosoftGraphClient } from "./client"
import { downloadFileFromGraph, makeGraphApiCall } from "./client"
import { Apps, DriveEntity } from "@/shared/types"
import { chunkDocument } from "@/chunks"
import { MAX_ONEDRIVE_FILE_SIZE } from "./config"
import type {
  AuthenticationProvider,
  Client,
} from "@microsoft/microsoft-graph-client"
import { ClientSecretCredential, type AccessToken } from "@azure/identity"
import type { Permission, DriveItem } from "@microsoft/microsoft-graph-types"
import { extractTextAndImagesWithChunksFromDocx } from "@/docxChunks"
import { hashPdfFilename } from "@/utils"
import type { VespaFileWithDrivePermission } from "@xyne/vespa-ts/types"
import fs from "node:fs"
import path from "node:path"
import { unlink } from "node:fs/promises"
import type { Document } from "@langchain/core/documents"
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf"

export const loggerWithChild = getLoggerWithChild(Subsystem.Integrations, {
  module: "microsoft",
})

const Logger = getLogger(Subsystem.Integrations).child({ module: "microsoft" })

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
    throw new Error(`Error deleting file: ${(err as Error).message}`)
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

// Custom authentication provider for Microsoft Graph using ClientSecretCredential
export class CustomServiceAuthProvider implements AuthenticationProvider {
  private credential: ClientSecretCredential

  constructor(tenantId: string, clientId: string, clientSecret: string) {
    this.credential = new ClientSecretCredential(
      tenantId,
      clientId,
      clientSecret,
    )
  }

  async getAccessToken(): Promise<string> {
    const tokenResponse = await this.credential.getToken(
      "https://graph.microsoft.com/.default",
    )
    if (!tokenResponse) {
      throw new Error("Failed to get access token")
    }
    return tokenResponse.token
  }

  async getAccessTokenWithExpiry(): Promise<AccessToken> {
    const tokenResponse = await this.credential.getToken(
      "https://graph.microsoft.com/.default",
    )
    if (!tokenResponse) {
      throw new Error("Failed to get access token")
    }
    return tokenResponse
  }
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

export async function getFilePermissionsSharepoint(
  client: MicrosoftGraphClient,
  fileId: string,
  driveId: string,
): Promise<string[]> {
  const endpoint = `drives/${driveId}/items/${fileId}/permissions`

  try {
    const response = await makeGraphApiCall(client, endpoint)
    const permissions: string[] = []

    if (response.value && Array.isArray(response.value)) {
      const permissionsList = response.value as Permission[]
      for (const permission of permissionsList) {
        // Check for individual user permissions
        if (permission.grantedToV2?.siteUser?.loginName) {
          const loginName = permission.grantedToV2.siteUser.loginName
          // Extract email from loginName format: "i:0#.f|membership|email@domain.com"
          const emailMatch = loginName.match(/\|([^|]+@[^|]+)$/)
          if (emailMatch && emailMatch[1]) {
            permissions.push(emailMatch[1])
          }
        }

        // For site groups, we could add the group name as a permission identifier
        // if (permission.grantedToV2?.siteGroup?.displayName) {
        //   permissions.push(`group:${permission.grantedToV2.siteGroup.displayName}`)
        // }
      }
    }

    // Remove duplicates and return
    return Array.from(new Set(permissions))
  } catch (error) {
    loggerWithChild({ email: "system" }).error(
      error,
      `Error fetching SharePoint file permissions for ${fileId}: ${(error as Error).message}`,
    )
    return []
  }
}

//Get permissions for a file in one-drive or sharepoint
export async function getFilePermissions(
  client: MicrosoftGraphClient,
  fileId: string,
): Promise<string[]> {
  try {
    const endpoint = `me/drive/items/${fileId}/permissions`

    const response = await makeGraphApiCall(client, endpoint)

    const emails = new Set<string>()

    if (response.value && Array.isArray(response.value)) {
      for (const permission of response.value) {
        // Skip link-only permissions (no user identities)
        if (
          permission.link &&
          !permission.grantedToV2 &&
          !permission.grantedToIdentitiesV2
        ) {
          continue
        }

        // grantedToV2 (modern single user)
        if (permission.grantedToV2?.siteUser?.email) {
          emails.add(permission.grantedToV2.siteUser.email)
        } else if (permission.grantedToV2?.user?.email) {
          emails.add(permission.grantedToV2.user.email)
        } else if (permission.grantedToV2?.user?.userPrincipalName) {
          emails.add(permission.grantedToV2.user.userPrincipalName)
        }

        // grantedToIdentitiesV2 (modern multiple users)
        if (Array.isArray(permission.grantedToIdentitiesV2)) {
          for (const identity of permission.grantedToIdentitiesV2) {
            if (identity.siteUser?.email) {
              emails.add(identity.siteUser.email)
            } else if (identity.user?.email) {
              emails.add(identity.user.email)
            } else if (identity.user?.userPrincipalName) {
              emails.add(identity.user.userPrincipalName)
            }
          }
        }

        // grantedTo (legacy single user)
        if (permission.grantedTo?.user?.email) {
          emails.add(permission.grantedTo.user.email)
        } else if (permission.grantedTo?.user?.userPrincipalName) {
          emails.add(permission.grantedTo.user.userPrincipalName)
        }

        // grantedToIdentities (legacy multiple users)
        if (Array.isArray(permission.grantedToIdentities)) {
          for (const identity of permission.grantedToIdentities) {
            if (identity.user?.email) {
              emails.add(identity.user.email)
            } else if (identity.user?.userPrincipalName) {
              emails.add(identity.user.userPrincipalName)
            }
          }
        }
      }
    }

    return [...emails] // convert Set to array
  } catch (error) {
    Logger.warn(
      `Failed to get permissions for file ${fileId}: ${(error as Error).message}`,
    )
    return []
  }
}

// Process Microsoft PDF files (similar to googlePDFsVespa)
async function processMicrosoftPDFs(
  graphClient: MicrosoftGraphClient,
  pdfFiles: DriveItem[],
  userEmail: string,
): Promise<VespaFileWithDrivePermission[]> {
  const results: VespaFileWithDrivePermission[] = []

  for (const file of pdfFiles) {
    try {
      // Download PDF content
      const pdfBuffer = await downloadFileFromGraph(
        graphClient,
        file.id!,
        file.parentReference?.driveId!,
      )

      // Save temporarily (reuse Google's download directory pattern)
      const pdfFileName = `${hashPdfFilename(`${userEmail}_${file.id}_${file.name}`)}.pdf`
      const pdfPath = `${downloadDir}/${pdfFileName}`

      // Write buffer to file
      await fs.promises.writeFile(pdfPath, new Uint8Array(pdfBuffer))

      // Use existing PDF processing utilities
      const docs = await safeLoadPDF(pdfPath)
      if (!docs || docs.length === 0) {
        await deleteDocument(pdfPath)
        continue
      }

      // Use existing chunking utilities
      const chunks = docs.flatMap((doc: Document) =>
        chunkDocument(doc.pageContent),
      )

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
          size: file.size,
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
  graphClient: MicrosoftGraphClient,
  wordFiles: DriveItem[],
  userEmail: string,
): Promise<VespaFileWithDrivePermission[]> {
  const results: VespaFileWithDrivePermission[] = []

  for (const file of wordFiles) {
    try {
      // Download DOCX content
      const docxBuffer = await downloadFileFromGraph(
        graphClient,
        file.id!,
        file.parentReference?.driveId!,
      )

      // Use existing DOCX processing utilities from server/docxChunks.ts
      const extractedContent =
        await extractTextAndImagesWithChunksFromDocx(docxBuffer)

      results.push({
        title: file.name!,
        url: file.webUrl ?? "",
        app: graphClient.refreshToken
          ? Apps.MicrosoftDrive
          : Apps.MicrosoftSharepoint,
        docId: file.id!,
        parentId: file.parentReference?.id ?? null,
        owner: "",
        photoLink: "",
        ownerEmail: userEmail,
        entity: DriveEntity.WordDocument, // Reuse Google's entity types
        chunks: extractedContent.text_chunks || [], // Use text_chunks property
        permissions: [],
        mimeType: file.file?.mimeType ?? "",
        metadata: JSON.stringify({
          parentPath: file.parentReference?.path,
          size: file.size,
          images: extractedContent.image_chunks?.length || 0, // Use image_chunks property
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
// TODO: failing for huge excel files
async function processMicrosoftExcel(
  graphClient: Client,
  excelFiles: DriveItem[],
  userEmail: string,
): Promise<VespaFileWithDrivePermission[]> {
  const results: VespaFileWithDrivePermission[] = []

  for (const file of excelFiles) {
    try {
      const base = file.parentReference?.driveId
        ? `/drives/${file.parentReference.driveId}/items`
        : `/me/drive/items`

      // Use Microsoft Graph API to get workbook data
      const workbook = await graphClient
        .api(`${base}/${file.id}/workbook/worksheets`)
        .get()

      const chunks: string[] = []

      for (const worksheet of workbook.value) {
        try {
          // Get worksheet data
          const worksheetData = await graphClient
            .api(
              `${base}/${file.id}/workbook/worksheets/${worksheet.id}/usedRange`,
            )
            .get()

          if (worksheetData.values) {
            // Process similar to Google Sheets - filter textual content
            const textualContent = worksheetData.values
              .flat()
              .filter(
                (cell: any) =>
                  cell && typeof cell === "string" && isNaN(Number(cell)),
              )
              .join(" ")

            if (textualContent.length > 0) {
              const worksheetChunks = chunkDocument(textualContent)
              chunks.push(...worksheetChunks.map((c: any) => c.chunk))
            }
          }
        } catch (worksheetError) {
          console.error(
            `Error processing worksheet ${worksheet.name}:`,
            worksheetError,
          )
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
        entity: DriveEntity.ExcelSpreadsheet,
        chunks,
        permissions: [],
        mimeType: file.file?.mimeType ?? "",
        metadata: JSON.stringify({
          parentPath: file.parentReference?.path,
          size: file.size,
          worksheetCount: workbook.value?.length || 0,
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

export async function processFileContent(
  graphClient: MicrosoftGraphClient,
  file: DriveItem,
  userEmail: string,
): Promise<string[]> {
  const mimeType = file.file?.mimeType

  try {
    switch (mimeType) {
      case "application/pdf":
        const pdfResults = await processMicrosoftPDFs(
          graphClient,
          [file],
          userEmail,
        )
        return pdfResults[0]?.chunks || []

      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        const wordResults = await processMicrosoftWord(
          graphClient,
          [file],
          userEmail,
        )
        return wordResults[0]?.chunks || []

      case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        //TODO: breaking for huge excel files, response limit reached
        // const excelResults = await processMicrosoftExcel(
        //   graphClient.client,
        //   [file],
        //   userEmail,
        // )
        // return excelResults[0]?.chunks || []
        return []

      default:
        // For unsupported file types, return empty chunks (metadata only)
        return []
    }
  } catch (error) {
    console.error(`Error processing file content for ${file.name}:`, error)
    return [] // Fallback to metadata only on error
  }
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
