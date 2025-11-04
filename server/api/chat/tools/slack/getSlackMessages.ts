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
    const { email, agentPrompt } = context

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

      if (!hasScope && !params.query) {
        return ToolResponse.error(
          ToolErrorCodes.MISSING_REQUIRED_FIELD,
          "Please provide at least one filter (e.g., channelName, user, date range, or query) to scope the Slack message search.",
          { toolName: "getSlackRelatedMessages" },
        )
      }

      const searchOptions = {
        limit: Math.min(params.limit || 20, 100), // Cap at 100 for performance
        offset: Math.max(params.offset || 0, 0),
        filterQuery: params.query,
        sortBy: (params.sortBy || "desc") as "asc" | "desc",
        dateFrom: params.timeRange || null,
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
        timestampRange: params.timeRange
          ? {
              from: params.timeRange.startTime,
              to: params.timeRange.endTime,
            }
          : undefined,
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
        return ToolResponse.success("No messages found", {
          toolName: "getSlackRelatedMessages",
          contexts: [],
        })
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
        try {
          const threadResponse = await SearchVespaThreads(threadIdsToFetch)
          const threadItems = (threadResponse?.root?.children || []).filter(
            (item): item is VespaSearchResults =>
              !!(item.fields && "sddocname" in item.fields),
          )

          if (threadItems.length > 0) {
            allItems = [...items, ...threadItems]
            threadMessagesCount = threadItems.length
          }
        } catch (error) {
          Logger.warn(
            `[getSlackRelatedMessages] Failed to fetch thread messages: ${getErrorMessage(error)}`,
          )
        }
      }

      // Process results into fragments
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

      // Build response message
      let responseText = `Found ${fragments.length} Slack message${fragments.length !== 1 ? "s" : ""}`

      if (threadMessagesCount > 0) {
        responseText += ` (including ${threadMessagesCount} thread message${threadMessagesCount !== 1 ? "s" : ""})`
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

      Logger.info(
        `[getSlackRelatedMessages] retrieved ${fragments.length} messages for user ${email}`,
      )
      return ToolResponse.success(fragments.map((v) => v.content).join("\n"), {
        toolName: "getSlackRelatedMessages",
        contexts: fragments,
      })
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
