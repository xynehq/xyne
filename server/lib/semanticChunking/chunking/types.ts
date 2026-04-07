/**
 * Chunk type definitions
 */

export interface Chunk {
  id: string
  text: string
  metadata: ChunkMetadata
  refs: string[]  // Source refs for traceability
}

export interface ChunkMetadata {
  index: number
  pageNumbers: number[]
  sectionPaths: string[][]  // All section paths this chunk spans
  labels: string[]
  tokenCount: number
  charCount: number
}

export interface ChunkingOptions {
  /** Maximum tokens per chunk (default: 512) */
  maxTokens?: number
  /** Minimum tokens per chunk (default: 50) */
  minTokens?: number
  /** Overlap between chunks as percentage (default: 0.1 = 10%) */
  overlapRatio?: number
  /** Whether to respect sentence boundaries (default: true) */
  respectBoundaries?: boolean
  /** Target tokens for balanced chunking (default: (minTokens + maxTokens) / 2) */
  targetTokens?: number
}