import type { Context } from "hono"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path, { dirname, join } from "node:path"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import {
  type DataSourceUploadResult,
  DeleteImages,
  handleSingleFileUploadToDataSource,
} from "@/api/dataSource"
import { getUserByEmail } from "@/db/user"
import { db } from "@/db/client"
import {
  checkIfDataSourceFileExistsByNameAndId,
  DeleteDocument,
  getDataSourceByNameAndCreator,
  insert,
  GetDocument,
} from "../search/vespa"
import { NoUserFound } from "@/errors"
import config from "@/config"
import { HTTPException } from "hono/http-exception"
import { isValidFile, isImageFile, getFileType } from "shared/fileUtils"
import { generateThumbnail, getThumbnailPath } from "@/utils/image"
import { attachmentFileTypeMap, type AttachmentMetadata } from "@/shared/types"
import { FileProcessorService, type SheetProcessingResult } from "@/services/fileProcessor"
import { Apps, fileSchema, KbItemsSchema } from "@xyne/vespa-ts/types"
import { getBaseMimeType } from "@/integrations/dataSource/config"
import { isDataSourceError } from "@/integrations/dataSource/errors"
import { handleAttachmentDeleteSchema } from "./search"
import { getErrorMessage } from "@/utils"
import { expandSheetIds } from "@/search/utils"
import { promises as fs } from "node:fs"
import { generateStorageKey } from "@/db/knowledgeBase"
import { getStoragePath } from "./knowledgeBase"

const { JwtPayloadKey } = config
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
        const errorMessage = isDataSourceError(error)
          ? error.userMessage
          : error instanceof Error
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
    const user = userRes[0]

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
      const fileId = `attf_${crypto.randomUUID()}`
      let vespaId = fileId
      const ext = file.name.split(".").pop()?.toLowerCase() || ""
      const fullFileName = `${0}.${ext}`
      const isImage = isImageFile(file.type)
      let outputDir: string | undefined
      let filePath: string | undefined
      let attachmentApiUrl: string | undefined
      let attachmentThumbnailUrl: string | undefined

      try {
        if (isImage) {
          // For images: save to disk and generate thumbnail
          const baseDir = path.resolve(
            process.env.IMAGE_DIR || "downloads/xyne_images_db",
          )
          outputDir = path.join(baseDir, fileId)

          await mkdir(outputDir, { recursive: true })
          filePath = path.join(outputDir, fullFileName)
          await Bun.write(filePath, new Uint8Array(fileBuffer))

          // Generate thumbnail for images
          const thumbnailPath = getThumbnailPath(outputDir, fileId)
          await generateThumbnail(Buffer.from(fileBuffer), thumbnailPath)

          // Use opaque fileId in URLs instead of absolute file paths
          attachmentApiUrl = `/api/v1/attachments/${fileId}`
          attachmentThumbnailUrl = `/api/v1/attachments/${fileId}/thumbnail`
          const vespaDoc = {
            title: file.name,
            url: attachmentApiUrl,
            app: Apps.Attachment,
            docId: fileId,
            parentId: null,
            owner: email,
            photoLink: "",
            ownerEmail: email,
            entity: attachmentFileTypeMap[getFileType({ type: file.type, name: file.name })],
            chunks: [],
            chunks_pos: [],
            image_chunks: [`${file.name}`],
            image_chunks_pos: [0],
            chunks_map: [],
            image_chunks_map: [],
            permissions: [email],
            mimeType: getBaseMimeType(file.type),
            metadata: JSON.stringify({
              thumbnailUrl: attachmentThumbnailUrl,
              filePath: filePath,
              thumbnailPath: thumbnailPath,
            }),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }

          await insert(vespaDoc, fileSchema)
        } else {
          // Save attachments to disk in a structured way:
          // {cwd}/storage/kb_files/{workspaceExternalId}/{collectionId}/{year}/{month}/{storageKey}_{fileName}
          // collectionId is derived from workspaceExternalId and userId to create a unique namespace per user
          const collectionId = `attachments_${user.workspaceExternalId}_${user.id}`
          const storageKey = generateStorageKey()
          // Calculate storage path and assign to outer filePath variable
          filePath = getStoragePath(
            user.workspaceExternalId,
            collectionId,
            storageKey,
            file.name,
          )
  
          // Ensure directory exists
          await mkdir(dirname(filePath), { recursive: true })
  
          // Write file to disk
          await writeFile(filePath, new Uint8Array(fileBuffer))

          // For non-images: process through FileProcessorService and ingest into file schema

          // Process the file content using FileProcessorService
          const processingResults = await FileProcessorService.processFile(
            Buffer.from(fileBuffer),
            file.type,
            file.name,
            fileId,
            undefined,
            true,
            false,
            false,
          )

          if(processingResults.length > 0 && 'totalSheets' in processingResults[0]) {
            vespaId = `${fileId}_sheet_${(processingResults[0] as SheetProcessingResult).totalSheets}`
          }
          // Handle multiple processing results (e.g., for spreadsheets with multiple sheets)
          for (const [resultIndex, processingResult] of processingResults.entries()) {
            let docId = fileId
            let fileName = file.name

            // For sheet processing results, append sheet information
            if ('sheetName' in processingResult) {
              const sheetResult = processingResult as SheetProcessingResult
              fileName = processingResults.length > 1 
                ? `${file.name} / ${sheetResult.sheetName}`
                : file.name
              docId = sheetResult.docId
            }

            loggerWithChild({ email }).info(
              `Processed non-image file "${fileName}" with ${processingResult.chunks.length} text chunks and ${processingResult.image_chunks.length} image chunks`,
            )

            const { chunks, chunks_pos, image_chunks, image_chunks_pos } =
              processingResult

            // Use opaque fileId in URLs instead of absolute file paths
            attachmentApiUrl = `/api/v1/attachments/${docId}`
            const vespaDoc = {
              title: file.name,
              url: attachmentApiUrl,
              app: Apps.Attachment,
              docId: docId,
              parentId: null,
              owner: email,
              photoLink: "",
              ownerEmail: email,
              entity: attachmentFileTypeMap[getFileType({ type: file.type, name: file.name })],
              chunks: chunks,
              chunks_pos: chunks_pos,
              image_chunks: image_chunks,
              image_chunks_pos: image_chunks_pos,
              chunks_map: processingResult.chunks_map,
              image_chunks_map: processingResult.image_chunks_map,
              permissions: [email],
              mimeType: getBaseMimeType(file.type || "text/plain"),
              metadata: JSON.stringify({
                originalFileName: file.name,
                uploadedBy: email,
                chunksCount: chunks.length,
                imageChunksCount: image_chunks.length,
                processingMethod: getBaseMimeType(file.type || "text/plain"),
                lastModified: Date.now(),
                filePath: filePath,
                ...(('sheetName' in processingResult) && {
                  sheetName: (processingResult as SheetProcessingResult).sheetName,
                  sheetIndex: (processingResult as SheetProcessingResult).sheetIndex,
                  totalSheets: (processingResult as SheetProcessingResult).totalSheets,
                }),
              }),
              createdAt: Date.now(),
              updatedAt: Date.now(),
            }

            await insert(vespaDoc, fileSchema)
          }
        }

        // Create attachment metadata
        // Encode the storagePath so slashes in the absolute path don't break the URL
        const metadata: AttachmentMetadata = {
          fileId: vespaId,
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          isImage,
          thumbnailUrl: attachmentThumbnailUrl,
          createdAt: new Date(),
          url: attachmentApiUrl,
        }

        attachmentMetadata.push(metadata)

        loggerWithChild({ email }).info(
          `Attachment "${file.name}" processed with ID ${vespaId}${isImage ? " (saved to disk with thumbnail)" : " (processed and ingested into Vespa)"}`,
        )
      } catch (error) {
        // Cleanup: remove the directory if file write fails (only for images)
        if (isImage && outputDir) {
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
        } else if (!isImage && filePath) {
          // Cleanup non-image file if processing or DB insert fails
          try {
            await fs.unlink(filePath)
            loggerWithChild({ email }).warn(
              `Cleaned up file ${filePath} after failed processing`,
            )
            // Try to remove empty parent directories
            let currentDir = dirname(filePath)
            const storageBaseDir = join(process.cwd(), "storage", "kb_files")
            while (currentDir !== storageBaseDir && currentDir.length > storageBaseDir.length) {
              const entries = await fs.readdir(currentDir).catch(() => null)
              if (entries && entries.length === 0) {
                await fs.rmdir(currentDir).catch(() => {})
                currentDir = dirname(currentDir)
              } else {
                break
              }
            }
          } catch (cleanupError) {
            loggerWithChild({ email }).error(
              cleanupError,
              `Failed to cleanup file ${filePath} after processing error`,
            )
          }
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

export const handleAttachmentDelete = async (attachments: AttachmentMetadata [], email: string) => {
  const imageAttachmentFileIds: string[] = []
  const nonImageAttachmentFileIds: string[] = []

  for (const attachment of attachments) {
    if (attachment && typeof attachment === "object") {
      if (attachment.fileId) {
        // Check if this is an image attachment using both isImage field and fileType
        const isImageAttachment =
          attachment.isImage ||
          (attachment.fileType && isImageFile(attachment.fileType))

        if (isImageAttachment) {
          imageAttachmentFileIds.push(attachment.fileId)
        } else {
          nonImageAttachmentFileIds.push(attachment.fileId)
        }
      }
    }
  }

  // Delete image attachments and their thumbnails from disk
  if (imageAttachmentFileIds.length > 0) {
    loggerWithChild({ email: email }).info(
      `Deleting ${imageAttachmentFileIds.length} image attachment files and their thumbnails`,
    )

    for (const fileId of imageAttachmentFileIds) {
      try {
        // Validate fileId to prevent path traversal
        if (
          fileId.includes("..") ||
          fileId.includes("/") ||
          fileId.includes("\\")
        ) {
          loggerWithChild({ email: email }).error(
            `Invalid fileId detected: ${fileId}. Skipping deletion for security.`,
          )
          continue
        }
        const imageBaseDir = path.resolve(
          process.env.IMAGE_DIR || "downloads/xyne_images_db",
        )

        const imageDir = path.join(imageBaseDir, fileId)
        try {
          await fs.access(imageDir)
          await fs.rm(imageDir, { recursive: true, force: true })
          await DeleteDocument(fileId, fileSchema)
          
          loggerWithChild({ email: email }).info(
            `Deleted image attachment directory: ${imageDir}`,
          )
        } catch (attachmentError) {
          loggerWithChild({ email: email }).warn(
            `Image attachment file ${fileId} not found in either directory during chat deletion`,
          )
        }
      } catch (error) {
        loggerWithChild({ email: email }).error(
          error,
          `Failed to delete image attachment file ${fileId} during chat deletion: ${getErrorMessage(error)}`,
        )
      }
    }
  }

  // Delete non-image attachments from Vespa and disk
  if (nonImageAttachmentFileIds.length > 0) {
    loggerWithChild({ email: email }).info(
      `Deleting ${nonImageAttachmentFileIds.length} non-image attachments from Vespa and disk`,
    )

    for (const fileId of nonImageAttachmentFileIds) {
      try {
        const vespaIds = expandSheetIds(fileId)
        for (const vespaId of vespaIds) {
          // Get the document to retrieve file path from metadata before deletion
          let filePathToDelete: string | undefined
          try {
            const doc = await GetDocument(fileSchema, vespaId)
            if (doc?.fields) {
              const fields = doc.fields as any
              const metadata = fields.metadata ? JSON.parse(fields.metadata as string) : {}
              filePathToDelete = metadata.filePath
            }
          } catch (getErr) {
            loggerWithChild({ email: email }).warn(
              `Could not fetch document ${vespaId} for file path: ${getErrorMessage(getErr)}`,
            )
          }

          // Delete from Vespa kb_items or file schema
          if (vespaId.startsWith("att_")) {
            await DeleteDocument(vespaId, KbItemsSchema)
          } else {
            await DeleteDocument(vespaId, fileSchema)
          }
          // Delete images from disk
          await DeleteImages(vespaId)

          // Delete the file from disk
          if (filePathToDelete) {
            try {
              const resolvedPath = path.resolve(filePathToDelete)
              const storageBaseDir = path.resolve(join(process.cwd(), "storage", "kb_files"))
              
              // Security: ensure path is under allowed directory
              if (resolvedPath.startsWith(storageBaseDir + path.sep) || resolvedPath.startsWith(storageBaseDir + "/")) {
                await fs.unlink(resolvedPath)
                loggerWithChild({ email: email }).info(
                  `Deleted non-image attachment file from disk: ${resolvedPath}`,
                )
                
                // Try to remove empty parent directories
                let currentDir = dirname(resolvedPath)
                while (currentDir !== storageBaseDir && currentDir.length > storageBaseDir.length) {
                  const entries = await fs.readdir(currentDir).catch(() => null)
                  if (entries && entries.length === 0) {
                    await fs.rmdir(currentDir).catch(() => {})
                    currentDir = dirname(currentDir)
                  } else {
                    break
                  }
                }
              } else {
                loggerWithChild({ email: email }).warn(
                  `Skipping file deletion - path outside allowed directory: ${resolvedPath}`,
                )
              }
            } catch (fileDeleteErr) {
              const fileDeleteMsg = getErrorMessage(fileDeleteErr)
              if (!fileDeleteMsg.includes("ENOENT") && !fileDeleteMsg.includes("no such file")) {
                loggerWithChild({ email: email }).error(
                  fileDeleteErr,
                  `Failed to delete non-image attachment file from disk: ${filePathToDelete}`,
                )
              }
            }
          }

          loggerWithChild({ email: email }).info(
            `Successfully deleted non-image attachment ${vespaId} from Vespa and disk`,
          )
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error)
        if (errorMessage.includes("404 Not Found")) {
          loggerWithChild({ email: email }).warn(
            `Non-image attachment ${fileId} not found in Vespa (may have been already deleted)`,
          )
        } else {
          loggerWithChild({ email: email }).error(
            error,
            `Failed to delete non-image attachment ${fileId} from Vespa: ${errorMessage}`,
          )
        }
      }
    }
  }
}

export const handleAttachmentDeleteApi = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  const email = sub

  const { attachment } = handleAttachmentDeleteSchema.parse(await c.req.json())
  const fileId = attachment.fileId
  if (!fileId) {
    throw new HTTPException(400, { message: "File ID is required" })
  }

  try {
    // Get the attachment document from the file schema
    const attachmentDoc = await GetDocument(fileSchema, expandSheetIds(fileId)[0])

    if (!attachmentDoc || !attachmentDoc.fields) {
      return c.json({ success: true, message: "Attachment already deleted" })
    }

    // Check permissions - file schema has permissions array
    const fields = attachmentDoc.fields as any
    const permissions = Array.isArray(fields.permissions) ? fields.permissions as string[] : []
    if (!permissions.includes(email)) {
      throw new HTTPException(403, { message: "Access denied to this attachment" })
    }
    
    await handleAttachmentDelete([attachment], email)
    return c.json({ success: true, message: "Attachment deleted successfully" })
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error
    }
    loggerWithChild({ email }).error({ err: error }, "Error checking attachment permissions")
    throw new HTTPException(500, { message: "Internal server error" })
  }
}

/**
 * Serve attachment file by fileId
 * Resolves fileId to physical path via Vespa lookup to avoid exposing server internals.
 * Security: the resolved path must be under one of the allowed base directories.
 */
export const handleAttachmentServe = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  const email = sub

  try {
    const fileId = c.req.param("fileId")
    if (!fileId) {
      throw new HTTPException(400, { message: "File ID is required" })
    }

    // Validate fileId to prevent path traversal
    if (fileId.includes("..") || fileId.includes("/") || fileId.includes("\\")) {
      throw new HTTPException(400, { message: "Invalid file ID" })
    }

    // Look up the attachment document in Vespa to get the file path
    const attachmentDoc = await GetDocument(fileSchema, expandSheetIds(fileId)[0])

    if (!attachmentDoc || !attachmentDoc.fields) {
      throw new HTTPException(404, { message: "Attachment not found" })
    }

    // Check permissions
    const fields = attachmentDoc.fields as any
    const permissions = Array.isArray(fields.permissions) ? (fields.permissions as string[]) : []
    if (!permissions.includes(email)) {
      throw new HTTPException(403, { message: "Access denied" })
    }

    // Get file path from metadata
    let resolvedPath: string | undefined
    const metadata = fields.metadata ? JSON.parse(fields.metadata as string) : {}
    resolvedPath = metadata.filePath

    if (!resolvedPath) {
      throw new HTTPException(404, { message: "File path not found for attachment" })
    }

    // Security: resolve the path and ensure it is under one of the allowed base directories
    resolvedPath = path.resolve(resolvedPath)

    const allowedBaseDirs = [
      path.resolve(process.env.IMAGE_DIR || "downloads/xyne_images_db"),
      path.resolve(join(process.cwd(), "storage", "kb_files")),
    ]

    const isAllowed = allowedBaseDirs.some((baseDir) =>
      resolvedPath.startsWith(baseDir + path.sep) || resolvedPath.startsWith(baseDir + "/"),
    )

    if (!isAllowed) {
      loggerWithChild({ email }).error(
        `Attempted to access file outside allowed directories: ${resolvedPath}`,
      )
      throw new HTTPException(403, { message: "Access denied" })
    }

    // Check if file exists at the resolved path
    const file = Bun.file(resolvedPath)
    if (!(await file.exists())) {
      throw new HTTPException(404, { message: "File not found" })
    }

    const fileName = fields.title || path.basename(resolvedPath)
    const fileType = file.type || fields.mimeType || "application/octet-stream"

    loggerWithChild({ email }).info(
      `Serving attachment ${fileId} at ${resolvedPath} for user ${email}`,
    )

    // Set appropriate headers
    c.header("Content-Type", fileType)
    c.header(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    )
    c.header("Cache-Control", "public, max-age=31536000") // Cache for 1 year

    // Stream the file
    return new Response(file.stream(), {
      headers: c.res.headers,
    })
  } catch (error) {
    loggerWithChild({ email }).error(
      error,
      `Error serving attachment`,
    )
    throw error
  }
}

/**
 * Serve thumbnail for attachment by fileId
 * Resolves fileId to physical path via Vespa lookup to avoid exposing server internals.
 * Security: the resolved path must be under one of the allowed base directories.
 */
export const handleThumbnailServe = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  const email = sub

  try {
    const fileId = c.req.param("fileId")
    if (!fileId) {
      throw new HTTPException(400, { message: "File ID is required" })
    }

    // Validate fileId to prevent path traversal
    if (fileId.includes("..") || fileId.includes("/") || fileId.includes("\\")) {
      throw new HTTPException(400, { message: "Invalid file ID" })
    }

    // Look up the attachment document in Vespa to get the thumbnail path
    const attachmentDoc = await GetDocument(fileSchema, expandSheetIds(fileId)[0])

    if (!attachmentDoc || !attachmentDoc.fields) {
      throw new HTTPException(404, { message: "Attachment not found" })
    }

    // Check permissions
    const fields = attachmentDoc.fields as any
    const permissions = Array.isArray(fields.permissions) ? (fields.permissions as string[]) : []
    if (!permissions.includes(email)) {
      throw new HTTPException(403, { message: "Access denied" })
    }

    // Get thumbnail path from metadata
    let resolvedPath: string | undefined
    const metadata = fields.metadata ? JSON.parse(fields.metadata as string) : {}
    resolvedPath = metadata.thumbnailPath

    if (!resolvedPath) {
      throw new HTTPException(404, { message: "Thumbnail not found for attachment" })
    }

    // Security: resolve the path and ensure it is under one of the allowed base directories
    resolvedPath = path.resolve(resolvedPath)

    const allowedBaseDirs = [
      path.resolve(process.env.IMAGE_DIR || "downloads/xyne_images_db"),
      path.resolve(join(process.cwd(), "storage", "kb_files")),
    ]

    const isAllowed = allowedBaseDirs.some((baseDir) =>
      resolvedPath.startsWith(baseDir + path.sep) || resolvedPath.startsWith(baseDir + "/"),
    )

    if (!isAllowed) {
      loggerWithChild({ email }).error(
        `Attempted to access file outside allowed directories: ${resolvedPath}`,
      )
      throw new HTTPException(403, { message: "Access denied" })
    }

    // Check if file exists at the resolved path
    const file = Bun.file(resolvedPath)
    if (!(await file.exists())) {
      throw new HTTPException(404, { message: "Thumbnail file not found" })
    }

    // Set appropriate headers for thumbnail
    c.header("Content-Type", "image/jpeg")
    c.header("Cache-Control", "public, max-age=31536000") // Cache for 1 year

    // Stream the thumbnail
    return new Response(file.stream(), {
      headers: c.res.headers,
    })
  } catch (error) {
    loggerWithChild({ email }).error(
      error,
      `Error serving thumbnail for fileId ${c.req.param("fileId")}`,
    )
    throw error
  }
}
