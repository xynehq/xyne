import { Subsystem } from "@/types"
import { getLogger } from "@/logger"
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
import { makeGraphApiCall, type MicrosoftGraphClient } from "./client"
import { chunkSheetWithHeaders } from "@/sheetChunk"
import { checkFileSize } from "../dataSource"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "microsoft-attachments",
})

// Function to process PPTX file content using our PPTX extractor
const processPptxFile = async (
  pptxBuffer: Uint8Array,
  attachmentId: string,
): Promise<string[]> => {
  try {
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

// Function to get Outlook attachment chunks
export const getOutlookAttachmentChunks = async (
  client: MicrosoftGraphClient,
  attachmentMetadata: {
    messageId: string
    attachmentId: string
    filename: string
    size: number
    mimeType: string
  },
): Promise<string[] | null> => {
  const { attachmentId, filename, messageId, size, mimeType } =
    attachmentMetadata
  let attachmentChunks: string[] = []

  try {
    // First get the full attachment details to check the type
    const attachmentDetails = await makeGraphApiCall(
      client,
      `/me/messages/${messageId}/attachments/${attachmentId}`,
    )

    let attachmentBuffer: Buffer

    // Handle different attachment types from Microsoft Graph API
    if (
      attachmentDetails["@odata.type"] === "#microsoft.graph.fileAttachment"
    ) {
      // For file attachments, the content is in the contentBytes property (base64 encoded)
      if (attachmentDetails.contentBytes) {
        try {
          attachmentBuffer = Buffer.from(
            attachmentDetails.contentBytes,
            "base64",
          )
        } catch (error) {
          Logger.error(
            `Error decoding base64 content for ${filename}: ${error}`,
          )
          return null
        }
      } else {
        Logger.error(`No contentBytes found for file attachment ${filename}`)
        return null
      }
    } else if (
      attachmentDetails["@odata.type"] === "#microsoft.graph.itemAttachment"
    ) {
      // Item attachments (like embedded emails) - we'll skip these for now
      Logger.info(`Skipping item attachment ${filename} - not supported yet`)
      return null
    } else if (
      attachmentDetails["@odata.type"] ===
      "#microsoft.graph.referenceAttachment"
    ) {
      // Reference attachments (like OneDrive links) - we'll skip these for now
      Logger.info(
        `Skipping reference attachment ${filename} - not supported yet`,
      )
      return null
    } else {
      Logger.error(
        `Unknown attachment type for ${filename}: ${attachmentDetails["@odata.type"]}`,
      )
      return null
    }

    if (attachmentBuffer.length === 0) {
      Logger.error(`Attachment buffer is empty for ${filename}`)
      return null
    }

    // Process based on MIME type
    if (mimeType === "application/pdf") {
      try {
        checkFileSize(size, MAX_ATTACHMENT_PDF_SIZE)
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
        checkFileSize(size, MAX_ATTACHMENT_DOCX_SIZE)
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
        checkFileSize(size, MAX_ATTACHMENT_PPTX_SIZE)
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
        checkFileSize(size, MAX_ATTACHMENT_TEXT_SIZE)
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
      `Error in getting Outlook attachment chunks for ${filename}`,
    )
  }
  return attachmentChunks
}

// Function to get Outlook spreadsheet sheets
export const getOutlookSpreadsheetSheets = async (
  client: MicrosoftGraphClient,
  attachmentMetadata: {
    messageId: string
    attachmentId: string
    filename: string
    size: number
    mimeType: string
  },
): Promise<SheetData[] | null> => {
  const { attachmentId, filename, messageId, size, mimeType } =
    attachmentMetadata

  try {
    // First get the full attachment details to check the type
    const attachmentDetails = await makeGraphApiCall(
      client,
      `/me/messages/${messageId}/attachments/${attachmentId}`,
    )

    let attachmentBuffer: Buffer

    // Handle different attachment types from Microsoft Graph API
    if (
      attachmentDetails["@odata.type"] === "#microsoft.graph.fileAttachment"
    ) {
      // For file attachments, the content is in the contentBytes property (base64 encoded)
      if (attachmentDetails.contentBytes) {
        try {
          attachmentBuffer = Buffer.from(
            attachmentDetails.contentBytes,
            "base64",
          )
        } catch (error) {
          Logger.error(
            `Error decoding base64 content for ${filename}: ${error}`,
          )
          return null
        }
      } else {
        Logger.error(`No contentBytes found for file attachment ${filename}`)
        return null
      }
    } else if (
      attachmentDetails["@odata.type"] === "#microsoft.graph.itemAttachment"
    ) {
      // Item attachments (like embedded emails) - we'll skip these for now
      Logger.info(`Skipping item attachment ${filename} - not supported yet`)
      return null
    } else if (
      attachmentDetails["@odata.type"] ===
      "#microsoft.graph.referenceAttachment"
    ) {
      // Reference attachments (like OneDrive links) - we'll skip these for now
      Logger.info(
        `Skipping reference attachment ${filename} - not supported yet`,
      )
      return null
    } else {
      Logger.error(
        `Unknown attachment type for ${filename}: ${attachmentDetails["@odata.type"]}`,
      )
      return null
    }

    if (attachmentBuffer.length === 0) {
      Logger.error(`Attachment buffer is empty for ${filename}`)
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
        checkFileSize(size, MAX_ATTACHMENT_SHEET_SIZE)
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
      `Error in getting Outlook spreadsheet sheets for ${filename}`,
    )
    return null
  }
}

// Function to parse attachments from Outlook message
export const parseOutlookAttachments = (
  attachments: any[],
): { attachments: Attachment[]; filenames: string[] } => {
  const parsedAttachments: Attachment[] = []
  const filenames: string[] = []

  for (const attachment of attachments) {
    if (attachment.name && attachment.size) {
      filenames.push(attachment.name)
      parsedAttachments.push({
        fileType: attachment.contentType || "application/octet-stream",
        fileSize: attachment.size || 0,
      })
    }
  }

  return { attachments: parsedAttachments, filenames }
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

        const sheetChunks = chunkSheetWithHeaders(worksheet)
        const filteredSheetChunks = sheetChunks.filter(
          (chunk) => chunk.trim().length > 0,
        )

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

// Helper function to check if a file is a spreadsheet
export const isSpreadsheetFile = (mimeType: string): boolean => {
  return (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.ms-excel" ||
    mimeType === "text/csv"
  )
}

// Helper function to check if a MIME type is valid for processing
export const isValidMimeType = (
  mimeType: string | null | undefined,
): boolean => {
  if (!mimeType) return false

  const supportedTypes = new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "text/html",
    "text/markdown",
  ])

  return supportedTypes.has(mimeType.toLowerCase().split(";")[0].trim())
}
