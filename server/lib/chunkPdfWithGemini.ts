import * as crypto from "crypto"
import { VertexAI } from "@google-cloud/vertexai"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.AI).child({ module: "chunkPdfWithGemini" })



export const CHUNKING_PROMPT = `\
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

export type ChunkPdfOptions = {
  projectId?: string
  location?: string
  model?: string
  gcsUri?: string // Optional GCS URI to use for PDFs >= 15MB
  maxOutputTokens?: number
  temperature?: number
}

// 15 MB threshold for inlineData vs file_data
const INLINE_MAX_BYTES = 17 * 1024 * 1024

/**
 * Extract semantic chunks from a PDF using Gemini Flash on Vertex AI.
 * - If the file size < 15MB, sends the PDF as inlineData (base64-encoded)
 * - If the file size >= 15MB, requires a GCS URI (or uploaded File API URI) and uses file_data
 */
export async function extractSemanticChunksFromPdf(
  pdfData: Uint8Array,
  opts: ChunkPdfOptions = {},
): Promise<string> {
  if (!pdfData || pdfData.length === 0) throw new Error("pdfData is required")

  const dataSize = pdfData.length

  const projectId =
    process.env.VERTEX_PROJECT_ID ||
    ""

  const location =
    process.env.VERTEX_REGION ||
    "us-central1"

  if (!projectId) {
    throw new Error(
      "Missing GCP project ID. Set VERTEX_PROJECT_ID or GOOGLE_CLOUD_PROJECT (or GCLOUD_PROJECT/GCP_PROJECT_ID) or pass options.projectId.",
    )
  }

  const modelId = opts.model || process.env.VERTEX_AI_MODEL_PDF_PROCESSING || "gemini-2.5-flash"
  const maxOutputTokens = opts.maxOutputTokens ?? 8192
  const temperature = opts.temperature ?? 0.1

  const vertex = new VertexAI({ project: projectId, location })
  const model = vertex.getGenerativeModel({
    model: modelId,
    generationConfig: { maxOutputTokens, temperature },
  })

  // Build message parts
  const messageParts: any[] = [{ text: CHUNKING_PROMPT }]

  if (dataSize < INLINE_MAX_BYTES) {
    // Use inlineData for smaller PDFs
    const pdfBase64 = Buffer.from(pdfData).toString("base64")
    messageParts.push({
      inlineData: {
        mimeType: "application/pdf",
        data: pdfBase64,
      },
    })
  } else {
    // For large PDFs, require a GCS URI (or a File API URI)
    const fileUri = opts.gcsUri || process.env.PDF_GCS_URI
    if (!fileUri) {
      throw new Error(
        "PDF >= 15MB. Provide a GCS URI via options.gcsUri or env PDF_GCS_URI, or upload via Vertex AI File API and supply its URI.",
      )
    }
    // Use file_data for large files
    messageParts.push({
      // Include both camelCase and snake_case to accommodate library variations
      fileData: {
        mimeType: "application/pdf",
        fileUri,
      },
      file_data: {
        mime_type: "application/pdf",
        file_uri: fileUri,
      },
    })
  }

  Logger.info(
    {
      model: modelId,
      projectId,
      location,
      mode: dataSize < INLINE_MAX_BYTES ? "inlineData" : "file_data",
      sizeBytes: dataSize,
    },
    "Sending PDF to Gemini Flash via Vertex AI",
  )

  // Call Vertex AI Gemini Flash
  const response = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: messageParts,
      },
    ],
  })

  // Parse and return raw text
  const candidates = (response as any)?.response?.candidates || []
  const parts = candidates[0]?.content?.parts || []
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
 * Gemini-backed PDF extractor that returns the same shape as
 * extractTextAndImagesWithChunksFromPDF in server/pdfChunks.ts.
 *
 * Notes:
 * - image_chunks and image_chunk_pos are intentionally empty.
 * - Maintains chunk positions sequentially (0..n-1), equivalent to
 *   the globalSeq logic in pdfChunks.ts.
 * - Accepts a PDF as Uint8Array and processes it directly with Gemini.
 */
export async function extractTextAndImagesWithChunksFromPDFviaGemini(
  data: Uint8Array,
  docid: string = crypto.randomUUID(),
  _extractImages: boolean = false,
  _describeImages: boolean = false,
  _includeImageMarkersInText: boolean = true,
  opts: Partial<ChunkPdfOptions> = {},
): Promise<{
  text_chunks: string[]
  image_chunks: string[]
  text_chunk_pos: number[]
  image_chunk_pos: number[]
}> {
  // Ask Gemini to chunk this PDF directly with the data
  const raw = await extractSemanticChunksFromPdf(data, opts)

  // Parse <chunk> blocks
  const chunks = parseGeminiChunkBlocks(raw)

  // Build positions with global sequence semantics
  const text_chunks: string[] = []
  const text_chunk_pos: number[] = []
  let globalSeq = 0
  for (const c of chunks) {
    text_chunks.push(c)
    text_chunk_pos.push(globalSeq)
    globalSeq++
  }

  // As requested: image arrays are always empty
  const image_chunks: string[] = []
  const image_chunk_pos: number[] = []

  return {
    text_chunks,
    image_chunks,
    text_chunk_pos,
    image_chunk_pos,
  }
}
