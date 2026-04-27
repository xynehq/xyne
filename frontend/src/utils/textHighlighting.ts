import { removeStopwords } from 'stopword'

export interface HighlightMatch {
  startIndex: number
  endIndex: number
  length: number
}

export interface KeywordMatch extends HighlightMatch {
  type: "keyword"
}

export interface HighlightResult {
  success: boolean
  matches?: HighlightMatch[]
  message?: string
}

// Custom tokenization with regex and stopword removal using stopword library
export class TextTokenizer {
  public static tokenize(text: string, caseSensitive: boolean = false): string[] {
    const normalized = caseSensitive ? text : text.toLowerCase();
    
    // First, clean and split the text
    const words = normalized
      .replace(/[^\w\s]/g, ' ')  // Replace punctuation with spaces
      .split(/\s+/)
      .filter(word => word.length > 1); // Remove single characters and empty strings
    
    // Use stopword library to remove stopwords
    const filtered = removeStopwords(words);
    
    return filtered;
  }
}

// Efficient ordered window algorithm for finding minimum-length spans
class OrderedWindowFinder {
  public findMinimumWindow(tokenPositions: number[][]): { start: number; end: number } | null {
    if (tokenPositions.length === 0) {
      return null;
    }

    // Filter out tokens that have no occurrences
    const validTokenPositions = tokenPositions.filter(list => list.length > 0);
    const validTokenCount = validTokenPositions.length;
        
    if (validTokenCount === 0) {
      return null;
    }

    const merged: Array<{ pos: number, sentenceId: number }> = [];
    for (let sentenceId = 0; sentenceId < tokenPositions.length; sentenceId++) {
      if (tokenPositions[sentenceId].length > 0) { // Only include tokens that have occurrences
        for (const pos of tokenPositions[sentenceId]) merged.push({ pos, sentenceId });
      }
    }
    merged.sort((a, b) => a.pos - b.pos);

    const need = Math.floor(validTokenCount * 0.8); // Use 80% of tokens that actually have occurrences
    let have = 0;
    const cnt = new Map<number, number>();

    let bestL: number | null = null;
    let bestR: number | null = null;
    let l = 0;


    for (let r = 0; r < merged.length; r++) {
      const { pos: posR, sentenceId: sidR } = merged[r];
      cnt.set(sidR, (cnt.get(sidR) || 0) + 1);
      if (cnt.get(sidR) === 1) have++;

      while (have === need) {
        const { pos: posL, sentenceId: sidL } = merged[l];

        // Prefer strictly smaller span; keep the first minimal span for equal spans
        if (
          bestL === null ||
          (posR - posL) < (bestR! - bestL)
        ) {
          bestL = posL;
          bestR = posR;
        }

        cnt.set(sidL, (cnt.get(sidL) || 0) - 1);
        if (cnt.get(sidL) === 0) have--;
        l++;
      }
    }

    const result = bestL === null || bestR === null ? null : { start: bestL, end: bestR };
    return result;
  }
}
  
class AhoNode {
  public children: Map<string, AhoNode> = new Map();
  public failure: AhoNode | null = null;
  public output: number[] = [];
}
  
// Aho-Corasick automaton for efficient multi-pattern matching
class AhoCorasick {
  private root: AhoNode;
  private patterns: string[];

  constructor(patterns: string[]) {
    this.patterns = patterns;
    this.root = new AhoNode();
    this.buildTrie();
    this.buildFailureLinks();
  }

  private buildTrie(): void {
    for (let i = 0; i < this.patterns.length; i++) {
      const pattern = this.patterns[i];
      let current = this.root;
      
      for (const char of pattern) {
        if (!current.children.has(char)) {
          current.children.set(char, new AhoNode());
        }
        current = current.children.get(char)!;
      }
      current.output.push(i);
    }
  }

  private buildFailureLinks(): void {
    const queue: AhoNode[] = [];
    
    // Initialize failure links for depth 1
    for (const [, child] of this.root.children) {
      child.failure = this.root;
      queue.push(child);
    }

    // BFS to build failure links for deeper levels
    while (queue.length > 0) {
      const current = queue.shift()!;
      
      for (const [char, child] of current.children) {
        queue.push(child);
        
        let failure = current.failure;
        while (failure !== null && !failure.children.has(char)) {
          failure = failure.failure;
        }
        
        child.failure = failure?.children.get(char) || this.root;
        child.output.push(...child.failure.output);
      }
    }
  }

  public search(text: string): Map<number, number[]> {
    const results = new Map<number, number[]>();
    let current: AhoNode | null = this.root;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      
      while (current !== null && !current.children.has(char)) {
        current = current.failure;
      }
      
      if (current === null) {
        current = this.root;
      } else {
        current = current.children.get(char)!;
      }

      for (const patternIndex of current.output) {
        const startPos = i - this.patterns[patternIndex].length + 1;
        if (!results.has(patternIndex)) {
          results.set(patternIndex, []);
        }
        results.get(patternIndex)!.push(startPos);
      }
    }

    return results;
  }
}
  
// Helper function to merge close matches (optimized to avoid sorting)
const mergeCloseMatches = (matches: Array<{
  startIndex: number;
  endIndex: number;
  length: number;
}>) => {
  if (matches.length === 0) return matches;
  
  // Since matches come from ordered window, they should already be in order
  // But let's be safe and use a simple insertion sort for small k
  const sortedMatches = [...matches];
  for (let i = 1; i < sortedMatches.length; i++) {
    const key = sortedMatches[i];
    let j = i - 1;
    while (j >= 0 && sortedMatches[j].startIndex > key.startIndex) {
      sortedMatches[j + 1] = sortedMatches[j];
      j--;
    }
    sortedMatches[j + 1] = key;
  }
  
  const merged: Array<{
    startIndex: number;
    endIndex: number;
    length: number;
  }> = [];
  
  let currentMatch = { ...sortedMatches[0] };
  
  for (let i = 1; i < sortedMatches.length; i++) {
    const nextMatch = sortedMatches[i];
    const gap = nextMatch.startIndex - currentMatch.endIndex;
    
    // Merge if matches are close (within 128 characters or overlapping)
    if (gap <= 128) {
      // Extend the current match to include the next one
      currentMatch.endIndex = Math.max(currentMatch.endIndex, nextMatch.endIndex);
      currentMatch.length = currentMatch.endIndex - currentMatch.startIndex;
    } else {
      // Add current match and start a new one
      merged.push({
        ...currentMatch,
        length: currentMatch.endIndex - currentMatch.startIndex,
      });
      currentMatch = { ...nextMatch };
    }
  }
  
  // Add the last match
  merged.push({
    ...currentMatch,
    length: currentMatch.endIndex - currentMatch.startIndex,
  });
  
  return merged;
};

/** Collapses whitespace / markdown noise for chunk matching (same rules as server). */
function normalizeTextForChunking(text: string): string {
  return text
    .replace(/[-*•]\s+/g, "") // strip list bullets
    .replace(/^#+\s+/gm, "") // strip markdown headers
    .replace(/^\s+/gm, "") // strip leading whitespace/indentation from each line
    .replace(/\s+/g, " ") // collapse all whitespace to single spaces
    .replace(/\t/g, " ") // convert tabs to spaces
    .replace(/\n\s*\n/g, "\n") // remove empty lines with whitespace
    .trim()
}

/**
 * Text normalization with index mapping back to original string indices.
 * Must stay in sync with findHighlightMatches / chunk highlighting.
 */
export function normalizeTextWithMap(s: string): { norm: string; map: number[] } {
  const map: number[] = []
  const out: string[] = []
  let i = 0

  while (i < s.length) {
    const ch = s[i]

    if (/\s/.test(ch)) {
      let j = i + 1
      while (j < s.length && /\s/.test(s[j])) j++

      if (out.length > 0) {
        out.push(" ")
        map.push(j - 1)
      }
      i = j
    } else if (ch === "-" || ch === "*" || ch === "•") {
      let j = i + 1
      while (j < s.length && /\s/.test(s[j])) j++
      if (j > i + 1) {
        i = j
        continue
      }
      out.push(ch)
      map.push(i)
      i++
    } else if (ch === "#") {
      let j = i + 1
      while (j < s.length && s[j] === "#") j++
      if (i === 0 || s[i - 1] === "\n") {
        while (j < s.length && /\s/.test(s[j])) j++
        i = j
        continue
      }
      out.push(ch)
      map.push(i)
      i++
    } else if (ch === "\t") {
      out.push(" ")
      map.push(i)
      i++
    } else if (ch === "\n") {
      let j = i + 1
      while (j < s.length && /\s/.test(s[j])) j++
      if (j < s.length && s[j] === "\n") {
        i = j
        continue
      }
      out.push(ch)
      map.push(i)
      i++
    } else {
      out.push(ch)
      map.push(i)
      i++
    }
  }

  if (out.length && out[0] === " ") {
    out.shift()
    map.shift()
  }
  if (out.length && out[out.length - 1] === " ") {
    out.pop()
    map.pop()
  }

  return { norm: out.join(""), map }
}

/**
 * Maps an original [origStart, origEnd) span to [lo, hi) indices in normalized space
 * (same `map` as normalizeTextWithMap). `hi` is exclusive.
 */
function normalizedBoundsForOrigSpan(
  map: number[],
  origStart: number,
  origEndExclusive: number,
): { lo: number; hi: number } {
  if (map.length === 0 || origStart >= origEndExclusive) {
    return { lo: 0, hi: 0 }
  }
  let lo = 0
  while (lo < map.length && map[lo] < origStart) lo++
  let hi = lo
  while (hi < map.length && map[hi] < origEndExclusive) hi++
  return { lo, hi }
}

/**
 * Find highlight matches - exact port from server API
 */
export const findHighlightMatches = (
  chunkText: string,
  documentContent: string,
  options: { caseSensitive?: boolean } = {}
): HighlightResult => {
  try {
    const { caseSensitive = false } = options;

    const lowerCaseDoc = caseSensitive ? documentContent : documentContent.toLowerCase();
    const lowerCaseChunk = caseSensitive ? chunkText : chunkText.toLowerCase();
    const { norm: normalizedDoc, map: normalizedMap } = normalizeTextWithMap(lowerCaseDoc);
    const normalizedChunk = normalizeTextForChunking(lowerCaseChunk);

    // Step 1: Tokenize query text (chunkText) with custom tokenizer
    const queryTokens = TextTokenizer.tokenize(normalizedChunk, caseSensitive);
    
    if (queryTokens.length === 0) {
      return { 
        success: false, 
        message: "No meaningful tokens found in query after stopword removal",
      };
    }
    
    // Step 2: Use Aho-Corasick to find all occurrences of query tokens in O(n + m + occ) time
    const ac = new AhoCorasick(queryTokens);
    const searchResults = ac.search(normalizedDoc);
    
    // Step 3: Convert results to position lists for each token (already sorted by Aho-Corasick)
    const tokenPositions: number[][] = [];
    for (let i = 0; i < queryTokens.length; i++) {
      const positions = searchResults.get(i) || [];
      tokenPositions.push(positions); // Aho-Corasick already returns positions in order
    }
    
    
    // Step 4: Use ordered window algorithm to find minimum-length span
    const windowFinder = new OrderedWindowFinder();
    let bestWindow = windowFinder.findMinimumWindow(tokenPositions);
    
    if (!bestWindow) {
      return { 
        success: false, 
        message: "No suitable sequence of query tokens found in document",
      };
    }
    
    
    // Step 5: Create highlight matches for the optimal window
    const matches: Array<{
      startIndex: number;
      endIndex: number;
    }> = [];
    
    
    // For each token, find the best match within the window
    for (let i = 0; i < queryTokens.length; i++) {
      const token = queryTokens[i];
      const positions = tokenPositions[i];
      
      
      // Find positions within the window
      const windowPositions = positions.filter(pos => 
        pos >= bestWindow.start && pos <= bestWindow.end
      );
      
      
      if (windowPositions.length > 0) {
        // Use the first (leftmost) position within the window
        const bestPos = windowPositions[0];
        const startOrig = normalizedMap[bestPos] ?? bestPos;
        // Map the last character of the match, then add 1 for exclusive end boundary
        const lastCharIndex = bestPos + token.length - 1;
        const lastCharOrig = normalizedMap[lastCharIndex] ?? startOrig + token.length - 1;
        const endOrig = lastCharOrig + 1;
        
        
        matches.push({
          startIndex: startOrig,
          endIndex: endOrig,
        });
      }
    }
    
    // Step 6: Merge overlapping or close matches
    const mergedMatches = mergeCloseMatches(matches.map(match => ({ 
      ...match, 
      length: match.endIndex - match.startIndex 
    })));
    
    return {
      success: true,
      matches: mergedMatches,
    };

  } catch (error) {
    console.error("Error in client-side highlighting:", error);
    return { 
      success: false,
      message: error instanceof Error ? error.message : "Unknown error"
    };
  }
};

/**
 * Client-side keyword highlights: tokenize query (stopwords stripped), find occurrences
 * only inside each chunk span in normalized space, then map back to original indices
 * (same normalization + map as findHighlightMatches).
 */
export function getKeywordMatches(
  queryText: string,
  documentText: string,
  chunkMatches: HighlightMatch[],
  maxKeywords: number = 5,
  options: { caseSensitive?: boolean } = {},
): KeywordMatch[] {
  const { caseSensitive = false } = options
  if (!queryText?.trim() || !chunkMatches.length || !documentText) {
    return []
  }

  const queryForTokens = caseSensitive ? queryText : queryText.toLowerCase()
  const tokens = TextTokenizer.tokenize(queryForTokens, caseSensitive)
  if (tokens.length === 0) return []

  return getKeywordMatchesFromTokens(
    tokens,
    documentText,
    chunkMatches,
    maxKeywords,
    options,
  )
}

/**
 * Get top N longest unique tokens for better keyword matching
 * Longer tokens are more specific and provide better highlights
 * 
 * @param tokens - Array of tokens to filter
 * @param maxCount - Maximum number of tokens to return (default: 5)
 * @returns Array of top tokens sorted by length
 */
export function getTopUniqueTokens(tokens: string[], maxCount: number = 5): string[] {
  // Remove duplicates while preserving order
  const unique = [...new Set(tokens)]

  // Sort by length (longest first) - longer tokens = more specific
  const sorted = unique.sort((a, b) => b.length - a.length)

  // Return top N
  return sorted.slice(0, maxCount)
}

/**
 * Client-side keyword highlights using pre-tokenized keywords (from Vespa highlights)
 * instead of extracting tokens from query text.
 * 
 * This is the core function for Vespa-driven keyword highlighting. It accepts
 * pre-extracted and normalized tokens (e.g., from Vespa <hi> tags) and finds
 * their occurrences within chunk spans.
 * 
 * Key differences from getKeywordMatches:
 * - Accepts pre-tokenized keywords instead of raw query text
 * - Skips the tokenization step
 * - Ideal for using Vespa semantic highlights as keywords
 * 
 * @param tokens - Pre-extracted tokens to search for (already normalized)
 * @param documentText - Full document text to search within
 * @param chunkMatches - Chunk boundary matches to constrain search
 * @param maxKeywords - Maximum number of keyword matches to return (default: 5)
 * @param options - Configuration options
 * @returns Array of keyword matches within chunk boundaries
 * 
 * @example
 * ```ts
 * // Using Vespa highlight tokens
 * const vespaHighlights = ["authentication flow", "access token", "oauth"]
 * const tokens = vespaHighlights.flatMap(h => TextTokenizer.tokenize(h))
 * const topTokens = getTopUniqueTokens(tokens, 5)
 * 
 * const keywordMatches = getKeywordMatchesFromTokens(
 *   topTokens,
 *   documentText,
 *   chunkMatches,
 *   5,
 *   { caseSensitive: false }
 * )
 * ```
 */
export function getKeywordMatchesFromTokens(
  tokens: string[],
  documentText: string,
  chunkMatches: HighlightMatch[],
  maxKeywords: number = 5,
  options: { caseSensitive?: boolean } = {},
): KeywordMatch[] {
  const { caseSensitive = false } = options
  
  if (!tokens.length || !chunkMatches.length || !documentText) {
    return []
  }

  const docForNorm = caseSensitive 
    ? documentText 
    : documentText.toLowerCase()
  const { norm: normalizedDoc, map: normalizedMap } = normalizeTextWithMap(docForNorm)

  // Use provided tokens directly - skip tokenization step
  const ac = new AhoCorasick(tokens)
  const candidates: { start: number; end: number; len: number }[] = []

  for (const chunk of chunkMatches) {
    const { lo, hi } = normalizedBoundsForOrigSpan(
      normalizedMap,
      chunk.startIndex,
      chunk.endIndex,
    )
    if (lo >= hi) continue

    const slice = normalizedDoc.slice(lo, hi)
    if (slice.length === 0) continue

    const searchResults = ac.search(slice)
    
    for (let ti = 0; ti < tokens.length; ti++) {
      const token = tokens[ti]
      if (token.length < 2) continue
      const positions = searchResults.get(ti) || []
      for (const localPos of positions) {
        const globalNormStart = lo + localPos
        const globalNormEnd = globalNormStart + token.length
        if (globalNormEnd > hi) continue

        const startOrig = normalizedMap[globalNormStart] ?? chunk.startIndex
        const lastNorm = globalNormEnd - 1
        const lastCharOrig = normalizedMap[lastNorm] ?? startOrig
        const endOrig = lastCharOrig + 1

        if (
          startOrig >= chunk.startIndex &&
          endOrig <= chunk.endIndex &&
          startOrig < endOrig
        ) {
          candidates.push({
            start: startOrig,
            end: endOrig,
            len: endOrig - startOrig,
          })
        }
      }
    }
  }

  candidates.sort((a, b) => b.len - a.len || a.start - b.start)

  const overlaps = (
    a: { start: number; end: number },
    b: { start: number; end: number },
  ) => !(a.end <= b.start || b.end <= a.start)

  const selected: KeywordMatch[] = []
  for (const c of candidates) {
    if (selected.length >= maxKeywords) break
    if (
      selected.some((s) =>
        overlaps(
          { start: s.startIndex, end: s.endIndex },
          c,
        ),
      )
    )
      continue
    selected.push({
      startIndex: c.start,
      endIndex: c.end,
      length: c.len,
      type: "keyword",
    })
  }

  selected.sort((a, b) => a.startIndex - b.startIndex)
  return selected
}

/**
 * Check if two keyword matches are approximately the same (within 5 characters)
 * Used for deduplicating Vespa and fallback matches
 */
function areApproximatelySame(
  a: KeywordMatch,
  b: KeywordMatch,
  threshold: number = 5,
): boolean {
  return (
    Math.abs(a.startIndex - b.startIndex) < threshold &&
    Math.abs(a.endIndex - b.endIndex) < threshold
  )
}

/**
 * Hybrid keyword matching: prefers Vespa tokens, fills gaps with fallback query matches
 * 
 * This function combines Vespa semantic highlights with fallback keyword matching:
 * 1. Uses Vespa tokens as primary source (high-quality semantic matches)
 * 2. Falls back to query tokens to fill remaining slots
 * 3. Deduplicates matches that cover approximately the same region
 * 4. Ensures non-overlapping, well-distributed highlights
 * 
 * @param vespaTokens - Vespa-derived tokens (semantic highlights)
 * @param queryText - Original query text (for fallback matching)
 * @param documentText - Full document text to search within
 * @param chunkMatches - Chunk boundary matches to constrain search
 * @param maxKeywords - Maximum number of keyword matches to return (default: 5)
 * @param options - Configuration options
 * @returns Array of combined keyword matches, sorted by position
 */
export function getHybridKeywordMatches(
  vespaTokens: string[],
  queryText: string,
  documentText: string,
  chunkMatches: HighlightMatch[],
  maxKeywords: number = 5,
  options: { caseSensitive?: boolean; minTokenLength?: number; dedupeThreshold?: number } = {},
): KeywordMatch[] {
  const { caseSensitive = false, minTokenLength = 3, dedupeThreshold = 5 } = options

  // Edge case: no chunk matches
  if (!chunkMatches.length || !documentText) {
    return []
  }

  // Step 1: Filter Vespa tokens (remove short ones)
  const filteredVespaTokens = vespaTokens.filter(
    (token) => token.length >= minTokenLength,
  )

  // Step 2: Get Vespa matches (prioritized)
  let vespaMatches: KeywordMatch[] = []
  if (filteredVespaTokens.length > 0) {
    vespaMatches = getKeywordMatchesFromTokens(
      filteredVespaTokens,
      documentText,
      chunkMatches,
      maxKeywords,
      { caseSensitive },
    )
  }

  // Step 3: If we have enough Vespa matches, return them
  if (vespaMatches.length >= maxKeywords) {
    return vespaMatches.slice(0, maxKeywords)
  }

  // Step 4: Get fallback matches from query text to fill remaining slots
  let fallbackMatches: KeywordMatch[] = []
  if (queryText?.trim()) {
    fallbackMatches = getKeywordMatches(
      queryText,
      documentText,
      chunkMatches,
      maxKeywords,
      { caseSensitive },
    )
  }

  // Step 6: Combine Vespa + fallback, removing duplicates and overlaps
  const combined = [...vespaMatches]

  for (const fm of fallbackMatches) {
    if (combined.length >= maxKeywords) break

    // Skip if this fallback match is approximately the same as an existing match
    const isDuplicate = combined.some((cm) =>
      areApproximatelySame(cm, fm, dedupeThreshold),
    )
    if (isDuplicate) continue

    // Skip if this fallback overlaps with an existing match
    const hasOverlap = combined.some(
      (cm) =>
        !(fm.endIndex <= cm.startIndex || cm.endIndex <= fm.startIndex),
    )
    if (hasOverlap) continue

    combined.push(fm)
  }

  // Step 7: Sort by position for consistent rendering
  combined.sort((a, b) => a.startIndex - b.startIndex)

  return combined
}
