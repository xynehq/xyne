import { ToolType, WorkflowStatus, StepType, ToolExecutionStatus } from "@/types/workflowTypes"

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