/* eslint-disable @typescript-eslint/naming-convention --
 * Vespa schema uses snake_case fields (chunk_index, page_numbers, block_labels);
 * we mirror them in the tool's output / details for consistency with what the
 * agent sees from `vespaSearch`. */
// getChunks — paginate through a document's chunks by docId + chunk index.
//
// Returns up to 50 consecutive chunks starting at `startChunkIndex`. The
// agent uses this to read context around a hit from `vespaSearch`, or to
// scan a whole document in chunks (paginate by bumping startChunkIndex by
// the previous limit).

import { defineTool } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"

import { GetDocumentsByDocIds } from "@/search/vespa"

import type { Log } from "../../../log"
import {
  formatPages,
  newSpan,
  textResult,
  titleOf,
} from "./util"

const MAX_LIMIT = 30

const DESCRIPTION = [
  "Read a contiguous range of chunks from a specific SEBI document, given ",
  "its `docId` (from `vespaSearch`). Returns up to 50 chunks starting at ",
  "`startChunkIndex`. Use this AFTER `vespaSearch` to read the full surrounding ",
  "context — semantic search only returns the best-matching chunks, but ",
  "regulatory answers usually need surrounding language, definitions, and ",
  "cross-references. Call repeatedly with bumped `startChunkIndex` to walk ",
  "through long documents in pages.",
].join("")

const params = Type.Object({
  docId: Type.String({
    description: "The Vespa document ID (from a `vespaSearch` hit).",
    minLength: 1,
  }),
  startChunkIndex: Type.Number({
    description:
      "0-based chunk index to start at. Use the `chunk_index` from a " +
      "`vespaSearch` hit, then back up by 1–2 for surrounding context.",
    minimum: 0,
  }),
  limit: Type.Optional(
    Type.Number({
      description: `Number of chunks to return (1–${String(MAX_LIMIT)}). Default 15.`,
      minimum: 1,
      maximum: MAX_LIMIT,
    }),
  ),
})

export const buildGetChunksTool = (
  parentLogger: Log,
): ReturnType<typeof defineTool> =>
  defineTool({
    name: "getChunks",
    label: "Read document chunks",
    description: DESCRIPTION,
    promptSnippet:
      "Use `getChunks` to read full context around a `vespaSearch` hit, or " +
      "to walk through a document in pages.",
    parameters: params,
    async execute(toolCallId, p) {
      const log = parentLogger.child({ toolName: "getChunks", toolCallId })
      const startedAt = Date.now()
      log.info(
        {
          docId: p.docId,
          startChunkIndex: p.startChunkIndex,
          limit: p.limit ?? 15,
        },
        "tool: getChunks start",
      )
      const limit = Math.min(p.limit ?? 15, MAX_LIMIT)
      try {
        const resp = await GetDocumentsByDocIds(
          [p.docId],
          newSpan("getChunks"),
        )
        const doc = resp?.root?.children?.[0]
        if (!doc) {
          return textResult(
            `No document found with docId ${JSON.stringify(p.docId)}.`,
            { error: "not_found" },
            true,
          )
        }
        const fields = (doc.fields ?? {}) as Record<string, unknown>
        // KB-style schemas store full chunk text under either `chunks` or
        // `chunks_summary` (the SEBI ingestion uses the latter). Either is
        // an array — of strings, or of `{chunk, index}` objects. Coerce to
        // string[] indexed by chunk position.
        const rawChunks = fields["chunks"] ?? fields["chunks_summary"]
        if (!Array.isArray(rawChunks) || rawChunks.length === 0) {
          return textResult(
            `Document ${JSON.stringify(p.docId)} has no chunks.`,
            { docId: p.docId, total_chunks: 0 },
          )
        }
        const allChunks: string[] = rawChunks.map((c): string => {
          if (typeof c === "string") {
            return c
          }
          if (c && typeof c === "object") {
            const obj = c as { chunk?: string; text?: string }
            return obj.chunk ?? obj.text ?? ""
          }
          return ""
        })
        const total = allChunks.length
        if (p.startChunkIndex >= total) {
          return textResult(
            `startChunkIndex ${String(p.startChunkIndex)} is past the end of the document (total chunks: ${String(total)}).`,
            { docId: p.docId, total_chunks: total },
            true,
          )
        }
        const end = Math.min(p.startChunkIndex + limit, total)
        const slice = allChunks.slice(p.startChunkIndex, end)

        const chunksMap = (fields["chunks_map"] ?? []) as Array<{
          chunk_index: number
          page_numbers?: number[]
          block_labels?: string[]
        }>
        const mapByIndex = new Map(chunksMap.map((m) => [m.chunk_index, m]))

        const title = titleOf({
          title: fields["title"] as string | undefined,
          fileName: fields["fileName"] as string | undefined,
          docId: p.docId,
        })

        const lines: string[] = []
        lines.push(
          `<chunks docId=${JSON.stringify(p.docId)} start="${String(p.startChunkIndex)}" ` +
            `end="${String(end - 1)}" returned="${String(slice.length)}" ` +
            `total_chunks="${String(total)}">`,
        )
        lines.push(`  <title>${title}</title>`)
        slice.forEach((raw, i) => {
          const idx = p.startChunkIndex + i
          const meta = mapByIndex.get(idx)
          const pages = formatPages(meta?.page_numbers)
          const labels = meta?.block_labels?.join(",") ?? ""
          // Strip the "[Page N]" prefix the ingestion adds — it's redundant
          // with the explicit `pages` attribute.
          const cleaned = String(raw).replace(/^\[Page \d+(-\d+)?\]\s*/, "")
          // `cite` is the ready-made citation string the system prompt's
          // "copy, don't construct" rule tells the model to emit verbatim.
          // Mirror the same attribute on search / metadataSearch chunks.
          lines.push(
            `  <chunk index="${String(idx)}"${pages ? ` pages="${pages}"` : ""}${labels ? ` labels=${JSON.stringify(labels)}` : ""} cite="[${p.docId}#${String(idx)}]">`,
          )
          lines.push(`    ${cleaned}`)
          lines.push(`  </chunk>`)
        })
        const hasMore = end < total
        lines.push(`</chunks>`)
        if (hasMore) {
          lines.push(
            `\nMore chunks available. Call \`getChunks\` again with ` +
              `startChunkIndex=${String(end)} to continue from chunk ${String(end)}/${String(total - 1)}.`,
          )
        } else {
          lines.push(`\nReached end of document.`)
        }

        log.info(
          {
            returned: slice.length,
            total_chunks: total,
            has_more: hasMore,
            durationMs: Date.now() - startedAt,
          },
          "tool: getChunks done",
        )
        return textResult(lines.join("\n"), {
          docId: p.docId,
          startChunkIndex: p.startChunkIndex,
          returned: slice.length,
          total_chunks: total,
          has_more: hasMore,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(
          { err, docId: p.docId, durationMs: Date.now() - startedAt },
          "tool: getChunks failed",
        )
        return textResult(`getChunks failed: ${msg}`, { error: msg }, true)
      }
    },
  })
