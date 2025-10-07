import PgBoss from "pg-boss"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Queue)

const url = config.getDatabaseUrl()
export const boss = new PgBoss({
  connectionString: url,
  monitorStateIntervalMinutes: 10,
})

export const FileProcessingQueue = `file-processing`
export const PdfFileProcessingQueue = `file-processing-pdf`

/**
 * Initialize pg-boss for API server usage only
 * - Starts pg-boss connection
 * - Creates both FileProcessingQueue and PdfFileProcessingQueue
 * - Does NOT start any workers (workers run in sync-server.ts)
 */
export const initApiServerQueue = async () => {
  Logger.info("API Server Queue init - starting pg-boss")
  await boss.start()
  
  Logger.info("Creating FileProcessingQueue for API server")
  await boss.createQueue(FileProcessingQueue)
  
  Logger.info("Creating PdfFileProcessingQueue for API server")
  await boss.createQueue(PdfFileProcessingQueue)
  
  Logger.info("API Server Queue initialization complete - ready for boss.send()")
}

// Error handling
boss.on("error", (error) => {
  Logger.error(error, `API Server Queue error: ${error.message}`)
})