import { hc } from "hono/client"
import type { WebSocketApp, AppType } from "shared/types"
import { authFetch } from "./utils/authFetch"
export const api = hc<AppType>("/api/v1", { fetch: authFetch })

export const wsClient = hc<WebSocketApp>(
  import.meta.env.VITE_WS_BASE_URL || "http://localhost:3000",
)
