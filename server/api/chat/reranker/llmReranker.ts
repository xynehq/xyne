/**
 * LLM-based reranker implementation
 * Uses the fast model to score chunks for relevance
 */

import { getProviderByModel } from "@/ai/provider"
import { Models, type ModelParams } from "@/ai/types"
import { ConversationRole, type Message } from "@aws-sdk/client-bedrock-runtime"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { Chunk, RerankedChunk, Reranker } from "./types"

const Logger = getLogger(Subsystem.Chat)

const RERANKING_SYSTEM_PROMPT = `You are a relevance scoring engine. Given a user query and a list of document chunks, score each chunk 0-100 for how well it helps answer the query.

Output format: One score per line, numbered:
1: 85
2: 42
3: 91

Scoring guide:
- 90-100: Directly and specifically answers the query
- 70-89: Highly relevant, contains key information needed
- 40-69: Somewhat relevant, related topic but not directly answering
- 10-39: Tangentially related, minimal usefulness
- 0-9: Not relevant at all

Output ONLY the numbered scores, one per line. No extra text.`

const BATCH_SIZE = 5

/**
 * LLM-based reranker that uses the configured fast model
 */
export class LlmReranker implements Reranker {
  private modelId: string

  constructor(modelId?: string) {
    this.modelId = modelId || config.defaultFastModel
  }

  async rerank(query: string, chunks: Chunk[], topN?: number): Promise<RerankedChunk[]> {
    if (chunks.length === 0) {
      return []
    }

    // For very small sets, skip the LLM call and use Vespa scores
    if (chunks.length <= 3) {
      return chunks.map((chunk, index) => ({
        ...chunk,
        rerankScore: chunk.vespaScore,
        rank: index + 1,
      }))
    }

    try {
      // Split into batches of BATCH_SIZE and score each batch in parallel
      const batches: Chunk[][] = []
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        batches.push(chunks.slice(i, i + BATCH_SIZE))
      }

      const batchResults = await Promise.all(
        batches.map((batch) => this.scoreBatch(query, batch))
      )

      // Flatten batch scores back to per-chunk scores aligned with original order
      const allScores: number[] = batchResults.flat()

      if (allScores.length !== chunks.length) {
        Logger.warn(
          {
            expected: chunks.length,
            received: allScores.length,
            batchCount: batches.length,
          },
          "[LlmReranker] Score count mismatch after batching, falling back to Vespa scores"
        )
        return chunks.map((chunk, index) => ({
          ...chunk,
          rerankScore: chunk.vespaScore,
          rank: index + 1,
        }))
      }

      // Create reranked chunks
      const reranked: RerankedChunk[] = chunks.map((chunk, i) => ({
        ...chunk,
        rerankScore: allScores[i] / 100, // Normalize to 0-1
        rank: 0, // Will be set after sorting
      }))

      // Sort by rerank score descending
      reranked.sort((a, b) => b.rerankScore - a.rerankScore)

      // Assign ranks and apply topN limit
      const limited = topN ? reranked.slice(0, topN) : reranked
      limited.forEach((chunk, index) => {
        chunk.rank = index + 1
      })

      Logger.info(
        {
          chunkCount: chunks.length,
          batchCount: batches.length,
          topScore: limited[0]?.rerankScore,
          bottomScore: limited[limited.length - 1]?.rerankScore,
        },
        "[LlmReranker] Reranking completed"
      )

      return limited
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      Logger.error(
        {
          error: errorMessage,
          chunkCount: chunks.length,
        },
        "[LlmReranker] Reranking failed, falling back to Vespa scores"
      )

      // Fall back to Vespa scores for all chunks
      return chunks.map((chunk, index) => ({
        ...chunk,
        rerankScore: chunk.vespaScore,
        rank: index + 1,
      }))
    }
  }

  /**
   * Score a single batch of chunks (up to BATCH_SIZE) with one LLM call.
   * Returns scores in the same order as the input batch.
   * On failure, returns Vespa scores for the batch.
   */
  private async scoreBatch(query: string, batch: Chunk[]): Promise<number[]> {
    const chunkSummaries = batch
      .map((c, i) => {
        const content = c.content.substring(0, 200).replace(/\n+/g, " ")
        return `${i + 1}. ${content}`
      })
      .join("\n")

    const userMessage = `Query: "${query}"\n\nChunks:\n${chunkSummaries}\n\nProvide relevance scores (0-100) for each chunk in format:\n1: 85\n2: 42\n...`

    const messages: Message[] = [
      {
        role: ConversationRole.USER,
        content: [{ text: userMessage }],
      },
    ]

    const params: ModelParams = {
      modelId: this.modelId as Models,
      json: false,
      stream: false,
      temperature: 0,
      max_new_tokens: batch.length * 10,
      systemPrompt: RERANKING_SYSTEM_PROMPT,
    }

    try {
      const { text } = await getProviderByModel(this.modelId as Models).converse(messages, params)

      if (!text) {
        throw new Error("Empty LLM response for batch")
      }

      const scores = this.parseScores(text, batch.length)

      if (scores.length !== batch.length) {
        Logger.warn(
          {
            expected: batch.length,
            received: scores.length,
            rawResponse: text.substring(0, 300),
          },
          "[LlmReranker] Batch score count mismatch, using Vespa scores for this batch"
        )
        return batch.map((c) => c.vespaScore * 100)
      }

      return scores
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      Logger.warn(
        { error: errorMessage, batchSize: batch.length },
        "[LlmReranker] Batch scoring failed, using Vespa scores for this batch"
      )
      return batch.map((c) => c.vespaScore * 100)
    }
  }

  /**
   * Parse scores from LLM response text
   */
  private parseScores(text: string, expectedCount: number): number[] {
    const scores: number[] = []
    const lines = text.trim().split("\n")

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      // Try to match "N: score" or "N. score" format
      const match = trimmed.match(/^(?:\d+[\:\.\s]+)?(\d+)$/)
      if (match) {
        const score = parseInt(match[1], 10)
        if (score >= 0 && score <= 100) {
          scores.push(score)
        }
      }
    }

    // If we didn't get enough scores, try extracting all numbers
    if (scores.length < expectedCount) {
      const allNumbers = text.match(/\d+/g)
      if (allNumbers) {
        const extractedScores = allNumbers
          .map((n) => parseInt(n, 10))
          .filter((n) => n >= 0 && n <= 100)
          .slice(0, expectedCount)

        // Fill in missing scores
        while (scores.length < expectedCount && extractedScores.length > scores.length) {
          scores.push(extractedScores[scores.length])
        }
      }
    }

    return scores
  }
}