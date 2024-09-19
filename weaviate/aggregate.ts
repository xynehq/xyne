// import weaviate, { dataType, Filters, type WeaviateReturn } from 'weaviate-client'
import { env, pipeline } from '@xenova/transformers';
import { Client } from '@notionhq/client';
env.backends.onnx.wasm.numThreads = 1;

import { crawler, pageToString } from "notion-md-crawler";
import { chunkDocument, chunkTextByParagraph } from './chunks';


const extractor = await pipeline('feature-extraction', 'Xenova/bge-base-en-v1.5', { cache_dir: env.cacheDir });

const client = await weaviate.connectToLocal({
    host: "127.0.0.1",
    port: 8080,
    grpcPort: 50051,
});


const collection = client.collections.get('DriveFiles');

async function hybridSearchWithAggregation(query: string, permissions: string[], limit: number = 100) {
    const qEmbedding = await extractor(query, { pooling: 'mean', normalize: true });

    // Perform hybrid search with aggregation directly
    const result = await collection.query.hybrid(query, {
        // fusionType: 'Ranked',
        vector: qEmbedding.tolist()[0],
        alpha: 0.25,
        // limit: 1000,
        // limit: 50,
        limit: 2000,
        returnProperties: ['entity', 'chunk', 'docId'],
        returnMetadata: ['score'],
        filters: collection.filter.byProperty('permissions').containsAny(permissions),
        // groupBy: {
        //     property: 'entity',
        //     numberOfGroups: 5,
        //     objectsPerGroup: 1000,
        // }
    });
    return result

}


// Usage example
// const permissions = ['saheb@xynehq.com'];
// const query = 'kalp';
// const result = await hybridSearchWithAggregation(query, permissions);

// console.log(result.objects.slice(0, 5))
// let r = {}
// for (const v of result.objects) {
//     if (r[v.properties['entity']] == null) {
//         r[v.properties['entity']] = 0
//     }
//     r[v.properties['entity']] += 1
// }
// console.log(r)

// for (const [entity, obj] of Object.entries(result.groups)) {
//     console.log(entity, obj.numberOfObjects)
// }

// for (const group of result.groups.entries()) {
//     console.log(group)
// }
