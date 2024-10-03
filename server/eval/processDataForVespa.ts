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
    let processedData: any[] = [];
    let count = 0;
    let totalProcessed = 0;
    let currentFileCount = 1;
    const batchSize = 100;
    const docsPerFile = 5000;
    let currentFileDocsCount = 0;
    
    let writeStream = createNewWriteStream(currentFileCount);
    let isFirstBatch = true;

    // Create a counter for verification
    let linesRead = 0;
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    let total = 0;
    writeStream.write('[\n');

    try {
        for await (const line of rl) {
            linesRead++;
            
            await queue.add(async () => {
                try {
                    let t1 = performance.now();
                    const document = await processLine(line);
                    
                    if (!document) {
                        throw new Error(`Failed to process line ${linesRead}`);
                    }

                    processedData.push(document);
                    count++;
                    totalProcessed++;
                    currentFileDocsCount++;
                    
                    let t2 = performance.now();
                    total += (t2 - t1);
                    console.log(`Processed ${totalProcessed} lines. Processing time: ${total}ms`);

                    // Check if we need to write the batch
                    if (count >= batchSize) {
                        await appendArrayChunk(writeStream, processedData, isFirstBatch);
                        processedData = [];  // Clear memory
                        count = 0;  // Reset batch counter
                        isFirstBatch = false;
                    }

                    // Check if we need to create a new file
                    if (currentFileDocsCount >= docsPerFile) {
                        // Write any remaining documents to current file
                        if (processedData.length > 0) {
                            await appendArrayChunk(writeStream, processedData, isFirstBatch);
                            processedData = [];
                            count = 0;
                        }

                        // Close current file
                        writeStream.write('\n]\n');
                        await new Promise<void>((resolve) => writeStream.end(resolve));
                        
                        // Create new file
                        currentFileCount++;
                        writeStream = createNewWriteStream(currentFileCount);
                        writeStream.write('[\n');
                        isFirstBatch = true;  // Reset for new file
                        currentFileDocsCount = 0;
                        
                        console.log(`Created new file: process_data_${currentFileCount}.json`);
                    }

                } catch (error) {
                    console.error(`Error processing line ${linesRead}:`, error);
                    await fs.promises.appendFile('error_log.txt', 
                        `Line ${linesRead}: ${error}\n${line}\n\n`);
                }
            });
        }

        // Process remaining documents
        if (processedData.length > 0) {
            console.log(`Processing final batch of ${processedData.length} documents`);
            await appendArrayChunk(writeStream, processedData, isFirstBatch);
        }

        // Close final file
        writeStream.write('\n]\n');
        await new Promise<void>((resolve) => writeStream.end(resolve));

        // Verification step
        console.log("\nVerifying processed data...");
        console.log(`Total lines read: ${linesRead}`);
        console.log(`Total documents processed: ${totalProcessed}`);
        console.log(`Total files created: ${currentFileCount}`);

        // Verify each file
        let totalDocsInFiles = 0;
        for (let i = 1; i <= currentFileCount; i++) {
            const fileName = `process_data_${i}.json`;
            const fileContent = await fs.promises.readFile(fileName, 'utf8');
            const parsedData = JSON.parse(fileContent);
            totalDocsInFiles += parsedData.length;
            console.log(`File ${fileName}: ${parsedData.length} documents`);
        }

        if (linesRead !== totalProcessed) {
            console.error(`Warning: Mismatch between lines read (${linesRead}) and documents processed (${totalProcessed})`);
            throw new Error('Processing verification failed: Count mismatch');
        }

        if (totalDocsInFiles !== totalProcessed) {
            throw new Error(`Verification failed: Files contain ${totalDocsInFiles} documents but processed ${totalProcessed}`);
        }

    } catch (error) {
        console.error("Processing failed:", error);
        throw error;
    } finally {
        // Ensure streams are closed
        writeStream.end();
        rl.close();
        fileStream.close();
    }

    console.log("Processing complete with verification.");
    await queue.onIdle();
};

// Helper function to create new write stream
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


const saveToFile = async (fileName: string, data: any) => {
    try {
        await fs.promises.writeFile(fileName, JSON.stringify(data, null, 2), 'utf8');
        console.log(`${fileName} saved.`);
    } catch (error) {
        console.error("Error saving processed data:", error);
    }
};
// const appendArrayChunk = async (writeStream: any, data: any, isFirstBatch: boolean) => {
//     try {
//         const jsonData = data.map(doc => JSON.stringify(doc)).join(',\n');

//         // If it's not the first batch, prepend with a comma
//         if (!isFirstBatch) {
//             writeStream.write(',\n' + jsonData);
//         } else {
//             writeStream.write(jsonData);
//         }

//         console.log(`Appended ${data.length} records to file.`);
//     } catch (error) {
//         console.error("Error saving processed data:", error);
//     }
// };


// Example usage
await process_data('./data/collectionandqueries/collection.tsv')
process.exit(0)
// function writeJSONLLine(obj: any, filePath: string) {
//     const jsonLine = JSON.stringify(obj) + '\n';
//     fs.appendFile(filePath, jsonLine);
// }