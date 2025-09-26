import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import { FileProcessorService } from "@/services/fileProcessor"
import { insert } from "@/search/vespa"
import { Apps, KbItemsSchema, KnowledgeBaseEntity } from "@xyne/vespa-ts/types"
import { getBaseMimeType } from "@/integrations/dataSource/config"
import { db } from "@/db/client"
import { collectionItems } from "@/db/schema"
import { eq } from "drizzle-orm"
import { readFile } from "node:fs/promises"

const Logger = getLogger(Subsystem.Queue)

export interface FileProcessingJob {
  fileId: string
}

export async function processFileJob(job: { data: FileProcessingJob }) {
  const startTime = Date.now()
  
  // Debug logging to see what we receive
  Logger.info(`Raw job data: ${JSON.stringify(job.data)}`)
  
  const { fileId } = job.data
  
  try {
    Logger.info(`Processing file job: ${fileId}`)
    
    // Get file details for processing
    const fileDetails = await db
      .select({
        id: collectionItems.id,
        storagePath: collectionItems.storagePath,
        vespaDocId: collectionItems.vespaDocId,
        uploadStatus: collectionItems.uploadStatus,
        fileName: collectionItems.name,
        mimeType: collectionItems.mimeType,
        fileSize: collectionItems.fileSize,
        originalName: collectionItems.originalName,
        collectionId: collectionItems.collectionId,
      })
      .from(collectionItems)
      .where(eq(collectionItems.id, fileId))
      .limit(1)

    if (!fileDetails.length) {
      Logger.warn(`File not found: ${fileId}`)
      return
    }

    const file = fileDetails[0]
    
    // Skip if already processed
    if (file.uploadStatus === 'completed') {
      Logger.info(`File already processed: ${fileId}`)
      return
    }

    // Update status to processing
    await db
      .update(collectionItems)
      .set({ 
        uploadStatus: 'processing',
        statusMessage: `Processing file: ${file.fileName}`,
        updatedAt: new Date()
      })
      .where(eq(collectionItems.id, fileId))

    Logger.info(`Processing file: ${file.fileName} at ${file.storagePath}`)

    // Read file from disk
    if (!file.storagePath) {
      throw new Error(`No storage path for file: ${fileId}`)
    }
    
    const fileBuffer = await readFile(file.storagePath)
    
    // Process file to extract content
    const processingResult = await FileProcessorService.processFile(
      fileBuffer,
      file.mimeType || "application/octet-stream",
      file.fileName,
      file.vespaDocId || "",
      file.storagePath
    )

    // Create Vespa document
    const vespaDoc = {
      docId: file.vespaDocId!,
      clId: file.collectionId,
      itemId: file.id,
      fileName: file.fileName,
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
        chunksCount: processingResult.chunks.length,
        imageChunksCount: processingResult.image_chunks.length,
        processingMethod: getBaseMimeType(file.mimeType || "text/plain"),
        lastModified: Date.now(),
      }),
      createdBy: "system", // We can get user later if needed
      duration: 0,
      mimeType: getBaseMimeType(file.mimeType || "text/plain"),
      fileSize: file.fileSize || 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    // Insert into Vespa
    await insert(vespaDoc, KbItemsSchema)

    // Update status to completed
    const chunksCount = processingResult.chunks.length + processingResult.image_chunks.length
    await db
      .update(collectionItems)
      .set({ 
        uploadStatus: 'completed',
        statusMessage: `Successfully processed: ${chunksCount} chunks extracted from ${file.fileName}`,
        processedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(collectionItems.id, fileId))

    const endTime = Date.now()
    Logger.info(`Successfully processed file: ${fileId} in ${endTime - startTime}ms`)

  } catch (error) {
    const errorMessage = getErrorMessage(error)
    Logger.error(error, `Failed to process file: ${fileId} - ${errorMessage}`)
    
    // Update status message but keep status as 'processing' for retries
    // Only mark as 'failed' when pg-boss gives up after all retries
    await db
      .update(collectionItems)
      .set({ 
        statusMessage: `Processing attempt failed: ${errorMessage} (will retry)`,
        updatedAt: new Date()
      })
      .where(eq(collectionItems.id, fileId))
    
    throw error // Let pg-boss handle retries
  }
}