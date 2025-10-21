#!/usr/bin/env bun

import { insert } from "@/search/vespa"
import { fileSchema } from "@xyne/vespa-ts/types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { createId } from "@paralleldrive/cuid2"
import { chunkDocument } from "@/chunks"
import fs from "node:fs"
import path from "node:path"

const Logger = getLogger(Subsystem.Integrations)

interface ProcessFileOptions {
  inputDirectory: string
  userEmail: string
  fileExtensions?: string[]
}

async function processAndIngestFiles(options: ProcessFileOptions) {
  const {
    inputDirectory,
    userEmail,
    fileExtensions = [".txt", ".md", ".json"],
  } = options

  Logger.info(`Processing files from: ${inputDirectory}`)

  if (!fs.existsSync(inputDirectory)) {
    throw new Error(`Directory does not exist: ${inputDirectory}`)
  }

  const files = fs.readdirSync(inputDirectory, { recursive: true })
  const filteredFiles = files.filter((file) => {
    const filePath = file.toString()
    return fileExtensions.some((ext) => filePath.toLowerCase().endsWith(ext))
  })

  Logger.info(`Found ${filteredFiles.length} files to process`)

  for (const file of filteredFiles) {
    try {
      const filePath = path.join(inputDirectory, file.toString())
      const stat = fs.statSync(filePath)

      if (!stat.isFile()) continue

      const content = fs.readFileSync(filePath, "utf-8")
      const docId = createId()
      const fileName = path.basename(filePath)

      // Process content into chunks
      const chunks = chunkDocument(content)

      const vespaDoc = {
        docId,
        title: fileName,
        url: `file://${filePath}`,
        app: "DataSource" as const,
        entity: "Misc" as const,
        chunks: chunks.map((chunk) => chunk.chunk),
        permissions: [userEmail],
        mimeType: getMimeType(filePath),
        owner: userEmail,
        ownerEmail: userEmail,
        parentId: null,
        photoLink: "",
        metadata: JSON.stringify({ originalPath: filePath, size: stat.size }),
        createdAt: stat.birthtime.getTime(),
        updatedAt: stat.mtime.getTime(),
      }

      await insert(vespaDoc, fileSchema)
      Logger.info(
        `Processed and ingested: ${fileName} (${chunks.length} chunks)`,
      )

      // Small delay to avoid overwhelming Vespa
      await new Promise((resolve) => setTimeout(resolve, 50))
    } catch (error) {
      Logger.error(error, `Failed to process file: ${file}`)
    }
  }

  Logger.info("File processing and ingestion completed!")
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }
  return mimeTypes[ext] || "application/octet-stream"
}

// Command line interface
const args = process.argv.slice(2)
if (args.length < 2) {
  console.error(
    "Usage: bun run ingest-files.ts <directory> <user-email> [extensions...]",
  )
  console.error(
    "Example: bun run ingest-files.ts ./data user@example.com .txt .md .json",
  )
  process.exit(1)
}

const [inputDirectory, userEmail, ...extensions] = args
const fileExtensions = extensions.length > 0 ? extensions : undefined

processAndIngestFiles({
  inputDirectory,
  userEmail,
  fileExtensions,
}).catch((error) => {
  Logger.error(error, "File ingestion failed")
  process.exit(1)
})
