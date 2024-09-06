import weaviate, { dataType, Filters, type WeaviateReturn } from 'weaviate-client'

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