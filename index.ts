import fs from "node:fs/promises";
import { $ } from "bun";

import {
    Document, VectorStoreIndex, QdrantVectorStore, storageContextFromDefaults, ContextChatEngine, type QueryEngine, RetrieverQueryEngine, type NodeWithScore, Settings, MetadataMode, SimpleNodeParser, SentenceSplitter, TextSplitter, NodeParser,
    type BaseNodePostprocessor,
    type MessageContent

} from "llamaindex";
import { JWT } from "google-auth-library";
import { drive_v3, google } from "googleapis";
import { chromium, type Page } from 'playwright';
import cleanup from './cleanup';
import Turndown from 'turndown';
import { Readability } from "@mozilla/readability";
import path from 'node:path'
import {
    setInterval
} from 'node:timers/promises';
console.clear()

const criticalSectionMutex = new Mutex();
import {
    extractFootnotes,
    extractHeadersAndFooters,
    extractText,
    postProcessText,
} from "./doc";
const serviceAccountKey = JSON.parse(
    await fs.readFile('./service-account.json', "utf-8"),
);
const scopes = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/admin.directory.user.readonly",
    "https://www.googleapis.com/auth/documents.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/presentations.readonly",
];

const userEmail = 'saheb@xynehq.com'
const jwtClient = new JWT({
    email: serviceAccountKey.client_email,
    key: serviceAccountKey.private_key,
    scopes,
    subject: userEmail,
});

const debug = false

const fileId = '1UvTIACPP7M0zRtPGUvReSYCN9Rf8bcVOL2pmeXA2nz4'
const drive = google.drive({ version: "v3", auth: jwtClient });
const pdfFileId = '17AD2k8sQW842gm79VGTRPQmoszHQuUZh'

const MIME_TYPE = 'application/vnd.google-apps.document';

const getDriveFile = async (fileId: string): Promise<drive_v3.Schema$File> => {

    // let permissions = [];
    const driveResp = await drive.files.get({
        fileId: fileId,
        fields:
            "id, name, owners, sharingUser, webViewLink, createdTime, modifiedTime, permissions(id, type, emailAddress)",
    });
    const file = driveResp.data;
    const { id, name, webViewLink, createdTime, modifiedTime, owners } = file;

    file.permissions = toPermissionsList(file.permissions)
    return file
}


const toPermissionsList = (drivePermissions: drive_v3.Schema$Permission[]): string[] => {
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

const fetchLatestDoc = async (fileId: string): Promise<string> => {
    const docs = google.docs({ version: "v1", auth: jwtClient });
    // Handle Google Docs
    let rawTextContent
    try {
        const documentContent = await docs.documents.get({
            documentId: fileId,
        });
        rawTextContent = documentContent?.data?.body?.content
            .map((e) => extractText(e))
            .join("") || "";
    } catch (e) {
        // console.log('catch ', e)
        rawTextContent = ""
    }
    return rawTextContent
}
// const footnotes = extractFootnotes(documentContent.data);
// const headerFooter = extractHeadersAndFooters(documentContent.data);
// const cleanedTextContent = postProcessText(
//     rawTextContent + "\n\n" + footnotes + "\n\n" + headerFooter,
// );

enum ChangeType {
    Content = 'content',
    Permission = 'permission',
}

type HandleCallback = (changes: ChangeType[], file: drive_v3.Schema$File) => void

const CHECK_INTERVAL = 5000

class GoogleDocChangeChecker {
    private driveClient: drive_v3.Drive;
    private pageToken: string | null = null;
    private pFile: drive_v3.Schema$File;

    constructor(authClient: JWT, fileToSync: drive_v3.Schema$File) {
        this.driveClient = google.drive({ version: 'v3', auth: authClient });
        this.pFile = fileToSync;
    }

    private havePermissionsChanged(currentPermissions: string[]): boolean {
        const initialPermissions = this.pFile.permissions || [];
        if (currentPermissions.length !== initialPermissions.length) {
            return true;
        }
        for (let i = 0; i < currentPermissions.length; i++) {
            if (currentPermissions[i] !== initialPermissions[i]) {
                return false;
            }
        }

        return false;
    }

    private async initialize() {
        try {
            const response = await this.driveClient.changes.getStartPageToken({});
            this.pageToken = response.data.startPageToken || null;
            // console.log('Initialized with start page token:', this.pageToken);
        } catch (error) {
            console.error('Error initializing change checker:', error);
        }
    }

    // async watch() {
    //     this.driveClient.changes.watch()
    // }

    async checkForChanges(): Promise<drive_v3.Schema$Change | null> {
        if (!this.pageToken) {
            // console.log('No page token available. Initializing...');
            await this.initialize();
            return null;
        }

        if (!this.pFile.name) {
            try {
                file = await getDriveFile(fileId)
                this.pFile = file
            } catch (e) {
                return null
            }
        }
        try {
            // console.log('checking')
            const response = await this.driveClient.changes.list({
                pageToken: this.pageToken,
                spaces: 'drive',
                fields: '*',
                // supportsAllDrives: true
                // fields: 'changes(file(id, name, owners, sharingUser, webViewLink, createdTime, modifiedTime, permissions(id, type, emailAddress)), changeType), newStartPageToken',
            });

            const changes = response.data.changes || [];
            // we only check the file id and not mime type
            // because when we lose access to a file
            // we do not get file object
            const relevantChange = changes.find(change =>
                change.fileId === fileId
                // change.file.mimeType === MIME_TYPE
            );
            this.pageToken = response.data.newStartPageToken || this.pageToken;

            if (relevantChange && relevantChange.file) {
                if (relevantChange.file.permissions && this.havePermissionsChanged(toPermissionsList(relevantChange.file.permissions))) {
                    // console.log('Document permissions changed');
                } else {
                    // console.log()
                }
                this.pFile = relevantChange.file
                return relevantChange
            } else if (relevantChange && relevantChange.removed) {
                // file was removed or user lost access
                return relevantChange
            }

            // Update the page token for the next check
        } catch (error) {
            // console.error('Error checking for changes:', error);
        }
        return null
    }
}
export type ScraperLoadOptions =
    | {
        format?: 'html' | 'text' | 'markdown' | 'cleanup'
    }
    | {
        format: 'custom'
        formatFunction: (page: Page) => Promise<string> | string
    }
    | {
        format: 'image'
        fullPage?: boolean
    }

export type ScraperLoadResult = {
    url: string
    content: string
    format: ScraperLoadOptions['format']
}

const preprocess = async (
    page: Page,
    options: ScraperLoadOptions = { format: 'html' }
): Promise<ScraperLoadResult> => {
    const url = page.url()
    let content = ""

    if (options.format === 'html') {
        content = await page.content()
    }

    if (options.format === 'markdown') {
        const body = await page.innerHTML('body')
        content = new Turndown().turndown(body)
    }

    if (options.format === 'text') {
        const readabilityScript = await fs.readFile(path.resolve('./node_modules/@mozilla/readability/Readability.js'), 'utf8');

        // Inject the Readability script into the page context

        try {

            await page.evaluate(readabilityScript);
            const readable = await page.evaluate(() => {
                // const documentClone = document.cloneNode(true);
                const reader = new Readability(document);
                const article = reader.parse();
                return article;
            });
            content = `Page Title: ${readable.title.replaceAll('\n', '')}\n${readable.textContent}`
        } catch (e) {
            content = `Page Title: ${page.title}\n${await page.innerText('body')}`
        }
        // Run Readability and extract the article

    }

    if (options.format === 'cleanup') {
        await page.evaluate(cleanup)
        content = await page.content()
    }

    if (options.format === 'image') {
        const image = await page.screenshot({ fullPage: options.fullPage })
        content = image.toString('base64')
    }

    if (options.format === 'custom') {
        if (
            !options.formatFunction ||
            typeof options.formatFunction !== 'function'
        ) {
            throw new Error('customPreprocessor must be provided in custom mode')
        }

        content = await options.formatFunction(page)
    }

    return {
        url,
        content,
        format: options.format,
    }
}

Settings.callbackManager.on('llm-start', (event) => {
    if (debug) {
        console.log(event.detail, JSON.stringify(event.detail.messages[0]))
    }
})

Settings.callbackManager.on('llm-end', (event) => {
    // console.log(event.detail)
})

Settings.callbackManager.on("retrieve-end", (event) => {
    const { nodes } = event.detail;
    if (debug) {
        console.log(
            "The retrieved nodes are:",
            nodes.map((node: NodeWithScore) => node.node.getContent(MetadataMode.NONE)),
        );

    }
});

Settings.callbackManager.on('chunking-end', (event) => {
    // const { nodes } = event.detail;
    if (debug) {
        console.log('chunking end', event.detail);

    }
})

// Settings.callbackManager.on('chunking-start', (event) => {
//     console.log(event.detail)
// })


Settings.callbackManager.on('node-parsing-end', (event) => {
    if (debug) {

        console.log('nodes parsing end: ', event.detail)
    }
})

// if I'm not the owner must sync

const vectorStore = new QdrantVectorStore({
    url: "http://localhost:6333",
    collectionName: 'local_rag',
});
const ctx = await storageContextFromDefaults({ vectorStore });

// this is done coz if fileId access is gone now
// it will throw error
let file
try {
    file = await getDriveFile(fileId)
} catch (e) {
    // console.log('e ', e)
    file = {
        permissions: []
    }
}

import { PDFReader } from "llamaindex/readers/PDFReader";


// const pdfFile = await getDriveFile(pdfFileId)
// const res = await drive.files.get({ fileId: pdfFileId, alt: 'media' }, { responseType: 'stream' });
// const response = await drive.files.get(
//     { fileId, alt: 'media' },
//     { responseType: 'arraybuffer' }
// );
// const response = await drive.files.get({ fileId: pdfFileId, alt: 'media' }, { responseType: 'stream' })
// const response = await drive.files.get({
//     fileId: fileId,
//     alt: 'media',
// });
// const response = await drive.files.export({
//     fileId: pdfFileId,
//     mimeType: 'application/pdf',
// });

// const data = new Uint8Array(await response.data.arrayBuffer())
const escapeText = (text: string): string => {
    return text.replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
};

const pdfFile = await fs.readFile('./pdf-data/ai-integrations.pdf')

const data = new Uint8Array(pdfFile)
const reader = new PDFReader()
const pdf = require('pdf-parse')
const pdfDocs = (await reader.loadDataAsContent(data)).map(v => {
    v.id_ = pdfFileId;
    v.metadata.permissions = [userEmail];
    v.metadata.excludedEmbedMetadataKeys = ['permissions'];
    v.metadata.excludedLlmMetadataKeys = ['permissions'];
    // console.log(v.text)
    // v.text = escapeText(v.text)
    return v
})


class MinimalNodePostprocessor implements BaseNodePostprocessor {
    async postprocessNodes(
        nodes: NodeWithScore[],
        query?: MessageContent
    ): Promise<NodeWithScore[]> {
        // Log input for inspection (can be removed in production)
        // console.log('Input nodes:', nodes);
        // console.log('Query:', query);

        // Return nodes without modification
        return nodes;
    }
}

const checker = new GoogleDocChangeChecker(jwtClient, file);
const syncRetriever = async (rawTextContent: string): Promise<{ index: VectorStoreIndex, queryEngine: QueryEngine & RetrieverQueryEngine, chatEngine: ContextChatEngine }> => {
    // const release = await criticalSectionMutex.acquire()
    let index, queryEngine, chatEngine
    if (rawTextContent.trim() !== '') {
        const document = new Document({ text: rawTextContent, id_: file.id || "", metadata: { permissions: file.permissions }, excludedEmbedMetadataKeys: ['permissions'], excludedLlmMetadataKeys: ['permissions'] });


        index = await VectorStoreIndex.fromDocuments([document], {
            storageContext: ctx,
        });


        queryEngine = index.asQueryEngine({
            preFilters: {
                filters: [{
                    key: 'permissions',
                    value: userEmail,
                    operator: 'in'
                }]
            },
            // nodePostprocessors: [minimal]
        });

        chatEngine = new ContextChatEngine({ retriever: queryEngine.retriever })
        const qePrompts = queryEngine.getPrompts()
        const chatPrompts = chatEngine.getPrompts()
        chatPrompts["contextGenerator:contextSystemPrompt"] = qePrompts["responseSynthesizer:textQATemplate"]
        chatEngine.updatePrompts(chatPrompts)
    } else {
        index = await VectorStoreIndex.fromDocuments([...pdfDocs], {
            storageContext: ctx
        });

        // queryEngine = index.asQueryEngine();
        queryEngine = index.asQueryEngine({
            preFilters: {
                filters: [{
                    key: 'permissions',
                    value: userEmail,
                    operator: 'in'
                }]
            },
        });
        chatEngine = new ContextChatEngine({ retriever: queryEngine.retriever })
        const qePrompts = queryEngine.getPrompts()
        const chatPrompts = chatEngine.getPrompts()
        chatPrompts["contextGenerator:contextSystemPrompt"] = qePrompts["responseSynthesizer:textQATemplate"]
        chatEngine.updatePrompts(chatPrompts)

    }
    // release()
    return { index, queryEngine, chatEngine }
}

const rawTextContent = file.name ? await fetchLatestDoc(fileId) : '';

const release = await criticalSectionMutex.acquire()
let { index, queryEngine, chatEngine } = await syncRetriever(rawTextContent);
release();

// const chatEngine = new ContextChatEngine({  });


// await vectorStore.delete(fileId)
// ctx.vectorStores.TEXT?.delete(fileId)
// console.log('deleted')
// update vector db
(async () => {
    for await (const startTime of setInterval(CHECK_INTERVAL, Date.now())) {
        if (criticalSectionMutex.isLocked()) {
            continue;
        }
        const release = await criticalSectionMutex.acquire()
        const change = await checker.checkForChanges()
        let chatHistoryToRestore = chatEngine?.chatHistory
        // if (change) {
        let cFileId
        if (change?.removed) {
            cFileId = change.fileId
            await vectorStore.delete(cFileId)
            // the case where we want to remove those messages from the chatmessages.

        } else {
            cFileId = fileId//change ? change.file.id : fileId
            // console.log(cFileId)
            // const modifiedDate = new Date(change.file?.modifiedTime);
            // const currentDate = new Date();
            // const timeDifferenceMs = currentDate - modifiedDate;

            // console.log('change ', change)
            // console.log(`Change has been detected in file ${fileId}.`)

            // try {

            //     // delete if exists
            //     await vectorStore.delete(cFileId)
            // } catch (e) {

            // }
            const rawTextContent = file.name ? await fetchLatestDoc(cFileId) : '';
            let syncedIndex = await syncRetriever(rawTextContent)
            // update the global variables
            index = syncedIndex.index
            queryEngine = syncedIndex.queryEngine
            syncedIndex.chatEngine.chatHistory = chatHistoryToRestore

            chatEngine = syncedIndex.chatEngine
        }
        release();
        // else {
        // }
        // }
    }
})();

// const chatMessages = []

const handleResponse = async (query: string) => {
    const release = await criticalSectionMutex.acquire()
    const stream = await chatEngine.chat({ message: query, stream: true, verbose: true })

    let buffer = `## ${query} \n\n`
    let lastLogIndex = 0
    let output = ''
    for await (const chunk of stream) {
        buffer += chunk.message.content
        output = await $`echo ${buffer} | glow --style auto`.text()
        lastLogIndex += 1
        if (lastLogIndex % 5 == 0) {
            console.clear()
            console.log(output)
            lastLogIndex = 0
        }
    }
    if (lastLogIndex !== 0 && output) {
        console.clear()
        console.log(output)
    }
    release()
}

const handleWebsiteResponse = async (query: string, content: string) => {
    const stream = await openai.chat.completions.create({
        messages: [
            { role: "system", content: "You are a helpful AI assistant." },
            { role: "user", content: `I have gathered some data from a website. Here is the content: \n\n"${content}"\n\nBased on this information, I need an answer to the following question: "${query}". Answer exactly as it asked. Do not provide extra information than necessary.` }
        ],
        model: 'gpt-4o',
        stream: true,
        temperature: 0
    })
    process.stdout.write('\n')
    const release = await criticalSectionMutex.acquire()
    let buffer = `## ${query}\n\n`
    let lastLogIndex = 0
    let output = ''
    for await (const chunk of stream) {
        const val = chunk.choices[0].delta.content
        if (val) {
            buffer += chunk.choices[0].delta.content
        }

        output = await $`echo ${buffer} | glow --style auto`.text()
        lastLogIndex += 1
        if (lastLogIndex % 5 == 0 && output) {
            console.clear()
            console.log(output)
            lastLogIndex = 0
        }
    }
    if (lastLogIndex !== 0 && output) {
        console.clear()
        console.log(output)
    }
    release()

}

const key = "visit_website"
import OpenAI from "openai";
import { Mutex } from "async-mutex";
const openai = new OpenAI();


// const websiteVector = new QdrantVectorStore({
//     url: "http://localhost:6333",
//     collectionName: 'website_rag'
// });

// const websiteCtx = await storageContextFromDefaults({ vectorStore });
// function extractSingleUrl(text: string): string | null {
//     const urlPattern = /https?:\/\/(?:[-\w.]|(?:%[\da-fA-F]{2}))+/;
//     const match = text.match(urlPattern);
//     return match ? match[0] : null;
// }
function extractSingleUrl(text: string): string | null {
    const urlPattern = /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*)/;
    const match = text.match(urlPattern);
    return match ? match[0] : null;
}

const prompt = "";
process.stdout.write(prompt);
for await (const line of console) {
    if (line.trim() !== '') {
        const completion = await openai.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: `You are a helpful assistant designed to output JSON. Did the user in the query ask to visit a website "yes" or "no".
            This is the format { "${key}": "yes" } `,
                },
                { role: "user", content: line },
            ],
            model: "gpt-4o-mini",
            response_format: { type: "json_object" },
            temperature: 0
        });
        const output = completion.choices[0].message.content
        const jsonOutput = JSON.parse(output)
        if (jsonOutput[key] === "yes") {
            const url = extractSingleUrl(line)
            if (!url) {
                throw Error('Could not extract url')
            }
            const website = url
            const browser = await chromium.launch()
            const page = await browser.newPage()
            await page.goto(website)
            await page.waitForLoadState('networkidle')
            const { content } = await preprocess(page, { format: 'markdown' })
            await handleWebsiteResponse(line, content)
        } else {
            await handleResponse(line)
        }
        process.stdout.write(prompt);

    }
}