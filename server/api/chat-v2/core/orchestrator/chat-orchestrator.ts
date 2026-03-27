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
import { RequestContext } from "./request-context"
import type { ChatModeStrategy } from "../strategies/chat-mode-strategy"
import { ChatMode } from "../strategies/chat-mode-strategy"
import { StrategyRegistry } from "../strategies/strategy-registry"
import type { DependencyContainer } from "./dependency-container.types"
import { createDependencyContainer } from "./dependency-container"

export interface OrchestratorConfig {
  /** Strategy registry - can inject custom strategies for testing */
  strategyRegistry?: StrategyRegistry
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
  private strategyRegistry: StrategyRegistry
  private dependencies: DependencyContainer
  private debug: boolean

  constructor(config: OrchestratorConfig = {}) {
    this.strategyRegistry = config.strategyRegistry ?? new StrategyRegistry()
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
    jwtPayload: import("./request-context").JWTPayload,
  ): AsyncIterable<ChatEvent> {
    const startTime = Date.now()
    let requestContext: RequestContext | undefined
    let eventsEmitted = 0

    console.log(
      `[ChatOrchestrator] ========== Starting request processing ==========`,
    )
    console.log(`[ChatOrchestrator] Request message: ${request.message}`)
    console.log(
      `[ChatOrchestrator] JWT userId: ${jwtPayload.userId}, workspaceId: ${jwtPayload.workspaceId}`,
    )

    try {
      // Phase 1: Create request context
      this.log("Creating request context...")
      console.log("[ChatOrchestrator] Phase 1: Creating request context...")
      requestContext = await RequestContext.create(
        request,
        jwtPayload,
        this.dependencies,
      )
      console.log(
        `[ChatOrchestrator] Request context created: ${requestContext.requestId}`,
      )

      yield { type: "start" }
      eventsEmitted++

      // Phase 2: Select strategy
      console.log("[ChatOrchestrator] Phase 2: Selecting strategy...")
      const strategy = this.selectStrategy(request)
      console.log(`[ChatOrchestrator] Selected strategy: ${strategy.mode}`)

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
    if (this.strategyRegistry.getRegisteredModes().length > 0) {
      return
    }

    const { NormalChatStrategy } = require("../strategies/normal-chat.strategy")
    const {
      AgenticChatStrategy,
    } = require("../strategies/agentic-chat.strategy")
    const {
      AttachmentChatStrategy,
    } = require("../strategies/attachment-chat.strategy")
    const {
      KnowledgeBaseChatStrategy,
    } = require("../strategies/knowledge-base-chat.strategy")

    this.strategyRegistry.register(new KnowledgeBaseChatStrategy())
    this.strategyRegistry.register(new AttachmentChatStrategy())
    this.strategyRegistry.register(new AgenticChatStrategy())
    this.strategyRegistry.register(new NormalChatStrategy())

    // Set default
    this.strategyRegistry.setDefault(
      this.strategyRegistry.get(ChatMode.Normal)!,
    )
  }

  /**
   * Handle persistence for specific event types
   */
  private async handleEventPersistence(
    event: ChatEvent,
    context: RequestContext,
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
  private normalizeError(
    error: unknown,
  ): import("../../shared/events").ChatError {
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
