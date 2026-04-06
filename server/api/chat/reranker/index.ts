/**
 * Reranker factory and exports
 */

import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { JinaReranker } from "./jinaReranker"
import { LlmReranker } from "./llmReranker"
import { CrossEncoderReranker } from "./crossEncoderReranker"
import type { Reranker, RerankingConfig } from "./types"

const Logger = getLogger(Subsystem.Chat)

/**
 * Create a reranker instance based on configuration
 */
export function createReranker(rerankingConfigInput?: RerankingConfig): Reranker | null {
  const rerankingConfig = rerankingConfigInput || config.reranking

  if (!rerankingConfig.enabled) {
    Logger.info("[Reranker] Reranking is disabled")
    return null
  }

  switch (rerankingConfig.provider) {
    case "llm":
      Logger.info(
        {
          model: rerankingConfig.model || config.defaultFastModel,
        },
        "[Reranker] Creating LLM reranker"
      )
      return new LlmReranker(rerankingConfig.model)

    case "jina":
      if (!rerankingConfig.apiKey) {
        Logger.error("[Reranker] Jina reranker requires API key")
        return null
      }
      Logger.info("[Reranker] Creating Jina AI reranker")
      return new JinaReranker(
        rerankingConfig.apiKey,
        rerankingConfig.apiUrl,
        rerankingConfig.model,
        false // return_documents: false (we don't need documents back, just scores)
      )

    case "cohere":
      // Cohere reranker can be added here when needed
      Logger.error("[Reranker] Cohere reranker not yet implemented")
      return null

    case "cross-encoder":
      Logger.info(
        {
          model: rerankingConfig.model || "Xenova/ms-marco-MiniLM-L-6-v2",
        },
        "[Reranker] Creating local cross-encoder reranker"
      )
      return new CrossEncoderReranker(rerankingConfig.model)

    default:
      Logger.error(
        {
          provider: rerankingConfig.provider,
        },
        "[Reranker] Unknown reranker provider"
      )
      return null
  }
}

// Export all types and implementations
export * from "./types"
export { LlmReranker } from "./llmReranker"
export { JinaReranker } from "./jinaReranker"
export { CrossEncoderReranker } from "./crossEncoderReranker"