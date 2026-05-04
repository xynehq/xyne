import { promises as fsPromises } from "fs"
import * as path from "path"
import { getLogger } from "@/logger"
import { Subsystem, type ChunkMetadata } from "@/types"
import type { ProcessingResult } from "@/services/fileProcessor"
import config from "@/config"
import { chunkTextByParagraph } from "@/chunks"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "chunkByDocling",
})

const DEFAULT_IMAGE_DIR = "downloads/xyne_images_db"
const DEFAULT_DOCLING_TIMEOUT_MS = 300000
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1000

// Configuration from environment or config
const DOCLING_BASE_URL = config.doclingServiceUrl || "http://localhost:8000"
const DOCLING_TIMEOUT_MS = process.env.DOCLING_TIMEOUT_MS
  ? Number.parseInt(process.env.DOCLING_TIMEOUT_MS, 10)
  : DEFAULT_DOCLING_TIMEOUT_MS

// Docling API response types
interface DoclingBbox {
  l: number
  t: number
  r: number
  b: number
}

interface DoclingTocEntry {
  section_number: string
  section_title: string
  page_number: number
  level: number
  bbox?: DoclingBbox
  parent_index?: number | null
}

interface DoclingChunk {
  text: string
  headings: string[]
  page_numbers: number[]
  bbox?: DoclingBbox
}

interface DoclingImageChunk {
  text: string
  page_number: number
  bbox?: DoclingBbox
  width?: number
  height?: number
}

interface DoclingVlmStats {
  tables_replaced: number
  pictures_replaced: number
  scanned_pages_ocrd: number
}

interface DoclingVlmMetadata {
  enabled: boolean
  preset: string | null
  model: string | null
  tables_replaced: number
  pictures_replaced: number
  scanned_pages_ocrd: number
}

interface DoclingMetadata {
  doc_id: string
  filename: string
  num_pages: number
  num_images: number
  processing_time: number
  has_toc: boolean
  vlm: DoclingVlmMetadata
}

interface DoclingResponse {
  metadata: DoclingMetadata
  toc: {
    entries: DoclingTocEntry[]
  }
  chunks: DoclingChunk[]
  image_chunks: DoclingImageChunk[]
  images: Record<string, string> // base64 encoded images
}

// Extended ChunkMetadata with docling-specific fields
interface DoclingChunkMetadata extends ChunkMetadata {
  bbox?: DoclingBbox
  width?: number
  height?: number
  headings?: string[]
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Detect image extension from base64 data
 */
function detectImageExtension(base64Data: string): string {
  // Check for data URL prefix
  if (base64Data.startsWith("data:image/jpeg") || base64Data.startsWith("data:image/jpg")) {
    return "jpg"
  }
  if (base64Data.startsWith("data:image/png")) {
    return "png"
  }
  if (base64Data.startsWith("data:image/webp")) {
    return "webp"
  }
  if (base64Data.startsWith("data:image/gif")) {
    return "gif"
  }
  // Default to jpg (docling uses JPEG)
  return "jpg"
}

/**
 * Extract base64 data from data URL
 */
function extractBase64Data(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(",")
  if (commaIndex === -1) {
    return dataUrl
  }
  return dataUrl.slice(commaIndex + 1)
}

/**
 * Ensure unique filename
 */
function ensureUniqueFileName(name: string, usedNames: Set<string>): string {
  if (!usedNames.has(name)) {
    usedNames.add(name)
    return name
  }

  const parsed = path.parse(name)
  let counter = 1

  while (true) {
    const candidate = `${parsed.name}_${counter}${parsed.ext}`
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate)
      return candidate
    }
    counter += 1
  }
}

/**
 * Call docling service with retry logic
 */
async function callDoclingService(
  buffer: Buffer,
  fileName: string,
  docId: string,
): Promise<DoclingResponse> {
  const baseUrl = DOCLING_BASE_URL.replace(/\/+$/, "")
  const apiUrl = `${baseUrl}/process`

  const formData = new FormData()
  // Create blob from buffer bytes - use type assertion to bypass strict typing
  const blob = new Blob([buffer as unknown as BlobPart], { type: "application/pdf" })
  formData.append("file", blob, fileName)
  formData.append("doc_id", docId)

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOCLING_TIMEOUT_MS)

    try {
      Logger.info(`Calling docling service (attempt ${attempt}/${MAX_RETRIES})`, {
        fileName,
        docId,
        fileSize: buffer.length,
        url: apiUrl,
      })

      const response = await fetch(apiUrl, {
        method: "POST",
        body: formData,
        signal: controller.signal,
      })

      clearTimeout(timer)

      if (!response.ok) {
        const errorText = await response.text().catch(() => "")
        throw new Error(
          `Docling service returned ${response.status}: ${errorText.slice(0, 200)}`,
        )
      }

      const result = (await response.json()) as DoclingResponse

      Logger.info("Docling service response received", {
        fileName,
        docId,
        numChunks: result.chunks?.length || 0,
        numImageChunks: result.image_chunks?.length || 0,
        numImages: Object.keys(result.images || {}).length,
        numPages: result.metadata?.num_pages,
        processingTime: result.metadata?.processing_time,
      })

      return result
    } catch (error) {
      clearTimeout(timer)
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < MAX_RETRIES) {
        Logger.warn(
          `Docling service call failed (attempt ${attempt}/${MAX_RETRIES}), retrying...`,
          {
            error: lastError.message,
            fileName,
            docId,
          },
        )
        await sleep(RETRY_DELAY_MS * attempt) // Exponential backoff
      } else {
        Logger.error(
          `Docling service call failed after ${MAX_RETRIES} attempts`,
          {
            error: lastError.message,
            fileName,
            docId,
          },
        )
      }
    }
  }

  throw lastError || new Error("Unknown error calling docling service")
}

/**
 * Save base64 images to disk
 */
async function saveImages(
  images: Record<string, string>,
  docId: string,
): Promise<Map<string, string>> {
  const imageBaseDir = path.resolve(DEFAULT_IMAGE_DIR)
  const docImageDir = path.join(imageBaseDir, docId)
  await fsPromises.mkdir(docImageDir, { recursive: true })

  const savedPaths = new Map<string, string>()
  const usedFileNames = new Set<string>()
  let imageIndex = 0

  for (const [key, base64Data] of Object.entries(images)) {
    try {
      const extension = detectImageExtension(base64Data)
      const base64Content = extractBase64Data(base64Data)
      const imageBuffer = Buffer.from(base64Content, "base64")

      const fileName = ensureUniqueFileName(
        `img_${imageIndex}.${extension}`,
        usedFileNames,
      )
      const imagePath = path.join(docImageDir, fileName)

      await fsPromises.writeFile(imagePath, imageBuffer)
      savedPaths.set(key, imagePath)

      Logger.debug("Saved docling image", {
        docId,
        imageKey: key,
        imagePath,
        size: imageBuffer.length,
      })

      imageIndex++
    } catch (error) {
      Logger.error("Failed to save docling image", {
        docId,
        imageKey: key,
        error: (error as Error).message,
      })
    }
  }

  Logger.info("Saved docling images", {
    docId,
    totalImages: Object.keys(images).length,
    savedCount: savedPaths.size,
  })

  return savedPaths
}

/**
 * Transform docling chunks to xyne format
 */
function transformChunks(
  doclingChunks: DoclingChunk[],
): {
  chunks: string[]
  chunks_map: DoclingChunkMetadata[]
} {
  const chunks: string[] = []
  const chunks_map: DoclingChunkMetadata[] = []

  for (let index = 0; index < doclingChunks.length; index++) {
    const chunk = doclingChunks[index]

    if (!chunk.text?.trim()) {
      continue
    }

    chunks.push(chunk.text.trim())

    const blockLabels: string[] = []
    if (chunk.headings && chunk.headings.length > 0) {
      blockLabels.push(...chunk.headings.map((h) => `heading: ${h}`))
    }

    // Docling returns 1-based page numbers (first page = 1)
    // Normalize to 0-based to match PDF.js/OCR convention
    const pageNumbers = (chunk.page_numbers || []).map(p => p - 1)

    chunks_map.push({
      chunk_index: index,
      page_numbers: pageNumbers,
      block_labels: blockLabels,
      bbox: chunk.bbox,
      headings: chunk.headings,
    })
  }

  return { chunks, chunks_map }
}

/**
 * Transform docling image chunks to xyne format
 */
function transformImageChunks(
  doclingImageChunks: DoclingImageChunk[],
): {
  image_chunks: string[]
  image_chunks_map: DoclingChunkMetadata[]
} {
  const image_chunks: string[] = []
  const image_chunks_map: DoclingChunkMetadata[] = []

  for (let index = 0; index < doclingImageChunks.length; index++) {
    const imgChunk = doclingImageChunks[index]

    // Use the VLM-extracted text as the searchable content
    const description = imgChunk.text?.trim() || ""

    image_chunks.push(description)
    // Docling returns 1-based page numbers (first page = 1)
    // Normalize to 0-based to match PDF.js/OCR convention
    const pageNumber = imgChunk.page_number ? imgChunk.page_number - 1 : undefined
    image_chunks_map.push({
      chunk_index: index,
      page_numbers: pageNumber !== undefined ? [pageNumber] : [],
      block_labels: ["image"],
      bbox: imgChunk.bbox,
      width: imgChunk.width,
      height: imgChunk.height,
    })
  }

  return { image_chunks, image_chunks_map }
}

/**
 * Build metadata object for Vespa storage
 */
function buildMetadata(
  doclingResponse: DoclingResponse,
  savedImagePaths: Map<string, string>,
): Record<string, unknown> {
  const { metadata, toc, chunks, image_chunks } = doclingResponse

  return {
    // Original docling metadata
    docling: {
      docId: metadata.doc_id,
      filename: metadata.filename,
      numPages: metadata.num_pages,
      numImages: metadata.num_images,
      processingTime: metadata.processing_time,
      hasToc: metadata.has_toc,
      vlm: metadata.vlm,
    },
    // Table of contents
    toc: toc.entries.map((entry) => ({
      sectionNumber: entry.section_number,
      sectionTitle: entry.section_title,
      pageNumber: entry.page_number,
      level: entry.level,
      bbox: entry.bbox,
      parentIndex: entry.parent_index,
    })),
    // Image mappings (key -> file path)
    imagePaths: Object.fromEntries(savedImagePaths),
    // Processing stats
    chunksCount: chunks.length,
    imageChunksCount: image_chunks.length,
  }
}

/**
 * Process PDF using Docling service
 *
 * @param buffer - PDF file buffer
 * @param fileName - Name of the PDF file
 * @param docId - Document ID for image storage
 * @returns ProcessingResult compatible with xyne's file processor
 */
export async function chunkByDoclingFromBuffer(
  buffer: Buffer,
  fileName: string,
  docId: string,
): Promise<ProcessingResult> {
  Logger.info("Starting docling processing", {
    fileName,
    docId,
    fileSize: buffer.length,
  })

  // Step 1: Call docling service
  const doclingResponse = await callDoclingService(buffer, fileName, docId)

  // Step 2: Save images to disk
  const savedImagePaths = await saveImages(doclingResponse.images, docId)

  // Step 3: Transform chunks
  const { chunks, chunks_map } = transformChunks(doclingResponse.chunks)

  // Step 4: Transform image chunks
  const { image_chunks, image_chunks_map } = transformImageChunks(
    doclingResponse.image_chunks,
  )

  // Step 5: Build TOC chunks
  // Accumulate TOC entries into text and chunk them
  const tocText = doclingResponse.toc.entries
    .map((entry) => `${entry.section_number} ${entry.section_title}`.trim())
    .join("\n")
  const toc_chunks = tocText ? chunkTextByParagraph(tocText, 512, 0) : []

  // Step 6: Build metadata
  const metadata = buildMetadata(doclingResponse, savedImagePaths)

  Logger.info("Docling processing completed", {
    fileName,
    docId,
    textChunks: chunks.length,
    imageChunks: image_chunks.length,
    tocChunks: toc_chunks.length,
    savedImages: savedImagePaths.size,
    numPages: doclingResponse.metadata.num_pages,
    processingTime: doclingResponse.metadata.processing_time,
  })

  return {
    chunks,
    chunks_pos: chunks_map.map((m) => m.chunk_index),
    image_chunks,
    image_chunks_pos: image_chunks_map.map((m) => m.chunk_index),
    toc_chunks,
    chunks_map,
    image_chunks_map,
    processingMethod: "docling" as const,
    // Include metadata for Vespa storage
    // @ts-expect-error
    metadata,
  }
}
