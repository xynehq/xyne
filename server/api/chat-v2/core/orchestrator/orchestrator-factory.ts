/**
 * Orchestrator Factory
 *
 * Creates configured orchestrator instances
 * Centralizes configuration and strategy registration
 */

import { ChatOrchestrator } from "./chat-orchestrator"
import {
  createDependencyContainer,
  type DependencyContainer,
} from "./dependency-container"
import { StrategyRegistry } from "../strategies/strategy-registry"
import { NormalChatStrategy } from "../strategies/normal-chat.strategy"
import { AgenticChatStrategy } from "../strategies/agentic-chat.strategy"
import { AttachmentChatStrategy } from "../strategies/attachment-chat.strategy"
import { KnowledgeBaseChatStrategy } from "../strategies/knowledge-base-chat.strategy"

export interface OrchestratorFactoryConfig {
  /** Enable debug logging */
  debug?: boolean
  /** Custom strategy registry */
  strategyRegistry?: StrategyRegistry
  /** Custom dependencies */
  dependencies?: DependencyContainer
}

/**
 * Create a fully configured orchestrator
 */
export function createOrchestrator(
  config: OrchestratorFactoryConfig = {},
): ChatOrchestrator {
  const registry = config.strategyRegistry ?? createDefaultStrategyRegistry()
  const dependencies = config.dependencies ?? createDependencyContainer()

  return new ChatOrchestrator({
    strategyRegistry: registry,
    dependencies,
    debug: config.debug ?? process.env.DEBUG_CHAT === "true",
  })
}

/**
 * Create default strategy registry with all standard strategies
 */
function createDefaultStrategyRegistry(): StrategyRegistry {
  const registry = new StrategyRegistry()

  // Register strategies in priority order (first matching strategy wins)
  // KnowledgeBase is checked first because it's most specific
  registry.register(new KnowledgeBaseChatStrategy())

  // Attachment mode handles file uploads
  registry.register(new AttachmentChatStrategy())

  // Agentic mode for tool-using agents
  registry.register(new AgenticChatStrategy())

  // Normal chat is the default
  const normalStrategy = new NormalChatStrategy()
  registry.register(normalStrategy)
  registry.setDefault(normalStrategy)

  return registry
}

/**
 * Singleton instance for production use
 */
let globalOrchestrator: ChatOrchestrator | undefined

export function getGlobalOrchestrator(): ChatOrchestrator {
  if (!globalOrchestrator) {
    globalOrchestrator = createOrchestrator()
  }
  return globalOrchestrator
}

/**
 * Reset global orchestrator (useful for testing)
 */
export function resetGlobalOrchestrator(): void {
  globalOrchestrator = undefined
}
