import { drive_v3, google } from "googleapis";
import { extractFootnotes, extractHeadersAndFooters, extractText, postProcessText } from '@/doc';
import { chunkDocument } from '@/chunks';
import fs from "node:fs/promises";
import type { File, SaaSJob } from "@/types";
import { JWT } from "google-auth-library";
import path from 'node:path'
import type PgBoss from "pg-boss";
import { getConnector } from "@/db/connector";
import { getExtractor } from "@/embedding";
import { insertDocument } from "@/search/vespa";
import { ProgressEvent, SaaSQueue } from "@/queue";
import {
    useQuery,
    useMutation,
    useQueryClient,
    QueryClient,
    QueryClientProvider,
} from '@tanstack/react-query'
import { wsConnections } from "@/server";
import type { WSContext } from "hono/ws";

export const handleGoogleServiceAccountIngestion = async (boss: PgBoss, job: any) => {
    console.log('handleGoogleServiceAccountIngestion', job.data)
    const data: SaaSJob = job.data as SaaSJob
    try {
        const connector = await getConnector(data.connectorId)
        const serviceAccountKey = JSON.parse(connector.credentials as string)
        const subject: string = connector.subject as string
        const jwtClient = new JWT({
            email: serviceAccountKey.client_email,
            key: serviceAccountKey.private_key,
            scopes,
            subject
        });

        // boss.publish(ProgressEvent, {''})
        const fileMetadata = (await listFiles(jwtClient, subject)).map(v => {
            v.permissions = toPermissionsList(v.permissions, subject)
            return v
        })
        const totalFiles = fileMetadata.length
        const ws: WSContext = wsConnections.get(connector.externalId)
        if (ws) {
            ws.send(JSON.stringify({ totalFiles }))
        }
        const googleDocsMetadata = fileMetadata.filter(v => v.mimeType === DriveMime.Docs)
        const googleSheetsMetadata = fileMetadata.filter(v => v.mimeType === DriveMime.Sheets)
        const googleSlidesMetadata = fileMetadata.filter(v => v.mimeType === DriveMime.Slides)
        const rest = fileMetadata.filter(v => v.mimeType !== DriveMime.Docs)

        const documents: File[] = await googleDocsVespa(jwtClient, googleDocsMetadata)
        const driveFiles: File[] = await driveFilesToDoc(rest)


        console.log('generating embeddings')
        let allFiles: File[] = [...driveFiles, ...documents]

        for (const doc of allFiles) {
            await insertDocument(doc)
        }
    } catch (e) {
        console.error('could not finish job successfully', e)
        await boss.fail(job.name, job.id)
    }
}

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

export const listFiles = async (jwtClient: JWT, email: string, onlyDocs: boolean = false): Promise<drive_v3.Schema$File[]> => {
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

export const toPermissionsList = (drivePermissions: drive_v3.Schema$Permission[], ownerEmail: string): string[] => {
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
    return permissions
}

export enum DriveMime {
    Docs = "application/vnd.google-apps.document",
    Sheets = "application/vnd.google-apps.spreadsheet",
    Slides = "application/vnd.google-apps.presentation",
}

const extractor = await getExtractor()
export const googleDocsVespa = async (jwtClient: JWT, docsMetadata: drive_v3.Schema$File[]): Promise<any[]> => {
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

        console.clear()
        process.stdout.write(`${Math.floor((count / total) * 100)}`)
    }
    process.stdout.write('\n')
    return docsList

}

// export const googleDocs = async (jwtClient: JWT, docsMetadata: drive_v3.Schema$File[]): Promise<any[]> => {
//     const docsList: File[] = []
//     const docs = google.docs({ version: "v1", auth: jwtClient });
//     const total = docsMetadata.length
//     let count = 0
//     for (const doc of docsMetadata) {
//         const documentContent = await docs.documents.get({
//             documentId: doc.id,
//         });
//         const rawTextContent = documentContent?.data?.body?.content
//             .map((e) => extractText(e))
//             .join("");
//         const footnotes = extractFootnotes(documentContent.data);
//         const headerFooter = extractHeadersAndFooters(documentContent.data);
//         const cleanedTextContent = postProcessText(
//             rawTextContent + "\n\n" + footnotes + "\n\n" + headerFooter,
//         );

//         const chunks = chunkDocument(cleanedTextContent)
//         for (const { chunk, chunkIndex } of chunks) {
//             docsList.push({
//                 title: doc.name,
//                 url: doc.webViewLink,
//                 app: 'google',
//                 docId: doc.id,
//                 owner: doc?.owners[0]?.displayName,
//                 photoLink: doc?.owners[0]?.photoLink,
//                 ownerEmail: doc?.owners[0]?.emailAddress,
//                 entity: 'docs',
//                 chunk,
//                 chunkIndex,
//                 permissions: doc.permissions,
//                 mimeType: doc.mimeType
//             })
//         }

//         count += 1

//         console.clear()
//         process.stdout.write(`${Math.floor((count / total) * 100)}`)
//     }
//     process.stdout.write('\n')
//     return docsList

// }

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