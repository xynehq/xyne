import weaviate, { dataType, Filters, type WeaviateReturn } from 'weaviate-client'
import { env, pipeline } from '@xenova/transformers';
import fs from "node:fs/promises";
import { JWT } from "google-auth-library";
import { drive_v3, google } from "googleapis";
import { extractFootnotes, extractHeadersAndFooters, extractText, postProcessText } from './doc';
import { chunkDocument } from './chunks';
import { weaviateSchema } from './schema';
import type { File } from "./types";

import { progress_callback } from './utils';

env.backends.onnx.wasm.numThreads = 1;

const extractor = await pipeline('feature-extraction', 'Xenova/bge-base-en-v1.5', { progress_callback, cache_dir: env.cacheDir });

// const client = await weaviate.connectToLocal(
//     {
//         host: "127.0.0.1",   // URL only, no http prefix
//         port: 8080,
//         grpcPort: 50051,     // Default is 50051, WCD uses 443
//     })


// const collection = client.collections.get('DriveFiles');

export const searchGroupByCount = async (query: string, permissions: string[], app?: string, entity?: string): Promise<any> => {
    const qEmbedding = await extractor(query, { pooling: 'mean', normalize: true });

    let filters
    if (app && entity) {
        filters = Filters.and(
            collection.filter.byProperty('app').equal(app),
            collection.filter.byProperty('entity').equal(entity),
            collection.filter.byProperty('permissions').containsAny(permissions)
        )
    } else {
        filters = collection.filter.byProperty('permissions').containsAny(permissions)
    }

    const result = await collection.query.hybrid(query, {
        fusionType: 'Ranked',
        vector: qEmbedding.tolist()[0],
        // 1 is pure vector search, 0 is pure keyword search
        alpha: 0.25,
        limit: 500,
        returnProperties: ['app', 'entity'],
        returnMetadata: ['score'],
        filters,
    })

    result.objects = result.objects.filter(o => {
        return o?.metadata?.score > 0.01
    })
    let newRes = {}

    for (const obj of result.objects) {

        if (newRes[obj.properties.app] == null) {
            newRes[obj.properties.app] = {
                [obj.properties.entity]: 0
            }
        }
        if (newRes[obj.properties.app][obj.properties.entity] == null) {
            newRes[obj.properties.app][obj.properties.entity] = 0
        }
        newRes[obj.properties.app][obj.properties.entity] += 1
    }
    return newRes
}

export const search = async (query: string, limit: number, offset: number = 0, permissions: string[], app?: string, entity?: string): Promise<WeaviateReturn<undefined>> => {
    const qEmbedding = await extractor(query, { pooling: 'mean', normalize: true });
    let filters
    if (app && entity) {
        filters = Filters.and(
            collection.filter.byProperty('app').equal(app),
            collection.filter.byProperty('entity').equal(entity),
            collection.filter.byProperty('permissions').containsAny(permissions)
        )
    } else {
        filters = collection.filter.byProperty('permissions').containsAny(permissions)
    }
    const result = await collection.query.hybrid(query, {
        fusionType: 'Ranked',
        vector: qEmbedding.tolist()[0],
        // 1 is pure vector search, 0 is pure keyword search
        alpha: 0.25,
        limit,
        offset,
        returnMetadata: ['score', 'explainScore', 'certainty', 'distance'],
        filters,
    })
    return result
}


const fileWithoutContent = () => {

}

const getVectorStr = (name: string, body: string) => {
    if (body) {
        return `${name}\n${body}`
    } else {
        return `${name}`
    }
}

export const initI = async () => {

    await client.isReady()
    console.log('client ready')
    await client.collections.deleteAll()
    console.log('deleting all')

    await client.collections.create(weaviateSchema)

    const cachePath = './cache-data.json'

    let data = await checkAndReadFile(cachePath)
    if (!data) {
        const fileMetadata = (await listFiles(userEmail)).map(v => {
            v.permissions = toPermissionsList(v.permissions)
            return v
        })
        const googleDocsMetadata = fileMetadata.filter(v => v.mimeType === DriveMime.Docs)
        const googleSheetsMetadata = fileMetadata.filter(v => v.mimeType === DriveMime.Sheets)
        const googleSlidesMetadata = fileMetadata.filter(v => v.mimeType === DriveMime.Slides)
        const rest = fileMetadata.filter(v => v.mimeType !== DriveMime.Docs)

        const documents: File[] = await googleDocs(googleDocsMetadata)
        const driveFiles: File[] = driveFilesToDoc(rest)
        console.log(documents.length, driveFiles.length)

        data = await Promise.all([...driveFiles, ...documents].map(async (doc, i) => ({
            properties: {
                ...doc
            },
            vectors: (await extractor(getVectorStr(doc.title, doc.chunk), { pooling: 'mean', normalize: true })).tolist()[0],  // Add the generated vector
        })));
        await fs.writeFile(cachePath, JSON.stringify(data))
    }

    let processed = 0
    const batchSize = 30
    for (var i = 0; i < data.length; i += batchSize) {
        const part = data.slice(i, i + batchSize)
        const inserted = await collection.data.insertMany(part);
        processed += part.length
        console.log('inserting chunks: ', processed)
    }

}