import { db } from "@/db/client"
import { 
  workflowTemplate, 
  workflowExecution, 
  workflowStepExecution, 
  workflowStepTemplate,
  toolExecution,
  workflowTool
} from "@/db/schema/workflows"
import { eq, sql, and, inArray } from "drizzle-orm"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { WorkflowStatus, ToolExecutionStatus, StepType } from "@/types/workflowTypes"
import { getWorkflowStepTemplatesByTemplateId, getWorkflowTemplateByIdWithPermissionCheck } from "@/db/workflow"

const Logger = getLogger(Subsystem.WorkflowApi)

export interface WebhookExecutionContext {
  workflowTemplateId: string
  webhookPath: string
  requestData: any
  executionId?: string
  userId: number
  workspaceId: number
}

export class WebhookExecutionService {
  private static instance: WebhookExecutionService

  static getInstance(): WebhookExecutionService {
    if (!WebhookExecutionService.instance) {
      WebhookExecutionService.instance = new WebhookExecutionService()
    }
    return WebhookExecutionService.instance
  }

  async executeWorkflowFromWebhook(context: WebhookExecutionContext): Promise<string> {
    try {
      // Get workflow template
      const template = await getWorkflowTemplateByIdWithPermissionCheck(
        db,
        context.workflowTemplateId,
        context.workspaceId,
        context.userId
      )
      if (!template) {
        throw new Error(`Workflow template ${context.workflowTemplateId} not found`)
      }

      // Create workflow execution
      const execution = await this.createWorkflowExecution(template, context)

      // Get workflow steps
      const steps = await getWorkflowStepTemplatesByTemplateId(db, context.workflowTemplateId)

      // Create step executions
      await this.createStepExecutions(execution.id, steps, context)

      // Start execution
      await this.startWorkflowExecution(execution.id)

      Logger.info(`Started workflow execution ${execution.id} from webhook ${context.webhookPath}`)
      return execution.id

    } catch (error) {
      Logger.error(`Failed to execute workflow from webhook: ${error}`)
      throw error
    }
  }

  private async createWorkflowExecution(template: any, context: WebhookExecutionContext) {
    const [execution] = await db
      .insert(workflowExecution)
      .values({
        workflowTemplateId: template.id,
        name: `Webhook: ${context.webhookPath} - ${new Date().toISOString()}`,
        description: `Triggered by webhook: ${context.webhookPath}`,
        status: WorkflowStatus.ACTIVE,
        userId: context.userId,
        workspaceId: context.workspaceId,
        metadata: {
          triggerType: 'webhook',
          webhookPath: context.webhookPath,
          requestData: context.requestData,
          triggeredAt: new Date().toISOString(),
          // Structure webhook data for easy access in workflow tools
          webhook: {
            method: context.requestData.method || 'POST',
            path: context.requestData.path || context.webhookPath,
            url: context.requestData.url || `http://localhost:3000${context.webhookPath}`,
            headers: context.requestData.headers || {},
            query: context.requestData.query || {},
            body: context.requestData.body || {},
            timestamp: context.requestData.timestamp || new Date().toISOString(),
            requestData: context.requestData
          }
        }
      })
      .returning()

    return execution
  }

  // Utility function to sort steps based on their dependencies (prevStepIds/nextStepIds)
  private topologicalSortSteps(steps: any[]): any[] {
    // Create a map for quick lookup
    const stepMap = new Map(steps.map(step => [step.id, step]))
    const sorted: any[] = []
    const visiting = new Set<string>()
    const visited = new Set<string>()
    
    const visit = (stepId: string) => {
      if (visited.has(stepId)) return
      if (visiting.has(stepId)) {
        // Circular dependency detected, skip for now
        return
      }
      
      visiting.add(stepId)
      const step = stepMap.get(stepId)
      if (step) {
        // Visit all prerequisites first (prevStepIds)
        if (step.prevStepIds && Array.isArray(step.prevStepIds)) {
          for (const prevId of step.prevStepIds) {
            if (stepMap.has(prevId)) {
              visit(prevId)
            }
          }
        }
        
        visiting.delete(stepId)
        visited.add(stepId)
        sorted.push(step)
      }
    }
    
    // Find root steps (steps with no prevStepIds or empty prevStepIds)
    const rootSteps = steps.filter(step => 
      !step.prevStepIds || step.prevStepIds.length === 0
    )
    
    // Start with root steps
    for (const rootStep of rootSteps) {
      visit(rootStep.id)
    }
    
    // Visit any remaining unvisited steps (in case of isolated components)
    for (const step of steps) {
      if (!visited.has(step.id)) {
        visit(step.id)
      }
    }
    
    return sorted
  }

  private async createStepExecutions(executionId: string, steps: any[], context: WebhookExecutionContext) {
    Logger.info(`📋 Creating ${steps.length} step executions for workflow:`, steps.map(s => ({
      id: s.id,
      name: s.name,
      type: s.type,
      nextStepIds: s.nextStepIds,
      toolIds: s.toolIds
    })))

    for (const step of steps) {
      try {
        // Determine if this is a webhook step
        const isWebhookStep = step.toolIds && step.toolIds.length > 0 && 
          await this.isWebhookTool(step.toolIds[0])

        // Create step execution
        const [stepExecution] = await db
          .insert(workflowStepExecution)
          .values({
            workflowExecutionId: executionId,
            workflowStepTemplateId: step.id,
            name: step.name,
            type: step.type,
            // Mark webhook steps as completed immediately, others as active
            status: isWebhookStep ? WorkflowStatus.COMPLETED : WorkflowStatus.ACTIVE,
            parentStepId: step.parentStepId,
            prevStepIds: step.prevStepIds,
            nextStepIds: step.nextStepIds,
            timeEstimate: step.timeEstimate,
            completedAt: isWebhookStep ? new Date() : null,
            completedBy: isWebhookStep ? "webhook-trigger" : null,
            metadata: {
              ...step.metadata,
              webhookData: context.requestData,
              stepOrder: steps.indexOf(step),
              triggeredByWebhook: isWebhookStep
            }
          })
          .returning()

        Logger.info(`✅ Created step execution: ${stepExecution.name} (${stepExecution.id}) - Status: ${stepExecution.status}, Type: ${stepExecution.type}, IsWebhook: ${isWebhookStep}`)

        // Create tool executions for this step
        if (step.toolIds && step.toolIds.length > 0) {
          await this.createToolExecutions(stepExecution.id, step.toolIds, context, isWebhookStep)
        }

      } catch (error) {
        Logger.error(`Failed to create step execution for step ${step.id}: ${error}`)
      }
    }
  }

  // Helper method to check if a tool is a webhook tool
  private async isWebhookTool(toolId: string): Promise<boolean> {
    try {
      const [tool] = await db
        .select()
        .from(workflowTool)
        .where(eq(workflowTool.id, toolId))
        .limit(1)
      
      return tool?.type === 'webhook'
    } catch (error) {
      Logger.error(`Failed to check tool type for ${toolId}: ${error}`)
      return false
    }
  }

  // Helper method to format webhook content for AI analysis
  private formatWebhookContent(requestData: any, webhookPath: string): string {
    return `Webhook Request Analysis:

Method: ${requestData.method || 'POST'}
URL: ${requestData.url || `http://localhost:3000${webhookPath}`}
Path: ${requestData.path || webhookPath}
Timestamp: ${requestData.timestamp || new Date().toISOString()}

Headers:
${JSON.stringify(requestData.headers || {}, null, 2)}

Query Parameters:
${JSON.stringify(requestData.query || {}, null, 2)}

Request Body:
${JSON.stringify(requestData.body || {}, null, 2)}

cURL Command:
${this.generateCurlCommand({
  method: requestData.method || 'POST',
  url: requestData.url || `http://localhost:3000${webhookPath}`,
  headers: requestData.headers || {},
  body: requestData.body || {}
})}

Please analyze this webhook request and provide insights.`
  }

  // Helper method to generate cURL command from webhook data
  private generateCurlCommand(webhookData: {
    method: string
    url: string
    headers: Record<string, any>
    body: any
  }): string {
    try {
      let curl = `curl -X ${webhookData.method.toUpperCase()}`
      
      // Add headers
      Object.entries(webhookData.headers || {}).forEach(([key, value]) => {
        if (value) {
          curl += ` -H "${key}: ${value}"`
        }
      })
      
      // Add body for POST/PUT/PATCH requests
      if (webhookData.body && ["POST", "PUT", "PATCH"].includes(webhookData.method.toUpperCase())) {
        const bodyStr = typeof webhookData.body === 'string' 
          ? webhookData.body 
          : JSON.stringify(webhookData.body)
        curl += ` -d '${bodyStr}'`
      }
      
      // Add URL (should be last)
      curl += ` "${webhookData.url}"`
      
      return curl
    } catch (error) {
      return `curl -X ${webhookData.method.toUpperCase()} "${webhookData.url}"`
    }
  }

  private async createToolExecutions(stepExecutionId: string, toolIds: string[], context: WebhookExecutionContext, isWebhookStep: boolean = false) {
    for (const toolId of toolIds) {
      try {
        // Get tool details
        const [tool] = await db
          .select()
          .from(workflowTool)
          .where(eq(workflowTool.id, toolId))
          .limit(1)

        if (tool) {
          const isWebhookTool = tool.type === 'webhook'
          
          await db
            .insert(toolExecution)
            .values({
              workflowToolId: toolId,
              workflowExecutionId: stepExecutionId,
              // Mark webhook tools as completed immediately
              status: isWebhookTool ? ToolExecutionStatus.COMPLETED : ToolExecutionStatus.PENDING,
              startedAt: new Date(),
              completedAt: isWebhookTool ? new Date() : null,
              result: isWebhookTool ? {
                webhook: {
                  method: context.requestData.method || 'POST',
                  path: context.requestData.path || context.webhookPath,
                  url: context.requestData.url || `http://localhost:3000${context.webhookPath}`,
                  headers: context.requestData.headers || {},
                  query: context.requestData.query || {},
                  body: context.requestData.body || {},
                  timestamp: context.requestData.timestamp || new Date().toISOString(),
                  curl: this.generateCurlCommand({
                    method: context.requestData.method || 'POST',
                    url: context.requestData.url || `http://localhost:3000${context.webhookPath}`,
                    headers: context.requestData.headers || {},
                    body: context.requestData.body || {}
                  })
                },
                // Create formatted content for next steps
                aiOutput: this.formatWebhookContent(context.requestData, context.webhookPath),
                content: this.formatWebhookContent(context.requestData, context.webhookPath),
                output: this.formatWebhookContent(context.requestData, context.webhookPath),
                input: {
                  aiOutput: this.formatWebhookContent(context.requestData, context.webhookPath),
                  content: this.formatWebhookContent(context.requestData, context.webhookPath),
                  summary: `Webhook received: ${context.requestData.method || 'POST'} request to ${context.webhookPath}`,
                  data: context.requestData
                },
                data: context.requestData,
                status: 'success',
                message: 'Webhook received and processed successfully',
                triggeredAt: new Date().toISOString()
              } : {
                webhookData: context.requestData,
                queuedAt: new Date().toISOString()
              }
            })
            
          Logger.info(`📝 Created tool execution for ${tool.type} tool (${toolId}) - Status: ${isWebhookTool ? 'COMPLETED' : 'PENDING'}`)
        }
      } catch (error) {
        Logger.error(`Failed to create tool execution for tool ${toolId}: ${error}`)
      }
    }
  }

  private async startWorkflowExecution(executionId: string) {
    try {
      // Update execution status
      await db
        .update(workflowExecution)
        .set({
          status: WorkflowStatus.ACTIVE,
          updatedAt: new Date()
        })
        .where(eq(workflowExecution.id, executionId))

      // Get execution details to start the workflow chain
      const [execution] = await db
        .select()
        .from(workflowExecution)
        .where(eq(workflowExecution.id, executionId))
        .limit(1)

      if (!execution) {
        throw new Error(`Execution ${executionId} not found`)
      }

      // Get template to find root step
      const [template] = await db
        .select()
        .from(workflowTemplate)
        .where(eq(workflowTemplate.id, execution.workflowTemplateId))
        .limit(1)

      if (!template || !template.rootWorkflowStepTemplateId) {
        throw new Error(`Template not found or no root step configured`)
      }

      // Get step executions to find the root execution
      const stepExecutions = await db
        .select()
        .from(workflowStepExecution)
        .where(eq(workflowStepExecution.workflowExecutionId, executionId))

      Logger.info(`🔍 Found ${stepExecutions.length} step executions:`, stepExecutions.map(se => ({
        id: se.id,
        name: se.name,
        type: se.type,
        templateId: se.workflowStepTemplateId,
        status: se.status
      })))

      Logger.info(`🏠 Template root step ID: ${template.rootWorkflowStepTemplateId}`)

      const rootStepExecution = stepExecutions.find(
        (se) => se.workflowStepTemplateId === template.rootWorkflowStepTemplateId
      )

      if (!rootStepExecution) {
        Logger.error(`❌ Root step execution not found! Available step template IDs: ${stepExecutions.map(se => se.workflowStepTemplateId).join(', ')}`)
        throw new Error(`Root step execution not found`)
      }

      Logger.info(`🏁 Starting execution from root step: ${rootStepExecution.name} (${rootStepExecution.id})`)

      // Get tools for the workflow
      const tools = await this.getWorkflowTools(execution.workflowTemplateId)

      // For webhook-triggered workflows, execute the chain regardless of step type
      Logger.info(`Starting webhook-triggered workflow chain for execution ${executionId}`)
      
      // Import executeWorkflowChain dynamically to avoid circular imports
      const { executeWorkflowChain } = await import("../api/workflow")
      
      const executionResults = await executeWorkflowChain(
        executionId,
        rootStepExecution.id,
        tools,
        {}
      )

      Logger.info(`Webhook workflow chain completed for execution ${executionId}`, { results: executionResults })

    } catch (error) {
      Logger.error(`Failed to start workflow execution ${executionId}: ${error}`)
      throw error
    }
  }

  private async getWorkflowTools(templateId: string) {
    try {
      Logger.info(`🔧 getWorkflowTools for template: ${templateId}`)
      
      // Get template to get userId and workspaceId
      const [template] = await db
        .select()
        .from(workflowTemplate)
        .where(eq(workflowTemplate.id, templateId))
        .limit(1)

      if (!template) {
        Logger.error(`Template not found: ${templateId}`)
        return []
      }

      // Get all steps for the template
      const steps = await db
        .select()
        .from(workflowStepTemplate)
        .where(eq(workflowStepTemplate.workflowTemplateId, templateId))

      Logger.info(`📋 Found ${steps.length} step templates:`, steps.map(s => ({
        id: s.id,
        name: s.name,
        toolIds: s.toolIds
      })))

      // Get all tool IDs from steps
      const allToolIds: string[] = []
      steps.forEach(step => {
        if (step.toolIds && Array.isArray(step.toolIds)) {
          allToolIds.push(...step.toolIds)
        }
      })

      Logger.info(`🔨 Collected tool IDs:`, allToolIds)

      // Get all tools referenced by steps - fetch from same workspace/user as template
      if (allToolIds.length === 0) {
        Logger.warn(`No tool IDs found for template ${templateId}`)
        return []
      }

      const tools = await db
        .select()
        .from(workflowTool)
        .where(
          and(
            inArray(workflowTool.id, allToolIds),
            eq(workflowTool.workspaceId, template.workspaceId),
            eq(workflowTool.userId, template.userId)
          )
        )

      Logger.info(`🔨 Retrieved ${tools.length} tools for template ${templateId}:`, tools.map(t => ({
        id: t.id,
        type: t.type,
        workspaceId: t.workspaceId,
        userId: t.userId
      })))

      // If no tools found, log the mismatch for debugging
      if (tools.length === 0) {
        Logger.warn(`⚠️ No tools found for tool IDs: ${allToolIds.join(', ')} in workspace ${template.workspaceId} for user ${template.userId}`)
        
        // Check if tools exist in different workspace/user
        const allMatchingTools = await db
          .select()
          .from(workflowTool)
          .where(inArray(workflowTool.id, allToolIds))
        
        Logger.info(`🔍 Found ${allMatchingTools.length} matching tools in any workspace:`, allMatchingTools.map(t => ({
          id: t.id,
          type: t.type,
          workspaceId: t.workspaceId,
          userId: t.userId
        })))
      }

      return tools

    } catch (error) {
      Logger.error(`Failed to get workflow tools for template ${templateId}: ${error}`)
      return []
    }
  }

  async getExecutionStatus(executionId: string) {
    try {
      const [execution] = await db
        .select()
        .from(workflowExecution)
        .where(eq(workflowExecution.id, executionId))
        .limit(1)

      if (!execution) {
        throw new Error(`Execution ${executionId} not found`)
      }

      const steps = await db
        .select()
        .from(workflowStepExecution)
        .where(eq(workflowStepExecution.workflowExecutionId, executionId))

      return {
        execution,
        steps,
        status: execution.status,
        completedAt: execution.completedAt
      }

    } catch (error) {
      Logger.error(`Failed to get execution status for ${executionId}: ${error}`)
      throw error
    }
  }

  async completeExecution(executionId: string, result?: any) {
    try {
      await db
        .update(workflowExecution)
        .set({
          status: WorkflowStatus.COMPLETED,
          completedAt: new Date(),
          metadata: result ? { ...result, completedAt: new Date().toISOString() } : undefined,
          updatedAt: new Date()
        })
        .where(eq(workflowExecution.id, executionId))

      Logger.info(`Workflow execution ${executionId} completed`)

    } catch (error) {
      Logger.error(`Failed to complete execution ${executionId}: ${error}`)
      throw error
    }
  }

  async failExecution(executionId: string, error: any) {
    try {
      await db
        .update(workflowExecution)
        .set({
          status: WorkflowStatus.FAILED,
          metadata: { 
            error: error.toString(), 
            failedAt: new Date().toISOString() 
          },
          updatedAt: new Date()
        })
        .where(eq(workflowExecution.id, executionId))

      Logger.error(`Workflow execution ${executionId} failed: ${error}`)

    } catch (dbError) {
      Logger.error(`Failed to mark execution ${executionId} as failed: ${dbError}`)
      throw dbError
    }
  }
}

export default WebhookExecutionService.getInstance()