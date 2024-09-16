import { hc } from 'hono/client'
import { type AppType } from '@server/server'
export const api = hc<AppType>('/')