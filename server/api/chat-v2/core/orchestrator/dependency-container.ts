/**
 * Dependency Container for dependency injection
 * Provides access to services without tight coupling
 *
 * Updated for Phase 3: Added Strategy Registry
 */

import { ToolRegistry, createPiMonoToolRegistry } from "../../plugins/tools"
import {
  RetrieverRegistry,
  UnifiedVespaRetriever,
} from "../../plugins/retrievers"
import type { CitationRegistry } from "../../plugins/citations/citation-registry"
import { HybridMemoryService, DatabasePersistenceService } from "../../services"
import type {
  MemoryService,
  PersistenceService,
  PromptBuilderService,
} from "../../services"
import {
  NormalContextAssembler,
  AgentContextAssembler,
  AgenticContextAssembler,
  contextAssemblerRegistry,
} from "../pipeline/context-assembly"
import { ChatMode } from "../strategies/chat-mode-strategy"
import {
  StrategyRegistry,
  strategyRegistry,
} from "../strategies/strategy-registry"
import { registerStrategies } from "../strategies/bootstrap"
import type { GenerationPipeline } from "../pipeline/generation/generation-pipeline.interface"
import {
  StreamingGenerator,
  type LLMProvider,
  type LLMStreamEvent,
} from "../pipeline/generation/streaming-generator"
import type {
  DependencyContainer,
  ChatConfig,
} from "./dependency-container.types"
import { getProviderByModel, getProviderTypeByModel } from "@/ai/provider"
import type { Message } from "@aws-sdk/client-bedrock-runtime"
import type { ModelParams, Models } from "@/ai/types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import mainConfig from "@/config"
export type {
  DependencyContainer,
  ChatConfig,
} from "./dependency-container.types"

const Logger = getLogger(Subsystem.AI)

/**
 * Factory for creating dependency container with real implementations
 */
export function createDependencyContainer(
  overrides?: Partial<DependencyContainer>,
): DependencyContainer {
  // Create registries with actual implementations
  const tools = overrides?.tools ?? createToolRegistry()
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
    new NormalContextAssembler(),
  )
  contextAssemblerRegistry.register(
    ChatMode.Agentic,
    new AgenticContextAssembler(
      { includeAgentConfig: true },
      { agentId: "" }, // Will be set at runtime
    ),
  )
  contextAssemblerRegistry.setDefault(new NormalContextAssembler())

  // Register strategies
  registerStrategies()

  // Create generation pipeline with LLM provider adapter
  const generation = overrides?.generation ?? createGenerationPipeline()

  return {
    tools: overrides?.tools ?? tools,
    retrievers: overrides?.retrievers ?? retrievers,
    citations: overrides?.citations ?? citations,
    assemblers: contextAssemblerRegistry,
    strategies: overrides?.strategies ?? strategyRegistry,
    memory: overrides?.memory ?? memory,
    persistence: overrides?.persistence ?? persistence,
    promptBuilder: overrides?.promptBuilder ?? promptBuilder,
    generation,
    config: overrides?.config ?? getDefaultConfig(),
  }
}

/**
 * Create the generation pipeline with a StreamingGenerator
 * that wraps the existing LLM provider system
 */
function createGenerationPipeline(): GenerationPipeline {
  const llmProvider: LLMProvider = {
    async *streamCompletion(params) {
      console.log(
        `[LLMProvider] Starting streamCompletion for model: ${params.model}`,
      )
      console.log(`[LLMProvider] Messages count: ${params.messages.length}`)

      try {
        // Get provider type for better error messages
        const providerType = getProviderTypeByModel(params.model)
        console.log(
          `[LLMProvider] Provider type for ${params.model}: ${providerType || "NOT FOUND"}`,
        )

        // Get the provider for the requested model
        console.log("[LLMProvider] Getting provider by model...")
        let provider: any
        try {
          provider = getProviderByModel(params.model)
        } catch (e) {
          console.error(
            `[LLMProvider] Failed to get provider for ${params.model}:`,
            e,
          )
          // Fallback to LiteLLM if configured
          const { config } = await import("@/config")
          if (config.LiteLLMApiKey && config.LiteLLMBaseUrl) {
            console.log("[LLMProvider] Falling back to LiteLLM provider")
            const { LiteLLMProvider } = await import("@/ai/provider/litellm")
            provider = new LiteLLMProvider({
              apiKey: config.LiteLLMApiKey,
              baseUrl: config.LiteLLMBaseUrl,
              model: params.model,
            })
          } else {
            throw e
          }
        }
        console.log(
          `[LLMProvider] Provider obtained: ${provider ? "yes" : "no"}`,
        )

        // Convert messages to AWS Message format
        const messages: Message[] = params.messages.map((msg) => ({
          role:
            msg.role === "system"
              ? ("system" as const)
              : msg.role === "assistant"
                ? ("assistant" as const)
                : ("user" as const),
          content: [{ text: msg.content }],
        }))

        // Build model params
        const modelParams: ModelParams = {
          modelId: params.model,
          temperature: params.temperature ?? 0.7,
          max_new_tokens: params.maxTokens ?? 4096,
          stream: true,
          // Pass tools if available
          tools: params.tools?.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }

        console.log(
          `[LLMProvider] Model params: temperature=${modelParams.temperature}, maxTokens=${modelParams.max_new_tokens}`,
        )
        console.log(
          `[LLMProvider] Tools being sent to LLM: ${params.tools?.length || 0} tools`,
        )
        if (params.tools && params.tools.length > 0) {
          console.log(
            `[LLMProvider] Tool names: ${params.tools.map((t) => t.name).join(", ")}`,
          )
        }

        // Stream from the provider
        console.log("[LLMProvider] Starting converseStream...")
        const stream = provider.converseStream(messages, modelParams)
        console.log("[LLMProvider] Got stream, iterating...")

        let chunkCount = 0
        for await (const chunk of stream) {
          chunkCount++

          if (chunk.text) {
            yield {
              type: "token" as const,
              content: chunk.text,
            }
          }

          if (chunk.tool_calls && chunk.tool_calls.length > 0) {
            for (const toolCall of chunk.tool_calls) {
              yield {
                type: "tool-call" as const,
                tool: toolCall.function.name,
                toolCallId: toolCall.id || "",
                arguments: JSON.parse(toolCall.function.arguments || "{}"),
              }
            }
          }

          // Check if this is the end of the stream
          // Note: The provider may not explicitly signal completion
        }

        console.log(
          `[LLMProvider] Stream complete. Total chunks: ${chunkCount}`,
        )

        // Yield completion event
        yield {
          type: "complete" as const,
          finishReason: "stop",
        }
      } catch (error) {
        console.error("[LLMProvider] Error in streamCompletion:", error)
        Logger.error("LLM stream error:", error)
        yield {
          type: "error" as const,
          error: error instanceof Error ? error : new Error(String(error)),
        }
      }
    },
  }

  return new StreamingGenerator({
    llmProvider,
    maxTokens: 4096,
    temperature: 0.7,
  })
}

function getDefaultConfig(): ChatConfig {
  // Get default models from the main config
  // This ensures chat-v2 uses the same models as the rest of the app
  const defaultModel = mainConfig.defaultBestModel || "kimi-latest"
  const defaultFastModel = mainConfig.defaultFastModel || "kimi-latest"

  console.log(
    `[ChatV2 Config] Using models: default=${defaultModel}, fast=${defaultFastModel}`,
  )
  console.log(
    `[ChatV2 Config] Main config best model: ${mainConfig.defaultBestModel}`,
  )
  console.log(
    `[ChatV2 Config] Main config fast model: ${mainConfig.defaultFastModel}`,
  )

  return {
    defaultModel,
    defaultFastModel,
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

/**
 * Create and populate the tool registry with available tools
 * This replaces the hardcoded buildXyneTools() function
 */
function createToolRegistry(): ToolRegistry {
  console.log("[DependencyContainer] Creating tool registry...")

  // Use the pi-mono tool registry which registers all legacy tools
  const registry = createPiMonoToolRegistry()

  console.log(
    `[DependencyContainer] Tool registry created with ${registry.count} tools`,
  )
  console.log(
    `[DependencyContainer] Registered tools: ${registry.getNames().join(", ")}`,
  )

  return registry
}
