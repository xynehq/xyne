//@ts-ignore
import type { AppRoutes, wsApp } from "@/server"

export enum Apps {
    GoogleDrive = "google-drive"
}

export type AppType = typeof AppRoutes
export type WebSocketApp = typeof wsApp