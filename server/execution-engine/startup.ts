import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { ExecutionEngine } from "./index"

const Logger = getLogger(Subsystem.WorkflowApi)

// Initialize execution engine on server startup
export async function initializeExecutionEngine(): Promise<void> {
  try {
    Logger.info("Initializing execution engine...")

    // Start the communication service
    await ExecutionEngine.startService()

    // Perform health check
    const isHealthy = await ExecutionEngine.healthCheck()
    
    if (isHealthy) {
      Logger.info("Execution engine initialized successfully")
    } else {
      Logger.warn("Execution engine initialized but health check failed")
    }

    // Log engine status
    const status = await ExecutionEngine.getEngineStatus()
    Logger.info("Execution engine status:", status)

  } catch (error) {
    Logger.error(error, "Failed to initialize execution engine")
    throw error
  }
}

// Shutdown execution engine gracefully
export async function shutdownExecutionEngine(): Promise<void> {
  try {
    Logger.info("Shutting down execution engine...")

    await ExecutionEngine.stopService()

    Logger.info("Execution engine shutdown completed")

  } catch (error) {
    Logger.error(error, "Error during execution engine shutdown")
    throw error
  }
}

// Handle process signals for graceful shutdown
export function setupExecutionEngineSignalHandlers(): void {
  process.on('SIGTERM', async () => {
    Logger.info("Received SIGTERM, shutting down execution engine...")
    await shutdownExecutionEngine()
    process.exit(0)
  })

  process.on('SIGINT', async () => {
    Logger.info("Received SIGINT, shutting down execution engine...")
    await shutdownExecutionEngine()
    process.exit(0)
  })

  process.on('uncaughtException', async (error) => {
    Logger.error(error, "Uncaught exception, shutting down execution engine...")
    await shutdownExecutionEngine()
    process.exit(1)
  })

  process.on('unhandledRejection', async (reason) => {
    Logger.error(reason, "Unhandled rejection, shutting down execution engine...")
    await shutdownExecutionEngine()
    process.exit(1)
  })
}