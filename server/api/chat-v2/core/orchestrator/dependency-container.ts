/**
 * Dependency Container for dependency injection
 * Provides access to services without tight coupling
 * 
 * Updated for Phase 3: Added Strategy Registry
 */

import type { ToolRegistry } from "../../plugins/tools/tool-registry"
import { RetrieverRegistry, UnifiedVespaRetriever } from "../../plugins/retrievers"
import type { CitationRegistry } from "../../plugins/citations/citation-registry"
import { HybridMemoryService, DatabasePersistenceService } from "../../services"
import type { MemoryService, PersistenceService, PromptBuilderService } from "../../services"
import { NormalContextAssembler, AgentContextAssembler, contextAssemblerRegistry } from "../pipeline/context-assembly"
import { ChatMode } from "../strategies/chat-mode-strategy"
import { StrategyRegistry, strategyRegistry } from "../strategies/strategy-registry"
import { registerStrategies } from "../strategies/bootstrap"
import type { GenerationPipeline } from "../pipeline/generation/generation-pipeline.interface"
import type { DependencyContainer, ChatConfig } from "./dependency-container.types"
export type { DependencyContainer, ChatConfig } from "./dependency-container.types"

/**
 * Factory for creating dependency container with real implementations
 */
export function createDependencyContainer(
  overrides?: Partial<DependencyContainer>
): DependencyContainer {
  // Create registries
  const tools = overrides?.tools ?? ({} as ToolRegistry)
  const retrievers = new RetrieverRegistry()
  const citations = overrides?.citations ?? ({} as CitationRegistry)
  
  // Create services
  const memory = new HybridMemoryService()
  const persistence: PersistenceService = new DatabasePersistenceService()
  const promptBuilder = overrides?.promptBuilder ?? ({} as PromptBuilderService)
  
  // Register unified Vespa retriever
  retrievers.register(new UnifiedVespaRetriever())
  
  // Register context assemblers
  contextAssemblerRegistry.register(
    ChatMode.Normal,
    new NormalContextAssembler()
  )
  contextAssemblerRegistry.register(
    ChatMode.Agentic,
    new AgentContextAssembler(
      { includeAgentConfig: true },
      { agentId: "" } // Will be set at runtime
    )
  )
  contextAssemblerRegistry.setDefault(
    new NormalContextAssembler()
  )
  
  // Register strategies
  registerStrategies()
  
  return {
    tools: overrides?.tools ?? tools,
    retrievers: overrides?.retrievers ?? retrievers,
    citations: overrides?.citations ?? citations,
    assemblers: contextAssemblerRegistry,
    strategies: overrides?.strategies ?? strategyRegistry,
    memory: overrides?.memory ?? memory,
    persistence: overrides?.persistence ?? persistence,
    promptBuilder: overrides?.promptBuilder ?? promptBuilder,
    generation: overrides?.generation ?? ({} as GenerationPipeline),
    config: overrides?.config ?? getDefaultConfig(),
  }
}

function getDefaultConfig(): ChatConfig {
  return {
    defaultModel: "gpt-4o",
    defaultFastModel: "gpt-4o-mini",
    maxTurns: 10,
    maxTokens: 4096,
    reviewFrequency: 5,
    features: {
      reasoning: true,
      webSearch: true,
      deepResearch: false,
      delegation: true,
    },
  }
}
