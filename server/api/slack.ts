import type { Context } from "hono"
import {  z } from "zod"
import { HTTPException } from "hono/http-exception"
import {  getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import { Apps, SlackEntity} from "@xyne/vespa-ts/types"

import { type VespaSearchResults, type VespaChatUserSearch,type VespaChatContainerSearch,type Span} from "@/shared/types"

import { getErrorMessage } from "@/utils"
import { fetchSlackEntity, GetDocumentsByDocIds } from "@/search/vespa"
import config from "@/config"

const loggerWithChild = getLoggerWithChild(Subsystem.Api)
const { JwtPayloadKey } = config

// Schema for listing Slack entities (users or channels)

export const slackListSchema = z.object({
  entity: z.enum([SlackEntity.User, SlackEntity.Channel]),
  limit: z
    .string()
    .optional()
    .default("50")
    .transform((value) => parseInt(value, 10))
    .refine((value) => !isNaN(value) && value > 0, {
      message: "Limit must be a valid number between 1 and 100",
    }),
  offset: z
    .string()
    .optional()
    .default("0")
    .transform((value) => parseInt(value, 10))
    .refine((value) => !isNaN(value) && value >= 0, {
      message: "Offset must be a valid number >= 0",
    }),
})

// Schema for searching Slack entities (users or channels)
export const slackSearchSchema = z.object({
  entity: z.enum([SlackEntity.User, SlackEntity.Channel]),
  query: z
    .string()
    .min(1, "Search query is required")
    .max(200, "Query too long"),
  limit: z
    .string()
    .optional()
    .default("20")
    .transform((value) => parseInt(value, 10))
    .refine((value) => !isNaN(value) && value > 0, {
      message: "Limit must be a valid number ",
    }),
})

export type SlackListRequest = z.infer<typeof slackListSchema>
export type SlackSearchRequest = z.infer<typeof slackSearchSchema>

/**
 * Combined API endpoint that handles both listing and searching based on query presence
 *
 * GET /api/slack/entities?entity=user&limit=50&offset=0  (list)
 * GET /api/slack/entities?entity=user&query=john&limit=20  (search)
 *
 * This is a convenience endpoint that automatically determines whether to list or search
 * based on whether a query parameter is provided.
 */
export const SlackEntitiesApi = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  const email = sub

  try {
    // @ts-ignore
    const params = c.req.query()

    // Check if query parameter exists and is not empty
    const hasQuery =
      params.query &&
      typeof params.query === "string" &&
      params.query.trim().length > 0

    if (hasQuery) {
      // Validate search parameters
      const searchParams = slackSearchSchema.parse(params)

      loggerWithChild({ email }).info(
        `Auto-routing to search for Slack ${searchParams.entity}s`,
      )

      // Route to search logic using fetchSlackEntity
      const results = await fetchSlackEntity(
        searchParams.entity,
        searchParams.query.trim(),
        email,
        Apps.Slack,
        searchParams.limit,
        0,
      )


      return c.json({
        results: results || [],
        query: searchParams.query.trim(),
        entity: searchParams.entity,
        operation: "search",
        resultCount: results.root?.children?.length || 0,
      })
    } else {
      // Validate list parameters
      const listParams = slackListSchema.parse(params)

      loggerWithChild({ email }).info(
        `Auto-routing to list for Slack ${listParams.entity}s`,
      )

      // Route to list logic using fetchSlackEntity
      const results = await fetchSlackEntity(
        listParams.entity,
        null,
        email,
        Apps.Slack,
        listParams.limit,
        listParams.offset,
      )


      return c.json({
        results: results || [],
        pagination: {
          limit: listParams.limit,
          offset: listParams.offset,
          total:
            results.root?.fields?.totalCount ||
            results.root?.children?.length ||
            0,
          hasMore: (results.root?.children?.length || 0) === listParams.limit,
        },
        entity: listParams.entity,
        operation: "list",
      })
    }
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email }).error(
      error,
      `Error in combined Slack entities API: ${errMsg}`,
    )

    throw new HTTPException(500, {
      message: "Failed to process Slack entities request",
    })
  }
}
export const slackDocumentsApi = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  const docids: string[] = c.req.query("docids")?.split(",") || []
  if(docids.length === 0){
    throw new HTTPException(400, {
      message: "No document IDs provided",
    })
  }
  try {
    const mockSpan: Span= {
  traceId: "mock-trace-id",
  spanId: "mock-span-id",
  name: "mock-span",
  startTime: Date.now(),
  endTime: Date.now(),
  attributes: {},
  events: [],
  duration: 0,
  setAttribute: () => mockSpan,
  addEvent: () => mockSpan,
  startSpan: () => mockSpan,
  end: () => mockSpan,
};
    const response =await GetDocumentsByDocIds(docids,mockSpan)
    const mappedData= response.root?.children?.map((doc)=>{
      const searchResult = doc as VespaSearchResults
      const fields= searchResult.fields
      if(fields.sddocname === "chat_user"){
        const chatUserFields= fields as VespaChatUserSearch
        return {
          docId:chatUserFields.docId,
          name:chatUserFields.name,
        }
      }
      else if(fields.sddocname === "chat_container"){
        const chatContainerFields= fields as VespaChatContainerSearch
        return {
          docId:chatContainerFields.docId,
          name:chatContainerFields.name,
        }
      }
      else{
        return {
        docId:searchResult.fields?.docId,
        name:searchResult.fields?.sddocname || "unknown",
       
      }
      }
     
    }) || []
    return c.json({
      success:true,
      totalCount:response.root?.fields?.totalCount || 0,
      documents:mappedData,
    })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: sub }).error(
      error,
      `Error in fetching Slack documents by docIds: ${errMsg}`,
    )

    throw new HTTPException(500, {
      message: "Failed to fetch Slack documents",
    })
  }
}
