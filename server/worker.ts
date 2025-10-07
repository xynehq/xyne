import { getLogger } from "@/logger"
import { Subsystem, ProcessingJobType } from "@/types"
import { getErrorMessage } from "@/utils"
import { boss } from "@/queue"
import { FileProcessingQueue, PdfFileProcessingQueue } from "@/queue/api-server-queue"
import { processJob, type ProcessingJob } from "@/queue/fileProcessor"
import config from "@/config"

const Logger = getLogger(Subsystem.Queue)

// Common worker initialization logic with proper individual job failure handling
async function createWorker(
  queueName: string,
  batchSize: number,
  workerType: string
) {
  Logger.info(`Initializing ${workerType} worker...`)
  Logger.info(`Using batch size of ${batchSize} for concurrent ${workerType}`)
  
  await boss.work(queueName, { batchSize }, async (jobs) => {
    // Process all jobs in parallel, but handle failures individually
    // so one failed job doesn't fail the entire batch.
    const jobPromises = jobs.map(async (job) => {
      try {
        const jobData = job.data as ProcessingJob
        const jobType = jobData.type || ProcessingJobType.FILE
        
        Logger.info(`Processing ${workerType} ${jobType} job: ${JSON.stringify(jobData)}`)

        // Process the job using the unified processor
        // The processJob function handles all status updates internally:
        // - Sets status to PROCESSING
        // - Sets status to COMPLETED after success
        // - Calls updateParentStatus to check parent completion
        await processJob(job as { data: ProcessingJob })

        Logger.info(`✅ ${workerType} ${jobType} job processed successfully`)
        
        // Explicitly mark the job as complete.
        await boss.complete(job.id)
      } catch (error) {
        const jobData = job.data as ProcessingJob
        const jobType = jobData.type || ProcessingJobType.FILE
        const errorMessage = getErrorMessage(error)
        Logger.error(error, `❌ ${workerType} ${jobType} job failed: ${errorMessage}`)
        
        // Explicitly fail the job to trigger pg-boss's retry mechanism for this job alone.
        await boss.fail(job.id)
      }
    })

    // Wait for all jobs in the batch to be either completed or failed.
    await Promise.all(jobPromises)
  })

  Logger.info(`${workerType} worker initialized successfully`)
}

// File processing worker using boss.work() - non-blocking and event-driven
export const initFileProcessingWorker = async () => {
  await createWorker(FileProcessingQueue, config.fileProcessingTeamSize, "file processing")
}

// PDF file processing worker using boss.work() - non-blocking and event-driven
export const initPdfFileProcessingWorker = async () => {
  await createWorker(PdfFileProcessingQueue, config.pdfFileProcessingTeamSize, "PDF file processing")
}