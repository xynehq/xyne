/* eslint-disable @typescript-eslint/naming-convention --
 * Vespa schema uses snake_case fields (document_id, pan_ids, ...); we mirror
 * those names so the YQL we build matches what the schema declares. */
// metadataSearch — structured lookup against the new kb_items metadata fields.
//
// vespaSearch handles semantic discovery. This tool is the deterministic
// counterpart: when the user names a concrete identifier — a PAN, a doc_id,
// an entity name, a date range — we want exact filtering with no embedding
// step and no relevance ranking. It hits the Vespa query endpoint directly
// with a hand-built YQL and surfaces the metadata fields back to the agent
// so it can cite by ID/date/entity in the answer.
//
// Why a separate tool (vs. extending vespaSearch with filters): the agent
// should reach for this when it has a concrete identifier, not as a "narrow
// my semantic query" knob. Keeping them split makes the LLM's choice clear
// and avoids muddling the semantic-search prompt with filter syntax.

import { defineTool } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"

import config from "@/config"

import type { AgentScope } from "../../../agent-scope"
import type { Log } from "../../../log"
import { formatPages, snippetForChunk, textResult, titleOf, topChunkIndices, truncate } from "./util"

// Max hits we return — the agent should narrow further if it gets a wide
// result set rather than ask Vespa for a million rows.
const DEFAULT_LIMIT = 15
const MAX_LIMIT = 30

// When the caller passes `query`, ranking is on and `matchfeatures.chunk_scores`
// has signal — surface the top-N chunks per doc (same cap as vespaSearch) so
// the agent gets multiple anchored passages, not just one. With no query
// ranking is unranked and there are zero chunk scores, so no snippets render
// regardless of this cap.
const TOP_CHUNKS_PER_DOC = 3

const DESCRIPTION = [
  "Structured metadata search across the SEBI corpus. Use when the user ",
  "names a CONCRETE identifier — a PAN, a document_id, an entity (company/",
  "person/regulator), a referenced ID, or a date range. Returns documents ",
  "matching ALL provided filters (AND semantics). No semantic ranking, no ",
  "embeddings — exact + BM25 on the metadata fields. ",
  "Prefer this over `vespaSearch` whenever the user's question pivots on a ",
  "specific number, ID, or date rather than a topic. ",
  `When a topical \`query\` is passed, each hit also carries up to `,
  `${String(TOP_CHUNKS_PER_DOC)} top-scoring \`<chunk>\` snippets from the `,
  "document so you can see anchored passages, not just metadata.",
].join("")

const StringOrList = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 }),
])

const params = Type.Object(
  {
    documentId: Type.Optional({
      ...StringOrList,
      description:
        "Exact document_id(s) to fetch. Use when the user names a specific " +
        "doc ID. Multiple IDs are OR-matched.",
    }),
    pan: Type.Optional({
      ...StringOrList,
      description:
        "PAN number(s) to filter by (e.g. 'AAACH7852C'). Matches pan_ids " +
        "exactly. Multiple PANs are OR-matched.",
    }),
    references: Type.Optional({
      ...StringOrList,
      description:
        "Referenced ID(s) — e.g. another order/circular number this document " +
        "cites. BM25 matched against referenced_ids.",
    }),
    entities: Type.Optional({
      ...StringOrList,
      description:
        "Entity name(s) — companies, persons, regulators mentioned. BM25 " +
        "matched against entities_involved (e.g. 'HBN Dairies', 'SEBI', " +
        "'Rajat Gupta').",
    }),
    dateFrom: Type.Optional(
      Type.String({
        description:
          "Lower bound on document_date (inclusive). ISO-like string, e.g. " +
          "'2024-01-01' or '2024-09-23'.",
        minLength: 4,
        maxLength: 32,
      }),
    ),
    dateTo: Type.Optional(
      Type.String({
        description:
          "Upper bound on document_date (inclusive). Same format as dateFrom.",
        minLength: 4,
        maxLength: 32,
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: `Max hits to return (1-${String(MAX_LIMIT)}). Default ${String(DEFAULT_LIMIT)}.`,
        minimum: 1,
        maximum: MAX_LIMIT,
      }),
    ),
    query: Type.Optional(
      Type.String({
        description:
          "Optional free-text topical query — used to RANK within the " +
          "metadata-filtered set via the title_boosted_hybrid profile. " +
          "Provide 2-8 keywords that describe what the user is asking about " +
          "(NOT another ID; IDs go in the structured filters above). When " +
          "omitted, results are returned in arbitrary order within the " +
          "filtered set.",
        minLength: 2,
        maxLength: 200,
      }),
    ),
  },
  { additionalProperties: false },
)

type Params = {
  documentId?: string | string[]
  pan?: string | string[]
  references?: string | string[]
  entities?: string | string[]
  dateFrom?: string
  dateTo?: string
  limit?: number
  query?: string
}

// ─── YQL building ───────────────────────────────────────────────────────────

const asList = (v: string | string[]): string[] =>
  Array.isArray(v) ? v : [v]

/** Vespa YQL needs double-quoted string literals with backslash + dquote
 *  escapes. Strip anything that would close the literal early. */
const yqlString = (s: string): string =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

const inClause = (field: string, values: readonly string[]): string =>
  `${field} in (${values.map(yqlString).join(", ")})`

const containsAnyClause = (field: string, values: readonly string[]): string =>
  `(${values.map((v) => `${field} contains ${yqlString(v)}`).join(" or ")})`

// document_date is a `long` in the schema, encoded as YYYYMMDD (e.g.
// "2025-12-01" → 20251201). Vespa YQL range ops (>=, <=) are numeric-only,
// so a string date like "2025-12-01" parses as "[2025-12-01;]" and Vespa
// rejects it. Convert ISO/looser inputs to that int form; for partial inputs
// pad to the inclusive lower/upper bound of the implied period.
const isoDateToInt = (input: string, bound: "lower" | "upper"): number | null => {
  const s = input.trim()
  // YYYY, YYYY-MM, YYYY-MM-DD (or compact YYYYMMDD)
  const compact = s.replace(/-/g, "")
  if (!/^\d{4}(\d{2})?(\d{2})?$/.test(compact)) return null
  const year = compact.slice(0, 4)
  const mm =
    compact.length >= 6
      ? compact.slice(4, 6)
      : bound === "lower"
        ? "01"
        : "12"
  const dd =
    compact.length === 8
      ? compact.slice(6, 8)
      : bound === "lower"
        ? "01"
        : "31"
  const n = Number(`${year}${mm}${dd}`)
  return Number.isFinite(n) ? n : null
}

// Render YYYYMMDD int back to "YYYY-MM-DD" for the agent-facing output.
const intDateToIso = (n: number): string | null => {
  if (!Number.isFinite(n)) return null
  const s = String(n).padStart(8, "0")
  if (s.length !== 8) return null
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

/** Build the WHERE expression. At least one filter is required (the tool
 *  refuses to run otherwise — Vespa-wide unfiltered scans are wasteful and
 *  the agent should be more specific). */
const buildWhere = (p: Params, scope: AgentScope | undefined): string => {
  const clauses: string[] = []

  if (p.documentId) {
    clauses.push(inClause("document_id", asList(p.documentId)))
  }
  if (p.pan) {
    clauses.push(inClause("pan_ids", asList(p.pan)))
  }
  if (p.references) {
    // referenced_ids is BM25-indexed text — use `contains` so multi-word IDs
    // still hit even if tokenized.
    clauses.push(containsAnyClause("referenced_ids", asList(p.references)))
  }
  if (p.entities) {
    clauses.push(containsAnyClause("entities_involved", asList(p.entities)))
  }
  if (p.dateFrom) {
    const lo = isoDateToInt(p.dateFrom, "lower")
    if (lo === null) {
      throw new Error(
        `dateFrom: could not parse "${p.dateFrom}" — use YYYY, YYYY-MM, or YYYY-MM-DD`,
      )
    }
    clauses.push(`document_date >= ${String(lo)}`)
  }
  if (p.dateTo) {
    const hi = isoDateToInt(p.dateTo, "upper")
    if (hi === null) {
      throw new Error(
        `dateTo: could not parse "${p.dateTo}" — use YYYY, YYYY-MM, or YYYY-MM-DD`,
      )
    }
    clauses.push(`document_date <= ${String(hi)}`)
  }

  // Agent scope narrowing — if the agent's KB scope is set via cl- / clfd- /
  // clf- prefixes, narrow to those collections. Same shape vespa-ts uses
  // internally for searchVespaAgent; we replicate it inline since we're
  // bypassing the wrapper.
  if (scope?.collectionSelections.length) {
    const ids: string[] = []
    const folderIds: string[] = []
    const fileIds: string[] = []
    for (const s of scope.collectionSelections) {
      if (s.collectionIds?.length) ids.push(...s.collectionIds)
      if (s.collectionFolderIds?.length) folderIds.push(...s.collectionFolderIds)
      if (s.collectionFileIds?.length) fileIds.push(...s.collectionFileIds)
    }
    const scopeClauses: string[] = []
    if (ids.length) scopeClauses.push(inClause("clId", ids))
    if (folderIds.length) scopeClauses.push(inClause("clFd", folderIds))
    if (fileIds.length) scopeClauses.push(inClause("docId", fileIds))
    if (scopeClauses.length) {
      clauses.push(`(${scopeClauses.join(" or ")})`)
    }
  }

  if (clauses.length === 0) {
    throw new Error("at least one metadata filter is required")
  }
  return clauses.join(" and ")
}

// ─── Vespa transport ────────────────────────────────────────────────────────

type VespaSearchResponse = {
  root?: {
    children?: Array<{
      relevance?: number
      fields?: Record<string, unknown>
    }>
  }
}

/** POST a YQL query to the Vespa query endpoint. We don't go through
 *  vespa-ts because the metadata fields it doesn't yet model would need a
 *  wrapper change there; a direct HTTP call is simpler and keeps the
 *  responsibility for these fields local to this tool. */
const runYql = async (
  yql: string,
  limit: number,
  query: string | undefined,
): Promise<VespaSearchResponse> => {
  const endpoint = `${config.vespaEndpoint.queryEndpoint}/search/`
  // When the LLM passes a topical `query` alongside the structured filters,
  // the YQL we built includes `userInput(@query)`; we rank that filtered set
  // with `title_boosted_hybrid` (filename + chunks native-rank). When no
  // query is provided, we fall back to `unranked` — the WHERE clause has
  // already done the work, ordering doesn't matter.
  const body: Record<string, unknown> = {
    yql,
    hits: limit,
    timeout: "30s",
  }
  if (query && query.trim()) {
    body["query"] = query
    body["ranking.profile"] = "title_boosted_hybrid"
    // alpha=0 keeps this lexical-only; the metadata filter has already
    // narrowed candidates, vector retrieval inside the filter buys nothing
    // (and requires an embedding call we don't want on this code path).
    body["input.query(alpha)"] = 0
  } else {
    body["ranking"] = "unranked"
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`vespa HTTP ${String(res.status)}: ${body.slice(0, 240)}`)
  }
  return (await res.json()) as VespaSearchResponse
}

// ─── Tool ───────────────────────────────────────────────────────────────────

type ToolArgs = {
  logger: Log
  agentScope?: AgentScope
}

export const buildMetadataSearchTool = (
  args: ToolArgs,
): ReturnType<typeof defineTool> =>
  defineTool({
    name: "metadataSearch",
    label: "SEBI metadata search",
    description: DESCRIPTION,
    promptSnippet:
      "Use `metadataSearch` when the user names a concrete PAN, document_id, " +
      "entity, referenced ID, or date range — exact lookups, not topic search.",
    parameters: params,
    async execute(toolCallId, raw) {
      const p = raw as Params
      const log = args.logger.child({
        toolName: "metadataSearch",
        toolCallId,
      })
      const startedAt = Date.now()
      const limit = Math.min(Math.max(p.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)

      let where: string
      try {
        where = buildWhere(p, args.agentScope)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.info({ err: msg }, "tool: metadataSearch refused (no filters)")
        return textResult(`metadataSearch refused: ${msg}`, { error: msg }, true)
      }

      // When the LLM also passes a topical `query`, we OR-conjoin a
      // `userInput(@query)` term inside the WHERE clause so the rank profile
      // (`title_boosted_hybrid`, set in runYql) has terms to score
      // nativeRank(fileName) / nativeRank(chunks) against. The metadata
      // filter still applies AS THE GATE — userInput() is added as an
      // additional ANDed clause, not a replacement.
      const yqlWhere =
        p.query && p.query.trim()
          ? `(${where}) and userInput(@query)`
          : where
      const yql = `select * from kb_items where ${yqlWhere} limit ${String(limit)}`
      log.info(
        {
          limit,
          agentScoped: !!args.agentScope,
          filters: {
            documentId: p.documentId,
            pan: p.pan,
            references: p.references,
            entities: p.entities,
            dateFrom: p.dateFrom,
            dateTo: p.dateTo,
          },
        },
        "tool: metadataSearch start",
      )

      try {
        const resp = await runYql(yql, limit, p.query)
        const children = resp.root?.children ?? []
        if (children.length === 0) {
          log.info(
            { hits: 0, durationMs: Date.now() - startedAt },
            "tool: metadataSearch done (empty)",
          )
          return textResult(
            `<metadata_results hits="0"/>`,
            { hits: 0, filters: p },
          )
        }

        const lines: string[] = [
          `<metadata_results hits="${String(children.length)}">`,
        ]
        const details: Array<{
          rank: number
          docId: string
          documentId: string | null
          documentDate: string | null
          entities: string[]
          panIds: string[]
          referencedIds: string[]
          fileName: string | null
        }> = []

        children.forEach((hit, i) => {
          const rank = i + 1
          const fields = (hit.fields ?? {}) as Record<string, unknown>
          const docId = typeof fields["docId"] === "string" ? fields["docId"] : ""
          const fileName = fields["fileName"] as string | undefined
          const title = titleOf({
            title: fields["title"] as string | undefined,
            fileName: fileName,
            docId,
          })
          const documentId =
            typeof fields["document_id"] === "string"
              ? (fields["document_id"] as string)
              : null
          // document_date is now a `long` (YYYYMMDD) in the schema. Older
          // dumps that still return a string are tolerated for the transition.
          const rawDate = fields["document_date"]
          const documentDate =
            typeof rawDate === "number"
              ? intDateToIso(rawDate)
              : typeof rawDate === "string"
                ? rawDate
                : null
          const entities = Array.isArray(fields["entities_involved"])
            ? (fields["entities_involved"] as unknown[]).filter(
                (s): s is string => typeof s === "string",
              )
            : []
          const panIds = Array.isArray(fields["pan_ids"])
            ? (fields["pan_ids"] as unknown[]).filter(
                (s): s is string => typeof s === "string",
              )
            : []
          const referencedIds = Array.isArray(fields["referenced_ids"])
            ? (fields["referenced_ids"] as unknown[]).filter(
                (s): s is string => typeof s === "string",
              )
            : []

          // Best-effort snippets from the top chunks (when present) so the
          // agent sees what the document actually says, not just metadata.
          // With ranking=unranked there's no chunk_scores so `topChunks` is
          // empty and no <chunk> blocks render.
          const topChunks = topChunkIndices(fields, TOP_CHUNKS_PER_DOC)
          const chunksMap = fields["chunks_map"] as
            | Array<{ chunk_index: number; page_numbers?: number[] }>
            | undefined
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
            `  <hit rank="${String(rank)}" docId=${JSON.stringify(docId)}` +
              (documentId ? ` document_id=${JSON.stringify(documentId)}` : "") +
              (documentDate ? ` document_date=${JSON.stringify(documentDate)}` : "") +
              `>`,
          )
          lines.push(`    <title>${title}</title>`)
          if (entities.length) {
            lines.push(
              `    <entities>${entities.join(" | ")}</entities>`,
            )
          }
          if (panIds.length) {
            lines.push(`    <pan_ids>${panIds.join(", ")}</pan_ids>`)
          }
          if (referencedIds.length) {
            lines.push(
              `    <references>${referencedIds.join(", ")}</references>`,
            )
          }
          for (const c of renderedChunks) {
            lines.push(
              `    <chunk chunk_index="${String(c.index)}" ` +
                `score="${c.score.toFixed(4)}"` +
                `${c.pages ? ` pages="${c.pages}"` : ""}>` +
                `${truncate(c.snippet)}</chunk>`,
            )
          }
          lines.push(`  </hit>`)

          details.push({
            rank,
            docId,
            fileName : fileName ?? null,
            documentId,
            documentDate,
            entities,
            panIds,
            referencedIds,
          })
        })

        lines.push(`</metadata_results>`)
        lines.push(
          `\nNext steps: use \`getChunks\` with a docId to read full text, or ` +
            `\`vespaSearch\` if you need topic-level recall around these hits.`,
        )

        log.info(
          {
            hits: details.length,
            topDocId: details[0]?.docId,
            durationMs: Date.now() - startedAt,
          },
          "tool: metadataSearch done",
        )
        return textResult(lines.join("\n"), {
          hits: details,
          filters: p,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(
          { err, durationMs: Date.now() - startedAt },
          "tool: metadataSearch failed",
        )
        return textResult(`metadataSearch failed: ${msg}`, { error: msg }, true)
      }
    },
  })
