import config from "@/config";
import { DeleteDocument, getItems, searchVespa } from "@/search/vespa";
import { eventSchema, fileSchema, mailAttachmentSchema, mailSchema, userSchema, type GetItemsParams, SearchModes } from "@xyne/vespa-ts";

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
const { JwtPayloadKey } = config

// Schema for all-docs query parameters (matching server.ts)
const allDocsQuerySchema = z.object({
  page: z
    .string()
    .default("1")
    .transform((value) => parseInt(value, 10))
    .refine((value) => !isNaN(value) && value > 0, {
      message: "Page must be a valid positive number",
    }),
  limit: z
    .string()
    .default("50")
    .transform((value) => parseInt(value, 10))
    .refine((value) => !isNaN(value) && value > 0 && value <= 100, {
      message: "Limit must be a valid number between 1 and 100",
    }),
  search: z.string().default(""),
})

type AllDocsQuery = z.infer<typeof allDocsQuerySchema>




export const FetchAllVespaDocs = async (c: Context) => {
    // Query parameters are already validated by zValidator middleware in server.ts
    const page = parseInt(c.req.query("page") || "1")
    const limit = parseInt(c.req.query("limit") || "50") 
    const search = c.req.query("search") || ""
    const offset = (page - 1) * limit
    const { sub } = c.get(JwtPayloadKey)
    console.log("Fetching Vespa Docs for user:", sub, "Page:", page, "Limit:", limit, "Search:", search)
    try {
        let docs;
        
        if (search.trim()) {
            // Use search functionality when search term is provided
            console.log("Executing search with term:", search, "for user:", sub);
            docs = await searchVespa(
                search,
                sub,
                null, // app filter
                null, // entity filter
                {
                    limit: limit + offset,
                    offset: offset,
                    alpha: 0.5,
                    timestampRange: null,
                    excludedIds: [],
                    notInMailLabels: [],
                    rankProfile: SearchModes.AI,
                    requestDebug: false,
                    span: null,
                    maxHits: 10000,
                    recencyDecayRate: 0.01,
                    // orderBy: "desc" as const,
                }
            );
            console.log("Search executed successfully with term:", search, "Result count:", docs?.root?.children?.length || 0);
        } else {
            // // Use getItems for listing all documents when no search term
            // const allSchemasParams: GetItemsParams = {
            //     schema: [
            //         fileSchema,
            //         userSchema,
            //         mailSchema,
            //         eventSchema,
            //         mailAttachmentSchema,
            //     ],
            //     asc: false,
            //     offset: offset,
            //     limit: limit,
            //     timestampRange: null,
            //     email: sub,
            // }
            // docs = await getItems(allSchemasParams);
            console.log("Executing search with term:", search, "for user:", sub);
            docs = await searchVespa(
                "a",
                sub,
                null, // app filter
                null, // entity filter
                {
                    limit: limit + offset,
                    offset: offset,
                    alpha: 0.5,
                    timestampRange: null,
                    excludedIds: [],
                    notInMailLabels: [],
                    rankProfile: SearchModes.AI,
                    requestDebug: false,
                    span: null,
                    maxHits: 10000,
                    recencyDecayRate: 0.01,
                    // orderBy: "desc" as const,
                }
            );

        }
        
        return c.json({ 
            success: true, 
            data: docs, 
            count: docs?.root.children.length,
            page: page,
            limit: limit,
            totalCount: docs?.root.fields?.totalCount || 0,
            search: search
        });
    } catch (error) {
        throw new HTTPException(400, { message: `Error Fetching docs ${error}` })
    }
}

export const DeleteVespaDoc = async (c:Context) => {
    const { schema, id } = await c.req.json();
    if (!schema || !id) {
        throw new HTTPException(400, { message: "Schema and ID are required" });
    }
    try {
        const deleted = await DeleteDocument(id, schema);
        return c.json({ success: true, message: "Document deleted successfully",deleted:deleted });
    } catch (error) {
        throw new HTTPException(400, { message: `Error deleting document: ${error}` });
    }
}
