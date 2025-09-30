#!/usr/bin/env bun

import { promises as fs } from "fs"
import path from "path"
import { chunkByOCRFromBuffer } from "@/lib/chunkByOCR"

type EnvMap = Record<string, string>
const DEFAULT_TEST_PDF = ""

async function loadEnvFile(envPath: string): Promise<EnvMap> {
  try {
    const raw = await fs.readFile(envPath, "utf8")
    const map: EnvMap = {}
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let val = trimmed.slice(eq + 1).trim()
      // Strip surrounding quotes if present
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      map[key] = val
      if (!(key in process.env)) {
        process.env[key] = val
      }
    }
    return map
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`Warning: failed to read env file at ${envPath}:`, err)
    }
    return {}
  }
}

function resolvePdfPath(args: string[], envs: EnvMap): string {
  // Priority: CLI arg -> TEST_PDF_PATH -> PDF_PATH
  const cli = args[0]
  const fromEnv =
    envs["TEST_PDF_PATH"] ||
    envs["PDF_PATH"] ||
    process.env.TEST_PDF_PATH ||
    process.env.PDF_PATH
  const p = cli || fromEnv || DEFAULT_TEST_PDF
  return path.resolve(p)
}

async function main() {
  console.log("=== OCR PDF Chunker (processFile simulation) ===")

  // Load env from server/.env (preferred) then from project .env (optional)
  const cwd = process.cwd()
  const serverEnvPath = path.resolve(cwd, "server/.env")
  const rootEnvPath = path.resolve(cwd, ".env")
  const envs = {
    ...(await loadEnvFile(serverEnvPath)),
    ...(await loadEnvFile(rootEnvPath)),
  }

  // Resolve PDF path
  const argv = process.argv.slice(2)
  const pdfPath = resolvePdfPath(argv, envs)
  console.log("PDF Path:", pdfPath)

  // Read the PDF file into a Buffer (simulate FileProcessorService.processFile input)
  const buffer = await fs.readFile(pdfPath)
  console.log("File size:", buffer.length, "bytes")

  // Simulate processFile -> chunkByOCRFromBuffer call
  const fileName = path.basename(pdfPath)
  const vespaDocId = "test-docid-ocr"

  console.log("\nCalling OCR-backed extractor...")
  const result = await chunkByOCRFromBuffer(buffer, fileName, vespaDocId)

  // Extract results from ProcessingResult
  const chunks = result.chunks
  const chunks_pos = result.chunks_pos
  const image_chunks = result.image_chunks
  const image_chunks_pos = result.image_chunks_pos
  const chunks_map = result.chunks_map
  const image_chunks_map = result.image_chunks_map

  console.log("\n=== Results ===")
  console.log("Text chunks:", chunks.length)
  console.log("Text chunk positions:", chunks_pos.length)
  console.log("Image chunks:", image_chunks.length)
  console.log("Image chunk positions:", image_chunks_pos.length)
  console.log("Text chunks metadata:", chunks_map.length)
  console.log("Image chunks metadata:", image_chunks_map.length)

  console.log("All text chunks", { chunks })
  console.log("All text chunk positions", { chunks_pos })
  console.log("All image chunks", { image_chunks })
  console.log("All image chunk positions", { image_chunks_pos })

  // Print chunks with their metadata
  console.log("\n=== Text Chunks with Metadata ===")
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const pos = chunks_pos[i]
    const metadata = chunks_map[i]
    console.log(
      `\n[${i}] pos=${pos} page=${metadata?.page_number} labels=${metadata?.block_labels?.join(",")}`,
    )
    console.log(chunk.substring(0, 200) + (chunk.length > 200 ? "..." : ""))
  }

  if (image_chunks.length > 0) {
    console.log("\n=== Image Chunks with Metadata ===")
    for (let i = 0; i < image_chunks.length; i++) {
      const chunk = image_chunks[i]
      const pos = image_chunks_pos[i]
      const metadata = image_chunks_map[i]
      console.log(
        `\n[${i}] pos=${pos} page=${metadata?.page_number} labels=${metadata?.block_labels?.join(",")}`,
      )
      console.log(chunk)
    }
  }

  console.log("\n=== Done ===")
}

await main().catch((err) => {
  console.error("Test failed:", err)
  process.exit(1)
})
