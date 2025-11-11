import { z } from "zod"
import { ToolType, ToolCategory, ToolExecutionStatus } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext } from "./types"

export class HttpRequestTool implements WorkflowTool {
  type = ToolType.HTTP_REQUEST
  category = ToolCategory.ACTION
  
  defaultConfig = {
    inputCount: 1,
    outputCount: 1,
    options: {
      timeout: {
        type: "number",
        default: 30000,
        optional: true
      },
      retries: {
        type: "number", 
        default: 0,
        optional: true
      },
      followRedirects: {
        type: "boolean",
        default: true,
        optional: true
      }
    }
  }

  inputSchema = z.object({
    url: z.string(),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.any().optional(),
    params: z.record(z.string(), z.string()).optional(),
  })

  outputSchema = z.object({
    status: z.number(),
    data: z.any(),
    headers: z.record(z.string(), z.string()).optional(),
    duration: z.number(),
  })

  configSchema = z.object({
    timeout: z.number().default(30000),
    retries: z.number().default(0),
    followRedirects: z.boolean().default(true),
  })

  async execute(
    input: Record<string, any>,
    config: Record<string, any>,
    workflowContext: WorkflowContext
  ): Promise<ToolExecutionResult> {
    try {
      // TODO: Implement HTTP request execution logic
      return {
        status: ToolExecutionStatus.COMPLETED,
        output: {
          status: 200,
          data: { message: "HTTP request executed successfully" },
          duration: 100,
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