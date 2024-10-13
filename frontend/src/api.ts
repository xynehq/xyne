import { hc } from "hono/client";
import type { WebSocketApp, AppType } from "shared/types";
export const api = hc<AppType>("/");

export const wsClient = hc<WebSocketApp>("http://127.0.0.1:3000");
