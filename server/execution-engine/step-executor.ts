import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { db } from "@/db/client"
import { workflowTool, workflowStepExecution, toolExecution, WorkflowStatus, ToolExecutionStatus, type SelectWorkflowStepExecution, ToolType } from "@/db/schema/workflows"
import { eq, sql, inArray } from "drizzle-orm"
import { getTool } from "@/workflow-tools/registry"
import type { ToolExecutionResult, WorkflowContext } from "@/workflow-tools/types"
import type { ExecutionPacket, StepExecutionResult } from "./types"

const Logger = getLogger(Subsystem.ExecutionEngine)


export class StepExecutor {
  
  // Main method to execute a workflow step
  async executeStep(packet: ExecutionPacket): Promise<StepExecutionResult> {
    const { workflow_id, step_id, input, template_id } = packet
    
    try {
      Logger.info(`🚀 Starting step execution for step ${step_id}`)

      // 1.  Handle multi-input logic before execution
      const multiInputResult = await this.handleMultiInputLogic(packet)
      if (!multiInputResult.shouldExecute) {
        // Return waiting state for partial input collection
        return {
          success: false,
          stepId: step_id,
          toolResult: {
            status: ToolExecutionStatus.PENDING,
            output: {},
          },
          nextAction: 'wait_for_input',
        }
      }

      const currentStep = multiInputResult.currentStep
      
      // 5. Create workflow context
      const workflowContext: WorkflowContext = {
        templateId: template_id,
        workflowId: workflow_id,
        currentStepId: step_id,
      }
      
      // 6. Execute tool with workflow context (use combined input if available)
      const finalInput = multiInputResult.combinedInput || input
      const toolImplementation = getTool(currentStep.toolType as ToolType)
      Logger.info(`⚡ Executing tool ${currentStep.toolType} with input:`, finalInput)
      const toolResult = await toolImplementation.execute(
        finalInput,
        currentStep.toolConfig as Record<string, any> || {},
        workflowContext
      )
      
      // 7. Process tool result and determine next actions
      const result = await this.processToolResult(step_id, toolResult, workflow_id, finalInput)
      
      Logger.info(`✅ Step execution completed for step ${step_id} with status: ${toolResult.status}`)
      return result
      
    } catch (error) {
      Logger.error(error, `❌ Step execution failed for step ${step_id}`)
      await this.updateFailedStepStatus(step_id)
      
      return this.createErrorResult(
        step_id, 
        error instanceof Error ? error.message : "Unknown execution error"
      )
    }
  }

  // Update step execution status in database
  private async updateFailedStepStatus(stepId: string): Promise<void> {
    try {
        await db
          .update(workflowStepExecution)
          .set({
            status: WorkflowStatus.FAILED,
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
    const toolExectionId = await this.createToolExecutionAndUpdateStep(stepId, workflowId, input, toolResult, stepStatus)
    
    // Process scheduling information from nextExecuteAfter field
    let nextExecuteAt: string | undefined
    if (toolResult.nextExecuteAfter && typeof toolResult.nextExecuteAfter === 'number' && toolResult.nextExecuteAfter > 0) {
      const currentTime = new Date()
      const nextExecutionTime = new Date(currentTime.getTime() + toolResult.nextExecuteAfter * 1000)
      nextExecuteAt = nextExecutionTime.toISOString()
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
            metadata: workflowStepExecution.metadata,
            toolType: workflowStepExecution.toolType
          })
          .from(workflowStepExecution)
          .where(eq(workflowStepExecution.id, stepId))
          .limit(1)

        const stepExecutedCount = ((currentStep?.metadata as any)?.stepExecutedCount || 0)

        // 2. Create tool execution with stepExecutionNumber from metadata
        const [toolExec] = await tx
          .insert(toolExecution)
          .values({
            workflowExecutionId: workflowId,
            status: toolResult.status,
            result: toolResult.output,
            startedAt: new Date(),
          })
          .returning()

        const currentStepMetadata = currentStep?.metadata as Record<string,any> || {}
        const outputToolIds = (currentStepMetadata.outputToolIds as Record<string, string>) || {}
        const countKey = stepExecutedCount.toString()

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

        Logger.info(`✨ Created tool execution ${toolExec.id} for tool ${currentStep.toolType} with stepExecutionNumber: ${stepExecutedCount}`)
        Logger.info(`🔗 Updated step ${stepId} with tool execution ${toolExec.id} and status ${stepStatus}`)
        
        return toolExec.id
      } catch (error) {
        Logger.error(error, `Failed to create tool execution and update stepId ${stepId}`)
        throw error
      }
    })
  }


  // Handle multi-input logic for steps that require multiple inputs
  private async handleMultiInputLogic(packet: ExecutionPacket): Promise<{
    shouldExecute: boolean,
    combinedInput?: Record<string, any>,
    currentStep: SelectWorkflowStepExecution,
    }> {
    const { step_id, previous_step_id, previous_tool_id } = packet
    
    return await db.transaction(async (tx) => {
      try {
        // Get current step with metadata
        const [currentStep] = await tx
          .select()
          .from(workflowStepExecution)
          .where(eq(workflowStepExecution.id, step_id))
          .for("update")
          .limit(1)

        if (!currentStep) {
          Logger.error(`Step ${step_id} not found`)
          throw new Error(`Step ${step_id} not found`)
        }

        const currentMetadata = (currentStep.metadata as any) || {}
        const inputCount = (currentStep.toolConfig as Record<string,any>).inputCount || 1

        // If step only requires single input, proceed normally
        if (inputCount <= 1) {
          Logger.info(`📌 Step ${step_id} requires single input, proceeding with execution`)
          const stepExecutedCount = (currentMetadata.stepExecutedCount || 0) + 1
          const countKey = stepExecutedCount.toString()
          
          // Prepare atomic updates
          const newInputToolIds = packet.previous_tool_id ? { [countKey]: [packet.previous_tool_id] } : {}

          // Update with new metadata and status atomically
          const [updatedStep] = await tx
            .update(workflowStepExecution)
            .set({
              status: WorkflowStatus.ACTIVE,
              metadata: sql`
                COALESCE(metadata, '{}') || jsonb_build_object(
                  'stepExecutedCount', ${stepExecutedCount}::integer,
                  'inputToolIds', COALESCE(metadata->'inputToolIds', '{}') || ${JSON.stringify(newInputToolIds)}::jsonb
                )
              `,
              updatedAt: new Date(),
            })
            .where(eq(workflowStepExecution.id, step_id))
            .returning()

          Logger.info(`📊 Updated step ${step_id} status to ${WorkflowStatus.ACTIVE} with stepExecutedCount: ${stepExecutedCount} (atomic merge)`)
          return { shouldExecute: true , currentStep: updatedStep as SelectWorkflowStepExecution}
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

          // Calculate new stepExecutedCount
          const stepExecutedCount = (currentMetadata.stepExecutedCount || 0) + 1
          const countKey = stepExecutedCount.toString()

          // Prepare atomic updates using PostgreSQL JSON operators
          const newPartialInput = { [currentRoute]: previous_tool_id }
          const newInputToolIds = packet.previous_tool_id ? { [countKey]: [packet.previous_tool_id] } : {}

          // Update step metadata atomically using JSON merge
          await tx
            .update(workflowStepExecution)
            .set({
              metadata: sql`
                COALESCE(metadata, '{}') || jsonb_build_object(
                  'partialInputs', COALESCE(metadata->'partialInputs', '{}') || ${JSON.stringify(newPartialInput)}::jsonb,
                  'stepExecutedCount', ${stepExecutedCount}::integer,
                  'inputToolIds', COALESCE(metadata->'inputToolIds', '{}') || ${JSON.stringify(newInputToolIds)}::jsonb
                )
              `,
              status: WorkflowStatus.WAITING,
              updatedAt: new Date()
            })
            .where(eq(workflowStepExecution.id, step_id))

          Logger.info(`🔄 Step ${step_id} updated to WAITING, stored partial input for route ${currentRoute} (atomic merge)`)
          return { shouldExecute: false, currentStep: currentStep as SelectWorkflowStepExecution}
        }

        // If step is WAITING, check if all required inputs are collected
        if (currentStep.status === WorkflowStatus.WAITING) {
          if (!previous_step_id || !previous_tool_id) {
            Logger.error(`Missing previous step or tool ID for waiting step ${step_id}`)
            throw new Error(`Missing previous step or tool ID for waiting step ${step_id}`)
          }

          // Get route information
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

          // Prepare atomic updates
          const stepExecutedCount = (currentMetadata.stepExecutedCount || 0)
          const countKey = stepExecutedCount.toString()
          const newPartialInput = { [currentRoute]: previous_tool_id }
          const newInputToolIds = packet.previous_tool_id ? { [countKey]: [packet.previous_tool_id] } : {}

          // First, atomically update the partial inputs
          await tx
            .update(workflowStepExecution)
            .set({
              metadata: sql`
                COALESCE(metadata, '{}') || jsonb_build_object(
                  'partialInputs', COALESCE(metadata->'partialInputs', '{}') || ${JSON.stringify(newPartialInput)}::jsonb,
                  'inputToolIds', COALESCE(metadata->'inputToolIds', '{}') || ${JSON.stringify(newInputToolIds)}::jsonb
                )
              `,
              updatedAt: new Date()
            })
            .where(eq(workflowStepExecution.id, step_id))

          // Re-read the step to get updated partialInputs for checking completion
          const [updatedCurrentStep] = await tx
            .select()
            .from(workflowStepExecution)
            .where(eq(workflowStepExecution.id, step_id))
            .limit(1)

          const updatedMetadata = (updatedCurrentStep!.metadata as any) || {}
          const updatedPartialInputs = updatedMetadata.partialInputs || {}

          // Check if we have all required inputs
          const requiredRoutes = Object.keys(inRoutes)
          const collectedRoutes = Object.keys(updatedPartialInputs)
          const hasAllInputs = requiredRoutes.every(route => collectedRoutes.includes(route))

          if (!hasAllInputs) {
            // Still waiting for more inputs
            Logger.info(`⏳ Step ${step_id} still waiting, collected ${collectedRoutes.length}/${requiredRoutes.length} inputs (atomic merge)`)
            return { shouldExecute: false , currentStep: updatedCurrentStep as SelectWorkflowStepExecution}
          }

          // All inputs collected, update status to ACTIVE
          const [updatedStep] = await tx
          .update(workflowStepExecution)
          .set({
            status: WorkflowStatus.ACTIVE,
            updatedAt: new Date()
          })
          .where(eq(workflowStepExecution.id, step_id))
          .returning()
          

          // All inputs collected, fetch tool execution results and combine them
          const combinedInput: Record<string, any> = {}
          const toolExecutionIds = Object.values(updatedPartialInputs) as string[]
          
          // Fetch all tool executions in a single query
          const toolExecutions = await tx
            .select()
            .from(toolExecution)
            .where(inArray(toolExecution.id, toolExecutionIds))

          // Create a map for faster lookup
          const toolExecMap = new Map(toolExecutions.map(te => [te.id, te]))
          
          for (const [route, toolExecutionId] of Object.entries(updatedPartialInputs)) {
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
            combinedInput,
            currentStep: updatedStep as SelectWorkflowStepExecution
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
  private createErrorResult(stepId: string, error: string): StepExecutionResult {
    return {
      success: false,
      stepId,
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