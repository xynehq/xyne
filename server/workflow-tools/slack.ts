import { ToolType, ToolCategory, ToolExecutionStatus } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext } from "./types"
import { z } from "zod"

export class SlackTool implements WorkflowTool {
  type = ToolType.SLACK
  category = ToolCategory.ACTION
  
  defaultConfig = {
    inputCount: 1,
    outputCount: 1,
    options: {
      channel: {
        type: "string",
        default: "",
        optional: false
      },
      username: {
        type: "string",
        default: "Workflow Bot",
        optional: true
      },
      iconEmoji: {
        type: "string",
        default: ":robot_face:",
        optional: true
      },
      threadTs: {
        type: "string",
        default: "",
        optional: true
      }
    }
  }

  inputSchema = z.object({
    message: z.string().optional(),
    attachments: z.array(z.any()).optional(),
    previousStepData: z.record(z.string(), z.any()).optional()
  })

  outputSchema = z.object({
    messageId: z.string().optional(),
    channel: z.string(),
    message: z.string(),
    sentAt: z.string(),
    status: z.string()
  })

  configSchema = z.object({
    channel: z.string().min(1, "Channel is required"),
    username: z.string().optional(),
    icon_emoji: z.string().optional(),
    template: z.string().optional()
  })

  async execute(
    input: Record<string, any>,
    config: Record<string, any>,
    workflowContext: WorkflowContext
  ): Promise<ToolExecutionResult> {
    return {
      status: ToolExecutionStatus.COMPLETED,
      output: {
        message: "Slack task completed",
        data: input,
      },
    }
  }
}
