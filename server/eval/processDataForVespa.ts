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

const processBatch = async (batch: string[]) => {
    const processedbatch: any[] = [];
    const allChunks: any[] = [];
    const documentChunksMap: Record<string, any[]> = {};

    for (const line of batch) {
        const columns = line.split('\t');
        const chunks = chunkDocument(columns[1]);
        
        // Store document chunks mapped to the document ID
        documentChunksMap[columns[0]] = chunks;

        // Collect all chunks for the embedding extraction
        allChunks.push(...chunks.map(c => c.chunk));

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
        processedbatch.push(document);
    }

    const embeddings = (await extractor(allChunks, { pooling: 'mean', normalize: true })).tolist();

    let embeddingIndex = 0;
    for (const doc of processedbatch) {
        const chunkMap: Record<number, number[]> = {};
        const chunks = documentChunksMap[doc.fields.docId];
        
        chunks.forEach((chunk, index) => {
            chunkMap[chunk.chunkIndex] = embeddings[embeddingIndex]; // Assign embedding to respective chunk
            embeddingIndex++;
        });

        // Assign chunk embeddings to the document
        doc.fields["chunk_embeddings"] = chunkMap;
    }

    return processedbatch;
};


const process_data = async (filePath: string) => {
    let count = 0;
    let totalProcessed = 0;
    let currentFileCount = 1;
    const batchSize = 1000;
    const docsPerFile = 1000000;
    let currentFileDocsCount = 0;
    let isFirstBatch = true;
    
    // Create the initial write stream
    let writeStream = createNewWriteStream(currentFileCount);

    // Read file in a streaming manner
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    const batch: string[] = [];
    let totalProcessingTime = 0;
    let linesRead = 0;

    writeStream.write('[\n');  // Initialize JSON array

    try {
        // Step 1: Read lines from the file
        for await (const line of rl) {
            linesRead++;

            try {
                const t1 = performance.now();

                batch.push(line);
                count++;
                totalProcessed++;
                currentFileDocsCount++;

                // Step 2: When batch size is reached, process and write data
                if (batch.length >= batchSize) {
                    const documents = await processBatch(batch);
                    await appendArrayChunk(writeStream, documents, isFirstBatch);
                    
                    batch.length = 0;  // Clear batch
                    isFirstBatch = false;
                }

                const t2 = performance.now();
                totalProcessingTime += (t2 - t1);
                console.log(`Processed ${totalProcessed} lines. Processing time: ${totalProcessingTime}ms`);

                // Step 3: When the file size limit is reached, finalize current file
                if (currentFileDocsCount >= docsPerFile) {
                    // Write remaining batch if any
                    if (batch.length > 0) {
                        const documents = await processBatch(batch);
                        await appendArrayChunk(writeStream, documents, isFirstBatch);
                        batch.length = 0;  // Clear batch
                    }

                    // Close current file
                    writeStream.write('\n]\n');
                    await new Promise<void>((resolve) => writeStream.end(resolve));

                    // Create new file and reset counters
                    currentFileCount++;
                    writeStream = createNewWriteStream(currentFileCount);
                    writeStream.write('[\n');
                    currentFileDocsCount = 0;
                    isFirstBatch = true;

                    console.log(`Created new file: process_data_${currentFileCount}.json`);
                }

            } catch (error) {
                console.error(`Error processing line ${linesRead}:`, error);
                await fs.promises.appendFile('error_log.txt', `Line ${linesRead}: ${error}\n${line}\n\n`);
            }
        }

        // Step 4: Write any remaining documents from the last batch
        if (batch.length > 0) {
            console.log(`Processing final batch of ${batch.length} documents`);
            const documents = await processBatch(batch);
            await appendArrayChunk(writeStream, documents, isFirstBatch);
        }

        // Close the final file
        writeStream.write('\n]\n');
        await new Promise<void>((resolve) => writeStream.end(resolve));

        // Verification step
        console.log("\nVerifying processed data...");
        console.log(`Total lines read: ${linesRead}`);
        console.log(`Total documents processed: ${totalProcessed}`);
        console.log(`Total files created: ${currentFileCount}`);

        // Verify that the number of documents processed matches the number of lines read
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
        if (writeStream) {
            writeStream.end();
        }
        rl.close();
        fileStream.close();
    }

    console.log("Processing complete with verification.");
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



// Example usage
await process_data('./eval/data/collectionandqueries/collection.tsv')
process.exit(0)
// function writeJSONLLine(obj: any, filePath: string) {
//     const jsonLine = JSON.stringify(obj) + '\n';
//     fs.appendFile(filePath, jsonLine);
// }