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
      .where(and(eq(workflowStepTemplate.workflowTemplateId, templateId),eq(workflowStepTemplate.deprecated, false)))

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
          metadata: {"stepExecutedCount":0,"inputToolIds":{},"outputToolIds":{}},
        })
        .returning()
        .then(([stepExec]) => {
          stepExecutions.set(templateStep.id, stepExec.id)
        })
    }
    

    // Update step executions with relationships and metadata mapping
    for (const [templateStepId, stepExecId] of stepExecutions) {
      const templateStep = templateStepMaps.get(templateStepId)
      if (!templateStep) continue

      // Get previous step execution IDs
      const prevStepExecIds: string[] = []
      if (templateStep.prevStepIds && templateStep.prevStepIds.length > 0) {
        for (const prevTemplateId of templateStep.prevStepIds) {
          const prevStepExecId = stepExecutions.get(prevTemplateId)
          if (prevStepExecId) {
            prevStepExecIds.push(prevStepExecId)
          }
        }
      }

      // Get next step execution IDs
      const nextStepExecIds: string[] = []
      if (templateStep.nextStepIds && templateStep.nextStepIds.length > 0) {
        for (const nextTemplateId of templateStep.nextStepIds) {
          const nextStepExecId = stepExecutions.get(nextTemplateId)
          if (nextStepExecId) {
            nextStepExecIds.push(nextStepExecId)
          }
        }
      }

      // Process metadata to replace template IDs with step execution IDs
      let updatedMetadata = { ...templateStep.metadata }
      
      // Handle outRoutes mapping: out<num>:templateIds[] -> out<num>:stepExecIds[]
      if (templateStep.metadata?.outRoutes) {
        const updatedOutRoutes: Record<string, string[]> = {}
        for (const [routeKey, templateIds] of Object.entries(templateStep.metadata.outRoutes)) {
          const templateIdArray = Array.isArray(templateIds) ? templateIds : [templateIds as string]
          const targetStepExecIds: string[] = []
          
          for (const templateId of templateIdArray) {
            const targetStepExecId = stepExecutions.get(templateId)
            if (targetStepExecId) {
              targetStepExecIds.push(targetStepExecId)
            }
          }
          
          if (targetStepExecIds.length > 0) {
            updatedOutRoutes[routeKey] = targetStepExecIds
          }
        }
        updatedMetadata.outRoutes = updatedOutRoutes
      }

      // Handle inRoutes mapping: in<num>:templateIds[] -> in<num>:stepExecIds[]
      if (templateStep.metadata?.inRoutes) {
        const updatedInRoutes: Record<string, string[]> = {}
        for (const [routeKey, templateIds] of Object.entries(templateStep.metadata.inRoutes)) {
          const templateIdArray = Array.isArray(templateIds) ? templateIds : [templateIds as string]
          const sourceStepExecIds: string[] = []
          
          for (const templateId of templateIdArray) {
            const sourceStepExecId = stepExecutions.get(templateId)
            if (sourceStepExecId) {
              sourceStepExecIds.push(sourceStepExecId)
            }
          }
          
          if (sourceStepExecIds.length > 0) {
            updatedInRoutes[routeKey] = sourceStepExecIds
          }
        }
        updatedMetadata.inRoutes = updatedInRoutes
      }

      // Add step execution count
      updatedMetadata.stepExecutedCount = 0

      // Update the step execution with relationships and metadata
      await db
        .update(workflowStepExecution)
        .set({
          prevStepIds: prevStepExecIds,
          nextStepIds: nextStepExecIds,
          metadata: updatedMetadata,
        })
        .where(eq(workflowStepExecution.id, stepExecId))
    }

    return stepExecutions
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