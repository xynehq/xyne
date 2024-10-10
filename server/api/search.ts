import type { Context, ValidationTargets } from "hono";
import { autocomplete, groupVespaSearch, searchVespa } from "@/search/vespa";
import { z } from 'zod'
import config from "@/config"
import { HTTPException } from "hono/http-exception";
import { AutocompleteResultsSchema, type AutocompleteResults } from "@/shared/types";
const { JwtPayloadKey } = config

export const autocompleteSchema = z.object({
    query: z.string().min(2)
})

export const AutocompleteApi = async (c: Context) => {
    try {
        const { sub } = c.get(JwtPayloadKey)
        const email = sub
        const body = c.req.valid("json")
        const { query } = body;
        const results: AutocompleteResults = (await autocomplete(query, email, 5))?.root
        if (!results) {
            return c.json({ children: [] })
        }
        return c.json(results)
    } catch (e) {
        throw new HTTPException(500, { message: 'Could not fetch autocomplete results' })
    }
}

export const SearchApi = async (c: Context) => {
    const { sub } = c.get(JwtPayloadKey)
    const email = sub
    let { query, groupCount: gc, offset, page, app, entity } = c.req.valid('query');
    let groupCount: any = {}
    let results = {}
    const decodedQuery = decodeURIComponent(query)
    if (gc) {
        groupCount = await groupVespaSearch(query, email)
        results = await searchVespa(decodedQuery, email, app, entity, page, offset)

    } else {
        results = await searchVespa(decodedQuery, email, app, entity, page, offset)
    }
    results.groupCount = groupCount
    return c.json(results)
}