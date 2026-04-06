/**
 * Local cross-encoder reranker using @huggingface/transformers (Transformers.js)
 *
 * Runs a cross-encoder model (e.g. cross-encoder/ms-marco-MiniLM-L-6-v2)
 * directly in-process via ONNX runtime — no external API or server needed.
 * Model auto-downloads and caches on first use (~80MB).
 */

import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { Chunk, RerankedChunk, Reranker } from "./types"

const Logger = getLogger(Subsystem.Chat)

const DEFAULT_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2"

// Lazy-loaded model + tokenizer singleton
let tokenizer: any = null
let model: any = null
let modelLoading: Promise<void> | null = null

/**
 * Lazily load the cross-encoder model and tokenizer (singleton).
 * First call downloads the ONNX model (~80MB), subsequent calls are instant.
 */
async function ensureModelLoaded(modelId: string) {
  if (tokenizer && model) return

  if (modelLoading) {
    await modelLoading
    return
  }

  modelLoading = (async () => {
    try {
      Logger.info({ model: modelId }, "[CrossEncoderReranker] Loading cross-encoder model (first call downloads ~80MB)...")
      
      const { AutoTokenizer, AutoModelForSequenceClassification } = await import("@huggingface/transformers")

      tokenizer = await AutoTokenizer.from_pretrained(modelId)
      model = await AutoModelForSequenceClassification.from_pretrained(modelId)

      Logger.info({ model: modelId }, "[CrossEncoderReranker] Cross-encoder model loaded successfully")
    } catch (err) {
      modelLoading = null
      throw err
    }
  })()

  await modelLoading
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

/**
 * Local cross-encoder reranker — runs entirely on-device via ONNX
 */
export class CrossEncoderReranker implements Reranker {
  private modelId: string

  constructor(modelId?: string) {
    // HuggingFace model IDs use "org/model-name" format
    // If the configured model isn't in that format (e.g. "jina-reranker-v3"), use the default
    if (modelId && modelId.includes("/")) {
      this.modelId = modelId
    } else {
      this.modelId = DEFAULT_MODEL
      if (modelId) {
        Logger.info(
          { configuredModel: modelId, usingModel: DEFAULT_MODEL },
          "[CrossEncoderReranker] Configured model is not a HuggingFace model ID, using default"
        )
      }
    }
  }

  async rerank(query: string, chunks: Chunk[], topN?: number): Promise<RerankedChunk[]> {
    if (chunks.length === 0) return []

    try {
      await ensureModelLoaded(this.modelId)

      Logger.info(
        { chunkCount: chunks.length, topN: topN || chunks.length, model: this.modelId },
        "[CrossEncoderReranker] Scoring chunks with cross-encoder"
      )

      // Score each (query, chunk) pair through the cross-encoder
      const scores: number[] = []
      for (const chunk of chunks) {
        const inputs = tokenizer(query, {
          text_pair: chunk.content.substring(0, 512),
          padding: true,
          truncation: true,
        })
        const output = await model(inputs)
        // output.logits is a Tensor with shape [1, 1] for cross-encoders
        // Apply sigmoid to get a 0-1 relevance score
        const logit = output.logits.data[0]
        scores.push(sigmoid(logit))
      }

      // Create reranked chunks
      const reranked: RerankedChunk[] = chunks.map((chunk, i) => ({
        ...chunk,
        rerankScore: scores[i],
        rank: 0,
      }))

      // Sort by rerank score descending
      reranked.sort((a, b) => b.rerankScore - a.rerankScore)

      // Apply topN limit and assign ranks
      const limited = topN ? reranked.slice(0, topN) : reranked
      limited.forEach((chunk, index) => {
        chunk.rank = index + 1
      })

      Logger.info(
        {
          chunkCount: chunks.length,
          returnedCount: limited.length,
          topScore: limited[0]?.rerankScore,
          bottomScore: limited[limited.length - 1]?.rerankScore,
        },
        "[CrossEncoderReranker] Reranking completed"
      )

      return limited
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      Logger.error(
        { error: errorMessage, chunkCount: chunks.length },
        "[CrossEncoderReranker] Reranking failed, falling back to Vespa scores"
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
