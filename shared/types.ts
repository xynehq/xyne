//@ts-ignore
import type { AppRoutes, WsApp } from "../server"

export enum Apps {
    GoogleDrive = "google-drive"
}

export type AppType = typeof AppRoutes
export type WebSocketApp = typeof WsApp