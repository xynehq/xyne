/**
 * JAF Tool Adapter
 * Converts xyne tools to JAF-compatible tools
 */

import type { Tool, ToolParameter, ToolParameterType } from "@xynehq/jaf/adk"
import type { AgentTool, MinimalAgentFragment } from "../types"

export interface JAFToolConfig {
  email: string
  userContext: string
  agentPrompt?: string
  userMessage?: string
}

/**
 * Creates a JAF-compatible tool from a xyne tool
 */
export const createJAFToolAdapter = (
  xyneTool: AgentTool,
  config: JAFToolConfig,
): Tool => {
  // Convert xyne parameters to JAF ToolParameter array
  const parameters: ToolParameter[] = Object.entries(
    xyneTool.parameters || {},
  ).map(([name, param]: [string, any]) => ({
    name,
    type: (param.type || "string") as ToolParameterType,
    description: param.description || "",
    required: param.required || false,
    schema: param,
  }))

  return {
    name: xyneTool.name,
    description: xyneTool.description,
    parameters,

    execute: async (params: Record<string, any>, context: any) => {
      try {
        // Execute xyne tool with its expected parameters
        const result = await xyneTool.execute(
          params,
          undefined, // span - will be handled by JAF
          config.email,
          config.userContext,
          config.agentPrompt,
          config.userMessage || params.message,
        )

        // Convert xyne result to JAF result format
        if (result.error) {
          return {
            success: false,
            error: result.error,
            output: result.result,
          }
        }

        return {
          success: true,
          output: result.result,
          data: {
            contexts: result.contexts || [],
            fallbackReasoning: result.fallbackReasoning,
          },
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          output: `Tool execution failed: ${xyneTool.name}`,
        }
      }
    },
  }
}
