import type { WSContext } from "hono/ws"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "metricStream",
})

export const wsConnections = new Map()

export const closeWs = (connectorId: string) => {
  Logger.info(`Closing WebSocket connection for connector ${connectorId}`)
  wsConnections.get(connectorId)?.close(1000, "Job finished")
}

export const sendWebsocketMessage = (message: string, connectorId: string) => {
  // Logger.info(`Attempting to send WebSocket message to connector ${connectorId}`)
  const ws: WSContext = wsConnections.get(connectorId)
  if (ws) {
    // Logger.info(`Found WebSocket connection for connector ${connectorId}, sending message`)
    ws.send(JSON.stringify({ message }))
  } else {
    Logger.warn(`No WebSocket connection found for connector ${connectorId}`)
  }
}
