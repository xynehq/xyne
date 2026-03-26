/**
 * Record of a tool execution
 */
export interface ToolExecution {
  /** Unique call ID */
  callId: string
  
  /** Tool name */
  toolName: string
  
  /** Connector ID (for MCP tools) */
  connectorId?: string
  
  /** Arguments passed to tool */
  arguments: Record<string, unknown>
  
  /** Turn number when executed */
  turnNumber: number
  
  /** When execution started */
  startedAt: Date
  
  /** Execution duration in ms */
  durationMs: number
  
  /** Estimated cost in USD */
  estimatedCostUsd?: number
  
  /** Execution status */
  status: "success" | "error" | "cancelled"
  
  /** Error details (if failed) */
  error?: ToolError
  
  /** Result summary */
  result?: string
  
  /** Fragments produced by tool */
  fragments?: string[] // Fragment IDs
}

export interface ToolError {
  code: string
  message: string
  stack?: string
  isRetryable: boolean
}

/**
 * Tool execution expectation
 */
export interface ToolExpectation {
  goal: string
  successCriteria: string[]
  failureSignals?: string[]
  stopCondition?: string
  evidencePlan?: string
}
