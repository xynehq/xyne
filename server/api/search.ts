import type { Context } from "hono";
import { autocomplete, groupVespaSearch, searchVespa } from "@/search/vespa";
import { z } from "zod";
import type { AutocompleteResults } from "@/types";
import config from "@/config";
const { JwtPayloadKey } = config;

export const autocompleteSchema = z.object({
  query: z.string().min(2),
});

export const AutocompleteApi = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey);
  const email = sub;
  const body = c.req.valid("json");
  const { query } = body;
  const results: AutocompleteResults = (await autocomplete(query, email, 5))
    ?.root;
  if (!results) {
    return c.json({ children: [] });
  }
  return c.json(results);
};

export const SearchApi = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey);
  const email = sub;
  let {
    query,
    groupCount: gc,
    offset,
    page,
    app,
    entity,
  } = c.req.valid("query");
  let groupCount = {};
  let results = {};
  query = decodeURIComponent(query);
  if (gc) {
    groupCount = await groupVespaSearch(query, email);
    results = await searchVespa(query, email, app, entity, page, offset);
  } else {
    results = await searchVespa(query, email, app, entity, page, offset);
  }
  results.groupCount = groupCount;
  return c.json(results);
};
