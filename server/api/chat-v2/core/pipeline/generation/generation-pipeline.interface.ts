/**
 * Generation Pipeline Interface
 * 
 * Handles LLM response generation with streaming support
 */

import type { AssembledChatContext, Fragment } from "../../../models"
import type { RequestContextLike as RequestContext } from "../../orchestrator/request-context.types"
import type { Tool } from "../../../plugins/tools/tool.interface"

/**
 * Generation Pipeline - Produces LLM responses
 */
export interface GenerationPipeline {
  /**
   * Generate response for chat context
   * @param context - Assembled chat context
   * @param fragments - Retrieved fragments for context
   * @param requestContext - Request-scoped dependencies
   * @yields Generation events (tokens, tool calls, citations)
   */
  generate(
    context: AssembledChatContext,
    fragments: Fragment[],
    requestContext: RequestContext
  ): AsyncIterable<GenerationEvent>
  
  /**
   * Optional: Check if pipeline supports specific capabilities
   */
  supportsCapability?(capability: GenerationCapability): boolean
}

/**
 * Generation capability flags
 */
export type GenerationCapability =
  | "streaming"
  | "tool-calling"
  | "citations"
  | "images"
  | "reasoning"
  | "structured-output"

/**
 * Events emitted during generation
 */
export type GenerationEvent =
  | TokenEvent
  | ToolCallEvent
  | ToolResultEvent
  | CitationEvent
  | ReasoningEvent
  | ErrorEvent
  | CompleteEvent

export interface TokenEvent {
  type: "token"
  content: string
  /** Citation references within this token chunk */
  citations?: number[]
}

export interface ToolCallEvent {
  type: "tool-call"
  tool: string
  toolCallId: string
  arguments: Record<string, unknown>
}

export interface ToolResultEvent {
  type: "tool-result"
  tool: string
  toolCallId: string
  result: unknown
  success: boolean
}

export interface CitationEvent {
  type: "citation"
  citation: {
    index: number
    docId: string
    title: string
    url?: string
  }
}

export interface ReasoningEvent {
  type: "reasoning"
  step: string
  details?: Record<string, unknown>
}

export interface ErrorEvent {
  type: "error"
  error: {
    code: string
    message: string
    recoverable: boolean
  }
}

export interface CompleteEvent {
  type: "complete"
  finishReason: "stop" | "length" | "tool-calls" | "error"
  usage?: {
    inputTokens: number
    outputTokens: number
  }
}

/**
 * Generation options
 */
export interface GenerationOptions {
  /** Model to use */
  model?: string
  /** Temperature */
  temperature?: number
  /** Max tokens */
  maxTokens?: number
  /** Enable streaming */
  streaming?: boolean
  /** Available tools */
  tools?: Tool[]
  /** System prompt */
  systemPrompt?: string
}
