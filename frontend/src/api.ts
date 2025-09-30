import { hc } from "hono/client"
import type { WebSocketApp, AppType } from "shared/types"
import { authFetch } from "./utils/authFetch"

export const api = hc<AppType>("/api/v1", { fetch: authFetch })

const { protocol, host } = window.location
const wsProtocol = protocol === "https:" ? "wss" : "ws"
const wsUrl = `${wsProtocol}://${host}`

export const wsClient = hc<WebSocketApp>(wsUrl)
