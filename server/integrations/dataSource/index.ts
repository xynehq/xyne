import { Apps } from "@xyne/vespa-ts/types"
import { chunkDocument } from "@/chunks"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { insertDataSourceFile } from "@/search/vespa"
import {
  type VespaDataSourceFile,
  datasourceSchema,
} from "@xyne/vespa-ts/types"
import { createId } from "@paralleldrive/cuid2"
import path from "path"
import * as XLSX from "xlsx"
import {
  DATASOURCE_CONFIG,
  getBaseMimeType,
  isTextFile,
  isSheetFile,
  isImageFile,
  isDocxFile,
  isPptxFile,
  getSupportedFileTypes,
} from "./config"
import {
  FileProcessingError,
  ContentExtractionError,
  StorageError,
  createFileValidationError,
  createFileSizeError,
  createUnsupportedTypeError,
  handleDataSourceError,
  isDataSourceError,
} from "./errors"
import { describeImageWithllm } from "@/lib/describeImageWithllm"
import { promises as fsPromises } from "fs"
import { PdfProcessor } from "@/lib/pdfProcessor"
import { extractTextAndImagesWithChunksFromDocx } from "@/docxChunks"
import { extractTextAndImagesWithChunksFromPptx } from "@/pptChunks"
import imageType from "image-type"
import { NAMESPACE } from "@/config"
import { chunkSheetWithHeaders } from "@/sheetChunk"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "dataSourceIntegration",
})

// Types for better type safety
interface FileProcessingResult {
  success: boolean
  message: string
  docId: string
  fileName: string
}

interface FileMetadata {
  originalFileName: string
  uploadedBy: string
  chunksCount: number
  processingMethod: string
}

interface ProcessingOptions {
  fileName: string
  userEmail: string
  fileSize: number
  dataSourceUserSpecificId: string
  mimeType: string
  description?: string
}

const validateFile = (file: File): void => {
  if (
    !file?.name ||
    typeof file.size !== "number" ||
    typeof file.arrayBuffer !== "function"
  ) {
    throw createFileValidationError(file)
  }

  if (file.size === 0) {
    throw createFileValidationError(file)
  }

  // Extract base MIME type (remove parameters like charset)
  const rawMimeType = file.type || "text/plain"
  const baseMimeType = getBaseMimeType(rawMimeType)

  const supportedTypes = getSupportedFileTypes()

  if (!supportedTypes.includes(baseMimeType)) {
    throw createUnsupportedTypeError(baseMimeType, supportedTypes)
  }
}

export const checkFileSize = (size: number, maxFileSizeMB: number): void => {
  const fileSizeMB = size / (1024 * 1024)
  if (fileSizeMB > maxFileSizeMB) {
    throw createFileSizeError(size, maxFileSizeMB)
  }
}

export const createFileMetadata = (
  fileName: string,
  userEmail: string,
  chunksCount: number,
  processingMethod: string,
): string => {
  const metadata: FileMetadata = {
    originalFileName: fileName,
    uploadedBy: userEmail,
    chunksCount,
    processingMethod,
  }
  return JSON.stringify(metadata)
}

// Core processing functions
const createVespaDataSourceFile = (
  text_chunks: string[],
  options: ProcessingOptions,
  processingMethod: string,
  image_chunks?: string[],
  text_chunk_pos?: number[],
  image_chunk_pos?: number[],
  docId?: string,
): VespaDataSourceFile => {
  const now = Date.now()

  return {
    docId: docId || `dsf-${createId()}`,
    description:
      options.description || `File: ${options.fileName} for DataSource`,
    app: Apps.DataSource,
    fileName: options.fileName,
    fileSize: options.fileSize,
    chunks: text_chunks,
    image_chunks: image_chunks || [],
    chunks_pos: text_chunk_pos || [],
    image_chunks_pos: image_chunk_pos || [],
    uploadedBy: options.userEmail,
    mimeType: options.mimeType,
    createdAt: now,
    updatedAt: now,
    dataSourceRef: `id:${NAMESPACE}:${datasourceSchema}::${options.dataSourceUserSpecificId}`,
    metadata: createFileMetadata(
      options.fileName,
      options.userEmail,
      text_chunks.length,
      processingMethod,
    ),
  }
}

const processTextContent = async (
  content: string,
  options: ProcessingOptions,
): Promise<VespaDataSourceFile> => {
  const trimmedContent = content.trim()

  try {
    const chunks = chunkDocument(trimmedContent).map((v) => v.chunk)
    if (chunks.length === 0) {
      throw new ContentExtractionError(
        "No chunks generated from content",
        "text",
      )
    }

    return createVespaDataSourceFile(chunks, options, "text_processing")
  } catch (error) {
    throw new ContentExtractionError(
      error instanceof Error ? error.message : String(error),
      "text",
    )
  }
}

const processImageContent = async (
  imageBuffer: Buffer,
  options: ProcessingOptions,
): Promise<VespaDataSourceFile> => {
  try {
    const image_chunk: string = await describeImageWithllm(
      imageBuffer,
      "provide only a concise and detailed description of the image",
    )
    return createVespaDataSourceFile(
      [],
      options,
      "image_processing",
      [image_chunk],
      [],
      [0],
    )
  } catch (error) {
    if (isDataSourceError(error)) {
      throw error
    }
    throw new ContentExtractionError(
      error instanceof Error ? error.message : String(error),
      "image",
    )
  }
}

const processPdfContent = async (
  pdfBuffer: Uint8Array,
  options: ProcessingOptions,
): Promise<VespaDataSourceFile> => {
  try {
    const docId = `dsf-${createId()}`
    const result = await PdfProcessor.processWithFallback(
      Buffer.from(pdfBuffer),
      options.fileName,
      docId,
      true,
      true,
    )
    
    if (result.chunks.length === 0 && result.image_chunks.length === 0) {
      throw new ContentExtractionError(
        "No chunks generated from PDF content",
        "PDF",
      )
    }

    return createVespaDataSourceFile(
      result.chunks,
      options,
      result.processingMethod || "pdf_processing",
      result.image_chunks,
      result.chunks_pos,
      result.image_chunks_pos,
      docId,
    )
  } catch (error) {
    if (isDataSourceError(error)) {
      throw error
    }
    throw new ContentExtractionError(
      error instanceof Error ? error.message : String(error),
      "PDF",
    )
  }
}

const processDocxContent = async (
  docxBuffer: Uint8Array,
  options: ProcessingOptions,
): Promise<VespaDataSourceFile> => {
  try {
    Logger.info(`Processing DOCX file: ${options.fileName}`)

    const docId = `dsf-${createId()}`
    const docxResult = await extractTextAndImagesWithChunksFromDocx(
      docxBuffer,
      docId,
      true,
    )

    if (
      docxResult.text_chunks.length === 0 &&
      docxResult.image_chunks.length === 0
    ) {
      throw new ContentExtractionError(
        "No extractable content found in DOCX file",
        "DOCX",
      )
    }

    Logger.info(
      `DOCX processing completed: ${docxResult.text_chunks.length} text chunks, ${docxResult.image_chunks.length} image chunks`,
    )

    return createVespaDataSourceFile(
      docxResult.text_chunks,
      options,
      "docx_processing",
      docxResult.image_chunks,
      docxResult.text_chunk_pos,
      docxResult.image_chunk_pos,
      docId,
    )
  } catch (error) {
    if (isDataSourceError(error)) {
      throw error
    }
    throw new ContentExtractionError(
      error instanceof Error ? error.message : String(error),
      "DOCX",
    )
  }
}

const processPptxContent = async (
  pptxBuffer: Uint8Array,
  options: ProcessingOptions,
): Promise<VespaDataSourceFile> => {
  try {
    Logger.info(`Processing PPTX file: ${options.fileName}`)

    const docId = `dsf-${createId()}`
    const pptxResult = await extractTextAndImagesWithChunksFromPptx(
      pptxBuffer,
      docId,
      true,
    )

    if (
      pptxResult.text_chunks.length === 0 &&
      pptxResult.image_chunks.length === 0
    ) {
      throw new ContentExtractionError(
        "No extractable content found in PPTX file",
        "PPTX",
      )
    }

    Logger.info(
      `PPTX processing completed: ${pptxResult.text_chunks.length} text chunks, ${pptxResult.image_chunks.length} image chunks`,
    )

    return createVespaDataSourceFile(
      pptxResult.text_chunks,
      options,
      "pptx_processing",
      pptxResult.image_chunks,
      pptxResult.text_chunk_pos,
      pptxResult.image_chunk_pos,
      docId,
    )
  } catch (error) {
    if (isDataSourceError(error)) {
      throw error
    }
    throw new ContentExtractionError(
      error instanceof Error ? error.message : String(error),
      "PPTX",
    )
  }
}

const processSheetContent = async (
  sheetBuffer: Buffer,
  options: ProcessingOptions,
): Promise<VespaDataSourceFile[]> => {
  try {
    const sheetDocuments = await processSpreadsheetFile(sheetBuffer, options)
    if (sheetDocuments.length === 0) {
      throw new ContentExtractionError(
        "No valid content found in spreadsheet",
        "spreadsheet",
      )
    }

    return sheetDocuments
  } catch (error) {
    if (isDataSourceError(error)) {
      throw error
    }
    throw new ContentExtractionError(
      error instanceof Error ? error.message : String(error),
      "spreadsheet",
    )
  }
}

// Spreadsheet processing functions (XLSX, CSV)
const processSpreadsheetFile = async (
  buffer: Buffer,
  options: ProcessingOptions,
): Promise<VespaDataSourceFile[]> => {
  try {
    const workbook = XLSX.read(buffer, { type: "buffer" })
    const sheetDocuments: VespaDataSourceFile[] = []

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      throw new ContentExtractionError("No worksheets found", "Spreadsheet")
    }

    for (const [sheetIndex, sheetName] of workbook.SheetNames.entries()) {
      const worksheet = workbook.Sheets[sheetName]
      if (!worksheet) continue

      // Use the new header-preserving chunking function
      const sheetChunks = chunkSheetWithHeaders(worksheet)

      const filteredChunks = sheetChunks.filter(
        (chunk) => chunk.trim().length > 0,
      )

      // Skip sheets with no valid content
      if (filteredChunks.length === 0) continue

      // Create a separate document for each worksheet (like Google Sheets)
      const sheetDocId = `dsf-${createId()}_${sheetIndex}`
      const sheetFileName =
        workbook.SheetNames.length > 1
          ? `${options.fileName} / ${sheetName}`
          : options.fileName

      const sheetMetadata = {
        originalFileName: options.fileName,
        sheetName,
        sheetIndex,
        totalSheets: workbook.SheetNames.length,
        uploadedBy: options.userEmail,
        chunksCount: filteredChunks.length,
        processingMethod: "sheet_processing",
      }

      const sheetDocument = createVespaDataSourceFile(
        filteredChunks,
        {
          ...options,
          fileName: sheetFileName,
        },
        "sheet_processing",
        undefined, // image_chunks
        undefined, // text_chunk_pos
        undefined, // image_chunk_pos
        sheetDocId,
      )

      // Override metadata to include sheet-specific information
      sheetDocument.metadata = JSON.stringify(sheetMetadata)

      sheetDocuments.push(sheetDocument)
    }

    if (sheetDocuments.length === 0) {
      throw new ContentExtractionError(
        "No valid content found in any worksheet",
        "Spreadsheet",
      )
    }

    return sheetDocuments
  } catch (error) {
    if (isDataSourceError(error)) {
      throw error
    }
    const { name, message } = error as Error
    if (
      message.includes("PasswordException") ||
      name.includes("PasswordException")
    ) {
      Logger.warn("Password protected Spreadsheet, skipping")
    } else {
      Logger.error(error, `Spreadsheet load error: ${error}`)
    }
    throw new ContentExtractionError(
      error instanceof Error ? error.message : String(error),
      "Spreadsheet",
    )
  }
}

// Main export function
export const handleDataSourceFileUpload = async (
  file: File,
  userEmail: string,
  dataSourceUserSpecificId: string,
  description?: string,
): Promise<FileProcessingResult> => {
  try {
    validateFile(file)

    // Extract base MIME type (remove parameters like charset)
    const rawMimeType = file.type || "text/plain"
    const mimeType = getBaseMimeType(rawMimeType)

    const options: ProcessingOptions = {
      fileName: file.name,
      userEmail,
      fileSize: file.size,
      dataSourceUserSpecificId,
      mimeType,
      description,
    }

    let processedFiles: VespaDataSourceFile[] = []
    if (isImageFile(mimeType)) {
      if (!process.env.LLM_API_ENDPOINT) {
        throw new FileProcessingError(
          `LLM API endpoint is not set. Skipping image: ${options.fileName}`,
        )
      }
      checkFileSize(file.size, DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB)
      const imageBuffer = Buffer.from(await file.arrayBuffer())
      const type = await imageType(new Uint8Array(imageBuffer))
      if (!type || !DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES.has(type.mime)) {
        throw new FileProcessingError(
          `Unsupported or unknown image MIME type: ${type?.mime}. Skipping image: ${options.fileName}`,
        )
      }
      const processedFile = await processImageContent(imageBuffer, options)
      processedFiles = [processedFile]

      try {
        const baseDir = path.resolve(
          process.env.IMAGE_DIR || "downloads/xyne_images_db",
        )
        const outputDir = path.join(baseDir, processedFile.docId)
        await fsPromises.mkdir(outputDir, { recursive: true })

        const imageFilename = `${0}.${type.ext || "png"}`
        const imagePath = path.join(outputDir, imageFilename)

        await fsPromises.writeFile(
          imagePath,
          imageBuffer as NodeJS.ArrayBufferView,
        )
        Logger.info(`Saved image to: ${imagePath}`)
      } catch (saveError) {
        Logger.error(
          `Failed to save image for ${options.fileName}: ${saveError instanceof Error ? saveError.message : saveError}`,
        )
        // Continue processing even if saving fails
      }
    } else {
      // Process based on file type
      if (mimeType === "application/pdf") {
        checkFileSize(file.size, DATASOURCE_CONFIG.MAX_PDF_FILE_SIZE_MB)
        const fileBuffer = new Uint8Array(await file.arrayBuffer())
        const processedFile = await processPdfContent(fileBuffer, options)
        processedFiles = [processedFile]
      } else if (isDocxFile(mimeType)) {
        checkFileSize(file.size, DATASOURCE_CONFIG.MAX_DOCX_FILE_SIZE_MB)
        const fileBuffer = new Uint8Array(await file.arrayBuffer())
        const processedFile = await processDocxContent(fileBuffer, options)
        processedFiles = [processedFile]
      } else if (isPptxFile(mimeType)) {
        checkFileSize(file.size, DATASOURCE_CONFIG.MAX_PPTX_FILE_SIZE_MB)
        const fileBuffer = new Uint8Array(await file.arrayBuffer())
        const processedFile = await processPptxContent(fileBuffer, options)
        processedFiles = [processedFile]
      } else if (isSheetFile(mimeType)) {
        checkFileSize(file.size, DATASOURCE_CONFIG.MAX_SPREADSHEET_FILE_SIZE_MB)
        const fileBuffer = Buffer.from(await file.arrayBuffer())
        processedFiles = await processSheetContent(fileBuffer, options)
      } else if (isTextFile(mimeType)) {
        checkFileSize(file.size, DATASOURCE_CONFIG.MAX_TEXT_FILE_SIZE_MB)
        const content = await file.text()
        const processedFile = await processTextContent(content, options)
        processedFiles = [processedFile]
      } else {
        throw createUnsupportedTypeError(mimeType, getSupportedFileTypes())
      }
    }

    // Insert all processed files into Vespa
    const insertedDocIds: string[] = []
    try {
      for (const processedFile of processedFiles) {
        await insertDataSourceFile(processedFile)
        insertedDocIds.push(processedFile.docId)
      }
    } catch (error) {
      throw new StorageError(
        `Failed to store file in database: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const primaryDocId = processedFiles[0]?.docId || "unknown"
    const total = processedFiles.length

    Logger.info(
      {
        fileName: file.name,
        docIds: insertedDocIds,
        totalDocuments: total,
        userEmail,
        mimeType,
        rawMimeType,
      },
      `DataSource file processed successfully (${total} document(s))`,
    )

    return {
      success: true,
      message: `DataSource file processed and stored successfully (${total} document(s))`,
      docId: primaryDocId,
      fileName: file.name,
    }
  } catch (error) {
    const dsError = handleDataSourceError(error, file.name)
    Logger.error(
      {
        error: dsError,
        fileName: file.name,
        userEmail,
        errorCode: dsError.code,
        userMessage: dsError.userMessage,
      },
      `Error processing DataSource file "${file.name}"`,
    )
    throw dsError
  }
}
