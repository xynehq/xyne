import { getErrorMessage } from "@/utils"
import { chunkDocument } from "@/chunks"
import { extractTextAndImagesWithChunksFromDocx } from "@/docxChunks"
import { extractTextAndImagesWithChunksFromPptx } from "@/pptChunks"
import { type ChunkMetadata } from "@/types"
import { 
  PdfProcessor, 
  type PdfProcessingMethod,
  type ProcessingResultDraft 
} from "@/lib/pdfProcessor"
import { chunkSheetWithHeaders } from "@/sheetChunk"
import * as XLSX from "xlsx"
import {
  getBaseMimeType,
  isTextFile,
  isSheetFile,
  isDocxFile,
  isPptxFile,
} from "@/integrations/dataSource/config"
import { getLogger, Subsystem } from "@/logger"

const Logger = getLogger(Subsystem.Ingest).child({
  module: "fileProcessor",
})

export { 
  type PdfProcessingMethod, 
  type ProcessingResultDraft 
} from "@/lib/pdfProcessor"



export interface ProcessingResult {
  chunks: string[]
  chunks_pos: number[]
  image_chunks: string[]
  image_chunks_pos: number[]
  chunks_map: ChunkMetadata[]
  image_chunks_map: ChunkMetadata[]
  processingMethod?: PdfProcessingMethod
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
    let text_chunks_map: ChunkMetadata[] | null = null

    try {
      if (baseMimeType === "application/pdf") {
        // Use the modular PDF processor with fallback logic
        // It returns a complete result, no need to finalize again
        const pdfResult = await PdfProcessor.processWithFallback(
          buffer,
          fileName,
          vespaDocId,
          extractImages,
          describeImages,
          useOCR,
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
        if (!storagePath) {
          workbook = XLSX.read(buffer, { type: "buffer" })
        } else {
          workbook = XLSX.readFile(storagePath)
        }

        if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
          throw new Error("No worksheets found in spreadsheet")
        }

        const sheetResults: SheetProcessingResult[] = []

        for (const [sheetIndex, sheetName] of workbook.SheetNames.entries()) {
          const worksheet = workbook.Sheets[sheetName]
          if (!worksheet) continue

          // Use the same header-preserving chunking function as dataSource integration
          const sheetChunks = chunkSheetWithHeaders(worksheet)
          
          const filteredChunks = sheetChunks.filter(
            (chunk) => chunk.trim().length > 0,
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
        text_chunks_map = processedChunks.map((v) => ({
          chunk_index: v.chunkIndex,
          page_numbers: [],
          block_labels: ["text"],
          char_offset_start: v.charOffsetStart,
          char_offset_end: v.charOffsetEnd,
        }))
      } else {
        // For unsupported types, try to extract text content
        try {
          const content = buffer.toString("utf-8")
          if (content.trim()) {
            const processedChunks = chunkDocument(content.trim())
            chunks = processedChunks.map((v) => v.chunk)
            chunks_pos = chunks.map((_, idx) => idx)
            text_chunks_map = processedChunks.map((v) => ({
              chunk_index: v.chunkIndex,
              page_numbers: [],
              block_labels: ["text"],
              char_offset_start: v.charOffsetStart,
              char_offset_end: v.charOffsetEnd,
            }))
          }
        } catch {
          chunks = [
            `File: ${fileName}, Type: ${baseMimeType}, Size: ${buffer.length} bytes`,
          ]
          chunks_pos = [0]
        }
      }
    } catch (error) {
      Logger.error(error, `File processing failed for ${fileName} (${baseMimeType}, ${buffer.length} bytes)`)
      
      // Re-throw the error to ensure proper error handling upstream
      throw new Error(`Failed to process file "${fileName}": ${getErrorMessage(error)}`)
    }

    // Use text_chunks_map if available (has char offsets), otherwise create default chunks_map
    const chunks_map: ChunkMetadata[] = text_chunks_map ?? chunks.map((_, index) => ({
      chunk_index: index,
      page_numbers: [],
      block_labels: ["text"],
    }));

    const image_chunks_map: ChunkMetadata[] = image_chunks.map((_, index) => ({
      chunk_index: index, 
      page_numbers: [], 
      block_labels: ["image"], 
    }));

    // Wrap in array to match return type
    return [{
      chunks,
      chunks_pos,
      image_chunks,
      image_chunks_pos,
      chunks_map: chunks_map,
      image_chunks_map: image_chunks_map,
    }]
  }
}
