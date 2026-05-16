/* eslint-disable @typescript-eslint/naming-convention --
 * Vespa schema uses snake_case (chunk_scores, chunks_summary, etc.); we mirror
 * the on-the-wire field names. */
// Shared helpers for the SEBI Vespa tools.

import { getTracer } from "@/tracer"
import type { Span } from "@/tracer"

// Vespa helpers want a real Span object (not a duck-typed stub). Use xyne's
// in-process tracer to mint one — it's the same primitive xyne's production
// search uses. Each call yields a fresh span scoped to the tool invocation.
export const newSpan = (name: string): Span =>
  getTracer("backendv2-tools").startSpan(name)

export type ToolReturn = {
  content: { type: "text"; text: string }[]
  details: unknown
  isError?: boolean
}

export const textResult = (
  text: string,
  details: unknown = {},
  isError = false,
): ToolReturn => ({
  content: [{ type: "text", text }],
  details,
  ...(isError ? { isError: true } : {}),
})

// Truncate long snippet text to keep tool outputs under control. The agent
// can call getChunks for full content when needed.
export const SNIPPET_CHARS = 800

export const truncate = (s: string, max = SNIPPET_CHARS): string => {
  if (s.length <= max) {
    return s
  }
  return `${s.slice(0, max - 1)}…`
}

// Extract a chunk's representative page range. Vespa stores chunks with a
// 0-indexed `chunk_index` and a `page_numbers` array. We render as "1-3" or
// "1,2,5" so the agent can cross-reference against citations.
export const formatPages = (pageNumbers: number[] | undefined): string => {
  if (!pageNumbers || pageNumbers.length === 0) {
    return ""
  }
  // Detect contiguous range
  const sorted = [...pageNumbers].sort((a, b) => a - b)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (
    first !== undefined &&
    last !== undefined &&
    last - first === sorted.length - 1
  ) {
    return first === last ? String(first) : `${String(first)}-${String(last)}`
  }
  return sorted.join(",")
}

// Best-effort title resolution for a KB hit. Falls back to fileName, then docId.
export const titleOf = (fields: {
  title?: string | undefined
  fileName?: string | undefined
  docId?: string | undefined
}): string => {
  return (
    (fields.title?.trim() ?? "") ||
    (fields.fileName?.trim() ?? "") ||
    (fields.docId ?? "Unknown document")
  )
}

// Extract the chunk_index of the top-scoring chunk from a hit's
// `matchfeatures.chunk_scores.cells` map. Vespa returns scores keyed by
// chunk index as a string; we sort descending and return the winning index.
// Returns null when the map is missing or empty.
export const topChunkIndex = (
  fields: Record<string, unknown>,
): number | null => {
  const mf = fields["matchfeatures"] as
    | { chunk_scores?: { cells?: Record<string, number> } }
    | undefined
  const cells = mf?.chunk_scores?.cells
  if (!cells) {
    return null
  }
  let bestIdx: number | null = null
  let bestScore = -Infinity
  for (const [k, v] of Object.entries(cells)) {
    if (typeof v !== "number") {
      continue
    }
    const idx = Number(k)
    if (Number.isFinite(idx) && v > bestScore) {
      bestScore = v
      bestIdx = idx
    }
  }
  return bestIdx
}

// Given a chunk_index, find the matching snippet text in chunks_summary.
// Tries two paths:
//   1) `chunks_pos_summary[i] === chunkIndex` — chunks_summary[i] is the text
//   2) Fall back to `chunks_summary[chunkIndex]` (works when the array is the
//      full document with sequential indices).
// Returns "" if neither works.
export const snippetForChunk = (
  fields: Record<string, unknown>,
  chunkIndex: number,
): string => {
  const summary = fields["chunks_summary"]
  if (!Array.isArray(summary)) {
    return ""
  }
  const positions = fields["chunks_pos_summary"]
  if (Array.isArray(positions)) {
    const at = positions.indexOf(chunkIndex)
    if (at >= 0) {
      const v: unknown = summary[at]
      if (typeof v === "string") {
        return v
      }
      if (v && typeof v === "object") {
        const obj = v as { chunk?: string }
        return obj.chunk ?? ""
      }
    }
  }
  const fallback: unknown = summary[chunkIndex]
  if (typeof fallback === "string") {
    return fallback
  }
  if (fallback && typeof fallback === "object") {
    const obj = fallback as { chunk?: string }
    return obj.chunk ?? ""
  }
  return ""
}
