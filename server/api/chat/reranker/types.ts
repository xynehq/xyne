/**
 * Reranker types and interfaces for chunk-level reranking
 */

import type { Citation } from "@/api/chat/types"

/**
 * Represents a single chunk extracted from Vespa search results
 */
export interface Chunk {
  /** Unique identifier for the chunk */
  id: string
  /** The actual content/text of the chunk */
  content: string
  /** Parent document ID this chunk belongs to */
  parentDocId: string
  /** Original relevance score from Vespa */
  vespaScore: number
  /** Chunk index within the parent document */
  chunkIndex: number
  /** Citation info for the source document */
  source: Citation
  /** Additional metadata */
  metadata?: Record<string, any>
}

/**
 * Represents a chunk after reranking with a new relevance score
 */
export interface RerankedChunk extends Chunk {
  /** Reranked relevance score (0-1) */
  rerankScore: number
  /** Rank position after reranking */
  rank: number
}

/**
 * Interface for all reranker implementations
 */
export interface Reranker {
  /**
   * Rerank chunks based on query relevance
   * @param query - The search query
   * @param chunks - Array of chunks to rerank
   * @param topN - Number of top chunks to return (optional)
   * @returns Array of reranked chunks sorted by relevance
   */
  rerank(query: string, chunks: Chunk[], topN?: number): Promise<RerankedChunk[]>
}

/**
 * Configuration for reranking
 */
export interface RerankingConfig {
  /** Whether reranking is enabled */
  enabled: boolean
  /** Provider type: "llm" | "jina" | "cohere" | "cross-encoder" */
  provider: "llm" | "jina" | "cohere" | "cross-encoder"
  /** Model to use for LLM-based reranking */
  model?: string
  /** API key for external reranking services */
  apiKey?: string
  /** Custom API URL for reranking service */
  apiUrl?: string
  /** Number of top chunks to return after reranking */
  topK: number
}

/**
 * Result from external reranking API (Jina/Cohere format)
 */
export interface ExternalRerankResult {
  /** Index of the document in the input array */
  index: number
  /** Relevance score from the reranker */
  relevance_score: number
}

/**
 * Group of chunks belonging to the same parent document
 */
export interface ChunkGroup {
  /** Parent document ID */
  parentDocId: string
  /** Citation info for the source */
  source: Citation
  /** Chunks belonging to this document */
  chunks: RerankedChunk[]
  /** Aggregated score for the group */
  aggregatedScore: number
}