import type { ReasoningEmitter } from "@/api/chat/reasoning-steps"
import { ReasoningSteps } from "@/api/chat/reasoning-steps"
import type { MinimalAgentFragment } from "@/api/chat/types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent"
import type { XyneAgentState } from "./adapter"
import { toolEventRegistry } from "./tool-event-mapper/index"

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

export default function xyneExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
    const state = extensionStateRef
    if (!state) return undefined

    const { xyneState, emitReasoningStep } = state
    const attachmentContext = xyneState.attachmentContext

    // If no attachment context or no fragments, return undefined (no-op)
    if (!attachmentContext || attachmentContext.fragments.length === 0) {
      return undefined
    }

    // Push fragments into allFragments for citation tracking
    xyneState.allFragments.push(...attachmentContext.fragments)

    // Emit reasoning event for attachment extraction
    await emitReasoningStep(
      ReasoningSteps.attachmentExtracted(attachmentContext.fragments.length),
    )
    const startIndex = xyneState.allFragments.length + 1
    const fragmentCount = attachmentContext.fragments.length

    const textFragments = attachmentContext.fragments
      .map((fragment: { content: string }, index: number) => {
        const citationIndex = startIndex + index
        return `citationDocId: ${citationIndex} \n ${fragment.content}`
      })
      .join("\n\n")

    attachmentContext.fragments.forEach(
      (fragment: { id: string }, idx: number) => {
        const citationDocId = startIndex + idx
        xyneState.citationDocIdMapping.set(citationDocId, fragment.id)
      },
    )

    xyneState.attachmentContext = undefined

    return {
      message: {
        customType: "attachment_context",
        content: textFragments,
        display: false,
        details: { fragmentCount },
      },
    }
  })

  pi.on(
    "tool_call",
    async (event: ToolCallEvent): Promise<ToolCallEventResult | undefined> => {
      const state = extensionStateRef
      if (!state) return

      return toolEventRegistry.handleToolCall(event, {
        emitReasoningStep: state.emitReasoningStep,
        xyneState: state.xyneState,
        sendSteerMessage: (msg: string) =>
          pi.sendUserMessage(msg, { deliverAs: "steer" }),
      })
    },
  )

  pi.on("tool_result", async (event: ToolResultEvent) => {
    const state = extensionStateRef
    if (!state) return

    await toolEventRegistry.handleToolResult(event, {
      emitReasoningStep: state.emitReasoningStep,
      xyneState: state.xyneState,
    })

    const details = event.details as Record<string, unknown> | undefined

    if (details?.fragments && Array.isArray(details.fragments)) {
      const fragments = details.fragments as MinimalAgentFragment[]
      state.xyneState.allFragments.push(...fragments)

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

    return {
      content: event.content,
      details: event.details,
      isError: event.isError,
    }
  })
}
