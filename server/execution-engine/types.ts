import { ToolType, WorkflowStatus, StepType, ToolExecutionStatus } from "@/types/workflowTypes"
import type { ToolExecutionResult } from "@/workflow-tools/types"

// Execution context for workflow execution
export interface ExecutionContext {
  executionId: string
  workflowTemplateId: string
  userId: number
  workspaceId: number
  metadata?: Record<string, any>
  startedAt: Date
}

// Step execution data
export interface StepExecutionData {
  stepExecutionId: string
  stepTemplateId: string
  name: string
  type: StepType
  status: WorkflowStatus
  prevStepIds: string[]
  nextStepIds: string[]
  toolId?: string
  metadata?: Record<string, any>
  input?: any
  output?: any
}

// Tool execution data
export interface ToolExecutionData {
  toolExecutionId: string
  toolId: string
  toolType: ToolType
  status: ToolExecutionStatus
  input?: any
  result?: any
  config?: Record<string, any>
}

// Queue item for ready steps
export interface ReadyQueueItem {
  stepExecutionId: string
  stepTemplateId: string
  executionId: string
  priority: number
  createdAt: Date
  input?: any
}

// Execution result
export interface ExecutionResult {
  success: boolean
  stepExecutionId: string
  output?: any
  error?: string
  nextSteps?: string[]
}

// Workflow execution state
export interface WorkflowExecutionState {
  executionId: string
  status: WorkflowStatus
  completedSteps: Set<string>
  failedSteps: Set<string>
  activeSteps: Set<string>
  pendingSteps: Set<string>
}

// Execution packet interface for queue communication
export interface ExecutionPacket {
  template_id: string
  workflow_id: string
  step_id: string
  tool_id: string
  input: Record<string, any> // JSON input data for tool execution
  previous_tool_id?: string // Optional previous tool ID
  previous_step_id?: string // Optional previous step ID
}

// Step execution result interface
export interface StepExecutionResult {
  success: boolean
  stepId: string
  toolId: string
  toolResult: ToolExecutionResult
  nextAction: 'continue' | 'halt' | 'wait_for_input'
  next_execute_at?: string // ISO timestamp for scheduled execution
  error?: string
}