import type { SelectWorkflowTemplate } from "@/db/schema/workflows"
import { ToolType, ToolCategory } from "@/types/workflowTypes"
import { z } from "zod"

// Workflow context object passed to tools
export interface WorkflowContext {
  templateId: string
  workflowId: string
  currentStepId: string
  currentToolId: string
}

// Tool execution result
export interface ToolExecutionResult {
  status: "success" | "error" | "awaiting_user_input" | "partial_success"
  result: Record<string, any>
  metadata?: Record<string, any>
}

// Workflow tool interface with schemas
export interface WorkflowTool {
  type: ToolType
  category: ToolCategory
  inputSchema: z.ZodSchema<any>
  outputSchema: z.ZodSchema<any>
  configSchema: z.ZodSchema<any>
  triggerIfActive: boolean
  execute(input: Record<string, any>, config: Record<string, any>, workflowContext: WorkflowContext): Promise<ToolExecutionResult>
  handleActiveTrigger?(config: Record<string, any>, template:SelectWorkflowTemplate): Promise<Record<string, string>>
  handleInactiveTrigger?(config: Record<string, any>, template:SelectWorkflowTemplate): Promise<Record<string, string>>
}

// Tool registry type for the execution engine
export type ToolRegistry = {
  [K in ToolType]: WorkflowTool
}