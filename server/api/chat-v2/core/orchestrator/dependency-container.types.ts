/**
 * Dependency Container Types
 * 
 * Separated from implementation to avoid circular dependencies
 * NOTE: This file should NOT import from other chat-v2 core modules
 * Only import from plugins, services, and external types
 */

import type { ToolRegistry } from "../../plugins/tools/tool-registry"
import type { RetrieverRegistry } from "../../plugins/retrievers/retriever-registry"
import type { CitationRegistry } from "../../plugins/citations/citation-registry"
import type { MemoryService, PersistenceService, PromptBuilderService } from "../../services"

// Forward declarations to avoid circular dependencies
// These are minimal interfaces that match the actual implementations
interface GenerationPipeline {
  generate(chatContext: any, fragments: any, requestContext: any): AsyncIterable<any>
}

interface StrategyRegistry {
  register(strategy: any): void
  unregister(mode: any): boolean
  get(mode: any): any
  getOrThrow(mode: any): any
  setDefault(strategy: any): void
  getDefault(): any
  findFor(request: any): any
  getRegisteredModes(): any[]
  getAllStrategies(): any[]
  has(mode: any): boolean
  clear(): void
}

interface ContextAssemblerRegistry {
  register(mode: any, assembler: any): void
  setDefault(assembler: any): void
  get(mode: any): any
  getOrThrow(mode: any): any
  has(mode: any): boolean
  getRegisteredModes(): any[]
  unregister(mode: any): boolean
}

export interface DependencyContainer {
  // Registries
  tools: ToolRegistry
  retrievers: RetrieverRegistry
  citations: CitationRegistry
  assemblers: ContextAssemblerRegistry
  strategies: StrategyRegistry
  
  // Services
  memory: MemoryService
  persistence: PersistenceService
  promptBuilder: PromptBuilderService
  
  // Pipeline
  generation: GenerationPipeline
  
  // Configuration
  config: ChatConfig
}

export interface ChatConfig {
  defaultModel: string
  defaultFastModel: string
  defaultAgenticModel?: string
  maxTurns: number
  maxTokens: number
  reviewFrequency: number
  features: {
    reasoning: boolean
    webSearch: boolean
    deepResearch: boolean
    delegation: boolean
  }
}
