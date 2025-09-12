import { DeleteDocumentError } from "@/errors"
import { getLogger } from "@/logger"
import { Apps, DriveEntity } from "@xyne/vespa-ts/types"
import { Subsystem } from "@/types"
import type { drive_v3 } from "googleapis"
const Logger = getLogger(Subsystem.Integrations).child({ module: "google" })
import { unlink } from "node:fs/promises"
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf"
import path from "node:path"

export const downloadDir = path.resolve(__dirname, "../../downloads")

export const deleteDocument = async (filePath: string) => {
  try {
    await unlink(filePath)
    Logger.info(`File at ${filePath} deleted successfully`)
  } catch (err) {
    Logger.error(
      err,
      `Error deleting file at ${filePath}: ${err} ${(err as Error).stack}`,
      err,
    )
    throw new DeleteDocumentError({
      message: "Error in the catch of deleting file",
      cause: err as Error,
      integration: Apps.GoogleDrive,
      entity: DriveEntity.PDF,
    })
  }
}

export const downloadPDF = async (
  drive: drive_v3.Drive,
  fileId: string,
  fileName: string,
): Promise<void> => {
  const filePath = path.join(downloadDir, fileName)
  const file = Bun.file(filePath)
  const writer = file.writer()
  const res = await drive.files.get(
    { fileId: fileId, alt: "media" },
    { responseType: "stream" },
  )
  return new Promise((resolve, reject) => {
    res.data.on("data", (chunk) => {
      writer.write(chunk)
    })
    res.data.on("end", () => {
      writer.end()
      resolve()
    })
    res.data.on("error", (err) => {
      writer.end()
      reject(err)
    })
  })
}

// Helper function for safer PDF loading
export async function safeLoadPDF(pdfPath: string): Promise<Document[]> {
  try {
    const loader = new PDFLoader(pdfPath)
    // @ts-ignore
    return await loader.load()
  } catch (error) {
    const { name, message } = error as Error
    if (
      message.includes("PasswordException") ||
      name.includes("PasswordException")
    ) {
      Logger.warn("Password protected PDF, skipping")
    } else {
      Logger.error(error, `PDF load error: ${error}`)
    }
    return []
  }
}
