import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import { boss } from "@/queue"
import { FileProcessingQueue } from "@/queue/api-server-queue"
import { processFileJob, type FileProcessingJob } from "@/queue/fileProcessor"
import { db } from "@/db/client"
import { collectionItems } from "@/db/schema"
import { eq } from "drizzle-orm"

const Logger = getLogger(Subsystem.Queue)

// File processing worker using boss.work() - non-blocking and event-driven
export const initFileProcessingWorker = async () => {
  Logger.info("Initializing file processing worker...")
  
  await boss.work(FileProcessingQueue, async ([job]) => {
      try {
        const fileId = (job.data as FileProcessingJob).fileId
        Logger.info(`Processingsss file: ${fileId}`)
        
        // Get file info from database
        const fileItem = await db
          .select({ name: collectionItems.name })
          .from(collectionItems)
          .where(eq(collectionItems.id, fileId))
          .limit(1)
        
        const fileName = fileItem[0]?.name || 'Unknown'
        
        // Update status to 'processing'
        await db
          .update(collectionItems)
          .set({ 
            uploadStatus: 'processing',
            statusMessage: `Processing file: ${fileName}`,
            updatedAt: new Date()
          })
          .where(eq(collectionItems.id, fileId))
        
        // Process the file
        await processFileJob(job as { data: FileProcessingJob })
        
        // Update status to 'completed'
        await db
          .update(collectionItems)
          .set({ 
            uploadStatus: 'completed',
            statusMessage: 'File processed successfully',
            updatedAt: new Date()
          })
          .where(eq(collectionItems.id, fileId))
        
        Logger.info(`✅ File ${fileId} processed successfully`)
        
      } catch (error) {
        const fileId = (job.data as FileProcessingJob).fileId
        const errorMessage = getErrorMessage(error)
        Logger.error(error, `❌ File ${fileId} failed: ${errorMessage}`)
        
        // Update status to 'failed' - pg-boss will handle retries automatically
        // This will only run on the final failure (after all retries exhausted)
        await db
          .update(collectionItems)
          .set({ 
            uploadStatus: 'failed',
            statusMessage: `Processing failed: ${errorMessage}`,
            updatedAt: new Date()
          })
          .where(eq(collectionItems.id, fileId))
        
        // Re-throw to let pg-boss handle the retry logic
        throw error
      }
    }
  )
  
  Logger.info("File processing worker initialized successfully")
}