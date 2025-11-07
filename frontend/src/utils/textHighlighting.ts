import { removeStopwords } from 'stopword'

export interface HighlightMatch {
  startIndex: number
  endIndex: number
  length: number
}

export interface HighlightResult {
  success: boolean
  matches?: HighlightMatch[]
  message?: string
}

// Custom tokenization with regex and stopword removal using stopword library
class TextTokenizer {
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

    // Normalize text for matching
    const normalizeText = (text: string) => {
      return text
        .replace(/[-*•]\s+/g, "")      // strip list bullets
        .replace(/^#+\s+/gm, "")       // strip markdown headers
        .replace(/^\s+/gm, "")         // strip leading whitespace/indentation from each line
        .replace(/\s+/g, " ")          // collapse all whitespace to single spaces
        .replace(/\t/g, " ")           // convert tabs to spaces
        .replace(/\n\s*\n/g, "\n")     // remove empty lines with whitespace
        .trim();
    };

    // Text normalization function with index mapping
    const normalizeTextWithMap = (s: string) => {
      const map: number[] = [];
      const out: string[] = [];
      let i = 0;
      
      while (i < s.length) {
        const ch = s[i];
        
        // Handle whitespace sequences
        if (/\s/.test(ch)) {
          let j = i + 1;
          while (j < s.length && /\s/.test(s[j])) j++;
          
          // Only add a single space if we have content before it
          if (out.length > 0) {
            out.push(" ");
            map.push(j - 1);
          }
          i = j;
        } 
        // Handle list bullets and markdown headers
        else if (ch === '-' || ch === '*' || ch === '•') {
          // Check if this is a list bullet followed by whitespace
          let j = i + 1;
          while (j < s.length && /\s/.test(s[j])) j++;
          if (j > i + 1) {
            // Skip the bullet and whitespace
            i = j;
            continue;
          }
          // Not a list bullet, treat as normal character
          out.push(ch);
          map.push(i);
          i++;
        }
        // Handle markdown headers (#)
        else if (ch === '#') {
          let j = i + 1;
          while (j < s.length && s[j] === '#') j++;
          // Check if this is at start of line and followed by whitespace
          if (i === 0 || s[i-1] === '\n') {
            while (j < s.length && /\s/.test(s[j])) j++;
            // Skip the header markers and whitespace
            i = j;
            continue;
          }
          // Not a header, treat as normal character
          out.push(ch);
          map.push(i);
          i++;
        }
        // Handle tabs
        else if (ch === '\t') {
          out.push(' ');
          map.push(i);
          i++;
        }
        // Handle empty lines with whitespace
        else if (ch === '\n') {
          let j = i + 1;
          while (j < s.length && /\s/.test(s[j])) j++;
          if (j < s.length && s[j] === '\n') {
            // This is an empty line with whitespace, skip it
            i = j;
            continue;
          }
          // Normal newline
          out.push(ch);
          map.push(i);
          i++;
        }
        // Normal character
        else {
          out.push(ch);
          map.push(i);
          i++;
        }
      }
      
      // Remove leading and trailing spaces
      if (out.length && out[0] === " ") { 
        out.shift(); 
        map.shift(); 
      }
      if (out.length && out[out.length - 1] === " ") { 
        out.pop(); 
        map.pop(); 
      }
      
      return { norm: out.join(""), map };
    };

    const lowerCaseDoc = caseSensitive ? documentContent : documentContent.toLowerCase();
    const lowerCaseChunk = caseSensitive ? chunkText : chunkText.toLowerCase();
    const { norm: normalizedDoc, map: normalizedMap } = normalizeTextWithMap(lowerCaseDoc);
    const normalizedChunk = normalizeText(lowerCaseChunk);

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
