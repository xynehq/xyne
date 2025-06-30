import { Apps } from "@/search/types"
import { chunkDocument } from "@/chunks"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { insertDataSourceFile, NAMESPACE } from "@/search/vespa"
import { type VespaDataSourceFile, datasourceSchema } from "@/search/types"
import { createId } from "@paralleldrive/cuid2"
import fs from "fs"
import { readFile, writeFile, rename, access, unlink } from "fs/promises"
import path from "path"
import { v4 as uuidv4 } from "uuid"
import { spawn } from "child_process"
import * as XLSX from "xlsx"
import os from "os"
import {
  DATASOURCE_CONFIG,
  MAX_DATASOURCE_FILE_SIZE,
  getBaseMimeType,
  isTextFile,
  isSheetFile,
  isOfficeFile,
  isImageFile,
  requiresConversion,
  getSupportedFileTypes,
} from "./config"
import {
  FileValidationError,
  FileSizeExceededError,
  UnsupportedFileTypeError,
  FileConversionError,
  FileProcessingError,
  ContentExtractionError,
  InsufficientContentError,
  ExternalToolError,
  TimeoutError,
  StorageError,
  createFileValidationError,
  createFileSizeError,
  createUnsupportedTypeError,
  handleDataSourceError,
  isDataSourceError,
} from "./errors"
import type { Document } from "@langchain/core/documents"
import { safeLoadPDF, deleteDocument } from "@/integrations/google/index.ts"
import { extractTextAndImagesWithChunks } from "@/pdfChunks"
import {
  describeImageWithllm,
  withTempDirectory,
} from "@/lib/describeImageWithllm"
import { promises as fsPromises } from "fs"

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
  convertedFrom?: string
}

interface ProcessingOptions {
  fileName: string
  userEmail: string
  fileSize: number
  dataSourceUserSpecificId: string
  mimeType: string
  description?: string
}

// Utility functions
const getLibreOfficePath = (): string => {
  const platform =
    os.platform() as keyof typeof DATASOURCE_CONFIG.LIBREOFFICE_PATHS
  return (
    process.env.LIBREOFFICE_PATH ||
    DATASOURCE_CONFIG.LIBREOFFICE_PATHS[platform] ||
    "soffice"
  )
}

const ensureTempDir = async (): Promise<void> => {
  try {
    if (!fs.existsSync(DATASOURCE_CONFIG.TEMP_DIR)) {
      fs.mkdirSync(DATASOURCE_CONFIG.TEMP_DIR, { recursive: true })
    }
  } catch (error) {
    throw new FileProcessingError(
      `Failed to create temporary directory: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const cleanupFiles = async (filePaths: string[]): Promise<void> => {
  const results = await Promise.allSettled(
    filePaths.map(async (filePath) => {
      try {
        if (fs.existsSync(filePath)) {
          await unlink(filePath)
          Logger.debug(`Cleaned up temp file: ${filePath}`)
        }
      } catch (error) {
        Logger.warn(error, `Failed to cleanup file: ${filePath}`)
        throw error
      }
    }),
  )

  const failures = results.filter((result) => result.status === "rejected")
  if (failures.length > 0) {
    Logger.warn(`Failed to cleanup ${failures.length} temporary files`)
  }
}

const validateFile = (file: File): void => {
  if (
    !file?.name ||
    typeof file.size !== "number" ||
    typeof file.arrayBuffer !== "function"
  ) {
    throw createFileValidationError(file)
  }

  if (file.name.length > DATASOURCE_CONFIG.MAX_FILENAME_LENGTH) {
    throw new FileValidationError(
      `Filename exceeds maximum allowed length of ${DATASOURCE_CONFIG.MAX_FILENAME_LENGTH} characters.`,
    )
  }

  if (file.size > MAX_DATASOURCE_FILE_SIZE) {
    throw createFileSizeError(file, DATASOURCE_CONFIG.MAX_FILE_SIZE_MB)
  }

  if (file.size === 0) {
    throw new FileValidationError("Empty files are not allowed.")
  }

  // Extract base MIME type (remove parameters like charset)
  const rawMimeType = file.type || "text/plain"
  const baseMimeType = getBaseMimeType(rawMimeType)

  const supportedTypes = getSupportedFileTypes()

  if (!supportedTypes.includes(baseMimeType)) {
    throw createUnsupportedTypeError(baseMimeType, supportedTypes)
  }
}

const createFileMetadata = (
  fileName: string,
  userEmail: string,
  chunksCount: number,
  processingMethod: string,
  convertedFrom?: string,
): string => {
  const metadata: FileMetadata = {
    originalFileName: fileName,
    uploadedBy: userEmail,
    chunksCount,
    processingMethod,
    ...(convertedFrom && { convertedFrom }),
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
  convertedFrom?: string,
): VespaDataSourceFile => {
  const now = Date.now()
  const fileId = `dsf-${createId()}`

  return {
    docId: fileId,
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
      convertedFrom,
    ),
  }
}

const processTextContent = async (
  content: string,
  options: ProcessingOptions,
): Promise<VespaDataSourceFile> => {
  const trimmedContent = content.trim()

  if (
    !trimmedContent ||
    trimmedContent.length < DATASOURCE_CONFIG.MIN_CONTENT_LENGTH
  ) {
    throw new InsufficientContentError(
      DATASOURCE_CONFIG.MIN_CONTENT_LENGTH,
      trimmedContent.length,
    )
  }

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
  convertedFrom?: string,
): Promise<VespaDataSourceFile> => {
  try {
    return withTempDirectory(
      async (tempDir: string): Promise<VespaDataSourceFile> => {
        const image_chunk: string = await describeImageWithllm(
          imageBuffer,
          tempDir,
          "provide only a concise and detailed description of the image",
        )
        return createVespaDataSourceFile(
          [],
          options,
          convertedFrom ? "image_conversion" : "image_processing",
          [image_chunk],
          [],
          [0],
          convertedFrom,
        )
      },
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
  filePath: string,
  options: ProcessingOptions,
  convertedFrom?: string,
): Promise<VespaDataSourceFile> => {
  try {
    const { text_chunks, image_chunks, text_chunk_pos, image_chunk_pos } =
      await extractTextAndImagesWithChunks(filePath, `dsf-${createId()}`)
    if (text_chunks.length === 0 && image_chunks.length === 0) {
      throw new ContentExtractionError(
        "No chunks generated from PDF content",
        "PDF",
      )
    }

    return createVespaDataSourceFile(
      text_chunks,
      options,
      convertedFrom ? "pdf_conversion" : "pdf_processing",
      image_chunks,
      text_chunk_pos,
      image_chunk_pos,
      convertedFrom,
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

const processSheetContent = async (
  filePath: string,
  options: ProcessingOptions,
): Promise<VespaDataSourceFile> => {
  try {
    const chunks = await processXlsxFile(filePath)
    if (chunks.length === 0) {
      throw new ContentExtractionError(
        "No valid content found in spreadsheet",
        "spreadsheet",
      )
    }

    return createVespaDataSourceFile(chunks, options, "sheet_processing")
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

// File conversion functions
const convertToPdf = async (
  inputFilePath: string,
  mimeType: string,
): Promise<string> => {
  const tempDir = path.dirname(inputFilePath)
  const inputFileName = path.basename(
    inputFilePath,
    path.extname(inputFilePath),
  )
  const outputPdfPath = path.join(tempDir, `${inputFileName}_converted.pdf`)

  try {
    if (isOfficeFile(mimeType)) {
      await convertOfficeToPdf(inputFilePath, tempDir, outputPdfPath)
    }
    // else if (isImageFile(mimeType)) {
    //   await convertImageToPdf(inputFilePath, outputPdfPath)
    // }
    else {
      throw new UnsupportedFileTypeError(mimeType, [
        "office documents",
        "images",
      ])
    }

    if (!fs.existsSync(outputPdfPath)) {
      throw new FileConversionError("Output file not created", mimeType)
    }

    return outputPdfPath
  } catch (error) {
    if (isDataSourceError(error)) {
      throw error
    }
    throw new FileConversionError(
      error instanceof Error ? error.message : String(error),
      mimeType,
    )
  }
}

const convertOfficeToPdf = async (
  inputFilePath: string,
  tempDir: string,
  expectedOutputPath: string,
): Promise<void> => {
  const libreOfficePath = getLibreOfficePath()

  if (
    !fs.existsSync(libreOfficePath) ||
    !fs.statSync(libreOfficePath).isFile()
  ) {
    throw new ExternalToolError(
      "LibreOffice",
      `Not found at: ${libreOfficePath}`,
    )
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new TimeoutError(
          "LibreOffice conversion",
          DATASOURCE_CONFIG.CONVERSION_TIMEOUT_MS,
        ),
      )
    }, DATASOURCE_CONFIG.CONVERSION_TIMEOUT_MS)

    const proc = spawn(libreOfficePath, [
      "--headless",
      "--convert-to",
      "pdf",
      "--outdir",
      tempDir,
      inputFilePath,
    ])

    let stderr = ""
    proc.stderr?.on("data", (data) => {
      stderr += data.toString()
    })

    proc.on("error", (error) => {
      clearTimeout(timeout)
      reject(
        new ExternalToolError("LibreOffice", `Spawn error: ${error.message}`),
      )
    })

    proc.on("exit", (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve()
      } else {
        reject(
          new ExternalToolError(
            "LibreOffice",
            `Exited with code ${code}. Error: ${stderr}`,
          ),
        )
      }
    })
  })

  // Handle LibreOffice naming convention
  const inputFileName = path.basename(
    inputFilePath,
    path.extname(inputFilePath),
  )
  const libreOfficePdfPath = path.join(
    path.dirname(expectedOutputPath),
    `${inputFileName}.pdf`,
  )

  try {
    await access(libreOfficePdfPath)
    if (libreOfficePdfPath !== expectedOutputPath) {
      await rename(libreOfficePdfPath, expectedOutputPath)
    }
  } catch (error) {
    throw new FileConversionError(
      `Failed to locate converted PDF: ${error instanceof Error ? error.message : String(error)}`,
      "office document",
    )
  }
}

// XLSX processing functions
const processXlsxFile = async (filePath: string): Promise<string[]> => {
  try {
    const workbook = XLSX.readFile(filePath)
    const allChunks: string[] = []

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      throw new ContentExtractionError("No worksheets found", "Excel")
    }

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

      if (validRows.length === 0) continue

      const sheetChunks = chunkSheetRows(validRows)
      allChunks.push(...sheetChunks)
    }

    const filteredChunks = allChunks.filter((chunk) => chunk.trim().length > 0)

    if (filteredChunks.length === 0) {
      throw new ContentExtractionError(
        "No valid content found in any worksheet",
        "Excel",
      )
    }

    return filteredChunks
  } catch (error) {
    if (isDataSourceError(error)) {
      throw error
    }
    throw new ContentExtractionError(
      error instanceof Error ? error.message : String(error),
      "Excel",
    )
  }
}

const chunkSheetRows = (allRows: string[][]): string[] => {
  const chunks: string[] = []
  let currentChunk = ""

  for (const row of allRows) {
    const textualCells = row
      .filter(
        (cell) =>
          cell && isNaN(Number(cell)) && cell.toString().trim().length > 0,
      )
      .map((cell) => cell.toString().trim())

    if (textualCells.length === 0) continue

    const rowText = textualCells.join(" ")
    const potentialChunk = currentChunk ? `${currentChunk} ${rowText}` : rowText

    if (potentialChunk.length > DATASOURCE_CONFIG.MAX_CHUNK_SIZE) {
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim())
      }
      currentChunk = rowText
    } else {
      currentChunk = potentialChunk
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim())
  }

  return chunks
}

// Main export function
export const handleDataSourceFileUpload = async (
  file: File,
  userEmail: string,
  dataSourceUserSpecificId: string,
  description?: string,
): Promise<FileProcessingResult> => {
  const filesToCleanup: string[] = []

  try {
    // Validate inputs
    validateFile(file)
    await ensureTempDir()

    // Extract base MIME type (remove parameters like charset)
    const rawMimeType = file.type || "text/plain"
    const mimeType = getBaseMimeType(rawMimeType)

    const fileExtension = path.extname(file.name) || ".txt"
    const tempFilePath = path.join(
      DATASOURCE_CONFIG.TEMP_DIR,
      `${uuidv4()}${fileExtension}`,
    )
    filesToCleanup.push(tempFilePath)

    const options: ProcessingOptions = {
      fileName: file.name,
      userEmail,
      fileSize: file.size,
      dataSourceUserSpecificId,
      mimeType,
      description,
    }

    let processedFile: VespaDataSourceFile
    if (isImageFile(mimeType)) {
      const imageBuffer = Buffer.from(await file.arrayBuffer())
      processedFile = await processImageContent(imageBuffer, options)
      try {
        const baseDir = path.resolve(
          process.env.IMAGE_DIR || "downloads/xyne_images_db",
        )
        const outputDir = path.join(baseDir, processedFile.docId)
        await fsPromises.mkdir(outputDir, { recursive: true })

        const imageFilename = `${0}.png`
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
      // Write file to temp location
      try {
        const fileBuffer = new Uint8Array(await file.arrayBuffer())
        await writeFile(tempFilePath, fileBuffer)
      } catch (error) {
        throw new FileProcessingError(
          `Failed to write temporary file: ${error instanceof Error ? error.message : String(error)}`,
          file.name,
        )
      }

      // Process based on file type
      if (mimeType === "application/pdf") {
        processedFile = await processPdfContent(tempFilePath, options)
      } else if (isTextFile(mimeType)) {
        const content = await file.text()
        processedFile = await processTextContent(content, options)
      } else if (isSheetFile(mimeType)) {
        processedFile = await processSheetContent(tempFilePath, options)
      } else if (requiresConversion(mimeType)) {
        // Convert to PDF first
        const convertedPdfPath = await convertToPdf(tempFilePath, mimeType)
        filesToCleanup.push(convertedPdfPath)
        processedFile = await processPdfContent(
          convertedPdfPath,
          options,
          mimeType,
        )
      } else {
        throw createUnsupportedTypeError(mimeType, getSupportedFileTypes())
      }
    }

    // Insert into Vespa
    try {
      await insertDataSourceFile(processedFile)
    } catch (error) {
      throw new StorageError(
        `Failed to store file in database: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    Logger.info(
      {
        fileName: file.name,
        docId: processedFile.docId,
        userEmail,
        mimeType,
        rawMimeType,
      },
      "DataSource file processed successfully",
    )

    return {
      success: true,
      message: "DataSource file processed and stored successfully",
      docId: processedFile.docId,
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
  } finally {
    // Cleanup temporary files
    if (filesToCleanup.length > 0) {
      await cleanupFiles(filesToCleanup)
    }
  }
}
