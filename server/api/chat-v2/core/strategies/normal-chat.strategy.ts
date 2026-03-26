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

import { BaseChatModeStrategy, type StrategyCapability } from "./base-chat-mode-strategy"
import { ChatMode } from "./chat-mode-strategy"
import type { ChatRequest, AssembledChatContext, Fragment } from "../../models"
import type { ChatEvent } from "../../shared/events"
import type { RequestContextLike as RequestContext } from "../orchestrator/request-context.types"
import { NormalContextAssembler } from "../pipeline/context-assembly"
import type { ContextAssembler } from "../pipeline/context-assembly"

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

  private options: Required<NormalChatStrategyOptions>

  constructor(options: NormalChatStrategyOptions = {}) {
    super()
    this.options = {
      maxTokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      includeMemories: options.includeMemories ?? true,
      includeHistory: options.includeHistory ?? true,
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

      yield this.createStartEvent()

      // 2. Retrieve relevant documents for RAG
      const fragments = yield* this.retrieveDocuments(chatContext, context)

      // 3. Generate response
      yield* this.generateResponse(chatContext, fragments, context)

      yield this.createCompleteEvent({
        durationMs: Date.now() - startTime,
        mode: this.mode,
      })
    } catch (error) {
      yield* this.handleError(error, "NORMAL_STRATEGY_ERROR")
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

    if (!retriever) {
      yield this.createReasoningEvent("No retriever available")
      return []
    }

    const results: Fragment[] = []
    
    try {
      for await (const result of retriever.search(
        chatContext.normalizedUserMessage,
        {
          limit: 10,
          minConfidence: 0.5,
        },
        requestContext
      )) {
        results.push(...result.fragments)
      }

      // Yield metadata event with retrieval info
      yield this.createMetadataEvent({
        retrievalResults: results.length,
      })
    } catch (error) {
      // Non-fatal: continue without retrieval
      console.warn("[NormalChatStrategy] Retrieval failed:", error)
    }

    return results
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
    const messages = this.buildMessages(
      systemPrompt,
      chatContext.conversationHistory,
      chatContext.userMessage
    )

    // Stream generation
    const generator = requestContext.dependencies.generation
    
    if (!generator) {
      yield this.createErrorEvent(
        "GENERATION_NOT_AVAILABLE",
        "Generation pipeline not available",
        false
      )
      return
    }

    // Use streaming generator
    const stream = generator.generate(
      chatContext,
      fragments,
      requestContext
    )

    // Track citations
    let accumulatedText = ""

    for await (const event of stream) {
      switch (event.type) {
        case "token":
          accumulatedText += event.content

          // Extract and yield citations
          yield* this.extractCitations(
            accumulatedText,
            fragments,
            requestContext
          )

          yield {
            type: "token",
            content: event.content,
          }
          break

        case "error":
          yield {
            type: "error",
            error: {
              code: event.error.code,
              message: event.error.message,
              recoverable: event.error.recoverable,
            },
          }
          break

        case "complete":
          yield {
            type: "complete",
          }
          break

        case "citation":
          yield event as ChatEvent
          break

        case "reasoning":
          yield {
            type: "reasoning",
            step: {
              stage: "planning",
              message: event.step,
              details: event.details,
              timestamp: new Date(),
            },
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
    if (fragments.length > 0 && promptBuilder) {
      const contextSection = promptBuilder.buildSystemPrompt({
        mode: "normal",
        capabilities: {},
      })
      if (contextSection) {
        sections.push(contextSection)
      }
    }

    // Citation format
    sections.push("Cite sources using [1], [2], etc. format when referencing information.")

    return sections.join("\n\n")
  }

  /**
   * Check if request has KB collections
   */
  private hasKBCollections(request: ChatRequest): boolean {
    // Check for KB-specific parameters in modelConfig
    const modelConfig = request.modelConfig
    if (!modelConfig) return false

    // Check for KB-specific flags or selections
    const config = modelConfig as any
    if (config.knowledgeBase?.collectionIds?.length > 0) return true
    if (config.knowledgeBase?.folderIds?.length > 0) return true
    if (config.knowledgeBase?.fileIds?.length > 0) return true

    return false
  }
}
