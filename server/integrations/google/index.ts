import {
  admin_directory_v1,
  docs_v1,
  drive_v3,
  google,
  people_v1,
} from "googleapis"
import {
  extractFootnotes,
  extractHeadersAndFooters,
  extractText,
  postProcessText,
} from "@/doc"
import { chunkDocument, chunkTextByParagraph } from "@/chunks"
import {
  Subsystem,
  SyncCron,
  type GoogleChangeToken,
  type GoogleClient,
  type GoogleServiceAccount,
  type SaaSJob,
  type SaaSOAuthJob,
} from "@/types"
import PgBoss from "pg-boss"
import { getConnector, getOAuthConnectorWithCredentials } from "@/db/connector"
import { getExtractor } from "@/embedding"
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
} from "@/errors"
import fs from "node:fs"
import path from "node:path"
// import pdf2text from "pdf-to-text"
// import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf"
import { spawn } from "child_process"
import tracer from "dd-trace"
import fileSys from"node:fs/promises"

const Logger = getLogger(Subsystem.Integrations).child({ module: "google" })

export type GaxiosPromise<T = any> = Promise<GaxiosResponse<T>>

export async function dpdf2text(
  pdfPath: string,
): Promise<{ pages: string[]; content: string }> {
  return tracer.trace(
    dpdf2text,
    {
      resource: dpdf2text,
    },
    async (span) => {
      span?.setTag("pdfPath", pdfPath)
      const argsPerPage: string[] = ["-layout", "-enc", "UTF-8", pdfPath, "-"]

      const content = await new Promise<string>((resolve, reject) => {
        const child = spawn("pdftotext", argsPerPage)

        let capturedStdoutPerPage = ""
        let capturedStderrPerPage = ""

        child.stdout.on("data", (data) => {
          capturedStdoutPerPage += data
        })
        child.stderr.on("data", (data) => {
          capturedStderrPerPage += data
        })

        child.on("close", (code) => {
          if (code === 0) {
            resolve(capturedStdoutPerPage)
          } else {
            reject(new Error(capturedStderrPerPage))
          }
        })
      })

      // This assumes \f is not used in the PDF content. Checking popper source code (from which
      // pdftotext is derived), it seems that \f is considered to separate pages.
      // To mititage any major risk, we filter out empty pages which may be caused by extraneous \f.
      // From various tests on different PDFs this seems to work well. If we have a really problematic
      // PDF we can expect that upsert will fail because some chunks sections will have less content
      // than their prefix.
      const pages = content.split("\f").filter((page) => page.trim().length > 0)

      return { pages, content }
    },
  )
}

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

    await insertFilesForUser(oauth2Client, userEmail, connector)
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
      ingestionMetadata.push({
        email: userEmail,
        driveToken: startPageToken,
        contactsToken: contactsToken,
        otherContactsToken: otherContactsToken,
      })
      await insertFilesForUser(jwtClient, userEmail, connector)
      // insert that user
    }
    // insert all the workspace users
    await insertUsersForWorkspace(users)

    await db.transaction(async (trx) => {
      for (const {
        email,
        driveToken,
        contactsToken,
        otherContactsToken,
      } of ingestionMetadata) {
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

    // const documents: VespaFileWithDrivePermission[] = await googleDocsVespa(
    //   googleClient,
    //   googleDocsMetadata,
    //   connector.externalId,
    // )
    const pdfDocuments: VespaFileWithDrivePermission[] = await googlePDFsVespa(
      googleClient,
      googlePDFsMetadata,
      connector.externalId,
    )
    // const driveFiles: VespaFileWithDrivePermission[] =
    //   await driveFilesToDoc(rest)

    sendWebsocketMessage("generating embeddings", connector.externalId)
    let allFiles: VespaFileWithDrivePermission[] = [
      // ...driveFiles,
      // ...documents,
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

async function downloadPDF(
  drive: drive_v3.Drive,
  fileId: string,
  fileName: string,
) {
  // Todo Make a folder named downloads if not there
  const dest = fs.createWriteStream(
    path.resolve(__dirname, "../../downloads", fileName),
  )
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

// Function to handle PDF info
const getPdfInfo = (filePath) => {
  return new Promise((resolve, reject) => {
    pdf2text.info(filePath, (err, info) => {
      if (err) {
        reject("Error parsing PDF info:")
      } else {
        resolve(info)
      }
    })
  })
}

// Function to handle PDF text extraction
const getPdfText = (filePath: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    pdf2text.pdfToText(filePath, (err, text) => {
      if (err) {
        reject("Error extracting PDF text:")
      } else {
        resolve(text)
      }
    })
  })
}

// const getPdfText = (filePath: string): Promise<string> => {
//   return new Promise((resolve, reject) => {
//     let dataBuffer = fs.readFileSync(filePath);
//     pdfParse(dataBuffer)
//       .then((data) => {
//         // Resolve the Promise with the text extracted from the PDF
//         resolve(data.text)
//       })
//       .catch((err) => {
//         // Reject the Promise if there's an error
//         reject(`Error extracting PDF text: ${err}`)
//       })
//   })
// }

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
    await downloadPDF(drive, pdf.id!, pdf.name!)
    const pdfPath = path.resolve(__dirname, `../../downloads/${pdf?.name}`)
    const docs = await dpdf2text(pdfPath)
    // console.log("Text Content")
    // console.log(result.content)
    // console.log("Text Content")
    // console.log("Pages")
    // console.log(result.pages)
    // console.log("Pages")
    // const [pdfInfo, pdfText] = await Promise.all([
    //   getPdfInfo(pdfPath),
    //   getPdfText(pdfPath),
    // ])
    // const loader = new PDFLoader(pdfPath)
    // const docs = await loader.load()
    // const docs = pdfText.split("\f").filter((page) => page.trim().length > 0)

    if (!docs) {
      throw new Error(`Could not get content for file: ${pdf.id}`)
    }

    const chunks = docs.pages.flatMap((doc) => chunkDocument(doc))
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
    await deleteDocument(pdfPath)
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
