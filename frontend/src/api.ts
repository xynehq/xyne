import { hc } from "hono/client"
import type { WebSocketApp, AppType } from "shared/types"
import { authFetch } from "./utils/authFetch"
import { loadConfig } from "@/config"
export const api = hc<AppType>("/api/v1", { fetch: authFetch })

let wsClientInstance: ReturnType<typeof hc<WebSocketApp>> | null = null

export async function getWSClient() {
  if (!wsClientInstance) {
    try {
      console.log("Loading config for WebSocket client...")
      const config = await loadConfig()
      console.log("Config loaded:", config)

      if (!config) {
        throw new Error("Config is null or undefined")
      }

      let wsUrl = config.WS_BASE_URL || "http://localhost:3000"

      console.log("Creating WS Client with URL:", wsUrl)

      wsClientInstance = hc<WebSocketApp>(wsUrl)
      console.log("WS Client initialized successfully")
    } catch (error) {
      console.error("Error loading WS config:", error)
      console.log("Falling back to localhost:3000")
      wsClientInstance = hc<WebSocketApp>("http://localhost:3000") // fallback
    }
  }
  return wsClientInstance
}
