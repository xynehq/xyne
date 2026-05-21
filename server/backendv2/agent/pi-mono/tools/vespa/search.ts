/* eslint-disable @typescript-eslint/naming-convention --
 * Vespa schema uses snake_case fields (chunk_index, page_numbers); mirrored
 * in the tool's output and details. */
// vespaSearch — initial semantic search across the SEBI corpus.
//
// Returns the top-N matching chunks with enough metadata for the agent to
// decide which document to drill into next (via `getChunks` or
// `searchWithinDoc`). Chunks are returned in full (no per-chunk
// truncation) so the agent gets the same text the document was chunked
// into at ingest time.

import { defineTool } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"

import config from "@/config"
import { searchVespaAgent, searchVespaKnowledgeBase } from "@/search/vespa"
import type { VespaSearchResponse } from "@xyne/vespa-ts/types"

import type { AgentScope } from "../../../agent-scope"
import type { Log } from "../../../log"
import {
  formatPages,
  snippetForChunk,
  textResult,
  titleOf,
  topChunkIndices,
} from "./util"

// Per-hit snippet cap. Showing the agent multiple top-scoring chunks per
// document gives a far better recall signal than just the single best one —
// closely related passages (definitions + exceptions, header + table row,
// etc.) often live in adjacent chunks but score differently.
const TOP_CHUNKS_PER_DOC = 3

const DESCRIPTION = [
  "Semantic search across the ingested SEBI corpus (Acts, Regulations, ",
  "Circulars, Master Circulars, Notifications, DRHPs, RHPs, Filings).",
  `Each hit returns up to ${String(TOP_CHUNKS_PER_DOC)} top-scoring chunks `,
  "from the same document (each with its own `chunk_index`, `score`, and ",
  "snippet) so you can compare passages without an extra round-trip. Use ",
  "this as your FIRST step on any research task to discover candidate ",
  "documents. After this, drill in with `getChunks` (to read more around a ",
  "specific chunk) or `searchWithinDoc` (to find other relevant chunks in ",
  "the same document). Issue multiple varied queries — synonyms, regulation ",
  "numbers, circular numbers, section names — to maximise recall. Be specific. ",
  "When the user names a folder/section, pass a `folder` path (from ",
  "`getFolderTree`) to scope the search to that folder subtree.",
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
  folder: Type.Optional(
    Type.String({
      description:
        "Optional folder-path scope (e.g. 'Enforcements/Orders'). When set, " +
        "the search is restricted to documents whose path starts with this " +
        "folder, matching the document `fileName`. Call `getFolderTree` first " +
        "to discover valid paths. Start BROAD (a top-level folder) and only " +
        "narrow if you get too many irrelevant hits.",
      minLength: 1,
      maxLength: 300,
    }),
  ),
  alpha: Type.Optional(
    Type.Number({
      description:
        "Hybrid weight between lexical and vector match (0 = keyword-only, " +
        "1 = vector-only). Only used when `folder` is set; default 0.7 leans " +
        "semantic. Lower it toward 0.3-0.5 when the query is mostly exact " +
        "keywords/identifiers.",
      minimum: 0,
      maximum: 1,
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description:
        "Maximum chunks to return (1–50). Default 15 (25 when `folder` is " +
        "set). Use higher (30–50) for broad survey queries; keep tight " +
        "(5–10) for precision.",
      minimum: 1,
      maximum: 50,
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

/** Escape a YQL double-quoted string literal (backslash + dquote). */
const yqlString = (s: string): string =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

const inClause = (field: string, values: readonly string[]): string =>
  `${field} in (${values.map(yqlString).join(", ")})`

/** Replicate the agent's KB allowlist (clId/clFd/docId) as a YQL clause so the
 *  scoped path enforces the same visibility as `searchVespaAgent`. Returns ""
 *  when the scope carries no KB collection selections (nothing to gate on). */
const scopeGateClause = (agentScope: AgentScope | undefined): string => {
  if (!agentScope?.collectionSelections.length) return ""
  const ids: string[] = []
  const folderIds: string[] = []
  const fileIds: string[] = []
  for (const s of agentScope.collectionSelections) {
    if (s.collectionIds?.length) ids.push(...s.collectionIds)
    if (s.collectionFolderIds?.length) folderIds.push(...s.collectionFolderIds)
    if (s.collectionFileIds?.length) fileIds.push(...s.collectionFileIds)
  }
  const parts: string[] = []
  if (ids.length) parts.push(inClause("clId", ids))
  if (folderIds.length) parts.push(inClause("clFd", folderIds))
  if (fileIds.length) parts.push(inClause("docId", fileIds))
  return parts.length ? `(${parts.join(" or ")})` : ""
}

/** Folder-scoped hybrid search. The vespa-ts client can't express a `fileName`
 *  filter, so we build the YQL by hand and POST it to the query endpoint
 *  directly — same transport metadataSearch uses. The agent scope gate is
 *  ANDed in so a scoped session can't read outside its allowlist. */
const runScopedSearch = async (
  query: string,
  limit: number,
  folder: string,
  alpha: number,
  args: SearchToolArgs,
): Promise<VespaSearchResponse> => {
  const targetHits = Math.max(limit, 200)
  const clauses = [
    `(({targetHits:${String(targetHits)}}nearestNeighbor(chunk_embeddings, e)) ` +
      `or userInput(@query))`,
    `fileName contains ${yqlString(folder)}`,
  ]
  const gate = scopeGateClause(args.agentScope)
  if (gate) clauses.push(gate)
  const yql = `select * from kb_items where ${clauses.join(" and ")}`
  const body: Record<string, unknown> = {
    yql,
    query,
    "input.query(e)": "embed(@query)",
    "input.query(alpha)": alpha,
    "input.query(recency_decay_rate)": 0.02,
    "ranking.profile": "default_native",
    hits: limit,
    timeout: "30s",
  }
  const endpoint = `${config.vespaEndpoint.queryEndpoint}/search/`
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`vespa HTTP ${String(res.status)}: ${text.slice(0, 240)}`)
  }
  return (await res.json()) as VespaSearchResponse
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
      const folder = typeof p.folder === "string" ? p.folder.trim() : ""
      const limit = p.limit ?? (folder ? 35 : 20)
      const alpha = typeof p.alpha === "number" ? p.alpha : 0.7
      log.info(
        {
          query: p.query,
          limit,
          folder: folder || undefined,
          alpha: folder ? alpha : undefined,
          agentScoped: !!args.agentScope,
          agentExternalId: args.agentScope?.externalId,
        },
        "tool: vespaSearch start",
      )
      try {
        const resp = folder
          ? await runScopedSearch(p.query, limit, folder, alpha, args)
          : await runSearch(p.query, limit, args)
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
          chunkIndices: number[]
          score: number
          title: string
          aiSummary: string | null
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
          // LLM-generated per-document summary (title/type/date/entities/topics/
          // regulations/summary). Gives the agent the whole-doc gist alongside
          // the matched chunks so it can judge relevance, not just the passage.
          const aiSummary =
            typeof fields["ai_summary"] === "string"
              ? (fields["ai_summary"] as string)
              : null

          // Top-N chunk indices come from `matchfeatures.chunk_scores`.
          // Snippet text is fetched from `chunks_summary` at the matching
          // position (via `chunks_pos_summary` mapping).
          const topChunks = topChunkIndices(fields, TOP_CHUNKS_PER_DOC)
          const chunksMap = fields["chunks_map"] as
            | Array<{ chunk_index: number; page_numbers?: number[] }>
            | undefined
          // `chunks_map` has one entry per chunk in the doc, so its length
          // is the total chunk count we surface on the hit. The model uses
          // this to decide whether to call `getChunks` for more context or
          // stop here. When the field is missing we omit the attribute
          // rather than guess.
          const totalChunks = Array.isArray(chunksMap)
            ? chunksMap.length
            : undefined
          const renderedChunks = topChunks
            .map((c) => {
              const snippet = snippetForChunk(fields, c.index)
              const pages = Array.isArray(chunksMap)
                ? formatPages(
                    chunksMap.find((m) => m.chunk_index === c.index)
                      ?.page_numbers,
                  )
                : ""
              return { ...c, snippet, pages }
            })
            .filter((c) => c.snippet)

          lines.push(
            `  <hit rank="${String(rank)}" docId=${JSON.stringify(docId)} ` +
              `score="${score.toFixed(4)}"` +
              `${typeof totalChunks === "number" ? ` total_chunks="${String(totalChunks)}"` : ""}>`,
          )
          lines.push(`    <title>${title}</title>`)
          if (aiSummary) {
            lines.push(
              `    <ai_summary>${truncate(aiSummary, 2000)}</ai_summary>`,
            )
          }
          for (const c of renderedChunks) {
            // `cite` is the exact string the system prompt instructs the
            // model to copy verbatim into its answer. Emitting it as a
            // ready-made attribute removes the assembly step (and the
            // associated bracket/character errors) the model used to make
            // when it constructed `[docId#chunk]` itself.
            lines.push(
              `    <chunk chunk_index="${String(c.index)}" ` +
                `score="${c.score.toFixed(4)}"` +
                `${c.pages ? ` pages="${c.pages}"` : ""}` +
                ` cite="[${docId}#${String(c.index)}]">` +
                `${c.snippet}</chunk>`,
            )
          }
          lines.push(`  </hit>`)

          details.push({
            rank,
            docId,
            chunkIndex: renderedChunks[0]?.index ?? null,
            chunkIndices: renderedChunks.map((c) => c.index),
            score,
            title,
            aiSummary,
          })
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
