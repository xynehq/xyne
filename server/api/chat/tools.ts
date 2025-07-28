import { answerContextMap } from "@/ai/context"
import { getLogger } from "@/logger"
import { MessageRole, Subsystem } from "@/types"
import { delay, getErrorMessage } from "@/utils"

import { getTracer, type Span, type Tracer } from "@/tracer"
import {
  searchVespa,
  SearchModes,
  searchVespaInFiles,
  getItems,
  SearchVespaThreads,
  getThreadItems,
  type GetThreadItemsParams,
  searchVespaAgent,
  getSlackUserDetails,
} from "@/search/vespa"
import {
  Apps,
  CalendarEntity,
  chatMessageSchema,
  DataSourceEntity,
  dataSourceFileSchema,
  datasourceSchema,
  DriveEntity,
  entitySchema,
  eventSchema,
  fileSchema,
  GooglePeopleEntity,
  isValidApp,
  isValidEntity,
  mailAttachmentSchema,
  MailEntity,
  mailSchema,
  SlackEntity,
  SystemEntity,
  userSchema,
  type Entity,
  type VespaChatMessage,
  type VespaChatUser,
  type VespaDataSourceFile,
  type VespaSchema,
  type VespaSearchResponse,
  type VespaSearchResult,
  type VespaSearchResults,
  type VespaSearchResultsSchema,
  type VespaUser,
} from "@/search/types"

import { searchToCitation } from "./utils"
export const textToCitationIndex = /\[(\d+)\]/g
import config from "@/config"
import { is } from "drizzle-orm"
import { appToSchemaMapper } from "@/search/mappers"
import { getToolParameters, internalTools } from "@/api/chat/mapper"
import type {
  AgentTool,
  MetadataRetrievalParams,
  MinimalAgentFragment,
  SearchParams,
} from "./types"
import { XyneTools } from "@/shared/types"
import { expandEmailThreadsInResults } from "./utils"
import { resolveNamesToEmails } from "./chat"
import type { Intent } from "@/ai/types"

const { maxDefaultSummary, defaultFastModel } = config
const Logger = getLogger(Subsystem.Chat)

export function parseAgentAppIntegrations(agentPrompt?: string): {
  agentAppEnums: Apps[]
  agentSpecificDataSourceIds: string[]
} {
  Logger.debug({ agentPrompt }, "Parsing agent prompt for app integrations")
  let agentAppEnums: Apps[] = []
  let agentSpecificDataSourceIds: string[] = []

  if (!agentPrompt) {
    return { agentAppEnums, agentSpecificDataSourceIds }
  }

  let agentPromptData: { appIntegrations?: string[] } = {}

  try {
    agentPromptData = JSON.parse(agentPrompt)
    Logger.debug({ agentPromptData }, "Parsed agent prompt data")
  } catch (error) {
    Logger.warn("Failed to parse agentPrompt JSON", {
      error,
      agentPrompt,
    })
    return { agentAppEnums, agentSpecificDataSourceIds }
  }

  if (
    !agentPromptData.appIntegrations ||
    !Array.isArray(agentPromptData.appIntegrations)
  ) {
    Logger.warn(
      "agentPromptData.appIntegrations is not an array or is missing",
      { agentPromptData },
    )
    return { agentAppEnums, agentSpecificDataSourceIds }
  }

  for (const integration of agentPromptData.appIntegrations) {
    if (typeof integration !== "string") {
      Logger.warn(
        `Invalid integration item in agent prompt (not a string): ${integration}`,
      )
      continue
    }

    const integrationApp = integration.toLowerCase()

    // Handle data source IDs
    if (integrationApp.startsWith("ds-") || integrationApp.startsWith("ds_")) {
      agentSpecificDataSourceIds.push(integration)
      if (!agentAppEnums.includes(Apps.DataSource)) {
        agentAppEnums.push(Apps.DataSource)
      }
      continue
    }

    const app = integrationApp as Apps
    if (app) {
      if (!agentAppEnums.includes(app)) {
        agentAppEnums.push(app)
      }
    } else {
      Logger.warn(`Unknown integration type in agent prompt: ${integration}`)
    }
  }

  // Remove duplicates
  agentAppEnums = [...new Set(agentAppEnums)]

  return { agentAppEnums, agentSpecificDataSourceIds }
}

interface UnifiedSearchOptions {
  email: string
  query?: string | null
  app?: Apps | null
  entity?: Entity | null
  timestampRange?: {
    from?: number | string | null
    to?: number | string | null
  } | null
  limit?: number
  offset?: number
  orderDirection?: "asc" | "desc"
  excludedIds?: string[]
  agentAppEnums?: Apps[]
  span?: Span
  schema?: VespaSchema | null
  dataSourceIds?: string[] | undefined
  intent?: Intent | null
}

async function executeVespaSearch(options: UnifiedSearchOptions): Promise<{
  result: string
  contexts: MinimalAgentFragment[]
  error?: string
}> {
  const {
    email,
    query,
    app,
    entity,
    timestampRange,
    limit = 10,
    offset = 0,
    orderDirection = "desc",
    excludedIds,
    agentAppEnums,
    span,
    schema,
    intent,
  } = options

  const execSpan = span?.startSpan("execute_vespa_search_helper")
  execSpan?.setAttribute("email", email)
  if (query) execSpan?.setAttribute("query", query)
  if (app) execSpan?.setAttribute("app", app)
  if (entity) execSpan?.setAttribute("entity", entity)
  if (limit) execSpan?.setAttribute("limit", limit)
  if (offset) execSpan?.setAttribute("offset", offset)
  if (orderDirection) execSpan?.setAttribute("orderDirection", orderDirection)
  execSpan?.setAttribute("hasTimestampRange", !!timestampRange)
  execSpan?.setAttribute("hasExcludedIds", (excludedIds?.length || 0) > 0)
  execSpan?.setAttribute("hasAgentAppEnums", (agentAppEnums?.length || 0) > 0)

  if (!email) {
    const errorMsg = "Email is required for search execution."
    execSpan?.setAttribute("error", errorMsg)
    return { result: errorMsg, error: "Missing email", contexts: [] }
  }

  let searchResults: VespaSearchResponse | null = null
  const commonSearchOptions = {
    limit,
    alpha: 0.5,
    excludedIds,
    span: execSpan?.startSpan("vespa_search_call"),
    offset,
    rankProfile:
      orderDirection === "desc"
        ? SearchModes.GlobalSorted
        : SearchModes.NativeRank,
    intent,
  }

  const fromTimestamp = timestampRange?.from
    ? new Date(timestampRange.from).getTime()
    : undefined
  const toTimestamp = timestampRange?.to
    ? new Date(timestampRange.to).getTime()
    : undefined

  if (query && query.trim() !== "") {
    if (agentAppEnums && agentAppEnums.length > 0) {
      if (app && !agentAppEnums.includes(app)) {
        const errorMsg = `${app} is not an allowed app for this agent. Cannot search.`
        execSpan?.setAttribute("error", errorMsg)
        return { result: errorMsg, contexts: [] }
      }
      searchResults = await searchVespaAgent(
        query,
        email,
        app ?? null,
        entity ?? null,
        agentAppEnums,
        {
          ...commonSearchOptions,
          timestampRange:
            fromTimestamp && toTimestamp
              ? { from: fromTimestamp, to: toTimestamp }
              : undefined,
          dataSourceIds: options.dataSourceIds ?? undefined,
        },
      )
    } else {
      searchResults = await searchVespa(
        query,
        email,
        app ?? null,
        entity ?? null,
        {
          ...commonSearchOptions,
          timestampRange:
            fromTimestamp && toTimestamp
              ? { from: fromTimestamp, to: toTimestamp }
              : undefined,
        },
      )
    }
  } else if (schema) {
    // If no query, but a schema is provided, use getItems
    if (agentAppEnums && agentAppEnums.length > 0) {
      if (app && !agentAppEnums.includes(app)) {
        const errorMsg = `${app} is not an allowed app for this agent. Cannot retrieve items.`
        execSpan?.setAttribute("error", errorMsg)
        return { result: errorMsg, contexts: [] }
      }
    }

    searchResults = await getItems({
      email,
      schema,
      app: app ?? null,
      entity: entity ?? null,
      timestampRange:
        fromTimestamp && toTimestamp
          ? { from: fromTimestamp, to: toTimestamp }
          : null,
      limit,
      offset,
      asc: orderDirection === "asc",
      excludedIds,
      intent: options.intent || null,
    })
  } else {
    const errorMsg = "No query or schema provided for search."
    execSpan?.setAttribute("error", errorMsg)
    return {
      result: errorMsg,
      error: "Invalid search parameters",
      contexts: [],
    }
  }

  // Expand email threads if results contain emails
  if (searchResults?.root?.children && searchResults.root.children.length > 0) {
    searchResults.root.children = await expandEmailThreadsInResults(
      searchResults.root.children,
      email,
      execSpan,
    )
  }

  const children = (searchResults?.root?.children || []).filter(
    (item): item is VespaSearchResults =>
      !!(item.fields && "sddocname" in item.fields),
  )
  execSpan?.setAttribute("results_count", children.length)

  if (children.length === 0) {
    return { result: "No results found.", contexts: [] }
  }

  const fragments: MinimalAgentFragment[] = children.map((r) => {
    if (r.fields.sddocname === dataSourceFileSchema) {
      const fields = r.fields as VespaDataSourceFile
      return {
        id: `${fields.docId}`,
        content: answerContextMap(r, maxDefaultSummary),
        source: {
          docId: fields.docId,
          title: fields.fileName || "Untitled",
          url: `/dataSource/${(fields as VespaDataSourceFile).docId}`,
          app: fields.app || Apps.DataSource,
          entity: DataSourceEntity.DataSourceFile,
        },
        confidence: r.relevance || 0.7,
      }
    }
    const citation = searchToCitation(r)
    return {
      id: `${citation.docId}`,
      content: answerContextMap(r, maxDefaultSummary),
      source: citation,
      confidence: r.relevance || 0.7,
    }
  })

  let summaryText = `Found ${fragments.length} results`
  if (query) summaryText += ` matching '${query}'`
  if (app) summaryText += ` in \`${app}\``
  if (timestampRange?.from && timestampRange?.to) {
    summaryText += ` from ${new Date(timestampRange.from).toLocaleDateString()} to ${new Date(timestampRange.to).toLocaleDateString()}`
  }
  if (offset > 0)
    summaryText += ` (showing items ${offset + 1} to ${offset + fragments.length})`

  const topItemsList = fragments
    .slice(0, 3)
    .map((f) => `- "${f.source.title || "Untitled"}"`)
    .join("\n")
  summaryText += `.\nTop items:\n${topItemsList}`

  execSpan?.end()
  return { result: summaryText, contexts: fragments }
}

// Search Tool
export const searchTool: AgentTool = {
  name: XyneTools.Search,
  description: internalTools[XyneTools.Search].description,
  parameters: getToolParameters(XyneTools.Search),
  execute: async (
    params: SearchParams,
    span?: Span,
    email?: string,
    usrCtx?: string,
    agentPrompt?: string,
    userMessage?: string,
  ) => {
    const execSpan = span?.startSpan("execute_search_tool")
    try {
      if (!email) {
        const errorMsg = "Email is required for search tool execution."
        execSpan?.setAttribute("error", errorMsg)
        return { result: errorMsg, error: "Missing email" }
      }

      const queryToUse = params.filter_query || userMessage || ""
      if (!queryToUse.trim()) {
        return {
          result: "No query provided for general search.",
          error: "Missing query",
        }
      }

      const { agentAppEnums, agentSpecificDataSourceIds } =
        parseAgentAppIntegrations(agentPrompt)

      return await executeVespaSearch({
        email,
        query: queryToUse,
        limit: params.limit,
        excludedIds: params.excludedIds,
        agentAppEnums,
        span: execSpan,
        dataSourceIds: agentSpecificDataSourceIds,
      })
    } catch (error) {
      const errMsg = getErrorMessage(error)
      execSpan?.setAttribute("error", errMsg)
      return { result: `Search error: ${errMsg}`, error: errMsg }
    } finally {
      execSpan?.end()
    }
  },
}

// Item type mapping configuration
interface ItemTypeMappingDetails {
  schema: VespaSchema
  defaultEntity: Entity | null
  timestampField: string
  defaultApp: Apps | null
}

const meetingEventMapping: ItemTypeMappingDetails = {
  schema: eventSchema,
  defaultEntity: CalendarEntity.Event,
  timestampField: "startTime",
  defaultApp: Apps.GoogleCalendar,
}

const emailMessageNotificationMapping: ItemTypeMappingDetails = {
  schema: mailSchema,
  defaultEntity: MailEntity.Email,
  timestampField: "timestamp",
  defaultApp: Apps.Gmail,
}

const documentFileMapping: ItemTypeMappingDetails = {
  schema: fileSchema,
  defaultEntity: null,
  timestampField: "updatedAt",
  defaultApp: Apps.GoogleDrive,
}

const attachmentMapping: ItemTypeMappingDetails = {
  schema: mailAttachmentSchema,
  defaultEntity: null,
  timestampField: "timestamp",
  defaultApp: Apps.Gmail,
}

const userPersonMapping: ItemTypeMappingDetails = {
  schema: userSchema,
  defaultEntity: null,
  timestampField: "creationTime",
  defaultApp: Apps.GoogleWorkspace,
}

const contactMapping: ItemTypeMappingDetails = {
  schema: userSchema,
  defaultEntity: null,
  timestampField: "creationTime",
  defaultApp: null, // Default to null app to target personal contacts via owner field in getItems
}

interface SchemaMapping {
  schema: VespaSchema
  defaultEntity: Entity | null
  timestampField: string
}

const appMapping: Record<string, SchemaMapping> = {
  [Apps.Gmail.toLowerCase()]: {
    schema: mailSchema,
    defaultEntity: MailEntity.Email,
    timestampField: "timestamp",
  },
  [Apps.GoogleCalendar.toLowerCase()]: {
    schema: eventSchema,
    defaultEntity: CalendarEntity.Event,
    timestampField: "startTime",
  },
  [Apps.GoogleDrive.toLowerCase()]: {
    schema: fileSchema,
    defaultEntity: null,
    timestampField: "updatedAt",
  },
  [Apps.GoogleWorkspace.toLowerCase()]: {
    schema: userSchema,
    defaultEntity: null,
    timestampField: "creationTime",
  },
  [Apps.DataSource.toLowerCase()]: {
    schema: datasourceSchema,
    defaultEntity: null,
    timestampField: "updatedAt",
  },
  // [Apps.Slack.toLowerCase()]: {
  //   schema: chatMessageSchema,
  //   defaultEntity: SlackEntity.Message,
  //   timestampField: "createdAt"
  // },
}

// === NEW Metadata Retrieval Tool ===
export const metadataRetrievalTool: AgentTool = {
  name: XyneTools.MetadataRetrieval,
  description: internalTools[XyneTools.MetadataRetrieval].description,
  parameters: getToolParameters(XyneTools.MetadataRetrieval),
  execute: async (
    params: MetadataRetrievalParams,
    span?: Span,
    email?: string,
    userCtx?: string,
    agentPrompt?: string,
  ) => {
    const execSpan = span?.startSpan("execute_metadata_retrieval_tool")
    if (!email) {
      const errorMsg = "Email is required for search tool execution."
      execSpan?.setAttribute("error", errorMsg)
      return { result: errorMsg, error: "Missing email" }
    }
    Logger.debug(
      { params, excludedIds: params.excludedIds },
      "[metadata_retrieval] Input Parameters:",
    )
    if (params.app) execSpan?.setAttribute("app_param_original", params.app)
    if (params.entity) execSpan?.setAttribute("entity_param", params.entity)
    if (params.filter_query)
      execSpan?.setAttribute("filter_query", params.filter_query)
    if (params.intent)
      execSpan?.setAttribute("intent", JSON.stringify(params.intent))

    execSpan?.setAttribute("limit", params.limit || 10)
    execSpan?.setAttribute("offset", params.offset || 0)
    if (params.order_direction)
      execSpan?.setAttribute("order_direction_param", params.order_direction)

    try {
      let schema: VespaSchema
      let entity: Entity | null = null
      let appToUse: Apps | null = isValidApp(params.app || "")
        ? (params.app as Apps)
        : null
      let timestampField: string

      if (!appToUse) {
        const unknownItemMsg = `Error: Unknown item_type '${params.app}'`
        execSpan?.setAttribute("error", unknownItemMsg)
        Logger.error("[metadata_retrieval] Unknown item_type:", unknownItemMsg)
        return { result: unknownItemMsg, error: `Unknown item_type` }
      }

      const mapping = appMapping[appToUse.toLowerCase()]
      if (!mapping) {
        const unknownItemMsg = `Error: No mapping found for app '${appToUse}'`
        execSpan?.setAttribute("error", unknownItemMsg)
        Logger.error("[metadata_retrieval] No mapping found:", unknownItemMsg)
        return {
          result: unknownItemMsg,
          error: `No mapping found for item_type`,
        }
      }
      schema = mapping.schema
      entity = mapping.defaultEntity
      timestampField = mapping.timestampField

      Logger.debug(
        `[metadata_retrieval] Derived from item_type '${appToUse}': schema='${schema.toString()}', initial_entity='${entity ? entity.toString() : "null"}', timestampField='${timestampField}', inferred_appToUse='${appToUse ? appToUse.toString() : "null"}'`,
      )

      let finalEntity: Entity | null = isValidEntity(entity ?? "")
        ? entity
        : null
      execSpan?.setAttribute(
        "initial_entity_from_item_type",
        finalEntity ? finalEntity.toString() : "null",
      )

      Logger.debug(
        `[metadata_retrieval] Final determined values before Vespa call: appToUse='${appToUse ? appToUse.toString() : "null"}', schema='${schema.toString()}', finalEntity='${finalEntity ? finalEntity.toString() : "null"}'`,
      )

      execSpan?.setAttribute("derived_schema", schema.toString())
      if (entity) execSpan?.setAttribute("derived_entity", entity.toString())
      execSpan?.setAttribute(
        "final_app_to_use",
        appToUse ? appToUse.toString() : "null",
      )

      const orderByString: string | undefined = params.order_direction
        ? `${timestampField} ${params.order_direction}`
        : undefined
      if (orderByString)
        execSpan?.setAttribute("orderBy_constructed", orderByString)
      Logger.debug(
        `[metadata_retrieval] orderByString for Vespa (if applicable): '${orderByString}'`,
      )

      const { agentAppEnums, agentSpecificDataSourceIds } =
        parseAgentAppIntegrations(agentPrompt)

      let resolvedIntent = params.intent || {}
      if (
        resolvedIntent &&
        Object.keys(resolvedIntent).length > 0 &&
        appToUse === Apps.Gmail
      ) {
        Logger.info(
          ` Detected names in intent, resolving to emails: ${JSON.stringify(resolvedIntent)}`,
        )
        resolvedIntent = await resolveNamesToEmails(
          resolvedIntent,
          email,
          userCtx ?? "",
          span,
        )
        Logger.info(`Resolved intent: ${JSON.stringify(resolvedIntent)}`)
      }

      return await executeVespaSearch({
        email,
        query: params.filter_query,
        app: appToUse,
        entity: finalEntity,
        limit: params.limit,
        offset: params.offset,
        orderDirection: params.order_direction,
        excludedIds: params.excludedIds,
        agentAppEnums,
        span: execSpan,
        schema: params.filter_query ? null : schema, // Only pass schema if no filter_query for getItems
        dataSourceIds: agentSpecificDataSourceIds,
        timestampRange: { from: params.from, to: params.to },
        intent: resolvedIntent,
      })
    } catch (error) {
      const errMsg = getErrorMessage(error)
      execSpan?.setAttribute("error", errMsg)
      Logger.error(error, `Metadata retrieval tool error: ${errMsg}`)
      // Ensure this return type matches the interface
      return {
        result: `Error retrieving metadata: ${errMsg}`,
        error: errMsg,
      }
    } finally {
      execSpan?.end()
    }
  },
}

export const userInfoTool: AgentTool = {
  name: XyneTools.GetUserInfo,
  description: internalTools[XyneTools.GetUserInfo].description,
  parameters: {}, // No parameters needed from the LLM
  execute: async (_params: any, span?: Span, email?: string, ctx?: string) => {
    const execSpan = span?.startSpan("execute_get_user_info_tool")
    if (!ctx) {
      const errorMsg = "context is required for search tool execution."
      execSpan?.setAttribute("error", errorMsg)
      return { result: errorMsg, error: "Missing user context" }
    }
    try {
      // userCtxObject is already available in the outer scope
      const userFragment: MinimalAgentFragment = {
        id: `user_info_context-${Date.now()}`,
        content: ctx, // The string generated by userContext()
        source: {
          docId: "user_info_context",
          title: "User and System Information", // Optional
          app: Apps.Xyne, // Use Apps.Xyne as per feedback
          url: "", // Optional
          entity: SystemEntity.UserProfile, // Use the new SystemEntity.UserProfile
        },
        confidence: 1.0,
      }
      execSpan?.setAttribute("user_context_retrieved", true)
      return {
        result: "User and system context information retrieved successfully.",
        contexts: [userFragment],
      }
    } catch (error) {
      const errMsg = getErrorMessage(error)
      execSpan?.setAttribute("error", errMsg)
      Logger.error(error, `Error in get_user_info tool: ${errMsg}`)
      return {
        result: `Error retrieving user context: ${errMsg}`,
        error: errMsg,
      }
    } finally {
      execSpan?.end()
    }
  },
}

export const getSlackThreads: AgentTool = {
  name: "get_slack_threads",
  description:
    "Retrieves Slack thread messages for a specific message to provide conversational context. Use when users need to understand the full conversation history around a particular message.",
  parameters: {
    filter_query: {
      type: "string",
      description: "Optional keywords to filter thread messages",
      required: false,
    },
    limit: {
      type: "number",
      description:
        "Maximum number of thread messages to retrieve. default (10)",
      required: false,
    },
    offset: {
      type: "number",
      description: "Number of messages to skip for pagination",
      required: false,
    },
    order_direction: {
      type: "string",
      description: "Sort direction for thread messages",
      required: false,
    },
  },
  execute: async (
    params: any,
    span?: Span,
    email?: string,
    ctx?: string,
    agentPrompt?: string,
  ) => {
    const execSpan = span?.startSpan("slack_message")
    if (!email) {
      const errorMsg = "email is required for search tool execution."
      execSpan?.setAttribute("error", errorMsg)
      return { result: errorMsg, error: "Missing user email" }
    }

    if (agentPrompt) {
      const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)
      execSpan?.setAttribute("agent_app_enums", JSON.stringify(agentAppEnums))
      if (!agentAppEnums.includes(Apps.Slack)) {
        return {
          result:
            "Slack is not an allowed app for this agent. Cannot retrieve Slack threads.",
          contexts: [],
        }
      }
    }

    try {
      let appToUse: Apps = Apps.Slack // This tool is specific to Slack

      let searchResults: VespaSearchResponse | null = null
      const searchOptionsVespa: {
        limit: number
        offset: number
        span: Span | undefined
      } = {
        limit: params.limit || 10,
        offset: params.offset || 0,
        span: execSpan,
      }

      console.log(
        "[Retrieve Slack Thread] Common Vespa searchOptions:",
        JSON.stringify(
          {
            app: appToUse,
            filterQuery: params.filter_query,
            limit: searchOptionsVespa.limit,
            offset: searchOptionsVespa.offset,
          },
          null,
          2,
        ),
      )

      const searchQuery = params.filter_query
      Logger.debug(`[getSlackThreads] Using filter_query: '${searchQuery}'`)

      if (!searchQuery || searchQuery.trim() === "") {
        execSpan?.setAttribute("vespa_call_type", "getItems_no_keyword_filter")
        searchResults = await getItems({
          email,
          schema: chatMessageSchema, // Assuming thread roots are chat messages
          app: appToUse,
          entity: SlackEntity.Message, // Implicitly searching for messages
          timestampRange: null,
          limit: searchOptionsVespa.limit,
          offset: searchOptionsVespa.offset,
          asc: params.order_direction === "asc",
          excludedIds: undefined, // getSlackThreads doesn't have excludedIds param
        })
      } else {
        // The search is always for Slack messages (appToUse = Apps.Slack)
        // The entity is implicitly SlackEntity.Message when fetching threads.
        if (params.order_direction === "desc") {
          execSpan?.setAttribute("vespa_call_type", "searchVespa_GlobalSorted")
          searchResults = await searchVespa(
            searchQuery,
            email,
            appToUse,
            SlackEntity.Message,
            {
              limit: searchOptionsVespa.limit,
              offset: searchOptionsVespa.offset,
              rankProfile: SearchModes.GlobalSorted,
              span: execSpan?.startSpan(
                "vespa_search_slack_threads_globalsorted",
              ),
            },
          )
        } else {
          execSpan?.setAttribute(
            "vespa_call_type",
            "searchVespa_filter_no_sort",
          )
          searchResults = await searchVespa(
            searchQuery,
            email,
            appToUse,
            SlackEntity.Message,
            {
              limit: searchOptionsVespa.limit,
              offset: searchOptionsVespa.offset,
              rankProfile: SearchModes.NativeRank,
              span: execSpan?.startSpan("vespa_search_slack_threads_native"),
            },
          )
        }
      }
      const children = (searchResults?.root?.children || []).filter(
        (item): item is VespaSearchResults =>
          !!(item.fields && "sddocname" in item.fields),
      )

      if (!children.length) {
        return {
          result: `No messages found matching the filter query. ${params.filter_query ? `Query: '${params.filter_query}'` : ""}`,
          contexts: [],
        }
      }

      const threadIdsToFetch: string[] = []
      for (const child of children) {
        if (child.fields && child.fields.sddocname === chatMessageSchema) {
          const messageFields = child.fields as VespaChatMessage
          if (messageFields.app === Apps.Slack) {
            const createdAtNum = messageFields.createdAt
            const threadIdStr = messageFields.threadId
            if (String(createdAtNum) === threadIdStr) {
              threadIdsToFetch.push(threadIdStr)
            }
          }
        }
      }

      if (threadIdsToFetch.length === 0) {
        return {
          result: `No primary thread messages found matching the criteria. ${params.filter_query ? `Query: '${params.filter_query}'` : ""}`,
          contexts: [],
        }
      }
      const resp = await SearchVespaThreads(threadIdsToFetch, execSpan!)
      const allChildrenFromResp = resp.root?.children || []
      const threads: VespaSearchResults[] = allChildrenFromResp.filter(
        (item): item is VespaSearchResults =>
          !!(item.fields && "sddocname" in item.fields),
      )
      if (threads.length > 0) {
        const fragments: MinimalAgentFragment[] = threads.map(
          (item: VespaSearchResults): MinimalAgentFragment => {
            const citation = searchToCitation(item)
            Logger.debug({ item }, "Processing item in metadata_retrieval tool")

            const content = item.fields
              ? answerContextMap(item, maxDefaultSummary)
              : `Context unavailable for ${citation.title || citation.docId}`

            return {
              id: `${citation.docId}`,
              content: content,
              source: citation,
              confidence: item.relevance || 0.7, // Use item.relevance if available
            }
          },
        )

        let responseText = `Found ${fragments.length} Slack message${fragments.length !== 1 ? "s" : ""}`
        if (params.filter_query) {
          responseText += ` matching '${params.filter_query}'`
        }

        const appNameForText = appToUse
        responseText += ` in \`${appNameForText}\``

        if (params.offset && params.offset > 0) {
          const currentOffset = params.offset || 0
          responseText += ` (showing items ${currentOffset + 1} to ${currentOffset + fragments.length})`
        }
        const topItemsList = fragments
          .slice(0, 3)
          .map((f) => `- \"${f.source.title || "Untitled"}\"`)
          .join("\n")
        responseText += `.\nTop items:\n${topItemsList}`

        const successResult: {
          result: string
          contexts: MinimalAgentFragment[]
        } = {
          result: responseText,
          contexts: fragments,
        }
        return successResult
      } else {
        let notFoundMsg = `Could not find the slack messages`
        if (params.filter_query)
          notFoundMsg += ` matching '${params.filter_query}'`
        // Use the processed app name if available
        const appNameForText = appToUse
        if (params.app) notFoundMsg += ` in ${appNameForText}`
        notFoundMsg += `.`
        return { result: notFoundMsg, contexts: [] }
      }
    } catch (error) {
      const errMsg = getErrorMessage(error)
      execSpan?.setAttribute("error", errMsg)
      Logger.error(error, `Metadata retrieval tool error: ${errMsg}`)
      // Ensure this return type matches the interface
      return {
        result: `Error retrieving metadata: ${errMsg}`,
        error: errMsg,
      }
    } finally {
      execSpan?.end()
    }
  },
}

export const getSlackMessagesFromUser: AgentTool = {
  name: "get_slack_messages_from_user",
  description:
    "Retrieves Slack messages sent by a specific user across all accessible channels. Use when analyzing a user's communication patterns, finding their contributions, or tracking their activity.",
  parameters: {
    user_email: {
      type: "string",
      description: "Email address of the user whose messages to retrieve",
      required: true,
    },
    filter_query: {
      type: "string",
      description:
        "Keywords to search within the user's messages (e.g., 'project alpha', 'bug report')",
      required: false,
    },
    channel_name: {
      type: "string",
      description: "Optional channel name to limit search to specific channel",
      required: false,
    },
    limit: {
      type: "number",
      description: "Maximum number of messages to retrieve. default (20)",
      required: false,
    },
    offset: {
      type: "number",
      description: "Number of messages to skip for pagination",
      required: false,
    },
    order_direction: {
      type: '<"asc" | "desc">',
      description:
        "Sort direction based on message timestamp. default to 'desc' (newest first)",
      required: false,
    },
    date_from: {
      type: "string",
      description:
        "Start date for message search (ISO 8601 format: YYYY-MM-DD)",
      required: false,
    },
    date_to: {
      type: "string",
      description: "End date for message search (ISO 8601 format: YYYY-MM-DD)",
      required: false,
    },
  }, // No parameters needed from the LLM
  execute: async (
    params: any,
    span?: Span,
    email?: string,
    ctx?: string,
    agentPrompt?: string,
  ) => {
    const execSpan = span?.startSpan("slack_message")
    if (!email) {
      const errorMsg = "email is required for search tool execution."
      execSpan?.setAttribute("error", errorMsg)
      return { result: errorMsg, error: "Missing user email" }
    }

    if (agentPrompt) {
      const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)
      execSpan?.setAttribute("agent_app_enums", JSON.stringify(agentAppEnums))
      if (!agentAppEnums.includes(Apps.Slack)) {
        return {
          result:
            "Slack is not an allowed app for this agent. Cannot retrieve messages from user.",
          contexts: [],
        }
      }
    }

    try {
      let appToUse: Apps = Apps.Slack // This tool is specific to Slack
      if (!params.user_email) {
        return {
          result: "User email is required to retrieve messages.",
          error: "Missing user_email parameter",
        }
      }
      let searchResults: VespaSearchResponse | null = null
      let children: VespaSearchResults[] = []
      const searchOptionsVespa: {
        limit: number
        offset: number
        span: Span | undefined
        filterQuery?: string
        orderDirection?: "asc" | "desc"
        dateFrom?: string
        dateTo?: string
      } = {
        limit: params.limit || 10,
        offset: params.offset || 0,
        filterQuery: params.filter_query,
        orderDirection: params.order_direction || "desc",
        dateFrom: params.date_from ?? null,
        dateTo: params.date_to ?? null,
        span: execSpan,
      }

      console.log(
        "[Retrieve Slack Thread] Common Vespa searchOptions:",
        JSON.stringify(searchOptionsVespa, null, 2),
      )

      const searchQuery = params.filter_query
      console.log(
        `[get_slack_messages_from_user] Using searchVespa with filter_query: '${searchQuery}'`,
      )

      const searchParams: GetThreadItemsParams & {
        filterQuery: string
        orderDirection: string
      } = {
        userEmail: params.user_email,
        channelName: params.channel_name,
        filterQuery: searchOptionsVespa.filterQuery || "",
        email: email,
        asc: params.order_direction === "asc",
        limit: searchOptionsVespa.limit,
        offset: searchOptionsVespa.offset,
        orderDirection: searchOptionsVespa.orderDirection ?? "desc",
        timestampRange: {
          from: searchOptionsVespa.dateFrom,
          to: searchOptionsVespa.dateTo,
        },
      }
      const searchResponse = await getThreadItems(searchParams)
      const rawItems = searchResponse?.root?.children || []
      const items: VespaSearchResults[] = rawItems.filter(
        (item): item is VespaSearchResults =>
          !!(item && item.fields && "sddocname" in item.fields),
      )

      if (items.length > 0) {
        const fragments: MinimalAgentFragment[] = items.map(
          (item: VespaSearchResults): MinimalAgentFragment => {
            const citation = searchToCitation(item)
            Logger.debug({ item }, "Processing item in metadata_retrieval tool")

            const content = item.fields
              ? answerContextMap(item, maxDefaultSummary)
              : `Context unavailable for ${citation.title || citation.docId}`

            return {
              id: `${citation.docId}`,
              content: content,
              source: citation,
              confidence: item.relevance || 0.7, // Use item.relevance if available
            }
          },
        )

        let responseText = `Found ${fragments.length} Slack message${fragments.length !== 1 ? "s" : ""}`
        if (params.filter_query) {
          responseText += ` matching '${params.filter_query}'`
        }
        // Use the processed app name if available
        const appNameForText = appToUse
        if (params.app) {
          responseText += ` in \`${appNameForText}\``
        }
        if (params.offset && params.offset > 0) {
          const currentOffset = params.offset || 0
          responseText += ` (showing items ${currentOffset + 1} to ${currentOffset + fragments.length})`
        }
        const topItemsList = fragments
          .slice(0, 3)
          .map((f) => `- \"${f.source.title || "Untitled"}\"`)
          .join("\n")
        responseText += `.\nTop items:\n${topItemsList}`

        const successResult: {
          result: string
          contexts: MinimalAgentFragment[]
        } = {
          result: responseText,
          contexts: fragments,
        }
        return successResult
      } else {
        let notFoundMsg = `Could not find the slack messages`
        if (params.filter_query)
          notFoundMsg += ` matching '${params.filter_query}'`
        // Use the processed app name if available
        const appNameForText = appToUse
        if (params.app) notFoundMsg += ` in ${appNameForText}`
        notFoundMsg += `.`
        return { result: notFoundMsg, contexts: [] }
      }
    } catch (error) {
      const errMsg = getErrorMessage(error)
      execSpan?.setAttribute("error", errMsg)
      Logger.error(error, `Metadata retrieval tool error: ${errMsg}`)
      // Ensure this return type matches the interface
      return {
        result: `Error retrieving metadata: ${errMsg}`,
        error: errMsg,
      }
    } finally {
      execSpan?.end()
    }
  },
}

export const getSlackRelatedMessages: AgentTool = {
  name: "get_slack_related_messages",
  description:
    "Unified tool to retrieve Slack messages with flexible filtering options. Can search by channel, user, time range, thread, or any combination. Use this single tool for all Slack message retrieval needs.",
  parameters: {
    filter_query: {
      type: "string",
      description: "Keywords to search within messages",
      required: false,
    },
    channel_name: {
      type: "string",
      description: "Name of specific channel to search within",
      required: false,
    },
    user_email: {
      type: "string",
      description: "Email of specific user whose messages to retrieve",
      required: false,
    },
    date_from: {
      type: "string",
      description:
        "Start date for message search (ISO 8601 format: YYYY-MM-DD)",
      required: false,
    },
    date_to: {
      type: "string",
      description: "End date for message search (ISO 8601 format: YYYY-MM-DD)",
      required: false,
    },
    limit: {
      type: "number",
      description:
        "Maximum number of messages to retrieve (default: 20, max: 100)",
      required: false,
    },
    offset: {
      type: "number",
      description: "Number of messages to skip for pagination (default: 0)",
      required: false,
    },
    order_direction: {
      type: '"asc" | "desc"',
      description:
        "Sort direction - 'asc' (oldest first) or 'desc' (newest first, default)",
      required: false,
    },
  },

  execute: async (
    params: any,
    span?: Span,
    email?: string,
    ctx?: string,
    agentPrompt?: string,
  ) => {
    const execSpan = span?.startSpan("slack_messages_unified")

    if (!email) {
      const errorMsg = "User email is required for Slack message retrieval."
      execSpan?.setAttribute("error", errorMsg)
      return { result: errorMsg, error: "Missing user email" }
    }

    if (agentPrompt) {
      const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)
      execSpan?.setAttribute("agent_app_enums", JSON.stringify(agentAppEnums))
      if (!agentAppEnums.includes(Apps.Slack)) {
        return {
          result:
            "Slack is not an allowed app for this agent. Cannot retrieve related Slack messages.",
          contexts: [],
        }
      }
      // If agentPrompt is present and Slack is allowed, proceed.
    }

    try {
      // Validate that at least one scope parameter is provided
      const hasScope =
        params.channel_name ||
        params.user_email ||
        params.thread_id || // Assuming thread_id might be a parameter for this unified tool
        params.from ||
        params.to

      if (!hasScope && !params.filter_query) {
        return {
          result:
            "Please provide at least one filter (e.g., channel_name, user_email, date range, or filter_query) to scope the Slack message search.",
          error: "Insufficient search parameters",
        }
      }

      // Set up search options with validation
      const searchOptions = {
        limit: Math.min(params.limit || 20, 100), // Cap at 100 for performance
        offset: Math.max(params.offset || 0, 0),
        filterQuery: params.filter_query,
        orderDirection: (params.order_direction || "desc") as "asc" | "desc",
        dateFrom: params.from || null,
        dateTo: params.to || null,
        span: execSpan,
      }

      // Build search parameters based on what's provided
      const searchParams: GetThreadItemsParams & {
        filterQuery: string
        orderDirection: string
      } = {
        email: email,
        userEmail: params.user_email || undefined,
        channelName: params.channel_name || undefined,
        filterQuery: searchOptions.filterQuery || "",
        asc: searchOptions.orderDirection === "asc",
        limit: searchOptions.limit,
        offset: searchOptions.offset,
        orderDirection: searchOptions.orderDirection,
        timestampRange: {
          from: searchOptions.dateFrom,
          to: searchOptions.dateTo,
        },
      }

      // Log search strategy for debugging
      const searchStrategy = []
      if (params.channel_name)
        searchStrategy.push(`channel: ${params.channel_name}`)
      if (params.user_email) searchStrategy.push(`user: ${params.user_email}`)
      if (params.thread_id) searchStrategy.push(`thread: ${params.thread_id}`)
      if (params.date_from || params.date_to) {
        searchStrategy.push(`dates: ${params.from} to ${params.to}`)
      }
      if (params.filter_query)
        searchStrategy.push(`query: "${params.filter_query}"`)

      Logger.debug(
        `[get_slack_messages] Search strategy: ${searchStrategy.join(", ")}`,
      )

      // Execute the search
      const searchResponse = await getThreadItems(searchParams)
      const rawItems = searchResponse?.root?.children || []

      // Filter and validate results
      const items: VespaSearchResults[] = rawItems.filter(
        (item): item is VespaSearchResults =>
          !!(item && item.fields && "sddocname" in item.fields),
      )

      if (!items.length) {
        let noResultsMsg = "No messages found"
        if (searchStrategy.length > 0) {
          noResultsMsg += ` for: ${searchStrategy.join(", ")}`
        }
        return {
          result: noResultsMsg,
          contexts: [],
        }
      }

      // Process results into fragments
      const fragments: MinimalAgentFragment[] = items.map(
        (item: VespaSearchResults): MinimalAgentFragment => {
          const citation = searchToCitation(item)
          Logger.debug({ item }, "Processing Slack message item")

          const content = item.fields
            ? answerContextMap(item, maxDefaultSummary)
            : `Content unavailable for ${citation.title || citation.docId}`

          return {
            id: `${citation.docId}`,
            content: content,
            source: citation,
            confidence: item.relevance || 0.7,
          }
        },
      )

      // Build response message
      let responseText = `Found ${fragments.length} Slack message${fragments.length !== 1 ? "s" : ""}`

      // Add context about what was searched
      if (searchStrategy.length > 0) {
        responseText += ` (${searchStrategy.join(", ")})`
      }

      // Add pagination info
      if (searchOptions.offset > 0) {
        responseText += ` (items ${searchOptions.offset + 1}-${searchOptions.offset + fragments.length})`
      }

      // Show top results preview
      if (fragments.length > 0) {
        const topItemsList = fragments
          .slice(0, 3)
          .map((f, index) => {
            const title = f.source.title || "Untitled"
            const preview = f.content.substring(0, 60).replace(/\n/g, " ")
            return `${index + 1}. "${title}" - ${preview}${f.content.length > 60 ? "..." : ""}`
          })
          .join("\n")
        responseText += `\n\nTop results:\n${topItemsList}`
      }

      // Add pagination guidance if there might be more results
      if (fragments.length === searchOptions.limit) {
        responseText += `\n\n💡 Showing ${searchOptions.limit} results. Use offset parameter to see more.`
      }

      return {
        result: responseText,
        contexts: fragments,
      }
    } catch (error) {
      const errMsg = getErrorMessage(error)
      execSpan?.setAttribute("error", errMsg)
      Logger.error(error, `Slack messages retrieval error: ${errMsg}`)

      return {
        result: `Error retrieving Slack messages: ${errMsg}`,
        error: errMsg,
      }
    } finally {
      execSpan?.end()
    }
  },
}

export const getUserSlackProfile: AgentTool = {
  name: "get_user_slack_profile",
  description: "Get a user's Slack profile details by their email address.",
  parameters: {
    user_email: {
      type: "string",
      description: "Email address of the user whose Slack profile to retrieve.",
      required: true,
    },
  },
  execute: async (
    params: { user_email: string },
    span?: Span,
    invokingUserEmail?: string,
    ctx?: string,
    agentPrompt?: string,
  ) => {
    const execSpan = span?.startSpan("get_user_slack_profile_tool")
    execSpan?.setAttribute("target_user_email", params.user_email)

    if (agentPrompt) {
      const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)
      execSpan?.setAttribute("agent_app_enums", JSON.stringify(agentAppEnums))
      if (!agentAppEnums.includes(Apps.Slack)) {
        return {
          result:
            "Slack is not an allowed app for this agent. Cannot retrieve Slack user profile.",
          contexts: [],
        }
      }
    }

    if (!params.user_email) {
      const errorMsg =
        "Target user_email parameter is required to retrieve the Slack profile."
      execSpan?.setAttribute("error", errorMsg)
      return { result: errorMsg, error: "Missing target_user_email parameter" }
    }

    try {
      const searchResponse = await getSlackUserDetails(params.user_email)
      const children = searchResponse?.root?.children || []
      execSpan?.setAttribute("retrieved_profiles_count", children.length)

      if (children.length === 0) {
        return {
          result: `No Slack profile found for email: ${params.user_email}`,
          contexts: [],
        }
      }

      const userProfileDoc = children[0] as VespaSearchResults
      if (!userProfileDoc.fields) {
        Logger.warn("Couldn't retrieve user profile", {
          docId: userProfileDoc.id,
          fields: userProfileDoc.fields,
        })
        return {
          result: `Found a document for ${params.user_email}, but it's not a valid Slack user profile. Expected sddocname 'chat_user'.`,
          contexts: [],
        }
      }

      const profileData = userProfileDoc.fields as VespaChatUser

      let profileSummary = `Slack Profile for ${profileData.name || params.user_email}:\n`
      if (profileData.email) profileSummary += `- Email: ${profileData.email}\n`
      // Use docId for User ID as it's the Slack User ID from chat_user schema
      if (profileData.docId)
        profileSummary += `- User ID: ${profileData.docId}\n`
      if (profileData.name) profileSummary += `- Name: ${profileData.name}\n`
      if (profileData.image)
        profileSummary += `- Image URL: ${profileData.image}\n` // Use 'image'
      if (profileData.statusText)
        profileSummary += `- Status: ${profileData.statusText}\n`
      if (profileData.title) profileSummary += `- Title: ${profileData.title}\n` // 'title' field from VespaChatUser
      if (profileData.teamId)
        profileSummary += `- Team ID: ${profileData.teamId}\n`
      if (profileData.isAdmin !== undefined)
        profileSummary += `- Is Admin: ${profileData.isAdmin}\n`
      if (profileData.deleted !== undefined)
        profileSummary += `- Is Deleted: ${profileData.deleted}\n`

      const profileUrl = `https://app.slack.com/client/${profileData.teamId}/${profileData.docId}`

      const userFragment: MinimalAgentFragment = {
        id:
          userProfileDoc.id ||
          `slack-profile-${params.user_email}-${Date.now()}`,
        content: profileSummary,
        source: {
          docId: profileData.docId,
          title: `Slack Profile: ${profileData.name || params.user_email}`,
          app: Apps.Slack,
          entity: SlackEntity.User,
          url: profileUrl,
        },
        confidence: userProfileDoc.relevance || 0.98,
      }

      return {
        result: `Successfully retrieved Slack profile for ${params.user_email}.`,
        contexts: [userFragment],
      }
    } catch (error) {
      const errMsg = getErrorMessage(error)
      execSpan?.setAttribute("error", errMsg)
      Logger.error(error, `Error in get_my_slack_profile tool: ${errMsg}`)
      return {
        result: `Error retrieving Slack profile for ${params.user_email}: ${errMsg}`,
        error: errMsg,
      }
    } finally {
      execSpan?.end()
    }
  },
}

export const getSlackMessagesFromChannel: AgentTool = {
  name: "get_slack_messages_from_channel",
  description:
    "Retrieves Slack messages from a specific channel or group. Use when analyzing channel activity, finding discussions on specific topics, or reviewing channel history.",
  parameters: {
    channel_name: {
      type: "string",
      description: "Name of the channel",
      required: true,
    },
    filter_query: {
      type: "string",
      description: "Keywords to search within channel messages",
      required: false,
    },
    user_email: {
      type: "string",
      description:
        "Optional user email to filter messages from specific user in the channel",
      required: false,
    },
    limit: {
      type: "number",
      description: "Maximum number of messages to retrieve. default(20)",
      required: false,
    },
    offset: {
      type: "number",
      description: "Number of messages to skip for pagination",
      required: false,
    },
    order_direction: {
      type: '"asc" | "desc"',
      description: "Sort direction default to 'desc' (newest first)",
      required: false,
    },
    date_from: {
      type: "string",
      description:
        "Start date for message search (ISO 8601 format: YYYY-MM-DD)",
      required: false,
    },
    date_to: {
      type: "string",
      description: "End date for message search (ISO 8601 format: YYYY-MM-DD)",
      required: false,
    },
  }, // No parameters needed from the LLM
  execute: async (
    params: any,
    span?: Span,
    email?: string,
    ctx?: string,
    agentPrompt?: string,
  ) => {
    const execSpan = span?.startSpan("slack_message")
    if (!email) {
      const errorMsg = "email is required for search tool execution."
      execSpan?.setAttribute("error", errorMsg)
      return { result: errorMsg, error: "Missing user email" }
    }

    if (agentPrompt) {
      const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)
      execSpan?.setAttribute("agent_app_enums", JSON.stringify(agentAppEnums))
      if (!agentAppEnums.includes(Apps.Slack)) {
        return {
          result:
            "Slack is not an allowed app for this agent. Cannot retrieve messages from channel.",
          contexts: [],
        }
      }
    }

    try {
      let appToUse: Apps = Apps.Slack // This tool is specific to Slack
      if (!params.channel_name) {
        return {
          result: "channel_name is required to retrieve messages.",
          error: "Missing channel_name parameter",
        }
      }
      let searchResults: VespaSearchResponse | null = null
      let children: VespaSearchResults[] = []
      const searchOptionsVespa: {
        limit: number
        offset: number
        span: Span | undefined
        filterQuery?: string
        orderDirection?: "asc" | "desc"
        dateFrom?: string
        dateTo?: string
      } = {
        limit: params.limit || 10,
        offset: params.offset || 0,
        filterQuery: params.filter_query,
        orderDirection: params.order_direction || "desc",
        dateFrom: params.date_from ?? null,
        dateTo: params.date_to ?? null,
        span: execSpan,
      }

      const searchQuery = params.filter_query
      console.log(
        `[get_slack_messages_from_channel] Using filter_query: '${searchQuery}'`,
      )

      const searchParams: GetThreadItemsParams & {
        filterQuery: string
        orderDirection: string
      } = {
        userEmail: params.user_email,
        channelName: params.channel_name,
        filterQuery: searchOptionsVespa.filterQuery || "",
        email: email,
        asc: params.order_direction === "asc",
        limit: searchOptionsVespa.limit,
        offset: searchOptionsVespa.offset,
        orderDirection: searchOptionsVespa.orderDirection ?? "desc",
        timestampRange: {
          from: searchOptionsVespa.dateFrom,
          to: searchOptionsVespa.dateTo,
        },
      }
      const searchResponse = await getThreadItems(searchParams)
      const rawItems = searchResponse?.root?.children || []
      const items: VespaSearchResults[] = rawItems.filter(
        (item): item is VespaSearchResults =>
          !!(item && item.fields && "sddocname" in item.fields),
      )

      if (!items.length) {
        return {
          result: `No messages found matching the filter query. ${params.filter_query ? `Query: '${params.filter_query}'` : ""}`,
          contexts: [],
        }
      }
      const fragments: MinimalAgentFragment[] = items.map(
        (item: VespaSearchResults): MinimalAgentFragment => {
          const citation = searchToCitation(item)
          Logger.debug({ item }, "Processing item in metadata_retrieval tool")

          const content = item.fields
            ? answerContextMap(item, maxDefaultSummary)
            : `Context unavailable for ${citation.title || citation.docId}`

          return {
            id: `${citation.docId}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            content: content,
            source: citation,
            confidence: item.relevance || 0.7, // Use item.relevance if available
          }
        },
      )

      let responseText = `Found ${fragments.length} Slack message${fragments.length !== 1 ? "s" : ""}`
      if (params.filter_query) {
        responseText += ` matching '${params.filter_query}'`
      }
      // Use the processed app name if available
      const appNameForText = appToUse
      if (params.app) {
        responseText += ` in \`${appNameForText}\``
      }
      if (params.offset && params.offset > 0) {
        const currentOffset = params.offset || 0
        responseText += ` (showing items ${currentOffset + 1} to ${currentOffset + fragments.length})`
      }
      const topItemsList = fragments
        .slice(0, 3)
        .map((f) => `- \"${f.source.title || "Untitled"}\"`)
        .join("\n")
      responseText += `.\nTop items:\n${topItemsList}`

      const successResult: {
        result: string
        contexts: MinimalAgentFragment[]
      } = {
        result: responseText,
        contexts: fragments,
      }
      return successResult
    } catch (error) {
      const errMsg = getErrorMessage(error)
      execSpan?.setAttribute("error", errMsg)
      Logger.error(error, `Metadata retrieval tool error: ${errMsg}`)
      // Ensure this return type matches the interface
      return {
        result: `Error retrieving metadata: ${errMsg}`,
        error: errMsg,
      }
    } finally {
      execSpan?.end()
    }
  },
}

export const getSlackMessagesFromTimeRange: AgentTool = {
  name: "get_slack_messages_from_timerange",
  description:
    "Retrieves Slack messages from across all accessible channels within a specific time range. Use for time-based analysis, finding activity during specific periods, or generating reports for date ranges.",
  parameters: {
    date_from: {
      type: "string",
      description:
        "Start date for message search (ISO 8601 format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)",
      required: true,
    },
    date_to: {
      type: "string",
      description:
        "End date for message search (ISO 8601 format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)",
      required: true,
    },
    filter_query: {
      type: "string",
      description: "Keywords to search within messages during the time range",
      required: false,
    },
    channel_name: {
      type: "string",
      description: "Optional channel name to limit search to specific channel",
      required: false,
    },
    user_email: {
      type: "string",
      description: "Optional user email to filter messages from specific user",
      required: false,
    },
    limit: {
      type: "number",
      description: "Maximum number of messages to retrieve. default (20)",
      required: false,
    },
    offset: {
      type: "number",
      description: "Number of messages to skip for pagination",
      required: false,
    },
    order_direction: {
      type: '"asc" | "desc"',
      description:
        "Sort direction based on message timestamp. default to 'desc' (newest first)",
      required: false,
    },
  }, // No parameters needed from the LLM
  execute: async (
    params: any,
    span?: Span,
    email?: string,
    ctx?: string,
    agentPrompt?: string,
  ) => {
    const execSpan = span?.startSpan("slack_message")
    if (!email) {
      const errorMsg = "email is required for search tool execution."
      execSpan?.setAttribute("error", errorMsg)
      return { result: errorMsg, error: "Missing user email" }
    }

    if (agentPrompt) {
      const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)
      execSpan?.setAttribute("agent_app_enums", JSON.stringify(agentAppEnums))
      if (!agentAppEnums.includes(Apps.Slack)) {
        return {
          result:
            "Slack is not an allowed app for this agent. Cannot retrieve messages from time range.",
          contexts: [],
        }
      }
    }

    try {
      // Correctly check for date_from and date_to as per the tool's parameters
      if (!params.date_from || !params.date_to) {
        return {
          result:
            "Date range (date_from and date_to) is required to retrieve messages.",
          error: "Missing date_from or date_to parameter",
        }
      }

      const appToUse: Apps = Apps.Slack // This tool is specific to Slack

      const searchOptionsVespa: {
        limit: number
        offset: number
        span: Span | undefined
        filterQuery?: string
        orderDirection?: "asc" | "desc"
        dateFrom?: string
        dateTo?: string
      } = {
        limit: params.limit || 10,
        offset: params.offset || 0,
        filterQuery: params.filter_query,
        orderDirection: params.order_direction || "desc",
        dateFrom: params.date_from, // Use params.date_from as it's required
        dateTo: params.date_to, // Use params.date_to as it's required
        span: execSpan,
      }

      const searchQuery = params.filter_query
      console.log(
        `[getSlackMessagesFromTimeRange] Using filter_query: '${searchQuery || ""}'`,
      )

      const searchParams: GetThreadItemsParams & {
        filterQuery: string
        orderDirection: string
      } = {
        userEmail: params.user_email,
        channelName: params.channel_name,
        filterQuery: searchOptionsVespa.filterQuery || "",
        email: email,
        asc: params.order_direction === "asc",
        limit: searchOptionsVespa.limit,
        offset: searchOptionsVespa.offset,
        orderDirection: searchOptionsVespa.orderDirection ?? "desc",
        timestampRange: {
          from: searchOptionsVespa.dateFrom,
          to: searchOptionsVespa.dateTo,
        },
      }
      const searchResponse = await getThreadItems(searchParams)
      const rawItems = searchResponse?.root?.children || []
      const items: VespaSearchResults[] = rawItems.filter(
        (item): item is VespaSearchResults =>
          !!(item && item.fields && "sddocname" in item.fields),
      )

      if (!items.length) {
        return {
          result: `No messages found matching the filter query. ${params.filter_query ? `Query: '${params.filter_query}'` : ""}`,
          contexts: [],
        }
      }
      const fragments: MinimalAgentFragment[] = items.map(
        (item: VespaSearchResults): MinimalAgentFragment => {
          const citation = searchToCitation(item)
          Logger.debug({ item }, "Processing item in metadata_retrieval tool")

          const content = item.fields
            ? answerContextMap(item, maxDefaultSummary)
            : `Context unavailable for ${citation.title || citation.docId}`

          return {
            id: `${citation.docId}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            content: content,
            source: citation,
            confidence: item.relevance || 0.7, // Use item.relevance if available
          }
        },
      )

      let responseText = `Found ${fragments.length} Slack message${fragments.length !== 1 ? "s" : ""}`
      if (params.filter_query) {
        responseText += ` matching '${params.filter_query}'`
      }
      // Use the processed app name if available
      const appNameForText = appToUse
      if (params.app) {
        responseText += ` in \`${appNameForText}\``
      }
      if (params.offset && params.offset > 0) {
        const currentOffset = params.offset || 0
        responseText += ` (showing items ${currentOffset + 1} to ${currentOffset + fragments.length})`
      }
      const topItemsList = fragments
        .slice(0, 3)
        .map((f) => `- \"${f.source.title || "Untitled"}\"`)
        .join("\n")
      responseText += `.\nTop items:\n${topItemsList}`

      const successResult: {
        result: string
        contexts: MinimalAgentFragment[]
      } = {
        result: responseText,
        contexts: fragments,
      }
      return successResult
    } catch (error) {
      const errMsg = getErrorMessage(error)
      execSpan?.setAttribute("error", errMsg)
      Logger.error(error, `Metadata retrieval tool error: ${errMsg}`)
      // Ensure this return type matches the interface
      return {
        result: `Error retrieving metadata: ${errMsg}`,
        error: errMsg,
      }
    } finally {
      execSpan?.end()
    }
  },
}

// Fallback Tool - activates when iterations are exhausted and synthesis is not complete
export const fallbackTool: AgentTool = {
  name: "fall_back",
  description:
    "Generate detailed reasoning about why the search failed when initial iterations are exhausted but synthesis is still not complete.",
  parameters: {
    originalQuery: {
      type: "string",
      description: "The original user query",
      required: true,
    },
    agentScratchpad: {
      type: "string",
      description: "The agent reasoning history",
      required: true,
    },
    toolLog: {
      type: "string",
      description: "The tool execution log",
      required: true,
    },
    gatheredFragments: {
      type: "string",
      description: "The gathered context fragments",
      required: true,
    },
  },
  execute: async (
    params: {
      originalQuery: string
      agentScratchpad: string
      toolLog: string
      gatheredFragments: string
    },
    span?: Span,
    userCtx?: string,
  ) => {
    const execSpan = span?.startSpan("execute_fallback_tool")

    try {
      // Import the generateFallback function
      const { generateFallback } = await import("@/ai/provider")

      // Generate detailed reasoning about why the search failed
      const fallbackResponse = await generateFallback(
        userCtx || "",
        params.originalQuery,
        params.agentScratchpad,
        params.toolLog,
        params.gatheredFragments,
        {
          modelId: defaultFastModel,
          stream: false,
          json: true,
        },
      )

      if (
        !fallbackResponse.reasoning ||
        fallbackResponse.reasoning.trim() === ""
      ) {
        return {
          result: "No reasoning could be generated for the search failure.",
          error: "No reasoning generated",
        }
      }

      // Return only the reasoning, not alternative queries
      Logger.info(
        `Fallback tool generated detailed reasoning about search failure`,
      )

      return {
        result: `Fallback analysis completed. Generated detailed reasoning about why the search was unsuccessful.`,
        fallbackReasoning: fallbackResponse.reasoning, // Pass only the reasoning
      }
    } catch (error) {
      const errMsg = getErrorMessage(error)
      execSpan?.setAttribute("error", errMsg)
      Logger.error(error, `Fallback tool error: ${errMsg}`)
      return {
        result: `Fallback analysis failed: ${errMsg}`,
        error: errMsg,
      }
    } finally {
      execSpan?.end()
    }
  },
}

export const agentTools: Record<string, AgentTool> = {
  get_user_info: userInfoTool,
  metadata_retrieval: metadataRetrievalTool,
  search: searchTool,
  // Slack-specific tools
  get_slack_threads: getSlackThreads,
  get_slack_related_messages: getSlackRelatedMessages,
  get_user_slack_profile: getUserSlackProfile,
  fall_back: fallbackTool,
}
