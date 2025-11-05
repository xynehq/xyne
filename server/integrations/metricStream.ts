import type { WSContext } from "hono/ws"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import WebSocket from "ws"
const Logger = getLogger(Subsystem.Server).child({ module: "metricStream" })

// WebSocket connection to main server for forwarding stats
// Note: Slack channel ingestion uses database polling, other integrations use WebSocket
let mainServerWebSocket: WebSocket | null = null
let reconnectAttempts = 0
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null

const connectToMainServer = () => {
  // Clear any pending timer to avoid overlapping attempts
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout)
    reconnectTimeout = null
  }

  // Avoid duplicate connections if already OPEN or CONNECTING
  if (
    mainServerWebSocket &&
    (mainServerWebSocket.readyState === WebSocket.OPEN ||
      mainServerWebSocket.readyState === WebSocket.CONNECTING)
  ) {
    Logger.debug(
      "Already connected/connecting to main server; skipping connect",
    )
    return
  }

  // Use the main app container name in Docker Compose environment, fallback to localhost for dev
  const mainServerHost = process.env.MAIN_SERVER_HOST || "localhost"
  const mainServerUrl = `ws://${mainServerHost}:${config.port}/internal/sync-websocket`
  const authSecret = process.env.METRICS_SECRET

  if (!authSecret) {
    Logger.error(
      "METRICS_SECRET is not set; cannot authenticate WebSocket connection",
    )
    return
  }

  Logger.info(
    `Attempting to connect to main server WebSocket: ${mainServerUrl} (attempt ${reconnectAttempts + 1})`,
  )

  mainServerWebSocket = new WebSocket(mainServerUrl, {
    headers: {
      Authorization: `Bearer ${authSecret}`,
    },
  })

  mainServerWebSocket.on("open", () => {
    Logger.info("WebSocket connection to main server established successfully")
    reconnectAttempts = 0 // Reset attempts on successful connection
  })

  mainServerWebSocket.on("error", (error) => {
    Logger.error(
      error,
      `WebSocket connection to main server failed (attempt ${reconnectAttempts + 1})`,
    )
    mainServerWebSocket = null
    // Do not hammer if auth is misconfigured
    if (!process.env.METRICS_SECRET) {
      Logger.error("METRICS_SECRET missing; will not retry until configured")
      return
    }
    scheduleReconnect()
  })

  mainServerWebSocket.on("close", (code, reason) => {
    Logger.warn(
      `WebSocket connection to main server closed (code: ${code}, reason: ${reason || "unknown"})`,
    )
    mainServerWebSocket = null
    scheduleReconnect()
  })
}

const scheduleReconnect = () => {
  // If reconnection already scheduled, don't interfere with existing timer
  if (reconnectTimeout) {
    return
  }

  // If already connected/connecting, skip scheduling
  if (
    mainServerWebSocket &&
    (mainServerWebSocket.readyState === WebSocket.OPEN ||
      mainServerWebSocket.readyState === WebSocket.CONNECTING)
  ) {
    return
  }

  reconnectAttempts++
  // Exponential backoff: start at 2 seconds, max at 60 seconds
  const baseDelay = 2000
  const maxDelay = 60000
  const delayNoJitter = Math.min(
    baseDelay * Math.pow(2, Math.min(reconnectAttempts - 1, 5)),
    maxDelay,
  )
  // Add small jitter to avoid herding if multiple instances reconnect
  const jitter = Math.floor(Math.random() * 500) // 0-500ms
  const delay = delayNoJitter + jitter

  Logger.info(
    `Scheduling WebSocket reconnection in ${delay}ms (attempt ${reconnectAttempts})`,
  )

  reconnectTimeout = setTimeout(() => {
    connectToMainServer()
  }, delay)
}

// Function to send WebSocket message to main server
// Note: Slack channel ingestion bypasses this and uses database polling instead
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
      Logger.debug(`WebSocket message sent for connector ${connectorId}`)
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
      mainServerWebSocket.readyState !== WebSocket.OPEN
    ) {
      Logger.info("Scheduling reconnect to main server...")
      scheduleReconnect()
    }
  }
}

export const wsConnections = new Map()

export const closeWs = (connectorId: string) => {
  wsConnections.get(connectorId)?.close(1000, "Job finished")
}

// Function to send WebSocket message directly (when running on main server)
const sendWebsocketMessageDirect = (message: string, connectorId: string) => {
  const ws: WSContext = wsConnections.get(connectorId)
  if (ws) {
    ws.send(JSON.stringify({ message }))
  }
}

// Function to send WebSocket message via sync-server WebSocket connection
const sendWebsocketMessageViaSyncServerWS = async (
  message: string,
  connectorId: string,
) => {
  try {
    sendWebsocketMessageToMainServer(message, connectorId)
  } catch (error) {
    Logger.error(
      error,
      "Error sending WebSocket message via sync-server WebSocket - message will be lost",
    )
  }
}

// TODO: scope it per user email who is integration
// if multiple people are doing oauth it should just work
export const sendWebsocketMessage = (message: string, connectorId: string) => {
  // Always forward to main server from sync-server
  // The main server will then forward to the frontend client
  // This ensures the correct flow: Sync-Server → Main Server → Frontend Client
  sendWebsocketMessageViaSyncServerWS(message, connectorId)
}
