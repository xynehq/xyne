import { getLogger } from "@/logger"
import { Subsystem, ProcessingJobType } from "@/types"
import { getErrorMessage } from "@/utils"
import { boss } from "@/queue"
import { FileProcessingQueue, PdfFileProcessingQueue } from "@/queue/api-server-queue"
import { processJob, type ProcessingJob } from "@/queue/fileProcessor"
import config from "@/config"

const Logger = getLogger(Subsystem.Queue)

// File processing worker using boss.work() - non-blocking and event-driven
export const initFileProcessingWorker = async () => {
  Logger.info("Initializing file processing worker...")
  Logger.info(`Using batch size of ${config.fileProcessingTeamSize} for concurrent file processing`)
  
  // Use batchSize to process multiple jobs concurrently
  await boss.work(FileProcessingQueue, { batchSize: config.fileProcessingTeamSize }, async (jobs) => {
    // Process all jobs in parallel using Promise.all
    const jobPromises = jobs.map(async (job) => {
      try {
        const jobData = job.data as ProcessingJob
        const jobType = jobData.type || ProcessingJobType.FILE
        
        Logger.info(`Processing ${jobType} job: ${JSON.stringify(jobData)}`)

        // Process the job using the unified processor
        // The processJob function handles all status updates internally:
        // - Sets status to PROCESSING
        // - Sets status to COMPLETED after success
        // - Calls updateParentStatus to check parent completion
        await processJob(job as { data: ProcessingJob })

        Logger.info(`✅ ${jobType} job processed successfully`)
        
      } catch (error) {
        const jobData = job.data as ProcessingJob
        const jobType = jobData.type || ProcessingJobType.FILE
        const errorMessage = getErrorMessage(error)
        Logger.error(error, `❌ ${jobType} job failed: ${errorMessage}`)
        
        // Re-throw to let pg-boss handle the retry logic
        throw error
      }
    })

    // Wait for all jobs in the batch to complete
    await Promise.all(jobPromises)
  })

  Logger.info("File processing worker initialized successfully")
}

// PDF file processing worker using boss.work() - non-blocking and event-driven
export const initPdfFileProcessingWorker = async () => {
  Logger.info("Initializing PDF file processing worker...")
  Logger.info(`Using batch size of ${config.pdfFileProcessingTeamSize} for concurrent PDF file processing`)
  
  // Use batchSize to process multiple PDF jobs concurrently
  await boss.work(PdfFileProcessingQueue, { batchSize: config.pdfFileProcessingTeamSize }, async (jobs) => {
    // Process all jobs in parallel using Promise.all
    const jobPromises = jobs.map(async (job) => {
      try {
        const jobData = job.data as ProcessingJob
        const jobType = jobData.type || ProcessingJobType.FILE
        
        Logger.info(`Processing PDF ${jobType} job: ${JSON.stringify(jobData)}`)

        // Process the job using the unified processor
        // The processJob function handles all status updates internally:
        // - Sets status to PROCESSING
        // - Sets status to COMPLETED after success
        // - Calls updateParentStatus to check parent completion
        await processJob(job as { data: ProcessingJob })

        Logger.info(`✅ PDF ${jobType} job processed successfully`)
        
      } catch (error) {
        const jobData = job.data as ProcessingJob
        const jobType = jobData.type || ProcessingJobType.FILE
        const errorMessage = getErrorMessage(error)
        Logger.error(error, `❌ PDF ${jobType} job failed: ${errorMessage}`)
        
        // Re-throw to let pg-boss handle the retry logic
        throw error
      }
    })

    // Wait for all jobs in the batch to complete
    await Promise.all(jobPromises)
  })

  Logger.info("PDF file processing worker initialized successfully")
}