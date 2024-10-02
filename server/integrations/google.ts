import { admin_directory_v1, drive_v3, google } from "googleapis";
import { extractFootnotes, extractHeadersAndFooters, extractText, postProcessText } from '@/doc';
import { chunkDocument } from '@/chunks';
import { DriveMime, SyncCron, type ChangeToken, type File, type SaaSJob, type SaaSOAuthJob, type SyncConfig } from "@/types";
import { JWT, OAuth2Client } from "google-auth-library";
import PgBoss from "pg-boss";
import { getConnector, getOAuthConnectorWithCredentials } from "@/db/connector";
import { getExtractor } from "@/embedding";
import { DeleteDocument, GetDocument, insertDocument, UpdateDocumentPermissions } from "@/search/vespa";
import { SaaSQueue } from "@/queue";
import { wsConnections } from "@/server";
import type { WSContext } from "hono/ws";
import { db } from "@/db/client";
import { connectors, oauthProviders } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getWorkspaceByEmail } from "@/db/workspace";
import { Apps, ConnectorStatus, SyncJobStatus } from "@/shared/types";
import type { GoogleTokens } from "arctic";
import { getAppSyncJobs, insertSyncJob, updateSyncJob } from "@/db/syncJob";
import { getUserById } from "@/db/user";
import type { GaxiosResponse } from "gaxios";
import { insertSyncHistory } from "@/db/syncHistory";
import { getErrorMessage } from "@/utils";


const createJwtClient = (serviceAccountKey: GoogleServiceAccount, subject: string): JWT => {
    return new JWT({
        email: serviceAccountKey.client_email,
        key: serviceAccountKey.private_key,
        scopes,
        subject
    });
}

type GoogleServiceAccount = {
    client_email: string,
    private_key: string,
}

const listUsers = async (admin: admin_directory_v1.Admin, domain: string): Promise<admin_directory_v1.Schema$User[]> => {
    let users: admin_directory_v1.Schema$User[] = [];
    let nextPageToken = null;
    try {
        do {
            const res = await admin.users.list({
                domain: domain,
                maxResults: 500,
                orderBy: "email",
                pageToken: nextPageToken,
            });
            users = users.concat(res.data.users);

            nextPageToken = res.data.nextPageToken;
        } while (nextPageToken);
        return users;
    } catch (error) {
        console.error("Error listing users:", error);
        throw error
        // return [];
    }
};

const MimeMapForContent: Record<string, boolean> = {
    [DriveMime.Docs]: true
}

// TODO: change summary to json
// and store all the structured details
type ChangeStats = {
    added: number,
    removed: number,
    updated: number,
    summary: string
}

const handleGoogleDriveChange = async (change: drive_v3.Schema$Change, client: GoogleClient, email: string): Promise<ChangeStats> => {
    const stats = newStats()
    console.log(change)
    const docId = change.fileId
    // remove item
    if (change.removed) {
        if (docId) {
            const doc = await GetDocument(docId)
            const permissions = doc.fields.permissions
            if (permissions.length === 1) {
                // remove it
                try {
                    // also ensure that we are that permission
                    if (!(permissions[0] === email)) {
                        throw new Error("We got a change for us that we didn't have access to in Vespa")
                    }
                    await DeleteDocument(docId)
                    stats.removed += 1
                    stats.summary += `${docId} removed\n`
                } catch (e) {
                    // TODO: detect vespa 404 and only ignore for that case
                    // otherwise throw it further
                }
            } else {
                // remove our user's permission from the email
                const newPermissions = permissions.filter(v => v !== email)
                await UpdateDocumentPermissions(docId, newPermissions)
                stats.updated += 1
                stats.summary += `user lost permission for doc: ${docId}\n`
            }
        }
    } else if (docId && change.file) {
        const file = await getFile(client, docId)
        // we want to check if the doc already existed in vespa
        // and we are just updating the content of it
        // or user got access to a completely new doc
        let doc = null
        try {
            doc = await GetDocument(docId)
            stats.updated += 1
        } catch (e) {
            // catch the 404 error
            console.error(`Could not get document ${docId}, probably does not exist, ${e}`)
            stats.added += 1
        }
        // for these mime types we fetch the file
        // with the full processing
        let vespaData
        if (file.mimeType && MimeMapForContent[file.mimeType]) {
            // TODO: make this generic
            vespaData = await getFileContent(client, file, 'docs')
            if (doc) {
                stats.summary += `updated the content for ${docId}\n`
            } else {
                stats.summary += `indexed new content ${docId}\n`
            }
        } else {
            if (doc) {
                stats.summary += `updated file ${docId}\n`
            } else {
                stats.summary += `added new file ${docId}\n`
            }
            // just update it as is
            vespaData = driveFileToIndexed(file)
        }
        vespaData.permissions = toPermissionsList(vespaData.permissions, email)
        if (vespaData) {
            insertDocument(vespaData)
        }
    } else if (change.driveId) {
        // TODO: handle this once we support multiple drives
    } else {
        console.error('Could not handle change: ', change)
    }
    return stats
}

export const handleGoogleOAuthChanges = async (boss: PgBoss, job: PgBoss.Job<any>) => {
    console.log('handleGoogleOAuthChanges')
    const data = job.data
    // TODO: only fetch job with provider id associated with OAuth
    // so it is a company wide OAuth Sync Job sync for google drive
    const syncJobs = await getAppSyncJobs(db, Apps.GoogleDrive)
    for (const syncJob of syncJobs) {
        let stats = newStats()
        try {
            const connector = await getOAuthConnectorWithCredentials(db, syncJob.connectorId)
            const user = await getUserById(db, connector.userId)
            const oauthTokens: GoogleTokens = connector.oauthCredentials
            const oauth2Client = new google.auth.OAuth2();
            const config: ChangeToken = syncJob.config as ChangeToken
            // we have guarantee that when we started this job access Token at least
            // hand one hour, we should increase this time
            oauth2Client.setCredentials({ access_token: oauthTokens.accessToken });
            const driveClient = google.drive({ version: "v3", auth: oauth2Client })
            // TODO: add pagination for all the possible changes
            const { changes, newStartPageToken } = (await driveClient.changes.list({ pageToken: config.token })).data
            // there are changes

            // Potential issues:
            // we remove the doc but don't update the syncJob
            // leading to us trying to remove the doc again which throws error
            // as it is already removed
            // we should still update it in that case?
            if (changes?.length && newStartPageToken && newStartPageToken !== config.token) {
                console.log(`total changes:  ${changes.length}`)
                for (const change of changes) {
                    let changeStats = await handleGoogleDriveChange(change, oauth2Client, user.email)
                    stats = mergeStats(stats, changeStats)
                }
                const newConfig = { lastSyncedAt: new Date(), token: newStartPageToken }
                // update this sync job and
                // create sync history
                await db.transaction(async (trx) => {
                    await updateSyncJob(trx, syncJob.id, { config: newConfig, lastRanOn: new Date(), status: SyncJobStatus.Successful })
                    // make it compatible with sync history config type
                    await insertSyncHistory(trx, {
                        workspaceId: syncJob.workspaceId,
                        workspaceExternalId: syncJob.workspaceExternalId,
                        dataAdded: stats.added,
                        dataDeleted: stats.removed,
                        dataUpdated: stats.updated,
                        summary: { description: stats.summary },
                        errorMessage: "",
                        app: Apps.GoogleDrive,
                        status: SyncJobStatus.Successful,
                        config: { token: newConfig.token, lastSyncedAt: newConfig.lastSyncedAt.toISOString() },
                        type: SyncCron.ChangeToken,
                        lastRanOn: new Date(),
                    })
                })
                console.log(`Changes successfully synced: ${JSON.stringify(stats)}`)
            }
        } catch (error) {
            const errorMessage = getErrorMessage(error)
            console.error(`Could not successfully complete sync job: ${syncJob.id} due to ${errorMessage}`)
            const config: ChangeToken = syncJob.config as ChangeToken
            const newConfig = { token: config.token as string, lastSyncedAt: config.lastSyncedAt.toISOString() }
            await insertSyncHistory(db, {
                workspaceId: syncJob.workspaceId,
                workspaceExternalId: syncJob.workspaceExternalId,
                dataAdded: stats.added,
                dataDeleted: stats.removed,
                dataUpdated: stats.updated,
                summary: { description: stats.summary },
                errorMessage,
                app: Apps.GoogleDrive,
                status: SyncJobStatus.Failed,
                config: newConfig,
                type: SyncCron.ChangeToken,
                lastRanOn: new Date(),
            })
        }
    }
}

const newStats = (): ChangeStats => {
    return {
        added: 0,
        removed: 0,
        updated: 0,
        summary: ""
    }
}

const mergeStats = (prev: ChangeStats, current: ChangeStats): ChangeStats => {
    prev.added += current.added
    prev.updated += current.updated
    prev.removed += current.removed
    prev.summary += `\n${current.summary}`
    return prev
}

export const handleGoogleOAuthIngestion = async (boss: PgBoss, job: PgBoss.Job<any>) => {
    console.log('handleGoogleServiceAccountIngestion', job.data)
    const data: SaaSOAuthJob = job.data as SaaSOAuthJob
    try {
        // we will first fetch the change token
        // and poll the changes in a new Cron Job
        const connector = await getOAuthConnectorWithCredentials(db, data.connectorId)
        const userEmail = job.data.email
        const oauthTokens: GoogleTokens = connector.oauthCredentials
        const oauth2Client = new google.auth.OAuth2();
        // we have guarantee that when we started this job access Token at least
        // hand one hour, we should increase this time
        oauth2Client.setCredentials({ access_token: oauthTokens.accessToken });
        const driveClient = google.drive({ version: "v3", auth: oauth2Client })
        // get change token for any changes during drive integration
        const { startPageToken }: drive_v3.Schema$StartPageToken = (await driveClient.changes.getStartPageToken()).data
        if (!startPageToken) {
            throw new Error('Could not get start page token')
        }
        await insertDriveForAUser(oauth2Client, userEmail, connector)
        const changeToken = { token: startPageToken, lastSyncedAt: new Date().toISOString() }
        await db.transaction(async (trx) => {
            await trx.update(connectors).set({
                status: ConnectorStatus.Connected
            }).where(eq(connectors.id, connector.id))
            // create the SyncJob
            await insertSyncJob(trx, {
                workspaceId: connector.workspaceId,
                workspaceExternalId: connector.workspaceExternalId,
                app: Apps.GoogleDrive,
                connectorId: connector.id,
                config: changeToken,
                type: SyncCron.ChangeToken,
                status: SyncJobStatus.NotStarted
            })
            await boss.complete(SaaSQueue, job.id)
            console.log('job completed')
        })
    } catch (e) {
        console.error('could not finish job successfully', e)
        await db.transaction(async (trx) => {
            trx.update(connectors).set({
                status: ConnectorStatus.Failed
            }).where(eq(connectors.id, data.connectorId))
            await boss.fail(job.name, job.id)
        })
    }
}

export const handleGoogleServiceAccountIngestion = async (boss: PgBoss, job: PgBoss.Job<any>) => {
    console.log('handleGoogleServiceAccountIngestion', job.data)
    const data: SaaSJob = job.data as SaaSJob
    try {
        const connector = await getConnector(data.connectorId)
        const serviceAccountKey: GoogleServiceAccount = JSON.parse(connector.credentials as string)
        const subject: string = connector.subject as string
        let jwtClient = createJwtClient(serviceAccountKey, subject)
        const admin = google.admin({ version: "directory_v1", auth: jwtClient });

        const workspace = await getWorkspaceByEmail(db, subject)
        const users = await listUsers(admin, workspace.domain)
        for (const [index, user] of users.entries()) {
            sendWebsocketMessage(`${((index + 1) / users.length) * 100}% user's data is connected`, connector.externalId)
            const userEmail = user.primaryEmail || user.emails[0]
            jwtClient = createJwtClient(serviceAccountKey, userEmail)
            await insertDriveForAUser(jwtClient, userEmail, connector)
        }
        await db.transaction(async (trx) => {
            await trx.update(connectors).set({
                status: ConnectorStatus.Connected
            }).where(eq(connectors.id, connector.id))
            console.log('status updated')
            await boss.complete(SaaSQueue, job.id)
            console.log('job completed')
        })
    } catch (e) {
        console.error('could not finish job successfully', e)
        await db.transaction(async (trx) => {
            trx.update(connectors).set({
                status: ConnectorStatus.Failed
            }).where(eq(connectors.id, data.connectorId))
            await boss.fail(job.name, job.id)
        })
    }
}

type GoogleClient = JWT | OAuth2Client
const insertDriveForAUser = async (googleClient: GoogleClient, userEmail: string, connector: any) => {
    const fileMetadata = (await listFiles(googleClient)).map(v => {
        v.permissions = toPermissionsList(v.permissions, userEmail)
        return v
    })
    const totalFiles = fileMetadata.length
    const ws: WSContext = wsConnections.get(connector.externalId)
    if (ws) {
        ws.send(JSON.stringify({ totalFiles, message: `${totalFiles} metadata files ingested` }))
    }
    const googleDocsMetadata = fileMetadata.filter(v => v.mimeType === DriveMime.Docs)
    const googleSheetsMetadata = fileMetadata.filter(v => v.mimeType === DriveMime.Sheets)
    const googleSlidesMetadata = fileMetadata.filter(v => v.mimeType === DriveMime.Slides)
    const rest = fileMetadata.filter(v => v.mimeType !== DriveMime.Docs)

    const documents: File[] = await googleDocsVespa(googleClient, googleDocsMetadata, connector.externalId)
    const driveFiles: File[] = await driveFilesToDoc(rest)

    sendWebsocketMessage('generating embeddings', connector.externalId)
    let allFiles: File[] = [...driveFiles, ...documents]

    for (const doc of allFiles) {
        await insertDocument(doc)
    }
}

// export const oauthScopes = [
//     "https://www.googleapis.com/auth/drive.readonly",
//     "https://www.googleapis.com/auth/documents.readonly",
//     "https://www.googleapis.com/auth/spreadsheets.readonly",
//     "https://www.googleapis.com/auth/presentations.readonly",
// ]

// for service account
const scopes = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/admin.directory.user.readonly",
    "https://www.googleapis.com/auth/documents.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/presentations.readonly",
    // "https://www.googleapis.com/auth/calendar.readonly",
    // "https://www.googleapis.com/auth/contacts.readonly",
    // "https://www.googleapis.com/auth/contacts.other.readonly",
    // "https://www.googleapis.com/auth/gmail.readonly"
];

const getFile = async (client: GoogleClient, fileId: string): Promise<drive_v3.Schema$File> => {
    console.log('getFile')
    const drive = google.drive({ version: "v3", auth: client });
    const fields = "id, webViewLink, createdTime, modifiedTime, name, owners, fileExtension, mimeType, permissions(id, type, emailAddress)"
    const file: GaxiosResponse<drive_v3.Schema$File> = await drive.files.get({ fileId, fields })

    return file.data
}


export const listFiles = async (client: GoogleClient, onlyDocs: boolean = false): Promise<drive_v3.Schema$File[]> => {
    const drive = google.drive({ version: "v3", auth: client });
    let nextPageToken = null;
    let files: drive_v3.Schema$File[] = [];
    do {
        const res: GaxiosResponse<drive_v3.Schema$FileList> = await drive.files.list({
            pageSize: 100,
            ...(onlyDocs ? { q: "mimeType='application/vnd.google-apps.document'" } : {}),
            fields:
                "nextPageToken, files(id, webViewLink, createdTime, modifiedTime, name, owners, fileExtension, mimeType, permissions(id, type, emailAddress))",
            ...(nextPageToken ? { pageToken: nextPageToken } : {}),
        });

        if (res.data.files) {
            files = files.concat(res.data.files);
        }
        nextPageToken = res.data.nextPageToken;
    } while (nextPageToken);
    return files;
}

// we need to support alias?
export const toPermissionsList = (drivePermissions: drive_v3.Schema$Permission[] | undefined, ownerEmail: string): string[] => {
    if (!drivePermissions) {
        return [ownerEmail]
    }
    let permissions = []
    if (drivePermissions && drivePermissions.length) {
        permissions = drivePermissions
            .filter(
                (p) =>
                    p.type === "user" || p.type === "group" || p.type === "domain",
            )
            .map((p) => {
                if (p.type === "domain") {
                    return "domain";
                }
                return p.emailAddress;
            });
    } else {
        // permissions don't exist for you
        // but the user who is able to fetch
        // the metadata, can read it
        permissions = [ownerEmail];
    }
    return permissions as string[]
}

const sendWebsocketMessage = (message: string, connectorId: string) => {
    const ws: WSContext = wsConnections.get(connectorId)
    if (ws) {
        ws.send(JSON.stringify({ message }))
    }
}

const extractor = await getExtractor()

const getFileContent = async (client: GoogleClient, file: drive_v3.Schema$File, entity) => {
    console.log('getFileContent')
    const docs = google.docs({ version: "v1", auth: client });
    const documentContent = await docs.documents.get({
        documentId: file.id as string,
    });
    const rawTextContent = documentContent?.data?.body?.content
        .map((e) => extractText(e))
        .join("");
    const footnotes = extractFootnotes(documentContent.data);
    const headerFooter = extractHeadersAndFooters(documentContent.data);
    const cleanedTextContent = postProcessText(
        rawTextContent + "\n\n" + footnotes + "\n\n" + headerFooter,
    );

    const chunks = chunkDocument(cleanedTextContent)
    // let title_embedding = (await extractor(doc.name, { pooling: 'mean', normalize: true })).tolist()[0]
    let chunkMap: Record<string, number[]> = {}
    for (const c of chunks) {
        const { chunk, chunkIndex } = c
        chunkMap[chunkIndex] = (await extractor(chunk, { pooling: 'mean', normalize: true })).tolist()[0]
    }
    return {
        title: file.name,
        // title_embedding,
        url: file.webViewLink,
        app: Apps.GoogleDrive,
        docId: file.id,
        owner: file?.owners[0]?.displayName,
        photoLink: file?.owners[0]?.photoLink,
        ownerEmail: file?.owners[0]?.emailAddress,
        entity,
        chunks: chunks.map(v => v.chunk),
        chunk_embeddings: chunkMap,
        permissions: file.permissions,
        mimeType: file.mimeType
    }
}

export const googleDocsVespa = async (client: GoogleClient, docsMetadata: drive_v3.Schema$File[], connectorId: string): Promise<any[]> => {
    sendWebsocketMessage(`Scanning ${docsMetadata.length} Google Docs`, connectorId)
    const docsList: File[] = []
    const docs = google.docs({ version: "v1", auth: client });
    const total = docsMetadata.length
    let count = 0
    for (const doc of docsMetadata) {
        const documentContent = await docs.documents.get({
            documentId: doc.id,
        });
        const rawTextContent = documentContent?.data?.body?.content
            .map((e) => extractText(e))
            .join("");
        const footnotes = extractFootnotes(documentContent.data);
        const headerFooter = extractHeadersAndFooters(documentContent.data);
        const cleanedTextContent = postProcessText(
            rawTextContent + "\n\n" + footnotes + "\n\n" + headerFooter,
        );

        const chunks = chunkDocument(cleanedTextContent)
        // let title_embedding = (await extractor(doc.name, { pooling: 'mean', normalize: true })).tolist()[0]
        let chunkMap: Record<string, number[]> = {}
        for (const c of chunks) {
            const { chunk, chunkIndex } = c
            chunkMap[chunkIndex] = (await extractor(chunk, { pooling: 'mean', normalize: true })).tolist()[0]
        }
        docsList.push({
            title: doc.name,
            // title_embedding,
            url: doc.webViewLink,
            app: 'google',
            docId: doc.id,
            owner: doc?.owners[0]?.displayName,
            photoLink: doc?.owners[0]?.photoLink,
            ownerEmail: doc?.owners[0]?.emailAddress,
            entity: 'docs',
            chunks: chunks.map(v => v.chunk),
            chunk_embeddings: chunkMap,
            permissions: doc.permissions,
            mimeType: doc.mimeType
        })
        count += 1

        if (count % 5 === 0) {
            sendWebsocketMessage(`${count} Google Docs scanned`, connectorId)
        }
        console.clear()
        process.stdout.write(`${Math.floor((count / total) * 100)}`)
    }
    process.stdout.write('\n')
    return docsList
}

export const driveFileToIndexed = (file: drive_v3.Schema$File): File => {
    const mimeTypeMap = {
        // "application/vnd.google-apps.document": "docs",
        "application/vnd.google-apps.spreadsheet": "sheets",
        "application/vnd.google-apps.presentation": "slides",
        "application/vnd.google-apps.folder": "folder"
    };
    let entity
    if (mimeTypeMap[file.mimeType]) {
        entity = mimeTypeMap[file.mimeType]
    } else {
        entity = 'driveFile'
    }

    // let title_embedding = (await extractor(doc.name, { pooling: 'mean', normalize: true })).tolist()[0]
    return {
        title: file.name,
        // title_embedding,
        url: file.webViewLink,
        app: 'google',
        docId: file.id,
        entity,
        chunks: [],
        // chunk: '',
        owner: file?.owners[0]?.displayName,
        photoLink: file?.owners[0]?.photoLink,
        ownerEmail: file?.owners[0]?.emailAddress,
        // chunkIndex: 0,
        chunk_embeddings: {},
        permissions: file.permissions,
        mimeType: file.mimeType
    }
}

export const driveFilesToDoc = async (rest: drive_v3.Schema$File[]): Promise<File[]> => {
    let results: File[] = []
    for (const doc of rest) {
        results.push(driveFileToIndexed(doc))
    }
    return results

}