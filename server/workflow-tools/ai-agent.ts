import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext } from "./types"
import { z } from "zod"

export class AiAgentTool implements WorkflowTool {
  type = ToolType.AI_AGENT
  category = ToolCategory.ACTION
  triggerIfActive = false
  inputSchema = z.object({})
  outputSchema = z.object({})
  configSchema = z.object({})

  async execute(
    input: Record<string, any>,
    config: Record<string, any>,
    workflowContext: WorkflowContext
  ): Promise<ToolExecutionResult> {
    return {
      status: "success",
      result: {
        ai_response: "AI task completed",
        prompt: input.prompt || "No prompt specified",
      },
    }
  }
}