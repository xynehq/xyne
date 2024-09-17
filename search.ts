import type { Context } from "hono";
import { autocomplete, groupVespaSearch, searchVespa } from "./vespa";
import { z } from 'zod'
import type { AutocompleteResults } from "./types";

export const autocompleteSchema = z.object({
    query: z.string().min(2)
})



export const AutocompleteApi = async (c: Context) => {
    const body = c.req.valid("json")
    const { query } = body;
    const results: AutocompleteResults = (await autocomplete(query, 'saheb@xynehq.com', 5))?.root
    if (!results) {
        return c.json({ children: [] })
    }
    return c.json(results)
}

export const SearchApi = async (c: Context) => {
    const email = 'saheb@xynehq.com'
    let { query, groupCount: gc, offset, page, app, entity } = c.req.valid('query');
    let groupCount = {}
    let results = {}
    query = decodeURIComponent(query)
    if (gc) {
        // groupCount = await searchGroupByCount(query, ['saheb@xynehq.com'], app, entity)
        groupCount = await groupVespaSearch(query, email)
        // results = await search(query, page, offset, ['saheb@xynehq.com'], app, entity)
        results = await searchVespa(query, email, app, entity, page, offset)

    } else {
        //     // results = await search(query, page, offset, ['saheb@xynehq.com'], app, entity)
        results = await searchVespa(query, email, app, entity, page, offset)
    }
    // results.objects = results.objects.filter(o => {
    //     return o?.metadata?.score > 0.01
    // })
    results.groupCount = groupCount
    // return c.json(results)
    return c.json(results)
}