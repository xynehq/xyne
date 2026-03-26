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

import { BaseChatModeStrategy, type StrategyCapability } from "./base-chat-mode-strategy"
import { ChatMode } from "./chat-mode-strategy"
import type {
  ChatRequest,
  AssembledChatContext,
  Fragment,
} from "../../models"
import type { ChatEvent } from "../../shared/events"
import type { RequestContextLike as RequestContext } from "../orchestrator/request-context.types"
import { AgentContextAssembler } from "../pipeline/context-assembly"
import type { ContextAssembler } from "../pipeline/context-assembly"
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

  private options: Required<KnowledgeBaseChatStrategyOptions>

  constructor(options: KnowledgeBaseChatStrategyOptions = {}) {
    super()
    this.options = {
      defaultLimit: options.defaultLimit ?? 15,
      autoDetectCollections: options.autoDetectCollections ?? true,
      minConfidence: options.minConfidence ?? 0.5,
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
      yield this.createStartEvent()

      // 1. Extract KB scope from request
      const kbScope = this.extractKBScope(request)

      yield this.createMetadataEvent({
        mode: this.mode,
        collectionCount: kbScope.collectionIds?.length || 0,
        folderCount: kbScope.folderIds?.length || 0,
      })

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

      yield this.createMetadataEvent({
        kbResults: fragments.length,
      })

      // 4. Generate response scoped to KB
      yield* this.generateKBResponse(chatContext, fragments, kbScope, context)

      yield this.createCompleteEvent({
        durationMs: Date.now() - startTime,
        mode: this.mode,
        fragmentsUsed: fragments.length,
      })
    } catch (error) {
      yield* this.handleError(error, "KB_STRATEGY_ERROR")
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

    if (!retriever) {
      yield this.createReasoningEvent("No retriever available for KB search")
      return []
    }

    // Build KB search options
    const kbOptions: KnowledgeBaseSearchOptions = {
      apps: ["knowledge_base" as any],
      limit: this.options.defaultLimit,
      minConfidence: this.options.minConfidence,
      collectionIds: scope.collectionIds,
      collectionFolderIds: scope.folderIds,
      collectionFileIds: scope.fileIds,
      collectionSelections: scope.structuredSelections,
    }

    const fragments: Fragment[] = []

    try {
      for await (const result of retriever.searchKnowledgeBase(
        query,
        kbOptions,
        requestContext
      )) {
        fragments.push(...result.fragments)

        yield this.createMetadataEvent({
          retrievalSource: "knowledge-base",
          documentsFound: result.fragments.length,
          confidence: result.confidence,
        })
      }
    } catch (error) {
      console.warn("[KnowledgeBaseChatStrategy] KB retrieval failed:", error)
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

    // Stream synthesis
    const stream = generator.generate(
      chatContext,
      fragments,
      requestContext
    )

    let accumulatedText = ""

    for await (const event of stream) {
      switch (event.type) {
        case "token":
          accumulatedText += event.content

          // Extract citations
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
              stage: "synthesizing",
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

    // Context from KB fragments
    if (fragments.length > 0) {
      sections.push("\n## Retrieved Knowledge Base Documents\n")
      fragments.forEach((frag, index) => {
        sections.push(`[${index + 1}] ${frag.source.title || "Untitled"}`)
        sections.push(frag.content)
        sections.push("")
      })
    }

    // KB-specific instructions
    sections.push(
      "\n## Instructions\n" +
      "Use only the provided Knowledge Base documents to answer. " +
      "If the answer is not in the documents, say so clearly. " +
      "Always cite sources using [1], [2], etc. format."
    )

    return sections.join("\n")
  }

  /**
   * Check if agent has KB access
   */
  private agentHasKBAccess(request: ChatRequest): boolean {
    // This would check agent configuration for KB app
    // For now, assume true if agentId is present and KB is in allowed apps
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
