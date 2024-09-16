import { drive_v3, google } from "googleapis";
import { extractFootnotes, extractHeadersAndFooters, extractText, postProcessText } from '@/doc';
import { chunkDocument } from '@/chunks';
import fs from "node:fs/promises";
import type { File } from "@/types";
import { JWT } from "google-auth-library";
import path from 'node:path'

const serviceAccountKey = JSON.parse(
    await fs.readFile(path.join(__dirname, '../service-account.json'), "utf-8"),
);
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

const userEmail = 'saheb@xynehq.com'
const jwtClient = new JWT({
    email: serviceAccountKey.client_email,
    key: serviceAccountKey.private_key,
    scopes,
    subject: userEmail,
});

export const listFiles = async (email: string, onlyDocs: boolean = false): Promise<drive_v3.Schema$File[]> => {
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

export const toPermissionsList = (drivePermissions: drive_v3.Schema$Permission[]): string[] => {
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
        permissions = [userEmail];
    }
    return permissions
}

export enum DriveMime {
    Docs = "application/vnd.google-apps.document",
    Sheets = "application/vnd.google-apps.spreadsheet",
    Slides = "application/vnd.google-apps.presentation",
}

export const googleDocs = async (docsMetadata: drive_v3.Schema$File[]): Promise<any[]> => {
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
        for (const { chunk, chunkIndex } of chunks) {
            docsList.push({
                title: doc.name,
                url: doc.webViewLink,
                app: 'google',
                docId: doc.id,
                owner: doc?.owners[0]?.displayName,
                photoLink: doc?.owners[0]?.photoLink,
                ownerEmail: doc?.owners[0]?.emailAddress,
                entity: 'docs',
                chunk,
                chunkIndex,
                permissions: doc.permissions,
                mimeType: doc.mimeType
            })
        }

        count += 1

        console.clear()
        process.stdout.write(`${Math.floor((count / total) * 100)}`)
    }
    process.stdout.write('\n')
    return docsList

}

export const driveFilesToDoc = (rest: drive_v3.Schema$File[]): File[] => {
    const mimeTypeMap = {
        // "application/vnd.google-apps.document": "docs",
        "application/vnd.google-apps.spreadsheet": "sheets",
        "application/vnd.google-apps.presentation": "slides",
        "application/vnd.google-apps.folder": "folder"
    };
    return rest.map(doc => {

        let entity
        if (mimeTypeMap[doc.mimeType]) {
            entity = mimeTypeMap[doc.mimeType]
        } else {
            entity = 'driveFile'
        }

        return {
            title: doc.name,
            url: doc.webViewLink,
            app: 'google',
            docId: doc.id,
            entity,
            chunk: '',
            owner: doc?.owners[0]?.displayName,
            photoLink: doc?.owners[0]?.photoLink,
            ownerEmail: doc?.owners[0]?.emailAddress,
            chunkIndex: 0,
            permissions: doc.permissions,
            mimeType: doc.mimeType
        }
    })
}