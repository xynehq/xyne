import fs from "node:fs";
import path from "node:path";
const transformers = require('@xenova/transformers');
const { env } = transformers;
import { getExtractor } from "@/embedding";
import { chunkDocument } from "@/chunks";
import PQueue from "p-queue";
env.backends.onnx.wasm.numThreads = 1;
const SCHEMA = 'file'; // Replace with your actual schema name
const NAMESPACE = 'namespace';

const extractor = await getExtractor();

const readline = require('readline');

// Create a PQueue instance with a defined concurrency limit
const queue = new PQueue({ concurrency: 100 }); // Adjust concurrency based on your system

const processLine = async (line: string) => {
    const columns = line.split('\t'); // Split the line by tab characters
    let chunks = chunkDocument(columns[1]);

    const document = {
        "put": `id:${NAMESPACE}:${SCHEMA}::${columns[0]}`,
        "fields": {
            "docId": columns[0],
            "title": columns[1].slice(0, 20),
            "url": "https://example.com/vespa-hybrid-search",
            "chunks": chunks.map(v => v.chunk),
            "permissions": [
                "junaid.s@xynehq.com"
            ],
            "chunk_embeddings": {}
        }
    };

    let chunkMap: Record<string, number[]> = {};
    for await (const c of chunks) {
        const { chunk, chunkIndex } = c;
        chunkMap[chunkIndex] = (await extractor(chunk, { pooling: 'mean', normalize: true })).tolist()[0];
    }

    document.fields["chunk_embeddings"] = chunkMap;
    return document;
};

const process_data = async (filePath: string) => {
    let processedData:any = [];
    let count = 0;
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity // Handle different newline characters
    });

    for await (const line of rl) {
        if(count >= 10) break;
        // Add line processing to the queue
        queue.add(async () => {
            const document = await processLine(line);
            processedData.push(document);
            console.log(`Processed ${count} lines.`);
            count++;
        });
    }

    // Wait for all tasks in the queue to complete
    await queue.onIdle();

    // Once all lines are processed, save the result to the file
    try {
        await fs.promises.writeFile('./test_data.json', JSON.stringify(processedData, null, 2), 'utf8');
        console.log("Processed data saved.");
    } catch (error) {
        console.error("Error saving processed data:", error);
    }
};

// Example usage
await process_data(path.resolve(__dirname, 'data/collectionandqueries/collection.tsv'))

// function writeJSONLLine(obj: any, filePath: string) {
//     const jsonLine = JSON.stringify(obj) + '\n';
//     fs.appendFile(filePath, jsonLine);
// }