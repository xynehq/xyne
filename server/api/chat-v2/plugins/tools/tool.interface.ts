/**
 * Tool Interface - Core abstraction for agent tools
 * 
 * REPLACES: Hardcoded tool list in message-agents.ts buildXyneTools()
 * BENEFITS:
 *   - New tools implement interface, no editing of central file
 *   - Tools can be dynamically discovered and registered
 *   - Easy to mock for testing
 *   - Versioning support (multiple implementations)
 */

import type { JSONSchema7 } from "json-schema"
import type { RequestContextLike as RequestContext } from "../../core/orchestrator/request-context.types"
import type { Citation, Fragment } from "../../models"

/**
 * Tool interface - all tools implement this
 */
export interface Tool<TParams = unknown, TResult = unknown> {
  /** Unique tool name (used in tool calls) */
  readonly name: string
  
  /** Human-readable description for LLM */
  readonly description: string
  
  /** JSON Schema for parameters */
  readonly parameters: JSONSchema7
  
  /**
   * Execute the tool
   * @param params - Validated parameters
   * @param context - Execution context
   * @returns Tool result
   */
  execute(
    params: TParams,
    context: ToolExecutionContext
  ): Promise<ToolResult<TResult>>
  
  /**
   * Optional: Check if tool is available in current context
   * Called before adding to available tools list
   */
  isAvailable?(context: RequestContext): boolean
  
  /**
   * Optional: Get tool category for organization
   */
  readonly category?: ToolCategory
  
  /**
   * Optional: Tool version for compatibility
   */
  readonly version?: string
}

/**
 * Tool categories for organization
 */
export enum ToolCategory {
  Search = "search",
  Retrieval = "retrieval",
  Generation = "generation",
  Delegation = "delegation",
  Planning = "planning",
  Utility = "utility",
  Integration = "integration",
}

/**
 * Context provided during tool execution
 */
export interface ToolExecutionContext {
  /** Tool call ID from LLM */
  toolCallId: string
  
  /** Request context */
  requestContext: RequestContext
  
  /** Abort signal for cancellation */
  signal: AbortSignal
  
  /**
   * Report progress updates during long operations
   * Called multiple times for streaming updates
   */
  onProgress?: (update: ToolProgressUpdate) => void
}

/**
 * Progress update during tool execution
 */
export interface ToolProgressUpdate {
  stage: string
  message?: string
  percentComplete?: number
  metadata?: Record<string, unknown>
}

/**
 * Result of tool execution
 */
export interface ToolResult<TResult = unknown> {
  /** Success flag */
  success: boolean
  
  /** Result data (if success) */
  data?: TResult
  
  /** Error details (if failed) */
  error?: ToolError
  
  /** Citations produced by tool */
  citations?: Citation[]
  
  /** Fragments produced by tool */
  fragments?: Fragment[]
  
  /** Human-readable summary for LLM */
  summary?: string
  
  /** Execution metadata */
  metadata?: ToolResultMetadata
}

export interface ToolError {
  code: string
  message: string
  details?: Record<string, unknown>
  isRetryable: boolean
  suggestedAction?: string
}

export interface ToolResultMetadata {
  durationMs: number
  tokensUsed?: number
  costUsd?: number
  cacheHit?: boolean
}

/**
 * Tool factory for creating tool instances
 * Allows dependency injection
 */
export interface ToolFactory {
  createTool<TParams, TResult>(
    name: string,
    config?: Record<string, unknown>
  ): Tool<TParams, TResult>
}

/**
 * Tool metadata for discovery
 */
export interface ToolMetadata {
  name: string
  description: string
  parameters: JSONSchema7
  category: ToolCategory
  version: string
  requiresAuth?: boolean
  allowedRoles?: string[]
}

/**
 * Type guard for tool results
 */
export function isToolSuccess<TResult>(
  result: ToolResult<TResult>
): result is ToolResult<TResult> & { success: true; data: TResult } {
  return result.success === true && result.data !== undefined
}

export function isToolError<TResult>(
  result: ToolResult<TResult>
): result is ToolResult<TResult> & { success: false; error: ToolError } {
  return result.success === false && result.error !== undefined
}
