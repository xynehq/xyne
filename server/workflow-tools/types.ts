import { ToolType, ToolExecutionStatus, ToolCategory } from "@/types/workflowTypes"

// Base interfaces for all workflow tools
export interface ToolExecutionContext {
  executionId: string
  stepId: string
  userId: string
  workspaceId: string
  userEmail: string
  previousStepResults?: Record<string, any>
}

export interface ToolExecutionResult<T = any> {
  status: "success" | "error" | "awaiting_user_input" | "partial_success"
  result: T
  metadata?: Record<string, any>
}

export interface BaseToolConfig {
  [key: string]: any
}

export interface BaseToolInput {
  [key: string]: any
}

export interface BaseToolOutput {
  [key: string]: any
}

// Generic tool interface that all tools must implement
export interface WorkflowTool<
  TConfig extends BaseToolConfig = BaseToolConfig,
  TInput extends BaseToolInput = BaseToolInput,
  TOutput extends BaseToolOutput = BaseToolOutput
> {
  type: ToolType
  category: ToolCategory
  execute(
    input: TInput,
    config: TConfig,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<TOutput>>
  validateInput(input: unknown): input is TInput
  validateConfig(config: unknown): config is TConfig
  getInputSchema(): any
  getConfigSchema(): any
  getDefaultConfig(): TConfig
}

// Tool registry type for the execution engine
export type ToolRegistry = {
  [K in ToolType]: WorkflowTool<any, any, any>
}