// DebugCapture — per-turn sink for the chat-service to wire the runner /
// rag-agent into. One instance is created at sendMessage time when the
// caller opted in, and lives until agent_end. Each `emit` either drops
// the event (verbosity gate fails) or hands it to the publisher the
// service supplied (typically deps.stream.publish wrapped to carry the
// run id).

import { scrubSensitive } from "./scrub"
import {
  isDetailed,
  type DebugEvent,
  type DebugTokenUsage,
  type DebugVerbosity,
} from "./types"

type Publish = (event: DebugEvent) => void

/** Per-turn capture sink. Methods are called by:
 *   • rag-agent's streamFn wrapper (request + response_chunk + agent_end)
 *   • the runner's tool-call wrapping (tool_call_start / _end)
 *   • the chat service for compaction events forwarded from pi-mono
 *   • any error in the streaming loop
 *
 *  All payload fields are scrubbed before reaching `publish`. */
export class DebugCapture {
  private llmCall = 0

  public constructor(
    private readonly verbosity: DebugVerbosity,
    private readonly publish: Publish,
  ) {}

  /** Bump + return the new LLM-call index. The rag-agent calls this once
   *  per outbound provider request so events downstream of it (response
   *  chunks for that round) can be grouped in the UI. */
  public nextLlmCall(): number {
    this.llmCall += 1
    return this.llmCall
  }

  public currentLlmCall(): number {
    return this.llmCall
  }

  public emitRequest(args: {
    sentAt: number
    model: string
    sampler: {
      temperature?: number
      topP?: number
      maxTokens?: number
    }
    systemPromptChars: number
    payload: unknown
  }): void {
    const llmCall = this.nextLlmCall()
    // At `summary` the payload is dropped entirely — the user sees
    // boundaries + sampler params, not the wire body. This is the
    // cheapest level and the default.
    const includePayload = isDetailed(this.verbosity)
    this.publish({
      kind: "request",
      llmCall,
      sentAt: args.sentAt,
      model: args.model,
      sampler: args.sampler,
      systemPromptChars: args.systemPromptChars,
      ...(includePayload ? { payload: scrubSensitive(args.payload) } : {}),
    })
  }

  public emitResponse(args: {
    receivedAt: number
    stopReason?: string
    text?: string
    tokenUsage?: DebugTokenUsage
  }): void {
    // One response event per LLM round-trip. `text` is gated to
    // `detailed` because it can be long; the boundary itself (with
    // stopReason + tokens) always fires so even `summary` users see
    // every request paired with its response.
    const includeText = isDetailed(this.verbosity)
    this.publish({
      kind: "response",
      llmCall: this.llmCall,
      receivedAt: args.receivedAt,
      ...(args.stopReason ? { stopReason: args.stopReason } : {}),
      ...(includeText && args.text ? { text: args.text } : {}),
      ...(args.tokenUsage ? { tokenUsage: args.tokenUsage } : {}),
    })
  }

  public emitToolCallStart(args: {
    toolName: string
    toolCallId: string
    args: unknown
    startedAt: number
  }): void {
    this.publish({
      kind: "tool_call_start",
      toolName: args.toolName,
      toolCallId: args.toolCallId,
      args: scrubSensitive(args.args),
      startedAt: args.startedAt,
    })
  }

  public emitToolCallEnd(args: {
    toolName: string
    toolCallId: string
    durationMs: number
    isError: boolean
    result: unknown
  }): void {
    const includeResult = isDetailed(this.verbosity)
    this.publish({
      kind: "tool_call_end",
      toolName: args.toolName,
      toolCallId: args.toolCallId,
      durationMs: args.durationMs,
      isError: args.isError,
      ...(includeResult ? { result: scrubSensitive(args.result) } : {}),
    })
  }

  public emitCompactionStart(args: {
    reason: string
    tokensBefore?: number
    at: number
  }): void {
    this.publish({
      kind: "compaction_start",
      reason: args.reason,
      ...(args.tokensBefore !== undefined
        ? { tokensBefore: args.tokensBefore }
        : {}),
      at: args.at,
    })
  }

  public emitCompactionEnd(args: {
    tokensAfter?: number
    at: number
    aborted: boolean
  }): void {
    this.publish({
      kind: "compaction_end",
      ...(args.tokensAfter !== undefined
        ? { tokensAfter: args.tokensAfter }
        : {}),
      at: args.at,
      aborted: args.aborted,
    })
  }

  public emitAgentEnd(args: {
    stopReason: string
    tokenUsage: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
    }
    durationMs: number
  }): void {
    this.publish({
      kind: "agent_end",
      stopReason: args.stopReason,
      tokenUsage: args.tokenUsage,
      durationMs: args.durationMs,
    })
  }

  public emitError(args: {
    message: string
    llmCall?: number
    toolName?: string
  }): void {
    this.publish({
      kind: "error",
      message: args.message,
      ...(args.llmCall !== undefined ? { llmCall: args.llmCall } : {}),
      ...(args.toolName !== undefined ? { toolName: args.toolName } : {}),
    })
  }
}
