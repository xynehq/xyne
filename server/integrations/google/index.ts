import {
  admin_directory_v1,
  docs_v1,
  drive_v3,
  google,
  people_v1,
  sheets_v4,
  slides_v1,
} from "googleapis"
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
  type GoogleClient,
  type GoogleServiceAccount,
  type SaaSJob,
  type SaaSOAuthJob,
} from "@/types"
import PgBoss from "pg-boss"
import { getConnector, getOAuthConnectorWithCredentials } from "@/db/connector"
import { insertDocument, insertUser } from "@/search/vespa"
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
import type { GaxiosResponse } from "gaxios"
import { insertSyncHistory } from "@/db/syncHistory"
import { getErrorMessage } from "@/utils"
import {
  createJwtClient,
  DocsParsingError,
  driveFileToIndexed,
  DriveMime,
  getFile,
  toPermissionsList,
} from "@/integrations/google/utils"
import { getLogger } from "@/logger"
import { type VespaFileWithDrivePermission } from "@/search/types"
import {
  UserListingError,
  CouldNotFinishJobSuccessfully,
  ContactListingError,
  ContactMappingError,
  ErrorInsertingDocument,
  DeleteDocumentError,
  DownloadDocumentError,
} from "@/errors"
import fs from "node:fs"
import path from "node:path"
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf"
import fileSys from "node:fs/promises"
import type { Document } from "@langchain/core/documents"
import {
  MAX_GD_PDF_SIZE,
  MAX_GD_SHEET_ROWS,
  MAX_GD_SHEET_TEXT_LEN,
} from "@/integrations/google/config"
import { handleGmailIngestion } from "@/integrations/google/gmail"
import pLimit from "p-limit"
import { GoogleDocsConcurrency } from "./config"
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
  Logger.info("handleGoogleOauthIngestion", job.data)
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
    const { contacts, otherContacts, contactsToken, otherContactsToken } =
      await listAllContacts(oauth2Client)
    await insertContactsToVespa(contacts, otherContacts, userEmail)
    // get change token for any changes during drive integration
    const { startPageToken }: drive_v3.Schema$StartPageToken = (
      await driveClient.changes.getStartPageToken()
    ).data
    if (!startPageToken) {
      throw new Error("Could not get start page token")
    }

    const [
      _,
      // historyId
    ] = await Promise.all([
      insertFilesForUser(oauth2Client, userEmail, connector),
      // handleGmailIngestion(oauth2Client, userEmail),
    ])
    const changeTokens = {
      driveToken: startPageToken,
      contactsToken,
      otherContactsToken,
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
        config: changeTokens,
        email: userEmail,
        type: SyncCron.ChangeToken,
        status: SyncJobStatus.NotStarted,
      })
      // await insertSyncJob(trx, {
      //   workspaceId: connector.workspaceId,
      //   workspaceExternalId: connector.workspaceExternalId,
      //   app: Apps.Gmail,
      //   connectorId: connector.id,
      //   authType: AuthType.OAuth,
      //   config: { historyId, lastSyncedAt: new Date().toISOString() },
      //   email: userEmail,
      //   type: SyncCron.ChangeToken,
      //   status: SyncJobStatus.NotStarted,
      // })
      await boss.complete(SaaSQueue, job.id)
      Logger.info("job completed")
    })
  } catch (error) {
    Logger.error(
      `could not finish job successfully: ${(error as Error).message} ${(error as Error).stack}`,
      error,
    )
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

type IngestionMetadata = {
  email: string
  driveToken: string
  contactsToken: string
  otherContactsToken: string
  // gmail
  historyId: string
}

// we make 2 sync jobs
// one for drive and one for google workspace
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
    const ingestionMetadata: IngestionMetadata[] = []
    for (const [index, user] of users.entries()) {
      const userEmail = user.primaryEmail || user.emails[0]
      jwtClient = createJwtClient(serviceAccountKey, userEmail)
      const driveClient = google.drive({ version: "v3", auth: jwtClient })
      const { contacts, otherContacts, contactsToken, otherContactsToken } =
        await listAllContacts(jwtClient)
      await insertContactsToVespa(contacts, otherContacts, userEmail)
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
      const [_, historyId] = await Promise.all([
        insertFilesForUser(jwtClient, userEmail, connector),
        handleGmailIngestion(jwtClient, userEmail),
      ])
      ingestionMetadata.push({
        email: userEmail,
        driveToken: startPageToken,
        contactsToken,
        otherContactsToken,
        historyId,
      })
    }
    // insert all the workspace users
    await insertUsersForWorkspace(users)

    await db.transaction(async (trx) => {
      for (const {
        email,
        driveToken,
        contactsToken,
        otherContactsToken,
        historyId,
      } of ingestionMetadata) {
        // drive and contacts per user
        await insertSyncJob(trx, {
          workspaceId: connector.workspaceId,
          workspaceExternalId: connector.workspaceExternalId,
          app: Apps.GoogleDrive,
          connectorId: connector.id,
          authType: AuthType.ServiceAccount,
          config: {
            driveToken,
            contactsToken,
            otherContactsToken,
            lastSyncedAt: new Date().toISOString(),
          },
          email,
          type: SyncCron.ChangeToken,
          status: SyncJobStatus.NotStarted,
        })
        // gmail per user
        await insertSyncJob(trx, {
          workspaceId: connector.workspaceId,
          workspaceExternalId: connector.workspaceExternalId,
          app: Apps.Gmail,
          connectorId: connector.id,
          authType: AuthType.ServiceAccount,
          config: { historyId, updatedAt: new Date().toISOString() },
          email,
          type: SyncCron.ChangeToken,
          status: SyncJobStatus.NotStarted,
        })
      }
      // workspace sync for the Org
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
  } catch (error) {
    Logger.error(
      `could not finish job successfully: ${(error as Error).message} ${(error as Error).stack}`,
      error,
    )
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
      cause: error as Error,
    })
  }
}

export const deleteDocument = async (filePath: string) => {
  try {
    await fileSys.unlink(filePath) // Delete the file at the provided path
    Logger.info(`File at ${filePath} deleted successfully`)
  } catch (err) {
    Logger.error(
      `Error deleting file at ${filePath}: ${err} ${(err as Error).stack}`,
      err,
    )
    throw new DeleteDocumentError({
      message: "Error in the catch of deleting file",
      cause: err as Error,
      integration: Apps.GoogleDrive,
      entity: DriveEntity.PDF,
    })
  }
}

const getPresentationToBeIngested = async (
  slides: slides_v1.Slides,
  presentation: drive_v3.Schema$File,
  client: GoogleClient,
) => {
  const presentationData = await slides.presentations.get({
    presentationId: presentation.id!,
  })
  const slidesData = presentationData.data.slides!
  const chunks: string[] = []
  let currentChunk = ""

  slidesData.forEach((slide) => {
    slide.pageElements!.forEach((element) => {
      if (
        element.shape &&
        element.shape.text &&
        element.shape.text.textElements
      ) {
        element.shape.text.textElements.forEach((textElement) => {
          if (textElement.textRun) {
            const textContent = textElement.textRun.content!.trim()

            if ((currentChunk + " " + textContent).trim().length > 512) {
              // Check if adding this text would exceed the maximum chunk length
              // Add the current chunk to the list and start a new chunk
              if (currentChunk.trim().length > 0) {
                chunks.push(currentChunk.trim())
              }
              currentChunk = textContent
            } else {
              // Append the text to the current chunk
              currentChunk += " " + textContent
            }
          }
        })
      }
    })
  })

  if (currentChunk.trim().length > 0) {
    // Add any remaining text as the last chunk
    chunks.push(currentChunk.trim())
  }

  const parentsForMetadata = []
  if (presentation?.parents) {
    for (const parentId of presentation.parents!) {
      const parentData = await getFile(client, parentId)
      const folderName = parentData.name!
      parentsForMetadata.push({ folderName, folderId: parentId })
    }
  }

  const presentationToBeIngested = {
    title: presentation.name!,
    url: presentation.webViewLink ?? "",
    app: Apps.GoogleDrive,
    docId: presentation.id!,
    owner: presentation.owners
      ? (presentation.owners[0].displayName ?? "")
      : "",
    photoLink: presentation.owners
      ? (presentation.owners[0].photoLink ?? "")
      : "",
    ownerEmail: presentation.owners
      ? (presentation.owners[0]?.emailAddress ?? "")
      : "",
    entity: DriveEntity.Slides,
    chunks,
    permissions: presentation.permissions ?? [],
    mimeType: presentation.mimeType ?? "",
    metadata: JSON.stringify({ parents: parentsForMetadata }),
  }

  return presentationToBeIngested
}

const googleSlidesVespa = async (
  client: GoogleClient,
  presentationMetadata: drive_v3.Schema$File[],
  connectorId: string,
): Promise<VespaFileWithDrivePermission[]> => {
  sendWebsocketMessage(
    `Scanning ${presentationMetadata.length} Google Slides`,
    connectorId,
  )
  const presentationsList: VespaFileWithDrivePermission[] = []
  const slides = google.slides({ version: "v1", auth: client })
  const total = presentationMetadata.length
  let count = 0

  for (const presentation of presentationMetadata) {
    try {
      const presentationToBeIngested = await getPresentationToBeIngested(
        slides,
        presentation,
        client,
      )
      presentationsList.push(presentationToBeIngested)
      count += 1

      if (count % 5 === 0) {
        sendWebsocketMessage(`${count} Google Slides scanned`, connectorId)
        process.stdout.write(`${Math.floor((count / total) * 100)}`)
        process.stdout.write("\n")
      }
    } catch (error) {
      Logger.error(
        `Error getting slides: ${error} ${(error as Error).stack}`,
        error,
      )
      continue
    }
  }
  return presentationsList
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
      (v) =>
        v.mimeType !== DriveMime.Docs &&
        v.mimeType !== DriveMime.PDF &&
        v.mimeType !== DriveMime.Sheets &&
        v.mimeType !== DriveMime.Slides,
    )

    const [
      // documents, pdfDocuments, sheets,
      slides,
    ]: [
      VespaFileWithDrivePermission[],
      // VespaFileWithDrivePermission[],
      // VespaFileWithDrivePermission[],
      // VespaFileWithDrivePermission[],
    ] = await Promise.all([
      // googleDocsVespa(googleClient, googleDocsMetadata, connector.externalId),
      // googlePDFsVespa(googleClient, googlePDFsMetadata, connector.externalId),
      // googleSheetsVespa(
      //   googleClient,
      //   googleSheetsMetadata,
      //   connector.externalId,
      // ),
      googleSlidesVespa(
        googleClient,
        googleSlidesMetadata,
        connector.externalId,
      ),
    ])
    // const driveFiles: VespaFileWithDrivePermission[] = await driveFilesToDoc(
    //   googleClient,
    //   rest,
    // )

    sendWebsocketMessage("generating embeddings", connector.externalId)
    let allFiles: VespaFileWithDrivePermission[] = [
      // ...driveFiles,
      // ...documents,
      // ...pdfDocuments,
      // ...sheets,
      ...slides,
    ].map((v) => {
      v.permissions = toPermissionsList(v.permissions, userEmail)
      return v
    })

    for (const doc of allFiles) {
      await insertDocument(doc)
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    Logger.error(
      `Could not insert files for user: ${errorMessage} ${(error as Error).stack}`,
    )
  }
}

export const getAllSheetsFromSpreadSheet = async (
  sheets: sheets_v4.Sheets,
  spreadsheet: sheets_v4.Schema$Spreadsheet,
  spreadsheetId: string,
) => {
  const allSheets = []
  for (const sheet of spreadsheet.sheets!) {
    const sheetProp = sheet.properties
    const sheetTitle = sheetProp?.title
    const sheetType = sheetProp?.sheetType

    // If sheetType is GRID meaning table like structure, then only go further
    // Other sheetType includes OBJECT which represent charts, graphs, etc. Ignoring them for now
    if (sheetType !== "GRID") {
      continue
    }

    const sheetRanges = await sheets.spreadsheets.values.get({
      range: `'${sheetTitle}'`,
      spreadsheetId,
      valueRenderOption: "FORMATTED_VALUE",
    })

    const valueRanges = sheetRanges?.data?.values!
    // Making a object of one sheet info here to specify sheet data with sheet info
    allSheets.push({
      sheetId: sheetProp?.sheetId,
      sheetTitle,
      valueRanges,
    })
  }
  return allSheets
}

export const cleanSheetAndGetValidRows = (allRows: string[][]) => {
  const rowsWithData = allRows?.filter((row) =>
    row.some((r) => r.trim() !== ""),
  )

  if (!rowsWithData || rowsWithData.length === 0) {
    // If no row is filled, no data is there
    Logger.error("No data in any row. Skipping it")
    return []
  }

  let noOfCols = 0
  for (const row of rowsWithData) {
    if (row.length > noOfCols) {
      noOfCols = row.length
    }
  }

  // If some cells are empty in a row, and there are less values compared to the noOfCols
  // Put "" string in them
  const processedRows: string[][] = rowsWithData.map((row) =>
    row.length < noOfCols
      ? row.concat(Array(noOfCols - row.length).fill(""))
      : row,
  )

  if (processedRows.length < 2) {
    // One row is assumed to be headers/column names
    // Atleast one additional row for the data should be there
    // So there should be atleast two rows to continue further
    Logger.error("Not enough data to process further. Skipping it")
    return []
  }

  return processedRows
}

// Function to get the whole spreadsheet
// One spreadsheet can contain multiple sheets like Sheet1, Sheet2
export const getSpreadsheet = (sheets: sheets_v4.Sheets, id: string) =>
  sheets.spreadsheets.get({ spreadsheetId: id })

// Function to chunk rows of text data into manageable batches
// Excludes numerical data, assuming users do not typically search by numbers
// Concatenates all textual cells in a row into a single string
// Adds rows' string data to a chunk until the 512-character limit is exceeded
// If adding a row exceeds the limit, the chunk is added to the next chunk
// Otherwise, the row is added to the current chunk
const chunkFinalRows = (allRows: string[][]): string[] => {
  const chunks: string[] = []
  let currentChunk = ""
  let totalTextLength = 0

  for (const row of allRows) {
    // Filter out numerical cells and empty strings
    const textualCells = row.filter(
      (cell) => isNaN(Number(cell)) && cell.trim().length > 0,
    )

    if (textualCells.length === 0) continue // Skip if no textual data

    const rowText = textualCells.join(" ")

    // Check if adding this rowText would exceed the maximum text length
    if (totalTextLength + rowText.length > MAX_GD_SHEET_TEXT_LEN) {
      Logger.error(`Text length excedded, indexing with empty content`)
      // Return an empty array if the total text length exceeds the limit
      return []
    }

    totalTextLength += rowText.length

    if ((currentChunk + " " + rowText).trim().length > 512) {
      // Add the current chunk to the list and start a new chunk
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim())
      }
      currentChunk = rowText
    } else {
      // Append the row text to the current chunk
      currentChunk += " " + rowText
    }
  }

  if (currentChunk.trim().length > 0) {
    // Add any remaining text as the last chunk
    chunks.push(currentChunk.trim())
  }

  return chunks
}

export const getSheetsListFromOneSpreadsheet = async (
  sheets: sheets_v4.Sheets,
  client: GoogleClient,
  spreadsheet: drive_v3.Schema$File,
): Promise<VespaFileWithDrivePermission[]> => {
  const sheetsArr = []
  const spreadSheetData = await getSpreadsheet(sheets, spreadsheet.id!)

  // Now we should get all sheets inside this spreadsheet using the spreadSheetData
  const allSheetsFromSpreadSheet = await getAllSheetsFromSpreadSheet(
    sheets,
    spreadSheetData.data,
    spreadsheet.id!,
  )

  // There can be multiple parents
  // Element of parents array contains folderId and folderName
  const parentsForMetadata = []
  // Shared files cannot have parents
  // There can be some files that user has access to may not have parents as they are shared
  if (spreadsheet?.parents) {
    for (const parentId of spreadsheet?.parents!) {
      const parentData = await getFile(client, parentId)
      const folderName = parentData.name!
      parentsForMetadata.push({ folderName, folderId: parentId })
    }
  }

  for (const [sheetIndex, sheet] of allSheetsFromSpreadSheet.entries()) {
    const finalRows = cleanSheetAndGetValidRows(sheet.valueRanges)

    if (finalRows.length === 0) {
      Logger.info(
        `${spreadsheet.name} -> ${sheet.sheetTitle} found no rows. Skipping it`,
      )
      continue
    }

    let chunks: string[] = []

    if (finalRows.length > MAX_GD_SHEET_ROWS) {
      // If there are more rows than MAX_GD_SHEET_ROWS, still index it but with empty content
      Logger.info(
        `Large no. of rows in ${spreadsheet.name} -> ${sheet.sheetTitle}, indexing with empty content`,
      )
      chunks = []
    } else {
      chunks = chunkFinalRows(finalRows)
    }

    const sheetDataToBeIngested = {
      title: spreadsheet.name!,
      url: spreadsheet.webViewLink ?? "",
      app: Apps.GoogleDrive,
      // TODO Document it eveyrwhere
      // Combining spreadsheetId and sheetIndex as single spreadsheet can have multiple sheets inside it
      docId: `${spreadsheet?.id}_${sheetIndex}`,
      owner: spreadsheet.owners
        ? (spreadsheet.owners[0].displayName ?? "")
        : "",
      photoLink: spreadsheet.owners
        ? (spreadsheet.owners[0].photoLink ?? "")
        : "",
      ownerEmail: spreadsheet.owners
        ? (spreadsheet.owners[0]?.emailAddress ?? "")
        : "",
      entity: DriveEntity.Sheets,
      chunks,
      permissions: spreadsheet.permissions ?? [],
      mimeType: spreadsheet.mimeType ?? "",
      metadata: JSON.stringify({
        parents: parentsForMetadata,
        ...(sheetIndex === 0 && {
          spreadsheetId: spreadsheet.id!,
          totalSheets: spreadSheetData.data.sheets?.length!,
        }),
      }),
    }
    sheetsArr.push(sheetDataToBeIngested)
  }
  return sheetsArr
}

const googleSheetsVespa = async (
  client: GoogleClient,
  spreadsheetsMetadata: drive_v3.Schema$File[],
  connectorId: string,
): Promise<VespaFileWithDrivePermission[]> => {
  sendWebsocketMessage(
    `Scanning ${spreadsheetsMetadata.length} Google Sheets`,
    connectorId,
  )
  const sheetsList: VespaFileWithDrivePermission[] = []
  const sheets = google.sheets({ version: "v4", auth: client })
  const total = spreadsheetsMetadata.length
  let count = 0

  for (const spreadsheet of spreadsheetsMetadata) {
    try {
      const sheetsListFromOneSpreadsheet =
        await getSheetsListFromOneSpreadsheet(sheets, client, spreadsheet)
      sheetsList.push(...sheetsListFromOneSpreadsheet)
      count += 1

      if (count % 5 === 0) {
        sendWebsocketMessage(`${count} Google Sheets scanned`, connectorId)
        process.stdout.write(`${Math.floor((count / total) * 100)}`)
        process.stdout.write("\n")
      }
    } catch (error) {
      Logger.error(
        `Error getting sheet files: ${error} ${(error as Error).stack}`,
        error,
      )
      throw new DownloadDocumentError({
        message: "Error in the catch of getting sheet files",
        cause: error as Error,
        integration: Apps.GoogleDrive,
        entity: DriveEntity.Sheets,
      })
    }
  }
  return sheetsList
}

export const downloadDir = path.resolve(__dirname, "../../downloads")

export const downloadPDF = async (
  drive: drive_v3.Drive,
  fileId: string,
  fileName: string,
) => {
  if (!fs.existsSync(downloadDir)) {
    // Check if the downloads directory exists, create it if it doesn't
    fs.mkdirSync(downloadDir, { recursive: true })
  }

  const dest = fs.createWriteStream(path.join(downloadDir, fileName))
  try {
    const res = await drive.files.get(
      { fileId: fileId, alt: "media" },
      { responseType: "stream" },
    )
    return new Promise<void>((resolve, reject) => {
      res.data
        .on("end", () => {
          Logger.info(`Downloaded ${fileName}`)
          resolve()
        })
        .on("error", async (err) => {
          Logger.error("Error downloading file.", err)
          // Deleting document here if downloading fails
          await deleteDocument(`${downloadDir}/${fileName}`)
          reject(err)
        })
        .pipe(dest)
    })
  } catch (error) {
    Logger.error(`Error fetching the file stream:`, error)
    throw new DownloadDocumentError({
      message: "Error in downloading file",
      cause: error as Error,
      integration: Apps.GoogleDrive,
      entity: DriveEntity.PDF,
    })
  }
}

export const googlePDFsVespa = async (
  client: GoogleClient,
  pdfsMetadata: drive_v3.Schema$File[],
  connectorId: string,
): Promise<VespaFileWithDrivePermission[]> => {
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
    // Ignore the PDF files larger than Max PDF Size
    if (pdfSizeInMB > MAX_GD_PDF_SIZE) {
      Logger.info(`Ignoring ${pdf.name} as its more than 20 MB`)
      continue
    }
    try {
      await downloadPDF(drive, pdf.id!, pdf.name!)
      const pdfPath = `${downloadDir}/${pdf?.name}`
      let docs: Document[] = []

      const loader = new PDFLoader(pdfPath)
      docs = await loader.load()

      if (!docs || docs.length === 0) {
        Logger.error(`Could not get content for file: ${pdf.name}. Skipping it`)
        await deleteDocument(pdfPath)
        continue
      }
      const chunks = docs.flatMap((doc) => chunkDocument(doc.pageContent))

      const parentsForMetadata = []
      if (pdf?.parents) {
        for (const parentId of pdf.parents!) {
          const parentData = await getFile(client, parentId)
          const folderName = parentData.name!
          parentsForMetadata.push({ folderName, folderId: parentId })
        }
      }
      // TODO: remove ts-ignore and fix correctly
      // @ts-ignore
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
        permissions: pdf.permissions ?? [],
        mimeType: pdf.mimeType ?? "",
        metadata: JSON.stringify({ parents: parentsForMetadata }),
      })
      count += 1

      if (count % 5 === 0) {
        sendWebsocketMessage(`${count} Google PDFs scanned`, connectorId)
        process.stdout.write(`${Math.floor((count / total) * 100)}`)
        process.stdout.write("\n")
      }
      await deleteDocument(pdfPath)
    } catch (error) {
      Logger.error(
        `Error getting PDF files: ${error} ${(error as Error).stack}`,
        error,
      )
      throw new DownloadDocumentError({
        message: "Error in the catch of getting PDF files",
        cause: error as Error,
        integration: Apps.GoogleDrive,
        entity: DriveEntity.PDF,
      })
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

type ContactsResponse = {
  contacts: people_v1.Schema$Person[]
  otherContacts: people_v1.Schema$Person[]
  contactsToken: string
  otherContactsToken: string
}

// get both contacts and other contacts and return the sync tokens
const listAllContacts = async (
  client: GoogleClient,
): Promise<ContactsResponse> => {
  const peopleService = google.people({ version: "v1", auth: client })
  const keys = [
    "names",
    "emailAddresses",
    "photos",
    "organizations",
    "metadata",
    "urls",
    "birthdays",
    "genders",
    "occupations",
    "userDefined",
  ]
  const maxOtherContactsPerPage = 1000
  let pageToken: string = ""
  const contacts: any[] = []
  const otherContacts: any[] = []

  // will be returned in the end
  let newSyncTokenContacts: string = ""
  let newSyncTokenOtherContacts: string = ""

  do {
    const response = await peopleService.people.connections.list({
      resourceName: "people/me",
      pageSize: maxOtherContactsPerPage,
      personFields: keys.join(","),
      pageToken,
      requestSyncToken: true,
    })

    if (response.data.connections) {
      contacts.push(...response.data.connections)
    }

    pageToken = response.data.nextPageToken ?? ""
    newSyncTokenContacts = response.data.nextSyncToken ?? ""
  } while (pageToken)

  // reset page token for other contacts
  pageToken = ""

  do {
    const response = await peopleService.otherContacts.list({
      pageSize: maxOtherContactsPerPage,
      readMask: keys.join(","),
      pageToken,
      requestSyncToken: true,
      sources: ["READ_SOURCE_TYPE_PROFILE", "READ_SOURCE_TYPE_CONTACT"],
    })

    if (response.data.otherContacts) {
      otherContacts.push(...response.data.otherContacts)
    }

    pageToken = response.data.nextPageToken ?? ""
    newSyncTokenOtherContacts = response.data.nextSyncToken ?? ""
  } while (pageToken)

  if (!newSyncTokenContacts || !newSyncTokenOtherContacts) {
    throw new ContactListingError({
      message: "Could not get sync tokens for contact",
      integration: Apps.GoogleDrive,
      entity: GooglePeopleEntity.Contacts,
    })
  }

  return {
    contacts,
    otherContacts,
    contactsToken: newSyncTokenContacts,
    otherContactsToken: newSyncTokenOtherContacts,
  }
}

export const insertContact = async (
  contact: people_v1.Schema$Person,
  entity: GooglePeopleEntity,
  owner: string,
) => {
  const docId = contact.resourceName || ""
  if (!docId) {
    Logger.error(`Id does not exist for ${entity}`)
    return
    // throw new ContactMappingError({
    //   integration: Apps.GoogleDrive,
    //   entity: GooglePeopleEntity.Contacts,
    // })
  }

  const name = contact.names?.[0]?.displayName ?? ""
  const email = contact.emailAddresses?.[0]?.value ?? ""
  if (!email) {
    Logger.error(`Email does not exist for ${entity}`)
    return
    // throw new ContactMappingError({
    //   integration: Apps.GoogleDrive,
    //   entity: GooglePeopleEntity.Contacts,
    // })
  }

  const app = Apps.GoogleDrive

  const gender = contact.genders?.[0]?.value ?? ""
  const photoLink = contact.photos?.[0]?.url ?? ""
  const aliases =
    contact.emailAddresses?.slice(1)?.map((e) => e.value ?? "") || []
  const urls = contact.urls?.map((url) => url.value ?? "") || []

  const currentOrg =
    contact.organizations?.find((org) => !org.endDate) ||
    contact.organizations?.[0]

  const orgName = currentOrg?.name ?? ""
  const orgJobTitle = currentOrg?.title ?? ""
  const orgDepartment = currentOrg?.department ?? ""
  const orgLocation = currentOrg?.location ?? ""
  const orgDescription = ""

  const updateTimeStr = contact.metadata?.sources?.[0]?.updateTime
  const creationTime = updateTimeStr
    ? new Date(updateTimeStr).getTime()
    : Date.now()

  const birthdayObj = contact.birthdays?.[0]?.date
  const birthday = birthdayObj
    ? new Date(
        `${birthdayObj.year || "1970"}-${birthdayObj.month || "01"}-${birthdayObj.day || "01"}`,
      ).getTime()
    : undefined

  const occupations = contact.occupations?.map((o) => o.value ?? "") || []
  const userDefined =
    contact.userDefined?.map((u) => `${u.key}: ${u.value}`) || []

  // TODO: remove ts-ignore and fix correctly
  const vespaContact = {
    docId,
    name,
    email,
    app,
    entity,
    gender,
    photoLink,
    aliases,
    urls,
    orgName,
    orgJobTitle,
    orgDepartment,
    orgLocation,
    orgDescription,
    creationTime,
    birthday,
    occupations,
    userDefined,
    owner,
  }
  // @ts-ignore
  await insertUser(vespaContact)
}

const insertContactsToVespa = async (
  contacts: people_v1.Schema$Person[],
  otherContacts: people_v1.Schema$Person[],
  owner: string,
): Promise<void> => {
  try {
    for (const contact of contacts) {
      await insertContact(contact, GooglePeopleEntity.Contacts, owner)
    }
    for (const contact of otherContacts) {
      await insertContact(contact, GooglePeopleEntity.OtherContacts, owner)
    }
  } catch (error) {
    // error is related to vespa and not mapping
    if (error instanceof ErrorInsertingDocument) {
      Logger.error("Could not insert contact: ", error)
      throw error
    } else {
      Logger.error(
        `Error mapping contact: ${error} ${(error as Error).stack}`,
        error,
      )
      throw new ContactMappingError({
        message: "Error in the catch of mapping google contact",
        integration: Apps.GoogleDrive,
        entity: GooglePeopleEntity.Contacts,
        cause: error as Error,
      })
    }
  }
}

export const listFiles = async (
  client: GoogleClient,
): Promise<drive_v3.Schema$File[]> => {
  const drive = google.drive({ version: "v3", auth: client })
  let nextPageToken = ""
  let files: drive_v3.Schema$File[] = []
  do {
    const res: GaxiosResponse<drive_v3.Schema$FileList> =
      await drive.files.list({
        // TODO: prevent Google AI studio from getting indexed or add limits
        // that don't cause that issue.
        // anyone who uses Google AI Studio, AI Studio creates a folder
        // and all the pdf's they upload on it is part of this folder
        // these can be quite large and for now we should just avoid it
        // this does not guarantee that this folder is only created by AI studio
        // so that edge case is not handled
        // or just depend on the size limit of pdfs, we don't want to index books as of now
        q: "trashed = false",
        pageSize: 100,
        fields:
          "nextPageToken, files(id, webViewLink, size, parents, createdTime, modifiedTime, name, owners, fileExtension, mimeType, permissions(id, type, emailAddress))",
        pageToken: nextPageToken,
      })

    if (res.data.files) {
      files = files.concat(res.data.files)
    }
    nextPageToken = res.data.nextPageToken ?? ""
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
  sendWebsocketMessage(
    `Scanning ${docsMetadata.length} Google Docs`,
    connectorId,
  )
  const docsList: VespaFileWithDrivePermission[] = []
  const docs = google.docs({ version: "v1", auth: client })
  const total = docsMetadata.length
  let count = 0
  const limit = pLimit(GoogleDocsConcurrency)
  const docsPromises = docsMetadata.map((doc) =>
    limit(async () => {
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

      const parentsForMetadata = []
      // Shared files cannot have parents
      // There can be some files that user has access to may not have parents as they are shared
      if (doc?.parents) {
        for (const parentId of doc?.parents!) {
          const parentData = await getFile(client, parentId)
          const folderName = parentData.name!
          parentsForMetadata.push({ folderName, folderId: parentId })
        }
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
        permissions: doc.permissions ?? [],
        mimeType: doc.mimeType ?? "",
        metadata: JSON.stringify({ parents: parentsForMetadata }),
      })
      count += 1

      if (count % 5 === 0) {
        sendWebsocketMessage(`${count} Google Docs scanned`, connectorId)
        process.stdout.write(`${Math.floor((count / total) * 100)}`)
        process.stdout.write("\n")
      }
    }),
  )
  await Promise.all(docsPromises)
  // }
  return docsList
}

export const driveFilesToDoc = async (
  client: GoogleClient,
  rest: drive_v3.Schema$File[],
): Promise<VespaFileWithDrivePermission[]> => {
  let results: VespaFileWithDrivePermission[] = []
  for (const doc of rest) {
    results.push(await driveFileToIndexed(client, doc))
  }
  return results
}
