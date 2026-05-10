import { chunkByOCRFromBuffer } from "@/lib/chunkByOCR"
import { chunkByDoclingFromBuffer } from "@/lib/chunkByDocling"
import { extractTextAndImagesWithChunksFromPDFviaGemini } from "@/lib/chunkPdfWithGemini"
import { PdfPageCountExceededError } from "@/integrations/dataSource/errors"
import { extractTextAndImagesWithChunksFromPDF } from "@/pdfChunks"
import { type ChunkMetadata } from "@/types"
import { PDFDocument } from "pdf-lib"
import { getLogger, Subsystem } from "@/logger"

const Logger = getLogger(Subsystem.Ingest).child({
  module: "pdfProcessor",
})

export const PDF_PROCESSING_METHOD = {
  OCR: "ocr",
  DOCLING: "docling",
  GEMINI: "gemini",
  PDFJS: "pdfjs",
} as const

export type PdfProcessingMethod =
  (typeof PDF_PROCESSING_METHOD)[keyof typeof PDF_PROCESSING_METHOD]

const PDF_GEMINI_PAGE_THRESHOLD = 40
const MAX_PDF_PAGE_COUNT = 1000
const DEFAULT_DOCLING_TIMEOUT_FALLBACK_MS = 30 * 60 * 1000
const DOCLING_TIMEOUT_PER_PAGE_MS = 15 * 1000
const DOCLING_TIMEOUT_PER_100KB_MS = 10 * 1000
const ONE_HUNDRED_KB_BYTES = 100 * 1024

type DoclingPreflight = {
  pageCount: number | null
  timeoutMs: number
  usedFallbackTimeout: boolean
}

function getConfiguredDoclingBaseTimeoutMs(): number {
  const raw = process.env.DOCLING_TIMEOUT_MS
  if (!raw) {
    return DEFAULT_DOCLING_TIMEOUT_FALLBACK_MS
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DOCLING_TIMEOUT_FALLBACK_MS
  }

  return parsed
}

const DOCLING_BASE_TIMEOUT_MS = getConfiguredDoclingBaseTimeoutMs()

export function calculateDoclingTimeoutMs(
  fileSizeBytes: number,
  pageCount: number | null,
  baseTimeoutMs: number = DOCLING_BASE_TIMEOUT_MS,
): DoclingPreflight {
  if (
    !Number.isFinite(fileSizeBytes) ||
    fileSizeBytes <= 0 ||
    !Number.isFinite(pageCount) ||
    (pageCount as number) <= 0
  ) {
    return {
      pageCount: pageCount ?? null,
      timeoutMs: DEFAULT_DOCLING_TIMEOUT_FALLBACK_MS,
      usedFallbackTimeout: true,
    }
  }

  const sizeUnits = Math.ceil(fileSizeBytes / ONE_HUNDRED_KB_BYTES)
  const timeoutMs =
    baseTimeoutMs +
    (pageCount as number) * DOCLING_TIMEOUT_PER_PAGE_MS +
    sizeUnits * DOCLING_TIMEOUT_PER_100KB_MS

  return {
    pageCount: pageCount as number,
    timeoutMs,
    usedFallbackTimeout: false,
  }
}

export interface ProcessingResult {
  chunks: string[]
  chunks_pos: number[]
  image_chunks: string[]
  image_chunks_pos: number[]
  toc_chunks: string[]
  chunks_map: ChunkMetadata[]
  image_chunks_map: ChunkMetadata[]
  processingMethod?: PdfProcessingMethod
}

export type ProcessingResultDraft = {
  chunks: string[]
  chunks_pos?: number[]
  image_chunks: string[]
  image_chunks_pos?: number[]
  toc_chunks?: string[]
  chunks_map?: ChunkMetadata[]
  image_chunks_map?: ChunkMetadata[]
  processingMethod?: PdfProcessingMethod
}

export class PdfProcessor {
  private static normalizeChunkMetadata(
    metadata: ChunkMetadata[] | undefined,
    totalCount: number,
  ): ChunkMetadata[] {
    // If metadata is provided and has the correct length, use it as-is
    // The chunk_index in metadata represents the global index across all chunks,
    // not the position in this specific array
    if (Array.isArray(metadata) && metadata.length === totalCount) {
      return metadata.map((entry, index) => ({
        chunk_index:
          typeof entry?.chunk_index === "number" && entry.chunk_index >= 0
            ? entry.chunk_index
            : index,
        page_numbers: Array.isArray(entry?.page_numbers)
          ? entry.page_numbers
          : [],
        block_labels: Array.isArray(entry?.block_labels)
          ? entry.block_labels
          : [],
        bbox: entry?.bbox,
        bboxes: (entry as any)?.bboxes,
        width: entry?.width,
        height: entry?.height,
        headings: entry?.headings,
      }))
    }

    // Fallback: create default metadata for each chunk
    const normalized: ChunkMetadata[] = []
    for (let index = 0; index < totalCount; index++) {
      normalized.push({
        chunk_index: index,
        page_numbers: [],
        block_labels: [],
      })
    }

    return normalized
  }

  private static ensurePositions(
    items: unknown[],
    positions?: number[],
  ): number[] {
    if (Array.isArray(positions) && positions.length === items.length) {
      return positions
    }
    return items.map((_, index) => index)
  }

  private static finalizeProcessingResult(
    payload: ProcessingResultDraft,
    method: PdfProcessingMethod,
  ): ProcessingResult {
    const chunkPositions = this.ensurePositions(
      payload.chunks,
      payload.chunks_pos,
    )
    const imageChunkPositions = this.ensurePositions(
      payload.image_chunks,
      payload.image_chunks_pos,
    )

    const chunks_map = this.normalizeChunkMetadata(
      payload.chunks_map,
      payload.chunks.length,
    )
    const image_chunks_map = this.normalizeChunkMetadata(
      payload.image_chunks_map,
      payload.image_chunks.length,
    )

    return {
      chunks: payload.chunks,
      chunks_pos: chunkPositions,
      image_chunks: payload.image_chunks,
      image_chunks_pos: imageChunkPositions,
      toc_chunks: payload.toc_chunks || [],
      chunks_map,
      image_chunks_map,
      processingMethod: method,
    }
  }

  private static async getPdfPageCount(buffer: Buffer): Promise<number | null> {
    try {
      const document = await PDFDocument.load(buffer)
      return document.getPageCount()
    } catch (error) {
      Logger.warn(
        error,
        "Failed to determine PDF page count, skipping Gemini eligibility check",
      )
      return null
    }
  }

  /**
   * Helper method to process PDF with Gemini and transform the result
   */
  private static async processWithGemini(
    buffer: Buffer,
    vespaDocId: string,
  ): Promise<ProcessingResult> {
    const geminiResult = await extractTextAndImagesWithChunksFromPDFviaGemini(
      buffer,
      vespaDocId,
    )
    return this.finalizeProcessingResult(
      {
        chunks: geminiResult.text_chunks,
        chunks_pos: geminiResult.text_chunk_pos,
        image_chunks: geminiResult.image_chunks,
        image_chunks_pos: geminiResult.image_chunk_pos,
      },
      PDF_PROCESSING_METHOD.GEMINI,
    )
  }

  /**
   * Helper method to process PDF with PDF.js and transform the result
   */
  private static async processWithPdfJs(
    buffer: Buffer,
    vespaDocId: string,
    extractImages: boolean = false,
    describeImages: boolean = false,
  ): Promise<ProcessingResult> {
    // Convert Buffer to Uint8Array for PDF.js compatibility
    const uint8Buffer = new Uint8Array(buffer)
    const pdfJsResult = await extractTextAndImagesWithChunksFromPDF(
      uint8Buffer,
      vespaDocId,
      extractImages,
      describeImages,
    )
    return this.finalizeProcessingResult(
      {
        chunks: pdfJsResult.text_chunks,
        chunks_pos: pdfJsResult.text_chunk_pos,
        image_chunks: pdfJsResult.image_chunks,
        image_chunks_pos: pdfJsResult.image_chunk_pos,
        chunks_map: pdfJsResult.text_chunks_map,
        image_chunks_map: pdfJsResult.image_chunks_map,
      },
      PDF_PROCESSING_METHOD.PDFJS,
    )
  }

  /**
   * Helper method to process PDF with Docling and transform the result
   */
  private static async processWithDocling(
    buffer: Buffer,
    fileName: string,
    vespaDocId: string,
    preflight: DoclingPreflight,
  ): Promise<ProcessingResult> {
    Logger.info(
      {
        fileName,
        fileSizeBytes: buffer.length,
        pageCount: preflight.pageCount,
        computedTimeoutMs: preflight.timeoutMs,
        usedFallbackTimeout: preflight.usedFallbackTimeout,
      },
      `Computed docling request preflight timeoutMs=${preflight.timeoutMs} pageCount=${preflight.pageCount ?? "unknown"} fallback=${preflight.usedFallbackTimeout} fileSizeBytes=${buffer.length}`,
    )

    const doclingResult = await chunkByDoclingFromBuffer(
      buffer,
      fileName,
      vespaDocId,
      { timeoutMs: preflight.timeoutMs },
    )
    return this.finalizeProcessingResult(
      {
        chunks: doclingResult.chunks,
        chunks_pos: doclingResult.chunks_pos,
        image_chunks: doclingResult.image_chunks,
        image_chunks_pos: doclingResult.image_chunks_pos,
        toc_chunks: doclingResult.toc_chunks,
        chunks_map: doclingResult.chunks_map,
        image_chunks_map: doclingResult.image_chunks_map,
      },
      PDF_PROCESSING_METHOD.DOCLING,
    )
  }

  /**
   * Processes a PDF using the fallback logic:
   * 1. Try OCR first (if enabled via useOCR)
   *    - If DOCLING_ENABLED is true, use Docling
   *    - Otherwise, use Paddle OCR (if OCR_PROVIDERS configured)
   * 2. If OCR fails and PDF < 40 pages, try Gemini
   * 3. If all above fail or PDF >= 40 pages, use PDF.js
   *
   * @param buffer - PDF file buffer
   * @param fileName - Name of the PDF file
   * @param vespaDocId - Vespa document ID
   * @param extractImages - Whether to extract images (only applies to the PDF.js fallback).
   * @param describeImages - Whether to describe images (only applies to the PDF.js fallback).
   * @param useOCR - Whether to use OCR for processing (default: true)
   * @returns PDF processing result with method used
   */
  static async processWithFallback(
    buffer: Buffer,
    fileName: string,
    vespaDocId: string,
    extractImages: boolean = false,
    describeImages: boolean = false,
    useOCR: boolean = true,
  ): Promise<ProcessingResult> {
    const pageCount = await this.getPdfPageCount(buffer)
    if (pageCount !== null && pageCount > MAX_PDF_PAGE_COUNT) {
      throw new PdfPageCountExceededError(pageCount, MAX_PDF_PAGE_COUNT)
    }

    // Step 1: Try OCR first (if enabled)
    if (useOCR) {
      try {
        Logger.info(`Attempting OCR processing for ${fileName}`)

        // Check if Docling is enabled in config, otherwise use Paddle OCR
        const doclingEnabled = process.env.DOCLING_ENABLED === "true"

        if (doclingEnabled) {
          const doclingPreflight = calculateDoclingTimeoutMs(
            buffer.length,
            pageCount,
          )
          Logger.info(`Using Docling for OCR processing of ${fileName}`)
          const doclingResult = await this.processWithDocling(
            buffer,
            fileName,
            vespaDocId,
            doclingPreflight,
          )
          Logger.info(`Docling processing successful for ${fileName}`)
          return doclingResult
        } else {
          Logger.info(`Using Paddle OCR for processing of ${fileName}`)
          const ocrResult = await chunkByOCRFromBuffer(
            buffer,
            fileName,
            vespaDocId,
          )
          Logger.info(`OCR processing successful for ${fileName}`)
          return this.finalizeProcessingResult(
            {
              chunks: ocrResult.chunks,
              chunks_pos: ocrResult.chunks_pos,
              image_chunks: ocrResult.image_chunks,
              image_chunks_pos: ocrResult.image_chunks_pos,
              chunks_map: ocrResult.chunks_map,
              image_chunks_map: ocrResult.image_chunks_map,
            },
            PDF_PROCESSING_METHOD.OCR,
          )
        }
      } catch (error) {
        Logger.warn(
          `OCR PDF processing failed for ${fileName}, attempting fallbacks. error: ${JSON.stringify(error)}`,
        )
      }
    } else {
      Logger.info(`OCR disabled for ${fileName}, skipping OCR processing`)
    }

    // Step 2: Determine if we should try Gemini based on page count
    const shouldTryGemini =
      pageCount !== null && pageCount < PDF_GEMINI_PAGE_THRESHOLD

    if (shouldTryGemini) {
      try {
        Logger.info(
          `Attempting Gemini processing for ${fileName} (${pageCount} pages)`,
        )
        const result = await this.processWithGemini(buffer, vespaDocId)
        Logger.info(`Gemini processing successful for ${fileName}`)
        return result
      } catch (error) {
        Logger.warn(
          `Gemini PDF processing failed for ${fileName}, falling back to PDF.js. error: ${JSON.stringify(error)}`,
        )
      }
    } else if (pageCount !== null) {
      Logger.debug(
        {
          fileName,
          pageCount,
          threshold: PDF_GEMINI_PAGE_THRESHOLD,
        },
        "Skipping Gemini fallback due to page count threshold",
      )
    }

    // Step 3: Final fallback to PDF.js
    try {
      Logger.info(`Attempting PDF.js processing for ${fileName}`)
      const result = await this.processWithPdfJs(
        buffer,
        vespaDocId,
        extractImages,
        describeImages,
      )
      Logger.info(`PDF.js processing successful for ${fileName}`)
      return result
    } catch (error) {
      Logger.error(
        `All PDF processing strategies failed for ${fileName}. error: ${JSON.stringify(error)}`,
      )
      throw error
    }
  }

  /**
   * Get the page count of a PDF without processing it
   */
  static async getPageCount(buffer: Buffer): Promise<number | null> {
    return this.getPdfPageCount(buffer)
  }

  static getMaxPdfPageCount(): number {
    return MAX_PDF_PAGE_COUNT
  }

  /**
   * Configuration for PDF processing
   */
  static getConfig() {
    return {
      geminiPageThreshold: PDF_GEMINI_PAGE_THRESHOLD,
      supportedMethods: ["ocr", "docling", "gemini", "pdfjs"] as const,
      defaultFallbackOrder: ["ocr", "gemini", "pdfjs"] as const,
    }
  }
}
