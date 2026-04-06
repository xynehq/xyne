/**
 * Pi-Mono Extension for Turn-End Processing
 *
 * CRITICAL ARCHITECTURAL NOTE:
 * This extension uses the SDK's blocking `context` event for review work
 * because `turn_end` does NOT block the agent loop.
 *
 * Fragment flow:
 * - Tools return fragments in result.details.fragments (not stored in state)
 * - context handler: Collects, ranks, and injects relevant fragments
 * - allFragments accumulates all fragments (for synthesis)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import type { XyneAgentState } from "./adapter"

import {
  buildTurnReviewInput,
  performAutomaticReview,
  handleReviewOutcome,
  buildReviewSteeringMessage,
} from "./review"
import { ReasoningSteps, emitReasoningEvent } from "@/api/chat/reasoning-steps"
import type { MinimalAgentFragment } from "@/api/chat/types"
import type { FragmentImageReference } from "@/api/chat/types"
import type { ReasoningEmitter } from "@/api/chat/reasoning-steps"
import { XyneTools } from "@/shared/types"
import { mergeFragmentLists } from "./fragment-utils"
import config from "@/config"
import {
  rankFragmentsByRelevance,
  buildRankedContextBlock,
} from "./fragment-ranking"

const Logger = getLogger(Subsystem.Chat)
const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

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
  setSystemPrompt?: (prompt: string) => void
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

// Search tools that provide fragments for ranking
const SEARCH_TOOLS = new Set([
  XyneTools.searchGlobal,
  XyneTools.searchKnowledgeBase,
  XyneTools.searchGmail,
  XyneTools.searchDriveFiles,
  XyneTools.searchChatHistory,
])

const MAX_TOOL_FAILURES_PER_TURN = 3
const MAX_DISTINCT_FAILED_TOOLS = 2
const STAGNATION_WINDOW = 2
const MAX_TURNS = 40

// Minimum relevance score (0-100) for fragments to be included in context
const MIN_RELEVANCE_SCORE = 50

/**
 * Check if a tool is a search tool that provides fragments
 */
function isSearchTool(toolName: string): boolean {
  return SEARCH_TOOLS.has(toolName as XyneTools)
}

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
 * Perform turn review
 */
async function performTurnReview(
  xyneState: XyneAgentState,
  turnIndex: number,
  toolExecutions: any[],
  agenticModelId: string,
  emitReasoningStep: ReasoningEmitter,
): Promise<boolean> {
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

  if (!shouldReview) {
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
    return false
  }

  await emitReasoningEvent(
    emitReasoningStep,
    ReasoningSteps.reviewStarted(turnIndex),
  )

  const reviewInput = buildTurnReviewInput(xyneState, turnIndex, reviewFreq, 0)

  const reviewResult = await performAutomaticReview(
    reviewInput,
    xyneState,
    agenticModelId,
  )

  const MAX_CONSECUTIVE_GATHER_MORE = 10
  if (reviewResult.recommendation === "gather_more") {
    xyneState.review.consecutiveGatherMore =
      (xyneState.review.consecutiveGatherMore || 0) + 1
    if (xyneState.review.consecutiveGatherMore >= MAX_CONSECUTIVE_GATHER_MORE) {
      Logger.warn(
        {
          turn: turnIndex,
          consecutiveGatherMore: xyneState.review.consecutiveGatherMore,
        },
        "[Pi-Mono Extension] Consecutive gather_more limit reached — overriding to proceed with synthesis",
      )
      reviewResult.recommendation = "proceed"
      reviewResult.planChangeNeeded = true
      reviewResult.planChangeReason = `After ${xyneState.review.consecutiveGatherMore} consecutive search rounds without finding new information, proceed to synthesize the answer from evidence already gathered.`
      reviewResult.notes =
        (reviewResult.notes || "") +
        " [AUTO-OVERRIDE: Consecutive gather_more limit reached.]"
      xyneState.review.consecutiveGatherMore = 0
    }
  } else {
    xyneState.review.consecutiveGatherMore = 0
  }

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

  return true
}

/**
 * Pi-Mono Turn Processor Extension
 */
export default function piMonoTurnProcessor(pi: ExtensionAPI) {
  const toolExecutions: any[] = []
  let executionToolsCalled = 0
  let todoWriteCalled = false
  let needsProcessing = false
  let currentProcessingTurn = 0

  /**
   * Get fragments from the PREVIOUS turn's tool executions
   * Context fires at turn start, so we rank fragments from turnIndex-1
   */
  function getPreviousTurnFragments(
    xyneState: XyneAgentState,
    currentTurn: number,
  ): MinimalAgentFragment[] {
    const previousTurn = currentTurn - 1
    if (previousTurn < 0) return []

    // Only return fragments if we haven't ranked this turn yet
    if (previousTurn <= xyneState.lastRankedTurn) return []

    return xyneState.turnFragments.get(previousTurn) || []
  }

  pi.on("context", async (event, ctx) => {
    const state = extensionStateRef
    if (!state) return

    const {
      xyneState,
      currentTurn,
      agenticModelId,
      message,
      email,
      emitReasoningStep,
    } = state
    const turnIndex = currentTurn.value

    const isFinalSynthesisActive =
      xyneState.finalSynthesis?.requested || xyneState.finalSynthesis?.completed

    const maxTurnsExceeded =
      turnIndex >= MAX_TURNS && !xyneState.finalSynthesis?.requested

    if (maxTurnsExceeded) {
      Logger.warn(
        {
          turn: turnIndex,
          maxTurns: MAX_TURNS,
          chatId: xyneState.chat.externalId,
        },
        "[Pi-Mono Extension] Max turns exceeded - forcing synthesis",
      )

      const modifiedMessages = [...event.messages]
      modifiedMessages.push({
        role: "system",
        content: `MAX_TURNS_REACHED: You have exceeded the maximum turn limit (${MAX_TURNS}). You MUST call synthesizeFinalAnswer NOW with the evidence you have gathered. Do not call any other tools.`,
      } as any)

      return { messages: modifiedMessages }
    }

    if (isFinalSynthesisActive) {
      if (toolExecutions.length > 0) {
        toolExecutions.length = 0
        executionToolsCalled = 0
        todoWriteCalled = false
        needsProcessing = false
      }
      return { messages: event.messages }
    }

    // Get fragments from PREVIOUS turn (context fires at turn start)
    const newFragments = getPreviousTurnFragments(xyneState, turnIndex)

    if (newFragments.length > 0) {
      Logger.info(
        {
          turn: turnIndex,
          previousTurn: turnIndex - 1,
          newFragments: newFragments.length,
        },
        "[Pi-Mono Extension] Retrieved fragments from previous turn",
      )

      // Mark this turn as ranked (ranking and merging now done in tools)
      xyneState.lastRankedTurn = turnIndex - 1

      Logger.info(
        {
          turn: turnIndex,
          newFragments: newFragments.length,
        },
        "[Pi-Mono Extension] Fragments already merged by tools",
      )
    }

    let modifiedMessages = [...event.messages]

    // Move accumulated fragments from previous turn to allFragments
    if (xyneState.currentTurnArtifacts.fragments.length > 0) {
      xyneState.allFragments = mergeFragmentLists(
        xyneState.allFragments,
        xyneState.currentTurnArtifacts.fragments,
      )
      Logger.info(
        {
          turn: turnIndex,
          fragmentsMoved: xyneState.currentTurnArtifacts.fragments.length,
          allFragmentsTotal: xyneState.allFragments.length,
        },
        "[Pi-Mono Extension] Moved turn fragments to allFragments",
      )
    }

    // Reset state-level turn artifacts
    xyneState.currentTurnArtifacts.toolOutputs = []
    xyneState.currentTurnArtifacts.executionToolsCalled = 0
    xyneState.currentTurnArtifacts.todoWriteCalled = false
    xyneState.currentTurnArtifacts.images = []
    xyneState.currentTurnArtifacts.fragments = []
    xyneState.currentTurnArtifacts.expectations = []
    // --- NEW: FORCED SEARCH INJECTION ---
    const originalUserQuery = xyneState.message.text

    if (turnIndex === 4) {
      modifiedMessages.push({
        role: "user",
        content: `TURN_MANDATE: Along with other tools that you will decide to call based on context , You MUST execute a searchKnowledgeBase call this turn using the full original user query: "${originalUserQuery}". Set limit: 20 and offset: 0. This ensures we don't miss any critical chunks from the primary search results.`,
      } as any)
      Logger.info(
        { turn: turnIndex },
        "[Pi-Mono Extension] Injected Turn 3 Search Mandate",
      )
    }
    Logger.info(
      {
        turn: turnIndex,
        allFragmentsCount: xyneState.allFragments.length,
      },
      "[Pi-Mono Extension] Context processing completed",
    )

    return { messages: modifiedMessages }
  })

  pi.on("tool_execution_end", async (event, ctx) => {
    const state = extensionStateRef
    if (!state) return

    const { xyneState, currentTurn } = state
    const result = event.result

    if (event.toolName === XyneTools.toDoWrite) {
      todoWriteCalled = true
    } else if (!NON_CRITICAL_TOOLS.has(event.toolName as XyneTools)) {
      executionToolsCalled++
    }

    toolExecutions.push({
      toolName: event.toolName,
      status: event.isError ? "error" : "success",
      arguments: (event as any).args || {},
      error: event.isError
        ? { message: result?.error || "Unknown error" }
        : undefined,
    })

    if (result?.details?.fragments && Array.isArray(result.details.fragments)) {
      const fragments = result.details.fragments as MinimalAgentFragment[]

      for (const fragment of fragments) {
        const vespaDocId = fragment.source?.docId
        if (vespaDocId != null && vespaDocId !== "") {
          xyneState.seenDocuments.add(vespaDocId)
        }
      }

      const existingForTurn =
        xyneState.turnFragments.get(currentTurn.value) ?? []
      xyneState.turnFragments.set(
        currentTurn.value,
        mergeFragmentLists(existingForTurn, fragments),
      )

      const fragmentImages: FragmentImageReference[] = []
      for (const fragment of fragments) {
        if (fragment.images && fragment.images.length > 0) {
          fragmentImages.push(...fragment.images)
        }
      }
      if (fragmentImages.length > 0) {
        for (const img of fragmentImages) {
          const exists = xyneState.allImages.some(
            (existing) => existing.fileName === img.fileName,
          )
          if (!exists) {
            xyneState.allImages.push(img)
          }
        }
      }

      Logger.debug(
        {
          toolName: event.toolName,
          fragmentsRecorded: fragments.length,
          turn: currentTurn.value,
        },
        "[Pi-Mono Extension] Recorded fragments for turn tracking",
      )
    }
  })

  pi.on("turn_end", async (event, ctx) => {
    const state = extensionStateRef
    if (!state) {
      Logger.warn("[Pi-Mono Extension] No state available for turn_end")
      return
    }

    const { xyneState, currentTurn } = state
    const turnIndex = currentTurn.value

    Logger.debug(
      { turn: turnIndex, executionToolsCalled, todoWriteCalled },
      "[Pi-Mono Extension] turn_end started",
    )

    if (xyneState.review.lockedByFinalSynthesis) {
      toolExecutions.length = 0
      executionToolsCalled = 0
      todoWriteCalled = false
      needsProcessing = false
      cleanupTurn(xyneState, turnIndex)
      return
    }

    const isNoOpTurn = executionToolsCalled === 0 && todoWriteCalled
    const isReasoningOnlyTurn = executionToolsCalled === 0 && !todoWriteCalled

    if (isNoOpTurn || isReasoningOnlyTurn) {
      cleanupTurn(xyneState, turnIndex)
      return
    }

    needsProcessing = true
    currentProcessingTurn = turnIndex

    clearAttachmentPhase(xyneState)
    finalizeTurnImages(xyneState, turnIndex)
    xyneState.pendingExpectations.length = 0

    Logger.info(
      {
        turn: turnIndex,
        needsProcessing: true,
        allFragmentsTotal: xyneState.allFragments.length,
      },
      "[Pi-Mono Extension] turn_end completed",
    )
  })

  function cleanupTurn(context: XyneAgentState, turn: number): void {
    clearAttachmentPhase(context)
    finalizeTurnImages(context, turn)
    context.pendingExpectations.length = 0
    context.currentTurnArtifacts.toolOutputs = []
    context.currentTurnArtifacts.executionToolsCalled = 0
    context.currentTurnArtifacts.todoWriteCalled = false
    context.currentTurnArtifacts.images = []
    // Note: fragments are NOT cleared here - they are moved to allFragments in the context handler
    context.currentTurnArtifacts.expectations = []

    Logger.debug({ turn }, "[Pi-Mono Extension] Cleanup completed")
  }

  Logger.info(
    "[Pi-Mono Extension] Registered with retrieval-driven context processing",
  )
}
