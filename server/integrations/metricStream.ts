import type { WSContext } from "hono/ws"

export const wsConnections = new Map()

export const closeWs = (connectorId: string) => {
  wsConnections.get(connectorId)?.close(1000, "Job finished")
}

export const sendWebsocketMessage = (message: string, connectorId: string) => {
  const ws: WSContext = wsConnections.get(connectorId)
  if (ws) {
    ws.send(JSON.stringify({ message }))
  }
}
