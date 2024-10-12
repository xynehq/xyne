import type { Context, ValidationTargets } from "hono";
import { autocomplete, groupVespaSearch, searchVespa } from "@/search/vespa";
import { z } from 'zod'
import config from "@/config"
import { HTTPException } from "hono/http-exception";
import { AutocompleteResultsSchema, type AutocompleteResults } from "@/shared/types";
import type { VespaSearchResponse } from "@/search/types";
import { VespaAutocompleteResponseToResult, VespaSearchResponseToSearchResult } from "@/search/mappers";
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
        const results = await autocomplete(query, email, 5)
        if (!results) {
            return c.json({ children: [] })
        }
        const newResults = VespaAutocompleteResponseToResult(results)
        return c.json(newResults)
    } catch (e) {
        console.error(e)
        throw new HTTPException(500, { message: 'Could not fetch autocomplete results' })
    }
}

export const SearchApi = async (c: Context) => {
    const { sub } = c.get(JwtPayloadKey)
    const email = sub
    let { query, groupCount: gc, offset, page, app, entity } = c.req.valid('query');
    let groupCount: any = {}
    let results: VespaSearchResponse = {} as VespaSearchResponse
    const decodedQuery = decodeURIComponent(query)
    if (gc) {
        groupCount = await groupVespaSearch(query, email)
        results = await searchVespa(decodedQuery, email, app, entity, page, offset)

    } else {
        results = await searchVespa(decodedQuery, email, app, entity, page, offset)
    }
    const newResults = VespaSearchResponseToSearchResult(results)
    newResults.groupCount = groupCount
    return c.json(newResults)
}