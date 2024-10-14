import type { GaxiosResponse } from "gaxios"
import { type GoogleClient, type GoogleServiceAccount } from "@/types"
import { docs_v1, drive_v3, google } from "googleapis"
import {
  extractFootnotes,
  extractHeadersAndFooters,
  extractText,
  postProcessText,
} from "@/doc"
import { chunkDocument } from "@/chunks"
import { getExtractor } from "@/embedding"
import { Apps, DriveEntity } from "@/shared/types"
import { JWT } from "google-auth-library"
import { scopes } from "@/integrations/google/config"
import type { VespaFileWithDrivePermission } from "@/search/types"

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
}

export class DocsParsingError extends Error {}

export const getFile = async (
  client: GoogleClient,
  fileId: string,
): Promise<drive_v3.Schema$File> => {
  console.log("getFile")
  const drive = google.drive({ version: "v3", auth: client })
  const fields =
    "id, webViewLink, createdTime, modifiedTime, name, owners, fileExtension, mimeType, permissions(id, type, emailAddress)"
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
  const extractor = await getExtractor()
  console.log("getFileContent")
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
  // let title_embedding = (await extractor(doc.name, { pooling: 'mean', normalize: true })).tolist()[0]
  let chunkMap: Record<string, number[]> = {}
  for (const c of chunks) {
    const { chunk, chunkIndex } = c
    chunkMap[chunkIndex] = (
      await extractor(chunk, { pooling: "mean", normalize: true })
    ).tolist()[0]
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
    // TODO: fix this correctly
    // @ts-ignore
    chunk_embeddings: chunkMap,
    permissions: file.permissions ?? [],
    mimeType: file.mimeType ?? "",
  }
}

export const driveFileToIndexed = (
  file: drive_v3.Schema$File,
): VespaFileWithDrivePermission => {
  let entity = mimeTypeMap[file.mimeType!] ?? DriveEntity.Misc

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
    // TODO: fix this correctly
    // @ts-ignore
    chunk_embeddings: {},
    permissions: file.permissions ?? [],
    mimeType: file.mimeType ?? "",
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
