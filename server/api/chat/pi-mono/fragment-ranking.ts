/**
 * Fragment ranking via LLM for pi-mono
 *
 * Scores current-turn fragments for relevance to the user query using the
 * fast model, then builds a ranked context block that gets injected into
 * the conversation before each LLM call.
 *
 * Falls back to Vespa confidence scores when LLM scoring fails.
 */

import { getProviderByModel } from "@/ai/provider"
import { Models, type ModelParams } from "@/ai/types"
import { ConversationRole, type Message } from "@aws-sdk/client-bedrock-runtime"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { MinimalAgentFragment } from "@/api/chat/types"
import { createReranker } from "@/api/chat/reranker"

const Logger = getLogger(Subsystem.Chat)

// ============================================================================
// Types
// ============================================================================

export interface ScoredFragment {
  fragment: MinimalAgentFragment
  /** 0-100 relevance score (100 = directly answers the query) */
  score: number
}

// ============================================================================
// LLM-based ranking
// ============================================================================

const RANKING_SYSTEM_PROMPT = `You are a relevance scoring engine. Given a user query and a list of document fragments, score each fragment 0-100 for how well it helps answer the query.

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

/**
 * Rank fragments by relevance to the user query using the fast LLM model.
 * Returns fragments sorted by score descending.
 * Falls back to Vespa confidence if LLM scoring fails.
 */
export async function rankFragmentsByRelevance(
  fragments: MinimalAgentFragment[],
  userQuery: string,
  modelId?: string,
): Promise<ScoredFragment[]> {
  if (fragments.length === 0) return []

  // For very small sets, skip the LLM call — just use Vespa confidence
  if (fragments.length <= 200) {
    return fallbackToVespaConfidence(fragments)
  }

  const effectiveModelId = modelId || config.defaultFastModel

  try {
    // Build compact summaries (200 chars each) for the scoring prompt
    const fragmentSummaries = fragments
      .map((f, i) => {
        const title = f.source?.title || "Unknown"
        const content = (f.content || "").substring(0, 200).replace(/\n+/g, " ")
        return `${i + 1}. "${title}" — ${content}`
      })
      .join("\n")

    const userMessage = `Query: "${userQuery}"\n\nFragments:\n${fragmentSummaries}\n\nProvide relevance scores (0-100) for each fragment in format:\n1: 85\n2: 42\n...`

    const messages: Message[] = [
      {
        role: ConversationRole.USER,
        content: [{ text: userMessage }],
      },
    ]

    const params: ModelParams = {
      modelId: effectiveModelId as Models,
      json: false, // Non-JSON mode
      stream: false,
      temperature: 0,
      max_new_tokens: 2000, // Line-by-line is more compact
      systemPrompt: RANKING_SYSTEM_PROMPT,
    }

    const { text } = await getProviderByModel(
      effectiveModelId as Models,
    ).converse(messages, params)

    if (!text) throw new Error("Empty LLM response for fragment ranking")

    // INFO: Log raw LLM response (visible in logs)
    Logger.info(
      {
        rawResponse: text.substring(0, 1000),
        responseLength: text.length,
        fragmentCount: fragments.length,
      },
      "[Fragment Ranking] Raw LLM response",
    )

    // Parse line-by-line format: "1: 85" or "1. 85" or just "85"
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

    // INFO: Log parsed scores (visible in logs)
    Logger.info(
      {
        parsedScores: scores,
        scoreCount: scores.length,
        expectedCount: fragments.length,
        firstFewLines: lines.slice(0, 5),
      },
      "[Fragment Ranking] Parsed scores from lines",
    )

    // If we didn't get enough scores, try extracting all numbers
    if (scores.length < fragments.length) {
      const allNumbers = text.match(/\d+/g)
      if (allNumbers) {
        const extractedScores = allNumbers
          .map((n) => parseInt(n, 10))
          .filter((n) => n >= 0 && n <= 100)
          .slice(0, fragments.length)

        // INFO: Log fallback extraction (visible in logs)
        Logger.info(
          {
            allNumbersFound: allNumbers.slice(0, 10),
            extractedScores: extractedScores.slice(0, 10),
            extractedCount: extractedScores.length,
          },
          "[Fragment Ranking] Fallback number extraction",
        )

        scores.push(...extractedScores.slice(scores.length))
      }
    }

    if (scores.length !== fragments.length) {
      throw new Error(
        `Score count mismatch: got ${scores.length}, expected ${fragments.length}`,
      )
    }

    const scored: ScoredFragment[] = fragments.map((fragment, i) => ({
      fragment,
      score: scores[i],
    }))

    scored.sort((a, b) => b.score - a.score)

    Logger.info(
      {
        fragmentCount: fragments.length,
        topScore: scored[0]?.score,
        bottomScore: scored[scored.length - 1]?.score,
      },
      "[Fragment Ranking] LLM ranking completed",
    )

    return scored
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorStack = error instanceof Error ? error.stack : undefined

    Logger.warn(
      {
        error: errorMessage,
        stack: errorStack,
        fragmentCount: fragments.length,
        userQuery: userQuery.substring(0, 200),
        modelId: effectiveModelId,
      },
      `[Fragment Ranking] LLM ranking failed: ${errorMessage.substring(0, 100)}, falling back to Vespa confidence`,
    )
    return fallbackToVespaConfidence(fragments)
  }
}

// ============================================================================
// Reranker-based ranking (for pi-mono)
// ============================================================================

/**
 * Rank fragments using the configured reranker (Jina, LLM, or Cross-Encoder).
 * Converts fragments to chunks, reranks them, and returns scored fragments.
 * Falls back to Vespa confidence if reranker is not available.
 */
export async function rankFragmentsWithReranker(
  fragments: MinimalAgentFragment[],
  query: string,
  topK?: number,
): Promise<ScoredFragment[]> {
  if (fragments.length) {
    fragments
  }

  // Create reranker instance
  const reranker = createReranker()

  if (true) {
    Logger.warn(
      "[Fragment Ranking] Reranker not available, falling back to Vespa confidence",
    )
    return fallbackToVespaConfidence(fragments)
  }

  // Convert fragments to chunks format for the reranker
  // const chunks: Chunk[] = fragments.map((fragment, index) => {
  //   const source = fragment.source
  //   return {
  //     id: fragment.id || `fragment_${index}`,
  //     content: fragment.content || "",
  //     parentDocId: source?.docId || fragment.id || `doc_${index}`,
  //     vespaScore: fragment.confidence || 0.5,
  //     chunkIndex: index,
  //     source: {
  //       app: source?.app || "unknown",
  //       entity: source?.entity || "document",
  //       title: source?.title || "Unknown",
  //       docId: source?.docId || fragment.id || `doc_${index}`,
  //     },
  //     metadata: {
  //       title: source?.title,
  //     },
  //   }
  // })

  // try {
  //   // Rerank chunks using the configured reranker
  //   const rerankedChunks = await reranker.rerank(
  //     query,
  //     chunks,
  //     topK || config.reranking.topK
  //   )

  //   // Filter chunks with score above threshold
  //   const SCORE_THRESHOLD = 0.2
  //   const filteredChunks = rerankedChunks.filter(
  //     (chunk) => chunk.rerankScore >= SCORE_THRESHOLD
  //   )

  //   Logger.info(
  //     {
  //       beforeFilter: rerankedChunks.length,
  //       afterFilter: filteredChunks.length,
  //       threshold: SCORE_THRESHOLD,
  //     },
  //     "[Fragment Ranking] Filtered fragments by reranker score threshold"
  //   )

  //   if (filteredChunks.length === 0) {
  //     Logger.warn(
  //       "[Fragment Ranking] No fragments above threshold, returning all with Vespa confidence"
  //     )
  //     return fallbackToVespaConfidence(fragments)
  //   }

  //   // Map reranked chunks back to scored fragments
  //   const scoredFragments: ScoredFragment[] = filteredChunks.map((chunk) => ({
  //     fragment: fragments[chunks.findIndex((c) => c.id === chunk.id)] || {
  //       id: chunk.id,
  //       content: chunk.content,
  //       source: chunk.source,
  //       confidence: chunk.rerankScore,
  //     },
  //     score: Math.round(chunk.rerankScore * 100),
  //   }))

  //   // Sort by score descending
  //   scoredFragments.sort((a, b) => b.score - a.score)

  //   Logger.info(
  //     {
  //       fragmentCount: fragments.length,
  //       rerankedCount: scoredFragments.length,
  //       topScore: scoredFragments[0]?.score,
  //       bottomScore: scoredFragments[scoredFragments.length - 1]?.score,
  //     },
  //     "[Fragment Ranking] Reranker-based ranking completed"
  //   )

  //   return scoredFragments
  // } catch (error) {
  //   const errorMessage = error instanceof Error ? error.message : String(error)
  //   Logger.error(
  //     { error: errorMessage, fragmentCount: fragments.length, query: query.substring(0, 200) },
  //     "[Fragment Ranking] Reranker failed, falling back to Vespa confidence"
  //   )
  //   return fallbackToVespaConfidence(fragments)
  // }
}

// ============================================================================
// Fallback
// ============================================================================

/**
 * Sort by Vespa confidence score (used when LLM ranking fails or set is tiny)
 */
function fallbackToVespaConfidence(
  fragments: MinimalAgentFragment[],
): ScoredFragment[] {
  return fragments
    .map((fragment) => ({
      fragment,
      score: Math.round((fragment.confidence || 0) * 100),
    }))
    .sort((a, b) => b.score - a.score)
}

// ============================================================================
// Context block builder
// ============================================================================

/**
 * Build a context block string from scored fragments for injection before
 * each LLM call. Shows top N fragments with real content so the agent can
 * reason about what was found this turn.
 */
export function buildRankedContextBlock(
  scoredFragments: ScoredFragment[],
  topN: number = 20,
  maxContentChars: number = 800,
): string {
  if (scoredFragments.length === 0) return ""

  const top = scoredFragments.slice(0, topN)

  const lines: string[] = [
    "# RANKED SEARCH RESULTS",
    `Top ${top.length} of ${scoredFragments.length} fragments, ranked by relevance to your query.`,
    "",
  ]

  for (let i = 0; i < top.length; i++) {
    const { fragment, score } = top[i]
    const title = fragment.source?.title || "Unknown"
    const app = fragment.source?.app || "unknown"
    const entity = fragment.source?.entity || "document"
    const docId = fragment.source?.docId || fragment.id || "unknown"

    lines.push(`## [${i + 1}] ${title} — Relevance: ${score}/100`)
    lines.push(`${app} ${entity} | DocID: ${docId}`)
    lines.push("")

    const content = fragment.content || "No content"
    const truncated =
      content.length > maxContentChars
        ? content.substring(0, maxContentChars) + "…"
        : content
    lines.push(truncated)
    lines.push("")
    lines.push("---")
    lines.push("")
  }

  return lines.join("\n")
}
