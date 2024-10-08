import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { Worker, isMainThread, workerData, parentPort } from 'worker_threads';
import os from 'os';
import PQueue from 'p-queue';
import { chunkDocument } from "@/chunks"; // Assuming this function breaks document text into chunks.
import { getExtractor } from "@/embedding"; // Assuming this fetches an embedding extractor.

const SCHEMA = 'file';
const NAMESPACE = 'namespace';
const NUM_WORKERS = os.cpus().length;
const BATCH_SIZE = 10;
const DOCS_PER_FILE = 100;

if (isMainThread) {
    console.log("Main thread");

    const processData = async (filePath: string) => {
        const fileStream = fs.createReadStream(filePath);
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });

        const workers: Worker[] = [];
        for (let i = 0; i < NUM_WORKERS; i++) {
            const worker = new Worker(__filename, { workerData: { workerId: i } });
            workers.push(worker);
        }

        let lineCount = 0;
        let workerIndex = 0;
        let batch: string[] = [];
        let currentFileCount = 1;
        let totalProcessed = 0;
        let currentFileDocsCount = 0;
        let writeStream = createNewWriteStream(currentFileCount);
        writeStream.write('[\n');
        let isFirstBatch = true;

        const results: any[] = [];

        for await (const line of rl) {
            batch.push(line);
            lineCount++;

            if (batch.length >= BATCH_SIZE) {
                workers[workerIndex].postMessage(batch);
                workerIndex = (workerIndex + 1) % NUM_WORKERS;
                batch = [];
            }
        }

        if (batch.length > 0) {
            workers[workerIndex].postMessage(batch);
        }

        workers.forEach(worker => worker.postMessage('END'));

        await new Promise<void>((resolve) => {
            workers.forEach(worker => {
                worker.on('message', async (message) => {
                    if (message === 'DONE') {
                        return;
                    }

                    const processedBatch = message as any[];
                    totalProcessed += processedBatch.length;
                    currentFileDocsCount += processedBatch.length;
                    await appendArrayChunk(writeStream, processedBatch, isFirstBatch);
                    isFirstBatch = false;

                    // Check if we need to write a new file
                    if (currentFileDocsCount >= DOCS_PER_FILE) {
                        writeStream.write('\n]\n');
                        await new Promise<void>((resolve) => writeStream.end(resolve));

                        currentFileCount++;
                        writeStream = createNewWriteStream(currentFileCount);
                        writeStream.write('[\n');
                        isFirstBatch = true;
                        currentFileDocsCount = 0;
                    }

                    if (totalProcessed === lineCount) {
                        writeStream.write('\n]\n');
                        await new Promise<void>((resolve) => writeStream.end(resolve));
                        resolve();
                    }
                });
            });
        });

        console.log(`All ${lineCount} lines processed and saved.`);
    };

    processData(path.resolve(__dirname, 'data/collectionandqueries/collection.tsv'));

} else {
    (async () => {
        const { workerId } = workerData;
        const extractor = await getExtractor();
        const queue = new PQueue({ concurrency: 10 });

        const processLine = async (line: string) => {
            const columns = line.split('\t');
            const chunks = chunkDocument(columns[1]);
            const document = {
                "put": `id:${NAMESPACE}:${SCHEMA}::${columns[0]}`,
                "fields": {
                    "docId": columns[0],
                    "title": columns[1].slice(0, 20),
                    "url": "https://example.com/vespa-hybrid-search",
                    "chunks": chunks.map(v => v.chunk),
                    "permissions": ["junaid.s@xynehq.com"],
                    "chunk_embeddings": {}
                }
            };

            const chunkEmbeddings = await Promise.all(chunks.map(async c => {
                const { chunk, chunkIndex } = c;
                const embedding = await extractor(chunk, { pooling: 'mean', normalize: true });
                return [chunkIndex, embedding.tolist()[0]];
            }));

            document.fields["chunk_embeddings"] = Object.fromEntries(chunkEmbeddings);
            return document;
        };

        parentPort!.on('message', async (message) => {
            if (message === 'END') {
                parentPort!.postMessage('DONE');
                return;
            }

            const batch = message as string[];
            const processedBatch = await Promise.all(batch.map(line => queue.add(() => processLine(line))));
            parentPort!.postMessage(processedBatch);
        });
    })();
}

// Create a new write stream with unique file name
const createNewWriteStream = (fileCount: number): fs.WriteStream => {
    const fileName = `process_data_${fileCount}.json`;
    return fs.createWriteStream(fileName, { flags: 'a' });
};

// Helper function to safely append array chunk
const appendArrayChunk = async (
    writeStream: fs.WriteStream, 
    data: any[], 
    isFirstBatch: boolean
): Promise<void> => {
    return new Promise((resolve, reject) => {
        const chunk = data.map(item => JSON.stringify(item)).join(',\n');
        const content = isFirstBatch ? chunk : ',\n' + chunk;
        
        writeStream.write(content, (error) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
};
