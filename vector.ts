import { QdrantClient } from '@qdrant/js-client-rest';

// TO connect to Qdrant running locally
const client = new QdrantClient({ url: 'http://127.0.0.1:6333' });
