/* eslint-disable @typescript-eslint/naming-convention --
 * Vespa schema uses snake_case fields (chunk_index, page_numbers); mirrored
 * in the tool's output. */
// searchWithinDoc — semantic search constrained to a single SEBI document.
//
// Wraps xyne's `searchCollectionRAG`, which searches the KB schema and supports
// filtering to specific docIds. Use after `vespaSearch` identifies a relevant
// document, when you need to find OTHER passages in that document related to a
// different aspect of the question.
//
// NOTE: SEBI docs live in `KbItemsSchema`, not `FileSchema`, so we must NOT use
// `searchVespaInFiles` here — that path always returns 0 hits for KB docs.

import { defineTool } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"

import { searchCollectionRAG } from "@/search/vespa"

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
  "Semantic search within a single SEBI document. Given a `docId` (from a ",
  "`vespaSearch` hit) and a focused `query`, returns the most relevant chunks ",
  "from that document only. Use when you need to find related passages, ",
  "definitions, exceptions, or cross-references inside the same document ",
  "without re-searching the whole corpus.",
].join("")

const params = Type.Object({
  docId: Type.String({
    description: "The Vespa document ID to constrain the search to.",
    minLength: 1,
  }),
  query: Type.String({
    description:
      "Search query within the document — short keyword-style phrasing " +
      "(e.g., 'definition of qualified institutional buyer').",
    minLength: 2,
    maxLength: 200,
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum matching chunks to return (1–30). Default 15.",
      minimum: 1,
      maximum: 30,
    }),
  ),
})

export const buildSearchWithinDocTool = (
  _userEmail: string,
  parentLogger: Log,
): ReturnType<typeof defineTool> =>
  defineTool({
    name: "searchWithinDoc",
    label: "Search within a SEBI document",
    description: DESCRIPTION,
    promptSnippet:
      "Use `searchWithinDoc` to find specific passages inside a known SEBI " +
      "document without re-querying the full corpus.",
    parameters: params,
    async execute(toolCallId, p) {
      const log = parentLogger.child({
        toolName: "searchWithinDoc",
        toolCallId,
      })
      const startedAt = Date.now()
      log.info(
        { docId: p.docId, query: p.query, limit: p.limit ?? 15 },
        "tool: searchWithinDoc start",
      )
      const limit = p.limit ?? 15
      try {
        // KB items don't enforce per-user permissions, so userEmail isn't
        // needed here — the schema is filtered by docId only.
        const resp = await searchCollectionRAG(p.query, [p.docId], undefined, limit)
        const children = resp?.root?.children ?? []
        if (children.length === 0) {
          log.info(
            { hits: 0, durationMs: Date.now() - startedAt },
            "tool: searchWithinDoc done (empty)",
          )
          return textResult(
            `<doc_search docId=${JSON.stringify(p.docId)} query=${JSON.stringify(p.query)} hits="0"/>`,
            { hits: 0, docId: p.docId, query: p.query },
          )
        }

        const lines: string[] = []
        lines.push(
          `<doc_search docId=${JSON.stringify(p.docId)} query=${JSON.stringify(p.query)} hits="${String(children.length)}">`,
        )
        const details: Array<{
          rank: number
          chunkIndex: number | null
          score: number
        }> = []

        children.forEach((hit, i) => {
          const rank = i + 1
          const fields = (hit?.fields ?? {}) as Record<string, unknown>
          const score = typeof hit?.relevance === "number" ? hit.relevance : 0
          const title = titleOf({
            title: fields["title"] as string | undefined,
            fileName: fields["fileName"] as string | undefined,
            docId: p.docId,
          })

          const chunkIndex = topChunkIndex(fields)
          const snippet =
            chunkIndex !== null ? snippetForChunk(fields, chunkIndex) : ""

          let pages = ""
          const chunksMap = fields["chunks_map"]
          if (Array.isArray(chunksMap) && chunkIndex !== null) {
            const entry = (chunksMap as Array<{
              chunk_index: number
              page_numbers?: number[]
            }>).find((m) => m.chunk_index === chunkIndex)
            pages = formatPages(entry?.page_numbers)
          }

          if (i === 0) {
            lines.push(`  <title>${title}</title>`)
          }
          lines.push(
            `  <hit rank="${String(rank)}" chunk_index="${chunkIndex === null ? "" : String(chunkIndex)}" ` +
              `score="${score.toFixed(4)}"${pages ? ` pages="${pages}"` : ""}>`,
          )
          if (snippet) {
            lines.push(`    <snippet>${truncate(snippet)}</snippet>`)
          }
          lines.push(`  </hit>`)
          details.push({ rank, chunkIndex, score })
        })

        lines.push(`</doc_search>`)
        lines.push(
          `\nFollow up with \`getChunks\` on the same docId using the ` +
            `\`chunk_index\` of the most relevant hit to read full context.`,
        )

        log.info(
          {
            hits: details.length,
            topChunkIndex: details[0]?.chunkIndex,
            durationMs: Date.now() - startedAt,
          },
          "tool: searchWithinDoc done",
        )
        return textResult(lines.join("\n"), {
          docId: p.docId,
          query: p.query,
          hits: details,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(
          { err, docId: p.docId, query: p.query, durationMs: Date.now() - startedAt },
          "tool: searchWithinDoc failed",
        )
        return textResult(`searchWithinDoc failed: ${msg}`, { error: msg }, true)
      }
    },
  })
