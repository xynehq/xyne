/**
 * Adapter utilities for wrapping existing tools
 * 
 * These utilities bridge the new Tool interface to existing tool implementations
 * in pi-mono/tools/ directory
 */

import { Type } from "@sinclair/typebox"
import type { Static, TSchema } from "@sinclair/typebox"
import type { Tool, ToolExecutionContext, ToolResult } from "../tool.interface"

// Mock types for existing tool compatibility - will be replaced with actual imports
interface XyneToolContext {
  events: {
    emit: (event: string, payload: unknown) => void
  }
  xyneState: XyneAgentState
  persistState: () => Promise<void>
  runtime: {
    streamAnswerText: (text: string) => Promise<void>
    emitReasoning: (payload: unknown) => Promise<void>
  }
}

interface XyneAgentState {
  // Placeholder for actual state structure
  turnCount: number
  [key: string]: unknown
}

// Placeholder for the adapter module
const ChatSSEvents = {
  Start: "START",
  Reasoning: "REASONING",
} as const

/**
 * Convert TypeBox schema to JSON Schema for Tool interface
 */
export function typeboxToJsonSchema(schema: TSchema): Record<string, unknown> {
  // TypeBox schemas are already JSON Schema compatible
  return schema as Record<string, unknown>
}

/**
 * Create ToolExecutionContext from RequestContext
 * This bridges the new context to the existing pi-mono adapter
 */
export function createToolExecutionBridge(
  requestContext: { getAgentState: () => unknown; getMetadata: (key: string) => unknown },
  toolCallId: string
): XyneToolContext {
  return {
    events: {
      emit: (event: string, payload: unknown) => {
        // Bridge events to new event system
        if (event === "reasoning") {
          // Emit reasoning event
        }
      },
    },
    xyneState: requestContext.getAgentState() as XyneAgentState,
    persistState: async () => {
      // State is persisted via RequestContext
    },
    runtime: requestContext.getMetadata("runtime") as {
      streamAnswerText: (text: string) => Promise<void>
      emitReasoning: (payload: unknown) => Promise<void>
    },
  }
}

/**
 * Adapter for wrapping existing pi-mono tools
 */
export function wrapExistingTool(
  name: string,
  existingTool: {
    name: string
    description: string
    parameters: TSchema
    execute: (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: XyneToolContext
    ) => Promise<{
      content: Array<{ type: string; text: string }>
      isError?: boolean
      details?: Record<string, unknown>
    }>
  }
): Tool {
  return {
    name: existingTool.name,
    description: existingTool.description,
    parameters: typeboxToJsonSchema(existingTool.parameters),
    
    async execute(params, context) {
      const xyneCtx = createToolExecutionBridge(
        context.requestContext,
        context.toolCallId
      )
      
      try {
        const result = await existingTool.execute(
          context.toolCallId,
          params,
          context.signal,
          {}, // onUpdate
          xyneCtx
        )
        
        if (result.isError) {
          return {
            success: false,
            error: {
              code: "TOOL_ERROR",
              message: result.content[0]?.text || "Tool execution failed",
              isRetryable: false,
            },
          }
        }
        
        return {
          success: true,
          data: result.details,
          summary: result.content[0]?.text,
        }
      } catch (error) {
        return {
          success: false,
          error: {
            code: "EXECUTION_ERROR",
            message: error instanceof Error ? error.message : String(error),
            isRetryable: true,
          },
        }
      }
    },
  }
}
