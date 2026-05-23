// Debug capture event union. One event per pi-mono / provider boundary
// that's worth surfacing to the user when they flip the debug toggle.
//
// Verbosity gates which events get emitted (see capture.ts) — `summary`
// keeps just boundaries, `detailed` adds request payloads + tool I/O,
// `verbose` adds every per-chunk provider response. The shapes stay
// the same across levels so the UI doesn't branch on verbosity.

// `summary` keeps just boundaries (request/response/tool/compaction
// /agent_end without large payloads). `detailed` adds request bodies,
// full response text + usage, and tool args/results. We dropped the
// old "verbose" tier (per-chunk events) — too noisy and not useful
// for the actual debug UX.
export type DebugVerbosity = "summary" | "detailed"

export type DebugTokenUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type DebugEvent =
  | {
      kind: "request"
      // 1-based index — pi-mono fires the first call as #1, each tool
      // round as #2, #3, … The UI uses this to group response_chunks
      // back to their LLM call.
      llmCall: number
      sentAt: number
      model: string
      sampler: {
        temperature?: number
        topP?: number
        maxTokens?: number
      }
      systemPromptChars: number
      // Only present at `detailed` / `verbose` — scrubbed of secrets
      // (apiKey, Authorization, cookies). Shape mirrors the provider's
      // wire body so it's copy-pasteable into curl reproductions.
      payload?: unknown
    }
  | {
      kind: "response"
      // Final response for `llmCall` — emitted once per provider
      // round-trip (request → assembled response). Carries the
      // assistant message text, the stop reason, and the round's
      // token usage. Replaces the old per-chunk firehose.
      llmCall: number
      receivedAt: number
      stopReason?: string
      // Assembled text content from the assistant message. Only at
      // `detailed`. Thinking lives separately in pi-mono and is
      // surfaced via the message itself; we don't duplicate it here.
      text?: string
      tokenUsage?: DebugTokenUsage
    }
  | {
      kind: "tool_call_start"
      toolName: string
      toolCallId: string
      args: unknown
      startedAt: number
    }
  | {
      kind: "tool_call_end"
      toolName: string
      toolCallId: string
      // From start → end of the local tool execution (Vespa round-trip
      // for the search tools, IO time for getChunks, etc.). Not the
      // LLM-side latency.
      durationMs: number
      isError: boolean
      // Present at `detailed` / `verbose`.
      result?: unknown
    }
  | {
      kind: "compaction_start"
      reason: string
      tokensBefore?: number
      at: number
    }
  | {
      kind: "compaction_end"
      tokensAfter?: number
      at: number
      aborted: boolean
    }
  | {
      kind: "agent_end"
      stopReason: string
      tokenUsage: DebugTokenUsage
      // Wall-clock from first request emit to agent_end. The UI shows
      // this in the panel header.
      durationMs: number
    }
  | {
      kind: "error"
      message: string
      // Optional context; e.g. which LLM call / which tool was in
      // flight when the error fired.
      llmCall?: number
      toolName?: string
    }

export const isDetailed = (v: DebugVerbosity): boolean => v === "detailed"
