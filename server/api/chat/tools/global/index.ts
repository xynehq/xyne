import { z, type ZodType } from "zod"
import type { Tool } from "@xynehq/jaf"
import { ToolErrorCodes, ToolResponse } from "@xynehq/jaf"
import {
  Apps,
  DataSourceEntity,
  dataSourceFileSchema,
  fileSchema,
  SearchModes,
  type Entity,
  type EventStatusType,
  type MailParticipant,
  type VespaDataSourceFile,
  type VespaQueryConfig,
  type VespaSchema,
  type VespaSearchResponse,
  type VespaSearchResults,
} from "@xyne/vespa-ts"
import { getErrorMessage } from "@/utils"
import { searchVespaAgent, searchVespa, getItems } from "@/search/vespa"
import {
  formatSearchToolResponse,
  parseAgentAppIntegrations,
  userMetadata,
} from "../utils"
import {
  expandEmailThreadsInResults,
  getChannelIdsFromAgentPrompt,
  searchToCitation,
} from "@/api/chat/utils"
import type { Ctx, WithExcludedIds } from "../types"
import { baseToolParams, createQuerySchema } from "../schemas"
import { generateFallback } from "@/ai/provider"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { MinimalAgentFragment } from "../../types"
import { answerContextMap } from "@/ai/context"
import config from "@/config"

const searchGlobalToolSchema = z.object({
  query: createQuerySchema(undefined, true),
  ...baseToolParams,
})

const fallbackToolSchema = z.object({
  originalQuery: z
    .string()
    .describe("The original user query")
    .min(1, "Original query is required"),
  agentScratchpad: z
    .string()
    .describe("The agent reasoning history")
    .min(1, "Agent scratchpad is required"),
  toolLog: z
    .string()
    .describe("The tool execution log")
    .min(1, "Tool log is required"),
  gatheredFragments: z
    .string()
    .describe("The gathered context fragments")
    .min(1, "Gathered fragments is required"),
})

export type SearchGlobalToolParams = z.infer<typeof searchGlobalToolSchema>
export type FallbackToolParams = z.infer<typeof fallbackToolSchema>

type ToolSchemaParameters<T> = Tool<T, Ctx>["schema"]["parameters"]
const toToolSchemaParameters = <T>(
  schema: ZodType<T>,
): ToolSchemaParameters<T> => schema as unknown as ToolSchemaParameters<T>

export const searchGlobalTool: Tool<SearchGlobalToolParams, Ctx> = {
  schema: {
    name: "searchGlobal",
    description:
      "Search across all connected applications and data sources to find relevant information. This is the primary search tool that can look through emails, documents, messages, and other content.",
    parameters: toToolSchemaParameters(searchGlobalToolSchema),
  },
  async execute(params: WithExcludedIds<SearchGlobalToolParams>, context: Ctx) {
    const { email, agentPrompt, userMessage } = context

    try {
      if (!email) {
        const errorMsg = "Email is required for global search."
        return ToolResponse.error(
          ToolErrorCodes.MISSING_REQUIRED_FIELD,
          errorMsg,
          {
            toolName: "searchGlobal",
          },
        )
      }

      const queryToUse = params.query || ""

      const {
        agentAppEnums,
        agentSpecificCollectionIds,
        agentSpecificCollectionFolderIds,
        agentSpecificCollectionFileIds,
        selectedItems,
      } = parseAgentAppIntegrations(agentPrompt)

      const channelIds = agentPrompt
        ? await getChannelIdsFromAgentPrompt(agentPrompt)
        : []

      const offset = params.offset || 0
      const limit = params.limit
        ? Math.min(params.limit, config.maxUserRequestCount) + (offset ?? 0)
        : undefined

      const response = await executeVespaSearch({
        email,
        query: queryToUse,
        limit,
        offset: params.offset || 0,
        excludedIds: params.excludedIds,
        agentAppEnums,
        channelIds,
        collectionIds: agentSpecificCollectionIds,
        collectionFolderIds: agentSpecificCollectionFolderIds,
        collectionFileIds: agentSpecificCollectionFileIds,
        selectedItems: selectedItems,
      })

      return ToolResponse.success(response.result, {
        toolName: "searchGlobal",
        contexts: response.contexts,
      })
    } catch (error) {
      const errMsg = getErrorMessage(error)
      return ToolResponse.error(
        ToolErrorCodes.EXECUTION_FAILED,
        `Search error: ${errMsg}`,
        { toolName: "searchGlobal" },
      )
    }
  },
}

export const fallbackTool: Tool<FallbackToolParams, Ctx> = {
  schema: {
    name: "fall_back",
    description:
      "Generate detailed reasoning about why the search failed when initial iterations are exhausted but synthesis is still not complete.",
    parameters: toToolSchemaParameters(fallbackToolSchema),
  },
  async execute(params: FallbackToolParams, context: Ctx) {
    const Logger = getLogger(Subsystem.Chat)
    const { userCtx } = context
    try {
      // Generate detailed reasoning about why the search failed
      const fallbackResponse = await generateFallback(
        userCtx || "",
        params.originalQuery,
        params.agentScratchpad,
        params.toolLog,
        params.gatheredFragments,
        {
          modelId: config.defaultFastModel,
          stream: false,
          json: true,
        },
      )

      if (
        !fallbackResponse.reasoning ||
        fallbackResponse.reasoning.trim() === ""
      ) {
        return ToolResponse.error(
          ToolErrorCodes.EXECUTION_FAILED,
          "No reasoning could be generated for the search failure.",
          { toolName: "fall_back" },
        )
      }

      // Return only the reasoning, not alternative queries
      Logger.info(
        `Fallback tool generated detailed reasoning about search failure`,
      )

      return ToolResponse.success(
        `Fallback analysis completed. Generated detailed reasoning about why the search was unsuccessful.`,
        {
          toolName: "fall_back",
          fallbackReasoning: fallbackResponse.reasoning, // Pass only the reasoning
        },
      )
    } catch (error) {
      const errMsg = getErrorMessage(error)
      Logger.error(error, `Fallback tool error: ${errMsg}`)
      return ToolResponse.error(
        ToolErrorCodes.EXECUTION_FAILED,
        `Fallback analysis failed: ${errMsg}`,
        { toolName: "fall_back" },
      )
    }
  },
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
}

async function executeVespaSearch(options: UnifiedSearchOptions): Promise<{
  result: string
  contexts: MinimalAgentFragment[]
  summary?: string
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

  let searchResults: VespaSearchResponse | null = null
  const commonSearchOptions: Partial<VespaQueryConfig> = {
    limit,
    alpha: 0.5,
    excludedIds,
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
      const appsToCheck = Array.isArray(app) ? app : app ? [app] : []
      const invalidApps = appsToCheck.filter((a) => !agentAppEnums.includes(a))
      if (invalidApps.length > 0) {
        const errorMsg = `${invalidApps.join(", ")} ${invalidApps.length > 1 ? "are" : "is"} not allowed app${invalidApps.length > 1 ? "s" : ""} for this agent. Cannot search.`
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
  } else {
    const errorMsg = "No query or schema provided for search."
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
    )
  }

  const children = (searchResults?.root?.children || []).filter(
    (item): item is VespaSearchResults =>
      !!(item.fields && "sddocname" in item.fields),
  )

  if (children.length === 0) {
    return { result: "No results found.", contexts: [] }
  }

  const fragments: MinimalAgentFragment[] = await Promise.all(
    children.map(async (r) => {
      const citation = searchToCitation(r)
      return {
        id: citation.docId,
        content: await answerContextMap(
          r,
          userMetadata,
          config.maxDefaultSummary,
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

  return {
    result: fragments.map((v) => v.content).join("\n"),
    contexts: fragments,
  }
}
