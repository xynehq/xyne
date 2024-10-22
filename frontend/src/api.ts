import { hc } from "hono/client"
import type { WebSocketApp, AppType } from "shared/types"
export const api = hc<AppType>("/")

export const wsClient = hc<WebSocketApp>(
  import.meta.env.VITE_WS_BASE_URL || "http://localhost:3000",
)
