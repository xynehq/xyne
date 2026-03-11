/**
 * turn-lifecycle.ts — Turn-End Processing Pipeline
 *
 * Consolidates ALL post-turn processing into a single, ordered pipeline:
 *
 *   1. SKIP CHECK — Was this a no-op turn (only toDoWrite, no execution tools)?
 *      If so, skip review and ranking entirely to save latency.
 *
 *   2. BATCH FRAGMENT RANKING — Collect all unranked fragments from all tools
 *      that ran this turn, run a SINGLE ranking LLM call to select the best
 *      documents, then record them into context.
 *
 *   3. REVIEW — Run the review LLM exactly ONCE per eligible
 *      turn. This is the ONLY place reviews happen — no duplicate reviews from
 *      event handlers.
 *
 *   4. CLEANUP — Finalize turn images, reset turn artifacts, flush expectations.
 *
 * Why this module exists:
 *   - The old architecture had reviews triggered from 3 separate places
 *     (onTurnEnd, turn_end event, run_end event), causing duplicate reviews.
 *   - Fragment ranking ran per-tool inside afterToolExecutionHook, causing
 *     N LLM calls per turn (one per tool). Now it's batched into 1 call.
 *   - No-op turns (only toDoWrite) wasted latency on review LLM calls
 *     with nothing to review.
 *
 * This module owns the entire turn-end lifecycle. The event handlers in
 * the main agent loop (turn_end, run_end) should NOT run reviews — they
 * only handle persistence and SSE streaming.
 */

import type {
  AgentRunContext,
  AutoReviewInput,
  CurrentTurnArtifacts,
  ReviewResult,
  ToolExpectationAssignment,
  UnrankedFragmentWithToolContext,
} from "./agent-schemas"
import type { MinimalAgentFragment, FragmentImageReference } from "./types"
import type { ReasoningEmitter } from "./reasoning-steps"
import { ReasoningSteps, emitReasoningEvent } from "./reasoning-steps"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Chat)

// ============================================================================
// TYPES
// ============================================================================

export interface TurnEndPipelineConfig {
  /** The turn number that just ended */
  turn: number
  /** Function to run the review LLM and broadcast results */
  runReview: (
    context: AgentRunContext,
    input: AutoReviewInput,
    turn: number
  ) => Promise<ReviewResult | null>
  /** Function to handle review outcome (update context state) */
  handleReviewOutcome: (
    context: AgentRunContext,
    result: ReviewResult,
    turn: number,
    focus: AutoReviewInput["focus"],
    emitter?: ReasoningEmitter
  ) => Promise<void>
  /** Function to rank and select best fragments (batch LLM call). Receives enriched list with tool name and query per fragment. */
  rankFragments: (
    context: AgentRunContext,
    allUnrankedWithToolContext: UnrankedFragmentWithToolContext[],
    turn: number,
    emitter?: ReasoningEmitter
  ) => Promise<MinimalAgentFragment[]>
  /** Build review input for the turn range */
  buildReviewInput: (
    turn: number,
    reviewFreq: number
  ) => AutoReviewInput
  /** Get expectation history for a specific turn */
  getExpectationsForTurn: (turn: number) => ToolExpectationAssignment[]
  /** When false, skip batch fragment ranking (filtering) this turn. Default true. */
  useAgenticFiltering?: boolean
  /** Review frequency (review every N turns) */
  reviewFrequency: number
  /** Minimum turn number (usually 0) */
  minTurnNumber: number
  /** Build a default "ok" review payload */
  buildDefaultReview: (notes?: string) => ReviewResult
  /** Reasoning event emitter */
  emitter?: ReasoningEmitter
  /** Flush pending expectations */
  flushExpectations: () => void
  /** Finalize turn images into context */
  finalizeTurnImages: (context: AgentRunContext, turn: number) => void
  /** Reset current turn artifacts */
  resetTurnArtifacts: (context: AgentRunContext) => void
  /** Clear attachment phase metadata if needed */
  clearAttachmentPhase: (context: AgentRunContext) => void
}

export interface TurnEndResult {
  /** Whether a review was executed this turn */
  reviewExecuted: boolean
  /** Whether fragment ranking was executed this turn */
  rankingExecuted: boolean
  /** Whether this was a no-op turn (skipped review + ranking) */
  wasNoOpTurn: boolean
  /** Number of fragments ranked (0 if skipped) */
  fragmentsRanked: number
  /** Review result if review was executed */
  reviewResult: ReviewResult | null
}

// ============================================================================
// PIPELINE
// ============================================================================

/**
 * The single entry point for ALL turn-end processing.
 *
 * Call this from the JAF `onTurnEnd` hook and NOWHERE ELSE.
 * The turn_end and run_end event handlers should NOT do reviews.
 */
export async function runTurnEndPipeline(
  context: AgentRunContext,
  config: TurnEndPipelineConfig
): Promise<TurnEndResult> {
  const { turn, emitter } = config
  const result: TurnEndResult = {
    reviewExecuted: false,
    rankingExecuted: false,
    wasNoOpTurn: false,
    fragmentsRanked: 0,
    reviewResult: null,
  }

  try {
    // ────────────────────────────────────────────────────────────────────
    // Gate: Is review locked by final synthesis for this turn?
    // ────────────────────────────────────────────────────────────────────
    if (
      context.review.lockedByFinalSynthesis &&
      context.review.lockedAtTurn === turn
    ) {
      Logger.info(
        {
          turn,
          chatId: context.chat.externalId,
          lockedAtTurn: context.review.lockedAtTurn,
        },
        "[TurnLifecycle] Review locked by final synthesis — skipping pipeline."
      )
      return result
    }

    // ────────────────────────────────────────────────────────────────────
    // Step 1: No-op turn detection
    // ────────────────────────────────────────────────────────────────────
    const artifacts = context.currentTurnArtifacts
    const isNoOpTurn =
      artifacts.executionToolsCalled === 0 && artifacts.todoWriteCalled

    if (isNoOpTurn) {
      Logger.debug(
        { turn, chatId: context.chat.externalId },
        "[TurnLifecycle] No-op turn (only toDoWrite) — skipping review and ranking."
      )
      result.wasNoOpTurn = true
      // Still do cleanup
      return result
    }

    // ────────────────────────────────────────────────────────────────────
    // Steps 2 & 3: Batch fragment ranking + Review (parallel)
    //
    // These are independent LLM calls — ranking reads unranked fragments
    // while review reads toolCallHistory/plan. Running them concurrently
    // saves one full LLM round-trip per turn.
    // ────────────────────────────────────────────────────────────────────

    const rankingPromise = buildRankingTask(context, artifacts, config, turn, emitter)
    const reviewPromise = buildReviewTask(context, config, turn, emitter)

    const [rankingResult, reviewResult] = await Promise.all([
      rankingPromise,
      reviewPromise,
    ])

    if (rankingResult) {
      result.rankingExecuted = true
      result.fragmentsRanked = rankingResult.count
    }
    if (reviewResult) {
      result.reviewExecuted = true
      result.reviewResult = reviewResult.result
    }

    return result
  } catch (error) {
    Logger.error(
      {
        turn,
        chatId: context.chat.externalId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[TurnLifecycle] Turn-end pipeline failed"
    )
    return result
  } finally {
    // ────────────────────────────────────────────────────────────────────
    // Step 4: Cleanup (always runs, even on error)
    // ────────────────────────────────────────────────────────────────────
    config.clearAttachmentPhase(context)
    config.flushExpectations()
    config.finalizeTurnImages(context, turn)
    config.resetTurnArtifacts(context)
  }
}

// ============================================================================
// HELPERS
// ============================================================================

const MIN_REVIEW_FREQUENCY = 2
const MAX_REVIEW_FREQUENCY = 10
const DEFAULT_REVIEW_FREQUENCY = 5

function normalizeReviewFrequency(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < MIN_REVIEW_FREQUENCY) {
    return DEFAULT_REVIEW_FREQUENCY
  }
  return Math.min(MAX_REVIEW_FREQUENCY, Math.floor(n))
}

/**
 * Check if a turn had any meaningful work done (execution tools called).
 * Used by external callers to decide if they need to wait for the pipeline.
 */
export function wasMeaningfulTurn(artifacts: CurrentTurnArtifacts): boolean {
  return artifacts.executionToolsCalled > 0
}

/**
 * Check if a turn was plan-only (toDoWrite called but no execution tools).
 */
export function wasPlanOnlyTurn(artifacts: CurrentTurnArtifacts): boolean {
  return artifacts.todoWriteCalled && artifacts.executionToolsCalled === 0
}

// ============================================================================
// PARALLEL TASK BUILDERS
// ============================================================================

async function buildRankingTask(
  context: AgentRunContext,
  artifacts: CurrentTurnArtifacts,
  config: TurnEndPipelineConfig,
  turn: number,
  emitter?: ReasoningEmitter,
): Promise<{ count: number } | null> {
  if (config.useAgenticFiltering === false) return null

  const allUnrankedWithToolContext: UnrankedFragmentWithToolContext[] = []
  for (const [toolKey , { query, fragments }] of artifacts.unrankedFragmentsByTool.entries()) {
    const toolName = toolKey.substring(0, toolKey.indexOf(':'))
    for (const fragment of fragments) {
      allUnrankedWithToolContext.push({ fragment, toolName, toolQuery: query })
    }
  }

  if (allUnrankedWithToolContext.length === 0) return null

  Logger.debug(
    {
      turn,
      chatId: context.chat.externalId,
      totalUnranked: allUnrankedWithToolContext.length,
      toolCount: artifacts.unrankedFragmentsByTool.size,
    },
    "[TurnLifecycle] Running batch fragment ranking."
  )

  const ranked = await config.rankFragments(context, allUnrankedWithToolContext, turn, emitter)
  return { count: ranked.length }
}

async function buildReviewTask(
  context: AgentRunContext,
  config: TurnEndPipelineConfig,
  turn: number,
  emitter?: ReasoningEmitter,
): Promise<{ result: ReviewResult | null } | null> {
  const reviewFreq = normalizeReviewFrequency(config.reviewFrequency)
  const shouldReview =
    context.review.lastReviewTurn === null || turn - (context.review.lastReviewTurn ?? 0) >= reviewFreq

  if (shouldReview) {
    await emitReasoningEvent(emitter, ReasoningSteps.reviewStarted(turn))
    const reviewInput = config.buildReviewInput(turn, reviewFreq)
    const reviewResult = await config.runReview(context, reviewInput, turn)
    if (reviewResult === null) return null
    return { result: reviewResult }
  }

  Logger.debug(
    {
      turn,
      reviewFrequency: reviewFreq,
      chatId: context.chat.externalId,
    },
    "[TurnLifecycle] Review skipped (runs every N turns)."
  )
  return null
}
