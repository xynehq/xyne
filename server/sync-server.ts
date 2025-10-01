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

export const initSyncServer = async () => {
  Logger.info("Initializing Sync Server")
  
  // Start multiple file processing workers in separate threads
  const workerThreads: Worker[] = []
  const workerCount = config.fileProcessingWorkerThreads
  
  Logger.info(`Starting ${workerCount} file processing worker threads...`)
  
  for (let i = 0; i < workerCount; i++) {
    const fileProcessingWorker = new Worker(path.join(__dirname, "fileProcessingWorker.ts"))
    workerThreads.push(fileProcessingWorker)
    
    fileProcessingWorker.on("message", (message) => {
      if (message.status === "initialized") {
        Logger.info(`File processing worker thread ${i + 1} initialized successfully`)
      } else if (message.status === "error") {
        Logger.error(`File processing worker thread ${i + 1} failed: ${message.error}`)
      }
    })
    
    fileProcessingWorker.on("error", (error) => {
      Logger.error(error, `File processing worker thread ${i + 1} error`)
    })
    
    fileProcessingWorker.on("exit", (code) => {
      if (code !== 0) {
        Logger.error(`File processing worker thread ${i + 1} exited with code ${code}`)
        
        // Restart worker thread if it crashes
        Logger.info(`Restarting file processing worker thread ${i + 1}...`)
        const newWorker = new Worker(path.join(__dirname, "fileProcessingWorker.ts"))
        workerThreads[i] = newWorker
        
        // Re-attach event listeners for the new worker
        newWorker.on("message", (message) => {
          if (message.status === "initialized") {
            Logger.info(`File processing worker thread ${i + 1} restarted and initialized successfully`)
          } else if (message.status === "error") {
            Logger.error(`File processing worker thread ${i + 1} failed: ${message.error}`)
          }
        })
        
        newWorker.on("error", (error) => {
          Logger.error(error, `File processing worker thread ${i + 1} error`)
        })
        
        newWorker.on("exit", (code) => {
          if (code !== 0) {
            Logger.error(`File processing worker thread ${i + 1} exited with code ${code}`)
          }
        })
      }
    })
  }
  
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
