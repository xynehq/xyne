import { chunkDocument } from "@/chunks"
import { extractTextAndImagesWithChunksFromDocx } from "@/docxChunks"
import {
  getBaseMimeType,
  isDocxFile,
  isPptxFile,
  isSheetFile,
  isTextFile,
} from "@/integrations/dataSource/config"
import { type PdfProcessingMethod, PdfProcessor } from "@/lib/pdfProcessor"
import { Subsystem, getLogger } from "@/logger"
import { extractTextAndImagesWithChunksFromPptx } from "@/pptChunks"
import { chunkSheetWithHeaders } from "@/sheetChunk"
import { type ChunkMetadata } from "@/types"
import { getErrorMessage } from "@/utils"
import * as XLSX from "xlsx"

const Logger = getLogger(Subsystem.Ingest).child({
  module: "fileProcessor",
})

export {
  type PdfProcessingMethod,
  type ProcessingResultDraft,
} from "@/lib/pdfProcessor"

export interface ProcessingResult {
  chunks: string[]
  chunks_pos: number[]
  image_chunks: string[]
  image_chunks_pos: number[]
  chunks_map: ChunkMetadata[]
  image_chunks_map: ChunkMetadata[]
  toc_chunks?: string[]
  processingMethod?: PdfProcessingMethod
  documentOutline?: string
}

export interface SheetProcessingResult extends ProcessingResult {
  sheetName: string
  sheetIndex: number
  totalSheets: number
  docId: string
}

type ProcessingResultArray = (ProcessingResult | SheetProcessingResult)[]

export class FileProcessorService {
  static async processFile(
    buffer: Buffer,
    mimeType: string,
    fileName: string,
    vespaDocId: string,
    storagePath?: string,
    extractImages: boolean = false,
    describeImages: boolean = false,
    useOCR: boolean = true,
  ): Promise<ProcessingResultArray> {
    const baseMimeType = getBaseMimeType(mimeType || "text/plain")
    let chunks: string[] = []
    let chunks_pos: number[] = []
    let image_chunks: string[] = []
    let image_chunks_pos: number[] = []

    try {
      Logger.info(
        {
          fileName,
          mimeType,
          baseMimeType,
          bufferSize: buffer.length,
          storagePath,
          extractImages,
          describeImages,
          useOCR,
        },
        "FileProcessorService stage: dispatching file processor",
      )

      if (baseMimeType === "application/pdf") {
        // Use the modular PDF processor with fallback logic
        // It returns a complete result, no need to finalize again
        const pdfStart = Date.now()
        Logger.info(
          {
            fileName,
            vespaDocId,
            bufferSize: buffer.length,
            useOCR,
          },
          "FileProcessorService stage: starting PDF processor",
        )
        const pdfResult = await PdfProcessor.processWithFallback(
          buffer,
          fileName,
          vespaDocId,
          extractImages,
          describeImages,
          useOCR,
        )
        Logger.info(
          {
            fileName,
            vespaDocId,
            method: pdfResult.processingMethod,
            chunks: pdfResult.chunks.length,
            imageChunks: pdfResult.image_chunks.length,
            durationMs: Date.now() - pdfStart,
          },
          "FileProcessorService stage: PDF processor complete",
        )
        // Wrap in array to match return type
        return [pdfResult]
      } else if (isDocxFile(baseMimeType)) {
        // Process DOCX
        const result = await extractTextAndImagesWithChunksFromDocx(
          new Uint8Array(buffer),
          vespaDocId,
          extractImages,
          describeImages,
        )
        chunks = result.text_chunks
        chunks_pos = result.text_chunk_pos
        image_chunks = result.image_chunks || []
        image_chunks_pos = result.image_chunk_pos || []
      } else if (isPptxFile(baseMimeType)) {
        // Process PPTX
        const result = await extractTextAndImagesWithChunksFromPptx(
          new Uint8Array(buffer),
          vespaDocId,
          extractImages,
          describeImages,
        )
        chunks = result.text_chunks
        chunks_pos = result.text_chunk_pos
        image_chunks = result.image_chunks || []
        image_chunks_pos = result.image_chunk_pos || []
      } else if (isSheetFile(baseMimeType)) {
        // Process spreadsheet
        let workbook: XLSX.WorkBook
        const sheetStart = Date.now()
        Logger.info(
          {
            fileName,
            storagePath,
            bufferSize: buffer.length,
          },
          "FileProcessorService stage: loading spreadsheet workbook",
        )
        if (!storagePath) {
          workbook = XLSX.read(buffer, { type: "buffer" })
        } else {
          workbook = XLSX.readFile(storagePath)
        }
        Logger.info(
          {
            fileName,
            sheetCount: workbook.SheetNames?.length || 0,
            durationMs: Date.now() - sheetStart,
          },
          "FileProcessorService stage: spreadsheet workbook loaded",
        )

        if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
          throw new Error("No worksheets found in spreadsheet")
        }

        const sheetResults: SheetProcessingResult[] = []

        for (const [sheetIndex, sheetName] of workbook.SheetNames.entries()) {
          const worksheet = workbook.Sheets[sheetName]
          if (!worksheet) continue

          // Use the same header-preserving chunking function as dataSource integration
          const chunkStart = Date.now()
          Logger.info(
            {
              fileName,
              sheetName,
              sheetIndex,
            },
            "FileProcessorService stage: chunking spreadsheet sheet",
          )
          const sheetChunks = chunkSheetWithHeaders(worksheet)

          const filteredChunks = sheetChunks.filter(
            (chunk) => chunk.trim().length > 0,
          )
          Logger.info(
            {
              fileName,
              sheetName,
              sheetIndex,
              rawChunks: sheetChunks.length,
              filteredChunks: filteredChunks.length,
              durationMs: Date.now() - chunkStart,
            },
            "FileProcessorService stage: spreadsheet sheet chunked",
          )

          // Skip sheets with no valid content
          if (filteredChunks.length === 0) continue

          // Generate a unique docId for each sheet
          const sheetDocId = `${vespaDocId}_sheet_${sheetIndex}`

          const sheetResult: SheetProcessingResult = {
            chunks: filteredChunks,
            chunks_pos: filteredChunks.map((_, idx) => idx),
            image_chunks: [],
            image_chunks_pos: [],
            chunks_map: [],
            image_chunks_map: [],
            sheetName,
            sheetIndex,
            totalSheets: workbook.SheetNames.length,
            docId: sheetDocId,
          }

          sheetResults.push(sheetResult)
        }

        if (sheetResults.length === 0) {
          throw new Error("No valid content found in any worksheet")
        }

        return sheetResults
      } else if (isTextFile(baseMimeType)) {
        // Process text file
        const content = buffer.toString("utf-8")
        const processedChunks = chunkDocument(content.trim())
        chunks = processedChunks.map((v) => v.chunk)
        chunks_pos = chunks.map((_, idx) => idx)
      } else {
        // For unsupported types, try to extract text content
        try {
          const content = buffer.toString("utf-8")
          if (content.trim()) {
            const processedChunks = chunkDocument(content.trim())
            chunks = processedChunks.map((v) => v.chunk)
            chunks_pos = chunks.map((_, idx) => idx)
          }
        } catch {
          chunks = [
            `File: ${fileName}, Type: ${baseMimeType}, Size: ${buffer.length} bytes`,
          ]
          chunks_pos = [0]
        }
      }
    } catch (error) {
      Logger.error(
        error,
        `File processing failed for ${fileName} (${baseMimeType}, ${buffer.length} bytes)`,
      )

      // Re-throw the error to ensure proper error handling upstream
      throw new Error(
        `Failed to process file "${fileName}": ${getErrorMessage(error)}`,
      )
    }

    // For non-PDF files, create empty chunks_map and image_chunks_map for backward compatibility
    const chunks_map: ChunkMetadata[] = chunks.map((_, index) => ({
      chunk_index: index,
      page_numbers: [],
      block_labels: ["text"],
    }))

    const image_chunks_map: ChunkMetadata[] = image_chunks.map((_, index) => ({
      chunk_index: index,
      page_numbers: [],
      block_labels: ["image"],
    }))

    // Wrap in array to match return type
    return [
      {
        chunks,
        chunks_pos,
        image_chunks,
        image_chunks_pos,
        toc_chunks: [],
        chunks_map: chunks_map,
        image_chunks_map: image_chunks_map,
      },
    ]
  }
}
