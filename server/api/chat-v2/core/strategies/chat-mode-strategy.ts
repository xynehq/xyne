/**
 * Chat Mode Strategy Pattern
 * 
 * Different chat modes (normal, agentic, attachment, etc.) implement this interface
 * Strategy is selected by Orchestrator based on request characteristics
 */

import type { ChatRequest } from "../../models"
import type { ChatEvent } from "../../shared/events"
import type { RequestContextLike as RequestContext } from "../orchestrator/request-context.types"

/**
 * Available chat modes
 */
export enum ChatMode {
  /** Simple chat without agentic loop */
  Normal = "normal",
  
  /** Agentic mode with tool calling */
  Agentic = "agentic",
  
  /** Chat focused on attachment analysis */
  Attachment = "attachment",
  
  /** Knowledge base scoped chat */
  KnowledgeBase = "knowledge-base",
  
  /** Multi-agent delegation */
  MultiAgent = "multi-agent",
  
  /** Structured reasoning mode */
  StructuredReasoning = "structured-reasoning",
}

/**
 * Strategy interface for chat modes
 */
export interface ChatModeStrategy {
  /** Unique mode identifier */
  readonly mode: ChatMode
  
  /**
   * Determine if this strategy can handle the request
   * Called by orchestrator to select appropriate strategy
   */
  canHandle(request: ChatRequest): boolean
  
  /**
   * Execute the chat flow
   * Returns async iterable of events for SSE streaming
   */
  execute(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent>
  
  /**
   * Optional: Prepare context before execution
   * Called by orchestrator before execute()
   */
  prepare?(
    request: ChatRequest,
    context: RequestContext
  ): Promise<void>
  
  /**
   * Optional: Cleanup after execution
   * Called by orchestrator after execute() completes or errors
   */
  cleanup?(
    request: ChatRequest,
    context: RequestContext
  ): Promise<void>
}

/**
 * Strategy registry for discovering and selecting strategies
 */
export class ChatModeStrategyRegistry {
  private strategies = new Map<ChatMode, ChatModeStrategy>()
  private defaultStrategy: ChatModeStrategy | undefined
  
  /**
   * Register a strategy
   */
  register(mode: ChatMode, strategy: ChatModeStrategy): void {
    if (this.strategies.has(mode)) {
      throw new Error(`Strategy for mode "${mode}" already registered`)
    }
    this.strategies.set(mode, strategy)
  }
  
  /**
   * Set default strategy when no specific strategy matches
   */
  setDefault(strategy: ChatModeStrategy): void {
    this.defaultStrategy = strategy
  }
  
  /**
   * Get strategy by mode
   */
  get(mode: ChatMode): ChatModeStrategy | undefined {
    return this.strategies.get(mode)
  }
  
  /**
   * Get all registered strategies
   */
  getAll(): ChatModeStrategy[] {
    return Array.from(this.strategies.values())
  }
  
  /**
   * Find strategy for request
   * Uses canHandle() to determine match, falls back to default
   */
  findFor(request: ChatRequest): ChatModeStrategy {
    // Check each strategy in priority order
    for (const strategy of this.strategies.values()) {
      if (strategy.canHandle(request)) {
        return strategy
      }
    }
    
    if (this.defaultStrategy) {
      return this.defaultStrategy
    }
    
    throw new Error("No suitable strategy found for request and no default set")
  }
  
  /**
   * Check if a mode is registered
   */
  has(mode: ChatMode): boolean {
    return this.strategies.has(mode)
  }
  
  /**
   * Unregister a strategy
   */
  unregister(mode: ChatMode): boolean {
    return this.strategies.delete(mode)
  }
}

/**
 * Singleton registry instance
 * Import this to register strategies
 */
export const strategyRegistry = new ChatModeStrategyRegistry()
