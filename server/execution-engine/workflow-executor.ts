import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { db } from "@/db/client"
import {
  workflowTemplate,
  workflowStepTemplate,
  workflowExecution,
  workflowStepExecution,
  WorkflowStatus,
} from "@/db/schema/workflows"
import { eq, and, sql } from "drizzle-orm"
import { sendExecutionPacket } from "./execution-engine-queue"
import type { ExecutionPacket } from "./types"
import { workflowTool, ToolCategory } from "@/db/schema/workflows"

const Logger = getLogger(Subsystem.WorkflowApi)

export class WorkflowExecutor {
  
  // Main function to start execution of a template
  async executeTemplate(templateId: string, userId: number, workspaceId: number): Promise<string> {
    let executionId: string | null = null
    
    try {
      Logger.info(`Starting execution for template ${templateId}`)

      // 1. Verify template exists and user has access
      const template = await this.getTemplate(templateId, workspaceId)
      if (!template) {
        throw new Error(`Template ${templateId} not found or access denied`)
      }
      
      // Validate template has valid trigger root nodes and get them
      const rootNodes = await this.validateRootNodeTriggers(templateId)
      
      // 2. Create workflow execution
      executionId = await this.createWorkflowExecution(template, userId, workspaceId)

      // 3. Create step executions for all template steps
      const stepExecutions = await this.createStepExecutions(templateId, executionId)
      
      // 4. Push root nodes to queue
      await this.pushRootNodesToQueue(rootNodes, stepExecutions, executionId)

      Logger.info(`Successfully started execution ${executionId} for template ${templateId}`)
      return executionId

    } catch (error) {
      Logger.error(error, `Failed to execute template ${templateId}`)
      
      // If workflow execution was created, mark it as failed
      if (executionId) {
        try {
          await db
            .update(workflowExecution)
            .set({
              status: WorkflowStatus.FAILED,
              updatedAt: new Date(),
            })
            .where(eq(workflowExecution.id, executionId))
          
          Logger.info(`Marked workflow execution ${executionId} as failed`)
        } catch (updateError) {
          Logger.error(updateError, `Failed to update workflow execution ${executionId} status to failed`)
        }
      }
      
      throw error
    }
  }

  // Get template with access validation
  private async getTemplate(templateId: string, workspaceId: number) {
    const [template] = await db
      .select()
      .from(workflowTemplate)
      .where(
        and(
          eq(workflowTemplate.id, templateId),
          eq(workflowTemplate.workspaceId, workspaceId)
        )
      )

    return template
  }

  // Create workflow execution record
  private async createWorkflowExecution(template: any, userId: number, workspaceId: number): Promise<string> {
    const [execution] = await db
      .insert(workflowExecution)
      .values({
        name: `${template.name} - ${new Date().toISOString()}`,
        description: template.description,
        workflowTemplateId: template.id,
        userId,
        workspaceId,
        status: WorkflowStatus.ACTIVE,
        createdAt: new Date(),
        metadata: {},
      })
      .returning()

    return execution.id
  }


  // Create step execution records for all template steps using graph analysis
  private async createStepExecutions(templateId: string, executionId: string) {
    // Get all template steps
    const templateSteps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, templateId))

    const visited = new Set<string>()
    const stepExecutions = new Map<string, string>()
    
    const rootSteps = templateSteps.filter(step => 
      !step.prevStepIds || step.prevStepIds.length === 0
    )

    const templateStepMaps = new Map<string, any>()
    for(const templateStep of templateSteps) {
      templateStepMaps.set(templateStep.id, templateStep)
    }

    for (const templateStep of templateSteps) {
      await db
        .insert(workflowStepExecution)
        .values({
          name: templateStep.name,
          type: templateStep.type,
          workflowExecutionId: executionId,
          workflowStepTemplateId: templateStep.id,
          status: WorkflowStatus.DRAFT,
          prevStepIds: [],
          nextStepIds: [],
          toolExecIds: [],
          createdAt: new Date(),
          metadata: {},
        })
        .returning()
        .then(([stepExec]) => {
          stepExecutions.set(templateStep.id, stepExec.id)
        })
    }
    
    //traverse the graph to set prev/next step execution IDs
    for(const rootStep of rootSteps) {
      // const stepExecId = stepExecutions.get(rootStep.id)
      // createEdgesOfStepExecution(stepExecId)
      await this.traverseGraphAndCreateExecutionEdges(rootStep,templateStepMaps, stepExecutions, visited, db)
    }

    return stepExecutions
  }


  private async traverseGraphAndCreateExecutionEdges(rootStep: any, templateStepMaps: Map<string, any>, stepExecutions: Map<string, string>, visited: Set<string>, db: any) {
    // Implementation for traversing the graph and creating execution edges
    const stack = [rootStep]
    
    while (stack.length > 0) {
      const currentStep = stack.pop()
      if (!currentStep || visited.has(currentStep.id)) {
        continue
      }
      visited.add(currentStep.id)

      // Create execution edges for the current step
      const stepExecId = stepExecutions.get(currentStep.id)
      // if (stepExecId) {
      //   createEdgesOfStepExecution(stepExecId)
      // }

      // Get next steps from the templateStepMaps
      const nextTemplateSteps: string[] = templateStepMaps.get(currentStep.id)?.nextStepIds || []
      
      for (const nextTemplateStepId of nextTemplateSteps) {
        //get the exec step and create edges
        const nextStepExecId = stepExecutions.get(nextTemplateStepId)
        if (stepExecId && nextStepExecId) {
          //create edges between stepExecId and nextStepExecId
          
          // Update current step's nextStepIds array
          await db
            .update(workflowStepExecution)
            .set({
              nextStepIds: sql`array_append(${workflowStepExecution.nextStepIds}, ${nextStepExecId})`,
              updatedAt: new Date(),
            })
            .where(eq(workflowStepExecution.id, stepExecId))

          // Update next step's prevStepIds array  
          await db
            .update(workflowStepExecution)
            .set({
              prevStepIds: sql`array_append(${workflowStepExecution.prevStepIds}, ${stepExecId})`,
              updatedAt: new Date(),
            })
            .where(eq(workflowStepExecution.id, nextStepExecId))
        }

        // Push the next template step onto the stack for further traversal
        const nextTemplateStep = templateStepMaps.get(nextTemplateStepId)
        if (nextTemplateStep && !visited.has(nextTemplateStep.id)) {
          stack.push(nextTemplateStep)
        }
      }
    }
  }


  // Push root nodes to execution queue
  private async pushRootNodesToQueue(rootNodes: Awaited<ReturnType<typeof this.validateRootNodeTriggers>>, stepExecutions: Map<string,string>, executionId: string): Promise<void> {
    Logger.info(`Pushing ${rootNodes.length} root nodes to execution queue`)

    for (const rootNode of rootNodes) {
      // Find the corresponding step execution for this root node
      const stepExec = stepExecutions.get(rootNode.id)
      
      if (!stepExec) {
        Logger.error(`No step execution found for root node ${rootNode.id}`)
        continue
      }

      // Queue each tool in the root node
      for (const toolId of rootNode.toolIds || []) {
        const packet: ExecutionPacket = {
          template_id: rootNode.workflowTemplateId,
          workflow_id: executionId,
          step_id: stepExec,
          tool_id: toolId,
          input: {}, // Default empty input for trigger tools
        }

        try {
          const jobId = await sendExecutionPacket(packet)
          Logger.info(`✓ Root step '${rootNode.name}' queued with job ID: ${jobId}`)
        } catch (error) {
          Logger.error(error, `Failed to queue root step '${rootNode.name}'`)
          
          // Mark step as failed
          await db
            .update(workflowStepExecution)
            .set({
              status: WorkflowStatus.FAILED,
              updatedAt: new Date(),
            })
            .where(eq(workflowStepExecution.id, stepExec))
          
          throw error
        }
      }
    }

    Logger.info(`✓ All ${rootNodes.length} root nodes queued successfully`)
  }

  // Get execution status
  async getExecutionStatus(executionId: string): Promise<any> {
    const [execution] = await db
      .select()
      .from(workflowExecution)
      .where(eq(workflowExecution.id, executionId))

    if (!execution) {
      throw new Error(`Execution ${executionId} not found`)
    }

    const stepExecutions = await db
      .select()
      .from(workflowStepExecution)
      .where(eq(workflowStepExecution.workflowExecutionId, executionId))

    return {
      execution,
      steps: stepExecutions,
    }
  }

  // Find and validate that root nodes are trigger tools
  private async validateRootNodeTriggers(templateId: string) {
    // Get all template steps
    const templateSteps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, templateId))

    // Find root nodes (steps with no incoming connections - empty or null prevStepIds)
    const rootSteps = templateSteps.filter(step => 
      !step.prevStepIds || step.prevStepIds.length === 0
    )

    if (rootSteps.length === 0) {
      throw new Error(`Template ${templateId} has no root nodes`)
    }

    Logger.info(`Found ${rootSteps.length} root nodes in template ${templateId}`)

    // Validate each root step has trigger tools
    for (const rootStep of rootSteps) {
      if (!rootStep.toolIds || rootStep.toolIds.length === 0) {
        throw new Error(`Root step '${rootStep.name}' (${rootStep.id}) has no tools configured`)
      }

      // Check each tool in the root step
      for (const toolId of rootStep.toolIds) {
        const [tool] = await db
          .select()
          .from(workflowTool)
          .where(eq(workflowTool.id, toolId))

        if (!tool) {
          throw new Error(`Tool ${toolId} not found for root step '${rootStep.name}'`)
        }

        if (tool.category !== ToolCategory.TRIGGER) {
          throw new Error(
            `Root step '${rootStep.name}' contains non-trigger tool '${tool.type}' (category: ${tool.category}). Root steps must only contain trigger tools.`
          )
        }

        Logger.info(`✓ Root step '${rootStep.name}' has valid trigger tool: ${tool.type}`)
      }
    }

    Logger.info(`✓ All ${rootSteps.length} root nodes validated as triggers`)
    
    return rootSteps
  }
}

// Export singleton instance
export const workflowExecutor = new WorkflowExecutor()