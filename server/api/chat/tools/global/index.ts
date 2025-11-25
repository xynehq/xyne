import { z, type ZodType } from "zod"
import type { Tool } from "@xynehq/jaf"
import { ToolErrorCodes, ToolResponse } from "@xynehq/jaf"
import {
  Apps,
  SearchModes,
  type Entity,
  type EventStatusType,
  type MailParticipant,
  type VespaQueryConfig,
  type VespaSchema,
  type VespaSearchResponse,
} from "@xyne/vespa-ts"
import { getErrorMessage } from "@/utils"
import { searchVespaAgent, searchVespa } from "@/search/vespa"
import {
  formatSearchToolResponse,
  parseAgentAppIntegrations,
} from "../utils"
import {
  expandEmailThreadsInResults,
  getChannelIdsFromAgentPrompt,
} from "@/api/chat/utils"
import type { Ctx, WithExcludedIds } from "../types"
import { baseToolParams, createQuerySchema } from "../schemas"
import { generateFallback } from "@/ai/provider"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { MinimalAgentFragment } from "../../types"
import config from "@/config"
import {
  buildKnowledgeBaseCollectionSelections,
  KnowledgeBaseScope,
  type KnowledgeBaseSelection,
} from "@/api/chat/knowledgeBaseSelections"

const Logger = getLogger(Subsystem.Chat)

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
    const email = context.user.email
    const agentPrompt = context.agentPrompt

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

      const kbScope = agentPrompt
        ? KnowledgeBaseScope.AgentScoped
        : KnowledgeBaseScope.UserOwned

      const kbSelections = await buildKnowledgeBaseCollectionSelections({
        scope: kbScope,
        email,
        selectedItems,
      })

      Logger.info(
        {
          email,
          scope: kbScope,
          selectionCount: kbSelections.length,
          selectedItemKeys: Object.keys(
            selectedItems as Record<string, unknown>,
          ).length,
        },
        "[Agents][searchGlobalTool] Using KnowledgeBaseScope for global search",
      )

      const channelIds = agentPrompt
        ? await getChannelIdsFromAgentPrompt(agentPrompt)
        : []

      const offset = params.offset || 0
      const limit = params.limit
        ? Math.min(params.limit, config.maxUserRequestCount) + (offset ?? 0)
        : undefined

      const fragments = await executeVespaSearch({
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
        collectionSelections: kbSelections,
      })

      return ToolResponse.success(fragments)
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
    const userCtx = context.userContext
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

      return ToolResponse.success({
        reasoning: fallbackResponse.reasoning,
      })
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
  collectionSelections?: KnowledgeBaseSelection[]
}

export async function executeVespaSearch(options: UnifiedSearchOptions): Promise<MinimalAgentFragment[]> {
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
    collectionSelections,
    selectedItems,
    orderBy,
    owner,
    eventStatus,
    eventAttendees,
  } = options

  if (!query || query.trim() === "") {
    throw new Error("No query provided for search.")
  }

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

  const resolvedCollectionSelections =
    collectionSelections && collectionSelections.length
      ? collectionSelections
      : buildCollectionSelectionsFromIds(
          collectionIds,
          collectionFolderIds,
          collectionFileIds,
        )

  if (agentAppEnums && agentAppEnums.length > 0) {
    const appsToCheck = Array.isArray(app) ? app : app ? [app] : []
    const invalidApps = appsToCheck.filter((a) => !agentAppEnums.includes(a))
    if (invalidApps.length > 0) {
      const errorMsg = `${invalidApps.join(", ")} ${invalidApps.length > 1 ? "are" : "is"} not allowed app${invalidApps.length > 1 ? "s" : ""} for this agent. Cannot search.`
      throw new Error(errorMsg)
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
        collectionSelections: resolvedCollectionSelections,
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
        collectionSelections: resolvedCollectionSelections,
      },
    )
  }

  // Expand email threads if results contain emails
  if (searchResults?.root?.children && searchResults.root.children.length > 0) {
    searchResults.root.children = await expandEmailThreadsInResults(
      searchResults.root.children,
      email,
    )
  }

  const fragments = await formatSearchToolResponse(searchResults, {
    query,
    app: Array.isArray(app) ? app.join(", ") : app ?? undefined,
    timeRange:
      fromTimestamp && toTimestamp
        ? { startTime: fromTimestamp, endTime: toTimestamp }
        : undefined,
    offset,
    limit,
    searchType: "Global search result",
  })

  return fragments
}

function buildCollectionSelectionsFromIds(
  collectionIds?: string[],
  collectionFolderIds?: string[],
  collectionFileIds?: string[],
): KnowledgeBaseSelection[] | undefined {
  if (
    (!collectionIds || collectionIds.length === 0) &&
    (!collectionFolderIds || collectionFolderIds.length === 0) &&
    (!collectionFileIds || collectionFileIds.length === 0)
  ) {
    return undefined
  }

  const selection: KnowledgeBaseSelection = {}
  if (collectionIds?.length) selection.collectionIds = collectionIds
  if (collectionFolderIds?.length)
    selection.collectionFolderIds = collectionFolderIds
  if (collectionFileIds?.length)
    selection.collectionFileIds = collectionFileIds

  return [selection]
}
