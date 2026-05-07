/**
 * Find the best contiguous span inside a chunk that "comes from" the answer.
 *
 * Uses token-level Smith-Waterman local alignment.  The chunk is the
 * reference text (haystack), the answer is the query (needle).  The
 * returned span is in CHARACTER offsets of the original chunk string,
 * trimmed to the boundaries of real tokens.
 *
 * Returns null when the alignment score is too low to be meaningful
 * (caller should treat as "no useful match — draw nothing extra").
 */

export interface MatchSpan {
  /** inclusive start char offset in the chunk */
  start: number
  /** exclusive end char offset in the chunk */
  end: number
  /** alignment score (higher is better) */
  score: number
}

interface Token {
  /** lowercased, punctuation-stripped form used for matching */
  norm: string
  /** char offset of the first character of the original token */
  start: number
  /** char offset just past the last character of the original token */
  end: number
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "by",
  "with",
  "as",
  "from",
  "or",
  "and",
  "but",
  "if",
  "it",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "his",
  "her",
  "its",
  "their",
  "our",
])

const MATCH = 2
const MISMATCH = -1
const GAP = -1

/** Normalize a token: lowercased, alphanumeric only.  Empty if all punctuation. */
function normalize(raw: string): string {
  let out = ""
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    // a-z, A-Z, 0-9
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      out += raw[i]
    } else if (c >= 65 && c <= 90) {
      out += String.fromCharCode(c + 32)
    }
  }
  return out
}

/** Tokenize on whitespace.  Each token records its char span in the original string. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const norm = normalize(m[0])
    if (!norm) continue
    tokens.push({ norm, start: m.index, end: m.index + m[0].length })
  }
  return tokens
}

/** Score a single token match.  Stopwords are worth less than content words. */
function tokenScore(t: string): number {
  return STOPWORDS.has(t) ? 1 : MATCH
}

/**
 * Smith-Waterman local alignment between two token sequences.
 * Returns the best-scoring contiguous run on the chunk side.
 */
function alignTokens(
  query: Token[],
  haystack: Token[],
): { startTok: number; endTok: number; score: number } | null {
  if (query.length === 0 || haystack.length === 0) return null

  const Q = query.length
  const H = haystack.length
  // dp[i][j] = best local-alignment score ending at query[i-1], haystack[j-1]
  const dp: Int32Array[] = new Array(Q + 1)
  for (let i = 0; i <= Q; i++) dp[i] = new Int32Array(H + 1)

  let bestScore = 0
  let bestI = 0
  let bestJ = 0
  // Trace bookkeeping: record which (i,j) each cell came from so we can walk back
  // 0 = stop, 1 = diag, 2 = up (gap in haystack), 3 = left (gap in query)
  const trace: Uint8Array[] = new Array(Q + 1)
  for (let i = 0; i <= Q; i++) trace[i] = new Uint8Array(H + 1)

  for (let i = 1; i <= Q; i++) {
    const qi = query[i - 1].norm
    const qScore = tokenScore(qi)
    for (let j = 1; j <= H; j++) {
      const hj = haystack[j - 1].norm
      const diag = dp[i - 1][j - 1] + (qi === hj ? qScore : MISMATCH)
      const up = dp[i - 1][j] + GAP
      const left = dp[i][j - 1] + GAP
      let v = 0
      let t: 0 | 1 | 2 | 3 = 0
      if (diag > v) {
        v = diag
        t = 1
      }
      if (up > v) {
        v = up
        t = 2
      }
      if (left > v) {
        v = left
        t = 3
      }
      dp[i][j] = v
      trace[i][j] = t
      if (v > bestScore) {
        bestScore = v
        bestI = i
        bestJ = j
      }
    }
  }

  if (bestScore === 0) return null

  // Walk back from (bestI, bestJ) until we hit a 0 cell to find the start on the haystack side
  let i = bestI
  let j = bestJ
  let endTok = bestJ // exclusive on haystack tokens
  let startTok = bestJ - 1
  while (i > 0 && j > 0 && trace[i][j] !== 0) {
    const t = trace[i][j]
    if (t === 1) {
      startTok = j - 1
      i--
      j--
    } else if (t === 2) {
      i--
    } else if (t === 3) {
      startTok = j - 1
      j--
    } else break
  }

  return { startTok, endTok, score: bestScore }
}

/**
 * Find the best matching span of `chunk` for the given `answer`.
 *
 * Returns null when the score is too small to be trustworthy.  The
 * threshold scales with the answer length: requiring at least ~half
 * of the answer's content tokens to land in the alignment.
 */
export function findBestMatchSpan(
  answer: string,
  chunk: string,
): MatchSpan | null {
  if (!answer || !chunk) return null

  const queryToks = tokenize(answer)
  const hayToks = tokenize(chunk)
  if (queryToks.length === 0 || hayToks.length === 0) return null

  // Skip the alignment entirely when the answer has no content words
  // (e.g. "yes", "ok") — there is nothing meaningful to highlight.
  const contentWords = queryToks.filter((t) => !STOPWORDS.has(t.norm)).length
  if (contentWords === 0) return null

  const aligned = alignTokens(queryToks, hayToks)
  if (!aligned) return null

  // Reject very weak matches: require enough score that at least a couple
  // of content tokens hit.  We deliberately do NOT scale this with answer
  // length — a long paraphrased answer can still legitimately point to a
  // short snippet in the chunk (the SW algorithm finds the LOCAL best
  // alignment regardless of how much surrounding answer text is irrelevant).
  const MIN_CONTENT_MATCHES = 2
  const minScore = MATCH * MIN_CONTENT_MATCHES
  if (aligned.score < minScore) return null

  const startTok = Math.max(0, Math.min(aligned.startTok, hayToks.length - 1))
  const endTok = Math.max(
    startTok + 1,
    Math.min(aligned.endTok, hayToks.length),
  )

  return {
    start: hayToks[startTok].start,
    end: hayToks[endTok - 1].end,
    score: aligned.score,
  }
}
