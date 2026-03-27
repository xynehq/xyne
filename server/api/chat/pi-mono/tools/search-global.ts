/**
 * searchGlobal tool - pi-mono version
 *
 * Fully wired to existing JAF implementation
 */

import { Type } from "@sinclair/typebox"
import { createXyneTool } from "../adapter"
import { executeVespaSearch } from "../../tools/global"
import type { XyneToolContext } from "../adapter"
import { parseAgentAppIntegrations } from "../../tools/utils"
import {
  buildKnowledgeBaseCollectionSelections,
  KnowledgeBaseScope,
} from "@/api/chat/knowledgeBaseSelections"
import { getChannelIdsFromAgentPrompt } from "@/api/chat/utils"
import config from "@/config"

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
      - File queries: Use topic + context (e.g., 'budget report', 'contract legal', 'project alpha')
      - Meeting queries: Use meeting topic + type (e.g., 'standup engineering', 'client demo', 'budget review')
      - Contact queries: Use person/company names, job titles (e.g., 'John Smith', 'OpenAI', 'CEO')
      - Slack queries: Use discussion topic + context (e.g., 'deployment issue', 'feature review', 'team sync')
      
      Examples:
      - "reimbursement procedure application process policy guidelines" → "reimbursement policy"
      - "meeting notes from last week about project updates" → "project updates"
      - "emails from John about the marketing campaign" → "John marketing"
      
      Step 4: Apply the rule:
      - Global search: query is MANDATORY. Use 1-3 most important terms from available keywords to search across all apps.
`

const searchGlobalParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description: retrievalQueryDescription,
    }),
  ),
  offset: Type.Optional(
    Type.Number({
      description:
        "Pagination offset as a non-negative integer. Use it after reviewing the current page to continue from the next unseen results.",
      default: 0,
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description:
        "Maximum number of results to return as an integer between 1 and 100. Default is 20. Keep this small for precision-first retrieval and page with `offset` when needed.",
      default: 20,
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

export const searchGlobalTool = createXyneTool(
  "searchGlobal",
  "Search across all connected applications and data sources when the likely source is unclear. Prefer a more specific tool when the query already points clearly to Gmail, Drive, Slack, Calendar, Contacts, or a known knowledge-base location.",
  searchGlobalParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    const { xyneState, persistState } = ctx

    try {
      const email = xyneState.user.email
      if (!email) {
        return {
          content: [
            { type: "text", text: "Email is required for global search." },
          ],
          isError: true,
          details: { toolName: "searchGlobal" },
        }
      }

      const agentPrompt = xyneState.agentPrompt

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

      const channelIds = agentPrompt
        ? await getChannelIdsFromAgentPrompt(agentPrompt)
        : []

      const offset = params.offset || 0
      const limit = params.limit
        ? Math.min(params.limit, config.maxUserRequestCount) + offset
        : undefined

      // Call the actual JAF implementation
      const fragments = await executeVespaSearch({
        email,
        query: params.query,
        limit,
        offset,
        excludedIds: params.excludedIds,
        agentAppEnums,
        channelIds,
        collectionIds: agentSpecificCollectionIds,
        collectionFolderIds: agentSpecificCollectionFolderIds,
        collectionFileIds: agentSpecificCollectionFileIds,
        selectedItems: selectedItems,
        collectionSelections: kbSelections,
        userId: xyneState.user.numericId,
        workspaceId: xyneState.user.workspaceNumericId ?? null,
      })

      // Store fragments in Xyne state
      xyneState.allFragments.push(...fragments)

      // Store in unrankedFragmentsByTool for turn-end batch ranking (mirrors JAF behavior)
      const toolKey = `searchGlobal:${params.query || "default"}`
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
          {
            type: "text",
            text: `Found ${fragments.length} results for "${params.query}"`,
          },
        ],
        details: {
          fragments,
          query: params.query,
          toolName: "searchGlobal",
        },
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: "text", text: `Search error: ${errMsg}` }],
        isError: true,
        details: { toolName: "searchGlobal", error: errMsg },
      }
    }
  },
)
