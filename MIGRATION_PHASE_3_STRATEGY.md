# Phase 3: Strategy Implementation - Detailed Migration Guide

## Overview

**Duration**: 2 weeks  
**Goal**: Implement Chat Mode Strategies - NormalChatStrategy, AgenticChatStrategy, AttachmentChatStrategy, and KnowledgeBaseChatStrategy  
**Risk Level**: Medium (new implementations, isolated behind feature flags)  
**Rollback Strategy**: Feature flag disables new strategy code, falls back to legacy implementation  

---

## Phase 3 Objectives

1. **Implement ChatModeStrategy Interface** - Define the contract for all chat modes
2. **Implement NormalChatStrategy** - Simple chat without agentic loop, direct generation
3. **Implement AgenticChatStrategy** - Full agentic loop with tools using pi-mono runtime
4. **Implement AttachmentChatStrategy** - Pre-loads attachment context, delegates to AgenticChatStrategy
5. **Implement KnowledgeBaseChatStrategy** - KB-specific retrieval with collection/folder scoping
6. **Create Strategy Registry** - Dynamic strategy discovery and selection
7. **Build Strategy Tests** - Comprehensive test coverage for each strategy
8. **Implement Strategy Selection Logic** - Determine which strategy handles each request

---

## Key Architectural Insight: Strategy Pattern for Chat Modes

The Strategy Pattern allows different chat modes to share common concerns (auth, persistence, streaming) while differing in:

- **Context assembly** (what context to load)
- **Tool availability** (which tools are available)
- **Retrieval approach** (how to retrieve relevant documents)
- **Generation strategy** (how to generate responses)

```typescript
// Each strategy implements the same interface
NormalChatStrategy      → Direct LLM generation, no tools
AgenticChatStrategy     → Full agent loop with pi-mono, all tools
AttachmentChatStrategy  → Pre-load attachments, then delegate
KnowledgeBaseChatStrategy → KB-scoped retrieval, synthesize from KB
```

**Benefits:**
- Adding new modes doesn't touch existing code
- Clear separation of concerns per mode
- Composable behaviors (Attachment + Agentic)
- Easy to test in isolation

---

## Week 1: Strategy Interface & Normal/Agentic Strategies

### Day 1-2: Chat Mode Strategy Interface

#### 1.1 Create Strategy Interface

**server/api/chat-v2/core/strategies/chat-mode-strategy.interface.ts**

```typescript
/**
 * Chat Mode Strategy Interface
 * 
 * REPLACES: Mode-specific conditional logic in message-agents.ts (lines 200-500)
 * BENEFITS:
 *   - Clear contract for all chat modes
 *   - Easy to add new modes without touching existing code
 *   - Testable in isolation
 *   - Composable behaviors
 */

import type { AssembledChatContext, ChatEvent, ChatRequest } from "../../models"
import type { RequestContext } from "../orchestrator/request-context"

/**
 * Chat modes supported by the system
 */
export enum ChatMode {
  /** Simple chat without agentic loop */
  Normal = "normal",
  /** Full agentic chat with tools */
  Agentic = "agentic",
  /** Chat with file attachments */
  Attachment = "attachment",
  /** Knowledge Base scoped chat */
  KnowledgeBase = "knowledge-base",
  /** Multi-agent delegation */
  MultiAgent = "multi-agent",
}

/**
 * Strategy for handling a specific chat mode
 */
export interface ChatModeStrategy {
  /** Unique mode identifier */
  readonly mode: ChatMode

  /**
   * Determine if this strategy can handle the request
   * @param request - Incoming chat request
   * @returns true if this strategy should handle the request
   */
  canHandle(request: ChatRequest): boolean

  /**
   * Execute the chat flow
   * @param request - Chat request
   * @param context - Request-scoped context with dependencies
   * @yields Chat events (tokens, citations, tool calls, etc.)
   */
  execute(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent>

  /**
   * Get the context assembler for this strategy
   * @returns Context assembler instance
   */
  getContextAssembler(): import("../pipeline/context-assembly").ContextAssembler

  /**
   * Get supported capabilities for this mode
   * @returns List of capabilities
   */
  getCapabilities(): StrategyCapability[]
}

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
 * Base class for chat mode strategies with common functionality
 */
export abstract class BaseChatModeStrategy implements ChatModeStrategy {
  abstract readonly mode: ChatMode

  abstract canHandle(request: ChatRequest): boolean

  abstract execute(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent>

  abstract getContextAssembler(): import("../pipeline/context-assembly").ContextAssembler

  getCapabilities(): StrategyCapability[] {
    return ["streaming", "citations"]
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
}

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
```

#### 1.2 Create Strategy Registry

**server/api/chat-v2/core/strategies/strategy-registry.ts**

```typescript
/**
 * Strategy Registry
 * 
 * Manages all chat mode strategies and handles strategy selection
 */

import type { ChatModeStrategy } from "./chat-mode-strategy.interface"
import { ChatMode } from "./chat-mode-strategy.interface"
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
    // Priority order for strategy selection
    const priorityOrder: ChatMode[] = [
      ChatMode.MultiAgent,
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

export const strategyRegistry = new StrategyRegistry()
```

**server/api/chat-v2/core/strategies/index.ts**

```typescript
export * from "./chat-mode-strategy.interface"
export * from "./strategy-registry"
```

### Day 3-4: Normal Chat Strategy

#### 2.1 Implement Normal Chat Strategy

**server/api/chat-v2/core/strategies/normal-chat.strategy.ts**

```typescript
/**
 * Normal Chat Strategy
 * 
 * Simple chat without agentic loop
 * - Direct LLM generation
 * - No tool calling
 * - Basic context assembly (history, memories)
 * - Streaming response
 * 
 * REPLACES: Direct generation logic in chat.ts (lines 1000-1200)
 */

import { BaseChatModeStrategy, ChatMode, type StrategyCapability } from "./chat-mode-strategy.interface"
import type { ChatRequest, ChatEvent, AssembledChatContext, Fragment } from "../../models"
import type { RequestContext } from "../orchestrator/request-context"
import { NormalContextAssembler } from "../pipeline/context-assembly"
import type { ContextAssembler } from "../pipeline/context-assembly"
import type { GenerationEvent } from "../pipeline/generation/generation-pipeline.interface"

export interface NormalChatStrategyOptions {
  /** Max tokens for response */
  maxTokens?: number
  /** Temperature for generation */
  temperature?: number
  /** Include memories in context */
  includeMemories?: boolean
  /** Include conversation history */
  includeHistory?: boolean
}

export class NormalChatStrategy extends BaseChatModeStrategy {
  readonly mode = ChatMode.Normal

  private options: NormalChatStrategyOptions

  constructor(options: NormalChatStrategyOptions = {}) {
    super()
    this.options = {
      maxTokens: 4096,
      temperature: 0.7,
      includeMemories: true,
      includeHistory: true,
      ...options,
    }
  }

  /**
   * Normal strategy handles requests without:
   * - agentId (no agentic mode)
   * - attachments (use Attachment strategy)
   * - knowledge base collections (use KB strategy)
   */
  canHandle(request: ChatRequest): boolean {
    // Lowest priority - only handles basic requests
    // Other strategies should handle specialized cases first
    const hasAgent = !!request.agentId
    const hasAttachments = !!request.attachments && request.attachments.length > 0
    const hasKBCollections = this.hasKBCollections(request)

    return !hasAgent && !hasAttachments && !hasKBCollections
  }

  getCapabilities(): StrategyCapability[] {
    return [
      "streaming",
      "citations",
      "multi-turn",
      "reasoning",
    ]
  }

  getContextAssembler(): ContextAssembler {
    return new NormalContextAssembler({
      includeHistory: this.options.includeHistory,
      includeEpisodicMemory: this.options.includeMemories,
      includeChatMemory: this.options.includeMemories,
    })
  }

  async *execute(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent> {
    const startTime = Date.now()

    try {
      // 1. Assemble context
      const assembler = this.getContextAssembler()
      await assembler.validate(context)
      const chatContext = await assembler.assemble(context)

      yield {
        type: "start",
        timestamp: new Date().toISOString(),
      }

      // 2. Optional: Retrieve relevant documents for RAG
      const fragments = yield* this.retrieveDocuments(chatContext, context)

      // 3. Generate response
      yield* this.generateResponse(chatContext, fragments, context)

      yield {
        type: "complete",
        timestamp: new Date().toISOString(),
        metadata: {
          durationMs: Date.now() - startTime,
          mode: this.mode,
        },
      }
    } catch (error) {
      yield {
        type: "error",
        error: {
          code: "STRATEGY_ERROR",
          message: error instanceof Error ? error.message : "Unknown error",
          recoverable: false,
        },
      }
    }
  }

  /**
   * Retrieve relevant documents (optional RAG)
   */
  private async *retrieveDocuments(
    chatContext: AssembledChatContext,
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    const retriever = requestContext.retrievers.get()

    const results = []
    for await (const result of retriever.search(
      chatContext.normalizedUserMessage,
      {
        limit: 10,
        minConfidence: 0.5,
      },
      requestContext
    )) {
      results.push(result)
    }

    // Flatten fragments from all results
    const allFragments: Fragment[] = results.flatMap((r) => r.fragments)

    // Yield context assembled event with fragments
    yield {
      type: "metadata",
      data: {
        retrievalResults: results.length,
        totalFragments: allFragments.length,
      },
    }

    return allFragments
  }

  /**
   * Generate streaming response
   */
  private async *generateResponse(
    chatContext: AssembledChatContext,
    fragments: Fragment[],
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    const promptBuilder = requestContext.promptBuilder

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(chatContext, fragments, promptBuilder)

    // Build messages
    const messages = this.buildMessages(chatContext, systemPrompt)

    // Get LLM provider
    const llmProvider = requestContext.getLLMProvider()

    // Stream completion
    const stream = llmProvider.streamCompletion({
      messages,
      model: requestContext.config.defaultModel,
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
    })

    // Track citations
    const citationHandler = requestContext.citations.getHandler("standard")
    let accumulatedText = ""

    for await (const event of stream) {
      switch (event.type) {
        case "token":
          accumulatedText += event.content

          // Extract and yield citations
          if (citationHandler) {
            yield* this.extractCitations(
              accumulatedText,
              fragments,
              citationHandler,
              requestContext
            )
          }

          yield {
            type: "token",
            content: event.content,
          }
          break

        case "error":
          yield {
            type: "error",
            error: {
              code: "GENERATION_ERROR",
              message: event.error.message,
              recoverable: false,
            },
          }
          break

        case "complete":
          yield {
            type: "complete",
            finishReason: event.finishReason as any,
            usage: event.usage,
          }
          break
      }
    }
  }

  /**
   * Build system prompt
   */
  private buildSystemPrompt(
    chatContext: AssembledChatContext,
    fragments: Fragment[],
    promptBuilder: import("../../services").PromptBuilderService
  ): string {
    const sections: string[] = []

    // Identity
    sections.push("You are a helpful AI assistant.")

    // Context from fragments
    if (fragments.length > 0) {
      sections.push(promptBuilder.buildContextSection(fragments))
    }

    // Citation format
    sections.push("Cite sources using [1], [2], etc. format when referencing information.")

    return sections.join("\n\n")
  }

  /**
   * Build message array for LLM
   */
  private buildMessages(
    chatContext: AssembledChatContext,
    systemPrompt: string
  ): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = []

    // System prompt
    messages.push({
      role: "system",
      content: systemPrompt,
    })

    // Conversation history
    for (const msg of chatContext.conversationHistory.slice(-10)) {
      messages.push({
        role: msg.role,
        content: msg.content,
      })
    }

    // Current user message
    messages.push({
      role: "user",
      content: chatContext.userMessage,
    })

    return messages
  }

  /**
   * Extract citations from generated text
   */
  private async *extractCitations(
    text: string,
    fragments: Fragment[],
    citationHandler: import("../../plugins/citations/citation-handler.interface").CitationHandler,
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    for await (const event of citationHandler.extractCitations(
      text,
      fragments,
      requestContext
    )) {
      if (event.citation) {
        yield {
          type: "citation",
          citation: {
            index: event.citation.index,
            docId: event.citation.item.docId,
            title: event.citation.item.title || "Untitled",
            url: event.citation.item.url,
          },
        }
      }
    }
  }

  /**
   * Check if request has KB collections
   */
  private hasKBCollections(request: ChatRequest): boolean {
    // Check for KB-specific parameters
    const modelConfig = request.modelConfig
    if (!modelConfig) return false

    // Check for KB-specific flags
    return false // Override in KB strategy
  }
}
```

### Day 5-7: Agentic Chat Strategy

#### 3.1 Implement Agentic Chat Strategy

**server/api/chat-v2/core/strategies/agentic-chat.strategy.ts**

```typescript
/**
 * Agentic Chat Strategy
 * 
 * Full agentic loop with tools using pi-mono runtime
 * - Tool calling and execution
 * - Multi-turn conversation with agent
 * - Fragment collection and ranking
 * - Final synthesis with citations
 * 
 * REPLACES: MessageAgentsPiMono in pi-mono/message-agents.ts (lines 100-900)
 */

import { BaseChatModeStrategy, ChatMode, type StrategyCapability } from "./chat-mode-strategy.interface"
import type {
  ChatRequest,
  ChatEvent,
  AssembledChatContext,
  Fragment,
  Tool,
  AgentConfig,
} from "../../models"
import type { RequestContext } from "../orchestrator/request-context"
import { AgentContextAssembler } from "../pipeline/context-assembly"
import type { ContextAssembler } from "../pipeline/context-assembly"
import { ReasoningSteps } from "../../../chat/reasoning-steps"

export interface AgenticChatStrategyOptions {
  /** Maximum turns before forcing synthesis */
  maxTurns?: number
  /** Temperature for generation */
  temperature?: number
  /** Enable reasoning steps */
  enableReasoning?: boolean
  /** Enable automatic review */
  enableReview?: boolean
  /** Review frequency (every N turns) */
  reviewFrequency?: number
}

/**
 * Agent state tracked during execution
 */
interface AgentExecutionState {
  turnCount: number
  fragments: Fragment[]
  images: Array<{
    fileName: string
    sourceFragmentId: string
    sourceToolName: string
  }>
  toolHistory: Array<{
    tool: string
    toolCallId: string
    arguments: Record<string, unknown>
    result?: unknown
    error?: string
  }>
  plan?: string
  clarifications: Array<{
    id: string
    question: string
    answer?: string
  }>
}

export class AgenticChatStrategy extends BaseChatModeStrategy {
  readonly mode = ChatMode.Agentic

  private options: AgenticChatStrategyOptions

  constructor(options: AgenticChatStrategyOptions = {}) {
    super()
    this.options = {
      maxTurns: 10,
      temperature: 0.7,
      enableReasoning: true,
      enableReview: true,
      reviewFrequency: 5,
      ...options,
    }
  }

  /**
   * Agentic strategy handles requests with:
   * - agentId specified
   * - Or requests that require tool usage
   */
  canHandle(request: ChatRequest): boolean {
    return !!request.agentId
  }

  getCapabilities(): StrategyCapability[] {
    return [
      "streaming",
      "tool-calling",
      "citations",
      "attachments",
      "knowledge-base",
      "agent-delegation",
      "multi-turn",
      "reasoning",
    ]
  }

  getContextAssembler(): ContextAssembler {
    // Agent context assembler will be instantiated with agentId at runtime
    return new AgentContextAssembler(
      {
        includeHistory: true,
        includeEpisodicMemory: true,
        includeChatMemory: true,
        includeAttachments: true,
        includeAgentConfig: true,
      },
      { agentId: "" } // Will be set at runtime
    )
  }

  async *execute(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent> {
    const startTime = Date.now()

    try {
      yield {
        type: "start",
        timestamp: new Date().toISOString(),
      }

      // 1. Assemble context with agent configuration
      const assembler = this.getContextAssembler() as AgentContextAssembler
      // Set agent ID from request
      const agentId = request.agentId!
      const agentAssembler = new AgentContextAssembler(
        {
          includeHistory: true,
          includeEpisodicMemory: true,
          includeChatMemory: true,
          includeAttachments: true,
          includeAgentConfig: true,
        },
        { agentId }
      )

      await agentAssembler.validate(context)
      const chatContext = await agentAssembler.assemble(context)

      if (!chatContext.agentConfig) {
        throw new Error("Agent configuration required for agentic mode")
      }

      // 2. Yield metadata
      yield {
        type: "metadata",
        data: {
          mode: this.mode,
          agentId: chatContext.agentConfig.id,
          agentName: chatContext.agentConfig.name,
        },
      }

      // 3. Build tools list
      const tools = this.buildTools(chatContext.agentConfig, context)

      // 4. Execute agent loop
      const state: AgentExecutionState = {
        turnCount: 0,
        fragments: [],
        images: [],
        toolHistory: [],
        clarifications: [],
      }

      yield* this.executeAgentLoop(
        chatContext,
        tools,
        state,
        context
      )

      yield {
        type: "complete",
        timestamp: new Date().toISOString(),
        metadata: {
          durationMs: Date.now() - startTime,
          mode: this.mode,
          turns: state.turnCount,
          toolCalls: state.toolHistory.length,
        },
      }
    } catch (error) {
      yield {
        type: "error",
        error: {
          code: "AGENTIC_ERROR",
          message: error instanceof Error ? error.message : "Unknown error",
          recoverable: false,
        },
      }
    }
  }

  /**
   * Execute the main agent loop
   */
  private async *executeAgentLoop(
    chatContext: AssembledChatContext,
    tools: Tool[],
    state: AgentExecutionState,
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    const maxTurns = this.options.maxTurns!

    while (state.turnCount < maxTurns) {
      state.turnCount++

      // Yield reasoning step
      if (this.options.enableReasoning) {
        yield {
          type: "reasoning",
          step: `Turn ${state.turnCount}`,
          details: {
            fragments: state.fragments.length,
            toolsUsed: state.toolHistory.length,
          },
        }
      }

      // Create pi-mono session
      const session = yield* this.createSession(
        chatContext,
        tools,
        state,
        requestContext
      )

      // Run one turn
      const turnResult = yield* this.runTurn(
        session,
        chatContext,
        state,
        requestContext
      )

      // Check if we should synthesize
      if (turnResult.shouldSynthesize) {
        yield* this.synthesizeFinalAnswer(
          chatContext,
          state,
          requestContext
        )
        break
      }

      // Check for max turns
      if (state.turnCount >= maxTurns) {
        yield {
          type: "reasoning",
          step: "Max turns reached",
          details: { maxTurns },
        }
        yield* this.synthesizeFinalAnswer(chatContext, state, requestContext)
        break
      }

      // Run review if enabled and at review frequency
      if (
        this.options.enableReview &&
        state.turnCount % this.options.reviewFrequency! === 0
      ) {
        const reviewResult = yield* this.runReview(state, requestContext)
        if (reviewResult.planChangeNeeded) {
          yield {
            type: "reasoning",
            step: "Plan change needed",
            details: { reason: reviewResult.planChangeReason },
          }
        }
      }
    }
  }

  /**
   * Create pi-mono agent session
   */
  private async *createSession(
    chatContext: AssembledChatContext,
    tools: Tool[],
    state: AgentExecutionState,
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    const promptBuilder = requestContext.promptBuilder
    const agentConfig = chatContext.agentConfig!

    // Build system prompt
    const systemPrompt = this.buildAgentSystemPrompt(
      chatContext,
      tools,
      promptBuilder
    )

    // Create session via pi-mono runtime
    const runtime = requestContext.getAgentRuntime()
    const session = await runtime.createSession({
      model: agentConfig.model || requestContext.config.defaultModel,
      systemPrompt,
      tools,
      temperature: this.options.temperature,
    })

    yield {
      type: "metadata",
      data: {
        sessionId: session.id,
        toolCount: tools.length,
      },
    }

    return session
  }

  /**
   * Run a single turn
   */
  private async *runTurn(
    session: any,
    chatContext: AssembledChatContext,
    state: AgentExecutionState,
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    let shouldSynthesize = false

    // Subscribe to events
    const unsubscribe = session.subscribe(async (event: any) => {
      switch (event.type) {
        case "token":
          yield {
            type: "token",
            content: event.content,
          }
          break

        case "tool-call":
          yield {
            type: "tool-call",
            tool: event.tool,
            toolCallId: event.toolCallId,
            arguments: event.arguments,
          }

          // Execute tool
          const toolResult = await this.executeTool(
            event.tool,
            event.arguments,
            requestContext
          )

          yield {
            type: "tool-result",
            tool: event.tool,
            toolCallId: event.toolCallId,
            result: toolResult.result,
            success: toolResult.success,
          }

          // Update state
          state.toolHistory.push({
            tool: event.tool,
            toolCallId: event.toolCallId,
            arguments: event.arguments,
            result: toolResult.result,
            error: toolResult.error,
          })

          if (toolResult.fragments) {
            state.fragments.push(...toolResult.fragments)
          }

          // Check for synthesize tool
          if (event.tool === "synthesizeFinalAnswer") {
            shouldSynthesize = true
          }
          break

        case "complete":
          shouldSynthesize = true
          break
      }
    })

    // Send user message
    await session.sendMessage(chatContext.userMessage)

    // Wait for completion
    await session.waitForComplete()

    unsubscribe()

    return { shouldSynthesize }
  }

  /**
   * Synthesize final answer
   */
  private async *synthesizeFinalAnswer(
    chatContext: AssembledChatContext,
    state: AgentExecutionState,
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    // Use streaming generator with all collected fragments
    const generator = requestContext.generation.getGenerator("streaming")

    yield {
      type: "reasoning",
      step: "Synthesizing final answer",
      details: {
        fragmentCount: state.fragments.length,
      },
    }

    for await (const event of generator.generate(
      chatContext,
      state.fragments,
      requestContext
    )) {
      yield event
    }
  }

  /**
   * Build tools list for agent
   */
  private buildTools(agentConfig: AgentConfig, requestContext: RequestContext): Tool[] {
    const toolRegistry = requestContext.tools

    if (agentConfig.tools && agentConfig.tools.length > 0) {
      // Use agent-specific tools
      return agentConfig.tools
        .map((name) => toolRegistry.get(name))
        .filter((t): t is Tool => !!t)
    }

    // Default: get all tools for agentic mode
    return toolRegistry.getForMode(ChatMode.Agentic)
  }

  /**
   * Execute a tool
   */
  private async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    requestContext: RequestContext
  ): Promise<{
    success: boolean
    result?: unknown
    error?: string
    fragments?: Fragment[]
  }> {
    const tool = requestContext.tools.get(toolName)
    if (!tool) {
      return {
        success: false,
        error: `Tool not found: ${toolName}`,
      }
    }

    try {
      const result = await tool.execute(args, {
        requestContext,
        toolCallId: `call_${Date.now()}`,
        signal: new AbortController().signal,
      })

      return {
        success: result.success,
        result: result.data,
        error: result.error?.message,
        fragments: result.fragments,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Tool execution failed",
      }
    }
  }

  /**
   * Run automatic review
   */
  private async *runReview(
    state: AgentExecutionState,
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    // Review logic here
    yield {
      type: "reasoning",
      step: "Running automatic review",
    }

    return {
      planChangeNeeded: false,
      planChangeReason: undefined,
    }
  }

  /**
   * Build agent system prompt
   */
  private buildAgentSystemPrompt(
    chatContext: AssembledChatContext,
    tools: Tool[],
    promptBuilder: import("../../services").PromptBuilderService
  ): string {
    const sections: string[] = []

    // Identity and base instructions
    sections.push("You are an AI agent that helps users by using available tools.")

    // Agent-specific prompt
    if (chatContext.agentConfig?.systemPrompt) {
      sections.push(chatContext.agentConfig.systemPrompt)
    }

    if (chatContext.agentConfig?.prompt) {
      sections.push(chatContext.agentConfig.prompt)
    }

    // Tool instructions
    sections.push(promptBuilder.buildToolInstructions(tools.map((t) => t.name)))

    // Citation format
    sections.push("Always cite sources using [1], [2], etc. format.")

    return sections.join("\n\n")
  }
}
```

---

## Week 2: Attachment & Knowledge Base Strategies

### Day 8-9: Attachment Chat Strategy

#### 4.1 Implement Attachment Chat Strategy

**server/api/chat-v2/core/strategies/attachment-chat.strategy.ts**

```typescript
/**
 * Attachment Chat Strategy
 * 
 * Handles chats with file attachments
 * - Pre-loads attachment context
 * - Processes file fragments
 * - Delegates to AgenticChatStrategy after attachment processing
 * 
 * REPLACES: Attachment processing logic in pi-mono/message-agents.ts (lines 270-310, 500-565)
 */

import { BaseChatModeStrategy, ChatMode, type StrategyCapability } from "./chat-mode-strategy.interface"
import type {
  ChatRequest,
  ChatEvent,
  AssembledChatContext,
  Fragment,
  AttachmentContext,
} from "../../models"
import type { RequestContext } from "../orchestrator/request-context"
import { AgentContextAssembler, NormalContextAssembler } from "../pipeline/context-assembly"
import type { ContextAssembler } from "../pipeline/context-assembly"
import { AgenticChatStrategy } from "./agentic-chat.strategy"
import { NormalChatStrategy } from "./normal-chat.strategy"
import { Apps } from "@xyne/vespa-ts/types"

export interface AttachmentChatStrategyOptions {
  /** Strategy to use after attachment processing */
  delegateTo?: "agentic" | "normal"
  /** Process images separately */
  processImages?: boolean
  /** Max file size to process */
  maxFileSize?: number
}

/**
 * Attachment fragment with metadata
 */
interface AttachmentFragment extends Fragment {
  isImage: boolean
  fileId: string
  fileName?: string
  mimeType?: string
}

export class AttachmentChatStrategy extends BaseChatModeStrategy {
  readonly mode = ChatMode.Attachment

  private options: AttachmentChatStrategyOptions
  private delegateStrategy: AgenticChatStrategy | NormalChatStrategy

  constructor(options: AttachmentChatStrategyOptions = {}) {
    super()
    this.options = {
      delegateTo: "agentic",
      processImages: true,
      maxFileSize: 50 * 1024 * 1024, // 50MB
      ...options,
    }

    // Create delegate strategy
    this.delegateStrategy =
      this.options.delegateTo === "agentic"
        ? new AgenticChatStrategy()
        : new NormalChatStrategy()
  }

  /**
   * Attachment strategy handles requests with:
   * - attachments array with items
   */
  canHandle(request: ChatRequest): boolean {
    return !!request.attachments && request.attachments.length > 0
  }

  getCapabilities(): StrategyCapability[] {
    return [
      "streaming",
      "tool-calling",
      "citations",
      "attachments",
      "multi-turn",
      "reasoning",
    ]
  }

  getContextAssembler(): ContextAssembler {
    // Use agentic assembler if delegating to agentic, otherwise normal
    if (this.options.delegateTo === "agentic") {
      return new AgentContextAssembler(
        {
          includeHistory: true,
          includeEpisodicMemory: true,
          includeChatMemory: true,
          includeAttachments: true,
        },
        { agentId: "" }
      )
    }

    return new NormalContextAssembler({
      includeHistory: true,
      includeAttachments: true,
    })
  }

  async *execute(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent> {
    const startTime = Date.now()

    try {
      yield {
        type: "start",
        timestamp: new Date().toISOString(),
      }

      yield {
        type: "reasoning",
        step: "Processing attachments",
        details: {
          attachmentCount: request.attachments?.length,
        },
      }

      // 1. Process attachments
      const attachmentContext = yield* this.processAttachments(request, context)

      // 2. Convert attachments to fragments
      const attachmentFragments = this.convertAttachmentsToFragments(
        attachmentContext,
        request
      )

      yield {
        type: "metadata",
        data: {
          attachmentCount: attachmentFragments.length,
          imageCount: attachmentFragments.filter((f) => f.isImage).length,
        },
      }

      // 3. Assemble base context
      const assembler = this.getContextAssembler()
      await assembler.validate(context)
      const chatContext = await assembler.assemble(context)

      // 4. Merge attachment fragments into context
      const enrichedContext: AssembledChatContext = {
        ...chatContext,
        attachments: {
          files: attachmentContext.files.map((f) => ({
            fileId: f.fileId,
            fileName: f.fileName,
            mimeType: f.mimeType,
            isImage: f.isImage,
          })),
          fragments: attachmentFragments,
          summary: attachmentContext.summary,
        },
      }

      yield {
        type: "reasoning",
        step: "Attachment processing complete",
        details: {
          fragmentsExtracted: attachmentFragments.length,
        },
      }

      // 5. Delegate to appropriate strategy
      if (this.options.delegateTo === "agentic") {
        yield* this.executeAgentic(enrichedContext, attachmentFragments, context)
      } else {
        yield* this.executeNormal(enrichedContext, attachmentFragments, context)
      }

      yield {
        type: "complete",
        timestamp: new Date().toISOString(),
        metadata: {
          durationMs: Date.now() - startTime,
          mode: this.mode,
        },
      }
    } catch (error) {
      yield {
        type: "error",
        error: {
          code: "ATTACHMENT_ERROR",
          message: error instanceof Error ? error.message : "Unknown error",
          recoverable: false,
        },
      }
    }
  }

  /**
   * Process file attachments
   */
  private async *processAttachments(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent> {
    const persistence = context.persistence

    if (!request.attachments || request.attachments.length === 0) {
      throw new Error("No attachments provided")
    }

    // Process attachments through persistence service
    const attachmentContext = await persistence.prepareAttachmentContext(
      request.attachments
    )

    yield {
      type: "metadata",
      data: {
        filesProcessed: attachmentContext.files.length,
        summary: attachmentContext.summary,
      },
    }

    return attachmentContext
  }

  /**
   * Convert attachments to fragments
   */
  private convertAttachmentsToFragments(
    attachmentContext: AttachmentContext,
    request: ChatRequest
  ): AttachmentFragment[] {
    const fragments: AttachmentFragment[] = []

    // Convert file fragments
    for (let i = 0; i < attachmentContext.fragments.length; i++) {
      const frag = attachmentContext.fragments[i]
      const file = attachmentContext.files[i]

      fragments.push({
        id: `attachment_${file.fileId}_${i}`,
        content: frag.content,
        source: {
          docId: file.fileId,
          title: file.fileName || `Attachment ${i + 1}`,
          url: "",
          app: Apps.Attachment,
          entity: file.isImage ? "Image" : "File",
        },
        confidence: 1.0, // User-provided = high confidence
        isImage: file.isImage,
        fileId: file.fileId,
        fileName: file.fileName,
        mimeType: file.mimeType,
      })
    }

    return fragments
  }

  /**
   * Execute agentic mode with attachments
   */
  private async *executeAgentic(
    chatContext: AssembledChatContext,
    attachmentFragments: AttachmentFragment[],
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    // Create agentic strategy
    const agenticStrategy = new AgenticChatStrategy()

    // Pre-populate state with attachment fragments
    // This would require modifying the agentic strategy to accept initial state
    // For now, we pass attachments through context

    yield* agenticStrategy.execute(
      { message: chatContext.userMessage, agentId: chatContext.agentConfig?.id },
      requestContext
    )
  }

  /**
   * Execute normal mode with attachments
   */
  private async *executeNormal(
    chatContext: AssembledChatContext,
    attachmentFragments: AttachmentFragment[],
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    // Include attachment fragments in generation context
    const generator = requestContext.generation.getGenerator("streaming")

    for await (const event of generator.generate(
      chatContext,
      attachmentFragments,
      requestContext
    )) {
      yield event
    }
  }
}
```

### Day 10-11: Knowledge Base Chat Strategy

#### 5.1 Implement Knowledge Base Chat Strategy

**server/api/chat-v2/core/strategies/knowledge-base-chat.strategy.ts**

```typescript
/**
 * Knowledge Base Chat Strategy
 * 
 * Handles chats scoped to Knowledge Base collections/folders
 * - KB-specific retrieval pipeline
 * - Collection/folder/file scoping
 * - Scoped synthesis
 * 
 * REPLACES: KB-specific logic in search-knowledge-base-tool.ts and knowledgeBaseSelections.ts
 */

import { BaseChatModeStrategy, ChatMode, type StrategyCapability } from "./chat-mode-strategy.interface"
import type {
  ChatRequest,
  ChatEvent,
  AssembledChatContext,
  Fragment,
} from "../../models"
import type { RequestContext } from "../orchestrator/request-context"
import { AgentContextAssembler } from "../pipeline/context-assembly"
import type { ContextAssembler } from "../pipeline/context-assembly"
import { Apps } from "@xyne/vespa-ts/types"
import type { KnowledgeBaseSearchOptions } from "../../plugins/retrievers/vespa-retriever.interface"

export interface KnowledgeBaseChatStrategyOptions {
  /** Default result limit */
  defaultLimit?: number
  /** Enable automatic collection detection */
  autoDetectCollections?: boolean
  /** Min confidence threshold for KB results */
  minConfidence?: number
}

/**
 * Knowledge Base scope configuration
 */
export interface KBScopeConfig {
  collectionIds?: string[]
  folderIds?: string[]
  fileIds?: string[]
  structuredSelections?: Array<{
    collectionIds?: string[]
    collectionFolderIds?: string[]
    collectionFileIds?: string[]
  }>
}

export class KnowledgeBaseChatStrategy extends BaseChatModeStrategy {
  readonly mode = ChatMode.KnowledgeBase

  private options: KnowledgeBaseChatStrategyOptions

  constructor(options: KnowledgeBaseChatStrategyOptions = {}) {
    super()
    this.options = {
      defaultLimit: 15,
      autoDetectCollections: true,
      minConfidence: 0.5,
      ...options,
    }
  }

  /**
   * KB strategy handles requests with:
   * - Explicit KB collections in modelConfig
   * - Or agent with KB app integration
   * - Or KB-specific query patterns
   */
  canHandle(request: ChatRequest): boolean {
    const hasKBCollections = this.extractKBScope(request).collectionIds !== undefined
    const hasAgentKB = request.agentId && this.agentHasKBAccess(request)
    const isKBQuery = this.isKBQueryPattern(request.message)

    return hasKBCollections || hasAgentKB || isKBQuery
  }

  getCapabilities(): StrategyCapability[] {
    return [
      "streaming",
      "tool-calling",
      "citations",
      "knowledge-base",
      "multi-turn",
      "reasoning",
    ]
  }

  getContextAssembler(): ContextAssembler {
    return new AgentContextAssembler(
      {
        includeHistory: true,
        includeEpisodicMemory: false, // KB queries typically don't need personal memories
        includeChatMemory: true,
        includeAttachments: false,
        includeAgentConfig: true,
      },
      { agentId: "" }
    )
  }

  async *execute(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent> {
    const startTime = Date.now()

    try {
      yield {
        type: "start",
        timestamp: new Date().toISOString(),
      }

      // 1. Extract KB scope from request
      const kbScope = this.extractKBScope(request)

      yield {
        type: "metadata",
        data: {
          mode: this.mode,
          collectionCount: kbScope.collectionIds?.length || 0,
          folderCount: kbScope.folderIds?.length || 0,
        },
      }

      // 2. Assemble context
      const assembler = this.getContextAssembler()
      await assembler.validate(context)
      const chatContext = await assembler.assemble(context)

      // 3. KB-specific retrieval
      const fragments = yield* this.retrieveKBDocuments(
        chatContext.normalizedUserMessage,
        kbScope,
        context
      )

      yield {
        type: "metadata",
        data: {
          kbResults: fragments.length,
        },
      }

      // 4. Generate response scoped to KB
      yield* this.generateKBResponse(chatContext, fragments, kbScope, context)

      yield {
        type: "complete",
        timestamp: new Date().toISOString(),
        metadata: {
          durationMs: Date.now() - startTime,
          mode: this.mode,
          fragmentsUsed: fragments.length,
        },
      }
    } catch (error) {
      yield {
        type: "error",
        error: {
          code: "KB_ERROR",
          message: error instanceof Error ? error.message : "Unknown error",
          recoverable: false,
        },
      }
    }
  }

  /**
   * Extract KB scope from request
   */
  private extractKBScope(request: ChatRequest): KBScopeConfig {
    const scope: KBScopeConfig = {}

    // Check modelConfig for KB selections
    if (request.modelConfig) {
      // Parse from modelConfig if present
      const config = request.modelConfig as any
      if (config.knowledgeBase) {
        scope.collectionIds = config.knowledgeBase.collectionIds
        scope.folderIds = config.knowledgeBase.folderIds
        scope.fileIds = config.knowledgeBase.fileIds
        scope.structuredSelections = config.knowledgeBase.selections
      }
    }

    // Check for agent-level KB configuration
    if (request.agentId) {
      // Agent config would be loaded during assembly
      // For now, return basic scope
    }

    return scope
  }

  /**
   * Retrieve documents from Knowledge Base
   */
  private async *retrieveKBDocuments(
    query: string,
    scope: KBScopeConfig,
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    const retriever = requestContext.retrievers.get()

    // Build KB search options
    const kbOptions: KnowledgeBaseSearchOptions = {
      apps: [Apps.KnowledgeBase],
      limit: this.options.defaultLimit,
      minConfidence: this.options.minConfidence,
      collectionIds: scope.collectionIds,
      collectionFolderIds: scope.folderIds,
      collectionFileIds: scope.fileIds,
      collectionSelections: scope.structuredSelections,
    }

    const fragments: Fragment[] = []

    for await (const result of retriever.searchKnowledgeBase(
      query,
      kbOptions,
      requestContext
    )) {
      fragments.push(...result.fragments)

      yield {
        type: "metadata",
        data: {
          retrievalSource: "knowledge-base",
          documentsFound: result.fragments.length,
          confidence: result.confidence,
        },
      }
    }

    return fragments
  }

  /**
   * Generate response using KB fragments
   */
  private async *generateKBResponse(
    chatContext: AssembledChatContext,
    fragments: Fragment[],
    scope: KBScopeConfig,
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    const promptBuilder = requestContext.promptBuilder

    // Build KB-specific system prompt
    const systemPrompt = this.buildKBSystemPrompt(
      chatContext,
      fragments,
      scope,
      promptBuilder
    )

    // Build messages
    const messages = this.buildMessages(chatContext, systemPrompt)

    // Stream generation
    const llmProvider = requestContext.getLLMProvider()
    const stream = llmProvider.streamCompletion({
      messages,
      model: requestContext.config.defaultModel,
      temperature: 0.7,
    })

    const citationHandler = requestContext.citations.getHandler("standard")
    let accumulatedText = ""

    for await (const event of stream) {
      switch (event.type) {
        case "token":
          accumulatedText += event.content

          // Extract citations
          if (citationHandler) {
            yield* this.extractKBCitations(
              accumulatedText,
              fragments,
              citationHandler,
              requestContext
            )
          }

          yield {
            type: "token",
            content: event.content,
          }
          break

        case "error":
          yield {
            type: "error",
            error: {
              code: "GENERATION_ERROR",
              message: event.error.message,
              recoverable: false,
            },
          }
          break

        case "complete":
          yield {
            type: "complete",
            finishReason: event.finishReason as any,
            usage: event.usage,
          }
          break
      }
    }
  }

  /**
   * Build KB-specific system prompt
   */
  private buildKBSystemPrompt(
    chatContext: AssembledChatContext,
    fragments: Fragment[],
    scope: KBScopeConfig,
    promptBuilder: import("../../services").PromptBuilderService
  ): string {
    const sections: string[] = []

    // Identity
    sections.push("You are a helpful AI assistant with access to a Knowledge Base.")

    // Scope information
    if (scope.collectionIds && scope.collectionIds.length > 0) {
      sections.push(
        `You are searching within ${scope.collectionIds.length} collection(s).`
      )
    }

    // Context from KB
    if (fragments.length > 0) {
      sections.push(promptBuilder.buildContextSection(fragments))
    }

    // KB-specific instructions
    sections.push(
      "Use only the provided Knowledge Base documents to answer. " +
        "If the answer is not in the documents, say so clearly. " +
        "Always cite sources using [1], [2], etc. format."
    )

    return sections.join("\n\n")
  }

  /**
   * Build messages
   */
  private buildMessages(
    chatContext: AssembledChatContext,
    systemPrompt: string
  ): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = []

    messages.push({
      role: "system",
      content: systemPrompt,
    })

    for (const msg of chatContext.conversationHistory.slice(-10)) {
      messages.push({
        role: msg.role,
        content: msg.content,
      })
    }

    messages.push({
      role: "user",
      content: chatContext.userMessage,
    })

    return messages
  }

  /**
   * Extract KB citations
   */
  private async *extractKBCitations(
    text: string,
    fragments: Fragment[],
    citationHandler: import("../../plugins/citations/citation-handler.interface").CitationHandler,
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    for await (const event of citationHandler.extractCitations(
      text,
      fragments,
      requestContext
    )) {
      if (event.citation) {
        yield {
          type: "citation",
          citation: {
            index: event.citation.index,
            docId: event.citation.item.docId,
            title: event.citation.item.title || "Untitled",
            url: event.citation.item.url,
            source: "knowledge-base",
          },
        }
      }
    }
  }

  /**
   * Check if agent has KB access
   */
  private agentHasKBAccess(request: ChatRequest): boolean {
    // This would check agent configuration
    // For now, assume true if agentId is present
    return !!request.agentId
  }

  /**
   * Check if query matches KB patterns
   */
  private isKBQueryPattern(message: string): boolean {
    const kbPatterns = [
      /\b(kb|knowledge base|collection|folder)\b/i,
      /\b(documents?|files?) in\b/i,
      /\b(search|find) (in|within)\b/i,
    ]

    return kbPatterns.some((pattern) => pattern.test(message))
  }
}
```

### Day 12-14: Bootstrap & Testing

#### 6.1 Strategy Bootstrap

**server/api/chat-v2/core/strategies/bootstrap.ts**

```typescript
/**
 * Strategy Bootstrap
 * 
 * Registers all chat mode strategies with the registry
 */

import { strategyRegistry } from "./strategy-registry"
import { ChatMode } from "./chat-mode-strategy.interface"
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
 */
export function registerStrategies(options: StrategyBootstrapOptions = {}): void {
  // Clear existing registrations
  strategyRegistry.clear()

  // Register strategies in priority order (highest to lowest)
  // Knowledge Base (most specific)
  strategyRegistry.register(
    new KnowledgeBaseChatStrategy(options.knowledgeBaseChat)
  )

  // Attachment
  strategyRegistry.register(
    new AttachmentChatStrategy(options.attachmentChat)
  )

  // Agentic
  strategyRegistry.register(
    new AgenticChatStrategy(options.agenticChat)
  )

  // Normal (least specific - fallback)
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
```

#### 6.2 Strategy Tests

**server/api/chat-v2/core/strategies/__tests__/normal-chat.strategy.test.ts**

```typescript
/**
 * Tests for NormalChatStrategy
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { NormalChatStrategy } from "../normal-chat.strategy"
import { ChatMode } from "../chat-mode-strategy.interface"
import type { ChatRequest, RequestContext } from "../../../models"

describe("NormalChatStrategy", () => {
  let strategy: NormalChatStrategy
  let mockContext: RequestContext

  beforeEach(() => {
    strategy = new NormalChatStrategy()
    mockContext = {
      request: { message: "Hello" },
      user: { id: "user-123", workspaceId: "ws-456" },
      persistence: {
        getRecentMessages: vi.fn().mockResolvedValue([]),
      },
      memory: {
        getEpisodicMemories: vi.fn().mockResolvedValue(""),
        getChatMemories: vi.fn().mockResolvedValue(""),
      },
      retrievers: {
        get: vi.fn().mockReturnValue({
          search: vi.fn().mockImplementation(async function* () {
            yield {
              fragments: [],
              confidence: 0,
            }
          }),
        }),
      },
      promptBuilder: {
        buildContextSection: vi.fn().mockReturnValue("Context"),
      },
      getLLMProvider: vi.fn().mockReturnValue({
        streamCompletion: vi.fn().mockImplementation(async function* () {
          yield { type: "token", content: "Hello!" }
          yield { type: "complete", finishReason: "stop" }
        }),
      }),
      citations: {
        getHandler: vi.fn().mockReturnValue(null),
      },
      config: {
        defaultModel: "gpt-4o",
      },
    } as unknown as RequestContext
  })

  describe("canHandle", () => {
    it("should handle basic requests", () => {
      const request: ChatRequest = { message: "Hello" }
      expect(strategy.canHandle(request)).toBe(true)
    })

    it("should not handle requests with agentId", () => {
      const request: ChatRequest = { message: "Hello", agentId: "agent-123" }
      expect(strategy.canHandle(request)).toBe(false)
    })

    it("should not handle requests with attachments", () => {
      const request: ChatRequest = {
        message: "Hello",
        attachments: [{ fileId: "file-123" } as any],
      }
      expect(strategy.canHandle(request)).toBe(false)
    })
  })

  describe("mode", () => {
    it("should have correct mode", () => {
      expect(strategy.mode).toBe(ChatMode.Normal)
    })
  })

  describe("capabilities", () => {
    it("should support streaming and citations", () => {
      const caps = strategy.getCapabilities()
      expect(caps).toContain("streaming")
      expect(caps).toContain("citations")
    })

    it("should not support tool-calling", () => {
      const caps = strategy.getCapabilities()
      expect(caps).not.toContain("tool-calling")
    })
  })

  describe("execute", () => {
    it("should yield start event", async () => {
      const events = []
      for await (const event of strategy.execute(
        { message: "Hello" },
        mockContext
      )) {
        events.push(event)
      }

      expect(events[0].type).toBe("start")
    })

    it("should yield complete event", async () => {
      const events = []
      for await (const event of strategy.execute(
        { message: "Hello" },
        mockContext
      )) {
        events.push(event)
      }

      expect(events[events.length - 1].type).toBe("complete")
    })

    it("should handle errors gracefully", async () => {
      mockContext.persistence.getRecentMessages = vi
        .fn()
        .mockRejectedValue(new Error("DB Error"))

      const events = []
      for await (const event of strategy.execute(
        { message: "Hello" },
        mockContext
      )) {
        events.push(event)
      }

      const errorEvent = events.find((e) => e.type === "error")
      expect(errorEvent).toBeDefined()
    })
  })
})
```

**server/api/chat-v2/core/strategies/__tests__/strategy-registry.test.ts**

```typescript
/**
 * Tests for StrategyRegistry
 */

import { describe, it, expect, beforeEach } from "vitest"
import { StrategyRegistry } from "../strategy-registry"
import { ChatMode } from "../chat-mode-strategy.interface"
import type { ChatModeStrategy } from "../chat-mode-strategy.interface"
import type { ChatRequest } from "../../../models"

// Mock strategies
const createMockStrategy = (mode: ChatMode, canHandleValue: boolean): ChatModeStrategy => ({
  mode,
  canHandle: () => canHandleValue,
  execute: async function* () {},
  getContextAssembler: () => ({ assemble: async () => ({} as any) } as any),
  getCapabilities: () => [],
})

describe("StrategyRegistry", () => {
  let registry: StrategyRegistry

  beforeEach(() => {
    registry = new StrategyRegistry()
  })

  describe("register", () => {
    it("should register a strategy", () => {
      const strategy = createMockStrategy(ChatMode.Normal, true)
      registry.register(strategy)

      expect(registry.has(ChatMode.Normal)).toBe(true)
    })

    it("should overwrite existing strategy", () => {
      const strategy1 = createMockStrategy(ChatMode.Normal, true)
      const strategy2 = createMockStrategy(ChatMode.Normal, false)

      registry.register(strategy1)
      registry.register(strategy2)

      expect(registry.get(ChatMode.Normal)).toBe(strategy2)
    })
  })

  describe("findFor", () => {
    it("should find matching strategy by priority", () => {
      const normalStrategy = createMockStrategy(ChatMode.Normal, true)
      const agenticStrategy = createMockStrategy(ChatMode.Agentic, true)

      registry.register(normalStrategy)
      registry.register(agenticStrategy)

      const request: ChatRequest = { message: "Hello", agentId: "agent-123" }
      const found = registry.findFor(request)

      // Agentic has higher priority than Normal
      expect(found.mode).toBe(ChatMode.Agentic)
    })

    it("should use default when no strategy matches", () => {
      const defaultStrategy = createMockStrategy(ChatMode.Normal, true)
      registry.setDefault(defaultStrategy)

      const nonMatchingStrategy = createMockStrategy(ChatMode.KnowledgeBase, false)
      registry.register(nonMatchingStrategy)

      const request: ChatRequest = { message: "Hello" }
      const found = registry.findFor(request)

      expect(found).toBe(defaultStrategy)
    })

    it("should throw when no strategy matches and no default", () => {
      const nonMatchingStrategy = createMockStrategy(ChatMode.KnowledgeBase, false)
      registry.register(nonMatchingStrategy)

      const request: ChatRequest = { message: "Hello" }
      expect(() => registry.findFor(request)).toThrow()
    })
  })

  describe("getOrThrow", () => {
    it("should return strategy when exists", () => {
      const strategy = createMockStrategy(ChatMode.Normal, true)
      registry.register(strategy)

      expect(registry.getOrThrow(ChatMode.Normal)).toBe(strategy)
    })

    it("should throw when strategy not found", () => {
      expect(() => registry.getOrThrow(ChatMode.Normal)).toThrow(
        'No strategy registered for mode "normal"'
      )
    })
  })
})
```

#### 6.3 Update Dependency Container

**server/api/chat-v2/core/orchestrator/dependency-container.ts** (Update)

```typescript
/**
 * Dependency Container - Updated for Phase 3
 * 
 * Adds strategy registry to the container
 */

import { ToolRegistry } from "../../plugins/tools/tool-registry"
import { RetrieverRegistry, UnifiedVespaRetriever } from "../../plugins/retrievers"
import { CitationRegistry } from "../../plugins/citations/citation-registry"
import { HybridMemoryService, DatabasePersistenceService, ModularPromptBuilder } from "../../services"
import type { MemoryService, PersistenceService, PromptBuilderService } from "../../services"
import { NormalContextAssembler, AgentContextAssembler, contextAssemblerRegistry } from "../pipeline/context-assembly"
import { ChatMode } from "../strategies/chat-mode-strategy"
import { StrategyRegistry, strategyRegistry } from "../strategies/strategy-registry"
import { NormalChatStrategy, AgenticChatStrategy, AttachmentChatStrategy, KnowledgeBaseChatStrategy } from "../strategies"
import { registerStrategies } from "../strategies/bootstrap"

export interface DependencyContainer {
  // Registries
  tools: ToolRegistry
  retrievers: RetrieverRegistry
  citations: CitationRegistry
  assemblers: typeof contextAssemblerRegistry
  strategies: StrategyRegistry

  // Services
  memory: MemoryService
  persistence: PersistenceService
  promptBuilder: PromptBuilderService

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

/**
 * Factory for creating dependency container with all Phase 3 components
 */
export function createDependencyContainer(
  overrides?: Partial<DependencyContainer>
): DependencyContainer {
  // Create registries
  const tools = new ToolRegistry()
  const retrievers = new RetrieverRegistry()
  const citations = new CitationRegistry()
  
  // Create services
  const memory = new HybridMemoryService()
  const persistence = new DatabasePersistenceService()
  const promptBuilder = new ModularPromptBuilder()
  
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
```

---

## Phase 3 Testing Strategy

### Unit Tests

1. **Strategy Interface Tests**
   - Verify all strategies implement interface correctly
   - Test capability reporting
   - Test mode constants

2. **Individual Strategy Tests**
   - Test `canHandle` logic for each strategy
   - Test execution flow
   - Test error handling
   - Test event generation

3. **Registry Tests**
   - Test registration/unregistration
   - Test priority-based selection
   - Test default strategy fallback

### Integration Tests

1. **Strategy Selection Flow**
   ```typescript
   it("should select AgenticChatStrategy for agent requests", async () => {
     const request = { message: "Hello", agentId: "agent-123" }
     const strategy = strategyRegistry.findFor(request)
     expect(strategy.mode).toBe(ChatMode.Agentic)
   })
   ```

2. **Strategy Execution Flow**
   ```typescript
   it("should execute full agentic flow", async () => {
     const strategy = new AgenticChatStrategy()
     const events = []
     
     for await (const event of strategy.execute(request, context)) {
       events.push(event)
     }
     
     expect(events.some(e => e.type === "start")).toBe(true)
     expect(events.some(e => e.type === "complete")).toBe(true)
   })
   ```

### Feature Flag Tests

```typescript
it("should use legacy implementation when feature flag is off", async () => {
  // Ensure Phase 3 code is behind feature flag
  const useNewStrategies = config.features?.chatV2Strategies === true
  
  if (!useNewStrategies) {
    // Should fall back to legacy message-agents.ts
    expect(() => legacyMessageAgents(c)).not.toThrow()
  }
})
```

---

## Phase 3 Checklist

### Implementation

- [ ] ChatModeStrategy interface defined
- [ ] StrategyRegistry implemented
- [ ] NormalChatStrategy implemented and tested
- [ ] AgenticChatStrategy implemented and tested
- [ ] AttachmentChatStrategy implemented and tested
- [ ] KnowledgeBaseChatStrategy implemented and tested
- [ ] Strategy bootstrap function created
- [ ] Dependency container updated

### Testing

- [ ] Unit tests for each strategy
- [ ] Unit tests for registry
- [ ] Integration tests for strategy selection
- [ ] Feature flag tests
- [ ] Performance benchmarks

### Documentation

- [ ] JSDoc comments on all strategies
- [ ] README for adding new strategies
- [ ] Migration notes for existing code
- [ ] Example usage in test files

### Rollback Safety

- [ ] All new code behind feature flag
- [ ] Legacy code paths preserved
- [ ] Fallback mechanism tested
- [ ] Monitoring/alerts configured

---

## Migration Path for Phase 4

Phase 3 provides the foundation for Phase 4 (Orchestrator & API Layer):

1. **ChatOrchestrator** will use StrategyRegistry to route requests
2. **API Handlers** will delegate to strategies via orchestrator
3. **Streaming** will be standardized across all strategies
4. **Persistence** will be handled by orchestrator, not strategies

```typescript
// Phase 4 orchestrator will look like:
export class ChatOrchestrator {
  async handle(request: ChatRequest, context: Context) {
    // 1. Select strategy
    const strategy = this.strategies.findFor(request)
    
    // 2. Create request context
    const requestContext = await RequestContext.create(request, this.deps)
    
    // 3. Execute strategy
    const events = strategy.execute(request, requestContext)
    
    // 4. Stream events to client
    for await (const event of events) {
      await this.streamEvent(event, context)
    }
    
    // 5. Persist results
    await this.persistence.save(requestContext)
  }
}
```

---

## Benefits Summary

### Before (Current Implementation)

| Concern | Implementation |
|---------|---------------|
| Mode selection | Hardcoded conditionals in message-agents.ts (200+ lines) |
| Mode-specific logic | Scattered across multiple files |
| Adding new mode | Edit message-agents.ts, risk breaking existing modes |
| Testing | Difficult - modes not isolated |
| Documentation | In code comments only |

### After (Phase 3 Implementation)

| Concern | Implementation |
|---------|---------------|
| Mode selection | StrategyRegistry with priority ordering |
| Mode-specific logic | Isolated in strategy classes |
| Adding new mode | Implement ChatModeStrategy interface |
| Testing | Each strategy independently testable |
| Documentation | Interface + implementation docs |

### Extensibility Examples

**Adding a Research Mode:**
```typescript
export class ResearchChatStrategy extends BaseChatModeStrategy {
  readonly mode = ChatMode.Research
  
  canHandle(request: ChatRequest): boolean {
    return request.modelConfig?.deepResearch === true
  }
  
  async *execute(request, context) {
    // Deep research implementation
  }
}

// Register
strategyRegistry.register(new ResearchChatStrategy())
```

**Adding Multi-Agent Mode:**
```typescript
export class MultiAgentChatStrategy extends BaseChatModeStrategy {
  readonly mode = ChatMode.MultiAgent
  
  canHandle(request: ChatRequest): boolean {
    return request.agents && request.agents.length > 1
  }
  
  async *execute(request, context) {
    // Delegate to multiple agents
    for (const agentId of request.agents!) {
      yield* this.delegateToAgent(agentId, request, context)
    }
  }
}
```

---

## Appendix: Strategy Decision Flow

```
Incoming Request
      │
      ▼
┌───────────────────────┐
│ KnowledgeBaseChat     │ Can handle? (KB collections/config)
│ Strategy              │ ──Yes──► Execute KB flow
└───────────────────────┘
      │ No
      ▼
┌───────────────────────┐
│ AttachmentChat        │ Can handle? (has attachments)
│ Strategy              │ ──Yes──► Process attachments, delegate
└───────────────────────┘
      │ No
      ▼
┌───────────────────────┐
│ AgenticChat           │ Can handle? (has agentId)
│ Strategy              │ ──Yes──► Execute agentic loop
└───────────────────────┘
      │ No
      ▼
┌───────────────────────┐
│ NormalChat            │ Default
│ Strategy              │ ──Execute direct generation
└───────────────────────┘
```

This priority order ensures:
1. **Most specific** modes are checked first (KB, Attachment)
2. **Agentic** mode takes precedence over normal
3. **Normal** is the safe fallback
