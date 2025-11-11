import type { SelectWorkflowTemplate, ToolExecutionStatus } from "@/db/schema/workflows"
import { ToolType, ToolCategory } from "@/types/workflowTypes"
import {type workflowToolType} from "@/api/workflow-template"
// Workflow context object passed to tools
export interface WorkflowContext {
  templateId: string
  workflowId: string
  currentStepId: string
  currentToolId: string
}

// Tool execution result
export interface ToolExecutionResult {
  status: ToolExecutionStatus
  output: Record<string, any>
  metadata?: Record<string, any>
  nextStepRoutes?: string[]
}

export type defaultToolConfig = workflowToolType

// Workflow tool interface with schemas
export interface WorkflowTool {
  type: ToolType
  category: ToolCategory
  defaultConfig: defaultToolConfig
  execute(input: Record<string, any>, config: Record<string, any>, workflowContext: WorkflowContext): Promise<ToolExecutionResult>
  handleActiveTrigger?(config: Record<string, any>, template:SelectWorkflowTemplate): Promise<Record<string, string>>
  handleInactiveTrigger?(config: Record<string, any>, template:SelectWorkflowTemplate): Promise<Record<string, string>>
}

// Tool registry type for the execution engine
export type ToolRegistry = {
  [K in ToolType]: WorkflowTool
}