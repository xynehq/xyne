/**
 * searchGmail tool - pi-mono version
 *
 * Fully wired to existing JAF implementation
 */

import { Type } from "@sinclair/typebox"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"
import { Apps, GoogleApps } from "@xyne/vespa-ts"
import { searchGoogleApps } from "@/search/vespa"
import { expandEmailThreadsInResults } from "@/api/chat/utils"
import {
  formatSearchToolResponse,
  parseAgentAppIntegrations,
} from "../../tools/utils"
import config from "@/config"

const participantsSchema = Type.Object(
  {
    from: Type.Optional(
      Type.Array(
        Type.String({
          description:
            "Sender identifier string. Email is preferred; full name or organization name can also work.",
        }),
      ),
    ),
    to: Type.Optional(
      Type.Array(
        Type.String({
          description:
            "Primary recipient identifier string. Email is preferred; full name or organization name can also work.",
        }),
      ),
    ),
    cc: Type.Optional(
      Type.Array(
        Type.String({
          description:
            "CC recipient identifier string. Email is preferred; full name or organization name can also work.",
        }),
      ),
    ),
    bcc: Type.Optional(
      Type.Array(
        Type.String({
          description:
            "BCC recipient identifier string. Email is preferred; full name or organization name can also work.",
        }),
      ),
    ),
  },
  {
    description:
      "Structured Gmail participant filter object with optional `from`, `to`, `cc`, and `bcc` string arrays.",
  },
)

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
      
      Examples:
      - "reimbursement procedure application process policy guidelines" → "reimbursement policy"
      - "meeting notes from last week about project updates" → "project updates"
      - "emails from John about the marketing campaign" → "John marketing"
      
      Step 4: Apply the rule:
      - IF specific content keywords found → create SHORT semantic query (1-3 terms)
      - IF no specific content keywords found → set query to null
`

const searchGmailParams = Type.Object({
  query: Type.String({
    description: retrievalQueryDescription,
    minLength: 1,
  }),
  limit: Type.Optional(Type.Number({ default: 10 })),
  offset: Type.Optional(Type.Number({ default: 0 })),
  sortBy: Type.Optional(
    Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
      description:
        "Sort direction. Valid values are `asc` and `desc`. Use `desc` for newest-first or most-recent-first ordering when supported.",
    }),
  ),
  excludedIds: Type.Optional(Type.Array(Type.String())),
  labels: Type.Optional(
    Type.Array(Type.String({ description: "Gmail label" }), {
      description:
        "Optional Gmail label strings used to narrow the search. Common values include `IMPORTANT`, `STARRED`, `UNREAD`, `CATEGORY_PERSONAL`, `CATEGORY_SOCIAL`, `CATEGORY_PROMOTIONS`, `CATEGORY_UPDATES`, `CATEGORY_FORUMS`, `DRAFT`, `SENT`, `INBOX`, `SPAM`, and `TRASH`.",
    }),
  ),
  timeRange: Type.Optional(
    Type.Object({
      startTime: Type.Optional(Type.String()),
      endTime: Type.Optional(Type.String()),
    }),
  ),
  participants: Type.Optional(
    Type.Composite([participantsSchema], {
      description:
        "Advanced email communication filtering with intelligent resolution of names, organizations, and email addresses. Supports complex multi-participant email queries with automatic name-to-email mapping. - Structure: {from?: string[], to?: string[], cc?: string[], bcc?: string[]}. - Each field accepts arrays containing email addresses, full names, first names, or organization names.",
    }),
  ),
})

export const searchGmailTool = createXyneTool(
  "searchGmail",
  "Search Gmail messages by content with optional participant, label, and time filters.",
  searchGmailParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    const { xyneState, persistState } = ctx

    try {
      const email = xyneState.user.email
      const agentPrompt = xyneState.agentPrompt

      const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)

      // Check if Gmail is allowed for this agent
      if (agentAppEnums && agentAppEnums.length > 0) {
        if (!agentAppEnums.includes(Apps.Gmail)) {
          return {
            content: [
              {
                type: "text",
                text: "Gmail is not allowed for this agent. Cannot search.",
              },
            ],
            isError: true,
            details: { toolName: "searchGmail", code: "PERMISSION_DENIED" },
          }
        }
      }

      if (!email) {
        return {
          content: [
            { type: "text", text: "Email is required for Gmail search." },
          ],
          isError: true,
          details: { toolName: "searchGmail" },
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
      const limit = params.limit
        ? Math.min(params.limit, config.maxUserRequestCount) + offset
        : undefined

      const searchResults = await searchGoogleApps({
        app: GoogleApps.Gmail,
        email,
        query: params.query,
        limit,
        offset,
        sortBy: params.sortBy || "desc",
        labels: params.labels,
        timeRange: timeRange,
        participants: params.participants || {},
        excludeDocIds: params.excludedIds || [],
        docIds: undefined,
      })

      if (searchResults?.root?.children?.length) {
        searchResults.root.children = await expandEmailThreadsInResults(
          searchResults.root.children,
          email,
        )
      }

      const fragments = await formatSearchToolResponse(searchResults, {
        query: params.query,
        app: GoogleApps.Gmail,
        labels: params.labels,
        timeRange: timeRange,
        offset: params.offset,
        limit: params.limit,
        searchType: "Gmail message",
      })

      xyneState.allFragments.push(...fragments)

      // Store in unrankedFragmentsByTool for turn-end batch ranking (mirrors JAF behavior)
      const toolKey = `searchGmail:${params.query || "default"}`
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

      return {
        content: [
          { type: "text", text: `Found ${fragments.length} Gmail messages` },
        ],
        details: { fragments, query: params.query, toolName: "searchGmail" },
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: "text", text: `Gmail search error: ${errMsg}` }],
        isError: true,
        details: { toolName: "searchGmail", error: errMsg },
      }
    }
  },
)
