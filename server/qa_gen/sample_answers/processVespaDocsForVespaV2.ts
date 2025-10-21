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

import { getLogger } from "../../logger"
import { Subsystem } from "../../types"

const Logger = getLogger(Subsystem.Eval)
const validExtensions = [".jsonl", ".json"]
if (!validExtensions.includes(path.extname(corpusPath))) {
  throw new Error("corpus file must be a .jsonl or .json file.")
}

if (path.extname(outputPath) !== ".jsonl") {
  throw new Error("Output file must be a .jsonl file.")
}

import fs from "node:fs"
import readline from "readline"

// Define allowed fields for each document type based on Vespa schema
const allowedFields = {
  file: [
    "docId",
    "app",
    "entity",
    "title",
    "parentId",
    "url",
    "chunks",
    "owner",
    "ownerEmail",
    "photoLink",
    "permissions",
    "mimeType",
    "createdAt",
    "updatedAt",
    "chunk_embeddings",
    "title_fuzzy",
  ],
  mail: [
    "docId",
    "threadId",
    "mailId",
    "userMap",
    "subject",
    "chunks",
    "timestamp",
    "app",
    "entity",
    "permissions",
    "from",
    "to",
    "cc",
    "bcc",
    "mimeType",
    "attachmentFilenames",
    "labels",
    "chunk_embeddings",
    "subject_fuzzy",
  ],
  chat_message: [
    "docId",
    "teamId",
    "channelId",
    "text",
    "name",
    "username",
    "image",
    "userId",
    "createdAt",
    "threadId",
    "teamRef",
    "chatRef",
    "app",
    "entity",
    "attachmentIds",
    "replyCount",
    "replyUsersCount",
    "mentions",
    "updatedAt",
    "deletedAt",
    "text_embeddings",
  ],
  event: [
    "docId",
    "name",
    "description",
    "url",
    "baseUrl",
    "status",
    "location",
    "createdAt",
    "updatedAt",
    "app",
    "entity",
    "creator",
    "organizer",
    "attendeesNames",
    "startTime",
    "endTime",
    "attachmentFilenames",
    "recurrence",
    "joiningLink",
    "permissions",
    "cancelledInstances",
    "defaultStartTime",
    "chunk_embeddings",
    "name_fuzzy",
  ],
}

const filterFields = (fields: any, docType: string): any => {
  const allowed = allowedFields[docType as keyof typeof allowedFields] || []
  const filtered: any = {}

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      filtered[key] = fields[key]
    }
  }

  return filtered
}

// Process documents from both JSONL and JSON formats
const processData = async (filePath: string) => {
  let totalProcessed = 0
  let writeStream = fs.createWriteStream(outputPath)

  const isJsonl = path.extname(filePath) === ".jsonl"
  let processedDocs: any[] = []

  const writeProcessDocs = (stream: any, docs: any[]) => {
    return new Promise<void>((resolve, reject) => {
      let writeCount = 0
      const totalWrites = docs.length

      if (totalWrites === 0) {
        resolve()
        return
      }

      for (let i = 0; i < docs.length; i++) {
        const written = stream.write(
          JSON.stringify(docs[i]) + "\n",
          (err: any) => {
            if (err) {
              reject(err)
              return
            }
            writeCount++
            if (writeCount === totalWrites) {
              resolve()
            }
          },
        )

        // If write returned false, need to wait for drain
        if (!written) {
          stream.once("drain", () => {
            // Continue after drain
          })
        }
      }
    })
  }

  const processDocument = (vespaDoc: any, lineNumber: number) => {
    try {
      // Handle both formats: nested {put: {id: ...}} and flat {put: "id:..."}
      let docId: string
      let fields: any

      if (
        vespaDoc.put &&
        typeof vespaDoc.put === "object" &&
        vespaDoc.put.id &&
        vespaDoc.fields
      ) {
        // Original nested format: {"put": {"id": "..."}, "fields": {...}}
        docId = vespaDoc.put.id
        fields = vespaDoc.fields
      } else if (
        vespaDoc.put &&
        typeof vespaDoc.put === "string" &&
        vespaDoc.fields
      ) {
        // Already in feed format: {"put": "id:...", "fields": {...}}
        docId = vespaDoc.put
        fields = vespaDoc.fields
      } else {
        Logger.warn(
          `Skipping line ${lineNumber}: Invalid Vespa document structure`,
        )
        console.log(
          `Skipping line ${lineNumber}: Invalid Vespa document structure`,
        )
        return null
      }

      // Determine document type from the ID
      let docType = "file" // default
      if (docId.includes(":mail:")) docType = "mail"
      else if (docId.includes(":chat_message:")) docType = "chat_message"
      else if (docId.includes(":event:")) docType = "event"
      else if (docId.includes(":file:")) docType = "file"

      // Filter fields to match schema
      const filteredFields = filterFields(fields, docType)

      // Only process documents that have content after filtering
      if (Object.keys(filteredFields).length === 0) {
        Logger.warn(
          `Skipping line ${lineNumber}: No valid fields after filtering for docType ${docType}`,
        )
        console.log(
          `Skipping line ${lineNumber}: No valid fields after filtering for docType ${docType}`,
        )
        return null
      }

      // Transform to proper vespa feed format
      return {
        put: docId,
        fields: filteredFields,
      }
    } catch (error) {
      Logger.error(
        `Error processing document at line ${lineNumber}: ${(error as Error).stack}`,
      )
      return null
    }
  }

  try {
    if (isJsonl) {
      // Process JSONL file line by line
      const fileStream = fs.createReadStream(filePath)
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      })

      let linesRead = 0

      for await (const line of rl) {
        linesRead++

        if (!line.trim()) {
          // If the line is empty, skip processing it
          console.log(`Skipping empty line: ${linesRead}`)
          continue
        }

        try {
          const vespaDoc = JSON.parse(line)
          const feedDoc = processDocument(vespaDoc, linesRead)

          if (feedDoc) {
            processedDocs.push(feedDoc)
            totalProcessed++

            if (totalProcessed % 10 === 0) {
              Logger.info(`Processed ${totalProcessed} documents so far...`)
            }
          }
        } catch (error) {
          Logger.error(
            `Error parsing JSON on line ${linesRead}: ${(error as Error).message}`,
          )
          console.log(
            `Skipping line ${linesRead} due to JSON parsing error:`,
            error,
          )
          await fs.promises.appendFile(
            "error_log.txt",
            `Line ${linesRead}: ${error}\n${line}\n\n`,
          )
        }

        // Periodically write processedDocs
        if (processedDocs.length >= 100) {
          await writeProcessDocs(writeStream, processedDocs)
          processedDocs = [] // Clear memory
        }
      }
    } else {
      // Process JSON file as array
      const fileContent = await fs.promises.readFile(filePath, "utf8")
      const jsonData = JSON.parse(fileContent)

      if (!Array.isArray(jsonData)) {
        throw new Error("JSON file must contain an array of documents")
      }

      Logger.info(`Processing ${jsonData.length} documents from JSON array...`)

      for (let i = 0; i < jsonData.length; i++) {
        const vespaDoc = jsonData[i]
        const feedDoc = processDocument(vespaDoc, i + 1)

        if (feedDoc) {
          processedDocs.push(feedDoc)
          totalProcessed++

          if (totalProcessed % 10 === 0) {
            Logger.info(`Processed ${totalProcessed} documents so far...`)
          }
        }

        // Periodically write processedDocs
        if (processedDocs.length >= 100) {
          await writeProcessDocs(writeStream, processedDocs)
          processedDocs = [] // Clear memory
        }
      }
    }

    // Write any remaining documents
    if (processedDocs.length > 0) {
      await writeProcessDocs(writeStream, processedDocs)
    }
  } catch (error) {
    Logger.error(`Error processing file: ${error}`)
    throw error
  }

  writeStream.end()

  Logger.info(`Total documents processed: ${totalProcessed}`)
  return totalProcessed
}

await processData(corpusPath)
process.exit(0)
