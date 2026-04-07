/**
 * searchCalendarEvents tool - pi-mono version
 *
 * Fully wired to existing JAF implementation
 */

import { Type } from "@sinclair/typebox"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"
import { Apps, GoogleApps } from "@xyne/vespa-ts"
import type { EventStatusType } from "@xyne/vespa-ts"
import { searchGoogleApps } from "@/search/vespa"
import {
  formatSearchToolResponse,
  parseAgentAppIntegrations,
} from "../../tools/utils"
import config from "@/config"
import { formatFragmentsForLLM } from "./tool-utils"

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
      - Meeting queries: Use meeting topic + type (e.g., 'standup engineering', 'client demo', 'budget review')
      
      Examples:
      - "reimbursement procedure application process policy guidelines" → "reimbursement policy"
      - "meeting notes from last week about project updates" → "project updates"
      - "emails from John about the marketing campaign" → "John marketing"
      
      Step 4: Apply the rule:
      - IF specific content keywords found → create SHORT semantic query (1-3 terms)
      - IF no specific content keywords found → set query to null
`

const searchCalendarEventsParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description: retrievalQueryDescription,
    }),
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
  sortBy: Type.Optional(
    Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
      description:
        "Sort direction. Valid values are `asc` and `desc`. Use `desc` for newest-first or most-recent-first ordering when supported.",
    }),
  ),
  excludedIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Previously seen result document `docId`s to suppress on follow-up searches. Prefer prior `fragment.source.docId` values. Do not pass collection, folder, file, path, or fragment IDs.",
    }),
  ),
  attendees: Type.Optional(
    Type.Array(
      Type.String({
        description:
          "Optional attendee identifier strings. Email addresses are preferred; attendee display names can also work.",
      }),
      {
        description:
          "Optional attendee identifier strings. Email addresses are preferred; attendee display names can also work.",
      },
    ),
  ),
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal("confirmed"),
        Type.Literal("tentative"),
        Type.Literal("cancelled"),
      ],
      {
        description:
          "Optional event status enum. Valid values are `confirmed`, `tentative`, and `cancelled`.",
      },
    ),
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
})

export const searchCalendarEventsTool = createXyneTool(
  "searchCalendarEvents",
  "Search Google Calendar events by meeting topic with optional attendee, status, and time filters. Use attendee and time fields for scheduling or meeting-history queries instead of overloading the query text.",
  searchCalendarEventsParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    const { xyneState } = ctx

    try {
      const email = xyneState.user.email
      const agentPrompt = xyneState.agentPrompt

      const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)

      if (!email) {
        return {
          content: [
            {
              type: "text",
              text: "Email is required for calendar events search.",
            },
          ],
          isError: true,
          details: { toolName: "searchCalendarEvents" },
        }
      }

      // Check if Google Calendar is allowed for this agent
      if (agentAppEnums && agentAppEnums.length > 0) {
        if (!agentAppEnums.includes(Apps.GoogleCalendar)) {
          return {
            content: [
              {
                type: "text",
                text: "Google Calendar is not allowed for this agent. Cannot search.",
              },
            ],
            isError: true,
            details: {
              toolName: "searchCalendarEvents",
              code: "PERMISSION_DENIED",
            },
          }
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
        app: GoogleApps.Calendar,
        email,
        query: params.query,
        limit,
        offset,
        sortBy: params.sortBy || "desc",
        timeRange: timeRange,
        attendees: params.attendees,
        eventStatus: params.status as EventStatusType,
        excludeDocIds: params.excludedIds || [],
        docIds: undefined,
      })

      const fragments = await formatSearchToolResponse(searchResults, {
        query: params.query,
        app: GoogleApps.Calendar,
        timeRange: timeRange,
        offset: params.offset,
        limit: params.limit,
        searchType: "Calendar event",
      })

      const startIndex = xyneState.allFragments.length + 1

      // Store in unrankedFragmentsByTool for turn-end batch ranking (mirrors JAF behavior)
      const toolKey = `searchCalendarEvents:${params.query || "default"}`
      const existing =
        xyneState.currentTurnArtifacts.unrankedFragmentsByTool.get(toolKey)
      const mergedFragments = existing
        ? [...existing.fragments, ...fragments]
        : fragments
      xyneState.currentTurnArtifacts.unrankedFragmentsByTool.set(toolKey, {
        query: params.query || "",
        fragments: mergedFragments,
      })

      const context = formatFragmentsForLLM(fragments, startIndex)

      return {
        content: [{ type: "text", text: context }],
        details: {
          fragments,
          query: params.query,
          toolName: "searchCalendarEvents",
          startIndex,
        },
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      return {
        content: [
          { type: "text", text: `Calendar events search error: ${errMsg}` },
        ],
        isError: true,
        details: { toolName: "searchCalendarEvents", error: errMsg },
      }
    }
  },
)
