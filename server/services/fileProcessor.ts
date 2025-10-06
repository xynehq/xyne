import { getErrorMessage } from "@/utils"
import { chunkDocument } from "@/chunks"
// import { extractTextAndImagesWithChunksFromPDF } from "@/pdf

import { extractTextAndImagesWithChunksFromDocx } from "@/docxChunks"
import { extractTextAndImagesWithChunksFromPptx } from "@/pptChunks"
import { chunkByOCRFromBuffer } from "@/lib/chunkByOCR"
import { type ChunkMetadata } from "@/types"
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

export interface ProcessingResult {
  chunks: string[]
  chunks_pos: number[]
  image_chunks: string[]
  image_chunks_pos: number[]
  chunks_map: ChunkMetadata[]
  image_chunks_map: ChunkMetadata[]
}

export interface SheetProcessingResult extends ProcessingResult {
  sheetName: string
  sheetIndex: number
  totalSheets: number
  docId: string
}

export class FileProcessorService {

  static async processFile(
    buffer: Buffer,
    mimeType: string,
    fileName: string,
    vespaDocId: string,
    storagePath?: string,
    extractImages: boolean = false,
    describeImages: boolean = false,
  ): Promise<(ProcessingResult | SheetProcessingResult)[]> {
    const baseMimeType = getBaseMimeType(mimeType || "text/plain")
    let chunks: string[] = []
    let chunks_pos: number[] = []
    let image_chunks: string[] = []
    let image_chunks_pos: number[] = []

    try {
      if (baseMimeType === "application/pdf") {
        // Redirect PDF processing to OCR
        const result = await chunkByOCRFromBuffer(buffer, fileName, vespaDocId)
        return [result]
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
          // If text extraction fails, create a basic chunk with file info
          chunks = [
            `File: ${fileName}, Type: ${baseMimeType}, Size: ${buffer.length} bytes`,
          ]
          chunks_pos = [0]
        }
      }
    } catch (error) {
      // Log the processing failure with error details and context
      Logger.error(error, `File processing failed for ${fileName} (${baseMimeType}, ${buffer.length} bytes)`)
      
      // Re-throw the error to ensure proper error handling upstream
      // This allows callers to handle failures appropriately (retries, status updates, etc.)
      throw new Error(`Failed to process file "${fileName}": ${getErrorMessage(error)}`)
    }

    // For non-PDF files, create empty chunks_map and image_chunks_map for backward compatibility
    const chunks_map: ChunkMetadata[] = chunks.map((_, index) => ({
      chunk_index: index,
      page_number: -1, // Default to page -1 for non-PDF files
      block_labels: ["text"], // Default block label
    }));

    const image_chunks_map: ChunkMetadata[] = image_chunks.map((_, index) => ({
      chunk_index: index, // Local indexing for image chunks array
      page_number: -1, // Default to page -1 for non-PDF files
      block_labels: ["image"], // Default block label
    }));

    return [{
      chunks,
      chunks_pos,
      image_chunks,
      image_chunks_pos,
      chunks_map,
      image_chunks_map,
    }]
  }
}
