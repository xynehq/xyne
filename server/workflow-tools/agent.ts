import { ToolType, ToolCategory, ToolExecutionStatus } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext, defaultToolConfig } from "./types"
import { z } from "zod"

export class AgentTool implements WorkflowTool {
  type = ToolType.AGENT
  category = ToolCategory.ACTION

  defaultConfig:defaultToolConfig  = {
    inputCount: 1,
    outputCount: 1,
    options: {
      agentId: {
        type: "string",
        default: "",
        optional: false
      },
      prompt: {
        type: "string",
        default: "",
        optional: true
      },
      timeout: {
        type: "number",
        default: 120000,
        optional: true
      }
    }
  }

  inputSchema = z.object({})
  outputSchema = z.object({})
  configSchema = z.object({})

  async execute(
    input: Record<string, any>,
    config: Record<string, any>,
    workflowContext: WorkflowContext
  ): Promise<ToolExecutionResult> {
    return {
      status: ToolExecutionStatus.COMPLETED,
      output: {
        agent_response: "Agent task completed",
        task: input.task || "No task specified",
      },
    }
  }
}