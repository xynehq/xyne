import type { WSContext } from "hono/ws"

export const wsConnections = new Map<string, WSContext>()

export const closeWs = (connectorId: string, workspaceId?: string) => {
  const key = workspaceId ? `${workspaceId}:${connectorId}` : connectorId
  wsConnections.get(key)?.close(1000, "Job finished")
}

export const sendWebsocketMessage = (message: string, connectorId: string, workspaceId?: string) => {
  const key = workspaceId ? `${workspaceId}:${connectorId}` : connectorId
  const ws: WSContext = wsConnections.get(key)
  if (ws) {
    ws.send(JSON.stringify({ message }))
  }
}