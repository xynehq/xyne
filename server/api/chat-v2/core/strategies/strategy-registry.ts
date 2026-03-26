/**
 * Strategy Registry
 * 
 * Manages all chat mode strategies and handles strategy selection
 * 
 * REPLACES: Mode-specific conditional logic in message-agents.ts
 * BENEFITS:
 *   - Dynamic strategy discovery and selection
 *   - Priority-based strategy resolution
 *   - Easy to add new modes without touching existing code
 */

import { type ChatModeStrategy, ChatMode } from "./chat-mode-strategy"
import type { ChatRequest } from "../../models"

export class StrategyRegistry {
  private strategies = new Map<ChatMode, ChatModeStrategy>()
  private defaultStrategy: ChatModeStrategy | undefined

  /**
   * Register a strategy for a chat mode
   */
  register(strategy: ChatModeStrategy): void {
    if (this.strategies.has(strategy.mode)) {
      console.warn(
        `Strategy for mode "${strategy.mode}" already registered, overwriting`
      )
    }
    this.strategies.set(strategy.mode, strategy)
  }

  /**
   * Unregister a strategy
   */
  unregister(mode: ChatMode): boolean {
    return this.strategies.delete(mode)
  }

  /**
   * Get strategy for a specific mode
   */
  get(mode: ChatMode): ChatModeStrategy | undefined {
    return this.strategies.get(mode)
  }

  /**
   * Get strategy or throw
   */
  getOrThrow(mode: ChatMode): ChatModeStrategy {
    const strategy = this.get(mode)
    if (!strategy) {
      throw new Error(`No strategy registered for mode "${mode}"`)
    }
    return strategy
  }

  /**
   * Set default strategy
   */
  setDefault(strategy: ChatModeStrategy): void {
    this.defaultStrategy = strategy
  }

  /**
   * Get default strategy
   */
  getDefault(): ChatModeStrategy | undefined {
    return this.defaultStrategy
  }

  /**
   * Find strategy for a request
   * Tries each strategy's canHandle method in priority order
   */
  findFor(request: ChatRequest): ChatModeStrategy {
    // Priority order for strategy selection (most specific to least specific)
    const priorityOrder: ChatMode[] = [
      ChatMode.KnowledgeBase,
      ChatMode.Attachment,
      ChatMode.Agentic,
      ChatMode.Normal,
    ]

    for (const mode of priorityOrder) {
      const strategy = this.strategies.get(mode)
      if (strategy && strategy.canHandle(request)) {
        return strategy
      }
    }

    if (this.defaultStrategy) {
      return this.defaultStrategy
    }

    throw new Error("No strategy found for request and no default set")
  }

  /**
   * Get all registered modes
   */
  getRegisteredModes(): ChatMode[] {
    return Array.from(this.strategies.keys())
  }

  /**
   * Get all registered strategies
   */
  getAllStrategies(): ChatModeStrategy[] {
    return Array.from(this.strategies.values())
  }

  /**
   * Check if a mode has a registered strategy
   */
  has(mode: ChatMode): boolean {
    return this.strategies.has(mode)
  }

  /**
   * Clear all registrations
   */
  clear(): void {
    this.strategies.clear()
    this.defaultStrategy = undefined
  }
}

/**
 * Singleton registry instance
 */
export const strategyRegistry = new StrategyRegistry()
