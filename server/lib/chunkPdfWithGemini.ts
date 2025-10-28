import * as crypto from "crypto"
import { VertexAI } from "@google-cloud/vertexai"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { PDFDocument } from "pdf-lib"
import {
  FileSizeExceededError,
  PdfPageTooLargeError,
} from "@/integrations/dataSource/errors"
// import { CHUNKING_PROMPT } from "@/ai/prompts"

const Logger = getLogger(Subsystem.AI).child({ module: "chunkPdfWithGemini" })

// Splitting uses pdf-lib only; pdfjs not required here
const PAGE_SPLIT_NUMBER = 30
const GEMINI_OUTPUT_LIMIT = 55535 // previously -> 8192 // max  is : 65535
export type ChunkPdfOptions = {
  projectId?: string
  location?: string
  model?: string
  gcsUri?: string // Optional GCS URI to use for PDFs >= 15MB
  maxOutputTokens?: number
  temperature?: number
}

// PDF Chunking Prompt
// This prompt is used for OCR and semantic chunking of PDF pages using Gemini.
const CHUNKING_PROMPT = `\
OCR the provided PDF page(s) into clean Markdown with enriched table and image handling, then segment into coherent RAG-ready chunks.

GLOBAL RULES:
- Preserve text structure as Markdown (headings, paragraphs, lists, footnotes).
- Keep reading order across pages; prefer natural section boundaries.
- No hallucinations. If content is unreadable, write [illegible].
- Do not surround output with triple backticks or any code fences.
- Output ONLY a sequence of <chunk>...</chunk> blocks. No extra commentary.

TABLES (including tables shown inside images):
- Extract ALL tables completely; never summarize or omit cells.
- Represent EVERY table as HTML: <table><thead><tr><th>…</th></tr></thead><tbody><tr><td>…</td></tr>…</tbody></table>.
- Keep the entire table within a single chunk when possible.
- If a table must be split across chunks due to limits:
  - Split on complete rows only; never split a cell.
  - Repeat the full header row (<thead>) at the start of the next chunk.
  - Add "(table continues)" at the end of the first part and "(table continued)" at the start of the next part.

IMAGES, FIGURES, CHARTS, DIAGRAMS:
- Insert an inline marker at the exact location where the image appears:
  - Begin a new paragraph starting with "Image:" and provide a rich, thorough description.
  - Describe the scene, axes, legends, units, labels, key values, trends, colors, shapes, and any text in the image.
- If the image contains tabular data, transcribe it immediately after the description as an HTML <table> (same structure as above).
- For charts, add 1–2 sentences summarizing key insights after the description.

CHUNKING:
- Group content by semantic theme (e.g., subsection, self-contained explanation, contiguous table).
- Target 250–512 words per chunk with a hard maximum of 1024 bytes (UTF-8).
- If 250–512 words would exceed 1024 bytes, end early to respect the byte limit and continue in the next chunk.
- Do not break sentences, list items, or table rows across chunks unless unavoidable due to the byte limit.
- When continuing content in the next chunk, begin with a brief "(continued)" cue to retain context.
- Maintain flow: image descriptions and any extracted tables must appear inline where the image occurs so readers know an image was present there.

FORMATTING:
- Surround each chunk with <chunk> ... </chunk> tags.
- Inside chunks, use valid Markdown and HTML (<table> only).
- Keep whitespace clean; avoid double spaces and stray line breaks.

Begin now and emit only <chunk> blocks.
`

// Size limits for PDF processing
const INLINE_MAX_BYTES = 17 * 1024 * 1024 // 17MB - split into chunks
const MAX_SUPPORTED_BYTES = 100 * 1024 * 1024 // 100MB - hard limit

// Save [startPageIdxInclusive .. startPageIdxInclusive+count-1] into a new PDF
async function saveRange(
  srcPdf: PDFDocument,
  startPageIdxInclusive: number,
  count: number,
): Promise<Uint8Array> {
  const newPdf = await PDFDocument.create()
  const indices: number[] = []
  for (let i = 0; i < count; i++) indices.push(startPageIdxInclusive + i)
  const copied = await newPdf.copyPages(srcPdf, indices)
  for (const p of copied) newPdf.addPage(p)
  return await newPdf.save()
}

// Find the largest `count` pages starting at `start` that fit under `maxBytes`.
// Returns { count, bytes }. Uses exponential growth + binary search.
// Complexity: ~O(log remainingPages) saves.
async function findMaxFittingCount(
  srcPdf: PDFDocument,
  start: number,
  remainingPages: number,
  maxBytes: number,
): Promise<{ count: number; bytes: Uint8Array }> {
  // 1) At least one page must fit, or we error (single-page too large)
  let loCount = 1
  let loBytes = await saveRange(srcPdf, start, loCount)
  if (loBytes.length > maxBytes) {
    throw new PdfPageTooLargeError(
      start + 1,
      Math.floor(maxBytes / (1024 * 1024)),
      loBytes.length,
    )
  }

  // 2) Exponential growth to find an overflow upper bound
  let hiCount = loCount
  let hiBytes: Uint8Array | null = null
  while (hiCount < remainingPages) {
    // Double, but cap by remaining pages
    const next = Math.min(hiCount * 2, remainingPages)
    const tryBytes = await saveRange(srcPdf, start, next)
    if (tryBytes.length <= maxBytes) {
      // Still under → move low up
      loCount = next
      loBytes = tryBytes
      hiCount = next
      if (next === remainingPages) {
        // Everything fits, done
        return { count: loCount, bytes: loBytes }
      }
    } else {
      // Overflow found; set high bound and break
      hiCount = next
      hiBytes = tryBytes // record overflow marker
      break
    }
  }

  // If we never overflowed (all pages fit via loop), return lo
  if (!hiBytes && loCount === remainingPages) {
    return { count: loCount, bytes: loBytes }
  }

  // 3) Binary search between (loCount, hiCount-1)
  let left = loCount + 1
  let right = hiCount - 1
  let bestCount = loCount
  let bestBytes = loBytes

  while (left <= right) {
    const mid = (left + right) >> 1
    const bytes = await saveRange(srcPdf, start, mid)
    if (bytes.length <= maxBytes) {
      bestCount = mid
      bestBytes = bytes
      left = mid + 1
    } else {
      right = mid - 1
    }
  }

  return { count: bestCount, bytes: bestBytes }
}

// Public splitter: O(k log n) saves for k chunks total
export async function splitPdfIntoInlineSizedChunks(
  data: Uint8Array,
  maxBytes: number,
  logger?: { info: Function; warn: Function },
  srcPdfDoc?: PDFDocument,
): Promise<Uint8Array[]> {
  const srcPdf = srcPdfDoc || (await PDFDocument.load(data))
  const totalPages = srcPdf.getPageCount()

  const chunks: Uint8Array[] = []
  let start = 0

  while (start < totalPages) {
    const remaining = totalPages - start
    const { count, bytes } = await findMaxFittingCount(
      srcPdf,
      start,
      remaining,
      maxBytes,
    )

    if (logger) {
      console.log(
        {
          startPage: start + 1,
          endPage: start + count,
          pagesInChunk: count,
          subSizeBytes: bytes.length,
          maxBytes,
        },
        "Prepared sub-PDF chunk",
      )
    }

    chunks.push(bytes)
    start += count
  }
  return chunks
}

// Page-first splitter (≤ maxPagesPerChunk), then size rule (≤ maxBytes)
export async function splitPdfByPagesThenSize(
  data: Uint8Array,
  maxPagesPerChunk: number = PAGE_SPLIT_NUMBER,
  maxBytes: number = INLINE_MAX_BYTES,
  logger?: { info: Function; warn: Function },
): Promise<Uint8Array[]> {
  const srcPdf = await PDFDocument.load(data)
  const totalPages = srcPdf.getPageCount()

  // If small page count, fall back to size-based splitting only
  if (totalPages <= maxPagesPerChunk) {
    if (data.length <= maxBytes) return [data]
    return await splitPdfIntoInlineSizedChunks(data, maxBytes, logger, srcPdf)
  }

  const chunks: Uint8Array[] = []

  // Helper: split a specific page range by size (stays within the range)
  const splitRangeBySize = async (
    startPage: number,
    pageCount: number,
  ): Promise<void> => {
    let localStart = startPage
    let remaining = pageCount
    while (remaining > 0) {
      const { count, bytes } = await findMaxFittingCount(
        srcPdf,
        localStart,
        remaining,
        maxBytes,
      )
      Logger.debug("Prepared sub-PDF chunk within page group")

      chunks.push(bytes)
      localStart += count
      remaining -= count
    }
  }

  // Page-first: iterate groups of ≤ maxPagesPerChunk, then size-check each
  for (let start = 0; start < totalPages; start += maxPagesPerChunk) {
    const count = Math.min(maxPagesPerChunk, totalPages - start)
    const bytes = await saveRange(srcPdf, start, count)

    if (bytes.length <= maxBytes) {
      chunks.push(bytes)
    } else {
      // Further split this page group by size
      await splitRangeBySize(start, count)
    }
  }

  return chunks
}

/**
 * Extract semantic chunks from a PDF using Gemini Flash on Vertex AI.
 * - If the data passed to this function is < 17MB, it is sent as inlineData (base64-encoded).
 * - Callers should split larger PDFs into sub-PDFs <= 17MB and call this per part.
 */
export async function extractSemanticChunksFromPdf(
  pdfData: Uint8Array,
  opts: ChunkPdfOptions = {},
): Promise<string> {
  if (!pdfData || pdfData.length === 0) throw new Error("pdfData is required")

  const dataSize = pdfData.length

  const projectId = process.env.VERTEX_PROJECT_ID || ""

  const location = process.env.VERTEX_REGION || "us-central1"

  if (!projectId) {
    throw new Error(
      "Missing GCP project ID. Set VERTEX_PROJECT_ID or GOOGLE_CLOUD_PROJECT (or GCLOUD_PROJECT/GCP_PROJECT_ID) or pass options.projectId.",
    )
  }

  const modelId =
    opts.model ||
    process.env.VERTEX_AI_MODEL_PDF_PROCESSING ||
    "gemini-2.5-flash"
  const maxOutputTokens = opts.maxOutputTokens ?? GEMINI_OUTPUT_LIMIT
  const temperature = opts.temperature ?? 0.1

  const vertex = new VertexAI({ project: projectId, location })
  const model = vertex.getGenerativeModel({
    model: modelId,
    generationConfig: { maxOutputTokens, temperature },
  })

  // Build message parts - always inlineData (callers split before calling)
  const messageParts: any[] = [{ text: CHUNKING_PROMPT }]
  const pdfBase64 = Buffer.from(pdfData).toString("base64")
  messageParts.push({
    inlineData: {
      mimeType: "application/pdf",
      data: pdfBase64,
    },
  })

  Logger.debug(
    {
      model: modelId,
      projectId,
      location,
      mode: "inlineData",
      sizeBytes: dataSize,
    },
    "Sending PDF to Gemini Flash via Vertex AI",
  )

  // Call Vertex AI Gemini Flash
  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: messageParts,
      },
    ],
  })

  // Parse and return raw text
  const candidates = result.response?.candidates ?? []
  const parts = candidates[0]?.content?.parts ?? []
  const text = parts
    .filter((p: any) => typeof p?.text === "string")
    .map((p: any) => p.text as string)
    .join("")
    .trim()

  return text
}

/**
 * Parse Gemini's raw output into an ordered list of chunk strings.
 * Looks for <chunk>...</chunk> blocks, preserving order.
 */
export function parseGeminiChunkBlocks(raw: string): string[] {
  if (!raw) return []
  const chunks: string[] = []
  const re = /<chunk\b[^>]*>([\s\S]*?)<\/chunk>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    const content = (match[1] || "").trim()
    if (content) chunks.push(content)
  }
  return chunks
}

/**
 * Notes:
 * - image_chunks and image_chunk_pos are intentionally empty.
 * - Maintains chunk positions sequentially (0..n-1), equivalent to
 *   the globalSeq logic in pdfChunks.ts.
 * - Accepts a PDF as Uint8Array and processes it directly with Gemini.
 */
export async function extractTextAndImagesWithChunksFromPDFviaGemini(
  data: Uint8Array,
  docid: string = crypto.randomUUID(), // will be used to parse images if we extract it later
  opts: Partial<ChunkPdfOptions> = {},
): Promise<{
  text_chunks: string[]
  image_chunks: string[]
  text_chunk_pos: number[]
  image_chunk_pos: number[]
}> {
  if (!data || data.length === 0) {
    return {
      text_chunks: [],
      image_chunks: [],
      text_chunk_pos: [],
      image_chunk_pos: [],
    }
  }

  if (data.length > MAX_SUPPORTED_BYTES) {
    const actualMB = data.length / (1024 * 1024)
    const maxMB = MAX_SUPPORTED_BYTES / (1024 * 1024)
    throw new FileSizeExceededError(maxMB, actualMB)
  }

  const text_chunks: string[] = []
  const text_chunk_pos: number[] = []
  let globalSeq = 0

  // Page-first rule: if > 30 pages, split into ≤30-page groups first,
  // then ensure each group is ≤ 17MB (split further if needed).
  const subPdfs = await splitPdfByPagesThenSize(
    data,
    PAGE_SPLIT_NUMBER,
    INLINE_MAX_BYTES,
    Logger,
  )
  for (let i = 0; i < subPdfs.length; i++) {
    const part = subPdfs[i]
    Logger.info(
      { index: i + 1, bytes: part.length },
      "Sending sub-PDF to Gemini",
    )
    const raw = await extractSemanticChunksFromPdf(
      part,
      opts as ChunkPdfOptions,
    )
    const chunks = parseGeminiChunkBlocks(raw)
    for (const c of chunks) {
      text_chunks.push(c)
      text_chunk_pos.push(globalSeq++)
    }
  }

  // As requested: image arrays are always empty/unified
  const image_chunks: string[] = []
  const image_chunk_pos: number[] = []

  return { text_chunks, image_chunks, text_chunk_pos, image_chunk_pos }
}
