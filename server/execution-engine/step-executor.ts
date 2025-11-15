import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { db } from "@/db/client"
import { workflowTool, workflowStepExecution, toolExecution, WorkflowStatus, ToolExecutionStatus } from "@/db/schema/workflows"
import { eq, sql, inArray } from "drizzle-orm"
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
      
      // 3. Handle multi-input logic before execution
      const multiInputResult = await this.handleMultiInputLogic(packet)
      if (!multiInputResult.shouldExecute) {
        // Return waiting state for partial input collection
        return {
          success: false,
          stepId: step_id,
          toolId: tool_id,
          toolResult: {
            status: ToolExecutionStatus.PENDING,
            output: {},
          },
          nextAction: 'wait_for_input',
        }
      }
      
      // 4. Update step status to running
      // await this.updateStepStatus(step_id, WorkflowStatus.ACTIVE, packet.previous_tool_id)
      
      // 5. Create workflow context
      const workflowContext: WorkflowContext = {
        templateId: template_id,
        workflowId: workflow_id,
        currentStepId: step_id,
        currentToolId: tool_id
      }
      
      // 6. Execute tool with workflow context (use combined input if available)
      const finalInput = multiInputResult.combinedInput || input
      Logger.info(`⚡ Executing tool ${toolConfig.type} with input:`, finalInput)
      const toolResult = await toolImplementation.execute(
        finalInput,
        toolConfig.config || {},
        workflowContext
      )
      
      // 7. Process tool result and determine next actions
      const result = await this.processToolResult(step_id, tool_id, toolResult, workflow_id, finalInput)
      
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
  private async updateStepStatus(stepId: string, status: WorkflowStatus, previousToolId?: string): Promise<void> {
    try {
      // If status is ACTIVE, we need to increment stepExecutedCount in metadata
      if (status === WorkflowStatus.ACTIVE) {
        // First, get the current step to read existing metadata
        const [currentStep] = await db
          .select({
            metadata: workflowStepExecution.metadata
          })
          .from(workflowStepExecution)
          .where(eq(workflowStepExecution.id, stepId))
          .limit(1)

        // Extract current metadata and increment stepExecutedCount
        const currentMetadata = (currentStep?.metadata as any) || {}
        const stepExecutedCount = (currentMetadata.stepExecutedCount || 0) + 1
        const inputToolIds = (currentMetadata.inputToolIds as Record<string, string[]>) || {}
        
        // If previousToolId is provided, add it to inputToolIds with current count
        if (previousToolId) {
          const countKey = stepExecutedCount.toString()
          if (!inputToolIds[countKey]) {
            inputToolIds[countKey] = []
          }
          inputToolIds[countKey].push(previousToolId)
        }
        const updatedMetadata = {
          ...currentMetadata,
          stepExecutedCount: stepExecutedCount,
          inputToolIds
        }


        // Update with new metadata and status
        await db
          .update(workflowStepExecution)
          .set({
            status,
            metadata: updatedMetadata,
            updatedAt: new Date(),
          })
          .where(eq(workflowStepExecution.id, stepId))
          
        Logger.info(`📊 Updated step ${stepId} status to ${status} with stepExecutedCount: ${stepExecutedCount}`)
      } else {
        // For other statuses, just update status normally
        await db
          .update(workflowStepExecution)
          .set({
            status,
            updatedAt: new Date(),
          })
          .where(eq(workflowStepExecution.id, stepId))
          
        Logger.info(`📊 Updated step ${stepId} status to ${status}`)
      }
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
      case ToolExecutionStatus.COMPLETED:
        nextAction = 'continue'
        stepStatus = WorkflowStatus.COMPLETED
        break
        
      case ToolExecutionStatus.RUNNING:
        nextAction = 'continue'
        stepStatus = WorkflowStatus.COMPLETED
        break
        
      case ToolExecutionStatus.AWAITING_USER_INPUT:
        nextAction = 'wait_for_input' 
        stepStatus = WorkflowStatus.WAITING        
        break
        
      case ToolExecutionStatus.FAILED:
        nextAction = 'halt'
        stepStatus = WorkflowStatus.FAILED
        break
    }

    // Create tool execution and update step in a single transaction
    const toolExectionId = await this.createToolExecutionAndUpdateStep(stepId, toolId, workflowId, input, toolResult, stepStatus)
    
    // Process metadata to extract scheduling information
    let nextExecuteAt: string | undefined
    if (toolResult.metadata && toolResult.metadata.trigger_after) {
      nextExecuteAt = toolResult.metadata.trigger_after
      Logger.info(`📅 Step ${stepId} scheduled for execution at: ${nextExecuteAt}`)
    }
    
    return {
      success: toolResult.status === ToolExecutionStatus.COMPLETED,
      stepId,
      toolId: toolExectionId,
      toolResult,
      nextAction,
      next_execute_at: nextExecuteAt,
    }
  }


  // Create tool execution and update step in a single transaction
  private async createToolExecutionAndUpdateStep(
    stepId: string,
    toolId: string, 
    workflowId: string, 
    input: Record<string, any>, 
    toolResult: ToolExecutionResult,
    stepStatus: WorkflowStatus
  ): Promise<string> {
    return await db.transaction(async (tx) => {
      try {
        // 1. Get current step metadata to extract stepExecutedCount
        const [currentStep] = await tx
          .select({
            metadata: workflowStepExecution.metadata
          })
          .from(workflowStepExecution)
          .where(eq(workflowStepExecution.id, stepId))
          .limit(1)

        const stepExecutedCount = ((currentStep?.metadata as any)?.stepExecutedCount || 0)

        // 2. Create tool execution with stepExecutionNumber from metadata
        const [toolExec] = await tx
          .insert(toolExecution)
          .values({
            workflowToolId: toolId,
            workflowExecutionId: workflowId,
            status: toolResult.status,
            input: input,
            result: toolResult.output,
            startedAt: new Date(),
          })
          .returning()

        const currentStepMetadata = currentStep?.metadata as Record<string,any> || {}
        const outputToolIds = (currentStepMetadata.outputToolIds as Record<string, string>) || {}
        const countKey = stepExecutedCount.toString()
        // if (!outputToolIds[countKey]) {
        //   outputToolIds[countKey] = []
        // }
        outputToolIds[countKey]=toolExec.id
        const updatedStepMetadata = {
          ...currentStepMetadata,
          outputToolIds
        }
        
        // 3. Update step with tool execution ID and status
        await tx
          .update(workflowStepExecution)
          .set({
            toolExecIds: sql`array_append(${workflowStepExecution.toolExecIds}, ${toolExec.id})`,
            updatedAt: new Date(),
            status: stepStatus,
            metadata: updatedStepMetadata
          })
          .where(eq(workflowStepExecution.id, stepId))

        Logger.info(`✨ Created tool execution ${toolExec.id} for tool ${toolId} with stepExecutionNumber: ${stepExecutedCount}`)
        Logger.info(`🔗 Updated step ${stepId} with tool execution ${toolExec.id} and status ${stepStatus}`)
        
        return toolExec.id
      } catch (error) {
        Logger.error(error, `Failed to create tool execution and update step for tool ${toolId}`)
        throw error
      }
    })
  }

  // Handle multi-input logic for steps that require multiple inputs
  private async handleMultiInputLogic(packet: ExecutionPacket): Promise<{
    shouldExecute: boolean,
    combinedInput?: Record<string, any>
  }> {
    const { step_id, previous_step_id, previous_tool_id } = packet
    
    return await db.transaction(async (tx) => {
      try {
        // Get current step with metadata
        const [currentStep] = await tx
          .select()
          .from(workflowStepExecution)
          .where(eq(workflowStepExecution.id, step_id))
          .limit(1)

        if (!currentStep) {
          Logger.error(`Step ${step_id} not found`)
          throw new Error(`Step ${step_id} not found`)
        }
        
        // fetch tool with packet.tool_id
        const [tool] = await tx
          .select()
          .from(workflowTool)
          .where(eq(workflowTool.id, packet.tool_id))
          .limit(1)

        if (!tool) {
          Logger.error(`Tool ${packet.tool_id} not found`)
          throw new Error(`Tool ${packet.tool_id} not found`)
        }

        const currentMetadata = (currentStep.metadata as any) || {}
        const inputCount = (tool.config as Record<string,any>).inputCount || 1

        // If step only requires single input, proceed normally
        if (inputCount <= 1) {
          Logger.info(`📌 Step ${step_id} requires single input, proceeding with execution`)
          const stepExecutedCount = (currentMetadata.stepExecutedCount || 0) + 1
          const inputToolIds = (currentMetadata.inputToolIds as Record<string, string[]>) || {}
          
          // If previousToolId is provided, add it to inputToolIds with current count
          if (packet.previous_tool_id) {
            const countKey = stepExecutedCount.toString()
            if (!inputToolIds[countKey]) {
              inputToolIds[countKey] = []
            }
            inputToolIds[countKey].push(packet.previous_tool_id)
          }
          const updatedMetadata = {
            ...currentMetadata,
            stepExecutedCount: stepExecutedCount,
            inputToolIds
          }


          // Update with new metadata and status
          await db
            .update(workflowStepExecution)
            .set({
              status: WorkflowStatus.ACTIVE,
              metadata: updatedMetadata,
              updatedAt: new Date(),
            })
            .where(eq(workflowStepExecution.id, step_id))

          Logger.info(`📊 Updated step ${step_id} status to ${WorkflowStatus.ACTIVE} with stepExecutedCount: ${stepExecutedCount}`)
          return { shouldExecute: true }
        }

        Logger.info(`📋 Step ${step_id} requires ${inputCount} inputs, current status: ${currentStep.status}`)

        // If step is DRAFT, collect partial input and set to WAITING
        if (currentStep.status === WorkflowStatus.DRAFT) {
          if (!previous_step_id || !previous_tool_id) {
            Logger.error(`Missing previous step or tool ID for step ${step_id}`)
            throw new Error(`Missing previous step or tool ID for step ${step_id}`)
          }

          // Get route information from inRoutes
          const inRoutes = currentMetadata.inRoutes || {}
          let currentRoute: string | null = null
          
          // Find which route this input belongs to
          for (const [routeKey, stepIds] of Object.entries(inRoutes)) {
            if (Array.isArray(stepIds) && stepIds.includes(previous_step_id)) {
              currentRoute = routeKey
              break
            }
          }

          if (!currentRoute) {
            Logger.error(`Could not find route for previous step ${previous_step_id}`)
            throw new Error(`Could not find route for previous step ${previous_step_id}`)
          }

          // Store partial input
          const partialInputs = currentMetadata.partialInputs || {}
          partialInputs[currentRoute] = previous_tool_id

          //update stepExecutedCount and inputToolIds
          const stepExecutedCount = (currentMetadata.stepExecutedCount || 0) + 1
          const inputToolIds = (currentMetadata.inputToolIds as Record<string, string[]>) || {}
          if (packet.previous_tool_id) {
            const countKey = stepExecutedCount.toString()
            if (!inputToolIds[countKey]) {
              inputToolIds[countKey] = []
            }
            inputToolIds[countKey].push(packet.previous_tool_id)
          }

          const updatedMetadata = {
            ...currentMetadata,
            partialInputs,
            stepExecutedCount: stepExecutedCount,
            inputToolIds
          }

          // Update step metadata and set status to WAITING
          await tx
            .update(workflowStepExecution)
            .set({
              metadata: updatedMetadata,
              status: WorkflowStatus.WAITING,
              updatedAt: new Date()
            })
            .where(eq(workflowStepExecution.id, step_id))

          Logger.info(`🔄 Step ${step_id} updated to WAITING, stored partial input for route ${currentRoute}`)
          return { shouldExecute: false }
        }

        // If step is WAITING, check if all required inputs are collected
        if (currentStep.status === WorkflowStatus.WAITING) {
          if (!previous_step_id || !previous_tool_id) {
            Logger.error(`Missing previous step or tool ID for waiting step ${step_id}`)
            throw new Error(`Missing previous step or tool ID for waiting step ${step_id}`)
          }

          // Get route information
          const inRoutes = currentMetadata.inRoutes || {}
          const partialInputs = currentMetadata.partialInputs || {}
          let currentRoute: string | null = null
          
          // Find which route this input belongs to
          for (const [routeKey, stepIds] of Object.entries(inRoutes)) {
            if (Array.isArray(stepIds) && stepIds.includes(previous_step_id)) {
              currentRoute = routeKey
              break
            }
          }

          if (!currentRoute) {
            Logger.error(`Could not find route for previous step ${previous_step_id}`)
            throw new Error(`Could not find route for previous step ${previous_step_id}`)
          }

          // Update partial inputs with new tool ID
          partialInputs[currentRoute] = previous_tool_id

          //update inputToolIds
          const stepExecutedCount = (currentMetadata.stepExecutedCount || 0)
          const inputToolIds = (currentMetadata.inputToolIds as Record<string, string[]>) || {}
          if (packet.previous_tool_id) {
            const countKey = stepExecutedCount.toString()
            if (!inputToolIds[countKey]) {
              inputToolIds[countKey] = []
            }
            inputToolIds[countKey].push(packet.previous_tool_id)
          }
          // Check if we have all required inputs
          const requiredRoutes = Object.keys(inRoutes)
          const collectedRoutes = Object.keys(partialInputs)
          const hasAllInputs = requiredRoutes.every(route => collectedRoutes.includes(route))

          const updatedMetadata = {
            ...currentMetadata,
            partialInputs,
            inputToolIds
          }
          

          if (!hasAllInputs) {
            // Still waiting for more inputs
            await tx
              .update(workflowStepExecution)
              .set({
                metadata: updatedMetadata,
                updatedAt: new Date()
              })
              .where(eq(workflowStepExecution.id, step_id))
            Logger.info(`⏳ Step ${step_id} still waiting, collected ${collectedRoutes.length}/${requiredRoutes.length} inputs`)
            return { shouldExecute: false }
          }else{
            await tx
            .update(workflowStepExecution)
            .set({
              status: WorkflowStatus.ACTIVE,
              metadata: updatedMetadata,
              updatedAt: new Date()
            })
            .where(eq(workflowStepExecution.id, step_id))
          }

          // All inputs collected, fetch tool execution results and combine them
          const combinedInput: Record<string, any> = {}
          const toolExecutionIds = Object.values(partialInputs) as string[]
          
          // Fetch all tool executions in a single query
          const toolExecutions = await tx
            .select()
            .from(toolExecution)
            .where(inArray(toolExecution.id, toolExecutionIds))

          // Create a map for faster lookup
          const toolExecMap = new Map(toolExecutions.map(te => [te.id, te]))
          
          for (const [route, toolExecutionId] of Object.entries(partialInputs)) {
            const toolExec = toolExecMap.get(toolExecutionId as string)
            
            if (toolExec && toolExec.result) {
              combinedInput[route] = toolExec.result
            } else {
              Logger.warn(`Could not find tool execution result for ${toolExecutionId}`)
              combinedInput[route] = {}
            }
          }

          Logger.info(`🎯 Step ${step_id} has all inputs, proceeding with combined input:`, combinedInput)
          return { 
            shouldExecute: true,
            combinedInput
          }
        }

        // Default case - if we reach here, something is wrong
        Logger.error(`Unexpected step status for step ${step_id}: ${currentStep.status}`)
        throw new Error(`Unexpected step status for step ${step_id}: ${currentStep.status}`)
        
      } catch (error) {
        Logger.error(error, `Failed to handle multi-input logic for step ${step_id}`)
        throw error // Re-throw to trigger transaction rollback
      }
    }).catch((error) => {
      Logger.error(error, `Transaction failed for multi-input logic on step ${step_id}`)
      throw error // Re-throw to fail execution
    })
  }

  // Helper to create error result
  private createErrorResult(stepId: string, toolId: string, error: string): StepExecutionResult {
    return {
      success: false,
      stepId,
      toolId,
      toolResult: {
        status: ToolExecutionStatus.FAILED,
        output: {},
      },
      nextAction: 'halt',
      error,
    }
  }
}

// Export singleton instance
export const stepExecutor = new StepExecutor()