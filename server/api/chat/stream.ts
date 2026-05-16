import type { SSEStreamingApi } from "hono/streaming"

export interface ActiveStreamState {
  stream: SSEStreamingApi
  waitingForClarification?: boolean
  clarificationCallback?: (
    clarificationId: string,
    selectedOptionId: {
      selectedOptionId: string
      selectedOption: string
      customInput?: string
    },
  ) => void
  stopController?: AbortController
}

// Map to store active streams: Key = "chatId", Value = ActiveStreamState
export const activeStreams = new Map<string, ActiveStreamState>()
