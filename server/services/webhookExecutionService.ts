import { db } from "@/db/client"
import { 
  workflowTemplate, 
  workflowExecution, 
  workflowStepExecution, 
  workflowStepTemplate,
  toolExecution,
  workflowTool
} from "@/db/schema/workflows"
import { eq, and } from "drizzle-orm"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { WorkflowStatus, ToolExecutionStatus, StepType } from "@/types/workflowTypes"

const Logger = getLogger(Subsystem.WorkflowApi)

export interface WebhookExecutionContext {
  workflowTemplateId: string
  webhookPath: string
  requestData: any
  executionId?: string
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
      const template = await this.getWorkflowTemplate(context.workflowTemplateId)
      if (!template) {
        throw new Error(`Workflow template ${context.workflowTemplateId} not found`)
      }

      // Create workflow execution
      const execution = await this.createWorkflowExecution(template, context)

      // Get workflow steps
      const steps = await this.getWorkflowSteps(context.workflowTemplateId)

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

  private async getWorkflowTemplate(templateId: string) {
    const [template] = await db
      .select()
      .from(workflowTemplate)
      .where(eq(workflowTemplate.id, templateId))
      .limit(1)

    return template
  }

  private async createWorkflowExecution(template: any, context: WebhookExecutionContext) {
    const [execution] = await db
      .insert(workflowExecution)
      .values({
        workflowTemplateId: template.id,
        name: `Webhook: ${context.webhookPath} - ${new Date().toISOString()}`,
        description: `Triggered by webhook: ${context.webhookPath}`,
        status: WorkflowStatus.ACTIVE,
        metadata: {
          triggerType: 'webhook',
          webhookPath: context.webhookPath,
          requestData: context.requestData,
          triggeredAt: new Date().toISOString()
        }
      })
      .returning()

    return execution
  }

  private async getWorkflowSteps(templateId: string) {
    const steps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, templateId))

    return steps
  }

  private async createStepExecutions(executionId: string, steps: any[], context: WebhookExecutionContext) {
    for (const step of steps) {
      try {
        // Create step execution
        const [stepExecution] = await db
          .insert(workflowStepExecution)
          .values({
            workflowExecutionId: executionId,
            workflowStepTemplateId: step.id,
            name: step.name,
            type: step.type,
            status: step.type === StepType.AUTOMATED ? WorkflowStatus.ACTIVE : WorkflowStatus.DRAFT,
            parentStepId: step.parentStepId,
            prevStepIds: step.prevStepIds,
            nextStepIds: step.nextStepIds,
            timeEstimate: step.timeEstimate,
            metadata: {
              ...step.metadata,
              webhookData: context.requestData,
              stepOrder: steps.indexOf(step)
            }
          })
          .returning()

        // Create tool executions for this step
        if (step.toolIds && step.toolIds.length > 0) {
          await this.createToolExecutions(stepExecution.id, step.toolIds, context)
        }

      } catch (error) {
        Logger.error(`Failed to create step execution for step ${step.id}: ${error}`)
      }
    }
  }

  private async createToolExecutions(stepExecutionId: string, toolIds: string[], context: WebhookExecutionContext) {
    for (const toolId of toolIds) {
      try {
        // Get tool details
        const [tool] = await db
          .select()
          .from(workflowTool)
          .where(eq(workflowTool.id, toolId))
          .limit(1)

        if (tool) {
          await db
            .insert(toolExecution)
            .values({
              workflowToolId: toolId,
              workflowExecutionId: stepExecutionId,
              status: ToolExecutionStatus.PENDING,
              result: {
                webhookData: context.requestData,
                queuedAt: new Date().toISOString()
              }
            })
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

      // TODO: Trigger actual workflow processing
      // This would typically integrate with your workflow engine
      Logger.info(`Workflow execution ${executionId} started and ready for processing`)

    } catch (error) {
      Logger.error(`Failed to start workflow execution ${executionId}: ${error}`)
      throw error
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