import type { ReasoningEmitter } from "@/api/chat/reasoning-steps"
import type { MinimalAgentFragment } from "@/api/chat/types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type {
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
