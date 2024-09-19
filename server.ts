import { Hono } from 'hono'
import { logger } from 'hono/logger'
// import { Apps, defaultMetrics, MsgType, type Metrics } from './frontend/src/lib/types';
import fs from 'node:fs'
// import { initI, search, searchGroupByCount } from './weaviate'
import { initNotion } from './notion'
import { autocomplete } from './search/vespa'
import { AutocompleteApi, autocompleteSchema, SearchApi } from '@/api/search'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { addServiceConnectionSchema, searchSchema } from './types'
import { basicAuth } from 'hono/basic-auth'
import { AddServiceConnection, GetConnectors } from './api/admin'
import { boss, init as initQueue, SaaSQueue } from './queue'
import { createBunWebSocket } from 'hono/bun'
import type { ServerWebSocket } from 'bun'

const { upgradeWebSocket, websocket } =
    createBunWebSocket<ServerWebSocket>()

const app = new Hono()

app.use('*', logger())

export const wsConnections = new Map();


const wsApp = app.get(
    '/ws',
    upgradeWebSocket((c) => {
        let connectorId: string | undefined
        return {
            onOpen(event, ws) {
                connectorId = c.req.query('id')
                wsConnections.set(connectorId, ws)
            },
            onMessage(event, ws) {
                console.log(`Message from client: ${event.data}`)
                ws.send(JSON.stringify({ message: 'Hello from server!' }))
            },
            onClose: (event, ws) => {
                console.log('Connection closed')
                if (connectorId) {
                    wsConnections.delete(connectorId)
                }
            },
        }
    })
)

export type WebSocketApp = typeof wsApp


const AppRoutes = app.basePath('/api')
    .post('/autocomplete', zValidator('json', autocompleteSchema), AutocompleteApi)
    .get('/search', zValidator('query', searchSchema), SearchApi)
    .basePath('/admin')
    // TODO: debug
    // for some reason the validation schema
    // is not making the keys mandatory
    .post('/service_account', zValidator('form', addServiceConnectionSchema), AddServiceConnection)
    .get('/connectors/all', GetConnectors)

export type AppType = typeof AppRoutes


export const init = async () => {
    await initQueue()
    // await initKG()
    // await initI()
    // await initNotion()
}
init().catch(e => {
    console.error(e)
})

const server = Bun.serve({
    fetch: app.fetch,
    websocket
})
console.log('listening on port: 3000')