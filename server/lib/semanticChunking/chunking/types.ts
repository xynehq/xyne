/**
 * Chunk type definitions
 */

export interface Chunk {
  id: string
  text: string
  metadata: ChunkMetadata
}

export interface PageBBox {
  page: number
  l: number
  t: number
  r: number
  b: number
}

// ChunkMetadata type for OCR and file processing
export type ChunkMetadata = {
  chunk_index: number
  page_numbers: number[]
  block_labels: string[]
  bboxes?: Array<PageBBox>
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
  docId?: string
  describeImages?: boolean
}

/** Structured chunking result matching pdfChunks architecture */
export interface ChunkingResult {
  text_chunks: string[]
  image_chunks: string[]
  text_chunk_pos: number[]
  image_chunk_pos: number[]
  text_chunks_map: ChunkMetadata[]
  image_chunks_map: ChunkMetadata[]
}
