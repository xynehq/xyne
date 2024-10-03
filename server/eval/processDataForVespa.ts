import fs from "node:fs";
import path from "node:path";
import * as transformers from "@xenova/transformers"
const { env } = transformers;
import { getExtractor } from "@/embedding";
import { chunkDocument } from "@/chunks";
import PQueue from "p-queue";
env.backends.onnx.wasm.numThreads = 1;
const SCHEMA = 'file'; // Replace with your actual schema name
const NAMESPACE = 'namespace';

const extractor = await getExtractor();
import readline from 'readline'
// const readline = require('readline');

// Create a PQueue instance with a defined concurrency limit
const queue = new PQueue({ concurrency: 500 }); // Adjust concurrency based on your system

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
    // for await (const c of chunks) {
    //     const { chunk, chunkIndex } = c;
    //     chunkMap[chunkIndex] = (await extractor(chunk, { pooling: 'mean', normalize: true })).tolist()[0];
    // }
    const chunkPromises = chunks.map(async (c) => {
        const { chunk, chunkIndex } = c;
        const embedding = (await extractor(chunk, { pooling: 'mean', normalize: true })).tolist()[0];
        chunkMap[chunkIndex] = embedding;
    });

    await Promise.all(chunkPromises);

    document.fields["chunk_embeddings"] = chunkMap;
    return document;
};

const process_data = async (filePath: string) => {
    let processedData: any = [];
    let count = 0;
    let batchSize = 100000;
    let fileIndex = 0;
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity // Handle different newline characters
    });

    let total = 0
    for await (const line of rl) {
        // Add line processing to the queue
        queue.add(async () => {
            let t1 = performance.now()
            const document = await processLine(line);
            processedData.push(document);
            count++;
            let t2 = performance.now()
            total += (t2 - t1)
            console.log(total)
            console.log(`Processed ${count} lines.`);

            if ((count % batchSize) === 0) {
                fileIndex++;
                await saveToFile(`./process_data_${fileIndex}.json`, processedData);
                processedData = []; // Clear memory
            }
        });
    }

    if (processedData.length > 0) {
        console.log("processed length inside")
        fileIndex++;
        await saveToFile(`./process_data_${fileIndex}.json`, processedData);
    }
    // Wait for all tasks in the queue to complete
    await queue.onIdle();

};


const saveToFile = async (fileName: string, data: any) => {
    try {
        await fs.promises.writeFile(fileName, JSON.stringify(data, null, 2), 'utf8');
        console.log(`${fileName} saved.`);
    } catch (error) {
        console.error("Error saving processed data:", error);
    }
};

// Example usage
await process_data(path.resolve(import.meta.dirname, 'data/collectionandqueries/collection.tsv'))
process.exit(0)
// function writeJSONLLine(obj: any, filePath: string) {
//     const jsonLine = JSON.stringify(obj) + '\n';
//     fs.appendFile(filePath, jsonLine);
// }