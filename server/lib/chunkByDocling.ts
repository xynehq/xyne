import { spawn } from "child_process"
import { promises as fsPromises } from "fs"
import * as path from "path"
import { chunkTextByParagraph } from "@/chunks"
import config from "@/config"
import { getLogger } from "@/logger"
import type { ProcessingResult } from "@/services/fileProcessor"
import { type ChunkMetadata, Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "chunkByDocling",
})

const DEFAULT_IMAGE_DIR = "downloads/xyne_images_db"
const DEFAULT_DOCLING_TIMEOUT_MS = 300000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_DELAY_MS = 1000

// On a POST /process timeout, do a single GET /status/{doc_id} to find out
// what really happened on the docling side before retrying.
const STATUS_FETCH_TIMEOUT_MS = 10_000

type DoclingCallOptions = {
  timeoutMs?: number
}

type DoclingHttpResponse = {
  status: number
  ok: boolean
  bodyText: string
}

type CurlResult = {
  stdout: string
  stderr: string
  exitCode: number | null
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// Configuration from environment or config
const DOCLING_BASE_URL = config.doclingServiceUrl || "http://localhost:8000"
const DOCLING_TIMEOUT_MS = parsePositiveInteger(
  process.env.DOCLING_TIMEOUT_MS,
  DEFAULT_DOCLING_TIMEOUT_MS,
)
const MAX_RETRIES = process.env.DOCLING_MAX_RETRIES
  ? Math.max(1, Number.parseInt(process.env.DOCLING_MAX_RETRIES, 10))
  : DEFAULT_MAX_RETRIES
const RETRY_DELAY_MS = process.env.DOCLING_RETRY_DELAY_MS
  ? Math.max(0, Number.parseInt(process.env.DOCLING_RETRY_DELAY_MS, 10))
  : DEFAULT_RETRY_DELAY_MS

function getEffectiveDoclingTimeoutMs(timeoutMs?: number): number {
  return Number.isFinite(timeoutMs) && (timeoutMs || 0) > 0
    ? (timeoutMs as number)
    : DOCLING_TIMEOUT_MS
}

function escapeMultipartHeaderValue(value: string): string {
  return value.replace(/[\r\n";]/g, "_")
}

function runCurl(args: string[], timeoutMs: number): Promise<CurlResult> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const child = spawn("curl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`curl timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (exitCode) => {
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
      })
    })
  })
}

async function postDoclingMultipart(
  apiUrl: string,
  buffer: Buffer,
  fileName: string,
  docId: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<DoclingHttpResponse> {
  const requestStart = Date.now()
  const tempFilePath = path.join(
    "/tmp",
    `xyne-docling-${docId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.pdf`,
  )
  const curlStatusMarker = "\nXYNE_CURL_STATUS:"

  await fsPromises.writeFile(tempFilePath, buffer)

  try {
    if (signal.aborted) {
      const error = new Error(`Docling request timed out after ${timeoutMs}ms`)
      error.name = "AbortError"
      throw error
    }

    const curlResult = await runCurl(
      [
        "-sS",
        "--fail-with-body",
        "--max-time",
        String(Math.ceil(timeoutMs / 1000)),
        "-H",
        "Connection: close",
        "-F",
        `file=@${tempFilePath};type=application/pdf;filename=${escapeMultipartHeaderValue(fileName)}`,
        "-F",
        `doc_id=${docId}`,
        "-w",
        `${curlStatusMarker}%{http_code}:%{content_type}:%{size_download}`,
        apiUrl,
      ],
      timeoutMs,
    )

    if (signal.aborted) {
      const error = new Error(`Docling request timed out after ${timeoutMs}ms`)
      error.name = "AbortError"
      throw error
    }

    const markerIndex = curlResult.stdout.lastIndexOf(curlStatusMarker)
    const bodyText =
      markerIndex >= 0
        ? curlResult.stdout.slice(0, markerIndex)
        : curlResult.stdout
    const statusParts =
      markerIndex >= 0
        ? curlResult.stdout
            .slice(markerIndex + curlStatusMarker.length)
            .trim()
            .split(":")
        : []
    const status = Number.parseInt(statusParts[0] || "0", 10)
    const contentType = statusParts[1] || null
    const sizeDownload = statusParts[2] || null
    const ok =
      curlResult.exitCode === 0 &&
      Number.isFinite(status) &&
      status >= 200 &&
      status < 300

    Logger.info(
      {
        fileName,
        docId,
        status,
        ok,
        contentLength: sizeDownload,
        contentType,
        elapsedMs: Date.now() - requestStart,
        curlExitCode: curlResult.exitCode,
      },
      "Docling HTTP response headers received",
    )
    Logger.info(
      {
        fileName,
        docId,
        contentLength: sizeDownload,
        elapsedMs: Date.now() - requestStart,
      },
      "Docling response body read starting",
    )
    Logger.info(
      {
        fileName,
        docId,
        bodyLength: bodyText.length,
        bodyReadDurationMs: 0,
        elapsedMs: Date.now() - requestStart,
      },
      "Docling response body read complete",
    )

    if (!ok && curlResult.stderr) {
      Logger.warn(
        {
          fileName,
          docId,
          status,
          curlExitCode: curlResult.exitCode,
          stderr: curlResult.stderr.slice(0, 500),
        },
        "Docling curl request completed with non-zero status",
      )
    }

    return { status, ok, bodyText }
  } finally {
    await fsPromises.unlink(tempFilePath).catch(() => undefined)
  }
}

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

interface DoclingBboxFragment extends DoclingBbox {
  page_no?: number | null
}

interface DoclingChunk {
  text: string
  headings: string[]
  page_numbers: number[]
  bbox?: DoclingBbox
  bboxes?: DoclingBboxFragment[]
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
  bboxes?: DoclingBboxFragment[]
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
  if (
    base64Data.startsWith("data:image/jpeg") ||
    base64Data.startsWith("data:image/jpg")
  ) {
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

interface DoclingStatusEntry {
  doc_id: string
  filename?: string | null
  state: "running" | "done" | "failed"
  stage?: string | null
  started_at?: number | null
  completed_at?: number | null
  duration_seconds?: number | null
  error?: string | null
}

/**
 * Single GET /status/{docId}. Returns `null` if the entry is missing (404),
 * unreachable, or malformed — the caller treats null as "unknown, just retry".
 */
async function fetchDoclingStatus(
  docId: string,
  baseUrl: string,
  fileName: string,
): Promise<DoclingStatusEntry | null> {
  const statusUrl = `${baseUrl}/status/${docId}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), STATUS_FETCH_TIMEOUT_MS)
  try {
    const resp = await fetch(statusUrl, { signal: controller.signal })
    if (resp.status === 404) return null
    if (!resp.ok) {
      Logger.warn(
        `Docling /status returned ${resp.status} for docId=${docId}`,
        { fileName, docId, statusUrl },
      )
      return null
    }
    return (await resp.json()) as DoclingStatusEntry
  } catch (err) {
    Logger.warn(
      `Docling /status fetch failed for docId=${docId}: ${(err as Error).message}`,
      { fileName, docId },
    )
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Call docling service with retry logic
 */
async function callDoclingService(
  buffer: Buffer,
  fileName: string,
  docId: string,
  options?: DoclingCallOptions,
): Promise<DoclingResponse> {
  const baseUrl = DOCLING_BASE_URL.replace(/\/+$/, "")
  const apiUrl = `${baseUrl}/process`
  // currentTimeoutMs grows on every "done while we were timed out" race or
  // "still running" outcome — that's direct evidence the calculated timeout
  // was too tight for this document. Grow linearly by adding the original
  // calculated value each time (T, 2T, 3T, ...), not exponentially.
  const initialTimeoutMs = getEffectiveDoclingTimeoutMs(options?.timeoutMs)
  let currentTimeoutMs = initialTimeoutMs

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), currentTimeoutMs)
    const requestStart = Date.now()

    try {
      Logger.info(
        {
          fileName,
          docId,
          fileSize: buffer.length,
          timeoutMs: currentTimeoutMs,
          url: apiUrl,
        },
        `Calling docling service (attempt ${attempt}/${MAX_RETRIES}) timeoutMs=${currentTimeoutMs} fileSize=${buffer.length} docId=${docId}`,
      )

      const response = await postDoclingMultipart(
        apiUrl,
        buffer,
        fileName,
        docId,
        currentTimeoutMs,
        controller.signal,
      )

      if (!response.ok) {
        clearTimeout(timer)
        Logger.warn(
          {
            fileName,
            docId,
            status: response.status,
            bodyLength: response.bodyText.length,
            elapsedMs: Date.now() - requestStart,
          },
          "Docling non-OK response body received",
        )
        throw new Error(
          `Docling service returned ${response.status}: ${response.bodyText.slice(0, 200)}`,
        )
      }

      clearTimeout(timer)

      const parseStart = Date.now()
      Logger.info(
        {
          fileName,
          docId,
          bodyLength: response.bodyText.length,
        },
        "Docling JSON parse starting",
      )
      const result = JSON.parse(response.bodyText) as DoclingResponse
      Logger.info(
        {
          fileName,
          docId,
          bodyLength: response.bodyText.length,
          parseDurationMs: Date.now() - parseStart,
          elapsedMs: Date.now() - requestStart,
        },
        "Docling JSON parse complete",
      )

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

      const isTimeout =
        lastError.name === "AbortError" || controller.signal.aborted

      if (isTimeout) {
        // One-shot check of docling's view of this doc_id before we retry.
        // Only `failed` keeps the same timeout (the failure was unrelated to
        // timing); every other outcome — done, still running, status
        // unreachable — is treated as evidence the timeout was too tight,
        // so the next attempt waits longer.
        //   done     → race; result was lost. Bump timeout, LOUD log, retry.
        //   failed   → docling-side error. Retry at same timeout.
        //   running  → docling still busy. Bump timeout, retry.
        //   null     → /status unreachable / not_found. Bump timeout, retry.
        const status = await fetchDoclingStatus(docId, baseUrl, fileName)
        const prevTimeoutMs = currentTimeoutMs

        if (status?.state === "done") {
          currentTimeoutMs = currentTimeoutMs + initialTimeoutMs
          Logger.error(
            `!!! DOCLING DONE-WHILE-TIMED-OUT RACE !!! docling reported state=done for docId=${docId} but the HTTP client aborted at ${prevTimeoutMs}ms. The processed result has been discarded on the docling side and there is no /result endpoint to recover it. Calculated timeout was too tight — bumping timeout from ${prevTimeoutMs}ms to ${currentTimeoutMs}ms and retrying upload. If this fires repeatedly for this file, raise DOCLING_TIMEOUT_PER_PAGE_MS / DOCLING_TIMEOUT_PER_100KB_MS in pdfProcessor.ts.`,
            {
              fileName,
              docId,
              prevTimeoutMs,
              newTimeoutMs: currentTimeoutMs,
              attempt,
              doclingDurationSeconds: status.duration_seconds,
              doclingStage: status.stage,
            },
          )
        } else if (status?.state === "failed") {
          Logger.warn(
            `Docling reported state=failed for docId=${docId}: ${status.error ?? "no error message"}; retrying upload at same timeout=${currentTimeoutMs}ms.`,
            {
              fileName,
              docId,
              doclingError: status.error,
              doclingStage: status.stage,
              attempt,
            },
          )
        } else if (status?.state === "running") {
          currentTimeoutMs = currentTimeoutMs + initialTimeoutMs
          Logger.warn(
            `Docling POST timed out after ${prevTimeoutMs}ms but /status still shows state=running for docId=${docId} (stage=${status.stage ?? "unknown"}); bumping timeout to ${currentTimeoutMs}ms and retrying.`,
            {
              fileName,
              docId,
              prevTimeoutMs,
              newTimeoutMs: currentTimeoutMs,
              doclingStage: status.stage,
              attempt,
            },
          )
        } else {
          currentTimeoutMs = currentTimeoutMs + initialTimeoutMs
          Logger.warn(
            `Docling POST timed out after ${prevTimeoutMs}ms; /status unavailable for docId=${docId}; bumping timeout to ${currentTimeoutMs}ms and retrying.`,
            {
              fileName,
              docId,
              prevTimeoutMs,
              newTimeoutMs: currentTimeoutMs,
              attempt,
            },
          )
        }
      }

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
function transformChunks(doclingChunks: DoclingChunk[]): {
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
    const pageNumbers = (chunk.page_numbers || []).map((p) => p - 1)

    chunks_map.push({
      chunk_index: index,
      page_numbers: pageNumbers,
      block_labels: blockLabels,
      bbox: chunk.bbox,
      bboxes: chunk.bboxes,
      headings: chunk.headings,
    })
  }

  return { chunks, chunks_map }
}

/**
 * Transform docling image chunks to xyne format
 */
function transformImageChunks(doclingImageChunks: DoclingImageChunk[]): {
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
    const pageNumber = imgChunk.page_number
      ? imgChunk.page_number - 1
      : undefined
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
  options?: DoclingCallOptions,
): Promise<ProcessingResult> {
  Logger.info(
    {
      fileName,
      docId,
      fileSize: buffer.length,
      timeoutMs: options?.timeoutMs,
    },
    `Starting docling processing timeoutMs=${options?.timeoutMs ?? "default"} fileSize=${buffer.length} docId=${docId}`,
  )

  // Step 1: Call docling service
  const doclingResponse = await callDoclingService(
    buffer,
    fileName,
    docId,
    options,
  )

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
