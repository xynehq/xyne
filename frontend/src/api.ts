import { hc } from 'hono/client'
import { WebSocketApp, type AppType } from '@server/server'
export const api = hc<AppType>('/')


export const wsClient = hc<WebSocketApp>('http://localhost:3000')
