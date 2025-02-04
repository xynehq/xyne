import type { GaxiosError, GaxiosResponse } from "gaxios"
import {
  Subsystem,
  type GoogleClient,
  type GoogleServiceAccount,
} from "@/types"
import { docs_v1, drive_v3, gmail_v1, google } from "googleapis"
import {
  extractFootnotes,
  extractHeadersAndFooters,
  extractText,
  postProcessText,
} from "@/doc"
import { chunkDocument } from "@/chunks"
import { Apps, DriveEntity } from "@/shared/types"
import { JWT } from "google-auth-library"
import {
  MAX_ATTACHMENT_PDF_SIZE,
  MAX_GD_PDF_SIZE,
  scopes,
} from "@/integrations/google/config"
import type { Attachment, VespaFileWithDrivePermission } from "@/search/types"
import { DownloadDocumentError } from "@/errors"
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf"
import type { Document } from "@langchain/core/documents"
import {
  deleteDocument,
  downloadDir,
  downloadPDF,
  getSheetsListFromOneSpreadsheet,
  safeLoadPDF,
} from "@/integrations/google"
import { getLogger } from "@/logger"
import type PgBoss from "pg-boss"
import fs from "node:fs/promises"
import path from "path"
import { retryWithBackoff } from "@/utils"

const Logger = getLogger(Subsystem.Integrations).child({ module: "google" })

// TODO: make it even more extensive
export const mimeTypeMap: Record<string, DriveEntity> = {
  "application/vnd.google-apps.document": DriveEntity.Docs,
  "application/vnd.google-apps.spreadsheet": DriveEntity.Sheets,
  "application/vnd.google-apps.presentation": DriveEntity.Presentation,
  "application/vnd.google-apps.folder": DriveEntity.Folder,
  "application/vnd.google-apps.drawing": DriveEntity.Drawing,
  "application/vnd.google-apps.form": DriveEntity.Form,
  "application/vnd.google-apps.script": DriveEntity.Script,
  "application/vnd.google-apps.site": DriveEntity.Site,
  "application/vnd.google-apps.map": DriveEntity.Map,
  "application/vnd.google-apps.audio": DriveEntity.Audio,
  "application/vnd.google-apps.video": DriveEntity.Video,
  "application/vnd.google-apps.photo": DriveEntity.Photo,
  "application/vnd.google-apps.drive-sdk": DriveEntity.ThirdPartyApp,
  "application/pdf": DriveEntity.PDF,
  "image/jpeg": DriveEntity.Image,
  "image/png": DriveEntity.Image,
  "application/zip": DriveEntity.Zip,
  "application/msword": DriveEntity.WordDocument,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    DriveEntity.WordDocument,
  "application/vnd.ms-excel": DriveEntity.ExcelSpreadsheet,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    DriveEntity.ExcelSpreadsheet,
  "application/vnd.ms-powerpoint": DriveEntity.PowerPointPresentation,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    DriveEntity.PowerPointPresentation,
  "text/plain": DriveEntity.Text,
  "text/csv": DriveEntity.CSV,
}

export enum DriveMime {
  Docs = "application/vnd.google-apps.document",
  Sheets = "application/vnd.google-apps.spreadsheet",
  Slides = "application/vnd.google-apps.presentation",
  PDF = "application/pdf",
}

export const MimeMapForContent: Record<string, boolean> = {
  [DriveMime.Docs]: true,
  [DriveMime.PDF]: true,
  [DriveMime.Sheets]: true,
  [DriveMime.Slides]: true,
}

export class DocsParsingError extends Error {}

export const getFile = async (
  client: GoogleClient,
  fileId: string,
): Promise<drive_v3.Schema$File> => {
  const drive = google.drive({ version: "v3", auth: client })
  const fields =
    "id, webViewLink, createdTime, modifiedTime, name, size, parents, owners, fileExtension, mimeType, permissions(id, type, emailAddress)"
  const file: GaxiosResponse<drive_v3.Schema$File> = await drive.files.get({
    fileId,
    fields,
  })

  return file.data
}

export const getFileContent = async (
  client: GoogleClient,
  file: drive_v3.Schema$File,
  entity: DriveEntity,
): Promise<VespaFileWithDrivePermission> => {
  const docs = google.docs({ version: "v1", auth: client })
  const docResponse: GaxiosResponse<docs_v1.Schema$Document> =
    await docs.documents.get({
      documentId: file.id as string,
    })
  if (!docResponse || !docResponse.data) {
    throw new DocsParsingError(
      `Could not get document content for file: ${file.id}`,
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
  if (file?.parents) {
    for (const parentId of file.parents!) {
      const parentData = await getFile(client, parentId)
      const folderName = parentData.name!
      parentsForMetadata.push({ folderName, folderId: parentId })
    }
  }

  return {
    title: file.name!,
    url: file.webViewLink ?? "",
    app: Apps.GoogleDrive,
    docId: file.id!,
    owner: file.owners ? (file.owners[0].displayName ?? "") : "",
    photoLink: file.owners ? (file.owners[0].photoLink ?? "") : "",
    ownerEmail: file.owners ? (file.owners[0]?.emailAddress ?? "") : "",
    entity,
    chunks: chunks.map((v) => v.chunk),
    permissions: file.permissions ?? [],
    mimeType: file.mimeType ?? "",
    metadata: JSON.stringify({ parents: parentsForMetadata }),
    createdAt: new Date(file.createdTime!).getTime(),
    updatedAt: new Date(file.modifiedTime!).getTime(),
  }
}

export const getPDFContent = async (
  client: GoogleClient,
  pdfFile: drive_v3.Schema$File,
  entity: DriveEntity,
): Promise<VespaFileWithDrivePermission | void> => {
  const drive = google.drive({ version: "v3", auth: client })
  const pdfSizeInMB = parseInt(pdfFile.size!) / (1024 * 1024)
  // Ignore the PDF files larger than Max PDF Size
  if (pdfSizeInMB > MAX_GD_PDF_SIZE) {
    Logger.error(`Ignoring ${pdfFile.name} as its more than 20 MB`)
    return
  }
  try {
    await downloadPDF(drive, pdfFile.id!, pdfFile.name!)
    const pdfPath = `${downloadDir}/${pdfFile?.name}`
    let docs: Document[] = []

    const loader = new PDFLoader(pdfPath)
    docs = await loader.load()

    if (!docs || docs.length === 0) {
      Logger.warn(
        `Could not get content for file: ${pdfFile.name}. Skipping it`,
      )
      await deleteDocument(pdfPath)
      return
    }

    const chunks = docs.flatMap((doc) => chunkDocument(doc.pageContent))

    const parentsForMetadata = []
    if (pdfFile?.parents) {
      for (const parentId of pdfFile.parents!) {
        const parentData = await getFile(client, parentId)
        const folderName = parentData.name!
        parentsForMetadata.push({ folderName, folderId: parentId })
      }
    }

    // Deleting document
    await deleteDocument(pdfPath)
    return {
      title: pdfFile.name!,
      url: pdfFile.webViewLink ?? "",
      app: Apps.GoogleDrive,
      docId: pdfFile.id!,
      owner: pdfFile.owners ? (pdfFile.owners[0].displayName ?? "") : "",
      photoLink: pdfFile.owners ? (pdfFile.owners[0].photoLink ?? "") : "",
      ownerEmail: pdfFile.owners ? (pdfFile.owners[0]?.emailAddress ?? "") : "",
      entity,
      chunks: chunks.map((v) => v.chunk),
      permissions: pdfFile.permissions ?? [],
      mimeType: pdfFile.mimeType ?? "",
      metadata: JSON.stringify({ parents: parentsForMetadata }),
      createdAt: new Date(pdfFile.createdTime!).getTime(),
      updatedAt: new Date(pdfFile.modifiedTime!).getTime(),
    }
  } catch (error) {
    Logger.error(
      error,
      `Error getting file: ${error} ${(error as Error).stack}`,
      error,
    )

    // previously sync was breaking for these 2 cases
    // so we return null (TODO: confirm if we ingest atleast the metadata)
    if (
      (error as Error).message === "No password given" &&
      (error as any).code === 1
    ) {
      return
    } else if (
      (error as Error).message === "Permission denied" &&
      (error as GaxiosError).code === "EACCES"
    ) {
      // this is pdf someone else has shared but we don't have access to download it
      return
    }

    throw new DownloadDocumentError({
      message: "Error in getting file content",
      cause: error as Error,
      integration: Apps.GoogleDrive,
      entity: DriveEntity.PDF,
    })
  }
}

export const getSheetsFromSpreadSheet = async (
  client: GoogleClient,
  spreadsheet: drive_v3.Schema$File,
  entity: DriveEntity,
): Promise<VespaFileWithDrivePermission[]> => {
  try {
    const sheets = google.sheets({ version: "v4", auth: client })
    const sheetsListFromOneSpreadsheet = await getSheetsListFromOneSpreadsheet(
      sheets,
      client,
      spreadsheet,
    )

    return sheetsListFromOneSpreadsheet
  } catch (err) {
    Logger.error(err, `Error in catch of getSheetsFromSpreadSheet`, err)
    return []
  }
}

export const driveFileToIndexed = async (
  client: GoogleClient,
  file: drive_v3.Schema$File,
): Promise<VespaFileWithDrivePermission> => {
  let entity = mimeTypeMap[file.mimeType!] ?? DriveEntity.Misc

  const parentsForMetadata = []
  if (file?.parents) {
    for (const parentId of file.parents!) {
      const parentData = await getFile(client, parentId)
      const folderName = parentData.name!
      parentsForMetadata.push({ folderName, folderId: parentId })
    }
  }

  // TODO: fix this correctly
  // @ts-ignore
  return {
    title: file.name!,
    url: file.webViewLink ?? "",
    app: Apps.GoogleDrive,
    docId: file.id!,
    entity,
    chunks: [],
    owner: file.owners ? (file.owners[0].displayName ?? "") : "",
    photoLink: file.owners ? (file.owners[0].photoLink ?? "") : "",
    ownerEmail: file.owners ? (file.owners[0]?.emailAddress ?? "") : "",
    permissions: file.permissions ?? [],
    mimeType: file.mimeType ?? "",
    metadata: JSON.stringify({ parents: parentsForMetadata }),
    createdAt: new Date(file.createdTime!).getTime(),
    updatedAt: new Date(file.modifiedTime!).getTime(),
  }
}

// we need to support alias?
export const toPermissionsList = (
  drivePermissions: drive_v3.Schema$Permission[] | undefined,
  ownerEmail: string,
): string[] => {
  if (!drivePermissions) {
    return [ownerEmail]
  }
  let permissions = []
  if (drivePermissions && drivePermissions.length) {
    permissions = drivePermissions
      .filter(
        (p) => p.type === "user" || p.type === "group" || p.type === "domain",
      )
      .map((p) => {
        if (p.type === "domain") {
          return "domain"
        }
        return p.emailAddress
      })
  } else {
    // permissions don't exist for you
    // but the user who is able to fetch
    // the metadata, can read it
    permissions = [ownerEmail]
  }
  return permissions as string[]
}

export const createJwtClient = (
  serviceAccountKey: GoogleServiceAccount,
  subject: string,
): JWT => {
  return new JWT({
    email: serviceAccountKey.client_email,
    key: serviceAccountKey.private_key,
    scopes,
    subject,
  })
}

export const checkDownloadsFolder = async (
  boss: PgBoss,
  job: PgBoss.Job<any>,
) => {
  Logger.info("Checking downloads folder...")

  try {
    // Read the contents of the downloads directory
    const files = await fs.readdir(downloadDir)

    if (files.length === 0) {
      Logger.info("No files found in downloads folder.")
      return
    }

    Logger.info(
      `Found ${files.length} file(s) in downloads folder. Deleting...`,
    )

    // Loop through each file and delete it
    for (const file of files) {
      const filePath = path.join(downloadDir, file)
      await fs.unlink(filePath)
      Logger.info(`Deleted file: ${filePath}`)
    }

    Logger.info("All files deleted successfully.")
  } catch (error) {
    Logger.error(
      error,
      `Error checking or deleting files in downloads folder: ${error} ${(error as Error).stack}`,
    )
  }
}
