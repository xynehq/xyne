import { randomUUID } from "node:crypto"
import { promises as fsPromises } from "node:fs"
import path from "node:path"
import config from "@/config"
import { PdfPageCountExceededError } from "@/integrations/dataSource/errors"
import { chunkByDoclingFromBuffer } from "@/lib/chunkByDocling"
import { chunkByOCRFromBuffer } from "@/lib/chunkByOCR"
import { extractTextAndImagesWithChunksFromPDFviaGemini } from "@/lib/chunkPdfWithGemini"
import { Subsystem, getLogger } from "@/logger"
import { extractTextAndImagesWithChunksFromPDF } from "@/pdfChunks"
import { type ChunkMetadata } from "@/types"
import { PDFDocument } from "pdf-lib"

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
const DEFAULT_DOCLING_TIMEOUT_FALLBACK_MS = 30 * 60 * 1000
const DOCLING_TIMEOUT_PER_PAGE_MS = 15 * 1000
const DOCLING_TIMEOUT_PER_100KB_MS = 10 * 1000
const ONE_HUNDRED_KB_BYTES = 100 * 1024

type DoclingPreflight = {
  pageCount: number | null
  timeoutMs: number
  usedFallbackTimeout: boolean
}

export type DoclingPageChunkResult = {
  result: ProcessingResult
  partIndex: number
  startPage: number
  endPage: number
  totalPages: number
}

export type DoclingPageChunk = {
  buffer: Buffer
  partIndex: number
  startPage: number
  endPage: number
  totalPages: number
  partDocId: string
  partFileName: string
}

export type DoclingStagedPart = Omit<DoclingPageChunk, "buffer"> & {
  partPath: string
  partSizeBytes: number
}

export type DoclingStagedParts = {
  fileId: string
  vespaDocId: string
  sourcePath: string
  sourceSize: number | null
  sourceMtimeMs: number | null
  fileName: string
  totalPages: number
  pageChunkSize: number
  partsTotal: number
  stageDir: string
  partsDir: string
  manifestPath: string
  parts: DoclingStagedPart[]
}

export type LoadedPdfDocument = {
  document: PDFDocument
  pageCount: number
}

type PdfLoadContext = {
  fileId?: string
  fileName?: string
}

type PdfMetadata = {
  pageCount: number
  fileSizeBytes: number
}

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const withPdfWorkPermit = async <T>(
  _details: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> => fn()

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

const getDoclingTempRoot = (): string =>
  path.isAbsolute(config.doclingTempResultsDir)
    ? config.doclingTempResultsDir
    : path.resolve(process.cwd(), config.doclingTempResultsDir)

const writeJsonAtomically = async (targetPath: string, payload: unknown) => {
  const tmpPath = `${targetPath}.tmp`
  await fsPromises.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`)
  await fsPromises.rename(tmpPath, targetPath)
}

const getQpdfTimeoutMs = (): number => {
  const parsed = Number.parseInt(process.env.QPDF_TIMEOUT_MS || "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300000
}

const QPDF_OUTPUT_LOG_LIMIT = 4000
const QPDF_COMMON_ARGS = ["--no-warn", "--warning-exit-0"]

const truncateQpdfOutput = (value: string | null): string | null => {
  if (value === null || value.length <= QPDF_OUTPUT_LOG_LIMIT) {
    return value
  }
  return `${value.slice(0, QPDF_OUTPUT_LOG_LIMIT)}\n... truncated ${value.length - QPDF_OUTPUT_LOG_LIMIT} chars`
}

const runQpdfCommand = async (
  operation: string,
  args: string[],
  context: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string }> => {
  const timeoutMs = getQpdfTimeoutMs()
  const startedAt = Date.now()
  const cmd = ["qpdf", ...QPDF_COMMON_ARGS, ...args]
  const proc = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  })

  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill("SIGKILL")
  }, timeoutMs)

  try {
    const exitCode = await proc.exited
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    const elapsedMs = Date.now() - startedAt

    if (timedOut) {
      throw new Error(`qpdf timed out after ${timeoutMs}ms for ${operation}`)
    }

    if (exitCode !== 0) {
      const output = truncateQpdfOutput(stderr || stdout)
      throw new Error(
        `qpdf exited with code ${exitCode} for ${operation}: ${output ?? ""}`,
      )
    }

    Logger.info(
      {
        ...context,
        operation,
        elapsedMs,
        timeoutMs,
        cmd,
      },
      "✅ qpdf command completed",
    )
    return { stdout, stderr }
  } catch (error) {
    const [stdout, stderr] = await Promise.allSettled([
      stdoutPromise,
      stderrPromise,
    ])
    const stdoutValue = stdout.status === "fulfilled" ? stdout.value : null
    const stderrValue = stderr.status === "fulfilled" ? stderr.value : null
    Logger.error(
      {
        ...context,
        operation,
        elapsedMs: Date.now() - startedAt,
        timeoutMs,
        timedOut,
        cmd,
        stdout: truncateQpdfOutput(stdoutValue),
        stderr: truncateQpdfOutput(stderrValue),
        stdoutLength: stdoutValue?.length ?? null,
        stderrLength: stderrValue?.length ?? null,
        errorMessage: getErrorMessage(error),
        error,
      },
      "🔴 qpdf command failed",
    )
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

const getQpdfPageCount = async (
  sourcePath: string,
  context: Record<string, unknown>,
): Promise<number> => {
  const { stdout } = await runQpdfCommand(
    "page_count",
    ["--show-npages", sourcePath],
    {
      ...context,
      sourcePath,
    },
  )
  const pageCount = Number.parseInt(stdout.trim(), 10)
  if (!Number.isFinite(pageCount) || pageCount <= 0) {
    throw new Error(`Invalid qpdf page count: ${stdout}`)
  }
  return pageCount
}

const extractQpdfPart = async (options: {
  sourcePath: string
  partPath: string
  startPage: number
  endPage: number
  context: Record<string, unknown>
}): Promise<number> => {
  const tmpPartPath = `${options.partPath}.tmp`
  const qpdfStartPage = options.startPage + 1
  const qpdfEndPage = options.endPage
  await fsPromises.rm(tmpPartPath, { force: true }).catch(() => undefined)
  try {
    await runQpdfCommand(
      "extract_part",
      [
        "--empty",
        "--pages",
        options.sourcePath,
        `${qpdfStartPage}-${qpdfEndPage}`,
        "--",
        tmpPartPath,
      ],
      {
        ...options.context,
        sourcePath: options.sourcePath,
        partPath: options.partPath,
        tmpPartPath,
        startPage: qpdfStartPage,
        endPage: qpdfEndPage,
      },
    )
    await fsPromises.rename(tmpPartPath, options.partPath)
    const stats = await fsPromises.stat(options.partPath)
    return stats.size
  } catch (error) {
    await fsPromises.rm(tmpPartPath, { force: true }).catch(() => undefined)
    throw error
  }
}

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
  documentOutline?: string
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
  documentOutline?: string
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
      documentOutline: payload.documentOutline,
    }
  }

  static async loadDocument(
    buffer: Buffer,
    context: PdfLoadContext = {},
  ): Promise<LoadedPdfDocument | null> {
    const startedAt = Date.now()
    try {
      return await withPdfWorkPermit(
        {
          operation: "load_document",
          fileSizeBytes: buffer.length,
          fileId: context.fileId,
          fileName: context.fileName,
        },
        async () => {
          Logger.info(
            {
              fileId: context.fileId,
              fileName: context.fileName,
              fileSizeBytes: buffer.length,
            },
            "✅ PDF-lib load_document starting",
          )
          const document = await PDFDocument.load(buffer)
          const pageCount = document.getPageCount()
          Logger.info(
            {
              fileId: context.fileId,
              fileName: context.fileName,
              fileSizeBytes: buffer.length,
              pageCount,
              elapsedMs: Date.now() - startedAt,
            },
            "✅ PDF-lib load_document completed",
          )
          return {
            document,
            pageCount,
          }
        },
      )
    } catch (error) {
      Logger.error(
        {
          fileId: context.fileId,
          fileName: context.fileName,
          fileSizeBytes: buffer.length,
          elapsedMs: Date.now() - startedAt,
          errorMessage: getErrorMessage(error),
          error,
        },
        "🔴 PDF-lib load_document failed",
      )
      return null
    }
  }

  static async loadDocumentMetadataFromFile(
    sourcePath: string,
    context: PdfLoadContext = {},
  ): Promise<PdfMetadata | null> {
    const startedAt = Date.now()
    try {
      return await withPdfWorkPermit(
        {
          operation: "qpdf_page_count",
          sourcePath,
          fileId: context.fileId,
          fileName: context.fileName,
        },
        async () => {
          const sourceStats = await fsPromises.stat(sourcePath)
          Logger.info(
            {
              fileId: context.fileId,
              fileName: context.fileName,
              sourcePath,
              fileSizeBytes: sourceStats.size,
              timeoutMs: getQpdfTimeoutMs(),
            },
            "✅ qpdf page count starting",
          )
          const pageCount = await getQpdfPageCount(sourcePath, {
            fileId: context.fileId,
            fileName: context.fileName,
            fileSizeBytes: sourceStats.size,
          })
          const metadata = {
            pageCount,
            fileSizeBytes: sourceStats.size,
          }
          Logger.info(
            {
              fileId: context.fileId,
              fileName: context.fileName,
              sourcePath,
              pageCount: metadata.pageCount,
              fileSizeBytes: metadata.fileSizeBytes,
              elapsedMs: Date.now() - startedAt,
            },
            "✅ qpdf page count completed",
          )
          return metadata
        },
      )
    } catch (error) {
      Logger.error(
        {
          fileId: context.fileId,
          fileName: context.fileName,
          sourcePath,
          elapsedMs: Date.now() - startedAt,
          errorMessage: getErrorMessage(error),
          error,
        },
        "🔴 qpdf page count failed",
      )
      throw error
    }
  }

  private static async getPdfPageCount(buffer: Buffer): Promise<number | null> {
    const loadedDocument = await this.loadDocument(buffer)
    return loadedDocument?.pageCount ?? null
  }

  static shouldStreamWithDocling(pageCount: number | null): boolean {
    return (
      config.doclingEnabled &&
      Number.isFinite(pageCount) &&
      (pageCount as number) >= config.doclingStreamingMinPages &&
      config.doclingPageChunkSize > 0
    )
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
        documentOutline: pdfJsResult.documentOutline,
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

  private static formatPartIndex(partIndex: number): string {
    return String(partIndex).padStart(5, "0")
  }

  static async stageDoclingPagePartsFromFile(options: {
    fileId: string
    sourcePath: string
    fileName: string
    vespaDocId: string
    pageChunkSize?: number
    knownTotalPages?: number | null
    stageRootPath?: string
  }): Promise<DoclingStagedParts> {
    const pageChunkSize = options.pageChunkSize ?? config.doclingPageChunkSize
    if (!Number.isFinite(pageChunkSize) || pageChunkSize <= 0) {
      throw new Error("Docling page chunk size must be greater than zero")
    }

    const startedAt = Date.now()
    try {
      const stagedParts = await withPdfWorkPermit(
        {
          operation: "qpdf_stage_file",
          fileId: options.fileId,
          fileName: options.fileName,
          vespaDocId: options.vespaDocId,
          pageChunkSize,
          knownTotalPages: options.knownTotalPages,
        },
        async () => {
          const sourceStats = await fsPromises
            .stat(options.sourcePath)
            .catch(() => null)
          const totalPages =
            typeof options.knownTotalPages === "number" &&
            Number.isFinite(options.knownTotalPages) &&
            options.knownTotalPages > 0
              ? options.knownTotalPages
              : await getQpdfPageCount(options.sourcePath, {
                  fileId: options.fileId,
                  fileName: options.fileName,
                  vespaDocId: options.vespaDocId,
                  fileSizeBytes: sourceStats?.size ?? null,
                })

          if (totalPages > config.maxPdfPageCount) {
            throw new PdfPageCountExceededError(
              totalPages,
              config.maxPdfPageCount,
            )
          }

          const stageDir = path.join(
            options.stageRootPath || getDoclingTempRoot(),
            options.fileId,
            randomUUID(),
          )
          const partsDir = path.join(stageDir, "parts")
          const manifestPath = path.join(stageDir, "manifest.json")
          await fsPromises.mkdir(partsDir, { recursive: true })
          const parts: DoclingStagedPart[] = []

          Logger.info(
            {
              fileId: options.fileId,
              fileName: options.fileName,
              vespaDocId: options.vespaDocId,
              sourcePath: options.sourcePath,
              totalPages,
              pageChunkSize,
              knownTotalPages: options.knownTotalPages,
              stageDir,
              timeoutMs: getQpdfTimeoutMs(),
            },
            "✅ qpdf Docling PDF part staging starting",
          )

          try {
            let partIndex = 0
            for (
              let startPage = 0;
              startPage < totalPages;
              startPage += pageChunkSize
            ) {
              const endPage = Math.min(startPage + pageChunkSize, totalPages)
              const partFileStem = this.formatPartIndex(partIndex)
              const partPath = path.join(partsDir, `${partFileStem}.pdf`)
              const partSizeBytes = await extractQpdfPart({
                sourcePath: options.sourcePath,
                partPath,
                startPage,
                endPage,
                context: {
                  fileId: options.fileId,
                  fileName: options.fileName,
                  vespaDocId: options.vespaDocId,
                  partIndex,
                  totalPages,
                  pageCount: endPage - startPage,
                },
              })

              const part: DoclingStagedPart = {
                partIndex,
                startPage,
                endPage,
                totalPages,
                partDocId: `${options.vespaDocId}__docling_part_${partIndex}`,
                partFileName: `${options.fileName}.pages-${startPage + 1}-${endPage}.pdf`,
                partPath,
                partSizeBytes,
              }
              parts.push(part)

              Logger.info(
                {
                  fileId: options.fileId,
                  fileName: options.fileName,
                  vespaDocId: options.vespaDocId,
                  partIndex,
                  startPage: startPage + 1,
                  endPage,
                  totalPages,
                  partPath,
                  partSizeBytes,
                },
                "✅ qpdf Docling PDF staged part written",
              )

              partIndex += 1
            }

            const stagedParts: DoclingStagedParts = {
              fileId: options.fileId,
              vespaDocId: options.vespaDocId,
              sourcePath: options.sourcePath,
              sourceSize: sourceStats?.size ?? null,
              sourceMtimeMs: sourceStats?.mtimeMs ?? null,
              fileName: options.fileName,
              totalPages,
              pageChunkSize,
              partsTotal: parts.length,
              stageDir,
              partsDir,
              manifestPath,
              parts,
            }

            await writeJsonAtomically(manifestPath, {
              fileId: stagedParts.fileId,
              vespaDocId: stagedParts.vespaDocId,
              sourcePath: stagedParts.sourcePath,
              sourceSize: stagedParts.sourceSize,
              sourceMtimeMs: stagedParts.sourceMtimeMs,
              fileName: stagedParts.fileName,
              totalPages: stagedParts.totalPages,
              pageChunkSize: stagedParts.pageChunkSize,
              partsTotal: stagedParts.partsTotal,
              stageDir: stagedParts.stageDir,
              partsDir: stagedParts.partsDir,
              parts: stagedParts.parts.map((part) => ({
                partIndex: part.partIndex,
                startPage: part.startPage,
                endPage: part.endPage,
                totalPages: part.totalPages,
                partDocId: part.partDocId,
                partFileName: part.partFileName,
                partPath: path.relative(stageDir, part.partPath),
                partSizeBytes: part.partSizeBytes,
              })),
            })

            return stagedParts
          } catch (error) {
            if (!config.doclingKeepTempResults) {
              await fsPromises
                .rm(stageDir, { recursive: true, force: true })
                .catch(() => undefined)
              await fsPromises
                .rmdir(path.dirname(stageDir))
                .catch(() => undefined)
            }
            throw error
          }
        },
      )

      Logger.info(
        {
          fileId: options.fileId,
          fileName: options.fileName,
          vespaDocId: options.vespaDocId,
          totalPages: stagedParts.totalPages,
          pageChunkSize,
          partsTotal: stagedParts.partsTotal,
          stageDir: stagedParts.stageDir,
          elapsedMs: Date.now() - startedAt,
        },
        "✅ qpdf Docling PDF part staging completed",
      )

      return stagedParts
    } catch (error) {
      Logger.error(
        {
          fileId: options.fileId,
          fileName: options.fileName,
          vespaDocId: options.vespaDocId,
          sourcePath: options.sourcePath,
          pageChunkSize,
          elapsedMs: Date.now() - startedAt,
          errorMessage: getErrorMessage(error),
          error,
        },
        "🔴 qpdf Docling PDF part staging failed",
      )
      throw error
    }
  }

  static async stageDoclingPageParts(options: {
    fileId: string
    source: LoadedPdfDocument
    sourcePath: string
    fileName: string
    vespaDocId: string
    pageChunkSize?: number
    knownTotalPages?: number | null
  }): Promise<DoclingStagedParts> {
    const pageChunkSize = options.pageChunkSize ?? config.doclingPageChunkSize
    if (!Number.isFinite(pageChunkSize) || pageChunkSize <= 0) {
      throw new Error("Docling page chunk size must be greater than zero")
    }

    const totalPages =
      typeof options.knownTotalPages === "number" &&
      Number.isFinite(options.knownTotalPages) &&
      options.knownTotalPages > 0
        ? options.knownTotalPages
        : options.source.pageCount

    if (totalPages > config.maxPdfPageCount) {
      throw new PdfPageCountExceededError(totalPages, config.maxPdfPageCount)
    }

    const stageDir = path.join(
      getDoclingTempRoot(),
      options.fileId,
      randomUUID(),
    )
    const partsDir = path.join(stageDir, "parts")
    const manifestPath = path.join(stageDir, "manifest.json")
    await fsPromises.mkdir(partsDir, { recursive: true })

    try {
      const sourceStats = await fsPromises
        .stat(options.sourcePath)
        .catch(() => null)
      const parts: DoclingStagedPart[] = []

      Logger.info(
        {
          fileId: options.fileId,
          fileName: options.fileName,
          vespaDocId: options.vespaDocId,
          totalPages,
          pageChunkSize,
          stageDir,
        },
        "Docling PDF part staging starting",
      )

      let partIndex = 0
      for (
        let startPage = 0;
        startPage < totalPages;
        startPage += pageChunkSize
      ) {
        const endPage = Math.min(startPage + pageChunkSize, totalPages)
        const pageIndexes = Array.from(
          { length: endPage - startPage },
          (_, index) => startPage + index,
        )
        const partFileStem = this.formatPartIndex(partIndex)
        const partPath = path.join(partsDir, `${partFileStem}.pdf`)
        const tmpPartPath = `${partPath}.tmp`

        const partBuffer = await withPdfWorkPermit(
          {
            operation: "stage_part",
            fileId: options.fileId,
            fileName: options.fileName,
            vespaDocId: options.vespaDocId,
            partIndex,
            startPage,
            endPage,
            totalPages,
            pageCount: endPage - startPage,
          },
          async () => {
            const partStartedAt = Date.now()
            Logger.info(
              {
                fileId: options.fileId,
                fileName: options.fileName,
                vespaDocId: options.vespaDocId,
                partIndex,
                startPage: startPage + 1,
                endPage,
                totalPages,
                pageCount: endPage - startPage,
              },
              "✅ PDF-lib stage_part starting",
            )
            const partDocument = await PDFDocument.create()
            const copiedPages = await partDocument.copyPages(
              options.source.document,
              pageIndexes,
            )
            for (const page of copiedPages) {
              partDocument.addPage(page)
            }

            const partBytes = await partDocument.save()
            Logger.info(
              {
                fileId: options.fileId,
                fileName: options.fileName,
                vespaDocId: options.vespaDocId,
                partIndex,
                startPage: startPage + 1,
                endPage,
                totalPages,
                pageCount: endPage - startPage,
                partSizeBytes: partBytes.length,
                elapsedMs: Date.now() - partStartedAt,
              },
              "✅ PDF-lib stage_part completed",
            )
            return Buffer.from(partBytes)
          },
        )

        await fsPromises.writeFile(tmpPartPath, partBuffer)
        await fsPromises.rename(tmpPartPath, partPath)

        const part: DoclingStagedPart = {
          partIndex,
          startPage,
          endPage,
          totalPages,
          partDocId: `${options.vespaDocId}__docling_part_${partIndex}`,
          partFileName: `${options.fileName}.pages-${startPage + 1}-${endPage}.pdf`,
          partPath,
          partSizeBytes: partBuffer.length,
        }
        parts.push(part)

        Logger.info(
          {
            fileId: options.fileId,
            fileName: options.fileName,
            vespaDocId: options.vespaDocId,
            partIndex,
            startPage: startPage + 1,
            endPage,
            totalPages,
            partPath,
            partSizeBytes: part.partSizeBytes,
          },
          "✅ Docling PDF staged part written",
        )

        partIndex += 1
      }

      const stagedParts: DoclingStagedParts = {
        fileId: options.fileId,
        vespaDocId: options.vespaDocId,
        sourcePath: options.sourcePath,
        sourceSize: sourceStats?.size ?? null,
        sourceMtimeMs: sourceStats?.mtimeMs ?? null,
        fileName: options.fileName,
        totalPages,
        pageChunkSize,
        partsTotal: parts.length,
        stageDir,
        partsDir,
        manifestPath,
        parts,
      }

      await writeJsonAtomically(manifestPath, {
        fileId: stagedParts.fileId,
        vespaDocId: stagedParts.vespaDocId,
        sourcePath: stagedParts.sourcePath,
        sourceSize: stagedParts.sourceSize,
        sourceMtimeMs: stagedParts.sourceMtimeMs,
        fileName: stagedParts.fileName,
        totalPages: stagedParts.totalPages,
        pageChunkSize: stagedParts.pageChunkSize,
        partsTotal: stagedParts.partsTotal,
        parts: stagedParts.parts.map((part) => ({
          partIndex: part.partIndex,
          startPage: part.startPage,
          endPage: part.endPage,
          totalPages: part.totalPages,
          partDocId: part.partDocId,
          partFileName: part.partFileName,
          partPath: path.relative(stageDir, part.partPath),
          partSizeBytes: part.partSizeBytes,
        })),
      })

      Logger.info(
        {
          fileId: options.fileId,
          fileName: options.fileName,
          vespaDocId: options.vespaDocId,
          totalPages,
          pageChunkSize,
          partsTotal: parts.length,
          stageDir,
        },
        "✅ Docling PDF part staging completed",
      )

      return stagedParts
    } catch (error) {
      Logger.error(
        {
          fileId: options.fileId,
          fileName: options.fileName,
          vespaDocId: options.vespaDocId,
          totalPages,
          pageChunkSize,
          stageDir,
          errorMessage: getErrorMessage(error),
          error,
        },
        "🔴 Docling PDF part staging failed",
      )
      if (!config.doclingKeepTempResults) {
        await fsPromises
          .rm(stageDir, { recursive: true, force: true })
          .catch((cleanupError) => {
            Logger.warn(
              {
                fileId: options.fileId,
                fileName: options.fileName,
                stageDir,
                cleanupError,
              },
              "Failed to cleanup incomplete staged Docling PDF parts",
            )
          })
      }
      throw error
    }
  }

  static async processStagedDoclingPart(
    part: DoclingStagedPart,
  ): Promise<DoclingPageChunkResult> {
    Logger.info(
      {
        partIndex: part.partIndex,
        startPage: part.startPage + 1,
        endPage: part.endPage,
        totalPages: part.totalPages,
        partPath: part.partPath,
        partSizeBytes: part.partSizeBytes,
      },
      "Reading staged Docling PDF part",
    )

    const partBuffer = await fsPromises.readFile(part.partPath)
    const preflight = calculateDoclingTimeoutMs(
      partBuffer.length,
      part.endPage - part.startPage,
    )
    const result = await this.processWithDocling(
      partBuffer,
      part.partFileName,
      part.partDocId,
      preflight,
    )

    return {
      result,
      partIndex: part.partIndex,
      startPage: part.startPage,
      endPage: part.endPage,
      totalPages: part.totalPages,
    }
  }

  static async readStagedPartBuffer(part: DoclingStagedPart): Promise<Buffer> {
    Logger.info(
      {
        partIndex: part.partIndex,
        startPage: part.startPage + 1,
        endPage: part.endPage,
        totalPages: part.totalPages,
        partPath: part.partPath,
        partSizeBytes: part.partSizeBytes,
      },
      "Reading staged Docling PDF part for submit",
    )
    return await fsPromises.readFile(part.partPath)
  }

  static async deleteStagedPart(part: DoclingStagedPart): Promise<void> {
    await this.deleteStagedPartPath(part.partPath)
  }

  static async deleteStagedPartPath(partPath?: string | null): Promise<void> {
    if (config.doclingKeepTempResults) {
      return
    }
    if (!partPath) {
      return
    }
    await fsPromises.rm(partPath, { force: true })
  }

  static async cleanupStagedDoclingParts(
    stagedParts: DoclingStagedParts | null | undefined,
  ): Promise<void> {
    await this.cleanupStagedDoclingDir(stagedParts?.stageDir, {
      fileId: stagedParts?.fileId,
      fileName: stagedParts?.fileName,
    })
  }

  static async cleanupStagedDoclingDir(
    stageDir?: string | null,
    context?: { fileId?: string; fileName?: string },
  ): Promise<void> {
    if (config.doclingKeepTempResults) {
      return
    }
    if (!stageDir) {
      return
    }
    try {
      await fsPromises.rm(stageDir, {
        recursive: true,
        force: true,
      })
    } catch (error) {
      Logger.warn(
        {
          fileId: context?.fileId,
          fileName: context?.fileName,
          stageDir,
          error,
        },
        "Failed to cleanup staged Docling PDF parts",
      )
    }
  }

  static async *splitIntoPageChunks(
    source: Buffer | LoadedPdfDocument,
    fileName: string,
    vespaDocId: string,
    pageChunkSize: number = config.doclingPageChunkSize,
    knownTotalPages?: number | null,
  ): AsyncGenerator<DoclingPageChunk> {
    if (!Number.isFinite(pageChunkSize) || pageChunkSize <= 0) {
      throw new Error("Docling page chunk size must be greater than zero")
    }

    const loadedDocument = Buffer.isBuffer(source)
      ? await this.loadDocument(source)
      : source

    if (!loadedDocument) {
      throw new Error("Failed to load PDF for Docling page chunk processing")
    }

    const sourceDocument = loadedDocument.document
    const totalPages =
      typeof knownTotalPages === "number" &&
      Number.isFinite(knownTotalPages) &&
      knownTotalPages > 0
        ? knownTotalPages
        : loadedDocument.pageCount

    if (totalPages > config.maxPdfPageCount) {
      throw new PdfPageCountExceededError(totalPages, config.maxPdfPageCount)
    }

    let partIndex = 0
    for (
      let startPage = 0;
      startPage < totalPages;
      startPage += pageChunkSize
    ) {
      const endPage = Math.min(startPage + pageChunkSize, totalPages)
      const pageIndexes = Array.from(
        { length: endPage - startPage },
        (_, index) => startPage + index,
      )

      const partBuffer = await withPdfWorkPermit(
        {
          operation: "split_part",
          fileName,
          vespaDocId,
          partIndex,
          startPage,
          endPage,
          totalPages,
          pageCount: endPage - startPage,
        },
        async () => {
          const partDocument = await PDFDocument.create()
          const copiedPages = await partDocument.copyPages(
            sourceDocument,
            pageIndexes,
          )
          for (const page of copiedPages) {
            partDocument.addPage(page)
          }

          const partBytes = await partDocument.save()
          return Buffer.from(partBytes)
        },
      )
      const partDocId = `${vespaDocId}__docling_part_${partIndex}`
      const partFileName = `${fileName}.pages-${startPage + 1}-${endPage}.pdf`

      Logger.info(
        {
          fileName,
          vespaDocId,
          partDocId,
          partIndex,
          startPage: startPage + 1,
          endPage,
          totalPages,
          partSizeBytes: partBuffer.length,
        },
        "Processing Docling PDF page chunk",
      )

      yield {
        buffer: partBuffer,
        partIndex,
        startPage,
        endPage,
        totalPages,
        partDocId,
        partFileName,
      }

      partIndex += 1
    }
  }

  static async *processWithDoclingPageChunks(
    source: Buffer | LoadedPdfDocument,
    fileName: string,
    vespaDocId: string,
    pageChunkSize: number = config.doclingPageChunkSize,
    knownTotalPages?: number | null,
  ): AsyncGenerator<DoclingPageChunkResult> {
    for await (const part of this.splitIntoPageChunks(
      source,
      fileName,
      vespaDocId,
      pageChunkSize,
      knownTotalPages,
    )) {
      const preflight = calculateDoclingTimeoutMs(
        part.buffer.length,
        part.endPage - part.startPage,
      )
      const result = await this.processWithDocling(
        part.buffer,
        part.partFileName,
        part.partDocId,
        preflight,
      )

      yield {
        result,
        partIndex: part.partIndex,
        startPage: part.startPage,
        endPage: part.endPage,
        totalPages: part.totalPages,
      }
    }
  }

  /**
   * Processes a PDF using the fallback logic:
   * 1. Try OCR first (if enabled via useOCR)
   *    - If DOCLING_ENABLED is true, use Docling
   *    - Otherwise, use Paddle OCR (if OCR_PROVIDERS configured)
   * 2. If OCR fails and PDF < 40 pages, try Gemini
   * 3. If all above fail or PDF >= 40 pages, use PDF.js
   * Set PDF_PROCESSING_DISABLE_FALLBACKS=true to fail ingestion on the first
   * selected processing strategy error instead of trying later strategies.
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
    if (pageCount !== null && pageCount > config.maxPdfPageCount) {
      throw new PdfPageCountExceededError(pageCount, config.maxPdfPageCount)
    }
    const disableFallbacks = config.pdfProcessingDisableFallbacks

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
        if (disableFallbacks) {
          Logger.error(
            `OCR PDF processing failed for ${fileName}; PDF processing fallbacks are disabled. error: ${JSON.stringify(error)}`,
          )
          throw error
        }
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
        if (disableFallbacks) {
          Logger.error(
            `Gemini PDF processing failed for ${fileName}; PDF processing fallbacks are disabled. error: ${JSON.stringify(error)}`,
          )
          throw error
        }
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
    return config.maxPdfPageCount
  }

  /**
   * Configuration for PDF processing
   */
  static getConfig() {
    return {
      geminiPageThreshold: PDF_GEMINI_PAGE_THRESHOLD,
      supportedMethods: ["ocr", "docling", "gemini", "pdfjs"] as const,
      defaultFallbackOrder: ["ocr", "gemini", "pdfjs"] as const,
      disableFallbacks: config.pdfProcessingDisableFallbacks,
    }
  }
}
