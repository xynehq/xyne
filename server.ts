import { Hono } from 'hono'
import { logger } from 'hono/logger'
// import { Apps, defaultMetrics, MsgType, type Metrics } from './frontend/src/lib/types';
import fs from 'node:fs'
import { initI, initNotion, search, searchGroupByCount } from './weaviate'

const app = new Hono()

app.use('*', logger())

app.get('/api/search', async (c) => {
    const query = c.req.query('query'); // Retrieve client ID from query params
    if (!query) {
        return c.json({ cause: 'query is mandatory' }, 400)
    }
    const offsetStr: string = c.req.query('offset') || ""
    let offset = 0
    if (offsetStr) {
        offset = parseInt(offsetStr)
    }
    const pageStr: string = c.req.query('page') || ""
    let page = 8
    if (pageStr) {
        page = parseInt(pageStr)
    }

    const gcStr = c.req.query('groupCount')
    let gc = 0
    if (gcStr) {
        gc = parseInt(gcStr)
    }
    const app = c.req.query('app')
    const entity = c.req.query('entity')

    let groupCount = {}
    let results = {}
    if (gc) {
        groupCount = await searchGroupByCount(query, ['saheb@xynehq.com'], app, entity)
        results = await search(query, page, offset, ['saheb@xynehq.com'], app, entity)

    } else {
        results = await search(query, page, offset, ['saheb@xynehq.com'], app, entity)
    }
    results.objects = results.objects.filter(o => {
        return o?.metadata?.score > 0.01
    })
    results.groupCount = groupCount
    return c.json(results)
})

const init = async () => {
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