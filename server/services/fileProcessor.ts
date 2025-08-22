import { getErrorMessage } from "@/utils"
import { chunkDocument } from "@/chunks"
import { extractTextAndImagesWithChunksFromPDF } from "@/pdfChunks"
import { extractTextAndImagesWithChunksFromDocx } from "@/docxChunks"
import { extractTextAndImagesWithChunksFromPptx } from "@/pptChunks"
import * as XLSX from "xlsx"
import {
  getBaseMimeType,
  isTextFile,
  isSheetFile,
  isDocxFile,
  isPptxFile,
} from "@/integrations/dataSource/config"

export interface ProcessingResult {
  chunks: string[]
  chunks_pos: number[]
  image_chunks: string[]
  image_chunks_pos: number[]
}

export class FileProcessorService {
  static async processFile(
    buffer: Buffer, 
    mimeType: string, 
    fileName: string,
    vespaDocId: string,
    storagePath?: string
  ): Promise<ProcessingResult> {
    const baseMimeType = getBaseMimeType(mimeType || "text/plain")
    let chunks: string[] = []
    let chunks_pos: number[] = []
    let image_chunks: string[] = []
    let image_chunks_pos: number[] = []

    try {
      if (baseMimeType === "application/pdf") {
        // Process PDF
        const result = await extractTextAndImagesWithChunksFromPDF(
          new Uint8Array(buffer),
          vespaDocId,
          false,
        )
        chunks = result.text_chunks
        chunks_pos = result.text_chunk_pos
        image_chunks = result.image_chunks || []
        image_chunks_pos = result.image_chunk_pos || []
      } else if (isDocxFile(baseMimeType)) {
        // Process DOCX
        const result = await extractTextAndImagesWithChunksFromDocx(
          new Uint8Array(buffer),
          vespaDocId,
          false,
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
          false,
        )
        chunks = result.text_chunks
        chunks_pos = result.text_chunk_pos
        image_chunks = result.image_chunks || []
        image_chunks_pos = result.image_chunk_pos || []
      } else if (isSheetFile(baseMimeType)) {
        // Process spreadsheet
        if (!storagePath) {
          throw new Error("Storage path required for spreadsheet processing")
        }
        const workbook = XLSX.readFile(storagePath)
        const allChunks: string[] = []

        for (const sheetName of workbook.SheetNames) {
          const worksheet = workbook.Sheets[sheetName]
          if (!worksheet) continue

          const sheetData: string[][] = XLSX.utils.sheet_to_json(
            worksheet,
            {
              header: 1,
              defval: "",
              raw: false,
            },
          )

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
        const content = buffer.toString('utf-8')
        const processedChunks = chunkDocument(content.trim())
        chunks = processedChunks.map((v) => v.chunk)
        chunks_pos = chunks.map((_, idx) => idx)
      } else {
        // For unsupported types, try to extract text content
        try {
          const content = buffer.toString('utf-8')
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
      console.warn(
        `Failed to process file content for ${fileName}: ${getErrorMessage(error)}`,
      )
      // Create basic chunk on processing error
      chunks = [
        `File: ${fileName}, Type: ${baseMimeType}, Size: ${buffer.length} bytes`,
      ]
      chunks_pos = [0]
    }

    return {
      chunks,
      chunks_pos,
      image_chunks,
      image_chunks_pos,
    }
  }
}
