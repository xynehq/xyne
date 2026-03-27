/**
 * getSlackRelatedMessages tool - pi-mono version
 *
 * Fully wired to existing JAF implementation
 */

import { Type } from "@sinclair/typebox"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"
import {
  Apps,
  chatMessageSchema,
  type VespaChatMessage,
  type VespaSearchResults,
} from "@xyne/vespa-ts"
import { searchSlackMessages, SearchVespaThreads } from "@/search/vespa"
import { parseAgentAppIntegrations } from "../../tools/utils"
import { searchToCitation } from "@/api/chat/utils"
import { answerContextMap } from "@/ai/context"
import type { SearchSlackParams } from "@xyne/vespa-ts"
import type { MinimalAgentFragment } from "@/api/chat/types"
import { getLogger, Subsystem } from "@/logger"
import { getErrorMessage } from "@/utils"

const Logger = getLogger(Subsystem.Chat)
const DEFAULT_SLACK_LOOKBACK_MS = 72 * 60 * 60 * 1000

type NormalizedTimestampRange = {
  from: number | null
  to: number | null
} | null

function normalizeTimestampRange(range?: {
  startTime?: string
  endTime?: string
}): NormalizedTimestampRange {
  if (!range) {
    return null
  }
  let hasValue = false
  const normalized: { from: number | null; to: number | null } = {
    from: null,
    to: null,
  }
  if (range.startTime) {
    const from = Date.parse(range.startTime)
    if (Number.isNaN(from)) {
      throw new Error("Invalid startTime")
    }
    normalized.from = from
    hasValue = true
  }
  if (range.endTime) {
    const to = Date.parse(range.endTime)
    if (Number.isNaN(to)) {
      throw new Error("Invalid endTime")
    }
    normalized.to = to
    hasValue = true
  }
  return hasValue ? normalized : null
}

const retrievalQueryDescription = `
Create SHORT, targeted search terms optimized for retrieval systems. Focus on 1-3 key terms rather than long descriptive phrases.
      
      Step 1: Identify the MOST IMPORTANT specific keywords:
      - Person names (e.g., "John", "Sarah")
      - Business/project names (e.g., "uber", "zomato") 
      - Core topics (e.g., "contract", "invoice", "proposal")
      - Company names (e.g., "OpenAI", "Google")
      - Product names or key identifiers
      
      Step 2: EXCLUDE these generic terms:
      - Action words: "find", "show", "get", "search", "give", "recent", "latest"
      - Pronouns: "my", "your", "their"
      - Time references: "recent", "latest", "last week", "old", "new"
      - Quantity words: "5", "10", "most", "all", "some"
      - Generic types: "emails", "files", "documents", "meetings" (when used alone)
      - Filler words: "summary", "details", "info", "information", "about", "regarding"
      
      Step 3: Create CONCISE query (1-3 key terms max):
      - Slack queries: Use discussion topic + context (e.g., 'deployment issue', 'feature review', 'team sync')
      
      Examples:
      - "reimbursement procedure application process policy guidelines" → "reimbursement policy"
      - "meeting notes from last week about project updates" → "project updates"
      - "emails from John about the marketing campaign" → "John marketing"
      
      Step 4: Apply the rule:
      - IF specific content keywords found → create SHORT semantic query (1-3 terms)
      - IF no specific content keywords found → set query to null
`

const getSlackRelatedMessagesParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description: retrievalQueryDescription,
    }),
  ),
  channelName: Type.Optional(
    Type.String({
      description:
        "Optional Slack channel name string, such as `eng-launches`. Pass the human-facing channel name, not a Slack channel ID.",
    }),
  ),
  user: Type.Optional(
    Type.String({
      description:
        "Optional Slack user identifier string to restrict messages by author. Email is preferred; display name can also work.",
    }),
  ),
  mentions: Type.Optional(
    Type.Array(
      Type.String({
        description:
          "Optional list of mentioned-user identifier strings, usually emails or usernames, to find messages that mention specific people.",
      }),
      {
        description:
          "Optional list of mentioned-user identifier strings, usually emails or usernames, to find messages that mention specific people.",
      },
    ),
  ),
  limit: Type.Optional(
    Type.Number({
      description:
        "Maximum number of results to return as an integer between 1 and 100. Default is 20. Keep this small for precision-first retrieval and page with `offset` when needed.",
      default: 20,
    }),
  ),
  offset: Type.Optional(
    Type.Number({
      description:
        "Pagination offset as a non-negative integer. Use it after reviewing the current page to continue from the next unseen results.",
      default: 0,
    }),
  ),
  excludedIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Previously seen result document `docId`s to suppress on follow-up searches. Prefer prior `fragment.source.docId` values. Do not pass collection, folder, file, path, or fragment IDs.",
    }),
  ),
  timeRange: Type.Optional(
    Type.Object(
      {
        startTime: Type.Optional(
          Type.String({ description: "Inclusive start time as a string." }),
        ),
        endTime: Type.Optional(
          Type.String({ description: "Inclusive end time as a string." }),
        ),
      },
      {
        description:
          "Optional time-range object with string fields `{ startTime, endTime }`. Use it when the query is bounded by an explicit time window.",
      },
    ),
  ),
  sortBy: Type.Optional(
    Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
      description:
        "Sort direction. Valid values are `asc` and `desc`. Use `desc` for newest-first or most-recent-first ordering when supported.",
    }),
  ),
})

export const getSlackRelatedMessagesTool = createXyneTool(
  "getSlackRelatedMessages",
  "Search Slack messages with flexible filters for content, channel, author, mentions, and time range. Automatically includes thread replies when thread roots are found, and defaults to recent Slack history only when no query and no Slack filter fields are supplied.",
  getSlackRelatedMessagesParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    const { xyneState, persistState } = ctx

    try {
      const email = xyneState.user.email
      const agentPrompt = xyneState.agentPrompt

      if (!email) {
        return {
          content: [
            {
              type: "text",
              text: "User email is required for Slack message retrieval.",
            },
          ],
          isError: true,
          details: { toolName: "getSlackRelatedMessages" },
        }
      }

      const { agentAppEnums, selectedItems } =
        parseAgentAppIntegrations(agentPrompt)
      const channelIds =
        ((selectedItems as Record<string, unknown>)[Apps.Slack] as any) || []

      // Check if Slack is allowed for this agent
      if (agentAppEnums && agentAppEnums.length > 0) {
        if (!agentAppEnums.includes(Apps.Slack)) {
          return {
            content: [
              {
                type: "text",
                text: "Slack is not an allowed app for this agent neither the agent is not configured for any Slack channel, please select a channel to search in. Cannot retrieve related Slack messages.",
              },
            ],
            isError: true,
            details: {
              toolName: "getSlackRelatedMessages",
              code: "PERMISSION_DENIED",
            },
          }
        }
      }

      // Validate that at least one scope parameter is provided
      const hasScope =
        params.channelName || params.user || params.timeRange || params.mentions
      const shouldApplyFallbackRange = !hasScope && !params.query

      let scopedTimeRange = params.timeRange
      if (shouldApplyFallbackRange) {
        const end = new Date()
        const start = new Date(end.getTime() - DEFAULT_SLACK_LOOKBACK_MS)
        scopedTimeRange = {
          startTime: start.toISOString(),
          endTime: end.toISOString(),
        }
        Logger.debug(
          "[getSlackRelatedMessages] No filters provided. Defaulting to the last 72 hours.",
        )
      }

      let normalizedTimestampRange: NormalizedTimestampRange = null
      try {
        normalizedTimestampRange = normalizeTimestampRange(scopedTimeRange)
      } catch {
        return {
          content: [
            {
              type: "text",
              text: "Invalid timeRange supplied. Provide ISO-8601 values for startTime and endTime.",
            },
          ],
          isError: true,
          details: {
            toolName: "getSlackRelatedMessages",
            code: "INVALID_INPUT",
          },
        }
      }

      const searchParams: SearchSlackParams = {
        email,
        user: params.user || undefined,
        channelName: params.channelName || undefined,
        filterQuery: params.query || "",
        asc: (params.sortBy || "desc") === "asc",
        limit: Math.min(params.limit || 20, 100),
        offset: params.offset || 0,
        timestampRange: normalizedTimestampRange,
        agentChannelIds: channelIds.length > 0 ? channelIds : undefined,
        excludeDocIds: params.excludedIds || [],
        mentions:
          params.mentions && params.mentions.length > 0
            ? params.mentions
            : undefined,
      }

      const searchResponse = await searchSlackMessages(searchParams)
      const rawItems = searchResponse?.root?.children || []

      // Filter and validate results
      const items: VespaSearchResults[] = rawItems.filter(
        (item): item is VespaSearchResults =>
          !!(item && item.fields && "sddocname" in item.fields),
      )

      if (!items.length) {
        // Store in unrankedFragmentsByTool for turn-end batch ranking (mirrors JAF behavior)
        const toolKey = `getSlackRelatedMessages:${params.query || "default"}`
        xyneState.currentTurnArtifacts.unrankedFragmentsByTool.set(toolKey, {
          query: params.query || "",
          fragments: [],
        })

        await persistState()
        return {
          content: [{ type: "text", text: "Found 0 Slack messages" }],
          details: {
            fragments: [],
            query: params.query,
            toolName: "getSlackRelatedMessages",
          },
        }
      }

      Logger.info(
        `[getSlackRelatedMessages] retrieved ${items.length} initial messages for user ${email}`,
      )

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

      // Filter excluded IDs
      const excludedDocIds = new Set(params.excludedIds || [])
      if (excludedDocIds.size > 0) {
        allItems = allItems.filter((item) => {
          const citation = searchToCitation(item)
          return !excludedDocIds.has(citation.docId)
        })
      }

      const userMetadata = {
        userTimezone: xyneState.user.timeZone || "UTC",
        dateForAI: new Date().toISOString(),
        userId: xyneState.user.numericId,
        workspaceId: xyneState.user.workspaceNumericId || 0,
      }

      const fragments: MinimalAgentFragment[] = await Promise.all(
        allItems.map(async (item): Promise<MinimalAgentFragment> => {
          const citation = searchToCitation(item)
          const content = item.fields
            ? await answerContextMap(item, userMetadata)
            : `Content unavailable for ${citation.title || citation.docId}`

          return {
            id: citation.docId,
            content,
            source: citation,
            confidence: item.relevance || 0.7,
          }
        }),
      )

      xyneState.allFragments.push(...fragments)

      // Store in unrankedFragmentsByTool for turn-end batch ranking (mirrors JAF behavior)
      const toolKey = `getSlackRelatedMessages:${params.query || "default"}`
      const existing =
        xyneState.currentTurnArtifacts.unrankedFragmentsByTool.get(toolKey)
      const mergedFragments = existing
        ? [...existing.fragments, ...fragments]
        : fragments
      xyneState.currentTurnArtifacts.unrankedFragmentsByTool.set(toolKey, {
        query: params.query || "",
        fragments: mergedFragments,
      })

      await persistState()

      Logger.info(
        `[getSlackRelatedMessages] retrieved ${fragments.length} messages for user ${email}`,
      )

      return {
        content: [
          { type: "text", text: `Found ${fragments.length} Slack messages` },
        ],
        details: {
          fragments,
          query: params.query,
          toolName: "getSlackRelatedMessages",
        },
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      return {
        content: [
          { type: "text", text: `Error retrieving Slack messages: ${errMsg}` },
        ],
        isError: true,
        details: { toolName: "getSlackRelatedMessages", error: errMsg },
      }
    }
  },
)
