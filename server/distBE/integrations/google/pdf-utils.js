import { DeleteDocumentError } from "../../errors/index.js"
import { getLogger } from "../../logger/index.js"
import { Apps, DriveEntity } from "../../search/types.js"
import { Subsystem } from "../../types.js"
const Logger = getLogger(Subsystem.Integrations).child({ module: "google" })
import { unlink } from "node:fs/promises"
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf"
import path from "node:path"
export const downloadDir = path.resolve(import.meta.dirname, "../../downloads")
export const deleteDocument = async (filePath) => {
  try {
    await unlink(filePath)
    Logger.info(`File at ${filePath} deleted successfully`)
  } catch (err) {
    Logger.error(
      err,
      `Error deleting file at ${filePath}: ${err} ${err.stack}`,
      err,
    )
    throw new DeleteDocumentError({
      message: "Error in the catch of deleting file",
      cause: err,
      integration: Apps.GoogleDrive,
      entity: DriveEntity.PDF,
    })
  }
}
export const downloadPDF = async (drive, fileId, fileName) => {
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
export async function safeLoadPDF(pdfPath) {
  try {
    const loader = new PDFLoader(pdfPath)
    // @ts-ignore
    return await loader.load()
  } catch (error) {
    const { name, message } = error
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
