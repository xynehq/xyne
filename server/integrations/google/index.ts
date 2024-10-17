import { admin_directory_v1, docs_v1, drive_v3, google } from "googleapis"
import {
  extractFootnotes,
  extractHeadersAndFooters,
  extractText,
  postProcessText,
} from "@/doc"
import { chunkDocument } from "@/chunks"
import {
  Subsystem,
  SyncCron,
  type ChangeToken,
  type GoogleClient,
  type GoogleServiceAccount,
  type SaaSJob,
  type SaaSOAuthJob,
} from "@/types"
import PgBoss from "pg-boss"
import { getConnector, getOAuthConnectorWithCredentials } from "@/db/connector"
import { getExtractor } from "@/embedding"
import {
  DeleteDocument,
  GetDocument,
  insertDocument,
  insertUser,
  UpdateDocumentPermissions,
} from "@/search/vespa"
import { SaaSQueue } from "@/queue"
import { wsConnections } from "@/server"
import type { WSContext } from "hono/ws"
import { db } from "@/db/client"
import { connectors, type SelectConnector } from "@/db/schema"
import { eq } from "drizzle-orm"
import { getWorkspaceByEmail } from "@/db/workspace"
import {
  Apps,
  AuthType,
  ConnectorStatus,
  SyncJobStatus,
  DriveEntity,
  GooglePeopleEntity,
} from "@/shared/types"
import type { GoogleTokens } from "arctic"
import { getAppSyncJobs, insertSyncJob, updateSyncJob } from "@/db/syncJob"
import { getUserById } from "@/db/user"
import type { GaxiosResponse } from "gaxios"
import { insertSyncHistory } from "@/db/syncHistory"
import { getErrorMessage } from "@/utils"
import {
  createJwtClient,
  DocsParsingError,
  driveFileToIndexed,
  DriveMime,
  mimeTypeMap,
  toPermissionsList,
} from "@/integrations/google/utils"
import { getLogger } from "@/logger"
import type { VespaFileWithDrivePermission } from "@/search/types"
import { UserListingError, CouldNotFinishJobSuccessfully } from "@/errors"
import fs from "node:fs"
import path from "node:path"
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf"
import fileSys from "node:fs/promises"
import type { Document } from "@langchain/core/documents"

const Logger = getLogger(Subsystem.Integrations).child({ module: "google" })

export type GaxiosPromise<T = any> = Promise<GaxiosResponse<T>>

const listUsers = async (
  admin: admin_directory_v1.Admin,
  domain: string,
): Promise<admin_directory_v1.Schema$User[]> => {
  let users: admin_directory_v1.Schema$User[] = []
  let nextPageToken = null
  try {
    do {
      const res: GaxiosResponse<admin_directory_v1.Schema$Users> =
        await admin.users.list({
          domain: domain,
          maxResults: 500,
          orderBy: "email",
          ...(nextPageToken ? { pageToken: nextPageToken } : {}),
        })
      if (res.data.users) {
        users = users.concat(res.data.users)
      }

      nextPageToken = res.data.nextPageToken
    } while (nextPageToken)
    return users
  } catch (error) {
    Logger.error(`Error listing users:", ${error}`)
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

    const workspace = await getWorkspaceByEmail(db, subject)
    // TODO: handle multiple domains
    const users = await listUsers(admin, workspace.domain)

    const updatedCount = users.length
    // TODO: better handle the data stats
    await insertUsersForWorkspace(users)
    await db.transaction(async (trx) => {
      await updateSyncJob(trx, syncJob.id, {
        config: { updatedAt: new Date() },
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
        config: { updatedAt: new Date().toISOString() },
        type: SyncCron.FullSync,
        lastRanOn: new Date(),
      })
    })
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    Logger.error("Could not sync Google workspace: ", errorMessage)
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
      config: { updatedAt: new Date().toISOString() },
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

export const handleGoogleOAuthIngestion = async (
  boss: PgBoss,
  job: PgBoss.Job<any>,
) => {
  Logger.info("handleGoogleServiceAccountIngestion", job.data)
  const data: SaaSOAuthJob = job.data as SaaSOAuthJob
  try {
    // we will first fetch the change token
    // and poll the changes in a new Cron Job
    const connector: SelectConnector = await getOAuthConnectorWithCredentials(
      db,
      data.connectorId,
    )
    const userEmail = job.data.email
    const oauthTokens: GoogleTokens = connector.oauthCredentials
    const oauth2Client = new google.auth.OAuth2()
    // we have guarantee that when we started this job access Token at least
    // hand one hour, we should increase this time
    oauth2Client.setCredentials({ access_token: oauthTokens.accessToken })
    const driveClient = google.drive({ version: "v3", auth: oauth2Client })
    // get change token for any changes during drive integration
    const { startPageToken }: drive_v3.Schema$StartPageToken = (
      await driveClient.changes.getStartPageToken()
    ).data
    if (!startPageToken) {
      throw new Error("Could not get start page token")
    }
    await insertFilesForUser(oauth2Client, userEmail, connector)
    const changeToken = {
      token: startPageToken,
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
        config: changeToken,
        email: userEmail,
        type: SyncCron.ChangeToken,
        status: SyncJobStatus.NotStarted,
      })
      await boss.complete(SaaSQueue, job.id)
      Logger.info("job completed")
    })
  } catch (error) {
    Logger.error("could not finish job successfully", error)
    await db.transaction(async (trx) => {
      trx
        .update(connectors)
        .set({
          status: ConnectorStatus.Failed,
        })
        .where(eq(connectors.id, data.connectorId))
      await boss.fail(job.name, job.id)
    })
    throw new CouldNotFinishJobSuccessfully({
      message: "Could not finish Oauth ingestion",
      integration: Apps.GoogleDrive,
      entity: "files",
      cause: error as Error,
    })
  }
}

type ChangeList = { email: string; changeToken: string }

export const handleGoogleServiceAccountIngestion = async (
  boss: PgBoss,
  job: PgBoss.Job<any>,
) => {
  Logger.info("handleGoogleServiceAccountIngestion", job.data)
  const data: SaaSJob = job.data as SaaSJob
  try {
    const connector = await getConnector(db, data.connectorId)
    const serviceAccountKey: GoogleServiceAccount = JSON.parse(
      connector.credentials as string,
    )
    const subject: string = connector.subject as string
    let jwtClient = createJwtClient(serviceAccountKey, subject)
    const admin = google.admin({ version: "directory_v1", auth: jwtClient })

    const workspace = await getWorkspaceByEmail(db, subject)
    // TODO: handle multiple domains
    const users = await listUsers(admin, workspace.domain)
    const userEmails: ChangeList[] = []
    for (const [index, user] of users.entries()) {
      const userEmail = user.primaryEmail || user.emails[0]
      jwtClient = createJwtClient(serviceAccountKey, userEmail)
      const driveClient = google.drive({ version: "v3", auth: jwtClient })
      const { startPageToken }: drive_v3.Schema$StartPageToken = (
        await driveClient.changes.getStartPageToken()
      ).data
      if (!startPageToken) {
        throw new Error("Could not get start page token")
      }
      sendWebsocketMessage(
        `${((index + 1) / users.length) * 100}% user's data is connected`,
        connector.externalId,
      )
      userEmails.push({ email: userEmail, changeToken: startPageToken })
      await insertFilesForUser(jwtClient, userEmail, connector)
      // insert that user
    }
    // insert all the workspace users
    await insertUsersForWorkspace(users)

    await db.transaction(async (trx) => {
      for (const { email, changeToken } of userEmails) {
        await insertSyncJob(trx, {
          workspaceId: connector.workspaceId,
          workspaceExternalId: connector.workspaceExternalId,
          app: Apps.GoogleDrive,
          connectorId: connector.id,
          authType: AuthType.ServiceAccount,
          config: {
            token: changeToken,
            lastSyncedAt: new Date().toISOString(),
          },
          email,
          type: SyncCron.ChangeToken,
          status: SyncJobStatus.NotStarted,
        })
      }
      await insertSyncJob(trx, {
        workspaceId: connector.workspaceId,
        workspaceExternalId: connector.workspaceExternalId,
        app: Apps.GoogleWorkspace,
        connectorId: connector.id,
        authType: AuthType.ServiceAccount,
        config: { updatedAt: new Date().toISOString() },
        email: "",
        type: SyncCron.FullSync,
        status: SyncJobStatus.NotStarted,
      })
      await trx
        .update(connectors)
        .set({
          status: ConnectorStatus.Connected,
        })
        .where(eq(connectors.id, connector.id))
      Logger.info("status updated")
      await boss.complete(SaaSQueue, job.id)
      Logger.info("job completed")
    })
  } catch (e) {
    Logger.error("could not finish job successfully", e)
    await db.transaction(async (trx) => {
      trx
        .update(connectors)
        .set({
          status: ConnectorStatus.Failed,
        })
        .where(eq(connectors.id, data.connectorId))
      await boss.fail(job.name, job.id)
    })
    throw new CouldNotFinishJobSuccessfully({
      message: "Could not finish Oauth ingestion",
      integration: Apps.GoogleWorkspace,
      entity: "files and users",
      cause: e as Error,
    })
  }
}

const deleteDocument = async (filePath: string) => {
  try {
    await fileSys.unlink(filePath) // Delete the file at the provided path
    console.log(`File at ${filePath} deleted successfully`)
  } catch (err) {
    console.error(`Error deleting file at ${filePath}:`, err)
    throw new Error("File deletion failed")
  }
}

const insertFilesForUser = async (
  googleClient: GoogleClient,
  userEmail: string,
  connector: SelectConnector,
) => {
  try {
    const fileMetadata = await listFiles(googleClient)
    const totalFiles = fileMetadata.length
    const ws: WSContext = wsConnections.get(connector.externalId)
    if (ws) {
      ws.send(
        JSON.stringify({
          totalFiles,
          message: `${totalFiles} metadata files ingested`,
        }),
      )
    }
    const googleDocsMetadata = fileMetadata.filter(
      (v) => v.mimeType === DriveMime.Docs,
    )
    const googlePDFsMetadata = fileMetadata.filter(
      (v) => v.mimeType === DriveMime.PDF,
    )
    const googleSheetsMetadata = fileMetadata.filter(
      (v) => v.mimeType === DriveMime.Sheets,
    )
    const googleSlidesMetadata = fileMetadata.filter(
      (v) => v.mimeType === DriveMime.Slides,
    )
    const rest = fileMetadata.filter(
      (v) => v.mimeType !== DriveMime.Docs && v.mimeType !== DriveMime.PDF,
    )

    const documents: VespaFileWithDrivePermission[] = await googleDocsVespa(
      googleClient,
      googleDocsMetadata,
      connector.externalId,
    )
    const pdfDocuments: VespaFileWithDrivePermission[] = await googlePDFsVespa(
      googleClient,
      googlePDFsMetadata,
      connector.externalId,
    )
    const driveFiles: VespaFileWithDrivePermission[] =
      await driveFilesToDoc(rest)

    sendWebsocketMessage("generating embeddings", connector.externalId)
    let allFiles: VespaFileWithDrivePermission[] = [
      ...driveFiles,
      ...documents,
      ...pdfDocuments,
    ].map((v) => {
      v.permissions = toPermissionsList(v.permissions, userEmail)
      return v
    })

    for (const doc of allFiles) {
      await insertDocument(doc)
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    Logger.error("Could not insert files for user: ", errorMessage)
  }
}

const downloadPDF = async (
  drive: drive_v3.Drive,
  fileId: string,
  fileName: string,
) => {
  const downloadDir = path.resolve(__dirname, "../../downloads")

  if (!fs.existsSync(downloadDir)) {
    // Check if the downloads directory exists, create it if it doesn't
    fs.mkdirSync(downloadDir, { recursive: true })
  }

  const dest = fs.createWriteStream(path.join(downloadDir, fileName))
  const res = await drive.files.get(
    { fileId: fileId, alt: "media" },
    { responseType: "stream" },
  )
  return new Promise<void>((resolve, reject) => {
    res.data
      .on("end", () => {
        console.log(`Downloaded ${fileName}`)
        resolve()
      })
      .on("error", (err) => {
        console.error("Error downloading file.")
        reject(err)
      })
      .pipe(dest)
  })
}

export const googlePDFsVespa = async (
  client: GoogleClient,
  pdfsMetadata: drive_v3.Schema$File[],
  connectorId: string,
): Promise<VespaFileWithDrivePermission[]> => {
  const extractor = await getExtractor()
  sendWebsocketMessage(
    `Scanning ${pdfsMetadata.length} Google PDFs`,
    connectorId,
  )
  const pdfsList: VespaFileWithDrivePermission[] = []
  const drive = google.drive({ version: "v3", auth: client })
  const total = pdfsMetadata.length
  let count = 0
  for (const pdf of pdfsMetadata) {
    const pdfSizeInMB = parseInt(pdf.size!) / (1024 * 1024)
    // Ignore the PDF files larger than 20MB
    if (pdfSizeInMB > 20) {
      console.log(`Ignoring ${pdf.name} as its more than 20 MB`)
      continue
    }
    try {
      await downloadPDF(drive, pdf.id!, pdf.name!)
    } catch (error) {
      console.error("An error occurred while downloading the PDF:", error)
    }
    const pdfPath = path.resolve(__dirname, `../../downloads/${pdf?.name}`)
    let docs: Document[] = []
    try {
      const loader = new PDFLoader(pdfPath)
      docs = await loader.load()
    } catch (error) {
      console.error("Error occured while parsing PDF:", error)
    }

    if (!docs || docs.length === 0) {
      console.error(`Could not get content for file: ${pdf.name}. Skipping it`)
      try {
        await deleteDocument(pdfPath)
      } catch (err) {
        console.error(`Error occured while deleting ${pdf.name}`, err)
      }
      continue
    }

    const chunks = docs.flatMap((doc) => chunkDocument(doc.pageContent))
    let chunkMap: Record<string, number[]> = {}
    for (const c of chunks) {
      const { chunk, chunkIndex } = c
      chunkMap[chunkIndex] = (
        await extractor(chunk, { pooling: "mean", normalize: true })
      ).tolist()[0]
    }
    pdfsList.push({
      title: pdf.name!,
      url: pdf.webViewLink ?? "",
      app: Apps.GoogleDrive,
      docId: pdf.id!,
      owner: pdf.owners ? (pdf.owners[0].displayName ?? "") : "",
      photoLink: pdf.owners ? (pdf.owners[0].photoLink ?? "") : "",
      ownerEmail: pdf.owners ? (pdf.owners[0]?.emailAddress ?? "") : "",
      entity: DriveEntity.PDF,
      chunks: chunks.map((v) => v.chunk),
      // TODO: remove ts-ignore and fix correctly
      // @ts-ignore
      chunk_embeddings: chunkMap,
      permissions: pdf.permissions ?? [],
      mimeType: pdf.mimeType ?? "",
    })
    count += 1

    if (count % 5 === 0) {
      sendWebsocketMessage(`${count} Google PDFs scanned`, connectorId)
      process.stdout.write(`${Math.floor((count / total) * 100)}`)
      process.stdout.write("\n")
    }
    // Deleting document
    try {
      await deleteDocument(pdfPath)
    } catch (err) {
      console.error(`Error occured while deleting ${pdf.name}`, err)
    }
  }
  return pdfsList
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
      langauge: preferredLanguage,
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

export const listFiles = async (
  client: GoogleClient,
  onlyDocs: boolean = false,
): Promise<drive_v3.Schema$File[]> => {
  const drive = google.drive({ version: "v3", auth: client })
  let nextPageToken = null
  let files: drive_v3.Schema$File[] = []
  do {
    const res: GaxiosResponse<drive_v3.Schema$FileList> =
      await drive.files.list({
        pageSize: 100,
        ...(onlyDocs
          ? { q: "mimeType='application/vnd.google-apps.document'" }
          : {}),
        fields:
          "nextPageToken, files(id, webViewLink, size, createdTime, modifiedTime, name, owners, fileExtension, mimeType, permissions(id, type, emailAddress))",
        ...(nextPageToken ? { pageToken: nextPageToken } : {}),
      })

    if (res.data.files) {
      files = files.concat(res.data.files)
    }
    nextPageToken = res.data.nextPageToken
  } while (nextPageToken)
  return files
}

const sendWebsocketMessage = (message: string, connectorId: string) => {
  const ws: WSContext = wsConnections.get(connectorId)
  if (ws) {
    ws.send(JSON.stringify({ message }))
  }
}

export const googleDocsVespa = async (
  client: GoogleClient,
  docsMetadata: drive_v3.Schema$File[],
  connectorId: string,
): Promise<VespaFileWithDrivePermission[]> => {
  const extractor = await getExtractor()
  sendWebsocketMessage(
    `Scanning ${docsMetadata.length} Google Docs`,
    connectorId,
  )
  const docsList: VespaFileWithDrivePermission[] = []
  const docs = google.docs({ version: "v1", auth: client })
  const total = docsMetadata.length
  let count = 0
  for (const doc of docsMetadata) {
    const docResponse: GaxiosResponse<docs_v1.Schema$Document> =
      await docs.documents.get({
        documentId: doc.id as string,
      })
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

    const chunks = chunkDocument(cleanedTextContent)
    let chunkMap: Record<string, number[]> = {}
    for (const c of chunks) {
      const { chunk, chunkIndex } = c
      chunkMap[chunkIndex] = (
        await extractor(chunk, { pooling: "mean", normalize: true })
      ).tolist()[0]
    }
    docsList.push({
      title: doc.name!,
      url: doc.webViewLink ?? "",
      app: Apps.GoogleDrive,
      docId: doc.id!,
      owner: doc.owners ? (doc.owners[0].displayName ?? "") : "",
      photoLink: doc.owners ? (doc.owners[0].photoLink ?? "") : "",
      ownerEmail: doc.owners ? (doc.owners[0]?.emailAddress ?? "") : "",
      entity: DriveEntity.Docs,
      chunks: chunks.map((v) => v.chunk),
      // TODO: remove ts-ignore and fix correctly
      // @ts-ignore
      chunk_embeddings: chunkMap,
      permissions: doc.permissions ?? [],
      mimeType: doc.mimeType ?? "",
    })
    count += 1

    if (count % 5 === 0) {
      sendWebsocketMessage(`${count} Google Docs scanned`, connectorId)
      process.stdout.write(`${Math.floor((count / total) * 100)}`)
      process.stdout.write("\n")
    }
  }
  return docsList
}

export const driveFilesToDoc = async (
  rest: drive_v3.Schema$File[],
): Promise<VespaFileWithDrivePermission[]> => {
  let results: VespaFileWithDrivePermission[] = []
  for (const doc of rest) {
    results.push(driveFileToIndexed(doc))
  }
  return results
}
