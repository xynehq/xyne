import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext } from "./types"
import { z } from "zod"

export class ConditionalTool implements WorkflowTool {
  type = ToolType.CONDITIONAL
  category = ToolCategory.SYSTEM
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
        condition_met: true,
        condition: config.condition || "No condition specified",
        result: "Condition evaluated",
      },
    }
  }
}