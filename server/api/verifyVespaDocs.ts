import { DeleteDocument, getItems } from "@/search/vespa";
import { chatAttachmentSchema, chatContainerSchema, chatMessageSchema, chatTeamSchema, chatUserSchema, dataSourceFileSchema, datasourceSchema, eventSchema, fileSchema, KbItemsSchema, mailAttachmentSchema, mailSchema, userQuerySchema, userSchema, type GetItemsParams } from "@xyne/vespa-ts";

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";



export const FetchAllVespaDocs = async (c:Context) => {
    const page = parseInt(c.req.query("page") || "1")
    const limit = parseInt(c.req.query("limit") || "50")
    const offset = (page - 1) * limit

    const allSchemasParams: GetItemsParams = {
        schema: [
            fileSchema,
            userSchema,
            mailSchema,
            eventSchema,
            userQuerySchema,
            mailAttachmentSchema,
            chatContainerSchema,
            chatTeamSchema,
            chatMessageSchema,
            chatUserSchema,
            chatAttachmentSchema,
            datasourceSchema,
            dataSourceFileSchema,
            KbItemsSchema
        ],
        asc: false,
        offset: offset,
        limit: limit,
        timestampRange: null,
        email: "",
        }
    try {
        const docs = await getItems(allSchemasParams);
        return c.json({ 
            success: true, 
            data: docs, 
            count: docs.root.children.length,
            page: page,
            limit: limit,
            totalCount: docs.root.fields?.totalCount || 0
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
