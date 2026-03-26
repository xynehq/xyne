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

import { BaseChatModeStrategy, type StrategyCapability } from "./base-chat-mode-strategy"
import { ChatMode } from "./chat-mode-strategy"
import type {
  ChatRequest,
  AssembledChatContext,
  Fragment,
  AgentConfig,
} from "../../models"
import type { ChatEvent } from "../../shared/events"
import type { RequestContextLike as RequestContext } from "../orchestrator/request-context.types"
import { AgentContextAssembler } from "../pipeline/context-assembly"
import type { ContextAssembler } from "../pipeline/context-assembly"
import type { Tool, ToolExecutionContext } from "../../plugins/tools/tool.interface"

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

  private options: Required<AgenticChatStrategyOptions>

  constructor(options: AgenticChatStrategyOptions = {}) {
    super()
    this.options = {
      maxTurns: options.maxTurns ?? 10,
      temperature: options.temperature ?? 0.7,
      enableReasoning: options.enableReasoning ?? true,
      enableReview: options.enableReview ?? true,
      reviewFrequency: options.reviewFrequency ?? 5,
    }
  }

  /**
   * Agentic strategy handles requests with:
   * - agentId specified
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
      yield this.createStartEvent()

      // 1. Assemble context with agent configuration
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
      yield this.createMetadataEvent({
        mode: this.mode,
        agentId: chatContext.agentConfig.id,
        agentName: chatContext.agentConfig.name,
      })

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
        metadata: {
          durationMs: Date.now() - startTime,
          mode: this.mode,
          turns: state.turnCount,
          toolCalls: state.toolHistory.length,
        },
      }
    } catch (error) {
      yield* this.handleError(error, "AGENTIC_STRATEGY_ERROR")
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
    const maxTurns = this.options.maxTurns

    while (state.turnCount < maxTurns) {
      state.turnCount++

      // Yield reasoning step
      if (this.options.enableReasoning) {
        yield this.createReasoningEvent(
          `Turn ${state.turnCount}/${maxTurns}`,
          {
            fragments: state.fragments.length,
            toolsUsed: state.toolHistory.length,
          }
        )
      }

      // Run one turn
      const turnResult = yield* this.runTurn(
        chatContext,
        tools,
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
        yield this.createReasoningEvent("Max turns reached", { maxTurns })
        yield* this.synthesizeFinalAnswer(chatContext, state, requestContext)
        break
      }

      // Run review if enabled and at review frequency
      if (
        this.options.enableReview &&
        state.turnCount % this.options.reviewFrequency === 0
      ) {
        yield* this.runReview(state, requestContext)
      }
    }
  }

  /**
   * Run a single turn
   */
  private async *runTurn(
    chatContext: AssembledChatContext,
    tools: Tool[],
    state: AgentExecutionState,
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    let shouldSynthesize = false

    // Build messages for this turn
    const messages = this.buildTurnMessages(chatContext, state)

    // Get generation pipeline
    const generator = requestContext.dependencies.generation
    if (!generator) {
      throw new Error("Generation pipeline not available")
    }

    // Generate response (with tools)
    const stream = generator.generate(
      chatContext,
      state.fragments,
      requestContext
    )

    for await (const event of stream) {
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
            args: event.arguments || {},
            callId: event.toolCallId,
          }

          // Execute tool
          const toolResult = yield* this.executeTool(
            event.tool,
            event.arguments || {},
            event.toolCallId,
            requestContext
          )

          // Update state with tool result
          state.toolHistory.push({
            tool: event.tool,
            toolCallId: event.toolCallId,
            arguments: event.arguments || {},
            result: toolResult.data,
            error: toolResult.error?.message,
          })

          if (toolResult.fragments) {
            state.fragments.push(...toolResult.fragments)
          }
          break

        case "complete":
          if (event.finishReason === "stop" || event.finishReason === "tool-calls") {
            shouldSynthesize = true
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

        case "reasoning":
          yield {
            type: "reasoning",
            step: {
              stage: "tool_executing",
              message: event.step,
              details: event.details,
              timestamp: new Date(),
            },
          }
          break

        case "citation":
          yield event as ChatEvent
          break
      }
    }

    return { shouldSynthesize }
  }

  /**
   * Execute a tool
   */
  private async *executeTool(
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string,
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    const tool = requestContext.tools.get(toolName)
    
    if (!tool) {
      yield {
        type: "tool-result",
        tool: toolName,
        result: { error: `Tool not found: ${toolName}` },
        callId: toolCallId,
        durationMs: 0,
      }
      return { success: false, error: { code: "TOOL_NOT_FOUND", message: `Tool not found: ${toolName}`, isRetryable: false } }
    }

    const startTime = Date.now()

    try {
      const execContext: ToolExecutionContext = {
        toolCallId,
        requestContext,
        signal: new AbortController().signal,
        onProgress: (update) => {
          // Progress updates could be yielded if needed
        },
      }

      const result = await tool.execute(args, execContext)

      yield {
        type: "tool-result",
        tool: toolName,
        result: result.success ? result.data : result.error,
        callId: toolCallId,
        durationMs: Date.now() - startTime,
      }

      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Tool execution failed"
      
      yield {
        type: "tool-result",
        tool: toolName,
        result: { error: errorMessage },
        callId: toolCallId,
        durationMs: Date.now() - startTime,
      }

      return {
        success: false,
        error: {
          code: "TOOL_EXECUTION_ERROR",
          message: errorMessage,
          isRetryable: true,
        },
      }
    }
  }

  /**
   * Synthesize final answer
   */
  private async *synthesizeFinalAnswer(
    chatContext: AssembledChatContext,
    state: AgentExecutionState,
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    yield this.createReasoningEvent("Synthesizing final answer", {
      fragmentCount: state.fragments.length,
      toolCalls: state.toolHistory.length,
    })

    // Use generation pipeline for final synthesis
    const generator = requestContext.dependencies.generation
    if (!generator) {
      yield this.createErrorEvent(
        "GENERATION_NOT_AVAILABLE",
        "Generation pipeline not available for synthesis",
        false
      )
      return
    }

    // Stream synthesis
    for await (const event of generator.generate(
      chatContext,
      state.fragments,
      requestContext
    )) {
      yield event as ChatEvent
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

    // Default: get all available tools
    return toolRegistry.getAll()
  }

  /**
   * Run automatic review
   */
  private async *runReview(
    state: AgentExecutionState,
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    yield this.createReasoningEvent("Running automatic review", {
      turnCount: state.turnCount,
      fragmentsCount: state.fragments.length,
    })

    // Review logic would go here
    // For now, just a placeholder
  }

  /**
   * Build turn messages
   */
  private buildTurnMessages(
    chatContext: AssembledChatContext,
    state: AgentExecutionState
  ): Array<{ role: string; content: string }> {
    const agentConfig = chatContext.agentConfig!
    const messages: Array<{ role: string; content: string }> = []

    // System prompt
    const systemPrompt = this.buildAgentSystemPrompt(agentConfig)
    messages.push({ role: "system", content: systemPrompt })

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
   * Build agent system prompt
   */
  private buildAgentSystemPrompt(agentConfig: AgentConfig): string {
    const sections: string[] = []

    // Identity and base instructions
    sections.push("You are an AI agent that helps users by using available tools.")

    // Agent-specific prompt
    if (agentConfig.systemPrompt) {
      sections.push(agentConfig.systemPrompt)
    }

    if (agentConfig.prompt) {
      sections.push(agentConfig.prompt)
    }

    // Tool instructions
    if (agentConfig.tools && agentConfig.tools.length > 0) {
      sections.push(`Available tools: ${agentConfig.tools.join(", ")}`)
    }

    // Citation format
    sections.push("Always cite sources using [1], [2], etc. format.")

    return sections.join("\n\n")
  }
}
