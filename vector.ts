import { QdrantClient } from '@qdrant/js-client-rest';
import { FileCollectionName } from './schema';
import { pipeline } from '@xenova/transformers';

// TO connect to Qdrant running locally
// const client = new QdrantClient({ url: 'http://127.0.0.1:6333' });

// const extractor = await pipeline('feature-extraction', 'Xenova/bge-base-en-v1.5', { cache_dir: env.cacheDir });

// client.createCollection(FileCollectionName, {
//     vectors: {
//         chunk: { size: 1536, distance: "Cosine", datatype: "float32", on_disk: true },
//     },
// });