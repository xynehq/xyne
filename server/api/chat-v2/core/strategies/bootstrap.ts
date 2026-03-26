/**
 * Strategy Bootstrap
 * 
 * Registers all chat mode strategies with the registry
 */

import { strategyRegistry } from "./strategy-registry"
import { ChatMode } from "./chat-mode-strategy"
import { NormalChatStrategy } from "./normal-chat.strategy"
import { AgenticChatStrategy } from "./agentic-chat.strategy"
import { AttachmentChatStrategy } from "./attachment-chat.strategy"
import { KnowledgeBaseChatStrategy } from "./knowledge-base-chat.strategy"

export interface StrategyBootstrapOptions {
  /** Strategy-specific options */
  normalChat?: import("./normal-chat.strategy").NormalChatStrategyOptions
  agenticChat?: import("./agentic-chat.strategy").AgenticChatStrategyOptions
  attachmentChat?: import("./attachment-chat.strategy").AttachmentChatStrategyOptions
  knowledgeBaseChat?: import("./knowledge-base-chat.strategy").KnowledgeBaseChatStrategyOptions
}

/**
 * Register all strategies
 * 
 * Priority order (highest to lowest):
 * 1. Knowledge Base (most specific)
 * 2. Attachment
 * 3. Agentic
 * 4. Normal (least specific - fallback)
 */
export function registerStrategies(options: StrategyBootstrapOptions = {}): void {
  // Clear existing registrations
  strategyRegistry.clear()

  // Register Knowledge Base strategy
  strategyRegistry.register(
    new KnowledgeBaseChatStrategy(options.knowledgeBaseChat)
  )

  // Register Attachment strategy
  strategyRegistry.register(
    new AttachmentChatStrategy(options.attachmentChat)
  )

  // Register Agentic strategy
  strategyRegistry.register(
    new AgenticChatStrategy(options.agenticChat)
  )

  // Register Normal strategy as both regular and default
  const normalStrategy = new NormalChatStrategy(options.normalChat)
  strategyRegistry.register(normalStrategy)
  strategyRegistry.setDefault(normalStrategy)

  console.log("[Strategy Bootstrap] Registered strategies:",
    strategyRegistry.getRegisteredModes().join(", ")
  )
}

/**
 * Get strategy for request
 */
export function getStrategyForRequest(
  request: import("../../models").ChatRequest
) {
  return strategyRegistry.findFor(request)
}

/**
 * Check if strategy is available
 */
export function isStrategyAvailable(mode: ChatMode): boolean {
  return strategyRegistry.has(mode)
}

/**
 * Unregister all strategies (useful for testing)
 */
export function unregisterAllStrategies(): void {
  strategyRegistry.clear()
}
