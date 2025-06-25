import { Subsystem, type GoogleClient } from "@/types"
import { getLogger } from "@/logger"
import { gmail_v1 } from "googleapis"
import {
  deleteDocument,
  downloadDir,
  downloadPDF,
  safeLoadPDF,
} from "@/integrations/google/pdf-utils"
import { hashPdfFilename, retryWithBackoff } from "@/utils"
import { chunkDocument } from "@/chunks"
import { Apps, type Attachment } from "@/search/types"
import {
  MAX_ATTACHMENT_PDF_SIZE,
  MAX_GD_PDF_SIZE,
} from "@/integrations/google/config"
import crypto from "node:crypto"
import fs from "fs"
import { readFile, writeFile } from "fs/promises"
import path from "path"
import { exec } from "child_process"
import { promisify } from "util"
import * as XLSX from "xlsx"

const execAsync = promisify(exec)
const Logger = getLogger(Subsystem.Integrations).child({ module: "google" })

export async function saveGmailAttachment(
  attachmentData: any,
  fileName: string,
) {
  try {
    // The attachment data is base64 encoded, so we need to decode it
    // Replace any `-` with `+` and `_` with `/` to make it standard base64
    const normalizedBase64 = attachmentData
      .replace(/-/g, "+")
      .replace(/_/g, "/")

    const buffer = Buffer.from(normalizedBase64, "base64")

    await writeFile(fileName, new Uint8Array(buffer))

    Logger.debug(`Successfully saved gmail attachment at ${fileName}`)
  } catch (error) {
    Logger.error("Error saving gmail attachment:", error)
    throw error
  }
}

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
    // Handle different file types
    if (
      mimeType.includes("officedocument") ||
      mimeType.includes("msword") ||
      mimeType.includes("presentation")
    ) {
      // For office documents, use LibreOffice
      const libreOfficePath =
        process.env.LIBREOFFICE_PATH ||
        "/Applications/LibreOffice.app/Contents/MacOS/soffice"
      await execAsync(
        `"${libreOfficePath}" --headless --convert-to pdf --outdir "${tempDir}" "${inputFilePath}"`,
      )
      // LibreOffice creates PDF with same base name
      const libreOfficePdfPath = path.join(tempDir, `${inputFileName}.pdf`)
      if (
        fs.existsSync(libreOfficePdfPath) &&
        libreOfficePdfPath !== outputPdfPath
      ) {
        fs.renameSync(libreOfficePdfPath, outputPdfPath)
      }
    } else if (mimeType.startsWith("image/")) {
      // For images, use ImageMagick convert
      await execAsync(`convert "${inputFilePath}" "${outputPdfPath}"`)
    } else {
      throw new Error(`Unsupported file type for PDF conversion: ${mimeType}`)
    }

    if (!fs.existsSync(outputPdfPath)) {
      throw new Error(`PDF conversion failed - output file not created`)
    }

    return outputPdfPath
  } catch (error) {
    throw new Error(
      `PDF conversion failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export const getGmailAttachmentChunks = async (
  gmail: gmail_v1.Gmail,
  attachmentMetadata: {
    messageId: string
    attachmentId: string
    filename: string
    size: { value: number }
    mimeType: string
  },
  client: GoogleClient,
): Promise<string[] | null> => {
  const { attachmentId, filename, messageId, size, mimeType } =
    attachmentMetadata
  let attachmentChunks: string[] = []
  try {
    const hashInput = `${filename}_${messageId}`
    const fileExt = path.extname(filename)
    const hashFileName = hashPdfFilename(hashInput)
    if (hashFileName == null) return null
    const newfileName = `${hashFileName}${fileExt}`
    const downloadAttachmentFilePath = path.join(downloadDir, newfileName)
    const attachementResp = await retryWithBackoff(
      () =>
        gmail.users.messages.attachments.get({
          messageId: messageId,
          id: attachmentId,
          userId: "me",
        }),
      "Fetching Gmail Attachments",
      Apps.Gmail,
      0,
      client,
    )

    await saveGmailAttachment(
      attachementResp.data.data,
      downloadAttachmentFilePath,
    )

    let filePathForProcessing = downloadAttachmentFilePath

    if (mimeType !== "application/pdf") {
      try {
        filePathForProcessing = await convertToPdf(
          downloadAttachmentFilePath,
          mimeType,
        )
      } catch (conversionError) {
        if (mimeType === "text/plain") {
          const content = await readFile(downloadAttachmentFilePath, "utf8")
          attachmentChunks = chunkDocument(content)
            .map((v) => v.chunk)
            .filter((v) => v.trim())
          return attachmentChunks
        } else if (
          mimeType ===
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ) {
          attachmentChunks = processXlsxFile(downloadAttachmentFilePath)
          return attachmentChunks
        } else {
          Logger.warn(
            conversionError,
            `invalid file type ${filename}. Skipping file.`,
          )
        }

        // Clean up the original file if conversion failed
        await deleteDocument(downloadAttachmentFilePath)
        return null
      }
    }

    const stats = fs.statSync(filePathForProcessing)
    size.value = stats.size

    const pdfSizeMB = size.value / (1024 * 1024)
    if (pdfSizeMB > MAX_GD_PDF_SIZE) {
      await deleteDocument(filePathForProcessing)
      Logger.error(
        `Ignoring ${filename} as its more than ${MAX_GD_PDF_SIZE} MB`,
      )
      return null
    }

    const docs = await safeLoadPDF(filePathForProcessing)
    if (!docs || docs.length === 0) {
      Logger.warn(`Could not get content for file: ${filename}. Skipping it`)

      await deleteDocument(downloadAttachmentFilePath)
      if (filePathForProcessing !== downloadAttachmentFilePath) {
        await deleteDocument(filePathForProcessing)
      }
      return null
    }

    attachmentChunks = docs
      // @ts-ignore
      .flatMap((doc) => chunkDocument(doc.pageContent))
      .map((v) => v.chunk)
      .filter((v) => v.trim())

    await deleteDocument(downloadAttachmentFilePath)
    if (filePathForProcessing !== downloadAttachmentFilePath) {
      await deleteDocument(filePathForProcessing)
    }
  } catch (error) {
    Logger.error(error, `Error in getting gmailAttachmentChunks`)
  }

  return attachmentChunks
}

// Function to parse attachments from the email payload
export const parseAttachments = (
  payload: gmail_v1.Schema$MessagePart,
): { attachments: Attachment[]; filenames: string[] } => {
  const attachments: Attachment[] = []
  const filenames: string[] = []

  const traverseParts = (parts: any[]) => {
    for (const part of parts) {
      if (part.filename && part.body && part.body.attachmentId) {
        filenames.push(part.filename)
        attachments.push({
          fileType: part.mimeType || "application/octet-stream",
          fileSize: parseInt(part.body.size, 10) || 0,
        })
      } else if (part.parts) {
        traverseParts(part.parts)
      }
    }
  }

  if (payload.parts) {
    traverseParts(payload.parts)
  }

  return { attachments, filenames }
}

// Function to process XLSX files similar to Google Sheets processing
const processXlsxFile = (filePath: string): string[] => {
  try {
    const workbook = XLSX.readFile(filePath)
    const chunks: string[] = []

    // Process each sheet in the workbook
    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName]

      // Convert sheet to JSON array of arrays
      const sheetData: string[][] = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: "",
        raw: false,
      })

      // Clean and get valid rows (similar to cleanSheetAndGetValidRows)
      const validRows = sheetData.filter((row) =>
        row.some((cell) => cell && cell.toString().trim().length > 0),
      )

      if (validRows.length === 0) continue

      // Chunk the rows (similar to chunkFinalRows)
      const sheetChunks = chunkSheetRows(validRows)
      chunks.push(...sheetChunks)
    }

    return chunks.filter((chunk) => chunk.trim().length > 0)
  } catch (error) {
    Logger.error(error, `Error processing XLSX file: ${filePath}`)
    return []
  }
}

// Function to chunk sheet rows (simplified version of chunkFinalRows)
const chunkSheetRows = (allRows: string[][]): string[] => {
  const chunks: string[] = []
  let currentChunk = ""
  const MAX_CHUNK_SIZE = 512

  for (const row of allRows) {
    // Filter out numerical cells and empty strings, join textual cells
    const textualCells = row
      .filter(
        (cell) =>
          cell && isNaN(Number(cell)) && cell.toString().trim().length > 0,
      )
      .map((cell) => cell.toString().trim())

    if (textualCells.length === 0) continue

    const rowText = textualCells.join(" ")

    if ((currentChunk + " " + rowText).trim().length > MAX_CHUNK_SIZE) {
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim())
      }
      currentChunk = rowText
    } else {
      currentChunk += (currentChunk ? " " : "") + rowText
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim())
  }

  return chunks
}
