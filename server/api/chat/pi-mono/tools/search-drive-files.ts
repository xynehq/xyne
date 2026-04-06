/**
 * searchDriveFiles tool - pi-mono version
 *
 * Fully wired to existing JAF implementation
 */

import { Type } from "@sinclair/typebox"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"
import { Apps, GoogleApps, DriveEntity } from "@xyne/vespa-ts"
import { searchGoogleApps } from "@/search/vespa"
import {
  formatSearchToolResponse,
  parseAgentAppIntegrations,
} from "../../tools/utils"
import { mergeFragmentLists } from "../fragment-utils"
import { extractDriveIds } from "@/search/utils"
import config from "@/config"
import type { MinimalAgentFragment } from "@/api/chat/types"

/**
 * Format search fragments as metadata-only for tool results.
 * Full content is available in the ranked context block injected by the context handler.
 */
function formatFragmentsForLLM(
  fragments: MinimalAgentFragment[],
  query: string | undefined,
): string {
  if (fragments.length === 0) {
    return `No Drive files found for "${query || "the query"}".`
  }

  const lines: string[] = [
    `Found ${fragments.length} Drive file${fragments.length === 1 ? "" : "s"} for "${query || "the query"}":`,
    "",
  ]

  for (let i = 0; i < fragments.length; i++) {
    const f = fragments[i]
    const source = f.source
    const title = source?.title || "Unknown"
    const app = source?.app || "GoogleDrive"
    const entity = source?.entity || "file"
    const relevance = f.confidence
      ? `${(f.confidence * 100).toFixed(1)}%`
      : "N/A"
    lines.push(
      `[${i + 1}] ${title} (${app} ${entity}) | DocID: ${source?.docId || f.id || "unknown"} | Relevance: ${relevance}`,
    )
  }

  lines.push("")
  lines.push(
    "Full content is available in the RANKED SEARCH RESULTS context block.",
  )

  return lines.join("\n")
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
      - File queries: Use topic + context (e.g., 'budget report', 'contract legal', 'project alpha')
      
      Examples:
      - "reimbursement procedure application process policy guidelines" → "reimbursement policy"
      - "meeting notes from last week about project updates" → "project updates"
      - "emails from John about the marketing campaign" → "John marketing"
      
      Step 4: Apply the rule:
      - IF specific content keywords found → create SHORT semantic query (1-3 terms)
      - IF no specific content keywords found → set query to null
`

const searchDriveFilesParams = Type.Object({
  query: Type.String({
    description: retrievalQueryDescription,
    minLength: 1,
  }),
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
  owner: Type.Optional(
    Type.String({
      description:
        "Optional Drive owner identifier string. Email is preferred; owner display name can also work.",
    }),
  ),
  filetype: Type.Optional(
    Type.Array(
      Type.String({
        description: `Optional Drive file-type enum values. Valid values are ${Object.values(
          DriveEntity,
        )
          .map((e) => `'${e}'`)
          .join(", ")}.`,
        enum: Object.values(DriveEntity),
      }),
      {
        description: `Optional Drive file-type enum values. Valid values are ${Object.values(
          DriveEntity,
        )
          .map((e) => `'${e}'`)
          .join(", ")}.`,
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

export const searchDriveFilesTool = createXyneTool(
  "searchDriveFiles",
  "Search Google Drive files by title/content with optional owner, file-type, and time filters. Use file types when the ask is constrained to PDFs, folders, spreadsheets, or other specific Drive entities.",
  searchDriveFilesParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    const { xyneState, persistState } = ctx

    try {
      const email = xyneState.user.email
      const agentPrompt = xyneState.agentPrompt

      const { agentAppEnums, selectedItems } =
        parseAgentAppIntegrations(agentPrompt)

      if (!email) {
        return {
          content: [
            { type: "text", text: "Email is required for Drive files search." },
          ],
          isError: true,
          details: { toolName: "searchDriveFiles" },
        }
      }

      // Check if Google Drive is allowed for this agent
      if (agentAppEnums && agentAppEnums.length > 0) {
        if (!agentAppEnums.includes(Apps.GoogleDrive)) {
          return {
            content: [
              {
                type: "text",
                text: "Google Drive is not allowed for this agent. Cannot search.",
              },
            ],
            isError: true,
            details: {
              toolName: "searchDriveFiles",
              code: "PERMISSION_DENIED",
            },
          }
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
      const limit = params.limit
        ? Math.min(params.limit, config.maxUserRequestCount) + offset
        : undefined

      // NOTE: Do NOT auto-inject seenDocuments into excludeDocIds here.
      // excludeDocIds operates at the DOCUMENT level — excluding it blocks ALL chunks.
      // The ranking pipeline deduplicates post-retrieval instead.

      const searchResults = await searchGoogleApps({
        app: GoogleApps.Drive,
        email,
        query: params.query,
        limit,
        offset,
        sortBy: params.sortBy || "desc",
        timeRange: timeRange,
        owner: params.owner,
        driveEntity: params.filetype as DriveEntity[],
        excludeDocIds: params.excludedIds,
        docIds: driveSourceIds,
      })

      const fragments = await formatSearchToolResponse(searchResults, {
        query: params.query,
        app: GoogleApps.Drive,
        timeRange: timeRange,
        offset: params.offset,
        limit: params.limit,
        searchType: "Drive file",
      })

      // Push fragments directly to allFragments so synthesis always has context.
      // The extension's ranking pipeline may also add/reorder via tool_execution_end;
      // mergeFragmentLists deduplicates by vespaDocId so double-adds are safe.
      xyneState.allFragments = mergeFragmentLists(
        xyneState.allFragments,
        fragments,
      )

      await persistState()

      // Format fragments for LLM visibility - include actual content, not just summary
      const formattedResults = formatFragmentsForLLM(fragments, params.query)

      return {
        content: [{ type: "text", text: formattedResults }],
        details: {
          fragments,
          query: params.query,
          toolName: "searchDriveFiles",
        },
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      return {
        content: [
          { type: "text", text: `Drive files search error: ${errMsg}` },
        ],
        isError: true,
        details: { toolName: "searchDriveFiles", error: errMsg },
      }
    }
  },
)
