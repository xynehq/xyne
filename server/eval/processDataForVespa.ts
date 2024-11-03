import path from "node:path"
const args = process.argv.slice(2)

const expectedArgsLen = 4
const requiredArgs = ["--corpus", "--output"]
let corpusPath = "",
  outputPath = ""

if (!args || args.length < expectedArgsLen) {
  throw new Error(
    "path not provided, this script requires --corpus path/to/corpus.jsonl --output path/to/output/.json",
  )
}

const argMap: { [key: string]: string } = {}
args.forEach((arg, idx) => {
  if (requiredArgs.includes(arg)) {
    argMap[arg] = args[idx + 1]
  }
})

corpusPath = argMap["--corpus"]
outputPath = argMap["--output"]
if (!corpusPath || !outputPath) {
  throw new Error("invalid arguments: --corpus and --output are required")
}

const Logger = getLogger(Subsystem.Eval)
if (path.extname(corpusPath) !== ".jsonl") {
  throw new Error("corpus file must be a .jsonl file.")
}

if (path.extname(outputPath) !== ".json") {
  throw new Error("Output file must be a .json file.")
}

import fs from "node:fs"
import { chunkDocument } from "@/chunks"

const SCHEMA = "file" // Replace with your actual schema name
const NAMESPACE = "namespace"

import readline from "readline"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const user = "junaid.s@xynehq.com"

type Doc = {
  _id: number
  title: string
  text: string
}
const processVespaDoc = (data: Doc) => {
  const chunks = chunkDocument(data.text)
  return {
    put: `id:${NAMESPACE}:${SCHEMA}::${data._id}`,
    fields: {
      docId: data._id,
      title: data.title ? data.title : "",
      // dummy url
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
  let writeStream = fs.createWriteStream(outputPath)

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
        Logger.error(
          `Error processing line ${linesRead}: ${(error as Error).stack}`,
        )
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
    Logger.error(
      `Processing failed: ${(error as Error).message} ${(error as Error).stack}`,
    )
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
