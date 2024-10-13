import fs from "node:fs"
import path from "node:path"
import * as transformers from "@xenova/transformers"
const { env } = transformers
import { getExtractor } from "@/embedding"
import { chunkDocument } from "@/chunks"
env.backends.onnx.wasm.numThreads = 1

// this will share the cache embedding model from /server
env.localModelPath = "../"
env.cacheDir = "../"

const SCHEMA = "file" // Replace with your actual schema name
const NAMESPACE = "namespace"

const extractor = await getExtractor()
import readline from "readline"

const corpusPath = path.resolve(import.meta.dirname, "data/fiqa/corpus.jsonl")
const user = "junaid.s@xynehq.com"

// This function processes an entire batch of data at once,
// generating embeddings for all chunks in the batch simultaneously,
// and returns the processed batch.
const processBatch = async (batch: any[]) => {
  const processedbatch: any[] = []
  const allChunks: any[] = []
  const documentChunksMap: Record<string, any[]> = {}

  for (const line of batch) {
    const chunks = chunkDocument(line.text)
    // Store document chunks mapped to the document ID
    documentChunksMap[line._id] = chunks

    // Collect all chunks for the embedding extraction
    allChunks.push(...chunks.map((c) => c.chunk))

    const document = {
      put: `id:${NAMESPACE}:${SCHEMA}::${line._id}`,
      fields: {
        docId: line._id,
        title: line.text.slice(0, 50),
        url: "https://example.com/vespa-hybrid-search",
        // Clean up the ASCII characters
        chunks: chunks.map((v) => v.chunk.replace(/[\x00-\x1F\x7F]/g, "")),
        permissions: [user],
        chunk_embeddings: {},
      },
    }
    processedbatch.push(document)
  }

  const embeddings = (
    await extractor(allChunks, { pooling: "mean", normalize: true })
  ).tolist()

  let embeddingIndex = 0
  for (const doc of processedbatch) {
    const chunkMap: Record<number, number[]> = {}
    const chunks = documentChunksMap[doc.fields.docId]

    chunks.forEach((chunk, index) => {
      chunkMap[chunk.chunkIndex] = embeddings[embeddingIndex]
      embeddingIndex++
    })

    // Assign chunk embeddings to the document
    doc.fields["chunk_embeddings"] = chunkMap
  }

  return processedbatch
}

const processData = async (filePath: string) => {
  let count = 0
  let totalProcessed = 0
  let currentFileCount = 1
  const batchSize = 50
  const docsPerFile = 10000
  let currentFileDocsCount = 0
  let isFirstBatch = true

  let writeStream = createNewWriteStream(currentFileCount)

  const fileStream = fs.createReadStream(filePath)
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  })

  let batch: string[] = []
  let totalProcessingTime = 0
  let linesRead = 0

  writeStream.write("[\n")

  try {
    for await (const line of rl) {
      linesRead++

      try {
        const t1 = performance.now()

        batch.push(JSON.parse(line))
        count++
        totalProcessed++
        currentFileDocsCount++

        if (batch.length >= batchSize) {
          const documents = await processBatch(batch)
          await appendArrayChunk(writeStream, documents, isFirstBatch)

          batch = [] // Clear batch
          isFirstBatch = false
        }

        const t2 = performance.now()
        totalProcessingTime += t2 - t1
        process.stdout.cursorTo(0)
        process.stdout.clearLine(0)
        process.stdout.write(
          `Processed ${totalProcessed} lines. Processing time: ${totalProcessingTime}ms`,
        )

        if (currentFileDocsCount >= docsPerFile) {
          // Write remaining batch if any
          if (batch.length > 0) {
            const documents = await processBatch(batch)
            await appendArrayChunk(writeStream, documents, isFirstBatch)
            batch = [] // Clear batch
          }

          writeStream.write("\n]\n")
          await new Promise<void>((resolve) => writeStream.end(resolve))

          currentFileCount++
          writeStream = createNewWriteStream(currentFileCount)
          writeStream.write("[\n")
          currentFileDocsCount = 0
          isFirstBatch = true

          console.log(`Created new file: process_data_${currentFileCount}.json`)
        }
      } catch (error) {
        console.error(`Error processing line ${linesRead}:`, error)
        await fs.promises.appendFile(
          "error_log.txt",
          `Line ${linesRead}: ${error}\n${line}\n\n`,
        )
      }
    }

    if (batch.length > 0) {
      console.log(`Processing final batch of ${batch.length} documents`)
      const documents = await processBatch(batch)
      await appendArrayChunk(writeStream, documents, isFirstBatch)
    }

    writeStream.write("\n]\n")
    await new Promise<void>((resolve) => writeStream.end(resolve))

    console.log("\nVerifying processed data...")
    console.log(`Total lines read: ${linesRead}`)
    console.log(`Total documents processed: ${totalProcessed}`)
    console.log(`Total files created: ${currentFileCount}`)

    let totalDocsInFiles = 0
    for (let i = 1; i <= currentFileCount; i++) {
      const fileName = path.resolve(
        import.meta.dirname,
        `data/output/process_data_${i}.json`,
      )
      const fileContent = await fs.promises.readFile(fileName, "utf8")
      const parsedData = JSON.parse(fileContent)
      totalDocsInFiles += parsedData.length
      console.log(`File process_data_${i}.json: ${parsedData.length} documents`)
    }

    if (linesRead !== totalProcessed) {
      console.error(
        `Warning: Mismatch between lines read (${linesRead}) and documents processed (${totalProcessed})`,
      )
      throw new Error("Processing verification failed: Count mismatch")
    }

    if (totalDocsInFiles !== totalProcessed) {
      throw new Error(
        `Verification failed: Files contain ${totalDocsInFiles} documents but processed ${totalProcessed}`,
      )
    }
  } catch (error) {
    console.error("Processing failed:", error)
    throw error
  } finally {
    if (writeStream) {
      writeStream.end()
    }
    rl.close()
    fileStream.close()
  }

  console.log("Processing complete with verification.")
}

const createNewWriteStream = (fileCount: number): fs.WriteStream => {
  const fileName = path.resolve(
    import.meta.dirname,
    `data/output/process_data_${fileCount}.json`,
  )
  return fs.createWriteStream(fileName, { flags: "a" })
}

const appendArrayChunk = async (
  writeStream: fs.WriteStream,
  data: any[],
  isFirstBatch: boolean,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const chunk = data.map((item) => JSON.stringify(item)).join(",\n")
    const content = isFirstBatch ? chunk : ",\n" + chunk

    writeStream.write(content, (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

await processData(corpusPath)
process.exit(0)
