import type { Context } from "hono"
import { mkdir, rm } from "node:fs/promises"
import path, { join } from "node:path"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import {
  type DataSourceUploadResult,
  handleSingleFileUploadToDataSource,
} from "@/api/dataSource"
import { getUserByEmail } from "@/db/user"
import { db } from "@/db/client"
import {
  checkIfDataSourceFileExistsByNameAndId,
  getDataSourceByNameAndCreator,
} from "../search/vespa"
import { NoUserFound } from "@/errors"
import config from "@/config"
import { HTTPException } from "hono/http-exception"
import { isValidFile } from "../../shared/filesutils"
import { generateThumbnail, isImageFile, getThumbnailPath } from "@/utils/image"
import type { AttachmentMetadata } from "@/shared/types"

const { JwtPayloadKey } = config
const Logger = getLogger(Subsystem.Api).child({ module: "newApps" })
const loggerWithChild = getLoggerWithChild(Subsystem.Api, { module: "newApps" })

const DOWNLOADS_DIR = join(process.cwd(), "downloads")
await mkdir(DOWNLOADS_DIR, { recursive: true })

interface FileUploadToDataSourceResult extends DataSourceUploadResult {
  filename: string
}

export const handleFileUpload = async (c: Context) => {
  let email = ""
  try {
    const { sub } = c.get(JwtPayloadKey)
    email = sub
    const userRes = await getUserByEmail(db, sub)
    if (!userRes || !userRes.length) {
      loggerWithChild({ email: email }).error(
        { sub },
        "No user found in file upload",
      )
      throw new NoUserFound({})
    }
    const [user] = userRes

    const formData = await c.req.formData()
    const files = formData.getAll("file") as File[]
    const datasourceName = formData.get("datasourceName") as string | null
    const flag = formData.get("flag") as "creation" | "addition" | null

    if (!datasourceName || datasourceName.trim() === "") {
      throw new HTTPException(400, { message: "Datasource name is required." })
    }

    let dataSourceId: string | undefined
    if (flag === "addition") {
      const dataSource = await getDataSourceByNameAndCreator(
        datasourceName,
        user.email,
      )
      if (!dataSource) {
        throw new HTTPException(404, {
          message: `Datasource "${datasourceName}" not found for user.`,
        })
      }
      dataSourceId = dataSource.docId
    }

    if (!flag || (flag !== "creation" && flag !== "addition")) {
      throw new HTTPException(400, {
        message: "Operation flag ('creation' or 'addition') is required.",
      })
    }

    if (!files.length) {
      throw new HTTPException(400, {
        message: "No files uploaded. Please upload at least one file",
      })
    }

    const invalidFiles = files.filter((file) => !isValidFile(file))
    if (invalidFiles.length > 0) {
      throw new HTTPException(400, {
        message: `${invalidFiles.length} file(s) rejected. Files must be under 40MB, images under 5MB and of supported types.`,
      })
    }

    loggerWithChild({ email: email }).info(
      { fileCount: files.length, email: user.email },
      "Processing uploaded files for DataSource",
    )

    const dataSourceProcessingResults: FileUploadToDataSourceResult[] = []
    const successfullyProcessedFiles: string[] = []
    const erroredFiles: { name: string; error: string }[] = []

    for (const file of files) {
      try {
        if (flag === "addition" && dataSourceId) {
          const fileExists = await checkIfDataSourceFileExistsByNameAndId(
            file.name,
            dataSourceId,
            user.email,
          )
          if (fileExists) {
            loggerWithChild({ email: email }).warn(
              `File "${file.name}" already exists in DataSource ID "${dataSourceId}" for user ${user.email}. Skipping.`,
            )
            erroredFiles.push({
              name: file.name,
              error: "Document already exists in this datasource.",
            })
            continue
          }
        }

        loggerWithChild({ email: email }).info(
          `Processing file "${file.name}" for DataSource for user ${user.email}`,
        )
        const result = await handleSingleFileUploadToDataSource({
          file,
          user,
          dataSourceName: datasourceName,
          flag,
        })
        dataSourceProcessingResults.push({
          filename: file.name,
          ...result,
        })
        successfullyProcessedFiles.push(file.name)
        loggerWithChild({ email: email }).info(
          `File "${file.name}" processed successfully for DataSource. Result: ${result.message}`,
        )
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : "Unknown error during DataSource processing"
        loggerWithChild({ email: email }).error(
          error,
          `Error processing file "${file.name}" for DataSource`,
        )
        erroredFiles.push({ name: file.name, error: errorMessage })
      }
    }

    const allProcessed = successfullyProcessedFiles.length === files.length
    const partialSuccess =
      successfullyProcessedFiles.length > 0 &&
      successfullyProcessedFiles.length < files.length

    let message = ""
    if (allProcessed) {
      message = `Successfully processed ${successfullyProcessedFiles.length} file(s) for DataSource.`
    } else if (partialSuccess) {
      message = `Processed ${successfullyProcessedFiles.length} file(s) successfully for DataSource. ${erroredFiles.length} file(s) failed.`
    } else if (
      erroredFiles.length > 0 &&
      successfullyProcessedFiles.length === 0
    ) {
      message = `Failed to process all ${erroredFiles.length} file(s) for DataSource.`
    } else {
      message = "No files were processed."
    }

    return c.json({
      success: successfullyProcessedFiles.length > 0,
      message,
      processedFiles: successfullyProcessedFiles,
      failedFiles: erroredFiles,
      dataSourceResults: dataSourceProcessingResults,
    })
  } catch (error) {
    loggerWithChild({ email: email }).error(
      error,
      "Error in file upload handler",
    )
    throw error
  }
}

export const handleAttachmentUpload = async (c: Context) => {
  let email = ""
  try {
    const { sub } = c.get(JwtPayloadKey)
    email = sub
    const userRes = await getUserByEmail(db, sub)
    if (!userRes || !userRes.length) {
      loggerWithChild({ email }).error(
        { sub },
        "No user found in attachment upload",
      )
      throw new NoUserFound({})
    }

    const formData = await c.req.formData()
    const files = formData.getAll("attachment") as File[]

    if (!files.length) {
      throw new HTTPException(400, {
        message: "No attachments uploaded. Please upload at least one file",
      })
    }

    const invalidFiles = files.filter((file) => !isValidFile(file))
    if (invalidFiles.length > 0) {
      throw new HTTPException(400, {
        message: `${invalidFiles.length} attachment(s) rejected. Files must be under 40MB, images under 5MB and of supported types.`,
      })
    }

    const attachmentMetadata: AttachmentMetadata[] = []

    for (const file of files) {
      const fileBuffer = await file.arrayBuffer()
      const fileId = crypto.randomUUID()
      const ext = file.name.split(".").pop()?.toLowerCase() || ""
      const fullFileName = `${0}.${ext}`
      const baseDir = isImageFile(file.type)
        ? path.resolve(process.env.IMAGE_DIR || "downloads/xyne_images_db")
        : path.resolve(
            process.env.ATTACHMENTS_DIR || "downloads/xyne_attachments",
          )
      const outputDir = path.join(baseDir, fileId)

      try {
        await mkdir(outputDir, { recursive: true })
        const filePath = path.join(outputDir, fullFileName)
        await Bun.write(filePath, new Uint8Array(fileBuffer))

        const isImage = isImageFile(file.type)
        let thumbnailPath: string | undefined

        // Generate thumbnail for images
        if (isImage) {
          thumbnailPath = getThumbnailPath(outputDir, fileId)
          await generateThumbnail(Buffer.from(fileBuffer), thumbnailPath)
        }

        // Create attachment metadata
        const metadata: AttachmentMetadata = {
          fileId,
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          isImage,
          thumbnailPath: thumbnailPath
            ? path.relative(baseDir, thumbnailPath)
            : undefined,
          createdAt: new Date(),
          url: `/api/v1/attachments/${fileId}`,
        }

        attachmentMetadata.push(metadata)

        loggerWithChild({ email }).info(
          `Attachment "${file.name}" stored with ID ${fileId}${isImage ? " (thumbnail generated)" : ""}`,
        )
      } catch (error) {
        // Cleanup: remove the directory if file write fails
        try {
          await rm(outputDir, { recursive: true, force: true })
          loggerWithChild({ email }).warn(
            `Cleaned up directory ${outputDir} after failed file write`,
          )
        } catch (cleanupError) {
          loggerWithChild({ email }).error(
            cleanupError,
            `Failed to cleanup directory ${outputDir} after file write error`,
          )
        }
        throw error
      }
    }

    return c.json({
      success: true,
      attachments: attachmentMetadata,
      message: `Stored ${attachmentMetadata.length} attachment(s) successfully.`,
    })
  } catch (error) {
    loggerWithChild({ email }).error(
      error,
      "Error in attachment upload handler",
    )
    throw error
  }
}

/**
 * Serve attachment file by fileId
 */
export const handleAttachmentServe = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  const email = sub

  try {
    const fileId = c.req.param("fileId")
    if (!fileId) {
      throw new HTTPException(400, { message: "File ID is required" })
    }

    // First, try the legacy path structure
    const legacyBaseDir = path.resolve(
      process.env.IMAGE_DIR || "downloads/xyne_images_db",
    )
    const legacyDir = path.join(legacyBaseDir, fileId)

    // Check for files in legacy structure
    let filePath: string | null = null
    let fileName: string | null = null
    let fileType: string | null = null

    // Look for any file in the legacy directory
    const possibleExtensions = ["jpg", "jpeg", "png", "gif", "webp"]
    for (const ext of possibleExtensions) {
      const testPath = path.join(legacyDir, `0.${ext}`)
      const testFile = Bun.file(testPath)
      if (await testFile.exists()) {
        filePath = testPath
        fileName = `${fileId}.${ext}`
        fileType = testFile.type || `image/${ext}`
        break
      }
    }

    // Check if file exists
    const file = Bun.file(filePath || "")
    if (!(await file.exists())) {
      throw new HTTPException(404, { message: "File not found on disk" })
    }

    loggerWithChild({ email }).info(
      `Serving attachment ${fileId} (${fileName}) for user ${email}`,
    )

    // Set appropriate headers
    c.header("Content-Type", fileType || "application/octet-stream")
    c.header("Content-Disposition", `inline; filename="${fileName}"`)
    c.header("Cache-Control", "public, max-age=31536000") // Cache for 1 year

    // Stream the file
    return new Response(file.stream(), {
      headers: c.res.headers,
    })
  } catch (error) {
    loggerWithChild({ email }).error(
      error,
      `Error serving attachment ${c.req.param("fileId")}`,
    )
    throw error
  }
}

/**
 * Serve thumbnail for attachment
 */
export const handleThumbnailServe = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  const email = sub

  try {
    const fileId = c.req.param("fileId")
    if (!fileId) {
      throw new HTTPException(400, { message: "File ID is required" })
    }

    // First, try the legacy path structure
    const legacyBaseDir = path.resolve(
      process.env.IMAGE_DIR || "downloads/xyne_images_db",
    )
    const legacyThumbnailPath = path.join(
      legacyBaseDir,
      fileId,
      `${fileId}_thumbnail.jpg`,
    )

    let thumbnailPath = legacyThumbnailPath
    let thumbnailFile = Bun.file(thumbnailPath)

    // Check if thumbnail exists
    if (!(await thumbnailFile.exists())) {
      throw new HTTPException(404, { message: "Thumbnail not found on disk" })
    }

    loggerWithChild({ email }).info(
      `Serving thumbnail for ${fileId} for user ${email}`,
    )

    // Set appropriate headers for thumbnail
    c.header("Content-Type", "image/jpeg")
    c.header("Cache-Control", "public, max-age=31536000") // Cache for 1 year

    // Stream the thumbnail
    return new Response(thumbnailFile.stream(), {
      headers: c.res.headers,
    })
  } catch (error) {
    loggerWithChild({ email }).error(
      error,
      `Error serving thumbnail ${c.req.param("fileId")}`,
    )
    throw error
  }
}
