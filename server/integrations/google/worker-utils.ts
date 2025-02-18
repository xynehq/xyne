import { Subsystem } from "@/types"
import fs from "node:fs/promises"
import { getLogger } from "@/logger"
import { gmail_v1 } from "googleapis"
import {
  deleteDocument,
  downloadDir,
  downloadPDF,
  safeLoadPDF,
} from "@/integrations/google/pdf-utils"
import { retryWithBackoff } from "@/utils"
import { chunkDocument } from "@/chunks"
import type { Attachment } from "@/search/types"
import { MAX_ATTACHMENT_PDF_SIZE } from "@/integrations/google/config"
import path from "node:path"
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
    // @ts-ignore
    await fs.writeFile(fileName, buffer)

    Logger.info(`Successfully saved gmail attachment at ${fileName}`)
  } catch (error) {
    Logger.error("Error saving gmail attachment:", error)
    throw error
  }
}

export const getGmailAttachmentChunks = async (
  gmail: gmail_v1.Gmail,
  attachmentMetadata: {
    messageId: string
    attachmentId: string
    filename: string
    size: number
  },
): Promise<string[] | null> => {
  const { attachmentId, filename, messageId, size } = attachmentMetadata
  let attachmentChunks: string[] = []
  const pdfSizeInMB = size / (1024 * 1024)
  // Ignore the PDF files larger than Max PDF Size
  if (pdfSizeInMB > MAX_ATTACHMENT_PDF_SIZE) {
    Logger.warn(
      `Ignoring ${filename} as its more than ${MAX_ATTACHMENT_PDF_SIZE} MB`,
    )
    return null
  }

  try {
    const fileName = `${filename}_${messageId}`
    const downloadAttachmentFilePath = path.join(downloadDir, fileName)

    const attachementResp = await retryWithBackoff(
      () =>
        gmail.users.messages.attachments.get({
          messageId: messageId,
          id: attachmentId,
          userId: "me",
        }),
      "Fetching Gmail Attachments",
    )

    await saveGmailAttachment(
      attachementResp.data.data,
      downloadAttachmentFilePath,
    )
    const docs = await safeLoadPDF(downloadAttachmentFilePath)
    if (!docs || docs.length === 0) {
      Logger.warn(`Could not get content for file: ${filename}. Skipping it`)

      await deleteDocument(downloadAttachmentFilePath)
      return null
    }
    attachmentChunks = docs
      // @ts-ignore
      .flatMap((doc) => chunkDocument(doc.pageContent))
      .map((v) => v.chunk)
      .filter((v) => v.trim())

    await deleteDocument(downloadAttachmentFilePath)
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
