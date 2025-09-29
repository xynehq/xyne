import { getLogger } from "@/logger"
import { Subsystem, UploadStatus, ProcessingJobType } from "@/types"
import { getErrorMessage } from "@/utils"
import { boss } from "@/queue"
import { FileProcessingQueue } from "@/queue/api-server-queue"
import { processJob, type ProcessingJob } from "@/queue/fileProcessor"
import { db } from "@/db/client"
import { collectionItems } from "@/db/schema"
import { eq } from "drizzle-orm"

const Logger = getLogger(Subsystem.Queue)

// File processing worker using boss.work() - non-blocking and event-driven
export const initFileProcessingWorker = async () => {
  Logger.info("Initializing file processing worker...")
  
  await boss.work(FileProcessingQueue, async ([job]) => {
      try {
        const jobData = job.data as ProcessingJob
        const jobType = jobData.type || ProcessingJobType.FILE
        
        Logger.info(`Processing ${jobType} job: ${JSON.stringify(jobData)}`)
        
        // For file jobs, update status to processing (collections and folders don't need status updates)
        if (jobType === ProcessingJobType.FILE) {
          const fileId = (jobData as any).fileId
          
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
              uploadStatus: UploadStatus.PROCESSING,
              statusMessage: `Processing file: ${fileName}`,
              updatedAt: new Date()
            })
            .where(eq(collectionItems.id, fileId))
        }
        
        // Process the job using the unified processor
        await processJob(job as { data: ProcessingJob })
        
        // For file jobs, update status to completed
        if (jobType === ProcessingJobType.FILE) {
          const fileId = (jobData as any).fileId
          
          await db
            .update(collectionItems)
            .set({ 
              uploadStatus: UploadStatus.COMPLETED,
              statusMessage: 'File processed successfully',
              updatedAt: new Date()
            })
            .where(eq(collectionItems.id, fileId))
        }
        
        Logger.info(`✅ ${jobType} job processed successfully`)
        
      } catch (error) {
        const jobData = job.data as ProcessingJob
        const jobType = jobData.type || ProcessingJobType.FILE
        const errorMessage = getErrorMessage(error)
        Logger.error(error, `❌ ${jobType} job failed: ${errorMessage}`)
        
        // Let processFileJob manage status updates; just rethrow for pg-boss retries
        
        // Re-throw to let pg-boss handle the retry logic
        throw error
      }
    }
  )

  Logger.info("File processing worker initialized successfully")
}