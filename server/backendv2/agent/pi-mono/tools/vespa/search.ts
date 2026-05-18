/* eslint-disable @typescript-eslint/naming-convention --
 * Vespa schema uses snake_case fields (chunk_index, page_numbers); mirrored
 * in the tool's output and details. */
// vespaSearch — initial semantic search across the SEBI corpus.
//
// Returns the top-N matching chunks with enough metadata for the agent to
// decide which document to drill into next (via `getChunks` or
// `searchWithinDoc`). Snippet text is truncated to keep the response cheap;
// the agent calls `getChunks` for full text.

import { defineTool } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"

import { searchVespaAgent, searchVespaKnowledgeBase } from "@/search/vespa"
import type { VespaSearchResponse } from "@xyne/vespa-ts/types"

import type { AgentScope } from "../../../agent-scope"
import type { Log } from "../../../log"
import {
  formatPages,
  snippetForChunk,
  textResult,
  titleOf,
  topChunkIndex,
  truncate,
} from "./util"

const DESCRIPTION = [
  "Semantic search across the ingested SEBI corpus (Acts, Regulations, ",
  "Circulars, Master Circulars, Notifications, DRHPs, RHPs, Filings).",
  "Returns the most relevant chunks with their `docId`, chunk index, ",
  "title, page range and a snippet of the content. Use this as your ",
  "FIRST step on any research task to discover candidate documents.",
  "After this, drill in with `getChunks` (to read more around a specific ",
  "chunk) or `searchWithinDoc` (to find other relevant chunks in the same ",
  "document). Issue multiple varied queries — synonyms, regulation numbers, ",
  "circular numbers, section names — to maximise recall. Be specific.",
].join("")

const params = Type.Object({
  query: Type.String({
    description:
      "Short, content-focused search query — 3-8 important keywords is " +
      "usually best (e.g. 'ESG rating withdrawal', 'AIF Category II " +
      "investment restrictions', 'Master Circular for Mutual Funds 2024').",
    minLength: 2,
    maxLength: 200,
  }),
  limit: Type.Optional(
    Type.Number({
      description:
        "Maximum chunks to return (1–30). Default 15. Use higher (20–30) " +
        "for broad survey queries; keep tight (5–10) for precision.",
      minimum: 1,
      maximum: 30,
    }),
  ),
})

type SearchToolArgs = {
  userEmail: string
  logger: Log
  agentScope?: AgentScope
}

/** Pick the right vespa entrypoint for the current turn. When the agent has a
 *  scope, route through `searchVespaAgent` so its allowlist (apps, item IDs,
 *  KB collections, channels, filters) is honored — that's what lets a user
 *  query a public agent's documents they don't personally own. Without a
 *  scope we keep the KB-only behavior (createdBy == email) which is the safe
 *  default for unscoped sessions. */
const runSearch = async (
  query: string,
  limit: number,
  args: SearchToolArgs,
): Promise<VespaSearchResponse> => {
  const { userEmail, agentScope } = args
  if (!agentScope) {
    return searchVespaKnowledgeBase(query, userEmail, { limit })
  }
  // If the agent has no app allowlist at all (rare — usually misconfigured),
  // searchVespaAgent would have nothing to query. Fall back to KB so the user
  // at least gets their own items rather than an empty response.
  if (agentScope.appEnums.length === 0) {
    return searchVespaKnowledgeBase(query, userEmail, { limit })
  }
  return searchVespaAgent(query, userEmail, null, null, agentScope.appEnums, {
    limit,
    ...(agentScope.dataSourceIds.length
      ? { dataSourceIds: agentScope.dataSourceIds }
      : {}),
    ...(agentScope.channelIds.length
      ? { channelIds: agentScope.channelIds }
      : {}),
    ...(Object.keys(agentScope.selectedItems).length
      ? { selectedItem: agentScope.selectedItems }
      : {}),
    ...(Object.keys(agentScope.appFilters).length
      ? { appFilters: agentScope.appFilters }
      : {}),
    ...(agentScope.collectionSelections.length
      ? { collectionSelections: agentScope.collectionSelections }
      : {}),
  })
}

export const buildVespaSearchTool = (
  args: SearchToolArgs,
): ReturnType<typeof defineTool> =>
  defineTool({
    name: "vespaSearch",
    label: "SEBI semantic search",
    description: DESCRIPTION,
    promptSnippet:
      "Use `vespaSearch` first to find candidate documents/chunks for any " +
      "SEBI research question. Vary the query phrasing across calls.",
    parameters: params,
    async execute(toolCallId, p) {
      const log = args.logger.child({
        toolName: "vespaSearch",
        toolCallId,
      })
      const startedAt = Date.now()
      log.info(
        {
          query: p.query,
          limit: p.limit ?? 15,
          agentScoped: !!args.agentScope,
          agentExternalId: args.agentScope?.externalId,
        },
        "tool: vespaSearch start",
      )
      const limit = p.limit ?? 15
      try {
        const resp = await runSearch(p.query, limit, args)
        const children = resp?.root?.children ?? []
        if (children.length === 0) {
          log.info(
            { hits: 0, durationMs: Date.now() - startedAt },
            "tool: vespaSearch done (empty)",
          )
          return textResult(
            `<search_results query=${JSON.stringify(p.query)} hits="0"/>`,
            { hits: 0, query: p.query },
          )
        }

        const lines: string[] = []
        lines.push(
          `<search_results query=${JSON.stringify(p.query)} hits="${String(children.length)}">`,
        )
        const details: Array<{
          rank: number
          docId: string
          chunkIndex: number | null
          score: number
          title: string
        }> = []

        children.forEach((hit, i) => {
          const rank = i + 1
          const fields = (hit?.fields ?? {}) as Record<string, unknown>
          const rawDocId = fields["docId"]
          const docId = typeof rawDocId === "string" ? rawDocId : ""
          const title = titleOf({
            title: fields["title"] as string | undefined,
            fileName: fields["fileName"] as string | undefined,
            docId,
          })
          const score = typeof hit?.relevance === "number" ? hit.relevance : 0

          // The top-scoring chunk index comes from `matchfeatures.chunk_scores`.
          // Snippet text is fetched from `chunks_summary` at the matching
          // position (via `chunks_pos_summary` mapping).
          const chunkIndex = topChunkIndex(fields)
          const snippet =
            chunkIndex !== null ? snippetForChunk(fields, chunkIndex) : ""

          // Resolve page numbers for this chunk via chunks_map if available.
          let pages = ""
          const chunksMap = fields["chunks_map"]
          if (Array.isArray(chunksMap) && chunkIndex !== null) {
            const entry = (
              chunksMap as Array<{
                chunk_index: number
                page_numbers?: number[]
              }>
            ).find((m) => m.chunk_index === chunkIndex)
            pages = formatPages(entry?.page_numbers)
          }

          lines.push(
            `  <hit rank="${String(rank)}" docId=${JSON.stringify(docId)} ` +
              `chunk_index="${chunkIndex === null ? "" : String(chunkIndex)}" ` +
              `score="${score.toFixed(4)}"${pages ? ` pages="${pages}"` : ""}>`,
          )
          lines.push(`    <title>${title}</title>`)
          if (snippet) {
            lines.push(`    <snippet>${truncate(snippet)}</snippet>`)
          }
          lines.push(`  </hit>`)

          details.push({ rank, docId, chunkIndex, score, title })
        })

        lines.push(`</search_results>`)
        lines.push(
          `\nNext steps: call \`getChunks\` with the docId + chunk_index ` +
            `range to read full context, or \`searchWithinDoc\` to find ` +
            `other relevant chunks in the same document.`,
        )

        log.info(
          {
            hits: details.length,
            topDocId: details[0]?.docId,
            topChunkIndex: details[0]?.chunkIndex,
            durationMs: Date.now() - startedAt,
          },
          "tool: vespaSearch done",
        )
        return textResult(lines.join("\n"), {
          query: p.query,
          hits: details,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(
          { err, query: p.query, durationMs: Date.now() - startedAt },
          "tool: vespaSearch failed",
        )
        return textResult(`vespaSearch failed: ${msg}`, { error: msg }, true)
      }
    },
  })
