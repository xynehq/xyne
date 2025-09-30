import type { WSContext } from "hono/ws"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server).child({ module: "metricStream" })

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
    // Import the sync-server function dynamically to avoid circular dependencies
    const { sendWebsocketMessageToMainServer } = await import("../sync-server")
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
