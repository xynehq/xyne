import { admin_directory_v1, drive_v3, google } from "googleapis";
import { extractFootnotes, extractHeadersAndFooters, extractText, postProcessText } from '@/doc';
import { chunkDocument } from '@/chunks';
import fs from "node:fs/promises";
import {  type File, type SaaSJob, type SaaSOAuthJob } from "@/types";
import { JWT, OAuth2Client } from "google-auth-library";
import path from 'node:path'
import type PgBoss from "pg-boss";
import { getConnector } from "@/db/connector";
import { getExtractor } from "@/embedding";
import { insertDocument } from "@/search/vespa";
import { ProgressEvent, SaaSQueue } from "@/queue";
import { wsConnections } from "@/server";
import type { WSContext } from "hono/ws";
import { db } from "@/db/client";
import { connectors } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getWorkspaceByEmail } from "@/db/workspace";
import { ConnectorStatus, LOGGERTYPES } from "@/shared/types";
import type { GoogleTokens } from "arctic";
import { getLogger } from "@/shared/logger";

const Logger = getLogger(LOGGERTYPES.server).child({module: 'integrations'}).child({module: 'google'})

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

const listUsers = async (admin: admin_directory_v1.Admin, domain: string) => {
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
        Logger.error(`Error listing users:", ${error}`);
        throw error
        // return [];
    }
};

export const handleGoogleOAuthIngestion = async (boss: PgBoss, job: PgBoss.Job<any>) => {
    Logger.info(`handleGoogleServiceAccountIngestion, ${job.data}`)
    const data: SaaSOAuthJob = job.data as SaaSOAuthJob
    try {
        const connector = await getConnector(data.connectorId)
        const userEmail = job.data.email
        const oauthTokens: GoogleTokens = JSON.parse(connector.oauthCredentials as string)
        const oauth2Client = new google.auth.OAuth2();
        // TODO: ensure access token is refreshed
        // also what happens if oauth token is gonna be expired during the
        // time it takes to finish the job?
        oauth2Client.setCredentials({ access_token: oauthTokens.accessToken });
        await insertDriveForAUser(oauth2Client, userEmail, connector)
        await db.transaction(async (trx) => {
            await trx.update(connectors).set({
                status: ConnectorStatus.Connected
            }).where(eq(connectors.id, connector.id))
            Logger.info('status updated')
            await boss.complete(SaaSQueue, job.id)
            Logger.info('job completed')
        })
    } catch (e) {
        Logger.error(`could not finish job successfully \n, ${e}`)
        await db.transaction(async (trx) => {
            trx.update(connectors).set({
                status: ConnectorStatus.Failed
            }).where(eq(connectors.id, data.connectorId))
            await boss.fail(job.name, job.id)
        })
    }
}

export const handleGoogleServiceAccountIngestion = async (boss: PgBoss, job: PgBoss.Job<any>) => {
    Logger.info(`handleGoogleServiceAccountIngestion', ${job.data}`)
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
            Logger.info('status updated')
            await boss.complete(SaaSQueue, job.id)
            Logger.info('job completed')
        })
    } catch (e) {
        Logger.error(`could not finish job successfully', ${e}`)
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

export const listFiles = async (jwtClient: GoogleClient, onlyDocs: boolean = false): Promise<drive_v3.Schema$File[]> => {
    const drive = google.drive({ version: "v3", auth: jwtClient });
    let nextPageToken = null;
    let files = [];
    do {
        const res = await drive.files.list({
            pageSize: 100,
            ...(onlyDocs ? { q: "mimeType='application/vnd.google-apps.document'" } : {}),
            fields:
                "nextPageToken, files(id, webViewLink, createdTime, modifiedTime, name, owners, fileExtension, mimeType, permissions(id, type, emailAddress))",
            ...(nextPageToken ? { pageToken: nextPageToken } : {}),
        });

        files = files.concat(res.data.files);
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

export enum DriveMime {
    Docs = "application/vnd.google-apps.document",
    Sheets = "application/vnd.google-apps.spreadsheet",
    Slides = "application/vnd.google-apps.presentation",
}

const sendWebsocketMessage = (message: string, connectorId: string) => {
    const ws: WSContext = wsConnections.get(connectorId)
    if (ws) {
        ws.send(JSON.stringify({ message }))
    }
}

const extractor = await getExtractor()
export const googleDocsVespa = async (jwtClient: GoogleClient, docsMetadata: drive_v3.Schema$File[], connectorId: string): Promise<any[]> => {
    sendWebsocketMessage(`Scanning ${docsMetadata.length} Google Docs`, connectorId)
    const docsList: File[] = []
    const docs = google.docs({ version: "v1", auth: jwtClient });
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

export const driveFilesToDoc = async (rest: drive_v3.Schema$File[]): Promise<File[]> => {
    const mimeTypeMap = {
        // "application/vnd.google-apps.document": "docs",
        "application/vnd.google-apps.spreadsheet": "sheets",
        "application/vnd.google-apps.presentation": "slides",
        "application/vnd.google-apps.folder": "folder"
    };
    let results: File[] = []
    for (const doc of rest) {
        let entity
        if (mimeTypeMap[doc.mimeType]) {
            entity = mimeTypeMap[doc.mimeType]
        } else {
            entity = 'driveFile'
        }

        // let title_embedding = (await extractor(doc.name, { pooling: 'mean', normalize: true })).tolist()[0]
        results.push({
            title: doc.name,
            // title_embedding,
            url: doc.webViewLink,
            app: 'google',
            docId: doc.id,
            entity,
            chunks: [],
            // chunk: '',
            owner: doc?.owners[0]?.displayName,
            photoLink: doc?.owners[0]?.photoLink,
            ownerEmail: doc?.owners[0]?.emailAddress,
            // chunkIndex: 0,
            chunk_embeddings: {},
            permissions: doc.permissions,
            mimeType: doc.mimeType
        })
    }
    return results

}