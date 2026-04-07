/**
 * Chunking utilities
 */

/**
 * Estimate token count using character-based approximation
 * Rule of thumb: ~4 characters per token for English text
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Simple sentence splitter
 * Splits on sentence-ending punctuation followed by space
 */
export function splitIntoSentences(text: string): string[] {
  // Split on sentence boundaries
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  // If no sentences found (no punctuation), fall back to splitting by length
  if (sentences.length === 0) {
    return splitByLength(text, 100)
  }

  return sentences
}

/**
 * Split text by character length (fallback method)
 */
export function splitByLength(text: string, maxLength: number): string[] {
  const chunks: string[] = []
  let i = 0

  while (i < text.length) {
    // Find a good breaking point (space) near maxLength
    let end = Math.min(i + maxLength, text.length)

    if (end < text.length) {
      // Look for last space before end
      const lastSpace = text.lastIndexOf(" ", end)
      if (lastSpace > i) {
        end = lastSpace
      }
    }

    chunks.push(text.slice(i, end).trim())
    i = end
  }

  return chunks.filter((s) => s.length > 0)
}

/**
 * Get unique values from array
 */
export function getUnique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr))
}

/**
 * Generate unique chunk ID
 */
export function generateChunkId(index: number, prefix = "chunk"): string {
  return `${prefix}_${String(index).padStart(6, "0")}`
}

/**
 * Extract overlap text from the end of a chunk
 * Takes last N sentences up to maxTokens limit
 */
export function getOverlapText(
  text: string,
  maxSentences: number,
  maxTokens: number,
  estimateTokensFn: (text: string) => number
): string {
  const sentences = splitIntoSentences(text)
  
  if (sentences.length === 0) return ""
  
  // Take sentences from the end
  const overlapSentences: string[] = []
  let overlapTokens = 0
  
  for (let i = sentences.length - 1; i >= 0 && overlapSentences.length < maxSentences; i--) {
    const sentence = sentences[i]
    const sentTokens = estimateTokensFn(sentence)
    
    // Stop if we'd exceed max overlap tokens
    if (overlapTokens + sentTokens > maxTokens) {
      break
    }
    
    overlapSentences.unshift(sentence) // Add to front to maintain order
    overlapTokens += sentTokens
  }
  
  return overlapSentences.join(" ")
}