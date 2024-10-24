import fs from "node:fs"
import path from "node:path"
import { chunkDocument } from "@/chunks"

const SCHEMA = "file" // Replace with your actual schema name
const NAMESPACE = "namespace"

import readline from "readline"

const corpusPath = path.resolve(import.meta.dirname, "data/fiqa/corpus.jsonl")
const user = "junaid.s@xynehq.com"

const processVespaDoc = (data: any) => {
  const chunks = chunkDocument(data.text)
  return {
    put: `id:${NAMESPACE}:${SCHEMA}::${data._id}`,
    fields: {
      docId: data._id,
      title: "",
      url: "https://example.com/vespa-hybrid-search",
      // Clean up the ASCII characters
      chunks: chunks.map((v) =>
        v.chunk.replace(/[\x00-\x1F\x7F]/g, " ").trim(),
      ),
      permissions: [user],
    },
  }
}

const processData = async (filePath: string) => {
  let totalProcessed = 0
  let writeStream = fs.createWriteStream(
    filePath.replace("corpus.jsonl", "fiqaCorpus.json"),
  )

  const fileStream = fs.createReadStream(filePath)
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  })

  let linesRead = 0
  let processedDocs: any[] = []
  let isFirstBatch = true
  writeStream.write("[\n")

  try {
    for await (const line of rl) {
      linesRead++

      if (!line.trim()) {
        // If the line is empty, skip processing it
        continue
      }

      try {
        processedDocs.push(processVespaDoc(JSON.parse(line)))
        totalProcessed++
      } catch (error) {
        console.error(`Error processing line ${linesRead}:`, error)
        await fs.promises.appendFile(
          "error_log.txt",
          `Line ${linesRead}: ${error}\n${line}\n\n`,
        )
      }

      // Periodically write processedDocs
      if (processedDocs.length >= 100) {
        await writeProcessDocs(writeStream, processedDocs, isFirstBatch)
        isFirstBatch = false
        processedDocs = [] // Clear memory
      }
    }

    // write docs if any
    if (processedDocs.length > 0) {
      await writeProcessDocs(writeStream, processedDocs, isFirstBatch)
    }

    await writeStream.write("\n]\n")
    await new Promise<void>((resolve) => writeStream.end(resolve))

    console.log("\nVerifying processed data...")
    console.log(`Total lines read: ${linesRead}`)
    console.log(`Total documents processed: ${totalProcessed}`)
  } catch (error) {
    console.error("Processing failed:", error)
    throw error
  }
}

const writeProcessDocs = async (
  writeStream: fs.WriteStream,
  data: any[],
  isFirstBatch: boolean,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const content = data.map((item) => JSON.stringify(item)).join(",\n")
    const chunks = isFirstBatch ? content : "," + content
    writeStream.write(chunks, (error) => {
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
