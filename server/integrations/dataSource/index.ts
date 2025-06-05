import { Apps } from "@/search/types"
import { chunkDocument } from "@/chunks"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { insertDataSourceFile, NAMESPACE } from "@/search/vespa"
import { type VespaDataSourceFile, datasourceSchema } from "@/search/types"
import { randomUUID } from "crypto"
import { createId } from "@paralleldrive/cuid2"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "dataSourceIntegration",
})

// Function to process the file content for DataSourceFile
const processDataSourceFileContent = (
  content: string,
  fileName: string,
  userEmail: string,
  fileSize: number,
  dataSourceUserSpecificId: string,
  mimeType: string = "text/plain",
  description?: string,
): VespaDataSourceFile => {
  const chunks = chunkDocument(content).map((v) => v.chunk)
  const now = Date.now()
  const fileId = `dsf-${createId()}`

  return {
    docId: `${fileId}`,
    title: fileName,
    description: description || `File: ${fileName} for DataSource`,
    app: Apps.DataSource,
    fileName: fileName,
    fileSize,
    chunks,
    uploadedBy: userEmail,
    mimeType,
    createdAt: now,
    updatedAt: now,
    dataSourceRef: `id:${NAMESPACE}:${datasourceSchema}::${dataSourceUserSpecificId}`,
    metadata: JSON.stringify({
      originalFileName: fileName,
      uploadedBy: userEmail,
      chunksCount: chunks.length,
    }),
  }
}

// Main function to handle DataSource file upload and storage
export const handleDataSourceFileUpload = async (
  file: File,
  userEmail: string,
  dataSourceUserSpecificId: string,
  description?: string,
) => {
  try {
    if (
      !file ||
      !file.name ||
      typeof file.size !== "number" ||
      typeof file.text !== "function"
    ) {
      throw new Error("Invalid file object provided for DataSource processing.")
    }

    const content = await file.text()
    const processedFile = processDataSourceFileContent(
      content,
      file.name,
      userEmail,
      file.size,
      dataSourceUserSpecificId,
      file.type || "text/plain",
      description,
    )

    await insertDataSourceFile(processedFile)

    return {
      success: true,
      message: "DataSource file processed and stored successfully",
      docId: processedFile.docId,
      fileName: file.name,
    }
  } catch (error) {
    Logger.error(error, `Error processing DataSource file "${file.name}"`)
    throw error
  }
}
