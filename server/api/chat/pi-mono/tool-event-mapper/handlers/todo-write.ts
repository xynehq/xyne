import { ReasoningSteps, emitReasoningEvent } from "@/api/chat/reasoning-steps"
import type { ToolResultEvent } from "@mariozechner/pi-coding-agent"
import type { ToDoWriteDetails, ToolCallContext, ToolHandler } from "../types"

export const todoWriteHandler: ToolHandler = {
  toolName: "toDoWrite",

  async onToolResult(
    event: ToolResultEvent,
    context: ToolCallContext,
  ): Promise<void> {
    const details = (event.details ?? {}) as ToDoWriteDetails
    const { plan } = details
    if (!plan) return

    await emitReasoningEvent(
      context.emitReasoningStep,
      ReasoningSteps.planCreated(plan.goal ?? "unknown", plan.subTasks ?? []),
    )
  },
}
