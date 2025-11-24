import { z, type ZodType } from "zod"
import type { Tool } from "@xynehq/jaf"
import { ToolErrorCodes, ToolResponse } from "@xynehq/jaf"
import {
  Apps,
  SlackEntity,
  chatMessageSchema,
  type VespaChatMessage,
  type VespaChatUser,
  type VespaSearchResults,
} from "@xyne/vespa-ts"
import { getErrorMessage } from "@/utils"
import { searchSlackMessages, SearchVespaThreads } from "@/search/vespa"
import { formatSearchToolResponse, parseAgentAppIntegrations } from "../utils"
import { searchToCitation } from "@/api/chat/utils"
import { answerContextMap } from "@/ai/context"
import { getLogger, Subsystem } from "@/logger"
import type { Ctx, WithExcludedIds } from "../types"
import { baseToolParams, createQuerySchema } from "../schemas"
import type { SearchSlackParams, VespaSearchResponse } from "@xyne/vespa-ts"
import type { MinimalAgentFragment } from "@/api/chat/types"
import { getDateForAI } from "@/utils/index"
import config from "@/config"
import type { UserMetadataType } from "@/types"

const Logger = getLogger(Subsystem.Chat)
const DEFAULT_SLACK_LOOKBACK_MS = 72 * 60 * 60 * 1000

const userMetadata: UserMetadataType = {
  userTimezone: "Asia/Kolkata",
  dateForAI: getDateForAI({ userTimeZone: "Asia/Kolkata" }),
}

type ToolSchemaParameters<T> = Tool<T, Ctx>["schema"]["parameters"]
const toToolSchemaParameters = <T>(schema: ZodType): ToolSchemaParameters<T> =>
  schema as unknown as ToolSchemaParameters<T>

// Related Messages Tool Schema
const getSlackRelatedMessagesSchema = z.object({
  query: createQuerySchema(Apps.Slack),
  channelName: z
    .string()
    .optional()
    .describe("Name of specific channel to search within"),
  user: z
    .string()
    .optional()
    .describe("Name or Email of specific user whose messages to retrieve"),
  mentions: z
    .array(z.string())
    .describe(
      "Filter messages that mention specific users. Provide usernames or email (e.g., '@john.doe' or john.d@domain.in)",
    )
    .optional(),
  ...baseToolParams,
})

export type GetSlackRelatedMessagesParams = z.infer<
  typeof getSlackRelatedMessagesSchema
>

export const getSlackRelatedMessagesTool: Tool<
  GetSlackRelatedMessagesParams,
  Ctx
> = {
  schema: {
    name: "getSlackRelatedMessages",
    description:
      "Unified tool to retrieve Slack messages with flexible filtering options. Can search by channel, user, time range, thread, or any combination. Automatically includes thread messages when found. Use this single tool for all Slack message retrieval needs.",
    parameters: toToolSchemaParameters<GetSlackRelatedMessagesParams>(
      getSlackRelatedMessagesSchema,
    ),
  },
  async execute(
    params: WithExcludedIds<GetSlackRelatedMessagesParams>,
    context: Ctx,
  ) {
    const email = context.user.email
    const agentPrompt = context.agentPrompt

    if (!email) {
      return ToolResponse.error(
        ToolErrorCodes.MISSING_REQUIRED_FIELD,
        "User email is required for Slack message retrieval.",
        { toolName: "getSlackRelatedMessages" },
      )
    }
    let channelIds: string[] = []
    if (agentPrompt) {
      const { agentAppEnums, selectedItems } =
        parseAgentAppIntegrations(agentPrompt)
      channelIds =
        ((selectedItems as Record<string, unknown>)[Apps.Slack] as any) || []
      if (!agentAppEnums.includes(Apps.Slack)) {
        return ToolResponse.error(
          ToolErrorCodes.PERMISSION_DENIED,
          "Slack is not an allowed app for this agent neither the agent is not configured for any Slack channel, please select a channel to search in. .. Cannot retrieve related Slack messages.",
          { toolName: "getSlackRelatedMessages" },
        )
      }
    }

    try {
      // Validate that at least one scope parameter is provided
      const hasScope =
        params.channelName || params.user || params.timeRange || params.mentions

      const shouldApplyFallbackRange = !hasScope && !params.query
      const scopedTimeRange =
        params.timeRange ||
        (shouldApplyFallbackRange ? buildDefaultRecentRange() : undefined)

      if (shouldApplyFallbackRange) {
        Logger.debug(
          "[getSlackRelatedMessages] No filters provided. Defaulting to the last 72 hours."
        )
      }

      let normalizedTimestampRange:
        | {
            from?: number
            to?: number
          }
        | undefined
      try {
        normalizedTimestampRange = normalizeTimestampRange(scopedTimeRange)
      } catch {
        return ToolResponse.error(
          ToolErrorCodes.INVALID_INPUT,
          "Invalid timeRange supplied. Provide ISO-8601 values for startTime and endTime.",
          { toolName: "getSlackRelatedMessages" },
        )
      }

      const searchOptions = {
        limit: Math.min(params.limit || 20, 100), // Cap at 100 for performance
        offset: Math.max(params.offset || 0, 0),
        filterQuery: params.query,
        sortBy: (params.sortBy || "desc") as "asc" | "desc",
        dateFrom: scopedTimeRange || null,
      }

      // Build search parameters based on what's provided
      const searchParams: SearchSlackParams = {
        email: email,
        user: params.user || undefined,
        channelName: params.channelName || undefined,
        filterQuery: searchOptions.filterQuery || "",
        asc: searchOptions.sortBy === "asc",
        limit: searchOptions.limit,
        offset: searchOptions.offset,
        timestampRange: normalizedTimestampRange,
        agentChannelIds: channelIds.length > 0 ? channelIds : undefined,
        mentions:
          params.mentions && params.mentions.length > 0
            ? params.mentions
            : undefined,
      }

      // Execute the search
      const searchResponse = await searchSlackMessages(searchParams)
      const rawItems = searchResponse?.root?.children || []

      // Filter and validate results
      const items: VespaSearchResults[] = rawItems.filter(
        (item): item is VespaSearchResults =>
          !!(item && item.fields && "sddocname" in item.fields),
      )

      if (!items.length) {
        return ToolResponse.success([])
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

      // Fetch thread messages if any thread roots were found
      if (threadIdsToFetch.length > 0) {
        try {
          const threadResponse = await SearchVespaThreads(threadIdsToFetch)
          const threadItems = (threadResponse?.root?.children || []).filter(
            (item): item is VespaSearchResults =>
              !!(item.fields && "sddocname" in item.fields),
          )

          if (threadItems.length > 0) {
            allItems = [...items, ...threadItems]
          }
        } catch (error) {
          Logger.warn(
            `[getSlackRelatedMessages] Failed to fetch thread messages: ${getErrorMessage(error)}`,
          )
        }
      }

      const fragments: MinimalAgentFragment[] = await Promise.all(
        allItems.map(
          async (item: VespaSearchResults): Promise<MinimalAgentFragment> => {
            const citation = searchToCitation(item)
            const content = item.fields
              ? await answerContextMap(item, userMetadata)
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

      Logger.info(
        `[getSlackRelatedMessages] retrieved ${fragments.length} messages for user ${email}`,
      )
      return ToolResponse.success(fragments)
    } catch (error) {
      const errMsg = getErrorMessage(error)
      Logger.error(error, `Slack messages retrieval error: ${errMsg}`)
      return ToolResponse.error(
        ToolErrorCodes.EXECUTION_FAILED,
        `Error retrieving Slack messages: ${errMsg}`,
        { toolName: "getSlackRelatedMessages" },
      )
    }
  },
}

function buildDefaultRecentRange(): {
  startTime: string
  endTime: string
} {
  const end = new Date()
  const start = new Date(end.getTime() - DEFAULT_SLACK_LOOKBACK_MS)
  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  }
}

function normalizeTimestampRange(
  range?: { startTime?: string; endTime?: string }
): { from?: number; to?: number } | undefined {
  if (!range) {
    return undefined
  }
  const normalized: { from?: number; to?: number } = {}
  if (range.startTime) {
    const from = Date.parse(range.startTime)
    if (Number.isNaN(from)) {
      throw new Error("Invalid startTime")
    }
    normalized.from = from
  }
  if (range.endTime) {
    const to = Date.parse(range.endTime)
    if (Number.isNaN(to)) {
      throw new Error("Invalid endTime")
    }
    normalized.to = to
  }
  return Object.keys(normalized).length ? normalized : undefined
}
