import type { XyneAgentState } from "../adapter"

// ─── Stop words ───────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "in",
  "of",
  "for",
  "to",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "can",
  "need",
  "ought",
  "shall",
  "with",
  "by",
  "from",
  "at",
  "on",
  "as",
  "or",
  "and",
  "but",
  "if",
  "then",
  "than",
  "so",
  "yet",
  "nor",
  "when",
  "where",
  "why",
  "how",
  "what",
  "who",
  "which",
  "whose",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
])

export function normalizeQuery(query: string): string {
  return query.toLowerCase().trim()
}

export function extractKeywords(query: string): string[] {
  const keywords: string[] = []
  const quotedRegex = /"([^"]+)"/g
  let match: RegExpExecArray | null

  // Extract quoted phrases as single keywords
  while ((match = quotedRegex.exec(query)) !== null) {
    const phrase = match[1].trim().toLowerCase()
    if (phrase.length > 0) {
      keywords.push(`"${phrase}"`)
    }
  }

  const withoutQuotes = query.replace(quotedRegex, " ")
  const words = withoutQuotes.split(/\s+/)

  for (const word of words) {
    const normalized = word.toLowerCase().trim()
    if (normalized.length > 0 && !STOP_WORDS.has(normalized)) {
      keywords.push(normalized)
    }
  }

  return keywords
}

interface KBFilterTarget {
  type?: string
  collectionId?: string
  folderId?: string
  fileId?: string
  path?: string
}

export function normalizeKBFilters(filters: unknown): string {
  const filtersObj = filters as { targets?: unknown[] } | undefined
  if (!filtersObj?.targets || filtersObj.targets.length === 0) {
    return ""
  }

  const toKey = (t: unknown): string => {
    const target = t as KBFilterTarget
    return `${target.type ?? ""}:${target.collectionId ?? ""}:${target.folderId ?? ""}:${target.fileId ?? ""}:${target.path ?? ""}`
  }

  const sortedTargets = [...filtersObj.targets].sort((a: unknown, b: unknown) =>
    toKey(a).localeCompare(toKey(b)),
  )

  return sortedTargets.map(toKey).join("|")
}

export function calculateKeywordOverlap(
  keywords1: string[],
  keywords2: string[],
): number {
  const set1 = new Set(keywords1)
  let overlap = 0
  for (const keyword of keywords2) {
    if (set1.has(keyword)) {
      overlap++
    }
  }
  return overlap
}

export function buildDedupSteerMessage(
  overlapPercentage: number,
  previousQuery: string,
  previousKeywords: string[],
): string {
  return `This search is ${overlapPercentage}% similar to a previous query: "${previousQuery}".

Before making the next search, reflect:
- What information have I already gathered?
- What is still missing?
- Can I narrow or redirect the search instead of repeating it?

Then choose ONE of these strategies:

1. Keyword Strategy
- Use NEW keywords (avoid: ${previousKeywords.join(", ")})
- Use synonyms or alternative terminology from retrieved documents
- Focus on a different aspect (cause, impact, exception, comparison)

2. Filter Strategy (HIGH VALUE)
- Narrow the search using filters:
  - specific file, folder, or collection
  - paths discovered via previous \`ls\` or results
- Target only the most relevant documents instead of broad search

3. Exploration Strategy
- Search a related concept not directly mentioned in the query
- Follow entities, definitions, or references found in previous results

Important:
- Do NOT rephrase the same query
- If relevant documents are already identified, prefer using filters over rewriting the query

The best next step may not be a new query — it may be a more precise search scope.`
}

export function trackSearchQuery(
  xyneState: Pick<XyneAgentState, "searchQueryHistory">,
  query: string,
  filters: unknown,
): void {
  const normalizedQuery = normalizeQuery(query)
  const keywords = extractKeywords(normalizedQuery)
  const normalizedFilters = normalizeKBFilters(filters)
  xyneState.searchQueryHistory.push({
    query,
    keywords,
    filters: normalizedFilters,
    timestamp: Date.now(),
  })
}
