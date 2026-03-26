/**
 * Base Chat Mode Strategy
 * 
 * Abstract base class with common functionality for all chat mode strategies
 * 
 * REPLACES: Common logic duplicated across message-agents.ts implementations
 * BENEFITS:
 *   - Shared event emission helpers
 *   - Standardized capability reporting
 *   - Common error handling
 */

import type { ChatModeStrategy, ChatMode } from "./chat-mode-strategy"
import type { ChatEvent, CitationEvent } from "../../shared/events"
import type { ChatRequest } from "../../models"
import type { RequestContextLike as RequestContext } from "../orchestrator/request-context.types"
import type { ContextAssembler } from "../pipeline/context-assembly"

/**
 * Capabilities a strategy can support
 */
export type StrategyCapability =
  | "streaming"
  | "tool-calling"
  | "citations"
  | "attachments"
  | "knowledge-base"
  | "agent-delegation"
  | "multi-turn"
  | "reasoning"

/**
 * Strategy execution result
 */
export interface StrategyExecutionResult {
  /** Whether execution succeeded */
  success: boolean
  /** Assistant message content */
  content?: string
  /** Citations from the response */
  citations?: import("../../models").Citation[]
  /** Tool calls made during execution */
  toolCalls?: ToolCallRecord[]
  /** Error if execution failed */
  error?: StrategyError
  /** Metadata about execution */
  metadata: {
    startTime: Date
    endTime: Date
    durationMs: number
    tokenCount?: number
    turnCount?: number
  }
}

/**
 * Tool call record for tracking
 */
export interface ToolCallRecord {
  tool: string
  toolCallId: string
  arguments: Record<string, unknown>
  result?: unknown
  error?: string
  durationMs: number
}

/**
 * Strategy execution error
 */
export interface StrategyError {
  code: string
  message: string
  recoverable: boolean
  details?: Record<string, unknown>
}

/**
 * Base class for chat mode strategies with common functionality
 */
export abstract class BaseChatModeStrategy implements ChatModeStrategy {
  abstract readonly mode: ChatMode

  abstract canHandle(request: ChatRequest): boolean

  abstract execute(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent>

  abstract getContextAssembler(): ContextAssembler

  /**
   * Get supported capabilities for this mode
   */
  getCapabilities(): StrategyCapability[] {
    return ["streaming", "citations"]
  }

  /**
   * Check if strategy supports a specific capability
   */
  supportsCapability(capability: StrategyCapability): boolean {
    return this.getCapabilities().includes(capability)
  }

  /**
   * Emit a chat event
   */
  protected async *emit(event: ChatEvent): AsyncIterable<ChatEvent> {
    yield event
  }

  /**
   * Emit multiple events
   */
  protected async *emitMany(events: ChatEvent[]): AsyncIterable<ChatEvent> {
    for (const event of events) {
      yield event
    }
  }

  /**
   * Stream events from an async iterable
   */
  protected async *streamEvents(
    generator: AsyncIterable<ChatEvent>
  ): AsyncIterable<ChatEvent> {
    for await (const event of generator) {
      yield event
    }
  }

  /**
   * Create error event
   */
  protected createErrorEvent(
    code: string,
    message: string,
    recoverable = false,
    details?: Record<string, unknown>
  ): ChatEvent {
    return {
      type: "error",
      error: {
        code,
        message,
        recoverable,
        details,
      },
    }
  }

  /**
   * Create start event
   */
  protected createStartEvent(): ChatEvent {
    return {
      type: "start",
    }
  }

  /**
   * Create complete event
   */
  protected createCompleteEvent(
    metadata?: Record<string, unknown>
  ): ChatEvent {
    return {
      type: "complete",
    }
  }

  /**
   * Create metadata event
   */
  protected createMetadataEvent(data: Record<string, unknown>): ChatEvent {
    return {
      type: "metadata",
      data: data as import("../../shared/events").ResponseMetadata,
    }
  }

  /**
   * Create reasoning event
   */
  protected createReasoningEvent(
    step: string,
    details?: Record<string, unknown>
  ): ChatEvent {
    return {
      type: "reasoning",
      step: {
        stage: "planning" as import("../../shared/events").ReasoningStage,
        message: step,
        details,
        timestamp: new Date(),
      },
    }
  }

  /**
   * Handle error in strategy execution
   */
  protected async *handleError(
    error: unknown,
    code = "STRATEGY_ERROR"
  ): AsyncIterable<ChatEvent> {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error(`[${this.mode}] Strategy error:`, error)
    
    yield this.createErrorEvent(code, errorMessage, false)
  }

  /**
   * Extract citations from generated text using citation handler
   */
  protected async *extractCitations(
    text: string,
    fragments: import("../../models").Fragment[],
    requestContext: RequestContext
  ): AsyncIterable<CitationEvent> {
    // Citation extraction logic would go here
    // For now, this is a placeholder that can be overridden
    const registry = requestContext.citations
    
    // Look for citation patterns like [1], [2], etc.
    const citationPattern = /\[(\d+)\]/g
    let match
    
    while ((match = citationPattern.exec(text)) !== null) {
      const index = parseInt(match[1], 10)
      const fragment = fragments[index - 1]
      
      if (fragment) {
        const citation = fragment.source
        const citationIndex = registry.register(citation)
        
        yield {
          type: "citation",
          citation: {
            index: citationIndex,
            item: citation,
            chunkIndex: fragment.metadata?.chunkIndex,
          },
          citationMap: { [index]: citationIndex },
        }
      }
    }
  }

  /**
   * Build standard message array for LLM
   */
  protected buildMessages(
    systemPrompt: string,
    conversationHistory: Array<{ role: string; content: string }>,
    userMessage: string,
    historyLimit = 10
  ): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
    ]

    // Add conversation history (limited)
    for (const msg of conversationHistory.slice(-historyLimit)) {
      messages.push({
        role: msg.role,
        content: msg.content,
      })
    }

    // Add current user message
    messages.push({
      role: "user",
      content: userMessage,
    })

    return messages
  }
}
