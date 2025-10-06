import { Hono } from "hono"
import { init as initQueue } from "@/queue"
import config from "@/config"
import { getLogger, LogMiddleware } from "@/logger"
import { Subsystem } from "@/types"
import { InitialisationError } from "@/errors"
import metricRegister from "@/metrics/sharedRegistry"
import { isSlackEnabled, startSocketMode } from "@/integrations/slack/client"
import { Worker } from "worker_threads"
import path from "path"

const Logger = getLogger(Subsystem.SyncServer)

const app = new Hono()

const honoMiddlewareLogger = LogMiddleware(Subsystem.SyncServer)

// Add logging middleware
app.use("*", honoMiddlewareLogger)

// Health check endpoint
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "sync-server" })
})

// Metrics endpoint for sync server
app.get("/metrics", async (c) => {
  try {
    const metrics = await metricRegister.metrics()
    return c.text(metrics, 200, {
      "Content-Type": metricRegister.contentType,
    })
  } catch (err) {
    Logger.error(err, "Error generating metrics")
    return c.text("Error generating metrics", 500)
  }
})

// Status endpoint to check sync operations
app.get("/status", (c) => {
  return c.json({
    service: "sync-server",
    status: "running",
    timestamp: new Date().toISOString(),
    slack_enabled: isSlackEnabled(),
  })
})

const startAndMonitorWorkers = (
  workerScript: string,
  workerType: string,
  count: number,
  workerThreads: Worker[],
  arrayIndexOffset: number
) => {
  Logger.info(`Starting ${count} ${workerType} processing worker threads...`)

  for (let i = 0; i < count; i++) {
    const workerIndexForLogging = i + 1
    const workerArrayIndex = arrayIndexOffset + i
    
    const worker = new Worker(path.join(__dirname, workerScript))
    workerThreads.push(worker)

    worker.on("message", (message) => {
      if (message.status === "initialized") {
        Logger.info(`${workerType} processing worker thread ${workerIndexForLogging} initialized successfully`)
      } else if (message.status === "error") {
        Logger.error(`${workerType} processing worker thread ${workerIndexForLogging} failed: ${message.error}`)
      }
    })

    worker.on("error", (error) => {
      Logger.error(error, `${workerType} processing worker thread ${workerIndexForLogging} error`)
    })

    worker.on("exit", (code) => {
      if (code !== 0) {
        Logger.error(`${workerType} processing worker thread ${workerIndexForLogging} exited with code ${code}`)
        
        Logger.info(`Restarting ${workerType} processing worker thread ${workerIndexForLogging}...`)
        const newWorker = new Worker(path.join(__dirname, workerScript))
        workerThreads[workerArrayIndex] = newWorker
        
        // Re-attach event listeners for the new worker
        newWorker.on("message", (message) => {
          if (message.status === "initialized") {
            Logger.info(`${workerType} processing worker thread ${workerIndexForLogging} restarted and initialized successfully`)
          } else if (message.status === "error") {
            Logger.error(`${workerType} processing worker thread ${workerIndexForLogging} failed: ${message.error}`)
          }
        })
        
        newWorker.on("error", (error) => {
          Logger.error(error, `${workerType} processing worker thread ${workerIndexForLogging} error`)
        })
        
        newWorker.on("exit", (code) => {
          if (code !== 0) {
            Logger.error(`${workerType} processing worker thread ${workerIndexForLogging} exited with code ${code}`)
          }
        })
      }
    })
  }
}

export const initSyncServer = async () => {
  Logger.info("Initializing Sync Server")

  // Start multiple file processing workers in separate threads
  const workerThreads: Worker[] = []
  const fileWorkerCount = config.fileProcessingWorkerThreads
  const pdfWorkerCount = config.pdfFileProcessingWorkerThreads

  // Start workers using the helper function
  startAndMonitorWorkers("fileProcessingWorker.ts", "File", fileWorkerCount, workerThreads, 0)
  startAndMonitorWorkers("pdfFileProcessingWorker.ts", "PDF file", pdfWorkerCount, workerThreads, fileWorkerCount)

  // Initialize the queue system in background - don't await (excluding file processing)
  initQueue()
    .then(() => {
      Logger.info("Queue system initialized successfully")
    })
    .catch((error) => {
      Logger.error(error, "Failed to initialize queue system")
    })

  Logger.info("Sync Server initialization completed")
}

// Initialize the sync server
initSyncServer().catch((error) => {
  throw new InitialisationError({ cause: error })
})

const errorHandler = (error: Error) => {
  Logger.error(error, "Sync Server error")
  return new Response(`<pre>${error}\n${error.stack}</pre>`, {
    headers: {
      "Content-Type": "text/html",
    },
  })
}

// Start the sync server on a different port
const syncServerPort = config.syncServerPort || 3010
const server = Bun.serve({
  fetch: app.fetch,
  port: syncServerPort,
  idleTimeout: 180,
  development: process.env.NODE_ENV != "production",
  error: errorHandler,
})

Logger.info(`Sync Server listening on port: ${syncServerPort}`)

const errorEvents: string[] = [
  `uncaughtException`,
  `unhandledRejection`,
  `rejectionHandled`,
]
errorEvents.forEach((eventType: string) =>
  process.on(eventType, (error: Error) => {
    Logger.error(error, `Sync Server caught via event: ${eventType}`)
    if (
      eventType === "uncaughtException" ||
      eventType === "unhandledRejection"
    ) {
      process.exit(1)
    }
  }),
)
