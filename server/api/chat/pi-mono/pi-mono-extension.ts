/**
 * Pi-Mono Extension for Turn-End Processing
 *
 * This extension properly hooks into the agent loop and blocks
 * the next turn until all async processing (ranking, review) completes.
 *
 * Mirrors JAF's runTurnEndPipeline behavior:
 * - No-op/reasoning-only turn detection
 * - Batch fragment ranking
 * - Review with failure/time/stagnation triggers
 * - Cleanup (images, expectations, artifacts, attachment phase)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import type { XyneAgentState } from "./adapter"
import {
  buildTurnReviewInput,
  performAutomaticReview,
  handleReviewOutcome,
} from "./review"
import {
  rankFragmentsByMetadataConstraints,
  extractMetadataConstraintsFromUserMessage,
} from "@/api/chat/message-agents-metadata"
import { ReasoningSteps, emitReasoningEvent } from "@/api/chat/reasoning-steps"
import type { MinimalAgentFragment } from "@/api/chat/types"
import type { ReasoningEmitter } from "@/api/chat/reasoning-steps"
import { XyneTools } from "@/shared/types"

const Logger = getLogger(Subsystem.Chat)

/**
 * State passed from the main session to the extension
 */
interface ExtensionState {
  xyneState: XyneAgentState
  currentTurn: { value: number }
  agenticModelId: string
  message: string
  email: string
  emitReasoningStep: ReasoningEmitter
}

// Store state reference - set by main session before creating extension
let extensionStateRef: ExtensionState | null = null

export function setExtensionState(state: ExtensionState) {
  extensionStateRef = state
}

export function clearExtensionState() {
  extensionStateRef = null
}

// Non-critical tools whose failures should not trigger review
const NON_CRITICAL_TOOLS = new Set([
  XyneTools.toDoWrite,
  XyneTools.synthesizeFinalAnswer,
])

const MAX_TOOL_FAILURES_PER_TURN = 3
const MAX_DISTINCT_FAILED_TOOLS = 2
const STAGNATION_WINDOW = 2

/**
 * Check if review should be triggered due to tool failures
 */
function hasCurrentTurnFailure(toolOutputs: any[]): boolean {
  let failedCount = 0
  const distinctFailedTools = new Set<string>()

  for (const t of toolOutputs) {
    if (
      t.status === "error" &&
      !NON_CRITICAL_TOOLS.has(t.toolName as XyneTools)
    ) {
      failedCount++
      distinctFailedTools.add(t.toolName)
    }
  }

  if (failedCount === 0) return false

  return (
    failedCount >= MAX_TOOL_FAILURES_PER_TURN ||
    distinctFailedTools.size >= MAX_DISTINCT_FAILED_TOOLS
  )
}

/**
 * Check for stagnation - no useful fragments ranked for N consecutive turns
 */
function hasStagnation(context: XyneAgentState, currentTurn: number): boolean {
  const turnNumbersWithToolCalls = [
    ...new Set(context.toolCallHistory.map((r) => r.turnNumber)),
  ].sort((a, b) => b - a)
  const lastNTurns = turnNumbersWithToolCalls.slice(0, STAGNATION_WINDOW)
  if (lastNTurns.length < STAGNATION_WINDOW) return false
  if (lastNTurns[0] !== currentTurn) return false
  const allZeroRanked = lastNTurns.every(
    (t) => (context.turnFragments.get(t)?.length ?? 0) === 0,
  )
  return allZeroRanked
}

/**
 * Finalize turn images into context
 */
function finalizeTurnImages(context: XyneAgentState, turn: number): void {
  const imagesToFinalize = context.currentTurnArtifacts.images.filter(
    (img) => img.addedAtTurn === turn,
  )

  if (imagesToFinalize.length === 0) return

  for (const img of imagesToFinalize) {
    // Mark as permanent by adding to allImages if not already there
    const exists = context.allImages.some(
      (existing) => existing.fileName === img.fileName,
    )
    if (!exists) {
      context.allImages.push(img)
    }
  }

  Logger.debug(
    { turn, imageCount: imagesToFinalize.length },
    "[Pi-Mono Extension] Finalized turn images",
  )
}

/**
 * Clear attachment phase metadata after first turn
 */
function clearAttachmentPhase(context: XyneAgentState): void {
  const metadata = context.chat.metadata as any
  if (metadata?.initialAttachmentPhase) {
    context.chat.metadata = {
      ...metadata,
      initialAttachmentPhase: false,
    }
    Logger.debug(
      { chatId: context.chat.externalId },
      "[Pi-Mono Extension] Cleared attachment phase",
    )
  }
}

/**
 * Pi-Mono Turn Processor Extension
 *
 * This extension accumulates tool results during a turn and processes
 * them at turn_end, blocking the next turn until complete.
 */
export default function piMonoTurnProcessor(pi: ExtensionAPI) {
  // Accumulate unranked fragments during the turn
  const pendingFragments: MinimalAgentFragment[] = []

  // Track tool executions for review
  const toolExecutions: any[] = []

  // Track execution tools vs todoWrite for no-op detection
  let executionToolsCalled = 0
  let todoWriteCalled = false

  // Collect fragments from tool results
  pi.on("tool_execution_end", async (event, ctx) => {
    const state = extensionStateRef
    if (!state) return

    const result = event.result

    // Track tool types for no-op detection
    if (event.toolName === XyneTools.toDoWrite) {
      todoWriteCalled = true
    } else if (!NON_CRITICAL_TOOLS.has(event.toolName as XyneTools)) {
      executionToolsCalled++
    }

    if (result?.details?.fragments && Array.isArray(result.details.fragments)) {
      pendingFragments.push(...result.details.fragments)

      Logger.debug(
        {
          toolName: event.toolName,
          fragmentsAdded: result.details.fragments.length,
          totalPending: pendingFragments.length,
        },
        "[Pi-Mono Extension] Collected fragments from tool",
      )
    }

    // Track tool execution for review
    toolExecutions.push({
      toolName: event.toolName,
      status: event.isError ? "error" : "success",
      arguments: (event as any).args || {},
      error: event.isError
        ? { message: result?.error || "Unknown error" }
        : undefined,
    })
  })

  // Process everything at turn end - this BLOCKS the next turn
  pi.on("turn_end", async (event, ctx) => {
    const state = extensionStateRef
    if (!state) {
      Logger.warn("[Pi-Mono Extension] No state available for turn_end")
      return
    }

    const {
      xyneState,
      currentTurn,
      agenticModelId,
      message,
      email,
      emitReasoningStep,
    } = state
    const turnIndex = currentTurn.value

    Logger.info(
      {
        turn: turnIndex,
        pendingFragments: pendingFragments.length,
        executionToolsCalled,
        todoWriteCalled,
      },
      "[Pi-Mono Extension] turn_end started - processing will block next turn",
    )

    // ────────────────────────────────────────────────────────────────────
    // Gate: Is review locked by final synthesis for this turn?
    // ────────────────────────────────────────────────────────────────────
    if (
      xyneState.review.lockedByFinalSynthesis &&
      xyneState.review.lockedAtTurn === turnIndex
    ) {
      Logger.info(
        {
          turn: turnIndex,
          chatId: xyneState.chat.externalId,
          lockedAtTurn: xyneState.review.lockedAtTurn,
        },
        "[Pi-Mono Extension] Review locked by final synthesis — skipping pipeline.",
      )

      // Still do cleanup
      cleanupTurn(xyneState, turnIndex)
      return
    }

    try {
      // ────────────────────────────────────────────────────────────────────
      // Step 1: No-op / reasoning-only turn detection
      //
      // Skip review and ranking when:
      // - No-op: only toDoWrite was called (plan-only turn).
      // - Reasoning-only: no tools at all (agent answered from context).
      // ────────────────────────────────────────────────────────────────────
      const isNoOpTurn = executionToolsCalled === 0 && todoWriteCalled
      const isReasoningOnlyTurn = executionToolsCalled === 0 && !todoWriteCalled

      if (isNoOpTurn) {
        Logger.debug(
          { turn: turnIndex, chatId: xyneState.chat.externalId },
          "[Pi-Mono Extension] No-op turn (only toDoWrite) — skipping review and ranking.",
        )
        cleanupTurn(xyneState, turnIndex)
        return
      }

      if (isReasoningOnlyTurn) {
        Logger.debug(
          { turn: turnIndex, chatId: xyneState.chat.externalId },
          "[Pi-Mono Extension] Reasoning-only turn (no tool calls) — skipping review and ranking.",
        )
        cleanupTurn(xyneState, turnIndex)
        return
      }

      // ────────────────────────────────────────────────────────────────────
      // Step 2: Batch fragment ranking (must complete before review)
      // ────────────────────────────────────────────────────────────────────
      if (pendingFragments.length > 0) {
        Logger.info(
          { fragmentCount: pendingFragments.length },
          "[Pi-Mono Extension] Ranking fragments",
        )

        const metadataConstraints =
          extractMetadataConstraintsFromUserMessage(message)
        const { rankedCandidates } = rankFragmentsByMetadataConstraints(
          pendingFragments,
          metadataConstraints,
        )

        const bestFragments = rankedCandidates
          .filter((c) => c.compliant)
          .map((c) => c.fragment)

        if (bestFragments.length > 0) {
          xyneState.allFragments.push(...bestFragments)
          // Also record for turnFragments tracking (for stagnation detection)
          xyneState.turnFragments.set(turnIndex, bestFragments)
          await emitReasoningEvent(
            emitReasoningStep,
            ReasoningSteps.documentsFiltered(bestFragments.length),
          )
          Logger.info(
            { rankedCount: bestFragments.length },
            "[Pi-Mono Extension] Fragments ranked and added",
          )
        } else if (!metadataConstraints.strict) {
          xyneState.allFragments.push(...pendingFragments)
          xyneState.turnFragments.set(turnIndex, pendingFragments)
          await emitReasoningEvent(
            emitReasoningStep,
            ReasoningSteps.documentsFiltered(pendingFragments.length),
          )
          Logger.info(
            { fallbackCount: pendingFragments.length },
            "[Pi-Mono Extension] Fragments added (fallback)",
          )
        }
      }

      // ────────────────────────────────────────────────────────────────────
      // Step 3: Review (runs after ranking so context.allFragments is up to date)
      // ────────────────────────────────────────────────────────────────────

      // Add accumulated tool executions to history for review
      toolExecutions.forEach((exec) => {
        xyneState.toolCallHistory.push({
          ...exec,
          turnNumber: turnIndex,
          startedAt: new Date(),
          durationMs: 0,
          estimatedCostUsd: 0,
        })
      })

      // Calculate review triggers (matching JAF)
      const reviewFreq = xyneState.review?.reviewFrequency || 5
      const failureTrigger = hasCurrentTurnFailure(toolExecutions)
      const timeTrigger =
        xyneState.review.lastReviewTurn === null ||
        turnIndex - (xyneState.review.lastReviewTurn ?? 0) >= reviewFreq
      const stagnationTrigger = hasStagnation(xyneState, turnIndex)
      const shouldReview = failureTrigger || timeTrigger || stagnationTrigger

      Logger.info(
        {
          turn: turnIndex,
          reviewFreq,
          shouldReview,
          failureTrigger,
          timeTrigger,
          stagnationTrigger,
          toolExecutions: toolExecutions.length,
        },
        "[Pi-Mono Extension] Review check",
      )

      if (shouldReview) {
        await emitReasoningEvent(
          emitReasoningStep,
          ReasoningSteps.reviewStarted(turnIndex),
        )

        const reviewInput = buildTurnReviewInput(
          xyneState,
          turnIndex,
          reviewFreq,
          0,
        )

        const reviewResult = await performAutomaticReview(
          reviewInput,
          xyneState,
          agenticModelId,
        )

        await handleReviewOutcome(
          xyneState,
          reviewResult,
          turnIndex,
          "turn_end",
          emitReasoningStep,
        )

        Logger.info(
          {
            turn: turnIndex,
            recommendation: reviewResult.recommendation,
            status: reviewResult.status,
          },
          "[Pi-Mono Extension] Review completed",
        )
      } else {
        Logger.debug(
          {
            turn: turnIndex,
            reviewFrequency: reviewFreq,
            failureTrigger,
            timeTrigger,
            stagnationTrigger,
          },
          "[Pi-Mono Extension] Review skipped (no trigger)",
        )
      }

      // ────────────────────────────────────────────────────────────────────
      // Step 4: Cleanup
      // ────────────────────────────────────────────────────────────────────
      cleanupTurn(xyneState, turnIndex)

      Logger.info(
        { turn: turnIndex },
        "[Pi-Mono Extension] turn_end completed - next turn can proceed",
      )
    } catch (error) {
      Logger.error(
        { error, turn: turnIndex },
        "[Pi-Mono Extension] Error in turn_end processing",
      )
      // Still cleanup on error to prevent state corruption
      cleanupTurn(xyneState, turnIndex)
      throw error // Re-throw to prevent agent from continuing with errors
    }
  })

  /**
   * Cleanup function - mirrors JAF's cleanup
   */
  function cleanupTurn(context: XyneAgentState, turn: number): void {
    // Clear attachment phase metadata
    clearAttachmentPhase(context)

    // Finalize images from this turn
    finalizeTurnImages(context, turn)

    // Flush pending expectations
    context.pendingExpectations.length = 0

    // Reset turn artifacts
    context.currentTurnArtifacts.unrankedFragmentsByTool.clear()
    context.currentTurnArtifacts.toolOutputs = []
    context.currentTurnArtifacts.executionToolsCalled = 0
    context.currentTurnArtifacts.todoWriteCalled = false
    context.currentTurnArtifacts.images = []
    context.currentTurnArtifacts.fragments = []
    context.currentTurnArtifacts.expectations = []

    // Clear extension-local accumulators
    pendingFragments.length = 0
    toolExecutions.length = 0
    executionToolsCalled = 0
    todoWriteCalled = false

    Logger.debug({ turn }, "[Pi-Mono Extension] Cleanup completed")
  }

  Logger.info("[Pi-Mono Extension] Registered")
}
