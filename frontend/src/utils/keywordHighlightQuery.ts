import type { Citation } from "@/components/CitationLink"

const CLAUSE_BEFORE_MARKER_MAX_LEN = 250

/** True if string has at least one letter or number (not punctuation-only like ","). */
function hasLettersOrDigits(s: string): boolean {
  return /\p{L}|\p{N}/u.test(s)
}

/** Strip markers / noise; collapse whitespace; cap length (tail = closest-to-citation context). */
function normalizeClauseForHighlightQuery(s: string): string {
  let t = s
    .trim()
    .replace(/[`]+/g, "")
    .replace(/\s*\[\d+_\d+\](\([^)]*\))?/g, "")
    .replace(/\s*\[\d+\](\([^)]*\))?/g, "")
    .replace(/\s*!\[image-citation:[^\]]+\]\([^)]*\)/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\u200b/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (t.length > CLAUSE_BEFORE_MARKER_MAX_LEN) {
    t = t.slice(-CLAUSE_BEFORE_MARKER_MAX_LEN)
  }
  return t
}

interface CitationSpan {
  start: number
  end: number
  inner: string
  raw: string
}

type FlatToken =
  | { type: "text"; start: number; end: number; value: string }
  | { type: "citation"; start: number; end: number; inner: string; raw: string }

type MessageSegment =
  | { type: "text"; value: string }
  | {
      type: "citationGroup"
      refs: string[]
      startFlat: number
      endFlat: number
    }

/**
 * Collect citation spans aligned with `processMessage` output:
 *   `[n_m](url)`, `[n_m]`, `[n](url)`, `[n]`, `![image-citation:key](…)`.
 * Span `end` includes optional markdown link destination so offsets inside `(url)` still resolve.
 */
function collectCitationSpans(message: string): CitationSpan[] {
  const raw: CitationSpan[] = []

  const push = (index: number, full: string, inner: string) => {
    raw.push({
      start: index,
      end: index + full.length,
      inner,
      raw: full,
    })
  }

  for (const m of message.matchAll(/!\[image-citation:([^\]]+)\]\([^)]*\)/g)) {
    push(m.index!, m[0], m[1])
  }

  for (const m of message.matchAll(/\[(\d+)_(\d+)\](\([^)]*\))?/g)) {
    push(m.index!, m[0], `${m[1]}_${m[2]}`)
  }

  for (const m of message.matchAll(/\[(\d+)\](\([^)]*\))?/g)) {
    push(m.index!, m[0], m[1])
  }

  raw.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: CitationSpan[] = []
  let coverEnd = -1
  for (const s of raw) {
    if (s.start < coverEnd) continue
    out.push(s)
    coverEnd = s.end
  }
  return out
}

function buildFlatTokens(message: string, spans: CitationSpan[]): FlatToken[] {
  const out: FlatToken[] = []
  let pos = 0
  for (const sp of spans) {
    if (sp.start > pos) {
      out.push({
        type: "text",
        start: pos,
        end: sp.start,
        value: message.slice(pos, sp.start),
      })
    }
    out.push({
      type: "citation",
      start: sp.start,
      end: sp.end,
      inner: sp.inner,
      raw: sp.raw,
    })
    pos = sp.end
  }
  if (pos < message.length) {
    out.push({
      type: "text",
      start: pos,
      end: message.length,
      value: message.slice(pos),
    })
  }
  return out
}

function flatToSegments(flat: FlatToken[]): MessageSegment[] {
  const segs: MessageSegment[] = []
  let i = 0
  while (i < flat.length) {
    const t = flat[i]
    if (t.type === "text") {
      segs.push({ type: "text", value: t.value })
      i++
    } else {
      const startFlat = i
      const refs: string[] = []
      while (i < flat.length && flat[i].type === "citation") {
        refs.push((flat[i] as Extract<FlatToken, { type: "citation" }>).inner)
        i++
      }
      segs.push({
        type: "citationGroup",
        refs,
        startFlat,
        endFlat: i,
      })
    }
  }
  return segs
}

function citationInnerMatchesClick(
  inner: string,
  citation: Citation,
  chunkIndex: number,
  citations: Citation[],
): boolean {
  const chunkStr = String(chunkIndex)
  const numeric = /^(\d+)_(\d+)$/.exec(inner)
  if (numeric) {
    const d = parseInt(numeric[1], 10)
    const c = parseInt(numeric[2], 10)
    if (c !== chunkIndex) return false
    const cited = citations[d - 1]
    if (!cited) return false
    return (
      cited.docId === citation.docId ||
      (!!citation.itemId &&
        cited.itemId !== undefined &&
        cited.itemId === citation.itemId)
    )
  }
  const keyed = /^(.*)_(\d+)$/.exec(inner)
  if (!keyed || keyed[2] !== chunkStr) return false
  const docKey = keyed[1]
  return (
    docKey === citation.docId ||
    (!!citation.itemId && docKey === citation.itemId)
  )
}

function parseCitationMarkdown(assistantMarkdownSource: string): {
  flat: FlatToken[]
  segments: MessageSegment[]
} {
  const spans = collectCitationSpans(assistantMarkdownSource)
  const flat = buildFlatTokens(assistantMarkdownSource, spans)
  const segments = flatToSegments(flat)
  return { flat, segments }
}

function findTargetFlatIndexFromOffset(
  flat: FlatToken[],
  sourceOffset: number,
  citation: Citation,
  chunkIndex: number,
  citations: Citation[],
): number {
  for (let i = 0; i < flat.length; i++) {
    const t = flat[i]
    if (t.type !== "citation") continue
    const inSpan =
      (sourceOffset >= t.start && sourceOffset < t.end) ||
      Math.abs(t.start - sourceOffset) <= 1
    if (
      inSpan &&
      citationInnerMatchesClick(t.inner, citation, chunkIndex, citations)
    ) {
      return i
    }
  }
  return -1
}

/**
 * Highlight query text for the citation pill the user clicked.
 * Pass the same markdown as MarkdownPreview (`processMessage` output) and
 * `node.position.start.offset` from the link — no separate occurrence index.
 */
export function extractSentenceAroundCitation(
  assistantMarkdownSource: string,
  citation: Citation,
  citations: Citation[],
  chunkIndex: number | undefined,
  /** From mdast/hast on the clicked `<a>` (react-markdown `passNode`). */
  sourceOffset?: number | null,
): string | null {
  if (chunkIndex === undefined || !assistantMarkdownSource?.trim()) {
    return null
  }

  const { flat, segments } = parseCitationMarkdown(assistantMarkdownSource)


  let targetFlat = -1
  if (sourceOffset != null && sourceOffset >= 0) {
    targetFlat = findTargetFlatIndexFromOffset(
      flat,
      sourceOffset,
      citation,
      chunkIndex,
      citations,
    )
  }

  if (targetFlat < 0) {
    return null
  }

  let targetSeg = -1
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si]
    if (seg.type !== "citationGroup") continue
    if (targetFlat >= seg.startFlat && targetFlat < seg.endFlat) {
      targetSeg = si
      break
    }
  }

  const textChunks: string[] = []
  if (targetSeg > 0) {
    for (let j = targetSeg - 1; j >= 0; j--) {
      const seg = segments[j]
      if (seg.type === "citationGroup") break
      if (seg.type === "text" && !hasLettersOrDigits(seg.value)) continue
      textChunks.unshift(seg.value)
      const joined = textChunks.join("")
      const norm = normalizeClauseForHighlightQuery(joined)
      if (norm.length > 0 && hasLettersOrDigits(norm)) {
        return norm
      }
    }
  }

  const prefixFromTokens = flat
    .slice(0, targetFlat)
    .filter((t): t is Extract<FlatToken, { type: "text" }> => t.type === "text")
    .map((t) => t.value)
    .join("")
  const wide = normalizeClauseForHighlightQuery(prefixFromTokens)
  if (wide.length > 0 && hasLettersOrDigits(wide)) {
    return wide
  }

  return null
}
