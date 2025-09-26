import { hc } from "hono/client"
import type { AppType, WebSocketApp } from "shared/types"
import { authFetch } from "./utils/authFetch"

export const api = hc<AppType>("/api/v1", { fetch: authFetch })

let wsClient: ReturnType<typeof hc<WebSocketApp>> | null = null

export const getWSClient = (): ReturnType<typeof hc<WebSocketApp>> => {
  if (typeof window === "undefined") {
    throw new Error("Cannot access WS client on server")
  }

  if (wsClient) return wsClient

  const cfg = (window as any).CONFIG
  if (!cfg || !cfg.WS_BASE_URL) {
    console.warn("window.CONFIG missing WS_BASE_URL, falling back to default")
    wsClient = hc<WebSocketApp>("http://localhost:3000")
  } else {
    wsClient = hc<WebSocketApp>(cfg.WS_BASE_URL)
  }

  return wsClient
}
