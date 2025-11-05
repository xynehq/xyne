import { answerContextMap } from "@/ai/context"
import { getLogger } from "@/logger"
import { MessageRole, Subsystem, type UserMetadataType } from "@/types"
import { delay, getErrorMessage } from "@/utils"

import { getTracer, type Span, type Tracer } from "@/tracer"
import {
  searchVespa,
  searchGoogleApps,
  searchVespaInFiles,
  getItems,
  SearchVespaThreads,
  getThreadItems,
  searchVespaAgent,
  getSlackUserDetails,
} from "@/search/vespa"
import {
  Apps,
  GoogleApps,
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
  MailAttachmentEntity,
  mailAttachmentSchema,
  MailEntity,
  mailSchema,
  SearchModes,
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
} from "@xyne/vespa-ts/types"

import {
  getChannelIdsFromAgentPrompt,
  isAppSelectionMap,
  isValidApp,
  isValidEntity,
  parseAppSelections,
  searchToCitation,
  type AppFilter,
} from "./utils"
import config from "@/config"
import { is } from "drizzle-orm"
import {
  getToolParameters,
  internalTools,
  googleTools,
  convertToAgentToolParameters,
  searchGlobalTool,
} from "@/api/chat/mapper"
import type {
  AgentTool,
  MetadataRetrievalParams,
  MinimalAgentFragment,
  SearchParams,
} from "./types"
import { XyneTools } from "@/shared/types"
import { expandEmailThreadsInResults } from "./utils"
import { resolveNamesToEmails } from "./chat"
import type {
  EventStatusType,
  GetThreadItemsParams,
  MailParticipant,
  VespaQueryConfig,
} from "@xyne/vespa-ts"
import { getDateForAI } from "@/utils/index"
import { extractDriveIds } from "@/search/utils"

const { maxDefaultSummary, defaultFastModel } = config
const Logger = getLogger(Subsystem.Chat)

function convertParticipantsToLowercase(
  participants?: MailParticipant,
): MailParticipant | undefined {
  if (!participants || Object.keys(participants).length < 1) return participants

  const converted: MailParticipant = {}

  if (participants.from) {
    converted.from = participants.from.map((email) => email.toLowerCase())
  }

  if (participants.to) {
    converted.to = participants.to.map((email) => email.toLowerCase())
  }

  if (participants.cc) {
    converted.cc = participants.cc.map((email) => email.toLowerCase())
  }

  if (participants.bcc) {
    converted.bcc = participants.bcc.map((email) => email.toLowerCase())
  }

  return converted
}

async function formatSearchToolResponse(
  searchResults: VespaSearchResponse | null,
  searchContext: {
    query?: string
    app?: string
    labels?: string[]
    timeRange?: { startTime: number; endTime: number }
    offset?: number
    limit?: number
    searchType?: string
  },
): Promise<{ result: string; contexts: MinimalAgentFragment[] }> {
  const children = (searchResults?.root?.children || []).filter(
    (item): item is VespaSearchResults =>
      !!(item.fields && "sddocname" in item.fields),
  )

  if (children.length === 0) {
    return {
      result: `No ${searchContext.searchType || "results"} found.`,
      contexts: [],
    }
  }

  const fragments: MinimalAgentFragment[] = await Promise.all(
    children.map(async (r) => {
      const citation = searchToCitation(r)
      return {
        id: citation.docId,
        content: await answerContextMap(
          r,
          userMetadata,
          // Limit to 50 chunks for file documents to prevent exceeding context size with large files
          r.fields.sddocname === fileSchema ? 50 : undefined,
        ),
        source: citation,
        confidence: r.relevance || 0.7,
      }
    }),
  )

  let summaryText = `Found ${fragments.length} ${searchContext.searchType || "result"}${fragments.length !== 1 ? "s" : ""}`

  if (searchContext.query) {
    summaryText += ` matching '${searchContext.query}'`
  }

  if (searchContext.app) {
    summaryText += ` in ${searchContext.app}`
  }

  if (searchContext.labels && searchContext.labels.length > 0) {
    summaryText += ` with labels: ${searchContext.labels.join(", ")}`
  }

  if (searchContext.timeRange) {
    summaryText += ` from ${new Date(searchContext.timeRange.startTime).toLocaleDateString()} to ${new Date(searchContext.timeRange.endTime).toLocaleDateString()}`
  }

  if (searchContext.offset && searchContext.offset > 0) {
    summaryText += ` (showing items ${searchContext.offset + 1} to ${searchContext.offset + fragments.length})`
  }

  const topItemsList = fragments
    .slice(0, 3)
    .map((f) => `- "${f.source.title || "Untitled"}"`)
    .join("\n")
  summaryText += `.\nTop results:\n${topItemsList}`

  return { result: summaryText, contexts: fragments }
}

export function parseAgentAppIntegrations(agentPrompt?: string): {
  agentAppEnums: Apps[]
  agentSpecificCollectionIds: string[]
  agentSpecificCollectionFolderIds: string[]
  agentSpecificCollectionFileIds: string[]
  selectedItems: {}
  appFilter: Partial<Record<Apps, AppFilter[]>> | undefined
} {
  Logger.debug({ agentPrompt }, "Parsing agent prompt for app integrations")
  let agentAppEnums: Apps[] = []
  let agentSpecificCollectionIds: string[] = []
  let agentSpecificCollectionFolderIds: string[] = []
  let agentSpecificCollectionFileIds: string[] = []
  let appFilter: Partial<Record<Apps, AppFilter[]>> | undefined = {}
  let selectedItem: any = {}

  if (!agentPrompt) {
    return {
      agentAppEnums,
      agentSpecificCollectionIds,
      agentSpecificCollectionFolderIds,
      agentSpecificCollectionFileIds,
      selectedItems: selectedItem,
      appFilter,
    }
  }

  let agentPromptData: { appIntegrations?: string[] } = {}

  try {
    agentPromptData = JSON.parse(agentPrompt)
    if (isAppSelectionMap(agentPromptData.appIntegrations)) {
      const { selectedApps, selectedItems, appFilters } = parseAppSelections(
        agentPromptData.appIntegrations,
      )
      // agentAppEnums = selectedApps.filter(isValidApp);
      selectedItem = selectedItems
      agentAppEnums = [...new Set(selectedApps)]
      appFilter = appFilters
      // Handle selectedItems logic...
    }

    if (selectedItem[Apps.KnowledgeBase]) {
      const source = selectedItem[Apps.KnowledgeBase]
      for (const itemId of source) {
        if (itemId.startsWith("cl-")) {
          // Entire collection - remove cl- prefix
          agentSpecificCollectionIds.push(itemId.replace(/^cl[-_]/, ""))
        } else if (itemId.startsWith("clfd-")) {
          // Collection folder - remove clfd- prefix
          agentSpecificCollectionFolderIds.push(itemId.replace(/^clfd[-_]/, ""))
        } else if (itemId.startsWith("clf-")) {
          // Collection file - remove clf- prefix
          agentSpecificCollectionFileIds.push(itemId.replace(/^clf[-_]/, ""))
        }
      }
    } else {
      Logger.info("No selected items found ")
    }
    Logger.debug({ agentPromptData }, "Parsed agent prompt data")
  } catch (error) {
    Logger.warn("Failed to parse agentPrompt JSON", {
      error,
      agentPrompt,
    })
    return {
      agentAppEnums,
      agentSpecificCollectionIds,
      agentSpecificCollectionFolderIds,
      agentSpecificCollectionFileIds,
      selectedItems: selectedItem,
      appFilter,
    }
  }

  // Remove duplicates
  agentAppEnums = [...new Set(agentAppEnums)]

  return {
    agentAppEnums,
    agentSpecificCollectionIds,
    agentSpecificCollectionFolderIds,
    agentSpecificCollectionFileIds,
    selectedItems: selectedItem,
    appFilter,
  }
}

interface UnifiedSearchOptions {
  email: string
  query?: string | null
  app?: Apps | Apps[] | null
  entity?: Entity | Entity[] | null
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
  mailParticipant?: MailParticipant | null
  orderBy?: "asc" | "desc"
  owner?: string | null
  eventStatus?: EventStatusType | null
  eventAttendees?: string[] | null
  channelIds?: string[]
  selectedItems?: {}
  collectionIds?: string[]
  collectionFolderIds?: string[]
  collectionFileIds?: string[]
  appFilters?: any
}

const userMetadata: UserMetadataType = {
  userTimezone: "Asia/Kolkata",
  dateForAI: getDateForAI({ userTimeZone: "Asia/Kolkata" }),
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
    mailParticipant,
    channelIds,
    collectionIds,
    collectionFolderIds,
    collectionFileIds,
    selectedItems,
    orderBy,
    owner,
    eventStatus,
    eventAttendees,
  } = options

  const execSpan = span?.startSpan("execute_vespa_search_helper")
  execSpan?.setAttribute("email", email)
  if (query) execSpan?.setAttribute("query", query)
  if (app)
    execSpan?.setAttribute("app", Array.isArray(app) ? app.join(",") : app)
  if (entity)
    execSpan?.setAttribute(
      "entity",
      Array.isArray(entity) ? entity.join(",") : entity,
    )
  if (limit) execSpan?.setAttribute("limit", limit)
  if (offset) execSpan?.setAttribute("offset", offset)
  if (orderDirection) execSpan?.setAttribute("orderDirection", orderDirection)
  execSpan?.setAttribute("hasTimestampRange", !!timestampRange)
  execSpan?.setAttribute("hasExcludedIds", (excludedIds?.length || 0) > 0)
  execSpan?.setAttribute("hasAgentAppEnums", (agentAppEnums?.length || 0) > 0)
  execSpan?.setAttribute("hasCollectionIds", (collectionIds?.length || 0) > 0)
  execSpan?.setAttribute(
    "hasCollectionFolderIds",
    (collectionFolderIds?.length || 0) > 0,
  )
  execSpan?.setAttribute(
    "hasCollectionFileIds",
    (collectionFileIds?.length || 0) > 0,
  )

  if (!email) {
    const errorMsg = "Email is required for search execution."
    execSpan?.setAttribute("error", errorMsg)
    return { result: errorMsg, error: "Missing email", contexts: [] }
  }

  let searchResults: VespaSearchResponse | null = null
  const commonSearchOptions: Partial<VespaQueryConfig> = {
    limit,
    alpha: 0.5,
    excludedIds,
    span: execSpan?.startSpan("vespa_search_call"),
    offset,
    rankProfile: SearchModes.NativeRank,
    mailParticipants: mailParticipant || null,
    orderBy,
    owner,
    eventStatus,
    attendees: eventAttendees || null,
  }

  const fromTimestamp = timestampRange?.from
    ? new Date(timestampRange.from).getTime()
    : undefined
  const toTimestamp = timestampRange?.to
    ? new Date(timestampRange.to).getTime()
    : undefined

  if (query && query.trim() !== "") {
    if (agentAppEnums && agentAppEnums.length > 0) {
      // Handle both single app and array of apps
      const appsToCheck = Array.isArray(app) ? app : app ? [app] : []
      const invalidApps = appsToCheck.filter((a) => !agentAppEnums.includes(a))
      if (invalidApps.length > 0) {
        const errorMsg = `${invalidApps.join(", ")} ${invalidApps.length > 1 ? "are" : "is"} not allowed app${invalidApps.length > 1 ? "s" : ""} for this agent. Cannot search.`
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
          channelIds,
          collectionSelections:
            collectionIds?.length ||
            collectionFolderIds?.length ||
            collectionFileIds?.length
              ? [
                  {
                    collectionIds: collectionIds?.length
                      ? collectionIds
                      : undefined,
                    collectionFolderIds: collectionFolderIds?.length
                      ? collectionFolderIds
                      : undefined,
                    collectionFileIds: collectionFileIds?.length
                      ? collectionFileIds
                      : undefined,
                  },
                ]
              : undefined,
          selectedItem: selectedItems,
          appFilters: options.appFilters,
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
      // Handle both single app and array of apps
      const appsToCheck = Array.isArray(app) ? app : app ? [app] : []
      const invalidApps = appsToCheck.filter((a) => !agentAppEnums.includes(a))
      if (invalidApps.length > 0) {
        const errorMsg = `${invalidApps.join(", ")} ${invalidApps.length > 1 ? "are" : "is"} not allowed app${invalidApps.length > 1 ? "s" : ""} for this agent. Cannot retrieve items.`
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
      mailParticipants: options.mailParticipant || null,
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

  const fragments: MinimalAgentFragment[] = await Promise.all(
    children.map(async (r) => {
      if (r.fields.sddocname === dataSourceFileSchema) {
        const fields = r.fields as VespaDataSourceFile
        return {
          id: `${fields.docId}`,
          content: await answerContextMap(r, userMetadata, maxDefaultSummary),
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
        id: citation.docId,
        content: await answerContextMap(
          r,
          userMetadata,
          // Limit to 50 chunks for file documents to prevent exceeding context size with large files
          r.fields.sddocname === fileSchema ? 50 : undefined,
        ),
        source: citation,
        confidence: r.relevance || 0.7,
      }
    }),
  )

  let summaryText = `Found ${fragments.length} results`
  if (query) summaryText += ` matching '${query}'`
  if (app) {
    const appText = Array.isArray(app) ? app.join(", ") : app
    summaryText += ` in \`${appText}\``
  }
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
export const searchGlobal: AgentTool = {
  name: XyneTools.Search,
  description: searchGlobalTool.description,
  parameters: convertToAgentToolParameters(searchGlobalTool),
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

      const queryToUse = params.query || userMessage || ""
      if (!queryToUse.trim()) {
        return {
          result: "No query provided for general search.",
          error: "Missing query",
        }
      }

      const {
        agentAppEnums,
        agentSpecificCollectionIds,
        agentSpecificCollectionFolderIds,
        agentSpecificCollectionFileIds,
        selectedItems,
        appFilter,
      } = parseAgentAppIntegrations(agentPrompt)
      const channelIds = agentPrompt
        ? await getChannelIdsFromAgentPrompt(agentPrompt)
        : []
      return await executeVespaSearch({
        email,
        query: queryToUse,
        limit: params.limit,
        excludedIds: params.excludedIds,
        agentAppEnums,
        span: execSpan,
        channelIds,
        collectionIds: agentSpecificCollectionIds,
        collectionFolderIds: agentSpecificCollectionFolderIds,
        collectionFileIds: agentSpecificCollectionFileIds,
        selectedItems: selectedItems,
        appFilters:appFilter
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
      const { agentAppEnums, selectedItems } =
        parseAgentAppIntegrations(agentPrompt)
      execSpan?.setAttribute("agent_app_enums", JSON.stringify(agentAppEnums))
      const channelIds =
        ((selectedItems as Record<string, unknown>)[Apps.Slack] as any) || []
      if (
        !agentAppEnums.includes(Apps.Slack) &&
        channelIds &&
        channelIds.length === 0
      ) {
        return {
          result:
            "Slack is not an allowed app for this agent neither the agent is not configured for any Slack channel, please select a channel to search in. .. Cannot retrieve messages from user.",
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
        const fragments: MinimalAgentFragment[] = await Promise.all(
          items.map(
            async (item: VespaSearchResults): Promise<MinimalAgentFragment> => {
              const citation = searchToCitation(item)
              Logger.debug(
                { item },
                "Processing item in metadata_retrieval tool",
              )

              const content = item.fields
                ? await answerContextMap(item, userMetadata, maxDefaultSummary)
                : `Context unavailable for ${citation.title || citation.docId}`

              return {
                id: `${citation.docId}`,
                content: content,
                source: citation,
                confidence: item.relevance || 0.7, // Use item.relevance if available
              }
            },
          ),
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
    "Unified tool to retrieve Slack messages with flexible filtering options. Can search by channel, user, time range, thread, or any combination. Automatically includes thread messages when found. Use this single tool for all Slack message retrieval needs.",
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
      const { agentAppEnums, selectedItems } =
        parseAgentAppIntegrations(agentPrompt)
      execSpan?.setAttribute("agent_app_enums", JSON.stringify(agentAppEnums))
      const channelIds =
        ((selectedItems as Record<string, unknown>)[Apps.Slack] as any) || []
      if (
        !agentAppEnums.includes(Apps.Slack) &&
        channelIds &&
        channelIds.length === 0
      ) {
        return {
          result:
            "Slack is not an allowed app for this agent neither the agent is not configured for any Slack channel, please select a channel to search in. .. Cannot retrieve related Slack messages.",
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

      // Check for thread messages and fetch them automatically
      const threadIdsToFetch: string[] = []
      for (const item of items) {
        if (item.fields && item.fields.sddocname === chatMessageSchema) {
          const messageFields = item.fields as VespaChatMessage
          if (messageFields.app === Apps.Slack) {
            const createdAtNum = messageFields.createdAt
            const threadIdStr = messageFields.threadId
            // If this message is a thread root (createdAt equals threadId)
            if (String(createdAtNum) === threadIdStr) {
              threadIdsToFetch.push(threadIdStr)
            }
          }
        }
      }

      let allItems = items
      let threadMessagesCount = 0

      // Fetch thread messages if any thread roots were found
      if (threadIdsToFetch.length > 0) {
        Logger.debug(
          `[get_slack_messages] Fetching threads for ${threadIdsToFetch.length} thread roots`,
        )
        try {
          const threadResponse = await SearchVespaThreads(
            threadIdsToFetch,
            execSpan!,
          )
          const threadItems = (threadResponse?.root?.children || []).filter(
            (item): item is VespaSearchResults =>
              !!(item.fields && "sddocname" in item.fields),
          )

          if (threadItems.length > 0) {
            // Combine original messages with thread messages
            allItems = [...items, ...threadItems]
            threadMessagesCount = threadItems.length
            Logger.debug(
              `[get_slack_messages] Added ${threadMessagesCount} thread messages`,
            )
          }
        } catch (error) {
          Logger.warn(
            `[get_slack_messages] Failed to fetch thread messages: ${getErrorMessage(error)}`,
          )
          // Continue with original messages even if thread fetching fails
        }
      }

      // Process results into fragments
      const fragments: MinimalAgentFragment[] = await Promise.all(
        allItems.map(
          async (item: VespaSearchResults): Promise<MinimalAgentFragment> => {
            const citation = searchToCitation(item)
            Logger.debug({ item }, "Processing Slack message item")

            const content = item.fields
              ? await answerContextMap(item, userMetadata, maxDefaultSummary)
              : `Content unavailable for ${citation.title || citation.docId}`

            return {
              id: `${citation.docId}`,
              content: content,
              source: citation,
              confidence: item.relevance || 0.7,
            }
          },
        ),
      )

      // Build response message
      let responseText = `Found ${fragments.length} Slack message${fragments.length !== 1 ? "s" : ""}`

      if (threadMessagesCount > 0) {
        responseText += ` (including ${threadMessagesCount} thread message${threadMessagesCount !== 1 ? "s" : ""})`
      }

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
      if (items.length === searchOptions.limit) {
        responseText += `\n\n💡 Showing ${searchOptions.limit} main results. Use offset parameter to see more.`
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
      const { agentAppEnums, selectedItems } =
        parseAgentAppIntegrations(agentPrompt)
      execSpan?.setAttribute("agent_app_enums", JSON.stringify(agentAppEnums))
      const channelIds =
        ((selectedItems as Record<string, unknown>)[Apps.Slack] as any) || []
      if (
        !agentAppEnums.includes(Apps.Slack) &&
        channelIds &&
        channelIds.length === 0
      ) {
        return {
          result:
            "Slack is not an allowed app for this agent neither the agent is not configured for any Slack channel, please select a channel to search in. .. Cannot retrieve Slack user profile.",
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
      const { agentAppEnums, selectedItems } =
        parseAgentAppIntegrations(agentPrompt)
      execSpan?.setAttribute("agent_app_enums", JSON.stringify(agentAppEnums))
      const channelIds =
        ((selectedItems as Record<string, unknown>)[Apps.Slack] as any) || []
      if (
        !agentAppEnums.includes(Apps.Slack) &&
        channelIds &&
        channelIds.length === 0
      ) {
        return {
          result:
            "Slack is not an allowed app for this agent neither the agent is not configured for any Slack channel, please select a channel to search in. .. Cannot retrieve messages from channel.",
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
      const fragments: MinimalAgentFragment[] = await Promise.all(
        items.map(
          async (item: VespaSearchResults): Promise<MinimalAgentFragment> => {
            const citation = searchToCitation(item)
            Logger.debug({ item }, "Processing item in metadata_retrieval tool")

            const content = item.fields
              ? await answerContextMap(item, userMetadata, maxDefaultSummary)
              : `Context unavailable for ${citation.title || citation.docId}`

            return {
              id: `${citation.docId}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
              content: content,
              source: citation,
              confidence: item.relevance || 0.7, // Use item.relevance if available
            }
          },
        ),
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
      const { agentAppEnums, selectedItems } =
        parseAgentAppIntegrations(agentPrompt)
      execSpan?.setAttribute("agent_app_enums", JSON.stringify(agentAppEnums))
      const channelIds =
        ((selectedItems as Record<string, unknown>)[Apps.Slack] as any) || []
      if (
        !agentAppEnums.includes(Apps.Slack) &&
        channelIds &&
        channelIds.length === 0
      ) {
        return {
          result:
            "Slack is not an allowed app for this agent neither the agent is not configured for any Slack channel, please select a channel to search in. .. Cannot retrieve messages from time range.",
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
      const fragments: MinimalAgentFragment[] = await Promise.all(
        items.map(
          async (item: VespaSearchResults): Promise<MinimalAgentFragment> => {
            const citation = searchToCitation(item)
            Logger.debug({ item }, "Processing item in metadata_retrieval tool")

            const content = item.fields
              ? await answerContextMap(item, userMetadata, maxDefaultSummary)
              : `Context unavailable for ${citation.title || citation.docId}`

            return {
              id: `${citation.docId}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
              content: content,
              source: citation,
              confidence: item.relevance || 0.7, // Use item.relevance if available
            }
          },
        ),
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

// Google Tools Implementation
export const searchGmail: AgentTool = {
  name: "searchGmail",
  description: googleTools[GoogleApps.Gmail].description,
  parameters: convertToAgentToolParameters(googleTools[GoogleApps.Gmail]),
  execute: async (
    params: {
      query?: string
      limit?: number
      offset?: number
      sortBy?: "asc" | "desc"
      labels?: string[]
      timeRange?: { startTime: string; endTime: string }
      participants?: MailParticipant
      excludedIds?: string[]
    },
    span?: Span,
    email?: string,
    userCtx?: string,
    agentPrompt?: string,
  ) => {
    const execSpan = span?.startSpan("execute_search_gmail_tool")
    try {
      const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)

      // Check if Gmail is allowed for this agent
      if (agentAppEnums && agentAppEnums.length > 0) {
        if (!agentAppEnums.includes(Apps.Gmail)) {
          const errorMsg = "Gmail is not allowed for this agent. Cannot search."
          execSpan?.setAttribute("error", errorMsg)
          return { result: errorMsg, contexts: [] }
        }
      }

      if (!email) {
        const errorMsg = "Email is required for Gmail search."
        execSpan?.setAttribute("error", errorMsg)
        return { result: errorMsg, error: "Missing email" }
      }

      let timeRange: { startTime: number; endTime: number } | undefined
      if (params.timeRange) {
        timeRange = {
          startTime: params.timeRange.startTime
            ? new Date(params.timeRange.startTime).getTime()
            : 0,
          endTime: params.timeRange.endTime
            ? new Date(params.timeRange.endTime).getTime()
            : Date.now(),
        }
      }
      const offset = params.offset || 0
      const searchResults = await searchGoogleApps({
        app: GoogleApps.Gmail,
        email: email,
        query: params.query,
        limit: (params.limit || config.VespaPageSize) + offset,
        offset,
        sortBy: params.sortBy || "desc",
        labels: params.labels,
        timeRange: timeRange,
        participants: convertParticipantsToLowercase(params.participants),
        excludeDocIds: params.excludedIds || [],
        docIds: undefined,
      })

      if (
        searchResults?.root?.children &&
        searchResults.root.children.length > 0
      ) {
        searchResults.root.children = await expandEmailThreadsInResults(
          searchResults.root.children,
          email,
          execSpan,
        )
      }

      return await formatSearchToolResponse(searchResults, {
        query: params.query,
        app: GoogleApps.Gmail,
        labels: params.labels,
        timeRange: timeRange,
        offset: params.offset,
        limit: params.limit,
        searchType: "Gmail message",
      })
    } catch (error) {
      const errMsg = getErrorMessage(error)
      execSpan?.setAttribute("error", errMsg)
      return { result: `Gmail search error: ${errMsg}`, error: errMsg }
    } finally {
      execSpan?.end()
    }
  },
}

export const searchDriveFiles: AgentTool = {
  name: "searchDriveFiles",
  description: googleTools[GoogleApps.Drive].description,
  parameters: convertToAgentToolParameters(googleTools[GoogleApps.Drive]),
  execute: async (
    params: {
      query: string
      owner?: string
      limit?: number
      offset?: number
      sortBy?: "asc" | "desc"
      filetype?: Entity[]
      timeRange?: { startTime: string; endTime: string }
      excludedIds?: string[]
    },
    span?: Span,
    email?: string,
    userCtx?: string,
    agentPrompt?: string,
  ) => {
    const execSpan = span?.startSpan("execute_search_drive_files_tool")
    try {
      if (!email) {
        const errorMsg = "Email is required for Drive files search."
        execSpan?.setAttribute("error", errorMsg)
        return { result: errorMsg, error: "Missing email" }
      }
      const { agentAppEnums, selectedItems } =
        parseAgentAppIntegrations(agentPrompt)

      // Check if Google Drive is allowed for this agent
      if (agentAppEnums && agentAppEnums.length > 0) {
        if (!agentAppEnums.includes(Apps.GoogleDrive)) {
          const errorMsg =
            "Google Drive is not allowed for this agent. Cannot search."
          execSpan?.setAttribute("error", errorMsg)
          return { result: errorMsg, contexts: [] }
        }
      }
      let driveSourceIds: string[] = []
      if (selectedItems) {
        driveSourceIds = await extractDriveIds(
          { selectedItem: selectedItems },
          email!,
        )
      }

      let timeRange: { startTime: number; endTime: number } | undefined
      if (params.timeRange) {
        timeRange = {
          startTime: params.timeRange.startTime
            ? new Date(params.timeRange.startTime).getTime()
            : 0,
          endTime: params.timeRange.endTime
            ? new Date(params.timeRange.endTime).getTime()
            : Date.now(),
        }
      }
      const offset = params.offset || 0
      // Call searchGoogleApps with correct parameter structure
      const searchResults = await searchGoogleApps({
        app: GoogleApps.Drive,
        email: email,
        query: params.query,
        limit: (params.limit || config.VespaPageSize) + offset,
        offset,
        sortBy: params.sortBy || "desc",
        timeRange: timeRange,
        owner: params.owner,
        driveEntity: params.filetype as DriveEntity | DriveEntity[],
        excludeDocIds: params.excludedIds || [],
        docIds: driveSourceIds,
      })

      return await formatSearchToolResponse(searchResults, {
        query: params.query,
        app: GoogleApps.Drive,
        timeRange: timeRange,
        offset: params.offset,
        limit: params.limit,
        searchType: "Drive file",
      })
    } catch (error) {
      const errMsg = getErrorMessage(error)
      execSpan?.setAttribute("error", errMsg)
      return { result: `Drive files search error: ${errMsg}`, error: errMsg }
    } finally {
      execSpan?.end()
    }
  },
}

export const searchCalendarEvents: AgentTool = {
  name: "searchCalendarEvents",
  description: googleTools[GoogleApps.Calendar].description,
  parameters: convertToAgentToolParameters(googleTools[GoogleApps.Calendar]),
  execute: async (
    params: {
      query: string
      attendees?: string[]
      status?: EventStatusType
      limit?: number
      offset?: number
      sortBy?: "asc" | "desc"
      timeRange?: { startTime: string; endTime: string }
      excludedIds?: string[]
    },
    span?: Span,
    email?: string,
    userCtx?: string,
    agentPrompt?: string,
  ) => {
    const execSpan = span?.startSpan("execute_search_calendar_events_tool")
    try {
      if (!email) {
        const errorMsg = "Email is required for calendar events search."
        execSpan?.setAttribute("error", errorMsg)
        return { result: errorMsg, error: "Missing email" }
      }

      const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)

      // Check if Google Calendar is allowed for this agent
      if (agentAppEnums && agentAppEnums.length > 0) {
        if (!agentAppEnums.includes(Apps.GoogleCalendar)) {
          const errorMsg =
            "Google Calendar is not allowed for this agent. Cannot search."
          execSpan?.setAttribute("error", errorMsg)
          return { result: errorMsg, contexts: [] }
        }
      }

      let timeRange: { startTime: number; endTime: number } | undefined
      if (params.timeRange) {
        timeRange = {
          startTime: params.timeRange.startTime
            ? new Date(params.timeRange.startTime).getTime()
            : 0,
          endTime: params.timeRange.endTime
            ? new Date(params.timeRange.endTime).getTime()
            : Date.now(),
        }
      }
      const offset = params.offset || 0
      const searchResults = await searchGoogleApps({
        app: GoogleApps.Calendar,
        email: email,
        query: params.query,
        limit: (params.limit || config.VespaPageSize) + offset,
        offset,
        sortBy: params.sortBy || "desc",
        timeRange: timeRange,
        attendees: params.attendees,
        eventStatus: params.status, // Take first status if provided
        excludeDocIds: params.excludedIds || [],
        docIds: undefined,
      })

      return await formatSearchToolResponse(searchResults, {
        query: params.query,
        app: GoogleApps.Calendar,
        timeRange: timeRange,
        offset: params.offset,
        limit: params.limit,
        searchType: "Calendar event",
      })
    } catch (error) {
      const errMsg = getErrorMessage(error)
      execSpan?.setAttribute("error", errMsg)
      return {
        result: `Calendar events search error: ${errMsg}`,
        error: errMsg,
      }
    } finally {
      execSpan?.end()
    }
  },
}

export const searchGoogleContacts: AgentTool = {
  name: "searchGoogleContacts",
  description: googleTools[GoogleApps.Contacts].description,
  parameters: convertToAgentToolParameters(googleTools[GoogleApps.Contacts]),
  execute: async (
    params: {
      query: string
      limit?: number
      offset?: number
      excludedIds?: string[]
    },
    span?: Span,
    email?: string,
    userCtx?: string,
    agentPrompt?: string,
  ) => {
    const execSpan = span?.startSpan("execute_search_google_contacts_tool")
    try {
      if (!email) {
        const errorMsg = "Email is required for Google contacts search."
        execSpan?.setAttribute("error", errorMsg)
        return { result: errorMsg, error: "Missing email" }
      }

      const offset = params.offset || 0
      const searchResults = await searchGoogleApps({
        app: GoogleApps.Contacts,
        email: email,
        query: params.query,
        limit: (params.limit || config.VespaPageSize) + offset,
        sortBy: "desc",
        excludeDocIds: params.excludedIds || [],
        offset,
      })

      return await formatSearchToolResponse(searchResults, {
        query: params.query,
        app: GoogleApps.Contacts,
        offset: params.offset,
        limit: params.limit,
        searchType: "Contact",
      })
    } catch (error) {
      const errMsg = getErrorMessage(error)
      execSpan?.setAttribute("error", errMsg)
      return {
        result: `Google contacts search error: ${errMsg}`,
        error: errMsg,
      }
    } finally {
      execSpan?.end()
    }
  },
}

export const agentTools: Record<string, AgentTool> = {
  // get_user_info: userInfoTool,
  // metadata_retrieval: metadataRetrievalTool,
  searchGlobal: searchGlobal,
  // // Slack-specific tools
  getSlackMessages: getSlackRelatedMessages,
  getSlackUserProfile: getUserSlackProfile,
  // Google-specific tools
  searchGmail: searchGmail,
  // searchGmailAttachment: searchGmailAttachment,
  searchDriveFiles: searchDriveFiles,
  searchCalendarEvents: searchCalendarEvents,
  searchGoogleContacts: searchGoogleContacts,

  // Fallback tool
  fall_back: fallbackTool,
}
