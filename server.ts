import { Hono } from 'hono'
import { logger } from 'hono/logger'
// import { Apps, defaultMetrics, MsgType, type Metrics } from './frontend/src/lib/types';
import fs from 'node:fs'
import { initI, initKG, search, searchGroupByCount } from './weaviate'
import { initNotion } from './notion'
import { autocomplete } from './vespa'
import { AutocompleteApi, autocompleteSchema, SearchApi } from './search'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { searchSchema } from './types'

const app = new Hono()

app.use('*', logger())

const AppRoutes = app.basePath('/api')
    .post('/autocomplete', zValidator('json', autocompleteSchema), AutocompleteApi)
    .get('/search', zValidator('query', searchSchema), SearchApi)

export type AppType = typeof AppRoutes


const init = async () => {
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