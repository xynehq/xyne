import { ToolType, ToolCategory, ToolExecutionStatus } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext } from "./types"
import { z } from "zod"

export class MergedNodeTool implements WorkflowTool {
  type = ToolType.MERGED_NODE
  category = ToolCategory.SYSTEM
  
  defaultConfig = {
    inputCount: -1, // Variable input count for merging
    outputCount: 1,
    options: {
      inputCount:{
        type: "number",
        default: 1,
        limit: 5,
        optional: false
      },
      mergeStrategy: {
        type: "select",
        default: "merge",
        optional: false
      },
      waitForAll: {
        type: "boolean",
        default: true,
        optional: true
      },
      timeout: {
        type: "number",
        default: 300000,
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
        message: "MergedNode task completed",
        data: input,
      },
    }
  }
}
