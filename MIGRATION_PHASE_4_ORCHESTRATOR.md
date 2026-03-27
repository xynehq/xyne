# Phase 4: Orchestrator & Migration - Detailed Implementation Guide

## Overview

**Duration**: 2 weeks  
**Goal**: Implement the ChatOrchestrator, all chat mode strategies, API layer, and establish migration path from legacy code  
**Risk Level**: High (integration point between new architecture and production traffic)  
**Rollback Strategy**: Feature flag `CHAT_V2_ENABLED` with request-level opt-in via header or query param; instant fallback to legacy `message-agents.ts`

---

## Phase 4 Objectives

1. **Implement ChatOrchestrator** - Central coordination layer that routes to appropriate strategies
2. **Implement All Chat Mode Strategies** - Normal, Agentic, Attachment, and KnowledgeBase strategies
3. **Create API Layer** - Hono routes, middleware, and SSE streaming handlers
4. **Build Feature Flag System** - Gradual rollout with per-request opt-in capability
5. **Implement Runtime Adapters** - Bridge pi-mono and JAF runtimes to new architecture
6. **Create Legacy Bridge** - Adapter to fall back to old implementation when needed
7. **Add Comprehensive Integration Tests** - End-to-end tests for all chat modes
8. **Write Migration Runbook** - Step-by-step guide for cutting over to new system

---

## Key Architectural Insight: Orchestrator as Traffic Controller

The **ChatOrchestrator** serves as the single entry point for all chat requests. Unlike the current system where logic is scattered across multiple files, the orchestrator:

```typescript
// Current: Logic scattered and duplicated
message-agents.ts (2000 lines) → handles some flows
pi-mono/message-agents.ts (1065 lines) → handles other flows
jaf-provider.ts (876 lines) → provider switching

// New: Single orchestrator delegates to strategies
ChatOrchestrator → Strategy → Pipeline → Response
```

**Critical Design Decision**: The orchestrator is **stateless** - all request state lives in `RequestContext`, enabling horizontal scaling and eliminating race conditions.

---

## Week 1: Orchestrator & Strategies

### Day 1-2: ChatOrchestrator Implementation

#### 1.1 Create ChatOrchestrator Core

**server/api/chat-v2/core/orchestrator/chat-orchestrator.ts**

```typescript
/**
 * ChatOrchestrator - Central coordination layer
 * 
 * REPLACES: message-agents.ts (both legacy and pi-mono versions)
 * BENEFITS:
 *   - Single entry point for all chat requests
 *   - Clean separation between routing and execution
 *   - Common concerns (auth, persistence, SSE) handled once
 *   - Easy to add new chat modes via strategies
 *   - Fully testable with mocked dependencies
 */

import type { ChatRequest } from "../../models"
import type { ChatEvent } from "../../shared/events"
import type { RequestContext } from "./request-context"
import type { ChatModeStrategy } from "../strategies/chat-mode-strategy"
import { ChatModeStrategyRegistry } from "../strategies/chat-mode-strategy"
import type { DependencyContainer } from "./dependency-container"
import { createDependencyContainer } from "./dependency-container"

export interface OrchestratorConfig {
  /** Strategy registry - can inject custom strategies for testing */
  strategyRegistry?: ChatModeStrategyRegistry
  /** Dependency container - can inject mocks for testing */
  dependencies?: DependencyContainer
  /** Enable detailed logging */
  debug?: boolean
}

export interface OrchestratorResult {
  /** Success flag */
  success: boolean
  /** Error details (if failed) */
  error?: OrchestratorError
  /** Number of events emitted */
  eventsEmitted: number
  /** Request duration in ms */
  durationMs: number
}

export interface OrchestratorError {
  code: string
  message: string
  recoverable: boolean
  details?: Record<string, unknown>
}

/**
 * ChatOrchestrator - Main entry point for chat processing
 * 
 * Responsibilities:
 * 1. Request validation
 * 2. Context creation
 * 3. Strategy selection
 * 4. Event streaming
 * 5. Error handling
 * 6. Cleanup
 */
export class ChatOrchestrator {
  private strategyRegistry: ChatModeStrategyRegistry
  private dependencies: DependencyContainer
  private debug: boolean

  constructor(config: OrchestratorConfig = {}) {
    this.strategyRegistry = config.strategyRegistry ?? new ChatModeStrategyRegistry()
    this.dependencies = config.dependencies ?? createDependencyContainer()
    this.debug = config.debug ?? false

    // Register default strategies if none provided
    this.registerDefaultStrategies()
  }

  /**
   * Process a chat request
   * 
   * This is the main entry point. It:
   * 1. Creates isolated RequestContext
   * 2. Selects appropriate strategy
   * 3. Streams events from strategy execution
   * 4. Handles errors gracefully
   * 5. Cleans up resources
   */
  async *process(
    request: ChatRequest,
    jwtPayload: import("./request-context").JWTPayload
  ): AsyncIterable<ChatEvent> {
    const startTime = Date.now()
    let requestContext: RequestContext | undefined
    let eventsEmitted = 0

    try {
      // Phase 1: Create request context
      this.log("Creating request context...")
      requestContext = await RequestContext.create(
        request,
        jwtPayload,
        this.dependencies
      )

      yield { type: "start" }
      eventsEmitted++

      // Phase 2: Select strategy
      this.log("Selecting strategy...")
      const strategy = this.selectStrategy(request)
      this.log(`Selected strategy: ${strategy.mode}`)

      // Phase 3: Optional strategy preparation
      if (strategy.prepare) {
        this.log("Preparing strategy...")
        await strategy.prepare(request, requestContext)
      }

      // Phase 4: Execute strategy and stream events
      this.log("Executing strategy...")
      for await (const event of strategy.execute(request, requestContext)) {
        // Check for cancellation
        if (requestContext.isAborted) {
          this.log("Request aborted, stopping execution")
          break
        }

        yield event
        eventsEmitted++

        // Persist certain events
        await this.handleEventPersistence(event, requestContext)
      }

      // Phase 5: Strategy cleanup
      if (strategy.cleanup) {
        this.log("Cleaning up strategy...")
        await strategy.cleanup(request, requestContext)
      }

      // Phase 6: Complete
      yield { type: "complete" }
      eventsEmitted++

      this.log(`Request completed. Events emitted: ${eventsEmitted}`)

    } catch (error) {
      this.log(`Error processing request: ${error}`)

      // Yield error event
      yield {
        type: "error",
        error: this.normalizeError(error),
      }
      eventsEmitted++

      // Attempt cleanup even on error
      if (requestContext) {
        try {
          const strategy = this.selectStrategy(request)
          if (strategy.cleanup) {
            await strategy.cleanup(request, requestContext)
          }
        } catch (cleanupError) {
          this.log(`Cleanup error: ${cleanupError}`)
        }
      }

    } finally {
      // Always dispose context
      if (requestContext) {
        // Context is garbage collected when it goes out of scope
        // No explicit disposal needed due to RequestContext design
      }

      const durationMs = Date.now() - startTime
      this.log(`Request handled in ${durationMs}ms`)
    }
  }

  /**
   * Select appropriate strategy for request
   */
  private selectStrategy(request: ChatRequest): ChatModeStrategy {
    return this.strategyRegistry.findFor(request)
  }

  /**
   * Register all default strategies
   */
  private registerDefaultStrategies(): void {
    // Only register if not already registered
    if (this.strategyRegistry.getAll().length > 0) {
      return
    }

    const { NormalChatStrategy } = require("../strategies/normal-chat.strategy")
    const { AgenticChatStrategy } = require("../strategies/agentic-chat.strategy")
    const { AttachmentChatStrategy } = require("../strategies/attachment-chat.strategy")
    const { KnowledgeBaseChatStrategy } = require("../strategies/kb-chat.strategy")

    this.strategyRegistry.register(ChatMode.Normal, new NormalChatStrategy())
    this.strategyRegistry.register(ChatMode.Agentic, new AgenticChatStrategy())
    this.strategyRegistry.register(ChatMode.Attachment, new AttachmentChatStrategy())
    this.strategyRegistry.register(ChatMode.KnowledgeBase, new KnowledgeBaseChatStrategy())

    // Set default
    this.strategyRegistry.setDefault(this.strategyRegistry.get(ChatMode.Normal)!)
  }

  /**
   * Handle persistence for specific event types
   */
  private async handleEventPersistence(
    event: ChatEvent,
    context: RequestContext
  ): Promise<void> {
    switch (event.type) {
      case "citation":
        // Citations are persisted with the final message
        break
      case "tool-result":
        // Tool results may trigger side effects
        break
      // Add other event types as needed
    }
  }

  /**
   * Normalize error to standard format
   */
  private normalizeError(error: unknown): import("../../shared/events").ChatError {
    if (error instanceof Error) {
      return {
        code: "ORCHESTRATOR_ERROR",
        message: error.message,
        recoverable: false,
        details: { stack: error.stack },
      }
    }

    return {
      code: "UNKNOWN_ERROR",
      message: String(error),
      recoverable: false,
    }
  }

  private log(message: string): void {
    if (this.debug) {
      console.log(`[ChatOrchestrator] ${message}`)
    }
  }
}

// Import needed for registration
import { ChatMode } from "../strategies/chat-mode-strategy"
```

#### 1.2 Create Orchestrator Factory

**server/api/chat-v2/core/orchestrator/orchestrator-factory.ts**

```typescript
/**
 * Orchestrator Factory
 * 
 * Creates configured orchestrator instances
 * Centralizes configuration and strategy registration
 */

import { ChatOrchestrator } from "./chat-orchestrator"
import { createDependencyContainer } from "./dependency-container"
import { ChatModeStrategyRegistry, ChatMode } from "../strategies/chat-mode-strategy"
import { NormalChatStrategy } from "../strategies/normal-chat.strategy"
import { AgenticChatStrategy } from "../strategies/agentic-chat.strategy"
import { AttachmentChatStrategy } from "../strategies/attachment-chat.strategy"
import { KnowledgeBaseChatStrategy } from "../strategies/kb-chat.strategy"

export interface OrchestratorFactoryConfig {
  /** Enable debug logging */
  debug?: boolean
  /** Custom strategy registry */
  strategyRegistry?: ChatModeStrategyRegistry
  /** Custom dependencies */
  dependencies?: import("./dependency-container").DependencyContainer
}

/**
 * Create a fully configured orchestrator
 */
export function createOrchestrator(config: OrchestratorFactoryConfig = {}): ChatOrchestrator {
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
function createDefaultStrategyRegistry(): ChatModeStrategyRegistry {
  const registry = new ChatModeStrategyRegistry()

  // Register strategies in priority order (first matching strategy wins)
  // KnowledgeBase is checked first because it's most specific
  registry.register(ChatMode.KnowledgeBase, new KnowledgeBaseChatStrategy())
  
  // Attachment mode handles file uploads
  registry.register(ChatMode.Attachment, new AttachmentChatStrategy())
  
  // Agentic mode for tool-using agents
  registry.register(ChatMode.Agentic, new AgenticChatStrategy())
  
  // Normal chat is the default
  const normalStrategy = new NormalChatStrategy()
  registry.register(ChatMode.Normal, normalStrategy)
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
```

### Day 3-4: Strategy Implementations

#### 2.1 Normal Chat Strategy

**server/api/chat-v2/core/strategies/normal-chat.strategy.ts**

```typescript
/**
 * Normal Chat Strategy
 * 
 * Simple chat without agentic loop
 * Direct question → retrieval → generation flow
 * 
 * REPLACES: Basic chat flow in message-agents.ts (lines 400-600)
 */

import type { ChatModeStrategy } from "./chat-mode-strategy"
import { ChatMode } from "./chat-mode-strategy"
import type { ChatRequest, AssembledChatContext, Fragment } from "../../models"
import type { ChatEvent } from "../../shared/events"
import type { RequestContext } from "../orchestrator/request-context"
import type { ContextAssembler } from "../pipeline/context-assembly/context-assembler.interface"
import type { GenerationPipeline } from "../pipeline/generation/generation-pipeline.interface"

export interface NormalChatStrategyConfig {
  /** Context assembler to use */
  contextAssembler?: ContextAssembler
  /** Generation pipeline to use */
  generationPipeline?: GenerationPipeline
  /** Max fragments to include */
  maxFragments?: number
}

export class NormalChatStrategy implements ChatModeStrategy {
  readonly mode = ChatMode.Normal
  private config: NormalChatStrategyConfig

  constructor(config: NormalChatStrategyConfig = {}) {
    this.config = {
      maxFragments: 10,
      ...config,
    }
  }

  /**
   * Can handle any request that doesn't have agent-specific markers
   */
  canHandle(request: ChatRequest): boolean {
    // Normal chat is the fallback - it can handle any request
    // but yields to more specific strategies
    return !request.agentId && !this.hasKnowledgeBaseScope(request)
  }

  /**
   * Execute normal chat flow:
   * 1. Assemble context
   * 2. Retrieve relevant documents
   * 3. Generate response
   */
  async *execute(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent> {
    // Step 1: Assemble context
    yield {
      type: "reasoning",
      step: {
        stage: "context_assembly",
        message: "Preparing context...",
        timestamp: new Date(),
      },
    }

    const assembler = this.getContextAssembler(context)
    const chatContext = await assembler.assemble(context)

    // Step 2: Retrieve documents
    yield {
      type: "reasoning",
      step: {
        stage: "retrieving",
        message: "Searching for relevant information...",
        timestamp: new Date(),
      },
    }

    const fragments = await this.retrieveDocuments(chatContext, context)

    yield {
      type: "reasoning",
      step: {
        stage: "documents_ranking",
        message: `Found ${fragments.length} relevant documents`,
        timestamp: new Date(),
      },
    }

    // Step 3: Generate response
    yield {
      type: "reasoning",
      step: {
        stage: "synthesizing",
        message: "Generating response...",
        timestamp: new Date(),
      },
    }

    const generator = this.getGenerationPipeline(context)

    for await (const event of generator.generate(chatContext, fragments, context)) {
      yield this.mapGenerationEvent(event)
    }
  }

  /**
   * Get or create context assembler
   */
  private getContextAssembler(context: RequestContext): ContextAssembler {
    if (this.config.contextAssembler) {
      return this.config.contextAssembler
    }

    // Get from registry or create default
    const { NormalContextAssembler } = require("../pipeline/context-assembly/normal-context-assembler")
    return new NormalContextAssembler()
  }

  /**
   * Retrieve relevant documents
   */
  private async retrieveDocuments(
    chatContext: AssembledChatContext,
    context: RequestContext
  ): Promise<Fragment[]> {
    const retriever = context.retrievers.get()
    const allFragments: Fragment[] = []

    // Search across all available apps
    for await (const result of retriever.search(
      chatContext.normalizedUserMessage,
      {
        limit: this.config.maxFragments,
        minConfidence: 0.5,
      },
      context
    )) {
      allFragments.push(...result.fragments)
    }

    // Sort by confidence and limit
    return allFragments
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, this.config.maxFragments)
  }

  /**
   * Get or create generation pipeline
   */
  private getGenerationPipeline(context: RequestContext): GenerationPipeline {
    if (this.config.generationPipeline) {
      return this.config.generationPipeline
    }

    // Import and create default streaming generator
    const { StreamingGenerator } = require("../pipeline/generation/streaming-generator")
    
    // Bridge to existing LLM provider
    const llmProvider = createLLMProviderBridge(context)

    return new StreamingGenerator({
      llmProvider,
      citationHandler: context.citations.getHandler(),
    })
  }

  /**
   * Map generation event to chat event
   */
  private mapGenerationEvent(
    event: import("../pipeline/generation/generation-pipeline.interface").GenerationEvent
  ): ChatEvent {
    switch (event.type) {
      case "token":
        return { type: "token", content: event.content }
      case "citation":
        return {
          type: "citation",
          citation: {
            index: event.citation.index,
            item: {
              docId: event.citation.docId,
              title: event.citation.title,
              url: event.citation.url,
              app: "document" as any,
              entity: "file" as any,
            },
          },
          citationMap: {},
        }
      case "error":
        return {
          type: "error",
          error: {
            code: event.error.code,
            message: event.error.message,
            recoverable: event.error.recoverable,
          },
        }
      case "complete":
        return { type: "complete" }
      default:
        // Other events not needed for normal chat
        return { type: "token", content: "" }
    }
  }

  /**
   * Check if request has knowledge base scope
   */
  private hasKnowledgeBaseScope(request: ChatRequest): boolean {
    // Check for KB-specific markers in request
    return !!request.modelConfig?.knowledgeBaseId ||
           (request.toolsList?.some(t => t.connectorId?.includes("kb")) ?? false)
  }
}

/**
 * Create LLM provider bridge to existing providers
 */
function createLLMProviderBridge(context: RequestContext): import("../pipeline/generation/streaming-generator").LLMProvider {
  return {
    async *streamCompletion(params) {
      // Bridge to existing JAF or pi-mono provider
      const provider = await getProvider(context)
      
      const stream = await provider.stream({
        messages: params.messages,
        model: params.model,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
      })

      for await (const chunk of stream) {
        if (chunk.type === "content") {
          yield { type: "token", content: chunk.content }
        } else if (chunk.type === "error") {
          yield { type: "error", error: new Error(chunk.error) }
        }
      }

      yield { type: "complete", finishReason: "stop" }
    },
  }
}

async function getProvider(context: RequestContext) {
  // Use existing provider selection logic
  const { getProviderForModel } = await import("../../../ai/provider-selector")
  return getProviderForModel(context.config.defaultModel)
}
```

#### 2.2 Agentic Chat Strategy

**server/api/chat-v2/core/strategies/agentic-chat.strategy.ts**

```typescript
/**
 * Agentic Chat Strategy
 * 
 * Full agentic loop with tool calling
 * Implements plan → execute → observe → revise cycle
 * 
 * REPLACES: pi-mono agent flow in pi-mono/message-agents.ts (lines 600-900)
 */

import type { ChatModeStrategy } from "./chat-mode-strategy"
import { ChatMode } from "./chat-mode-strategy"
import type { ChatRequest, AssembledChatContext, Fragment, Tool } from "../../models"
import type { ChatEvent } from "../../shared/events"
import type { RequestContext } from "../orchestrator/request-context"
import type { AgentRuntime, AgentSession } from "../runtime/runtime.interface"

export interface AgenticChatStrategyConfig {
  /** Max turns before forcing synthesis */
  maxTurns?: number
  /** Enable review step */
  enableReview?: boolean
  /** Review frequency (every N turns) */
  reviewFrequency?: number
}

export class AgenticChatStrategy implements ChatModeStrategy {
  readonly mode = ChatMode.Agentic
  private config: AgenticChatStrategyConfig
  private runtime: AgentRuntime | undefined
  private session: AgentSession | undefined

  constructor(config: AgenticChatStrategyConfig = {}) {
    this.config = {
      maxTurns: 10,
      enableReview: true,
      reviewFrequency: 5,
      ...config,
    }
  }

  /**
   * Can handle requests with agentId
   */
  canHandle(request: ChatRequest): boolean {
    return !!request.agentId
  }

  /**
   * Prepare agent context before execution
   */
  async prepare(request: ChatRequest, context: RequestContext): Promise<void> {
    // Validate agent exists and user has permission
    const agent = await context.persistence.getAgentById(
      request.agentId!,
      context.user.workspaceId
    )

    if (!agent) {
      throw new Error(`Agent not found: ${request.agentId}`)
    }

    // Store agent in context metadata for later use
    context.setMetadata("agentConfig", agent)
  }

  /**
   * Execute agentic chat flow:
   * 1. Assemble agent context
   * 2. Initialize runtime
   * 3. Run agent loop
   * 4. Handle tool calls
   * 5. Final synthesis
   */
  async *execute(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent> {
    const agentConfig = context.getMetadata("agentConfig") as any

    // Step 1: Assemble context
    yield this.createReasoningEvent("agent_started", "Initializing agent...")

    const assembler = this.getAgentContextAssembler(context)
    const chatContext = await assembler.assemble(context)

    // Step 2: Get available tools
    const tools = this.selectTools(chatContext, context)
    yield this.createReasoningEvent(
      "tool_selected",
      `Agent has ${tools.length} tools available`
    )

    // Step 3: Create runtime session
    this.runtime = this.createRuntime(context)
    this.session = await this.runtime.createSession({
      model: agentConfig.model || context.config.defaultAgenticModel,
      systemPrompt: this.buildSystemPrompt(chatContext, tools),
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    })

    // Step 4: Run agent loop
    const agentState = context.getAgentState()
    let turnCount = 0

    yield this.createReasoningEvent("turn_started", "Starting agent loop...")

    while (turnCount < this.config.maxTurns!) {
      if (context.isAborted) {
        yield this.createReasoningEvent("turn_ended", "Request aborted")
        break
      }

      turnCount++
      agentState.turnCount = turnCount

      // Run one turn
      const turnResult = await this.runAgentTurn(
        request.message,
        context,
        agentState
      )

      // Handle turn result
      for await (const event of this.handleTurnResult(turnResult, context, agentState)) {
        yield event
      }

      // Check if we should synthesize
      if (this.shouldSynthesize(agentState, turnResult)) {
        yield this.createReasoningEvent("synthesis_started", "Generating final answer...")
        
        for await (const event of this.runSynthesis(context, agentState)) {
          yield event
        }

        agentState.synthesis.completed = true
        break
      }

      // Run review if enabled
      if (this.shouldReview(agentState)) {
        yield this.createReasoningEvent("reviewing", "Reviewing progress...")
        
        const reviewResult = await this.runReview(context, agentState)
        
        if (reviewResult.recommendation === "replan") {
          yield this.createReasoningEvent("planning", "Adjusting plan...")
          await this.replan(context, agentState)
        }
      }
    }

    // Force synthesis if max turns reached
    if (!agentState.synthesis.completed && turnCount >= this.config.maxTurns!) {
      yield this.createReasoningEvent(
        "synthesis_started",
        "Max turns reached, generating final answer..."
      )
      
      for await (const event of this.runSynthesis(context, agentState)) {
        yield event
      }
    }

    yield this.createReasoningEvent("agent_ended", "Agent execution complete")
  }

  /**
   * Cleanup runtime resources
   */
  async cleanup(request: ChatRequest, context: RequestContext): Promise<void> {
    if (this.session) {
      this.session.stop()
      this.session = undefined
    }
    this.runtime = undefined
  }

  // ... (additional private methods for runAgentTurn, handleTurnResult, etc.)

  private createReasoningEvent(
    stage: string,
    message: string
  ): ChatEvent {
    return {
      type: "reasoning",
      step: {
        stage: stage as any,
        message,
        timestamp: new Date(),
      },
    }
  }

  private getAgentContextAssembler(context: RequestContext) {
    const { AgentContextAssembler } = require("../pipeline/context-assembly/agent-context-assembler")
    return new AgentContextAssembler(
      {},
      { agentId: context.request.agentId! }
    )
  }

  private selectTools(chatContext: AssembledChatContext, context: RequestContext): Tool[] {
    const toolRegistry = context.tools
    
    if (chatContext.agentConfig?.tools) {
      return chatContext.agentConfig.tools
        .map(name => toolRegistry.get(name))
        .filter((t): t is Tool => !!t)
    }

    return toolRegistry.getForMode(ChatMode.Agentic)
  }

  private createRuntime(context: RequestContext): AgentRuntime {
    // Use pi-mono runtime by default
    const { PiMonoRuntime } = require("../runtime/pi-mono-runtime")
    return new PiMonoRuntime()
  }

  private buildSystemPrompt(chatContext: AssembledChatContext, tools: Tool[]): string {
    const parts: string[] = []

    if (chatContext.agentConfig?.systemPrompt) {
      parts.push(chatContext.agentConfig.systemPrompt)
    }

    parts.push(chatContext.agentConfig?.prompt || "You are a helpful AI assistant.")

    if (tools.length > 0) {
      parts.push("\nAvailable tools:")
      for (const tool of tools) {
        parts.push(`- ${tool.name}: ${tool.description}`)
      }
      parts.push("\nUse these tools to help answer the user's question.")
    }

    return parts.join("\n\n")
  }

  private async runAgentTurn(
    message: string,
    context: RequestContext,
    agentState: import("../../models/agent-state").AgentState
  ): Promise<any> {
    // Implementation delegates to runtime
    return this.session!.sendMessage(message)
  }

  private async *handleTurnResult(
    result: any,
    context: RequestContext,
    agentState: import("../../models/agent-state").AgentState
  ): AsyncIterable<ChatEvent> {
    // Handle tool calls, streaming, etc.
    // This is a simplified version - full implementation handles all event types
    yield { type: "token", content: result.content || "" }
  }

  private shouldSynthesize(agentState: any, turnResult: any): boolean {
    return turnResult.finishReason === "stop" || 
           agentState.synthesis.requested
  }

  private shouldReview(agentState: any): boolean {
    if (!this.config.enableReview) return false
    
    const turnsSinceReview = agentState.turnCount - (agentState.review.lastReviewTurn || 0)
    return turnsSinceReview >= this.config.reviewFrequency!
  }

  private async runReview(context: RequestContext, agentState: any): Promise<any> {
    // Implementation of review logic
    return { recommendation: "proceed" }
  }

  private async replan(context: RequestContext, agentState: any): Promise<void> {
    // Implementation of replanning logic
  }

  private async *runSynthesis(
    context: RequestContext,
    agentState: any
  ): AsyncIterable<ChatEvent> {
    // Implementation of final synthesis
    yield this.createReasoningEvent("synthesis_completed", "Final answer generated")
  }
}
```

#### 2.3 Attachment Chat Strategy

**server/api/chat-v2/core/strategies/attachment-chat.strategy.ts**

```typescript
/**
 * Attachment Chat Strategy
 * 
 * Chat focused on analyzing uploaded files
 * Pre-loads attachment context and can delegate to other strategies
 * 
 * REPLACES: Attachment handling in message-agents.ts (lines 300-400)
 */

import type { ChatModeStrategy } from "./chat-mode-strategy"
import { ChatMode } from "./chat-mode-strategy"
import type { ChatRequest } from "../../models"
import type { ChatEvent } from "../../shared/events"
import type { RequestContext } from "../orchestrator/request-context"

export class AttachmentChatStrategy implements ChatModeStrategy {
  readonly mode = ChatMode.Attachment
  private delegateStrategy: ChatModeStrategy | undefined

  /**
   * Can handle requests with attachments
   */
  canHandle(request: ChatRequest): boolean {
    return !!request.attachments && request.attachments.length > 0
  }

  /**
   * Prepare attachment context
   */
  async prepare(request: ChatRequest, context: RequestContext): Promise<void> {
    // Process attachments early
    const attachmentContext = await context.persistence.prepareAttachmentContext(
      request.attachments!
    )
    
    context.setMetadata("attachmentContext", attachmentContext)

    // Determine if we should delegate to agentic mode
    if (request.agentId) {
      const { AgenticChatStrategy } = require("./agentic-chat.strategy")
      this.delegateStrategy = new AgenticChatStrategy()
      await this.delegateStrategy.prepare?.(request, context)
    } else {
      const { NormalChatStrategy } = require("./normal-chat.strategy")
      this.delegateStrategy = new NormalChatStrategy()
    }
  }

  /**
   * Execute attachment-focused chat
   * 
   * 1. Process attachments
   * 2. Analyze content
   * 3. Delegate to appropriate strategy with attachment context
   */
  async *execute(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent> {
    const attachmentContext = context.getMetadata("attachmentContext") as any

    // Announce attachment processing
    yield {
      type: "reasoning",
      step: {
        stage: "attachment_analyzing",
        message: `Analyzing ${attachmentContext.files.length} attachment(s)...`,
        timestamp: new Date(),
      },
    }

    // If we have image attachments, process them
    const images = attachmentContext.files.filter((f: any) => f.isImage)
    if (images.length > 0) {
      yield {
        type: "reasoning",
        step: {
          stage: "attachment_extracted",
          message: `Processing ${images.length} image(s)...`,
          timestamp: new Date(),
        },
      }
    }

    // Delegate to underlying strategy
    if (this.delegateStrategy) {
      for await (const event of this.delegateStrategy.execute(request, context)) {
        yield event
      }
    }
  }

  async cleanup(request: ChatRequest, context: RequestContext): Promise<void> {
    await this.delegateStrategy?.cleanup?.(request, context)
  }
}
```

#### 2.4 Knowledge Base Chat Strategy

**server/api/chat-v2/core/strategies/kb-chat.strategy.ts**

```typescript
/**
 * Knowledge Base Chat Strategy
 * 
 * Chat scoped to specific knowledge base collections/folders
 * Uses KB-specific retrieval pipeline
 * 
 * REPLACES: KB search logic scattered across search tools
 */

import type { ChatModeStrategy } from "./chat-mode-strategy"
import { ChatMode } from "./chat-mode-strategy"
import type { ChatRequest, AssembledChatContext, Fragment } from "../../models"
import type { ChatEvent } from "../../shared/events"
import type { RequestContext } from "../orchestrator/request-context"
import { Apps } from "@xyne/vespa-ts/types"

export interface KBChatStrategyConfig {
  /** Default result limit */
  defaultLimit?: number
  /** Enable cross-collection search */
  enableCrossCollection?: boolean
}

export class KnowledgeBaseChatStrategy implements ChatModeStrategy {
  readonly mode = ChatMode.KnowledgeBase
  private config: KBChatStrategyConfig
  private kbScope: any

  constructor(config: KBChatStrategyConfig = {}) {
    this.config = {
      defaultLimit: 15,
      enableCrossCollection: false,
      ...config,
    }
  }

  /**
   * Can handle requests with KB scope
   */
  canHandle(request: ChatRequest): boolean {
    // Check for explicit KB ID
    if (request.modelConfig?.knowledgeBaseId) {
      return true
    }

    // Check for KB tools
    if (request.toolsList?.some(t => t.connectorId?.includes("knowledge-base"))) {
      return true
    }

    // Check for agent with KB access
    if (request.agentId) {
      // Will be validated in prepare()
      return true
    }

    return false
  }

  /**
   * Prepare KB scope
   */
  async prepare(request: ChatRequest, context: RequestContext): Promise<void> {
    // Extract KB scope from request
    this.kbScope = await this.extractKBScope(request, context)
    
    context.setMetadata("kbScope", this.kbScope)
  }

  /**
   * Execute KB-scoped chat
   */
  async *execute(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent> {
    // Assemble context
    const assembler = this.getKBContextAssembler(context)
    const chatContext = await assembler.assemble(context)

    // Retrieve from KB only
    yield {
      type: "reasoning",
      step: {
        stage: "retrieving",
        message: "Searching knowledge base...",
        timestamp: new Date(),
      },
    }

    const fragments = await this.retrieveFromKB(chatContext, context)

    yield {
      type: "reasoning",
      step: {
        stage: "documents_ranking",
        message: `Found ${fragments.length} documents in knowledge base`,
        timestamp: new Date(),
      },
    }

    // Generate response
    const generator = this.getGenerationPipeline(context)

    for await (const event of generator.generate(chatContext, fragments, context)) {
      yield this.mapGenerationEvent(event)
    }
  }

  private async extractKBScope(request: ChatRequest, context: RequestContext): Promise<any> {
    // Extract from model config
    if (request.modelConfig?.knowledgeBaseId) {
      return {
        collectionIds: [request.modelConfig.knowledgeBaseId],
      }
    }

    // Extract from agent config
    if (request.agentId) {
      const agent = await context.persistence.getAgentById(
        request.agentId,
        context.user.workspaceId
      )
      
      if (agent?.allowedCollections) {
        return {
          collectionIds: agent.allowedCollections,
          folderIds: agent.allowedFolders,
          fileIds: agent.allowedFiles,
        }
      }
    }

    // Default: user-owned KBs
    return {
      scope: "user_owned",
      email: context.user.email,
    }
  }

  private async retrieveFromKB(
    chatContext: AssembledChatContext,
    context: RequestContext
  ): Promise<Fragment[]> {
    const retriever = context.retrievers.get()
    const allFragments: Fragment[] = []

    for await (const result of retriever.searchKnowledgeBase(
      chatContext.normalizedUserMessage,
      {
        limit: this.config.defaultLimit,
        ...this.kbScope,
      },
      context
    )) {
      allFragments.push(...result.fragments)
    }

    return allFragments
  }

  private getKBContextAssembler(context: RequestContext) {
    const { NormalContextAssembler } = require("../pipeline/context-assembly/normal-context-assembler")
    return new NormalContextAssembler()
  }

  private getGenerationPipeline(context: RequestContext) {
    const { StreamingGenerator } = require("../pipeline/generation/streaming-generator")
    
    return new StreamingGenerator({
      llmProvider: createLLMProviderBridge(context),
    })
  }

  private mapGenerationEvent(event: any): ChatEvent {
    // Same as NormalChatStrategy
    return event
  }
}

function createLLMProviderBridge(context: RequestContext): any {
  // Implementation similar to NormalChatStrategy
  return {
    async *streamCompletion() {
      yield { type: "complete", finishReason: "stop" }
    },
  }
}
```

### Day 5-7: Runtime Adapters

#### 3.1 Runtime Interface

**server/api/chat-v2/core/runtime/runtime.interface.ts**

```typescript
/**
 * Runtime Interface
 * 
 * Abstracts different LLM runtimes (pi-mono, JAF, future alternatives)
 */

import type { Tool } from "../../models"

export interface AgentRuntime {
  /**
   * Create a new session
   */
  createSession(config: SessionConfig): Promise<AgentSession>
}

export interface AgentSession {
  readonly id: string

  /**
   * Send a message to the agent
   */
  sendMessage(message: string): Promise<AgentResponse>

  /**
   * Subscribe to events
   */
  subscribe(handler: EventHandler): Unsubscribe

  /**
   * Stop the session
   */
  stop(): void
}

export interface SessionConfig {
  model: string
  systemPrompt?: string
  tools?: ToolConfig[]
  temperature?: number
  maxTokens?: number
}

export interface ToolConfig {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface AgentResponse {
  content?: string
  toolCalls?: ToolCallRequest[]
  finishReason: "stop" | "tool-calls" | "length" | "error"
}

export interface ToolCallRequest {
  id: string
  tool: string
  arguments: Record<string, unknown>
}

export type EventHandler = (event: RuntimeEvent) => void
export type Unsubscribe = () => void

export type RuntimeEvent =
  | { type: "token"; content: string }
  | { type: "tool-call"; call: ToolCallRequest }
  | { type: "tool-result"; callId: string; result: unknown }
  | { type: "error"; error: Error }
  | { type: "complete"; finishReason: string }
```

#### 3.2 pi-mono Runtime Adapter

**server/api/chat-v2/core/runtime/pi-mono-runtime.ts**

```typescript
/**
 * pi-mono Runtime Adapter
 * 
 * Bridges new architecture to existing @mariozechner/pi-coding-agent
 */

import type {
  AgentRuntime,
  AgentSession,
  SessionConfig,
  AgentResponse,
  EventHandler,
  Unsubscribe,
} from "./runtime.interface"

export class PiMonoRuntime implements AgentRuntime {
  async createSession(config: SessionConfig): Promise<AgentSession> {
    // Bridge to existing pi-mono session creation
    const { createAgentSession } = await import("../../../api/chat/pi-mono/core/runtime")
    
    const piMonoSession = await createAgentSession({
      model: config.model,
      systemPrompt: config.systemPrompt,
      tools: config.tools,
    })

    return new PiMonoSessionAdapter(piMonoSession)
  }
}

class PiMonoSessionAdapter implements AgentSession {
  readonly id: string
  private piMonoSession: any
  private handlers: EventHandler[] = []

  constructor(piMonoSession: any) {
    this.piMonoSession = piMonoSession
    this.id = piMonoSession.id

    // Subscribe to pi-mono events and forward
    this.piMonoSession.on("event", (event: any) => {
      const runtimeEvent = this.mapPiMonoEvent(event)
      this.handlers.forEach(h => h(runtimeEvent))
    })
  }

  async sendMessage(message: string): Promise<AgentResponse> {
    const result = await this.piMonoSession.sendMessage(message)
    
    return {
      content: result.content,
      toolCalls: result.toolCalls?.map((tc: any) => ({
        id: tc.id,
        tool: tc.name,
        arguments: tc.arguments,
      })),
      finishReason: this.mapFinishReason(result.finishReason),
    }
  }

  subscribe(handler: EventHandler): Unsubscribe {
    this.handlers.push(handler)
    return () => {
      const index = this.handlers.indexOf(handler)
      if (index > -1) {
        this.handlers.splice(index, 1)
      }
    }
  }

  stop(): void {
    this.piMonoSession.stop()
    this.handlers = []
  }

  private mapPiMonoEvent(event: any): import("./runtime.interface").RuntimeEvent {
    switch (event.type) {
      case "content":
        return { type: "token", content: event.content }
      case "tool_call":
        return {
          type: "tool-call",
          call: {
            id: event.callId,
            tool: event.toolName,
            arguments: event.arguments,
          },
        }
      case "error":
        return { type: "error", error: new Error(event.message) }
      case "complete":
        return { type: "complete", finishReason: event.finishReason }
      default:
        return { type: "token", content: "" }
    }
  }

  private mapFinishReason(reason: string): "stop" | "tool-calls" | "length" | "error" {
    switch (reason) {
      case "stop":
        return "stop"
      case "tool_calls":
        return "tool-calls"
      case "length":
        return "length"
      default:
        return "error"
    }
  }
}
```

---

## Week 2: API Layer & Migration

### Day 8-10: API Layer Implementation

#### 4.1 Hono Routes

**server/api/chat-v2/api/routes.ts**

```typescript
/**
 * Chat V2 API Routes
 * 
 * Hono route definitions for new chat architecture
 */

import { Hono } from "hono"
import { chatHandler } from "./handlers/chat.handler"
import { streamHandler } from "./handlers/streaming.handler"
import { authMiddleware } from "./middleware/auth"
import { validationMiddleware } from "./middleware/validation"
import { featureFlagMiddleware } from "./middleware/feature-flag"

const app = new Hono()

// Apply global middleware
app.use("*", authMiddleware)
app.use("*", featureFlagMiddleware)

// Main chat endpoint
app.post("/api/chat-v2/message",
  validationMiddleware,
  chatHandler
)

// Stream test endpoint (for debugging)
app.get("/api/chat-v2/stream-test", streamHandler)

export default app
```

#### 4.2 Chat Handler

**server/api/chat-v2/api/handlers/chat.handler.ts**

```typescript
/**
 * Chat Handler
 * 
 * HTTP handler for chat requests
 * Bridges Hono to ChatOrchestrator
 */

import type { Context } from "hono"
import type { ChatRequest } from "../../models"
import { getGlobalOrchestrator } from "../../core/orchestrator/orchestrator-factory"
import { toSSEEvent } from "../../shared/events"

export async function chatHandler(c: Context) {
  const startTime = Date.now()

  try {
    // Parse request body
    const body = await c.req.json<ChatRequest>()

    // Extract JWT payload (set by auth middleware)
    const jwtPayload = c.get("jwtPayload")

    // Get orchestrator
    const orchestrator = getGlobalOrchestrator()

    // Set up SSE stream
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Process request through orchestrator
          for await (const event of orchestrator.process(body, jwtPayload)) {
            // Convert to SSE format
            const sseEvent = toSSEEvent(event)
            
            // Send event
            controller.enqueue(
              new TextEncoder().encode(
                `event: ${sseEvent.event}\ndata: ${sseEvent.data}\n\n`
              )
            )

            // Stop if complete or error
            if (event.type === "complete" || event.type === "error") {
              controller.close()
              break
            }
          }
        } catch (error) {
          // Send error event
          const errorEvent = {
            event: "ERROR",
            data: JSON.stringify({
              error: {
                code: "STREAM_ERROR",
                message: error instanceof Error ? error.message : String(error),
                recoverable: false,
              },
            }),
          }
          
          controller.enqueue(
            new TextEncoder().encode(
              `event: ${errorEvent.event}\ndata: ${errorEvent.data}\n\n`
            )
          )
          controller.close()
        }
      },

      cancel() {
        // Handle client disconnect
        console.log("Client disconnected")
      },
    })

    // Return SSE response
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    })

  } catch (error) {
    // Return JSON error for non-streaming errors
    return c.json(
      {
        error: {
          code: "REQUEST_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      400
    )
  }
}
```

#### 4.3 Middleware

**server/api/chat-v2/api/middleware/feature-flag.ts**

```typescript
/**
 * Feature Flag Middleware
 * 
 * Controls access to chat-v2 based on feature flags
 * Supports gradual rollout with per-request opt-in
 */

import type { Context, Next } from "hono"
import config from "@/config"

export async function featureFlagMiddleware(c: Context, next: Next) {
  // Check global feature flag
  const v2Enabled = config.features?.chatV2 === true

  // Check request-level opt-in
  const optInHeader = c.req.header("X-Chat-V2")
  const optInQuery = c.req.query("v2")
  const requestOptIn = optInHeader === "true" || optInQuery === "true"

  // Check user-specific rollout (e.g., 10% of users)
  const userId = c.get("jwtPayload")?.userId
  const userInRollout = isUserInRollout(userId, config.features?.chatV2RolloutPercentage || 0)

  // Determine if V2 should be used
  const useV2 = v2Enabled && (requestOptIn || userInRollout)

  // Store decision in context
  c.set("useChatV2", useV2)

  if (!useV2) {
    // Fall back to legacy implementation
    return c.json(
      {
        error: "Chat V2 not enabled",
        message: "Use /api/chat/message for legacy implementation",
      },
      404
    )
  }

  await next()
}

/**
 * Determine if user is in rollout based on user ID hash
 */
function isUserInRollout(userId: number | undefined, percentage: number): boolean {
  if (!userId || percentage <= 0) return false
  if (percentage >= 100) return true

  // Simple hash of user ID
  const hash = userId * 2654435761 % 100
  return hash < percentage
}
```

**server/api/chat-v2/api/middleware/auth.ts**

```typescript
/**
 * Auth Middleware
 * 
 * JWT validation and user context extraction
 */

import type { Context, Next } from "hono"
import { verify } from "jsonwebtoken"
import config from "@/config"

export async function authMiddleware(c: Context, next: Next) {
  // Skip auth for health checks
  if (c.req.path === "/health") {
    await next()
    return
  }

  const authHeader = c.req.header("Authorization")
  
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401)
  }

  const token = authHeader.substring(7)

  try {
    const payload = verify(token, config.jwtSecret) as any
    
    // Store JWT payload in context
    c.set("jwtPayload", {
      sub: payload.sub,
      userId: payload.userId,
      workspaceId: payload.workspaceId,
      workspaceNumericId: payload.workspaceNumericId,
      email: payload.sub,
      timeZone: payload.timeZone || "UTC",
    })

    await next()
  } catch (error) {
    return c.json({ error: "Invalid token" }, 401)
  }
}
```

**server/api/chat-v2/api/middleware/validation.ts**

```typescript
/**
 * Validation Middleware
 * 
 * Validates incoming chat request structure
 */

import type { Context, Next } from "hono"

export async function validationMiddleware(c: Context, next: Next) {
  try {
    const body = await c.req.json()

    // Validate required fields
    if (!body.message || typeof body.message !== "string") {
      return c.json(
        { error: "Bad Request", message: "message is required and must be a string" },
        400
      )
    }

    if (body.message.length > 10000) {
      return c.json(
        { error: "Bad Request", message: "message exceeds maximum length of 10000" },
        400
      )
    }

    // Validate optional fields
    if (body.attachments && !Array.isArray(body.attachments)) {
      return c.json(
        { error: "Bad Request", message: "attachments must be an array" },
        400
      )
    }

    if (body.modelConfig && typeof body.modelConfig !== "object") {
      return c.json(
        { error: "Bad Request", message: "modelConfig must be an object" },
        400
      )
    }

    await next()
  } catch (error) {
    return c.json(
      { error: "Bad Request", message: "Invalid JSON body" },
      400
    )
  }
}
```

### Day 11-12: Legacy Bridge & Migration

#### 5.1 Legacy Bridge Adapter

**server/api/chat-v2/legacy/bridge.ts**

```typescript
/**
 * Legacy Bridge
 * 
 * Provides fallback to legacy implementation when:
 * - Feature flag is off
 * - New implementation encounters error
 * - Specific request requires legacy behavior
 */

import type { ChatRequest } from "../models"
import type { ChatEvent } from "../shared/events"

export interface LegacyBridgeConfig {
  /** Enable automatic fallback on errors */
  enableFallback?: boolean
  /** Log bridge decisions */
  debug?: boolean
}

/**
 * Execute request using legacy implementation
 */
export async function *executeLegacy(
  request: ChatRequest,
  jwtPayload: any,
  config: LegacyBridgeConfig = {}
): AsyncIterable<ChatEvent> {
  const { enableFallback = true, debug = false } = config

  if (debug) {
    console.log("[LegacyBridge] Falling back to legacy implementation")
  }

  try {
    // Import legacy handler dynamically to avoid loading if not needed
    const { MessageAgents } = await import("../api/chat/message-agents")
    
    // Convert request to legacy format
    const legacyRequest = convertToLegacyFormat(request, jwtPayload)

    // Execute legacy handler
    const legacyStream = await MessageAgents(legacyRequest)

    // Convert legacy events to new format
    for await (const legacyEvent of legacyStream) {
      yield convertLegacyEvent(legacyEvent)
    }

  } catch (error) {
    if (debug) {
      console.error("[LegacyBridge] Legacy execution failed:", error)
    }

    yield {
      type: "error",
      error: {
        code: "LEGACY_ERROR",
        message: "Both new and legacy implementations failed",
        recoverable: false,
        details: { originalError: String(error) },
      },
    }
  }
}

/**
 * Convert new format request to legacy format
 */
function convertToLegacyFormat(request: ChatRequest, jwtPayload: any): any {
  return {
    message: request.message,
    chatId: request.chatId,
    agentId: request.agentId,
    modelConfig: request.modelConfig,
    attachments: request.attachments,
    toolsList: request.toolsList,
    // JWT info
    user: {
      id: jwtPayload.userId,
      email: jwtPayload.email,
      workspaceId: jwtPayload.workspaceId,
    },
  }
}

/**
 * Convert legacy event to new format
 */
function convertLegacyEvent(legacy: any): ChatEvent {
  switch (legacy.event) {
    case "RESPONSE_UPDATE":
      return { type: "token", content: legacy.data }
    
    case "CITATIONS_UPDATE":
      return {
        type: "citation",
        citation: {
          index: legacy.data.index,
          item: legacy.data.item,
        },
        citationMap: legacy.data.citationMap || {},
      }
    
    case "REASONING":
      return {
        type: "reasoning",
        step: {
          stage: legacy.data.stage,
          message: legacy.data.message,
          timestamp: new Date(),
        },
      }
    
    case "ERROR":
      return {
        type: "error",
        error: {
          code: legacy.data.code || "LEGACY_ERROR",
          message: legacy.data.message,
          recoverable: false,
        },
      }
    
    case "END":
      return { type: "complete" }
    
    default:
      return { type: "token", content: "" }
  }
}
```

#### 5.2 Migration Runbook

**server/api/chat-v2/MIGRATION_RUNBOOK.md**

```markdown
# Chat V2 Migration Runbook

## Pre-Migration Checklist

- [ ] Phase 1 (Foundation) complete and tested
- [ ] Phase 2 (Pipeline) complete and tested
- [ ] Phase 3 (Strategies) complete and tested
- [ ] Integration tests passing
- [ ] Load testing completed
- [ ] Monitoring dashboards ready
- [ ] Rollback plan documented

## Migration Phases

### Phase A: Dark Launch (Week 1)

**Goal**: Run new implementation in parallel without affecting users

1. Deploy new code with `CHAT_V2_ENABLED=false`
2. Verify no errors in logs
3. Run shadow traffic (duplicate requests, discard responses)
4. Compare outputs between old and new

```bash
# Enable shadow mode
curl -X POST /admin/features \
  -d '{"chatV2ShadowMode": true}'
```

### Phase B: Internal Testing (Week 2)

**Goal**: Team dogfoods new implementation

1. Enable for internal team only:
```bash
curl -X POST /admin/features \
  -d '{"chatV2EnabledUsers": ["team@xynehq.com"]}'
```

2. Daily bug triage
3. Performance monitoring
4. Gather feedback

### Phase C: Gradual Rollout (Week 3-4)

**Goal**: Slowly increase traffic to new implementation

1. Enable for 1% of users:
```bash
# Set rollout percentage
curl -X POST /admin/features \
  -d '{"chatV2RolloutPercentage": 1}'
```

2. Monitor error rates, latency, user feedback
3. Increase by 5% daily if metrics healthy:
   - Error rate < 0.1%
   - P95 latency < 5s
   - No increase in support tickets

4. Target ramp:
   - Week 3: 1% → 25%
   - Week 4: 25% → 100%

### Phase D: Full Cutover (Week 5)

**Goal**: Complete migration

1. Enable for 100%:
```bash
curl -X POST /admin/features \
  -d '{"chatV2Enabled": true, "chatV2RolloutPercentage": 100}'
```

2. Monitor for 48 hours
3. If stable, begin legacy code removal

## Rollback Procedure

### Automatic Rollback Triggers

- Error rate > 1%
- P95 latency > 10s
- Any P0 incident reported

### Manual Rollback

```bash
# Disable V2 instantly
curl -X POST /admin/features \
  -d '{"chatV2Enabled": false}'

# Verify rollback
curl /admin/features
```

### Partial Rollback

If specific feature causing issues:

```bash
# Disable only agentic mode
curl -X POST /admin/features \
  -d '{"chatV2AgenticEnabled": false}'
```

## Post-Migration

### Legacy Code Removal (Week 6-8)

1. Remove old message-agents.ts
2. Remove pi-mono/ directory
3. Update imports
4. Remove feature flags

### Documentation Updates

1. Update API documentation
2. Update developer guides
3. Update architecture diagrams

### Team Enablement

1. Training sessions on new architecture
2. Code review guidelines update
3. Onboarding doc updates
```

### Day 13-14: Integration & Testing

#### 6.1 Integration Tests

**server/api/chat-v2/__tests__/integration/chat-flow.test.ts**

```typescript
/**
 * Integration Tests for Chat V2
 * 
 * End-to-end tests for all chat modes
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { ChatOrchestrator } from "../../core/orchestrator/chat-orchestrator"
import { createTestContainer } from "../test-utils"
import type { ChatRequest } from "../../models"

describe("ChatOrchestrator Integration", () => {
  let orchestrator: ChatOrchestrator

  beforeAll(() => {
    orchestrator = new ChatOrchestrator({
      dependencies: createTestContainer(),
      debug: true,
    })
  })

  describe("Normal Chat", () => {
    it("should handle simple question", async () => {
      const request: ChatRequest = {
        message: "What is the weather today?",
      }

      const jwtPayload = {
        sub: "test@example.com",
        userId: 1,
        workspaceId: 1,
      }

      const events: any[] = []
      
      for await (const event of orchestrator.process(request, jwtPayload)) {
        events.push(event)
      }

      // Should have start, reasoning, token, complete events
      expect(events[0].type).toBe("start")
      expect(events.some(e => e.type === "token")).toBe(true)
      expect(events[events.length - 1].type).toBe("complete")
    })

    it("should handle chat with history", async () => {
      const request: ChatRequest = {
        message: "Tell me more about that",
        chatId: "test-chat-123",
      }

      const jwtPayload = {
        sub: "test@example.com",
        userId: 1,
        workspaceId: 1,
      }

      const events: any[] = []
      
      for await (const event of orchestrator.process(request, jwtPayload)) {
        events.push(event)
      }

      expect(events.length).toBeGreaterThan(0)
    })
  })

  describe("Agentic Chat", () => {
    it("should handle agent with tools", async () => {
      const request: ChatRequest = {
        message: "Search for documents about AI",
        agentId: "search-agent",
      }

      const jwtPayload = {
        sub: "test@example.com",
        userId: 1,
        workspaceId: 1,
      }

      const events: any[] = []
      
      for await (const event of orchestrator.process(request, jwtPayload)) {
        events.push(event)
      }

      // Should have tool call events
      expect(events.some(e => e.type === "tool-call")).toBe(true)
      expect(events.some(e => e.type === "tool-result")).toBe(true)
    })
  })

  describe("Attachment Chat", () => {
    it("should process file attachments", async () => {
      const request: ChatRequest = {
        message: "Summarize this document",
        attachments: [
          { fileId: "file-123", fileName: "document.pdf" },
        ],
      }

      const jwtPayload = {
        sub: "test@example.com",
        userId: 1,
        workspaceId: 1,
      }

      const events: any[] = []
      
      for await (const event of orchestrator.process(request, jwtPayload)) {
        events.push(event)
      }

      // Should have attachment processing events
      expect(events.some(e => 
        e.type === "reasoning" && 
        e.step?.stage?.includes("attachment")
      )).toBe(true)
    })
  })

  describe("Error Handling", () => {
    it("should handle invalid agent ID", async () => {
      const request: ChatRequest = {
        message: "Hello",
        agentId: "non-existent-agent",
      }

      const jwtPayload = {
        sub: "test@example.com",
        userId: 1,
        workspaceId: 1,
      }

      const events: any[] = []
      
      for await (const event of orchestrator.process(request, jwtPayload)) {
        events.push(event)
      }

      expect(events.some(e => e.type === "error")).toBe(true)
    })

    it("should handle cancellation", async () => {
      const request: ChatRequest = {
        message: "Write a very long story",
      }

      const jwtPayload = {
        sub: "test@example.com",
        userId: 1,
        workspaceId: 1,
      }

      // Create abort controller
      const abortController = new AbortController()
      
      // Start processing
      const processPromise = (async () => {
        const events: any[] = []
        for await (const event of orchestrator.process(request, jwtPayload)) {
          events.push(event)
          if (events.length > 5) {
            abortController.abort()
          }
        }
        return events
      })()

      const events = await processPromise

      // Should have stopped early
      expect(events.length).toBeLessThan(20)
    })
  })
})
```

#### 6.2 Test Utilities

**server/api/chat-v2/__tests__/test-utils.ts**

```typescript
/**
 * Test Utilities for Chat V2
 */

import { ToolRegistry } from "../plugins/tools/tool-registry"
import { RetrieverRegistry, UnifiedVespaRetriever } from "../plugins/retrievers"
import { CitationRegistry } from "../plugins/citations/citation-registry"
import type { DependencyContainer } from "../core/orchestrator/dependency-container"

/**
 * Create test dependency container with mocks
 */
export function createTestContainer(
  overrides: Partial<DependencyContainer> = {}
): DependencyContainer {
  return {
    tools: overrides.tools ?? createMockToolRegistry(),
    retrievers: overrides.retrievers ?? createMockRetrieverRegistry(),
    citations: overrides.citations ?? createMockCitationRegistry(),
    memory: overrides.memory ?? createMockMemoryService(),
    persistence: overrides.persistence ?? createMockPersistenceService(),
    promptBuilder: overrides.promptBuilder ?? createMockPromptBuilder(),
    config: overrides.config ?? getTestConfig(),
  }
}

function createMockToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  
  // Register mock tools
  registry.register({
    name: "search",
    description: "Search for documents",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
    async execute(params) {
      return {
        success: true,
        data: { results: [] },
        summary: "Found 3 documents",
      }
    },
  })

  return registry
}

function createMockRetrieverRegistry(): RetrieverRegistry {
  const registry = new RetrieverRegistry()
  
  // Register mock retriever
  registry.register(new MockVespaRetriever())
  
  return registry
}

class MockVespaRetriever extends UnifiedVespaRetriever {
  async *search(query: string, options: any, context: any) {
    yield {
      fragments: [
        {
          id: "mock-1",
          content: "This is a mock search result",
          source: {
            docId: "doc-1",
            title: "Mock Document",
            app: "document" as any,
            entity: "file" as any,
          },
          confidence: 0.9,
        },
      ],
      app: "document" as any,
      confidence: 0.9,
      query,
      metadata: {
        durationMs: 100,
        documentsSearched: 1,
        searchedApps: ["document"],
      },
    }
  }
}

function createMockCitationRegistry(): CitationRegistry {
  return new CitationRegistry()
}

function createMockMemoryService(): any {
  return {
    async getEpisodicMemories() {
      return ""
    },
    async getChatMemories() {
      return ""
    },
    async addEpisodicMemory() {},
    async addChatMemory() {},
  }
}

function createMockPersistenceService(): any {
  return {
    async getOrCreateChat() {
      return {
        id: 1,
        externalId: "test-chat",
        metadata: {},
      }
    },
    async getRecentMessages() {
      return []
    },
    async saveUserMessage() {
      return { id: 1 }
    },
    async saveAssistantMessage() {
      return { id: 2 }
    },
    async getAgentById(agentId: string) {
      if (agentId === "non-existent-agent") {
        return null
      }
      return {
        id: 1,
        externalId: agentId,
        name: "Test Agent",
        prompt: "You are a test agent",
        workspaceId: 1,
      }
    },
    async prepareAttachmentContext() {
      return {
        files: [],
        fragments: [],
        summary: "",
      }
    },
  }
}

function createMockPromptBuilder(): any {
  return {
    buildSystemPrompt() {
      return "You are a helpful assistant"
    },
    buildToolInstructions() {
      return ""
    },
    buildContextSection() {
      return ""
    },
    buildAgentPrompt(agent: any) {
      return agent.prompt
    },
  }
}

function getTestConfig() {
  return {
    defaultModel: "gpt-4o",
    defaultFastModel: "gpt-4o-mini",
    maxTurns: 10,
    maxTokens: 4096,
    reviewFrequency: 5,
    features: {
      reasoning: true,
      webSearch: false,
      deepResearch: false,
      delegation: true,
    },
  }
}
```

---

## Final Integration

### Update Main Index

**server/api/chat-v2/index.ts** (Update from Phase 1)

```typescript
/**
 * Chat V2 - New Architecture
 * 
 * Phase 4: Complete implementation with Orchestrator, Strategies, and API layer
 */

import config from "@/config"

// Feature flag
export const CHAT_V2_ENABLED = config.features?.chatV2 === true

// Core exports
export { ChatOrchestrator } from "./core/orchestrator/chat-orchestrator"
export { createOrchestrator, getGlobalOrchestrator } from "./core/orchestrator/orchestrator-factory"
export { RequestContext } from "./core/orchestrator/request-context"

// Strategy exports
export { ChatMode, ChatModeStrategy, ChatModeStrategyRegistry } from "./core/strategies/chat-mode-strategy"
export { NormalChatStrategy } from "./core/strategies/normal-chat.strategy"
export { AgenticChatStrategy } from "./core/strategies/agentic-chat.strategy"
export { AttachmentChatStrategy } from "./core/strategies/attachment-chat.strategy"
export { KnowledgeBaseChatStrategy } from "./core/strategies/kb-chat.strategy"

// API exports
export { default as chatV2Routes } from "./api/routes"
export { chatHandler } from "./api/handlers/chat.handler"

// Legacy bridge
export { executeLegacy } from "./legacy/bridge"

// Type exports
export type { ChatRequest, ChatEvent } from "./models"
```

### Server Integration

**server/index.ts** (or main server file)

```typescript
import { Hono } from "hono"
import { chatV2Routes, CHAT_V2_ENABLED } from "./api/chat-v2"
import { legacyChatRoutes } from "./api/chat/message-agents"

const app = new Hono()

// Mount legacy routes (always available for fallback)
app.route("/api/chat", legacyChatRoutes)

// Mount V2 routes if enabled
if (CHAT_V2_ENABLED) {
  app.route("/api/chat-v2", chatV2Routes)
  console.log("✅ Chat V2 routes enabled")
}

export default app
```

---

## Summary

Phase 4 completes the architectural migration by:

1. **ChatOrchestrator** - Central coordination with strategy selection
2. **Four Strategy Implementations** - Normal, Agentic, Attachment, KnowledgeBase
3. **Runtime Adapters** - Bridge to pi-mono and JAF
4. **API Layer** - Hono routes with SSE streaming
5. **Feature Flags** - Gradual rollout capability
6. **Legacy Bridge** - Fallback to old implementation
7. **Integration Tests** - End-to-end test coverage
8. **Migration Runbook** - Step-by-step cutover guide

### Key Files Added in Phase 4

```
server/api/chat-v2/
├── core/
│   ├── orchestrator/
│   │   ├── chat-orchestrator.ts          # Main orchestrator
│   │   └── orchestrator-factory.ts       # Factory & singleton
│   ├── strategies/
│   │   ├── normal-chat.strategy.ts       # Normal chat implementation
│   │   ├── agentic-chat.strategy.ts      # Agentic chat with tools
│   │   ├── attachment-chat.strategy.ts   # File attachment handling
│   │   └── kb-chat.strategy.ts           # Knowledge base scoped chat
│   └── runtime/
│       ├── runtime.interface.ts          # Runtime abstraction
│       └── pi-mono-runtime.ts            # pi-mono adapter
├── api/
│   ├── routes.ts                         # Hono routes
│   ├── handlers/
│   │   ├── chat.handler.ts               # Main chat endpoint
│   │   └── streaming.handler.ts          # SSE utilities
│   └── middleware/
│       ├── auth.ts                       # JWT validation
│       ├── validation.ts                 # Request validation
│       └── feature-flag.ts               # Rollout controls
├── legacy/
│   └── bridge.ts                         # Legacy fallback
├── __tests__/
│   ├── integration/
│   │   └── chat-flow.test.ts             # E2E tests
│   └── test-utils.ts                     # Test helpers
└── MIGRATION_RUNBOOK.md                  # Cutover guide
```

### Production Readiness Checklist

- [ ] All strategies implemented and tested
- [ ] Feature flags configured
- [ ] Monitoring and alerting in place
- [ ] Rollback procedure tested
- [ ] Load testing passed
- [ ] Documentation updated
- [ ] Team trained on new architecture

The system is now ready for **gradual rollout** following the migration runbook.
