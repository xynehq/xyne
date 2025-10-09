import { parentPort } from "worker_threads"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { initPdfFileProcessingWorker } from "./worker"

const Logger = getLogger(Subsystem.Queue)

async function startPdfFileProcessingWorker() {
  try {
    Logger.info("Starting PDF file processing worker thread...")
    
    // Import PdfFileProcessingQueue from shared location
    const { PdfFileProcessingQueue } = await import("@/queue/api-server-queue")
    
    // Initialize boss and create PdfFileProcessingQueue in this worker thread
    const { boss } = await import("@/queue")
    await boss.start()
    await boss.createQueue(PdfFileProcessingQueue)
    
    // Now initialize the PDF file processing worker
    await initPdfFileProcessingWorker()
    Logger.info("PDF file processing worker thread initialized successfully")
    
    // Send success message to parent
    parentPort?.postMessage({ status: "initialized" })
  } catch (error) {
    Logger.error(error, "Failed to initialize PDF file processing worker thread")
    
    // Send error message to parent
    parentPort?.postMessage({ 
      status: "error", 
      error: error instanceof Error ? error.message : String(error) 
    })
  }
}

// Start the worker when this script is loaded
await startPdfFileProcessingWorker()

// Handle messages from parent thread if needed
parentPort?.on("message", (message) => {
  Logger.info("Received message from parent:", message)
})