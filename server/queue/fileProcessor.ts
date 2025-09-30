import { getLogger } from "@/logger"
import { Subsystem, ProcessingJobType } from "@/types"
import { getErrorMessage } from "@/utils"
import { FileProcessorService } from "@/services/fileProcessor"
import { insert } from "@/search/vespa"
import { Apps, KbItemsSchema, KnowledgeBaseEntity } from "@xyne/vespa-ts/types"
import { getBaseMimeType } from "@/integrations/dataSource/config"
import { db } from "@/db/client"
import { collectionItems, collections } from "@/db/schema"
import { eq } from "drizzle-orm"
import { readFile } from "node:fs/promises"
import { UploadStatus } from "@/shared/types"

const Logger = getLogger(Subsystem.Queue)

export interface FileProcessingJob {
  fileId: string
  type?: ProcessingJobType.FILE // Default type for backward compatibility
}

export interface CollectionProcessingJob {
  collectionId: string
  type: ProcessingJobType.COLLECTION
}

export interface FolderProcessingJob {
  folderId: string
  type: ProcessingJobType.FOLDER
}

export type ProcessingJob =
  | FileProcessingJob
  | CollectionProcessingJob
  | FolderProcessingJob

// Common retry handling function
async function handleRetryFailure(
  entityType: ProcessingJobType,
  entityId: string,
  currentRetryCount: number,
  errorMessage: string,
) {
  const newRetryCount = currentRetryCount + 1
  const maxRetries = 3 // Match pg-boss retryLimit

  if (newRetryCount >= maxRetries) {
    // Final attempt failed - mark as failed
    const updateData = {
      uploadStatus: UploadStatus.FAILED,
      statusMessage: `Processing failed after ${newRetryCount} attempts: ${errorMessage}`,
      retryCount: newRetryCount,
      updatedAt: new Date(),
    }

    if (entityType === ProcessingJobType.COLLECTION) {
      await db
        .update(collections)
        .set(updateData)
        .where(eq(collections.id, entityId))
    } else {
      await db
        .update(collectionItems)
        .set(updateData)
        .where(eq(collectionItems.id, entityId))
    }
  } else {
    // Update retry count but keep status as 'processing' for retries
    const updateData = {
      statusMessage: `Processing attempt ${newRetryCount} failed: ${errorMessage} (will retry)`,
      retryCount: newRetryCount,
      updatedAt: new Date(),
    }

    if (entityType === ProcessingJobType.COLLECTION) {
      await db
        .update(collections)
        .set(updateData)
        .where(eq(collections.id, entityId))
    } else {
      await db
        .update(collectionItems)
        .set(updateData)
        .where(eq(collectionItems.id, entityId))
    }
  }
}

export async function processJob(job: { data: ProcessingJob }) {
  const startTime = Date.now()

  // Debug logging to see what we receive
  Logger.info(`Raw job data: ${JSON.stringify(job.data)}`)

  const jobData = job.data
  const jobType = jobData.type || ProcessingJobType.FILE // Default to file for backward compatibility

  switch (jobType) {
    case ProcessingJobType.FILE:
      return await processFileJob(jobData as FileProcessingJob, startTime)
    case ProcessingJobType.COLLECTION:
      return await processCollectionJob(
        jobData as CollectionProcessingJob,
        startTime,
      )
    case ProcessingJobType.FOLDER:
      return await processFolderJob(jobData as FolderProcessingJob, startTime)
    default:
      throw new Error(`Unknown job type: ${jobType}`)
  }
}

async function processFileJob(jobData: FileProcessingJob, startTime: number) {
  const { fileId } = jobData

  // Get file details for processing with collection info (outside try block for error handling access)
  const fileDetails = await db
    .select({
      id: collectionItems.id,
      type: collectionItems.type,
      storagePath: collectionItems.storagePath,
      vespaDocId: collectionItems.vespaDocId,
      uploadStatus: collectionItems.uploadStatus,
      fileName: collectionItems.name,
      path: collectionItems.path,
      parentId: collectionItems.parentId,
      mimeType: collectionItems.mimeType,
      fileSize: collectionItems.fileSize,
      originalName: collectionItems.originalName,
      collectionId: collectionItems.collectionId,
      uploadedByEmail: collectionItems.uploadedByEmail,
      uploadedById: collectionItems.uploadedById,
      retryCount: collectionItems.retryCount,
      collectionName: collections.name,
    })
    .from(collectionItems)
    .innerJoin(collections, eq(collectionItems.collectionId, collections.id))
    .where(eq(collectionItems.id, fileId))
    .limit(1)

  if (!fileDetails.length) {
    Logger.warn(`File not found: ${fileId}`)
    return
  }

  const file = fileDetails[0]

  // Guard: only process real files
  if (file.type !== "file") {
    Logger.warn(`Item is not a file: ${fileId}`)
    return
  }

  try {
    Logger.info(`Processing file job: ${fileId}`)

    // Skip if already processed
    if (file.uploadStatus === UploadStatus.COMPLETED) {
      Logger.info(`File already processed: ${fileId}`)
      return
    }

    // Update status to processing
    await db
      .update(collectionItems)
      .set({
        uploadStatus: UploadStatus.PROCESSING,
        statusMessage: `Processing file: ${file.fileName}`,
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, fileId))

    Logger.info(`Processing file: ${file.fileName} at ${file.storagePath}`)

    // Check required fields
    if (!file.storagePath) {
      throw new Error(`No storage path for file: ${fileId}`)
    }

    if (!file.vespaDocId) {
      throw new Error(`No vespaDocId for file: ${fileId}`)
    }

    const fileBuffer = await readFile(file.storagePath)

    // Process file to extract content
    const processingResult = await FileProcessorService.processFile(
      fileBuffer,
      file.mimeType || "application/octet-stream",
      file.fileName,
      file.vespaDocId || "",
      file.storagePath,
    )

    // Create Vespa document with proper fileName (matching original logic)
    const targetPath = file.path
    
    // Reconstruct the original filePath (full path from collection root)
    const reconstructedFilePath = targetPath === "/" 
      ? file.fileName 
      : targetPath.substring(1) + file.fileName // Remove leading "/" and add filename
    
    const vespaFileName =
      targetPath === "/"
        ? file.collectionName + targetPath + reconstructedFilePath    // Uses full path for root
        : file.collectionName + targetPath + file.fileName            // Uses filename for nested

    const vespaDoc = {
      docId: file.vespaDocId,
      clId: file.collectionId,
      itemId: file.id,
      fileName: vespaFileName,
      app: Apps.KnowledgeBase as const,
      entity: KnowledgeBaseEntity.File,
      description: "",
      storagePath: file.storagePath,
      chunks: processingResult.chunks,
      chunks_pos: processingResult.chunks_pos,
      image_chunks: processingResult.image_chunks,
      image_chunks_pos: processingResult.image_chunks_pos,
      metadata: JSON.stringify({
        originalFileName: file.originalName || file.fileName,
        uploadedBy: file.uploadedByEmail || "system",
        chunksCount: processingResult.chunks.length,
        imageChunksCount: processingResult.image_chunks.length,
        processingMethod: getBaseMimeType(file.mimeType || "text/plain"),
        lastModified: Date.now(),
      }),
      createdBy: file.uploadedByEmail || "system",
      duration: 0,
      mimeType: getBaseMimeType(file.mimeType || "text/plain"),
      fileSize: file.fileSize || 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      clFd: file.parentId,
    }

    // Insert into Vespa
    await insert(vespaDoc, KbItemsSchema)

    // Update status to completed
    const chunksCount =
      processingResult.chunks.length + processingResult.image_chunks.length
    await db
      .update(collectionItems)
      .set({
        uploadStatus: UploadStatus.COMPLETED,
        statusMessage: `Successfully processed: ${chunksCount} chunks extracted from ${file.fileName}`,
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, fileId))

    const endTime = Date.now()
    Logger.info(
      `Successfully processed file: ${fileId} in ${endTime - startTime}ms`,
    )
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    Logger.error(error, `Failed to process file: ${fileId} - ${errorMessage}`)

    // Use common retry handling function
    await handleRetryFailure(
      ProcessingJobType.FILE,
      fileId,
      file.retryCount || 0,
      errorMessage,
    )

    throw error // Let pg-boss handle retries
  }
}

async function processCollectionJob(
  jobData: CollectionProcessingJob,
  startTime: number,
) {
  const { collectionId } = jobData

  // Get collection details first (outside try block for error handling access)
  const collection = await db
    .select({
      id: collections.id,
      name: collections.name,
      description: collections.description,
      vespaDocId: collections.vespaDocId,
      lastUpdatedByEmail: collections.lastUpdatedByEmail,
      metadata: collections.metadata,
      retryCount: collections.retryCount,
    })
    .from(collections)
    .where(eq(collections.id, collectionId))
    .limit(1)

  if (!collection.length) {
    Logger.warn(`Collection not found: ${collectionId}`)
    return
  }

  const col = collection[0]

  try {
    Logger.info(`Processing collection Vespa insertion: ${collectionId}`)

    // Update status to processing
    await db
      .update(collections)
      .set({
        uploadStatus: UploadStatus.PROCESSING,
        statusMessage: `Processing collection: ${col.name}`,
        updatedAt: new Date(),
      })
      .where(eq(collections.id, collectionId))

    // Create Vespa document for collection
    const vespaDoc = {
      docId: col.vespaDocId,
      clId: col.id,
      itemId: col.id,
      fileName: col.name,
      app: Apps.KnowledgeBase as const,
      entity: KnowledgeBaseEntity.Collection,
      description: col.description || "",
      storagePath: "",
      chunks: [],
      image_chunks: [],
      chunks_pos: [],
      image_chunks_pos: [],
      metadata: JSON.stringify({
        version: "1.0",
        lastModified: Date.now(),
        ...(typeof col.metadata === "object" && col.metadata
          ? col.metadata
          : {}),
      }),
      createdBy: col.lastUpdatedByEmail || "system",
      duration: 0,
      mimeType: "knowledge_base",
      fileSize: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      clFd: null,
    }

    // Insert into Vespa
    await insert(vespaDoc, KbItemsSchema)

    // Update status to completed
    await db
      .update(collections)
      .set({
        uploadStatus: UploadStatus.COMPLETED,
        statusMessage: `Successfully processed collection Vespa insertion`,
        updatedAt: new Date(),
      })
      .where(eq(collections.id, collectionId))

    const endTime = Date.now()
    Logger.info(
      `Successfully processed collection Vespa insertion: ${collectionId} in ${endTime - startTime}ms`,
    )
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    Logger.error(
      error,
      `Failed to process collection Vespa insertion: ${collectionId} - ${errorMessage}`,
    )

    // Use common retry handling function with existing collection data
    await handleRetryFailure(
      ProcessingJobType.COLLECTION,
      collectionId,
      col.retryCount || 0,
      errorMessage,
    )

    throw error // Let pg-boss handle retries
  }
}

async function processFolderJob(
  jobData: FolderProcessingJob,
  startTime: number,
) {
  const { folderId } = jobData

  // Get folder details first (outside try block for error handling access)
  const folder = await db
    .select({
      id: collectionItems.id,
      name: collectionItems.name,
      type: collectionItems.type,
      vespaDocId: collectionItems.vespaDocId,
      collectionId: collectionItems.collectionId,
      parentId: collectionItems.parentId,
      lastUpdatedByEmail: collectionItems.lastUpdatedByEmail,
      metadata: collectionItems.metadata,
      retryCount: collectionItems.retryCount,
    })
    .from(collectionItems)
    .where(eq(collectionItems.id, folderId))
    .limit(1)

  if (!folder.length) {
    Logger.warn(`Folder not found: ${folderId}`)
    return
  }

  const fol = folder[0]

  if (fol.type !== "folder") {
    Logger.warn(`Item is not a folder: ${folderId}`)
    return
  }

  try {
    Logger.info(`Processing folder Vespa insertion: ${folderId}`)

    // Check required fields
    if (!fol.vespaDocId) {
      throw new Error(`No vespaDocId for folder: ${folderId}`)
    }

    // Update status to processing
    await db
      .update(collectionItems)
      .set({
        uploadStatus: UploadStatus.PROCESSING,
        statusMessage: `Processing folder: ${fol.name}`,
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, folderId))

    // Create Vespa document for folder
    const vespaDoc = {
      docId: fol.vespaDocId,
      clId: fol.collectionId,
      itemId: fol.id,
      app: Apps.KnowledgeBase as const,
      fileName: fol.name,
      entity: KnowledgeBaseEntity.Folder,
      description: (fol.metadata as any)?.description || "",
      storagePath: "",
      chunks: [],
      image_chunks: [],
      chunks_pos: [],
      image_chunks_pos: [],
      metadata: JSON.stringify({
        version: "1.0",
        lastModified: Date.now(),
        tags: (fol.metadata as any)?.tags || [],
      }),
      createdBy: fol.lastUpdatedByEmail || "system",
      duration: 0,
      mimeType: "folder",
      fileSize: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      clFd: fol.parentId || null,
    }

    // Insert into Vespa
    await insert(vespaDoc, KbItemsSchema)

    // Update status to completed
    await db
      .update(collectionItems)
      .set({
        uploadStatus: UploadStatus.COMPLETED,
        statusMessage: `Successfully processed folder Vespa insertion`,
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, folderId))

    const endTime = Date.now()
    Logger.info(
      `Successfully processed folder Vespa insertion: ${folderId} in ${endTime - startTime}ms`,
    )
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    Logger.error(
      error,
      `Failed to process folder Vespa insertion: ${folderId} - ${errorMessage}`,
    )

    // Use common retry handling function with existing folder data
    await handleRetryFailure(
      ProcessingJobType.FOLDER,
      folderId,
      fol.retryCount || 0,
      errorMessage,
    )

    throw error // Let pg-boss handle retries
  }
}
