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
import { AddServiceConnection } from './api/admin'
import { init as initQueue } from './queue'

const app = new Hono()

app.use('*', logger())

const AppRoutes = app.basePath('/api')
    .post('/autocomplete', zValidator('json', autocompleteSchema), AutocompleteApi)
    .get('/search', zValidator('query', searchSchema), SearchApi)
    .basePath('/admin')
    // TODO: debug
    // for some reason the validation schema
    // is not making the keys mandatory
    .post('/service_account', zValidator('form', addServiceConnectionSchema), AddServiceConnection)

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
    fetch: app.fetch
})
console.log('listening on port: 3000')