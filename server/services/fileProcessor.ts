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
  ): Promise<ProcessingResult> {
    const baseMimeType = getBaseMimeType(mimeType || "text/plain")
    let chunks: string[] = []
    let chunks_pos: number[] = []
    let image_chunks: string[] = []
    let image_chunks_pos: number[] = []

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
        const allChunks: string[] = []

        for (const sheetName of workbook.SheetNames) {
          const worksheet = workbook.Sheets[sheetName]
          if (!worksheet) continue

          const sheetData: string[][] = XLSX.utils.sheet_to_json(worksheet, {
            header: 1,
            defval: "",
            raw: false,
          })

          const validRows = sheetData.filter((row) =>
            row.some((cell) => cell && cell.toString().trim().length > 0),
          )

          for (const row of validRows) {
            const textualCells = row
              .filter(
                (cell) =>
                  cell &&
                  isNaN(Number(cell)) &&
                  cell.toString().trim().length > 0,
              )
              .map((cell) => cell.toString().trim())

            if (textualCells.length > 0) {
              allChunks.push(textualCells.join(" "))
            }
          }
        }

        chunks = allChunks
        chunks_pos = allChunks.map((_, idx) => idx)
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
      Logger.error(error, `File processing failed for ${fileName} (${baseMimeType}, ${buffer.length} bytes)`)
      
      // Re-throw the error to ensure proper error handling upstream
      throw new Error(`Failed to process file "${fileName}": ${getErrorMessage(error)}`)
    }

    // For non-PDF files, create empty chunks_map and image_chunks_map for backward compatibility
    const chunks_map: ChunkMetadata[] = chunks.map((_, index) => ({
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
