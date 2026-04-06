/**
 * searchGoogleContacts tool - pi-mono version
 *
 * Fully wired to existing JAF implementation
 */

import { Type } from "@sinclair/typebox"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"
import { GoogleApps } from "@xyne/vespa-ts"
import { searchGoogleApps } from "@/search/vespa"
import { formatSearchToolResponse } from "../../tools/utils"
import { mergeFragmentLists } from "../fragment-utils"
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
      - Contact queries: Use person/company names, job titles (e.g., 'John Smith', 'OpenAI', 'CEO')
      
      Examples:
      - "reimbursement procedure application process policy guidelines" → "reimbursement policy"
      - "meeting notes from last week about project updates" → "project updates"
      - "emails from John about the marketing campaign" → "John marketing"
      
      Step 4: Apply the rule:
      - IF specific content keywords found → create SHORT semantic query (1-3 terms)
      - IF no specific content keywords found → set query to null
`

const searchGoogleContactsParams = Type.Object({
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
  excludedIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Previously seen result document `docId`s to suppress on follow-up searches. Prefer prior `fragment.source.docId` values. Do not pass collection, folder, file, path, or fragment IDs.",
    }),
  ),
})

export const searchGoogleContactsTool = createXyneTool(
  "searchGoogleContacts",
  "Search Google Contacts for people or organizations by name, email, phone number, title, or company. Use this to disambiguate identity before searching other apps.",
  searchGoogleContactsParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    const { xyneState, persistState } = ctx

    try {
      const email = xyneState.user.email

      if (!email) {
        return {
          content: [
            {
              type: "text",
              text: "Email is required for Google contacts search.",
            },
          ],
          isError: true,
          details: { toolName: "searchGoogleContacts" },
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
        app: GoogleApps.Contacts,
        email,
        query: params.query,
        limit,
        sortBy: "desc",
        excludeDocIds: params.excludedIds,
        offset,
      })

      const fragments = await formatSearchToolResponse(searchResults, {
        query: params.query,
        app: GoogleApps.Contacts,
        offset: params.offset,
        limit: params.limit,
        searchType: "Contact",
      })

      // Push fragments directly to allFragments so synthesis always has context.
      // The extension's ranking pipeline may also add/reorder via tool_execution_end;
      // mergeFragmentLists deduplicates by vespaDocId so double-adds are safe.
      xyneState.allFragments = mergeFragmentLists(
        xyneState.allFragments,
        fragments,
      )

      await persistState()

      return {
        content: [{ type: "text", text: `Found ${fragments.length} contacts` }],
        details: {
          fragments,
          query: params.query,
          toolName: "searchGoogleContacts",
        },
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      return {
        content: [
          { type: "text", text: `Google contacts search error: ${errMsg}` },
        ],
        isError: true,
        details: { toolName: "searchGoogleContacts", error: errMsg },
      }
    }
  },
)
