import weaviate, { dataType, Filters, type WeaviateReturn } from 'weaviate-client'

import { z, ZodString, ZodNumber, ZodArray, ZodTypeAny } from 'zod';

// Define the Zod schema manually
const fileSchema = z.object({
    docId: z.string(),
    app: z.string(),
    entity: z.string(),
    title: z.string(),
    url: z.string(),
    chunk: z.string(),
    chunkIndex: z.number(),
    owner: z.string(),
    ownerEmail: z.string(),
    photoLink: z.string(),
    permissions: z.array(z.string()),
    mimeType: z.string(),
});

export const FileCollectionName = 'Files'

export const fileVectorDBSchema = {

}




export const weaviateSchema = {
    name: 'DriveFiles',
    vectorizers: weaviate.configure.vectorizer.none(),
    properties: [
        {
            name: 'docId',
            dataType: dataType.TEXT,
            indexSearchable: false,
        },
        {
            name: 'app',
            dataType: dataType.TEXT,
            indexSearchable: false,
            indexFilterable: true,
        },
        {
            name: 'entity',
            dataType: dataType.TEXT,
            indexSearchable: false,
            indexFilterable: true,
        },
        {
            name: 'title',
            dataType: dataType.TEXT,
            indexSearchable: true,

        },
        {
            name: 'url',
            dataType: dataType.TEXT,
            // indexSearchable: true,
        },
        {
            name: 'chunk',
            dataType: dataType.TEXT,
            indexSearchable: true,

        },
        {
            name: 'chunkIndex',
            dataType: dataType.INT,
            indexSearchable: false,

        },
        {
            name: 'owner',
            dataType: dataType.TEXT,
            indexSearchable: true,
            indexFilterable: true
        },
        {
            name: 'ownerEmail',
            dataType: dataType.TEXT,
            indexSearchable: false,
            indexFilterable: true
        },
        {
            name: 'photoLink',
            dataType: dataType.TEXT,
            indexSearchable: false,
            indexFilterable: false
        },
        {
            name: 'permissions',
            dataType: dataType.TEXT_ARRAY,
            indexFilterable: true,
            indexSearchable: false,
        },
        {
            name: 'mimeType',
            dataType: dataType.TEXT,
            indexFilterable: true,
            indexSearchable: false,
        },
    ],
}