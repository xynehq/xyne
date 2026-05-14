import { ReasoningSteps, emitReasoningEvent } from "@/api/chat/reasoning-steps"
import type {
  ToolCallEvent,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent"
import type { ToolCallEventResult } from "@mariozechner/pi-coding-agent"
import type { ToolCallContext, ToolHandler } from "./types"

export class ToolHandlerRegistry {
  private readonly handlers = new Map<string, ToolHandler>()

  register(handler: ToolHandler): this {
    this.handlers.set(handler.toolName, handler)
    return this
  }

  registerAll(...handlers: ToolHandler[]): this {
    for (const handler of handlers) {
      this.register(handler)
    }
    return this
  }

  has(toolName: string): boolean {
    return this.handlers.has(toolName)
  }

  get(toolName: string): ToolHandler | undefined {
    return this.handlers.get(toolName)
  }

  /** List all registered tool names. */
  get registeredTools(): string[] {
    return Array.from(this.handlers.keys())
  }

  async handleToolCall(
    event: ToolCallEvent,
    context: ToolCallContext,
  ): Promise<ToolCallEventResult | undefined> {
    await this.emitToolSelected(event, context)

    const handler = this.handlers.get(event.toolName)
    if (handler?.onToolCall) {
      return handler.onToolCall(event, context)
    }

    return undefined
  }

  async handleToolResult(
    event: ToolResultEvent,
    context: ToolCallContext,
  ): Promise<void> {
    const handler = this.handlers.get(event.toolName)

    // Tool-specific logic first (side effects, extra events)
    if (handler) {
      const shouldRun = !event.isError || handler.handlesErrors
      if (shouldRun) {
        await handler.onToolResult(event, context)
      }
    }

    await this.emitToolCompleted(event.toolName, event.isError, context)
  }

  private async emitToolSelected(
    event: ToolCallEvent,
    context: ToolCallContext,
  ): Promise<void> {
    const { query } = (event.input as Record<string, unknown> | undefined) ?? {}
    await emitReasoningEvent(
      context.emitReasoningStep,
      ReasoningSteps.toolSelected(
        event.toolName,
        typeof query === "string" ? query : undefined,
      ),
    )
  }

  private async emitToolCompleted(
    toolName: string,
    isError: boolean,
    context: ToolCallContext,
  ): Promise<void> {
    await emitReasoningEvent(
      context.emitReasoningStep,
      ReasoningSteps.toolCompleted(toolName, isError),
    )
  }
}
