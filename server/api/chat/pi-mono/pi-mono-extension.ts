/**
 * Pi-Mono Extension for Xyne
 *
 * Handles tool interception, fragment processing, and review execution.
 * Uses pi-mono's ExtensionAPI for blocking/modifying tool calls.
 */

import { ReasoningSteps, emitReasoningEvent } from "@/api/chat/reasoning-steps"
import type { ReasoningEmitter } from "@/api/chat/reasoning-steps"
import type { MinimalAgentFragment } from "@/api/chat/types"
import { getLogger } from "@/logger"
import { XyneTools } from "@/shared/types"
import { Subsystem } from "@/types"
import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent"
import type { XyneAgentState } from "./adapter"

const Logger = getLogger(Subsystem.Chat)

// Non-critical tools whose failures should not trigger review
const NON_CRITICAL_TOOLS = new Set([
  XyneTools.toDoWrite,
  // Note: synthesizeFinalAnswer removed - agent now responds directly
])

const MAX_TOOL_FAILURES_PER_TURN = 3
const MAX_DISTINCT_FAILED_TOOLS = 2
const STAGNATION_WINDOW = 2

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

// Global state ref - required because extensions are factory functions
let extensionStateRef: ExtensionState | null = null

export function setExtensionState(state: ExtensionState): void {
  extensionStateRef = state
}

export function getExtensionState(): ExtensionState | null {
  return extensionStateRef
}

export function clearExtensionState(): void {
  extensionStateRef = null
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
/**
 * Xyne Pi-Mono Extension
 *
 * Intercepts tool calls to merge excludedIds, processes fragments immediately,
 * and runs review at turn end.
 */
export default function xyneExtension(pi: ExtensionAPI) {
  // Track accumulators for turn-end processing
  const pendingFragments: MinimalAgentFragment[] = []
  const toolExecutions: any[] = []
  let executionToolsCalled = 0
  let todoWriteCalled = false

  // === TOOL CALL INTERCEPTION (Blocking) ===
  pi.on("tool_call", async (event: ToolCallEvent) => {})

  pi.on("tool_result", async (event: ToolResultEvent) => {
    const state = extensionStateRef
    if (!state) return

    const details = event.details as Record<string, unknown> | undefined
    if (details?.fragments && Array.isArray(details.fragments)) {
      const fragments = details.fragments as MinimalAgentFragment[]

      const startIndex = (details.startIndex as number) || 1
      fragments.forEach((fragment, idx) => {
        const docId = fragment.source?.docId
        const returnedChunks = fragment.source?.returnedChunkIndices

        if (docId && returnedChunks && returnedChunks.length > 0) {
          // Track the specific chunks that were actually returned in the content
          returnedChunks.forEach((chunkIdx) => {
            const chunkKey = `${docId}_${chunkIdx}`
            state.xyneState.seenChunks.add(chunkKey)
          })
        }

        const citationDocId = startIndex + idx
        state.xyneState.citationDocIdMapping.set(citationDocId, fragment.id)
      })
    }

    // Track tool execution for review
    toolExecutions.push({
      toolName: event.toolName,
      status: event.isError ? "error" : "success",
      arguments: (event as any).args || {},
      error: event.isError ? { message: "Tool execution failed" } : undefined,
    })

    // Return modified result
    return {
      content: event.content,
      details: event.details,
      isError: event.isError,
    }
  })

  // === TURN END PROCESSING ===
  pi.on("turn_end", async (event) => {})
  /**
   * Cleanup function - mirrors JAF's cleanup
   */
  function cleanupTurn(context: XyneAgentState, turn: number): void {
    // Clear attachment phase metadata
    const metadata = context.chat.metadata as any
    if (metadata?.initialAttachmentPhase) {
      context.chat.metadata = { ...metadata, initialAttachmentPhase: false }
    }

    // Finalize images from this turn
    const imagesToFinalize = context.currentTurnArtifacts.images.filter(
      (img) => img.addedAtTurn === turn,
    )
    imagesToFinalize.forEach((img) => {
      if (
        !context.allImages.some(
          (existing) => existing.fileName === img.fileName,
        )
      ) {
        context.allImages.push(img)
      }
    })

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
