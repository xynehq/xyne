import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { db } from "@/db/client"
import { workflowTool, workflowStepExecution, toolExecution, WorkflowStatus, ToolExecutionStatus } from "@/db/schema/workflows"
import { eq, sql } from "drizzle-orm"
import { getTool } from "@/workflow-tools/registry"
import type { ToolExecutionResult, WorkflowContext } from "@/workflow-tools/types"
import type { ExecutionPacket, StepExecutionResult } from "./types"

const Logger = getLogger(Subsystem.ExecutionEngine)

export class StepExecutor {
  
  // Main method to execute a workflow step
  async executeStep(packet: ExecutionPacket): Promise<StepExecutionResult> {
    const { workflow_id, step_id, tool_id, input, template_id } = packet
    
    try {
      Logger.info(`🚀 Starting step execution for step ${step_id}, tool ${tool_id}`)

      // 1. Fetch tool configuration from database
      const toolConfig = await this.getToolConfiguration(tool_id)
      if (!toolConfig) {
        return this.createErrorResult(step_id, tool_id, "Tool configuration not found")
      }

      // 2. Get tool implementation from registry
      const toolImplementation = getTool(toolConfig.type as any)
      
      // 3. Update step status to running
      await this.updateStepStatus(step_id, WorkflowStatus.ACTIVE)
      
      // 4. Create workflow context
      const workflowContext: WorkflowContext = {
        templateId: template_id,
        workflowId: workflow_id,
        currentStepId: step_id,
        currentToolId: tool_id
      }
      
      // 5. Execute tool with workflow context
      Logger.info(`⚡ Executing tool ${toolConfig.type} with input:`, input)
      const toolResult = await toolImplementation.execute(
        input,
        toolConfig.config || {},
        workflowContext
      )
      
      // 6. Process tool result and determine next actions
      const result = await this.processToolResult(step_id, tool_id, toolResult, workflow_id, input)
      
      Logger.info(`✅ Step execution completed for step ${step_id} with status: ${toolResult.status}`)
      return result
      
    } catch (error) {
      Logger.error(error, `❌ Step execution failed for step ${step_id}`)
      await this.updateStepStatus(step_id, WorkflowStatus.FAILED)
      
      return this.createErrorResult(
        step_id, 
        tool_id, 
        error instanceof Error ? error.message : "Unknown execution error"
      )
    }
  }

  // Fetch tool configuration from database
  private async getToolConfiguration(toolId: string) {
    try {
      const [tool] = await db
        .select()
        .from(workflowTool)
        .where(eq(workflowTool.id, toolId))
        .limit(1)

      return tool
    } catch (error) {
      Logger.error(error, `Failed to fetch tool configuration for ${toolId}`)
      return null
    }
  }


  // Update step execution status in database
  private async updateStepStatus(stepId: string, status: WorkflowStatus) {
    try {
      await db
        .update(workflowStepExecution)
        .set({
          status,
          updatedAt: new Date(),
        })
        .where(eq(workflowStepExecution.id, stepId))
        
      Logger.info(`📊 Updated step ${stepId} status to ${status}`)
    } catch (error) {
      Logger.error(error, `Failed to update step ${stepId} status to ${status}`)
    }
  }

  // Process tool execution result and determine next actions
  private async processToolResult(
    stepId: string, 
    toolId: string, 
    toolResult: ToolExecutionResult,
    workflowId: string,
    input: Record<string, any>
  ): Promise<StepExecutionResult> {
    
    let nextAction: 'continue' | 'halt' | 'wait_for_input' = 'halt'
    let stepStatus: WorkflowStatus = WorkflowStatus.FAILED

    // Determine next action based on tool result status
    switch (toolResult.status) {
      case 'success':
        nextAction = 'continue'
        stepStatus = WorkflowStatus.COMPLETED
        break
        
      case 'partial_success':
        nextAction = 'continue'
        stepStatus = WorkflowStatus.COMPLETED
        break
        
      case 'awaiting_user_input':
        nextAction = 'wait_for_input' 
        stepStatus = WorkflowStatus.WAITING        
        break
        
      case 'error':
        nextAction = 'halt'
        stepStatus = WorkflowStatus.FAILED
        break
    }

    const toolExecutionId = await this.createToolExecution(toolId, workflowId, input, toolResult)
    // Update step
    await this.updateStep(stepId, toolExecutionId,stepStatus)
    
    // Process metadata to extract scheduling information
    let nextExecuteAt: string | undefined
    if (toolResult.metadata && toolResult.metadata.trigger_after) {
      nextExecuteAt = toolResult.metadata.trigger_after
      Logger.info(`📅 Step ${stepId} scheduled for execution at: ${nextExecuteAt}`)
    }
    
    return {
      success: toolResult.status === 'success' || toolResult.status === 'partial_success',
      stepId,
      toolId,
      toolResult,
      nextAction,
      next_execute_at: nextExecuteAt,
    }
  }


  // Create tool execution record for awaiting user input
  private async createToolExecution(
    toolId: string, 
    workflowId: string, 
    input: Record<string, any>, 
    toolResult: ToolExecutionResult
  ): Promise<string> {
    try {
      const [toolExec] = await db
        .insert(toolExecution)
        .values({
          workflowToolId: toolId,
          workflowExecutionId: workflowId,
          status: ToolExecutionStatus.PENDING,
          input: input,
          result: toolResult.result,
          startedAt: new Date(),
        })
        .returning()

      Logger.info(`✨ Created tool execution ${toolExec.id} for tool ${toolId} (awaiting user input)`)
      return toolExec.id
    } catch (error) {
      Logger.error(error, `Failed to create tool execution for tool ${toolId}`)
      throw error
    }
  }

  // Update step with tool execution ID
  private async updateStep(stepId: string, toolExecutionId: string, status: WorkflowStatus) {
    try {
      await db
        .update(workflowStepExecution)
        .set({
          toolExecIds: sql`array_append(${workflowStepExecution.toolExecIds}, ${toolExecutionId})`,
          updatedAt: new Date(),
          status: status
        })
        .where(eq(workflowStepExecution.id, stepId))
        
      Logger.info(`🔗 Updated step ${stepId} with tool execution ${toolExecutionId}`)
    } catch (error) {
      Logger.error(error, `Failed to update step ${stepId} with tool execution ${toolExecutionId}`)
    }
  }

  // Helper to create error result
  private createErrorResult(stepId: string, toolId: string, error: string): StepExecutionResult {
    return {
      success: false,
      stepId,
      toolId,
      toolResult: {
        status: 'error',
        result: {},
      },
      nextAction: 'halt',
      error,
    }
  }
}

// Export singleton instance
export const stepExecutor = new StepExecutor()