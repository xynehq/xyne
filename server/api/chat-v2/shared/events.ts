/**
 * Events emitted during chat processing
 * Used for SSE streaming to client
 */

export type ChatEvent =
  | StartEvent
  | MetadataEvent
  | ReasoningEvent
  | TokenEvent
  | ToolCallEvent
  | ToolResultEvent
  | CitationEvent
  | ImageCitationEvent
  | ErrorEvent
  | CompleteEvent

export interface StartEvent {
  type: "start"
}

export interface MetadataEvent {
  type: "metadata"
  data: ResponseMetadata
}

export interface ResponseMetadata {
  chatId: string
  messageId?: string
  timeTakenMs?: number
  model?: string
}

export interface ReasoningEvent {
  type: "reasoning"
  step: ReasoningStep
}

export interface ReasoningStep {
  stage: ReasoningStage
  message?: string
  details?: Record<string, unknown>
  timestamp: Date
}

export type ReasoningStage =
  | "turn_started"
  | "planning"
  | "tool_selected"
  | "tool_executing"
  | "tool_completed"
  | "reviewing"
  | "synthesizing"
  | "documents_ranking"
  | "attachment_analyzing"
  | "attachment_extracted"
  | "synthesis_started"
  | "synthesis_completed"
  | "turn_ended"
  | "agent_started"
  | "agent_ended"

export interface TokenEvent {
  type: "token"
  content: string
}

export interface ToolCallEvent {
  type: "tool-call"
  tool: string
  args: Record<string, unknown>
  callId: string
}

export interface ToolResultEvent {
  type: "tool-result"
  tool: string
  result: unknown
  callId: string
  durationMs: number
}

export interface CitationEvent {
  type: "citation"
  citation: {
    index: number
    item: import("../models/citation").Citation
    chunkIndex?: number
  }
  citationMap: Record<number, number>
}

export interface ImageCitationEvent {
  type: "image-citation"
  citation: import("../models/citation").ImageCitation
}

export interface ErrorEvent {
  type: "error"
  error: ChatError
}

export interface ChatError {
  code: string
  message: string
  details?: Record<string, unknown>
  recoverable: boolean
}

export interface CompleteEvent {
  type: "complete"
}

/**
 * Convert ChatEvent to SSE format
 */
export function toSSEEvent(event: ChatEvent): { event: string; data: string } {
  const eventName = event.type.replace(/([A-Z])/g, "_$1").toUpperCase()

  return {
    event: eventName,
    data: JSON.stringify(event),
  }
}
