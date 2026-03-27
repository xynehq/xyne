/**
 * Pi-Mono Tool Adapter
 *
 * Bridges pi-mono tools (from /server/api/chat/pi-mono/tools) to chat-v2 Tool interface.
 *
 * This adapter allows existing pi-mono tools to work with the new chat-v2 architecture
 * without requiring a complete rewrite of all tools.
 *
 * HOW IT WORKS:
 * - Pi-mono tools are created with createXyneTool() which returns ToolDefinition<TParams, any, any>
 * - Chat-v2 expects tools implementing the Tool<TParams, TResult> interface
 * - This adapter wraps pi-mono tools to conform to the chat-v2 interface
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import type { JSONSchema7 } from "json-schema"
import {
  ToolCategory,
  type Tool,
  type ToolExecutionContext,
  type ToolResult,
} from "./tool.interface"
import type { Fragment, Citation } from "../../models"

/**
 * Adapter that converts a pi-mono ToolDefinition to chat-v2 Tool interface
 */
export class PiMonoToolAdapter implements Tool {
  readonly name: string
  readonly description: string
  readonly parameters: JSONSchema7
  readonly category: ToolCategory
  readonly version: string = "1.0.0"

  private piMonoTool: ToolDefinition<any, any, any>

  constructor(
    piMonoTool: ToolDefinition<any, any, any>,
    category: ToolCategory = ToolCategory.Utility,
  ) {
    this.piMonoTool = piMonoTool
    this.name = piMonoTool.name
    this.description = piMonoTool.description

    // Convert TypeBox schema to JSON Schema 7
    // Pi-mono uses TypeBox, chat-v2 expects JSONSchema7
    this.parameters = this.convertTypeBoxToJsonSchema(piMonoTool.parameters)
    this.category = category
  }

  /**
   * Execute the tool, bridging pi-mono context to chat-v2 context
   */
  async execute(
    params: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const { toolCallId, signal, onProgress } = context

    try {
      // Create progress callback for pi-mono
      const onUpdate = (update: any) => {
        if (onProgress) {
          onProgress({
            stage: update.stage || "executing",
            message: update.message,
            percentComplete: update.percent,
          })
        }
      }

      // Execute pi-mono tool
      // Note: pi-mono tools expect XyneToolContext, we need to create an adapter
      const result = await this.piMonoTool.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        // Pass a context adapter that extracts what pi-mono needs from requestContext
        this.createXyneToolContext(context),
      )

      // Convert pi-mono result to chat-v2 ToolResult format
      return this.convertResult(result)
    } catch (error) {
      return {
        success: false,
        error: {
          code: "TOOL_EXECUTION_ERROR",
          message: error instanceof Error ? error.message : String(error),
          isRetryable: false,
        },
      }
    }
  }

  /**
   * Check if tool is available in context
   * For now, assume all pi-mono tools are available
   * TODO: Add proper availability checks based on user connectors
   */
  isAvailable(): boolean {
    return true
  }

  /**
   * Create XyneToolContext from chat-v2 ToolExecutionContext
   * This bridges the context gap between architectures
   */
  private createXyneToolContext(
    context: ToolExecutionContext,
  ): any {
    // Extract needed values from requestContext
    const { requestContext } = context

    // Return minimal context that pi-mono tools expect
    // The actual state management happens in the agentic strategy
    return {
      events: {
        emit: (event: string, payload: any) => {
          // Bridge events to chat-v2 event system
          // This can be enhanced to emit proper chat-v2 events
          console.log(`[Pi-Mono Tool Event] ${event}:`, payload)
        },
      },
      // XyneState will be provided by the agentic strategy
      // This is a placeholder - the actual state comes from AgentExecutionState
      xyneState: (requestContext as any).xyneState || {},
      persistState: async () => {
        // State persistence is handled by the strategy
      },
      runtime: (requestContext as any).runtime || {},
    }
  }

  /**
   * Convert pi-mono result to chat-v2 ToolResult
   */
  private convertResult(piMonoResult: any): ToolResult {
    // Pi-mono result format: { content: [...], details: {...}, isError?: boolean }
    if (piMonoResult.isError) {
      return {
        success: false,
        error: {
          code: "TOOL_ERROR",
          message:
            piMonoResult.content?.[0]?.text || "Tool execution failed",
          details: piMonoResult.details,
          isRetryable: false,
        },
      }
    }

    // Extract fragments if present
    const fragments: Fragment[] = piMonoResult.details?.fragments || []

    // Convert fragments to citations
    const citations: Citation[] = fragments.map((f: Fragment) => ({
      id: f.id,
      title: f.source?.title || "Unknown",
      url: f.source?.url,
      app: f.source?.app,
      entity: f.source?.entity,
      confidence: f.confidence || 1.0,
    }))

    return {
      success: true,
      data: piMonoResult.details,
      summary: piMonoResult.content?.[0]?.text,
      fragments,
      citations,
      metadata: {
        durationMs: 0, // Could track this
      },
    }
  }

  /**
   * Convert TypeBox schema to JSON Schema 7
   * This is a simplified conversion - enhance as needed
   */
  private convertTypeBoxToJsonSchema(typeBoxSchema: any): JSONSchema7 {
    // If it's already JSON Schema 7 compatible, return as-is
    if (typeBoxSchema && typeBoxSchema.$schema) {
      return typeBoxSchema as JSONSchema7
    }

    // Convert TypeBox to JSON Schema
    // TypeBox uses 'type', 'properties', 'required' similar to JSON Schema
    const schema: JSONSchema7 = {
      type: "object",
      properties: {},
      required: [],
    }

    if (typeBoxSchema?.properties) {
      for (const [key, value] of Object.entries(typeBoxSchema.properties)) {
        const prop = value as any
        ;(schema.properties as any)[key] = {
          type: prop.type || "string",
          description: prop.description,
          enum: prop.enum,
        }

        // Check if property is required
        if (typeBoxSchema.required?.includes(key)) {
          schema.required!.push(key)
        }
      }
    }

    return schema
  }
}

/**
 * Factory function to wrap a pi-mono tool with the adapter
 */
export function adaptPiMonoTool(
  piMonoTool: ToolDefinition<any, any, any>,
  category: ToolCategory = ToolCategory.Utility,
): Tool {
  return new PiMonoToolAdapter(piMonoTool, category)
}
