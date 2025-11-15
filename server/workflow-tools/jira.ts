import { z } from "zod"
import { ToolType, ToolCategory, ToolExecutionStatus } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext } from "./types"

export class JiraTool implements WorkflowTool {
  type = ToolType.JIRA
  category = ToolCategory.ACTION
  
  defaultConfig = {
    inputCount: 1,
    outputCount: 1,
    options: {
      baseUrl: {
        type: "string",
        default: "",
        optional: false
      },
      username: {
        type: "string", 
        default: "",
        optional: false
      },
      apiToken: {
        type: "string",
        default: "",
        optional: false
      },
      timeout: {
        type: "number",
        default: 30000,
        optional: true
      }
    }
  }

  inputSchema = z.object({
    action: z.enum(["create_issue", "update_issue", "get_issue", "transition_issue"]),
    project: z.string(),
    issueType: z.string().optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    assignee: z.string().optional(),
    priority: z.string().optional(),
    issueKey: z.string().optional(),
  })

  outputSchema = z.object({
    issueKey: z.string(),
    issueId: z.string(),
    status: z.string(),
    url: z.string(),
  })

  configSchema = z.object({
    baseUrl: z.string().url(),
    username: z.string(),
    apiToken: z.string(),
    timeout: z.number().default(30000),
  })

  async execute(
    input: Record<string, any>,
    config: Record<string, any>,
    workflowContext: WorkflowContext
  ): Promise<ToolExecutionResult> {
    try {
      // TODO: Implement JIRA integration logic
      return {
        status: ToolExecutionStatus.COMPLETED,
        output: {
          issueKey: "PROJ-123",
          issueId: "10001",
          status: "Open",
          url: "https://company.atlassian.net/browse/PROJ-123",
        }
      }
    } catch (error) {
      return {
        status: ToolExecutionStatus.FAILED,
        output: {
          error: error instanceof Error ? error.message : "Unknown error"
        }
      }
    }
  }
}