import { Subsystem, type GoogleClient } from "@/types"
import { getLogger } from "@/logger"
import { gmail_v1 } from "googleapis"
import { retryWithBackoff } from "@/utils"
import { chunkDocument } from "@/chunks"
import {
  Apps,
  MailAttachmentEntity,
  type Attachment,
} from "@xyne/vespa-ts/types"
import {
  MAX_ATTACHMENT_PDF_SIZE,
  MAX_ATTACHMENT_TEXT_SIZE,
  MAX_ATTACHMENT_DOCX_SIZE,
  MAX_ATTACHMENT_PPTX_SIZE,
  MAX_ATTACHMENT_SHEET_SIZE,
} from "@/integrations/google/config"
import * as XLSX from "xlsx"
import { extractTextAndImagesWithChunksFromDocx } from "@/docxChunks"
import { extractTextAndImagesWithChunksFromPptx } from "@/pptChunks"
import { PdfProcessor } from "@/lib/pdfProcessor"
import { chunkSheetWithHeaders } from "@/sheetChunk"
import { checkFileSize } from "../dataSource"

const Logger = getLogger(Subsystem.Integrations).child({ module: "google" })

// Function to process PPTX file content using our PPTX extractor
const processPptxFile = async (
  pptxBuffer: Uint8Array,
  attachmentId: string,
): Promise<string[]> => {
  try {
    // Handle non-spreadsheet files as before
    const pptxResult = await extractTextAndImagesWithChunksFromPptx(
      pptxBuffer,
      attachmentId,
      false, // Don't extract images for email attachments
    )
    return pptxResult.text_chunks.filter((v) => v.trim())
  } catch (error) {
    Logger.error(error, `Error processing PPTX buffer`)
    return []
  }
}

// Function to process PDF file content using our PDF extractor
const processPdfFile = async (
  pdfBuffer: Uint8Array,
  attachmentId: string,
): Promise<string[]> => {
  try {
    const result = await PdfProcessor.processWithFallback(
      Buffer.from(pdfBuffer),
      `attachment-${attachmentId}`,
      attachmentId,
      false,
      false,
    )
    return result.chunks.filter((v) => v.trim())
  } catch (error) {
    Logger.error(error, `Error processing PDF buffer`)
    return []
  }
}

// Function to process DOCX file content using our DOCX extractor
const processDocxFile = async (
  docxBuffer: Uint8Array,
  attachmentId: string,
): Promise<string[]> => {
  try {
    // Handle non-spreadsheet files as before
    const docxResult = await extractTextAndImagesWithChunksFromDocx(
      docxBuffer,
      attachmentId,
      false, // Don't extract images for email attachments
    )
    return docxResult.text_chunks.filter((v) => v.trim())
  } catch (error) {
    Logger.error(error, `Error processing DOCX buffer`)
    return []
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

    if (!attachementResp.data.data) {
      Logger.error(`No attachment data received for ${filename}`)
      return null
    }

    // Decode base64 data to buffer
    const normalizedBase64 = attachementResp.data.data
      .replace(/-/g, "+")
      .replace(/_/g, "/")

    let attachmentBuffer: Buffer
    try {
      attachmentBuffer = Buffer.from(normalizedBase64, "base64")
    } catch (error) {
      Logger.error(`Failed to decode base64 data for ${filename}:`, error)
      return null
    }

    if (attachmentBuffer.length === 0) {
      Logger.error(`Decoded buffer is empty for ${filename}`)
      return null
    }

    if (mimeType === "application/pdf") {
      try {
        checkFileSize(size.value, MAX_ATTACHMENT_PDF_SIZE)
      } catch (error) {
        Logger.error(
          `Ignoring ${filename} as its more than ${MAX_ATTACHMENT_PDF_SIZE} MB`,
        )
        return null
      }
      const pdfChunks = await processPdfFile(
        new Uint8Array(attachmentBuffer),
        attachmentId,
      )
      if (pdfChunks && pdfChunks.length > 0) {
        attachmentChunks = pdfChunks
      } else {
        Logger.warn(`Could not process PDF file: ${filename}`)
      }
    } else if (
      mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      mimeType === "application/msword"
    ) {
      try {
        checkFileSize(size.value, MAX_ATTACHMENT_DOCX_SIZE)
      } catch (error) {
        Logger.error(
          `Ignoring ${filename} as its more than ${MAX_ATTACHMENT_DOCX_SIZE} MB`,
        )
        return null
      }
      const docxChunks = await processDocxFile(
        new Uint8Array(attachmentBuffer),
        attachmentId,
      )
      if (docxChunks && docxChunks.length > 0) {
        attachmentChunks = docxChunks
      } else {
        Logger.warn(`Could not process DOCX file: ${filename}`)
      }
    } else if (
      mimeType ===
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
      mimeType === "application/vnd.ms-powerpoint"
    ) {
      try {
        checkFileSize(size.value, MAX_ATTACHMENT_PPTX_SIZE)
      } catch (error) {
        Logger.error(
          `Ignoring ${filename} as its more than ${MAX_ATTACHMENT_PPTX_SIZE} MB`,
        )
        return null
      }
      const pptxChunks = await processPptxFile(
        new Uint8Array(attachmentBuffer),
        attachmentId,
      )
      if (pptxChunks && pptxChunks.length > 0) {
        attachmentChunks = pptxChunks
      } else {
        Logger.warn(`Could not process PPTX file: ${filename}`)
      }
    } else if (
      mimeType === "text/plain" ||
      mimeType === "text/html" ||
      mimeType === "text/markdown"
    ) {
      try {
        checkFileSize(size.value, MAX_ATTACHMENT_TEXT_SIZE)
      } catch (error) {
        Logger.error(
          `Ignoring ${filename} as its more than ${MAX_ATTACHMENT_TEXT_SIZE} MB`,
        )
        return null
      }
      const content = attachmentBuffer.toString("utf8")
      const chunks = chunkDocument(content)
      attachmentChunks = chunks.map((v) => v.chunk).filter((v) => v.trim())
    } else {
      Logger.warn(
        `Unsupported file type ${mimeType} for file ${filename}. Skipping.`,
      )
      return null
    }
  } catch (error) {
    Logger.error(
      error,
      `Error in getting gmailAttachmentChunks for ${filename}`,
    )
  }
  return attachmentChunks
}

// Interface for sheet data returned by spreadsheet processing
export interface SheetData {
  sheetName: string
  sheetIndex: number
  chunks: string[]
  totalSheets: number
}

// Helper function to determine the correct entity type based on MIME type
export const getMailAttachmentEntity = (
  mimeType: string,
): MailAttachmentEntity => {
  const baseMimeType = mimeType.toLowerCase().split(";")[0].trim()

  switch (baseMimeType) {
    case "application/pdf":
      return MailAttachmentEntity.PDF

    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.ms-excel":
      return MailAttachmentEntity.Sheets

    case "text/csv":
      return MailAttachmentEntity.CSV

    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/msword":
      return MailAttachmentEntity.WordDocument

    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    case "application/vnd.ms-powerpoint":
      return MailAttachmentEntity.PowerPointPresentation

    case "text/plain":
    case "text/html":
    case "text/markdown":
      return MailAttachmentEntity.Text

    default:
      return MailAttachmentEntity.NotValid
  }
}

// Function to get spreadsheet data with individual sheet information
export const getGmailSpreadsheetSheets = async (
  gmail: gmail_v1.Gmail,
  attachmentMetadata: {
    messageId: string
    attachmentId: string
    filename: string
    size: { value: number }
    mimeType: string
  },
  client: GoogleClient,
): Promise<SheetData[] | null> => {
  const { attachmentId, filename, messageId, size, mimeType } =
    attachmentMetadata

  try {
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

    if (!attachementResp.data.data) {
      Logger.error(`No attachment data received for ${filename}`)
      return null
    }

    // Decode base64 data to buffer
    const normalizedBase64 = attachementResp.data.data
      .replace(/-/g, "+")
      .replace(/_/g, "/")

    let attachmentBuffer: Buffer
    try {
      attachmentBuffer = Buffer.from(normalizedBase64, "base64")
    } catch (error) {
      Logger.error(`Failed to decode base64 data for ${filename}:`, error)
      return null
    }

    if (attachmentBuffer.length === 0) {
      Logger.error(`Decoded buffer is empty for ${filename}`)
      return null
    }

    // Check if it's a supported spreadsheet type
    if (
      mimeType ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      mimeType === "application/vnd.ms-excel" ||
      mimeType === "text/csv"
    ) {
      try {
        checkFileSize(size.value, MAX_ATTACHMENT_SHEET_SIZE)
      } catch (error) {
        Logger.error(
          `Ignoring ${filename} as its more than ${MAX_ATTACHMENT_SHEET_SIZE} MB`,
        )
        return null
      }
      const sheetsData = await processSpreadsheetFileWithSheetInfo(
        attachmentBuffer,
        filename,
      )
      return sheetsData
    }

    return null
  } catch (error) {
    Logger.error(
      error,
      `Error in getting gmail spreadsheet sheets for ${filename}`,
    )
    return null
  }
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

// Function to process spreadsheet files and return individual sheet data
export const processSpreadsheetFileWithSheetInfo = async (
  buffer: Buffer,
  filename: string,
): Promise<SheetData[]> => {
  let workbook: XLSX.WorkBook | null = null

  try {
    // Process in a more memory-efficient way
    workbook = await new Promise<XLSX.WorkBook>((resolve, reject) => {
      // Use setTimeout to prevent blocking
      setTimeout(() => {
        try {
          const wb = XLSX.read(buffer, {
            type: "buffer",
            cellDates: true,
            cellNF: false,
            cellText: false,
            cellFormula: false,
            cellStyles: false,
            sheetStubs: false,
            password: undefined,
            dense: true, // Use dense mode for better memory efficiency
          })
          resolve(wb)
        } catch (err) {
          reject(err)
        }
      }, 0)
    })

    const sheetsData: SheetData[] = []

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      Logger.warn(`No worksheets found in spreadsheet file: ${filename}`)
      return []
    }

    // Process each sheet in the workbook
    for (const [sheetIndex, sheetName] of workbook.SheetNames.entries()) {
      try {
        const worksheet = workbook.Sheets[sheetName]
        if (!worksheet) continue

        const filteredSheetChunks = chunkSheetWithHeaders(worksheet);

        if (filteredSheetChunks.length === 0) {
          Logger.debug(
            `Sheet "${sheetName}" produced no valid chunks, skipping`,
          )
          continue
        }

        sheetsData.push({
          sheetName,
          sheetIndex,
          chunks: filteredSheetChunks,
          totalSheets: workbook.SheetNames.length,
        })

        Logger.debug(
          `Processed sheet "${sheetName}" with ${filteredSheetChunks.length} chunks`,
        )

        // Clear the worksheet from memory after processing
        delete workbook.Sheets[sheetName]
      } catch (sheetError) {
        Logger.error(
          `Error processing sheet "${sheetName}" in ${filename}: ${sheetError}`,
        )
        continue
      }
    }

    if (sheetsData.length === 0) {
      Logger.warn(
        `No valid content found in any worksheet of file: ${filename}`,
      )
    } else {
      Logger.info(
        `Successfully processed spreadsheet ${filename} with ${sheetsData.length} valid sheets`,
      )
    }

    return sheetsData
  } catch (error) {
    const { name, message } = error as Error
    if (
      message?.includes("PasswordException") ||
      name?.includes("PasswordException") ||
      message?.includes("File is password-protected")
    ) {
      Logger.warn(`Password protected spreadsheet '${filename}', skipping`)
    } else if (
      message?.includes("Unsupported file") ||
      message?.includes("Corrupted")
    ) {
      Logger.warn(
        `Corrupted or unsupported spreadsheet format '${filename}', skipping`,
      )
    } else if (
      message?.includes("Cannot read property") ||
      message?.includes("Cannot read properties")
    ) {
      Logger.warn(`Invalid spreadsheet structure in '${filename}', skipping`)
    } else {
      Logger.error(`Spreadsheet processing error for '${filename}': ${error}`)
    }
    return []
  } finally {
    // Clean up workbook reference
    if (workbook) {
      // Clear all sheets
      if (workbook.Sheets) {
        for (const sheetName of Object.keys(workbook.Sheets)) {
          delete workbook.Sheets[sheetName]
        }
      }
      workbook = null
    }
  }
}
