/**
 * Pi-Mono Event Types for Xyne
 *
 * Type-safe event handler types for pi-mono SDK events.
 * Note: The SDK uses a discriminated union for AgentSessionEvent,
 * so we define our own event interfaces based on observed event shapes.
 */

import type { XyneAgentState } from "../adapter"
import type { ReasoningEmitter } from "@/api/chat/reasoning-steps"

/**
 * Base event interface - all events have a type discriminator
 */
interface BaseEvent {
  type: string
}

/**
 * Turn lifecycle events
 */
export interface TurnStartEvent extends BaseEvent {
  type: "turn_start"
}

export interface TurnEndEvent extends BaseEvent {
  type: "turn_end"
}

/**
 * Agent lifecycle events
 */
export interface AgentStartEvent extends BaseEvent {
  type: "agent_start"
}

export interface AgentEndEvent extends BaseEvent {
  type: "agent_end"
  reason?: string
}

/**
 * Message streaming event
 */
export interface MessageUpdateEvent extends BaseEvent {
  type: "message_update"
  assistantMessageEvent?: {
    type: "text_delta" | "text_done" | string
    delta?: string
    text?: string
  }
}

/**
 * Tool execution events
 */
export interface ToolExecutionStartEvent extends BaseEvent {
  type: "tool_execution_start"
  toolName: string
  toolCallId?: string
}

export interface ToolExecutionEndEvent extends BaseEvent {
  type: "tool_execution_end"
  toolName: string
  toolCallId?: string
  isError?: boolean
}

/**
 * Compaction events
 */
export interface AutoCompactionStartEvent extends BaseEvent {
  type: "auto_compaction_start"
  reason: "threshold" | "overflow"
}

export interface AutoCompactionEndEvent extends BaseEvent {
  type: "auto_compaction_end"
  result?: unknown
  aborted: boolean
  willRetry: boolean
  errorMessage?: string
}

/**
 * Error event
 */
export interface ErrorEvent extends BaseEvent {
  type: "error"
  error: { message: string; stack?: string }
}

/**
 * Union of all Xyne-handled event types
 */
export type XyneAgentSessionEvent =
  | TurnStartEvent
  | TurnEndEvent
  | AgentStartEvent
  | AgentEndEvent
  | MessageUpdateEvent
  | ToolExecutionStartEvent
  | ToolExecutionEndEvent
  | AutoCompactionStartEvent
  | AutoCompactionEndEvent
  | ErrorEvent

/**
 * Xyne-specific event handler type
 */
export type XyneEventHandler<TEvent extends XyneAgentSessionEvent> = (
  event: TEvent,
  context: {
    xyneState: XyneAgentState
    emitReasoningStep: ReasoningEmitter
  },
) => Promise<void> | void

/**
 * Typed event map for message-agents.ts
 */
export interface XyneEventMap {
  turn_start: TurnStartEvent
  turn_end: TurnEndEvent
  agent_start: AgentStartEvent
  agent_end: AgentEndEvent
  message_update: MessageUpdateEvent
  tool_execution_start: ToolExecutionStartEvent
  tool_execution_end: ToolExecutionEndEvent
  auto_compaction_start: AutoCompactionStartEvent
  auto_compaction_end: AutoCompactionEndEvent
  error: ErrorEvent
}

/**
 * Type guard for auto-compaction events
 */
export function isAutoCompactionStartEvent(
  event: XyneAgentSessionEvent,
): event is AutoCompactionStartEvent {
  return event.type === "auto_compaction_start"
}

export function isAutoCompactionEndEvent(
  event: XyneAgentSessionEvent,
): event is AutoCompactionEndEvent {
  return event.type === "auto_compaction_end"
}

/**
 * Type guard for error events
 */
export function isErrorEvent(
  event: XyneAgentSessionEvent,
): event is ErrorEvent {
  return event.type === "error"
}
