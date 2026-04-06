/**
 * Jina AI reranker implementation
 * Uses Jina AI's reranking API: https://jina.ai/reranker/
 */

import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { Chunk, ExternalRerankResult, RerankedChunk, Reranker } from "./types"

const Logger = getLogger(Subsystem.Chat)

const JINA_API_URL = "https://api.jina.ai/v1/rerank"

/**
 * Jina AI reranker using their API
 */
export class JinaReranker implements Reranker {
  private apiKey: string
  private apiUrl: string
  private model: string
  private returnDocuments: boolean

  constructor(apiKey: string, apiUrl?: string, model?: string, returnDocuments: boolean = false) {
    this.apiKey = apiKey
    this.apiUrl = apiUrl || JINA_API_URL
    this.model = model || "jina-reranker-v3"
    this.returnDocuments = returnDocuments
  }

  async rerank(query: string, chunks: Chunk[], topN?: number): Promise<RerankedChunk[]> {
    if (chunks.length === 0) {
      return []
    }

    try {
      // Prepare documents for the API
      const documents = chunks.map((chunk) => chunk.content)

      const requestBody: any = {
        model: this.model,
        query,
        documents,
        top_n: topN || chunks.length,
        return_documents: this.returnDocuments,
      }

      Logger.info(
        {
          chunkCount: chunks.length,
          topN: topN || chunks.length,
          model: this.model,
        },
        "[JinaReranker] Calling Jina AI rerank API"
      )

      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(requestBody),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Jina API error: ${response.status} - ${errorText}`)
      }

      const data = await response.json()

      if (!data.results || !Array.isArray(data.results)) {
        throw new Error("Invalid response format from Jina API")
      }

      // Map results back to chunks
      const results: ExternalRerankResult[] = data.results
      const reranked: RerankedChunk[] = results.map((result, index) => {
        const originalChunk = chunks[result.index]
        return {
          ...originalChunk,
          rerankScore: result.relevance_score,
          rank: index + 1,
        }
      })

      Logger.info(
        {
          chunkCount: chunks.length,
          returnedCount: reranked.length,
          topScore: reranked[0]?.rerankScore,
          bottomScore: reranked[reranked.length - 1]?.rerankScore,
        },
        "[JinaReranker] Reranking completed"
      )

      return reranked
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      Logger.error(
        {
          error: errorMessage,
          chunkCount: chunks.length,
        },
        "[JinaReranker] Reranking failed, falling back to Vespa scores"
      )

      // Fall back to Vespa scores
      return chunks.map((chunk, index) => ({
        ...chunk,
        rerankScore: chunk.vespaScore,
        rank: index + 1,
      }))
    }
  }
}