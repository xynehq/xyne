import type { SSEStreamingApi } from "hono/streaming"
import type { RunState, RunConfig } from "@xynehq/jaf"

// Interface for active stream with JAF state preservation for HITL
export interface ActiveStreamState {
  stream: SSEStreamingApi
  // HITL: Store interrupted JAF state for resumption
  jafInterruptedState?: RunState<any>
  jafConfig?: RunConfig<any>
  waitingForClarification?: boolean
  // HITL: Callback to resume JAF when clarification is provided
  clarificationCallback?: (
    clarificationId: string,
    selectedOptionId: { selectedOptionId: string; selectedOption: string; customInput?: string },
  ) => void
}

// Map to store active streams: Key = "chatId", Value = ActiveStreamState
export const activeStreams = new Map<string, ActiveStreamState>()
