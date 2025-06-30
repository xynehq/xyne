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
  type VespaSchema,
  type VespaSearchResponse,
  type VespaSearchResult,
  type VespaSearchResults,
  type VespaSearchResultsSchema,
  type VespaUser,
} from "@/search/types"

import {
  type AgentTool,
  type FilteredSearchParameters,
  type MetadataRetrievalParameters,
  type MinimalAgentFragment,
  type SearchParameters,
} from "./types"
import { searchToCitation } from "./utils"
export const textToCitationIndex = /\[(\d+)\]/g
import config from "@/config"
import { is } from "drizzle-orm"
import { appToSchemaMapper } from "@/search/mappers"

const { maxDefaultSummary } = config
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

  const children = (searchResults?.root?.children || []).filter(
    (item): item is VespaSearchResults =>
      !!(item.fields && "sddocname" in item.fields),
  )
  execSpan?.setAttribute("results_count", children.length)

  if (children.length === 0) {
    return { result: "No results found.", contexts: [] }
  }

  const fragments: MinimalAgentFragment[] = children.map((r) => {
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

// Search Tool (existing)
export const searchTool: AgentTool = {
  name: "search",
  description:
    "Search for general information across all data sources (Gmail, Calendar, Drive) using keywords.",
  parameters: {
    query: {
      type: "string",
      description: "The keywords or question to search for.",
      required: true,
    },
    limit: {
      type: "number",
      description: "Maximum number of results (default: 10).",
      required: false,
    },
    excludedIds: {
      type: "array",
      description: "Optional list of document IDs to exclude from results.",
      required: false,
    },
  },
  execute: async (
    params: SearchParameters,
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

      const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)

      return await executeVespaSearch({
        email,
        query: queryToUse,
        limit: params.limit,
        excludedIds: params.excludedIds,
        agentAppEnums,
        span: execSpan,
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

// Filtered Search Tool (existing)
export const filteredSearchTool: AgentTool = {
  name: "filtered_search",
  description:
    "Search for information using keywords within a specific application. The 'app' parameter MUST BE EXACTLY ONE OF 'gmail', 'googlecalendar', 'googledrive'.",
  parameters: {
    filter_query: {
      type: "string",
      description: "The keywords or question to search for.",
      required: true,
    },
    app: {
      type: "string",
      description:
        "Optional app filter. If provided, MUST BE EXACTLY ONE OF 'gmail', 'googlecalendar', 'googledrive'. If omitted, inferred from item_type.",
      required: false,
    },
    entity: {
      type: "string",
      description:
        "Optional specific kind of item if item_type is 'document' or 'file' (e.g., 'spreadsheet', 'pdf', 'presentation').",
      required: false,
    },
    limit: {
      type: "number",
      description: "Maximum number of results (default: 10).",
      required: false,
    },
    offset: {
      type: "number",
      description: "Number of items to skip for pagination (default: 0).",
      required: false,
    },
    order_direction: {
      type: "string",
      description:
        "Sort direction: 'asc' (oldest first) or 'desc' (newest first, default).",
      required: false,
    },
    excludedIds: {
      type: "array",
      description: "Optional list of document IDs to exclude from results.",
      required: false,
    },
  },
  execute: async (
    params: FilteredSearchParameters,
    span?: Span,
    email?: string,
    usrCtx?: string,
    agentPrompt?: string,
    userMessage?: string,
    userAlpha?: number,
  ) => {
    const execSpan = span?.startSpan("execute_filtered_search_tool")
    try {
      if (!email) {
        const errorMsg = "Email is required for search tool execution."
        execSpan?.setAttribute("error", errorMsg)
        return { result: errorMsg, error: "Missing email" }
      }

      const app = params?.app || null
      const appEnum: Apps | null = isValidApp(app ?? "") ? (app as Apps) : null

      if (!appEnum) {
        const errorMsg = `Error: Invalid app specified: '${params.app}'. Valid apps are 'gmail', 'googlecalendar', 'googledrive'.`
        execSpan?.setAttribute("error", errorMsg)
        return { result: errorMsg, error: "Invalid app" }
      }

      const schema = appToSchemaMapper(appEnum)
      const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)

      return await executeVespaSearch({
        email,
        query: params.filter_query,
        app: appEnum,
        entity: isValidEntity(params.entity || "")
          ? (params.entity as Entity)
          : null,
        limit: params.limit,
        offset: params.offset,
        orderDirection: params.order_direction,
        excludedIds: params.excludedIds,
        agentAppEnums,
        span: execSpan,
        schema: params.filter_query ? null : schema,
      })
    } catch (error) {
      const errMsg = getErrorMessage(error)
      execSpan?.setAttribute("error", errMsg)
      return {
        result: `Search error in ${params.app || "filtered search"}: ${errMsg}`,
        error: errMsg,
      }
    } finally {
      execSpan?.end()
    }
  },
}

// Time Search Tool
export const timeSearchTool: AgentTool = {
  name: "time_search",
  description:
    "Search for information using keywords within a specific time range (relative to today).",
  parameters: {
    filter_query: {
      type: "string",
      description: "The keywords or question to search for.",
      required: true,
    },
    from: {
      type: "string",
      description: "Start date for search (ISO 8601 format: YYYY-MM-DD).",
      required: true,
    },
    to: {
      type: "string",
      description: "End date for search (ISO 8601 format: YYYY-MM-DD).",
      required: true,
    },
    app: {
      type: "string",
      description:
        "Optional app filter. If provided, MUST BE EXACTLY ONE OF 'gmail', 'googlecalendar', 'googledrive'. If omitted, inferred from item_type.",
      required: false,
    },
    entity: {
      type: "string",
      description:
        "Optional specific kind of item if item_type is 'document' or 'file' (e.g., 'spreadsheet', 'pdf', 'presentation').",
      required: false,
    },
    limit: {
      type: "number",
      description: "Maximum number of results (default: 10).",
      required: false,
    },
    excludedIds: {
      type: "array",
      description: "Optional list of document IDs to exclude from results.",
      required: false,
    },
  },
  execute: async (
    params: {
      query: string
      from: string
      to: string
      limit?: number
      excludedIds?: string[]
      app?: Apps,
      entity?: Entity | null,
    },
    span?: Span,
    email?: string,
    userCtx?: string,
    agentPrompt?: string,
  ) => {
    console.log("tool params in time search tool", params)
    const execSpan = span?.startSpan("execute_time_search_tool")
    try {
      if (!email) {
        const errorMsg = "Email is required for search tool execution."
        execSpan?.setAttribute("error", errorMsg)
        return { result: errorMsg, error: "Missing email" }
      }
      const searchLimit = params.limit || 10
      execSpan?.setAttribute("query", params.query)
      execSpan?.setAttribute("from", params.from)
      execSpan?.setAttribute("to", params.to)
      execSpan?.setAttribute("limit", searchLimit)
      if (params.excludedIds && params.excludedIds.length > 0) {
        execSpan?.setAttribute(
          "excludedIds",
          JSON.stringify(params.excludedIds),
        )
      }
      const from = new Date(params.from).getTime()
      const to = new Date(params.to).getTime()
      execSpan?.setAttribute("from_date", new Date(from).toISOString())
      execSpan?.setAttribute("to_date", new Date(to).toISOString())
      let searchResults: VespaSearchResponse | null = null
      if (agentPrompt) {
        // Parse agent integrations but still filter by the specified app
        const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)
        execSpan?.setAttribute("agent_app_enums", JSON.stringify(agentAppEnums))
        if (agentAppEnums.length === 0) {
          return {
            result: `No results found in the specified time range.`,
            contexts: [],
          }
        } else {
          searchResults = await searchVespaAgent(
            params.query,
            email,
            params.app || null,
            params.entity || null,
            agentAppEnums,
            {
              limit: searchLimit,
              alpha: 0.5,
              timestampRange: { from, to },
              excludedIds: params.excludedIds, // Pass excludedIds
              span: execSpan?.startSpan("vespa_search"),
            },
          )
        }
        execSpan?.setAttribute("agent_prompt", agentPrompt)
      } else {
        console.log(from,to, "from to in time search tool")
        searchResults = await searchVespa(params.query, email, params.app||null, params.entity || null, {
          limit: searchLimit,
          alpha: 0.5,
          timestampRange: { from, to },
          excludedIds: params.excludedIds, // Pass excludedIds
          span: execSpan?.startSpan("vespa_search"),
        })
      }

      const children = searchResults?.root?.children || []
      execSpan?.setAttribute("results_count", children.length)
      if (children.length === 0)
        return {
          result: `No results found in the specified time range.`,
          contexts: [],
        }
      const fragments = children.map((r) => {
        const citation = searchToCitation(r as any)
        return {
          id: `${citation.docId}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          content: answerContextMap(r as any, maxDefaultSummary),
          source: citation,
          confidence: r.relevance || 0.7,
        }
      })
      const topItemsList = fragments
        .slice(0, 3)
        .map((f) => `- \"${f.source.title || "Untitled"}\"`)
        .join("\n")
      const summaryText = `Found ${fragments.length} results in time range (\`${params.from}\` to \`${params.to}\`).\nTop items:\n${topItemsList}`
      return { result: summaryText, contexts: fragments }
    } catch (error) {
      const errMsg = getErrorMessage(error)
      execSpan?.setAttribute("error", errMsg)
      return { result: `Time search error: ${errMsg}`, error: errMsg }
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

const itemTypeMappings: Record<string, ItemTypeMappingDetails> = {
  meeting: meetingEventMapping,
  event: meetingEventMapping,
  email: emailMessageNotificationMapping,
  message: emailMessageNotificationMapping,
  notification: emailMessageNotificationMapping,
  document: documentFileMapping,
  file: documentFileMapping,
  mail_attachment: attachmentMapping,
  attachment: attachmentMapping,
  user: userPersonMapping,
  person: userPersonMapping,
  contact: contactMapping,
}

// === NEW Metadata Retrieval Tool ===
export const metadataRetrievalTool: AgentTool = {
  name: "metadata_retrieval",
  description:
    "Retrieves a list of items (e.g., emails, calendar events, drive files) based on type and time. Use for 'list my recent emails', 'show my first documents about X', 'find uber receipts'.",
  parameters: {
    item_type: {
      type: "string",
      description:
        "Type of item (e.g., 'meeting', 'event', 'email', 'notification', 'document', 'file'). For receipts or specific service-related items in email, use 'email'.",
      required: true,
    },
    app: {
      type: "string",
      description:
        "Optional app filter. If provided, MUST BE EXACTLY ONE OF 'gmail', 'googlecalendar', 'googledrive'. If omitted, inferred from item_type.",
      required: false,
    },
    entity: {
      type: "string",
      description:
        "Optional specific kind of item if item_type is 'document' or 'file' (e.g., 'spreadsheet', 'pdf', 'presentation').",
      required: false,
    },
    filter_query: {
      type: "string",
      description:
        "Optional keywords to filter the items (e.g., 'uber trip', 'flight confirmation').",
      required: false,
    },
    limit: {
      type: "number",
      description: "Maximum number of items to retrieve (default: 10).",
      required: false,
    },
    offset: {
      type: "number",
      description: "Number of items to skip for pagination (default: 0).",
      required: false,
    },
    order_direction: {
      type: "string",
      description:
        "Sort direction: 'asc' (oldest first) or 'desc' (newest first, default).",
      required: false,
    },
    excludedIds: {
      type: "array",
      description: "Optional list of document IDs to exclude from results.",
      required: false,
    },
  },
  execute: async (
    params: MetadataRetrievalParameters,
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
    execSpan?.setAttribute("item_type", params.item_type)
    if (params.app) execSpan?.setAttribute("app_param_original", params.app)
    if (params.entity) execSpan?.setAttribute("entity_param", params.entity)
    if (params.filter_query)
      execSpan?.setAttribute("filter_query", params.filter_query)

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

      // 2. Map item_type to schema, entity, timestampField, and default appToUse if not already set by user
      const mapping = itemTypeMappings[params.item_type.toLowerCase()]

      if (!mapping) {
        const unknownItemMsg = `Error: Unknown item_type '${params.item_type}'`
        execSpan?.setAttribute("error", unknownItemMsg)
        Logger.error("[metadata_retrieval] Unknown item_type:", unknownItemMsg)
        return { result: unknownItemMsg, error: `Unknown item_type` }
      }

      schema = mapping.schema
      entity = mapping.defaultEntity
      timestampField = mapping.timestampField
      if (!appToUse) {
        appToUse = mapping.defaultApp
      }

      Logger.debug(
        `[metadata_retrieval] Derived from item_type '${params.item_type}': schema='${schema.toString()}', initial_entity='${entity ? entity.toString() : "null"}', timestampField='${timestampField}', inferred_appToUse='${appToUse ? appToUse.toString() : "null"}'`,
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

      if (params.app) {
        if (!isValidApp(params.app)) {
          const mismatchMsg = `Error: Item type '${params.item_type}' (typically in ${params.app}) is incompatible with specified app '${params.app}'.`
          execSpan?.setAttribute("error", mismatchMsg)
          return { result: mismatchMsg, error: `App/Item type mismatch` }
        }

        appToUse = params.app
      }

      const orderByString: string | undefined = params.order_direction
        ? `${timestampField} ${params.order_direction}`
        : undefined
      if (orderByString)
        execSpan?.setAttribute("orderBy_constructed", orderByString)
      Logger.debug(
        `[metadata_retrieval] orderByString for Vespa (if applicable): '${orderByString}'`,
      )

      const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)

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
  name: "get_user_info",
  description:
    "Retrieves basic information about the current user and their environment, such as their name, email, company, current date, and time. Use this tool when the user's query directly asks for personal details (e.g., 'What is my name?', 'My email?', 'What time is it?', 'Who am I?') that can be answered from this predefined context.",
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
      description: "Maximum number of messages to retrieve. deafault (20)",
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

export const getMailAttachment: AgentTool = {
  name: "get_mail_attachment",
  description:
    "SPECIALIZED TOOL FOR EMAIL ATTACHMENTS ONLY. Use this tool when users specifically ask for email attachments, files attached to emails, or attachments from emails. Keywords that MUST trigger this tool: 'attachments', 'attached files', 'email attachments', 'files from emails', 'attachments from newest emails', 'attachments from recent emails', 'PDF attachments', 'document attachments'. DO NOT use metadata_retrieval for attachment queries - this tool handles the complete email-to-attachment workflow.",
  parameters: {
    email_search_query: {
      type: "string",
      description: "Keywords to search for emails that contain attachments (e.g., 'invoice', 'receipt', 'contract', 'report'). This will be used to find the emails first.",
      required: true,
    },
    attachment_filter: {
      type: "string",
      description: "Optional keywords to filter attachments by filename or content (e.g., 'pdf', 'invoice', 'report').",
      required: false,
    },
    file_type: {
      type: "string",
      description: "Optional file type filter (e.g., 'pdf', 'doc', 'xlsx', 'jpg'). Case-insensitive.",
      required: false,
    },
    date_from: {
      type: "string",
      description: "Optional start date for email search (YYYY-MM-DD format).",
      required: false,
    },
    date_to: {
      type: "string",
      description: "Optional end date for email search (YYYY-MM-DD format).",
      required: false,
    },
    limit: {
      type: "number",
      description: "Maximum number of attachments to retrieve (default: 20).",
      required: false,
    },
    offset: {
      type: "number",
      description: "Number of attachments to skip for pagination (default: 0).",
      required: false,
    },
  },
  execute: async (
    params: {
      email_search_query: string
      attachment_filter?: string
      file_type?: string
      date_from?: string
      date_to?: string
      limit?: number
      offset?: number
    },
    span?: Span,
    email?: string,
    userCtx?: string,
    agentPrompt?: string,
  ) => {
    const execSpan = span?.startSpan("execute_get_mail_attachment_tool")
    
    if (!email) {
      const errorMsg = "Email is required for mail attachment retrieval."
      execSpan?.setAttribute("error", errorMsg)
      return { result: errorMsg, error: "Missing email" }
    }

    // Handle empty or wildcard queries by providing a sensible default
    let sanitizedQuery = params.email_search_query?.trim() || ""
    
    if (!sanitizedQuery || sanitizedQuery === "*") {
      // Use a broad but valid search query for finding emails with attachments
      sanitizedQuery = "has:attachment"
    }

    const searchLimit = Math.min(params.limit || 20, 100) // Cap at 100 for performance
    const searchOffset = Math.max(params.offset || 0, 0)

    execSpan?.setAttribute("email_search_query", params.email_search_query)
    execSpan?.setAttribute("limit", searchLimit)
    execSpan?.setAttribute("offset", searchOffset)
    if (params.attachment_filter) execSpan?.setAttribute("attachment_filter", params.attachment_filter)
    if (params.file_type) execSpan?.setAttribute("file_type", params.file_type)
    if (params.date_from) execSpan?.setAttribute("date_from", params.date_from)
    if (params.date_to) execSpan?.setAttribute("date_to", params.date_to)

    try {
      // Check agent permissions if agentPrompt is provided
      if (agentPrompt) {
        const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)
        execSpan?.setAttribute("agent_app_enums", JSON.stringify(agentAppEnums))
        
        if (!agentAppEnums.includes(Apps.Gmail)) {
          return {
            result: "Gmail is not an allowed app for this agent. Cannot retrieve mail attachments.",
            contexts: [],
          }
        }
      }

      // Step 1: Search for emails that match the criteria
      Logger.info(`[get_mail_attachment] Step 1: Searching for emails with query: "${params.email_search_query}"`)
      
      let timestampRange: { from: number; to: number } | null = null
      if (params.date_from || params.date_to) {
        const now = Date.now()
        const fromTime = params.date_from ? new Date(params.date_from).getTime() : now - (30 * 24 * 60 * 60 * 1000) // Default to 30 days ago
        const toTime = params.date_to ? new Date(params.date_to).getTime() : now
        timestampRange = { from: fromTime, to: toTime }
      }

      let emailSearchResults: VespaSearchResponse | null = null
      
      if (agentPrompt) {
        const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)
        emailSearchResults = await searchVespaAgent(
          params.email_search_query,
          email,
          Apps.Gmail,
          MailEntity.Email,
          agentAppEnums,
          {
            limit: 50, // Default to 50 emails to search for attachments
            alpha: 0.5,
            timestampRange,
            span: execSpan?.startSpan("vespa_search_emails"),
          },
        )
      } else {
        emailSearchResults = await searchVespa(params.email_search_query, email, Apps.Gmail, MailEntity.Email, {
          limit: 50, // Default to 50 emails to search for attachments
          alpha: 0.5,
          timestampRange,
          span: execSpan?.startSpan("vespa_search_emails"),
        })
      }

      const emailChildren = emailSearchResults?.root?.children || []
      execSpan?.setAttribute("emails_found", emailChildren.length)

      if (emailChildren.length === 0) {
        return {
          result: `No emails found matching "${params.email_search_query}"${timestampRange ? ' in the specified date range' : ''}. Cannot search for attachments without emails.`,
          contexts: [],
        }
      }

      // Step 2: Extract mail IDs from the found emails
      const mailIds: string[] = []
      const emailDebugInfo: any[] = []
      
      for (const emailItem of emailChildren) {
        if (emailItem.fields && "sddocname" in emailItem.fields && emailItem.fields.sddocname === mailSchema) {
          const mailFields = emailItem.fields as any
          
          // Debug info for each email
          const emailInfo = {
            docId: mailFields.docId,
            mailId: mailFields.mailId,
            subject: mailFields.subject,
            sddocname: mailFields.sddocname,
            hasAttachmentFilenames: mailFields.attachmentFilenames?.length > 0,
            attachmentFilenames: mailFields.attachmentFilenames,
            hasAttachments: mailFields.attachments?.length > 0,
            attachments: mailFields.attachments
          }
          emailDebugInfo.push(emailInfo)
          
          if (mailFields.mailId) {
            mailIds.push(mailFields.mailId)
          } else if (mailFields.docId) {
            // Fallback to docId if mailId is not available
            mailIds.push(mailFields.docId)
          }
        }
      }

      Logger.info(`[get_mail_attachment] Step 2: Extracted ${mailIds.length} mail IDs from ${emailChildren.length} emails`)
      Logger.info(`[get_mail_attachment] Email debug info: ${JSON.stringify(emailDebugInfo.slice(0, 5), null, 2)}`) // Log first 5 emails
      Logger.info(`[get_mail_attachment] Extracted mail IDs: ${JSON.stringify(mailIds.slice(0, 10))}`) // Log first 10 mail IDs
      
      execSpan?.setAttribute("mail_ids_extracted", mailIds.length)

      if (mailIds.length === 0) {
        return {
          result: `Found ${emailChildren.length} emails matching "${params.email_search_query}" but could not extract mail IDs. Cannot search for attachments.`,
          contexts: [],
        }
      }

      // Step 3: Search for attachments from those mail IDs
      Logger.info(`[get_mail_attachment] Step 3: Searching for attachments from ${mailIds.length} emails`)
      
      let yqlConditions: string[] = []

      // Add mail ID filter - try multiple approaches since mailId matching isn't working
      // Try both mailId and threadId fields, and also try exact matches
      const mailIdConditions = []
      
      // Try mailId field with contains
      mailIdConditions.push(...mailIds.map(mailId => `mailId contains "${mailId.trim()}"`))
      
      // Try threadId field (attachments might be linked via threadId)
      mailIdConditions.push(...mailIds.map(mailId => `threadId contains "${mailId.trim()}"`))
      
      // Try docId field (attachments might be linked via docId)
      const docIds = emailDebugInfo.map(email => email.docId).filter(Boolean)
      if (docIds.length > 0) {
        mailIdConditions.push(...docIds.map(docId => `mailId contains "${docId.trim()}"`))
        mailIdConditions.push(...docIds.map(docId => `threadId contains "${docId.trim()}"`))
      }
      
      yqlConditions.push(`(${mailIdConditions.join(" or ")})`)
      
      Logger.info(`[get_mail_attachment] Trying ${mailIdConditions.length} different ID matching approaches`)

      // Add permissions filter for the current user
      yqlConditions.push(`permissions contains "${email}"`)

      // Add optional attachment filter for filename or content search
      if (params.attachment_filter) {
        const filterQuery = params.attachment_filter.trim()
        yqlConditions.push(`(filename contains "${filterQuery}" or chunks contains "${filterQuery}")`)
      }

      // Add optional file type filter
      if (params.file_type) {
        const fileType = params.file_type.toLowerCase().trim()
        // Handle both with and without dot prefix
        const normalizedFileType = fileType.startsWith('.') ? fileType.substring(1) : fileType
        yqlConditions.push(`(fileType contains "${normalizedFileType}" or filename contains ".${normalizedFileType}")`)
      }

      // Construct the complete YQL query for attachments
      const whereClause = yqlConditions.join(" and ")
      const yql = `select * from sources mail_attachment where ${whereClause} order by timestamp desc limit ${searchLimit} offset ${searchOffset}`

      execSpan?.setAttribute("attachment_yql_query", yql)
      Logger.info(`[get_mail_attachment] YQL Query: ${yql}`)

      // Execute the attachment search using Vespa
      const attachmentSearchPayload = {
        yql,
        email,
        "ranking.profile": "unranked", // Use unranked since we're doing specific ID lookups
        hits: searchLimit,
        offset: searchOffset,
      }

      const VespaClient = (await import("@/search/vespaClient")).default
      const vespa = new VespaClient()
      const attachmentResults: VespaSearchResponse = await vespa.search(attachmentSearchPayload)

      const attachmentChildren = attachmentResults?.root?.children || []
      execSpan?.setAttribute("attachments_found", attachmentChildren.length)
      
      // Debug the attachment search results
      Logger.info(`[get_mail_attachment] Attachment search results: ${JSON.stringify({
        totalCount: attachmentResults?.root?.fields?.totalCount,
        childrenCount: attachmentChildren.length,
        errors: attachmentResults?.root?.errors,
        coverage: attachmentResults?.root?.coverage
      }, null, 2)}`)
      
      if (attachmentChildren.length > 0) {
        Logger.info(`[get_mail_attachment] First few attachment results: ${JSON.stringify(attachmentChildren.slice(0, 3), null, 2)}`)
      }

      // Since no separate attachment records exist, extract attachment info from email records
      Logger.info(`[get_mail_attachment] No separate attachment records found. Extracting attachment info from email records.`)
      
      // Step 4: Extract attachment information directly from email records
      const fragments: MinimalAgentFragment[] = []
      
      for (const emailItem of emailChildren) {
        if (emailItem.fields && "sddocname" in emailItem.fields && emailItem.fields.sddocname === mailSchema) {
          const mailFields = emailItem.fields as any
          
          // Check if this email has attachments
          if (mailFields.attachmentFilenames && mailFields.attachmentFilenames.length > 0) {
            const attachmentFilenames = mailFields.attachmentFilenames
            const attachments = mailFields.attachments || []
            
            // Create a fragment for each attachment
            for (let i = 0; i < attachmentFilenames.length; i++) {
              const filename = attachmentFilenames[i]
              const attachmentMeta = attachments[i] || {}
              
              // Apply filters if specified
              if (params.attachment_filter) {
                const filterQuery = params.attachment_filter.toLowerCase()
                if (!filename.toLowerCase().includes(filterQuery)) {
                  continue // Skip this attachment if it doesn't match the filter
                }
              }
              
              if (params.file_type) {
                const fileType = params.file_type.toLowerCase().trim()
                const normalizedFileType = fileType.startsWith('.') ? fileType.substring(1) : fileType
                const fileExtension = filename.split('.').pop()?.toLowerCase() || ''
                const attachmentFileType = attachmentMeta.fileType?.toLowerCase() || ''
                
                if (!fileExtension.includes(normalizedFileType) && !attachmentFileType.includes(normalizedFileType)) {
                  continue // Skip this attachment if it doesn't match the file type
                }
              }
              
              // Build attachment information
              let attachmentInfo = `📎 **${filename}**`
              
              if (attachmentMeta.fileType) {
                attachmentInfo += `\n**Type:** ${attachmentMeta.fileType}`
              }
              if (attachmentMeta.fileSize) {
                const sizeInKB = Math.round(attachmentMeta.fileSize / 1024)
                attachmentInfo += `\n**Size:** ${sizeInKB}KB`
              }
              
              attachmentInfo += `\n**From Email:** ${mailFields.subject || 'No subject'}`
              attachmentInfo += `\n**Sender:** ${mailFields.from || 'Unknown sender'}`
              
              if (mailFields.timestamp) {
                const date = new Date(mailFields.timestamp).toLocaleDateString()
                attachmentInfo += `\n**Date:** ${date}`
              }
              
              const citation = searchToCitation(emailItem as VespaSearchResults)
              
              fragments.push({
                id: `email-attachment-${citation.docId}-${i}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
                content: attachmentInfo,
                source: {
                  ...citation,
                  title: `📎 ${filename}`,
                  url: citation.url, // Keep the email URL as the source
                },
                confidence: emailItem.relevance || 0.8,
              })
            }
          }
        }
      }
      
      if (fragments.length === 0) {
        let noResultsMsg = `Found ${emailChildren.length} emails matching "${params.email_search_query}" but no attachments were found`
        if (params.attachment_filter) noResultsMsg += ` matching '${params.attachment_filter}'`
        if (params.file_type) noResultsMsg += ` with file type '${params.file_type}'`
        noResultsMsg += ` in those emails.`

        return {
          result: noResultsMsg,
          contexts: [],
        }
      }

      // Build response message
      let responseText = `Found ${fragments.length} attachment${fragments.length !== 1 ? 's' : ''}`
      
      if (params.attachment_filter) {
        responseText += ` matching '${params.attachment_filter}'`
      }
      if (params.file_type) {
        responseText += ` of type '${params.file_type}'`
      }
      
      responseText += ` from ${emailChildren.length} email${emailChildren.length !== 1 ? 's' : ''} matching "${params.email_search_query}"`

      if (timestampRange) {
        const fromDate = new Date(timestampRange.from).toLocaleDateString()
        const toDate = new Date(timestampRange.to).toLocaleDateString()
        responseText += ` (${fromDate} to ${toDate})`
      }

      // Add pagination info
      if (searchOffset > 0) {
        responseText += ` (items ${searchOffset + 1}-${searchOffset + fragments.length})`
      }

      // Show top results preview
      if (fragments.length > 0) {
        const topItemsList = fragments
          .slice(0, 3)
          .map((f, index) => {
            const filename = f.source.title?.replace('📎 ', '') || 'Unknown file'
            return `${index + 1}. ${filename}`
          })
          .join('\n')
        responseText += `\n\nAttachments found:\n${topItemsList}`
      }

      // Add pagination guidance if there might be more results
      if (fragments.length === searchLimit) {
        responseText += `\n\n💡 Showing ${searchLimit} results. Use offset parameter to see more.`
      }

      // Add summary of the search process
      responseText += `\n\n📧 Search Summary: Found ${emailChildren.length} emails → Extracted ${mailIds.length} mail IDs → Retrieved ${fragments.length} attachments`

      return {
        result: responseText,
        contexts: fragments,
      }

    } catch (error) {
      const errMsg = getErrorMessage(error)
      execSpan?.setAttribute("error", errMsg)
      Logger.error(error, `Mail attachment retrieval error: ${errMsg}`)

      return {
        result: `Error retrieving mail attachments: ${errMsg}`,
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
  filtered_search: filteredSearchTool,
  time_search: timeSearchTool,
  get_slack_threads: getSlackThreads,
  get_slack_related_messages: getSlackRelatedMessages,
  get_user_slack_profile: getUserSlackProfile,
  get_mail_attachment: getMailAttachment,
}
