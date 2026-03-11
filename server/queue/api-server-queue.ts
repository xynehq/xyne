import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { boss as sharedBoss } from "./boss"
import { CHAT_MEMORY_INDEXING_QUEUE_NAME } from "./chat-memory-indexing"
import { EPISODIC_MEMORY_QUEUE_NAME } from "./episodic-memory-extraction"

const Logger = getLogger(Subsystem.Queue)

export const boss = sharedBoss
export const FileProcessingQueue = `file-processing`
export const PdfFileProcessingQueue = `file-processing-pdf`

/**
 * Initialize pg-boss for API server usage only
 * - Starts the shared pg-boss connection (same instance used by chat memory / episodic memory queues)
 * - Creates FileProcessingQueue, PdfFileProcessingQueue, and chat/episodic memory queues
 * - Does NOT start any workers (workers run in sync-server.ts)
 */
export const initApiServerQueue = async () => {
  Logger.info("API Server Queue init - starting pg-boss")
  await sharedBoss.start()

  Logger.info("Creating FileProcessingQueue for API server")
  await sharedBoss.createQueue(FileProcessingQueue)

  Logger.info("Creating PdfFileProcessingQueue for API server")
  await sharedBoss.createQueue(PdfFileProcessingQueue)

  Logger.info("Creating chat memory and episodic memory queues for API server")
  await sharedBoss.createQueue(CHAT_MEMORY_INDEXING_QUEUE_NAME)
  await sharedBoss.createQueue(EPISODIC_MEMORY_QUEUE_NAME)

  Logger.info("API Server Queue initialization complete - ready for boss.send()")
}

// Error handling
sharedBoss.on("error", (error) => {
  Logger.error(error, `API Server Queue error: ${error.message}`)
})