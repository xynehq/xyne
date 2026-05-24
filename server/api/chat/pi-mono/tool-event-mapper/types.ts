import type { ReasoningEmitter } from "@/api/chat/reasoning-steps"
import type { MinimalAgentFragment } from "@/api/chat/types"
import type { PlanSubTask } from "@/shared/types"
import type {
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent"
import type { XyneAgentState } from "../adapter"

export interface ToolCallContext {
  emitReasoningStep: ReasoningEmitter
  xyneState: XyneAgentState

  sendSteerMessage?: (message: string) => void
}

export interface ToolHandler {
  /** The tool name this handler responds to. Must match the pi-mono tool name. */
  readonly toolName: string

  /**
   * Whether this handler processes error results itself.
   * When `false` (default), errors bypass the handler and use the default
   * fallback which emits a generic `toolCompleted` event with the error flag.
   * Set to `true` if the handler needs custom error-handling logic.
   */
  readonly handlesErrors?: boolean

  onToolCall?(
    event: ToolCallEvent,
    context: ToolCallContext,
  ): Promise<ToolCallEventResult | undefined>

  onToolResult(event: ToolResultEvent, context: ToolCallContext): Promise<void>
}

export interface SearchKBDetails {
  query?: string
  filters?: unknown
  fragments?: MinimalAgentFragment[]
  topFragmentSummary?: string
  startIndex?: number
}

export interface ToDoWriteDetails {
  plan?: {
    goal: string
    subTasks: PlanSubTask[]
  }
}
