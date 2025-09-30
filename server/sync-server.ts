import { Hono } from "hono"
import { init as initQueue } from "@/queue"
import config from "@/config"
import { getLogger, LogMiddleware } from "@/logger"
import { startGoogleIngestionSchema, Subsystem } from "@/types"
import { InitialisationError } from "@/errors"
import metricRegister from "@/metrics/sharedRegistry"
import { isSlackEnabled, startSocketMode } from "@/integrations/slack/client"
import { jwt } from "hono/jwt"
import { zValidator } from "@hono/zod-validator"
import {
  IngestMoreChannelApi,
  StartSlackIngestionApi,
  ServiceAccountIngestMoreUsersApi,
  HandlePerUserSlackSync,
  HandlePerUserGoogleWorkSpaceSync,
  StartGoogleIngestionApi,
} from "@/api/admin"
import {
  ingestMoreChannelSchema,
  startSlackIngestionSchema,
  serviceAccountIngestMoreSchema,
} from "@/types"
import { db } from "@/db/client"
import { getUserByEmail } from "@/db/user"
import type { JwtVariables } from "hono/jwt"
import type { Context, Next } from "hono"
import WebSocket from "ws"
import { Worker } from "worker_threads"
import path from "path"

const Logger = getLogger(Subsystem.SyncServer)

const app = new Hono<{ Variables: JwtVariables }>()

const honoMiddlewareLogger = LogMiddleware(Subsystem.SyncServer)

// WebSocket connection to main server for forwarding stats
let mainServerWebSocket: WebSocket | null = null

const connectToMainServer = () => {
  const mainServerUrl = `ws://localhost:${config.port}/internal/sync-websocket`
  const authSecret = process.env.METRICS_SECRET
  mainServerWebSocket = new WebSocket(mainServerUrl, {
    headers: {
      Authorization: `Bearer ${authSecret}`,
    },
  })

  mainServerWebSocket.on("open", () => {})

  mainServerWebSocket.on("error", (error) => {
    Logger.error(error, "WebSocket connection to main server failed")
    mainServerWebSocket = null
    // Retry connection after 5 seconds
    setTimeout(connectToMainServer, 5000)
  })

  mainServerWebSocket.on("close", () => {
    mainServerWebSocket = null
    // Retry connection after 5 seconds
    setTimeout(connectToMainServer, 5000)
  })
}

// Function to send WebSocket message to main server
export const sendWebsocketMessageToMainServer = (
  message: string,
  connectorId: string,
) => {
  if (
    mainServerWebSocket &&
    mainServerWebSocket.readyState === WebSocket.OPEN
  ) {
    try {
      mainServerWebSocket.send(JSON.stringify({ message, connectorId }))
    } catch (error) {
      Logger.error(
        error,
        `Failed to send WebSocket message for connector ${connectorId} - message lost`,
      )
    }
  } else {
    Logger.warn(
      `Cannot send WebSocket message - connection not available for connector ${connectorId}. Connection state: ${mainServerWebSocket?.readyState || "null"}. Message lost.`,
    )

    // Try to reconnect if connection is not available
    if (
      !mainServerWebSocket ||
      mainServerWebSocket.readyState === WebSocket.CLOSED
    ) {
      Logger.info("Attempting to reconnect to main server...")
      connectToMainServer()
    }
  }
}

// JWT Authentication middleware
const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET!
const AccessTokenCookieName = "access-token"
const { JwtPayloadKey } = config

const AuthMiddleware = jwt({
  secret: accessTokenSecret,
  cookie: AccessTokenCookieName,
})

// Add logging middleware to all routes
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

// // Protected ingestion API routes - require JWT authentication
app.use("*", AuthMiddleware)

// Slack ingestion APIs
app.post(
  "/slack/ingest_more_channel",
  zValidator("json", ingestMoreChannelSchema),
  IngestMoreChannelApi,
)

app.post(
  "/slack/start_ingestion",
  zValidator("json", startSlackIngestionSchema),
  StartSlackIngestionApi,
)

// Google Workspace APIs
app.post(
  "/google/service_account/ingest_more",
  zValidator("json", serviceAccountIngestMoreSchema),
  ServiceAccountIngestMoreUsersApi,
)

app.post(
  "/google/start_ingestion",
  zValidator("json", startGoogleIngestionSchema),
  StartGoogleIngestionApi,
)
// Sync APIs
app.post("/syncSlackByMail", HandlePerUserSlackSync)
app.post("/syncGoogleWorkSpaceByMail", HandlePerUserGoogleWorkSpaceSync)

export const initSyncServer = async () => {
  Logger.info("Initializing Sync Server")

  // Start file processing worker in separate thread
  const fileProcessingWorker = new Worker(
    path.join(__dirname, "fileProcessingWorker.ts"),
  )

  fileProcessingWorker.on("message", (message) => {
    if (message.status === "initialized") {
      Logger.info("File processing worker thread initialized successfully")
    } else if (message.status === "error") {
      Logger.error(`File processing worker thread failed: ${message.error}`)
    }
  })

  fileProcessingWorker.on("error", (error) => {
    Logger.error(error, "File processing worker thread error")
  })

  fileProcessingWorker.on("exit", (code) => {
    if (code !== 0) {
      Logger.error(`File processing worker thread exited with code ${code}`)
    }
  })

  // Initialize the queue system in background - don't await (excluding file processing)
  initQueue()
    .then(() => {
      Logger.info("Queue system initialized successfully")
    })
    .catch((error) => {
      Logger.error(error, "Failed to initialize queue system")
    })

  // Connect to main server WebSocket
  connectToMainServer()

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
