import { db } from "@/db/client"
import { 
  workflowTemplate, 
  workflowExecution, 
  workflowStepExecution, 
  workflowStepTemplate,
} from "@/db/schema/workflows"
import { eq, and } from "drizzle-orm"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { WorkflowStatus } from "@/types/workflowTypes"
import { executeWorkflowChain } from "@/api/workflow"
import { getWorkflowToolsByIds } from "@/db/workflowTool"

const Logger = getLogger(Subsystem.Slack)

export interface SlackTriggerExecutionContext {
  workflowTemplateId: string
  triggerData: {
    command: string
    data: string
    slackUser: string
    slackChannel: string
    slackChannelId: string
    userId: number
    userEmail: string
    workspaceId: number
    isDM: boolean
    timestamp: string
  }
  userId: number
  workspaceId: number
}

export interface WorkflowExecutionResult {
  executionId: string
  totalSteps: number
  completedSteps: number
  status: string
}

/**
 * Executes a workflow triggered from Slack
 */
export async function executeWorkflowWithSlackTrigger(context: SlackTriggerExecutionContext): Promise<WorkflowExecutionResult> {
  try {
    Logger.info({
      workflowTemplateId: context.workflowTemplateId,
      userId: context.userId,
      slackCommand: context.triggerData.command
    }, "🚀 Starting Slack-triggered workflow execution")

    // Get workflow template
    const [template] = await db
      .select()
      .from(workflowTemplate)
      .where(and(
        eq(workflowTemplate.id, context.workflowTemplateId),
        eq(workflowTemplate.workspaceId, context.workspaceId)
      ))

    if (!template) {
      throw new Error(`Workflow template ${context.workflowTemplateId} not found`)
    }

    // Create workflow execution
    const [execution] = await db
      .insert(workflowExecution)
      .values({
        workflowTemplateId: template.id,
        name: `${template.name} - Slack: ${context.triggerData.command}`,
        description: `Triggered by Slack command ${context.triggerData.command}`,
        status: WorkflowStatus.ACTIVE,
        userId: context.userId,
        workspaceId: context.workspaceId,
        metadata: {
          triggerType: 'slack_trigger',
          slackTrigger: context.triggerData,
          triggeredAt: new Date().toISOString(),
        }
      })
      .returning()

    Logger.info({
      executionId: execution.id,
      templateName: template.name
    }, "✅ Workflow execution created")

    // Get workflow steps
    const steps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, context.workflowTemplateId))

    // Create step executions
    const stepExecutionsData = steps.map((step) => ({
      workflowExecutionId: execution.id,
      workflowStepTemplateId: step.id,
      name: step.name,
      type: step.type,
      status: WorkflowStatus.DRAFT,
      parentStepId: step.parentStepId,
      prevStepIds: step.prevStepIds || [],
      nextStepIds: step.nextStepIds || [],
      toolExecIds: [],
      timeEstimate: step.timeEstimate,
      metadata: {
        ...((step.metadata as Record<string, any>) || {}),
        triggeredBySlack: true,
        slackCommand: context.triggerData.command,
      },
    }))

    const stepExecutions = await db
      .insert(workflowStepExecution)
      .values(stepExecutionsData)
      .returning()

    // Find root step execution
    const rootStepExecution = stepExecutions.find(
      (se) => se.workflowStepTemplateId === template.rootWorkflowStepTemplateId,
    )

    if (!rootStepExecution) {
      throw new Error("Failed to create root step execution")
    }

    // Update workflow with root step execution ID
    await db
      .update(workflowExecution)
      .set({ rootWorkflowStepExeId: rootStepExecution.id })
      .where(eq(workflowExecution.id, execution.id))

    // Get all tools for the workflow using the existing helper
    const allToolIds = steps.flatMap((step) => step.toolIds as string[] || [])
    const allTools = allToolIds.length > 0 ? await getWorkflowToolsByIds(db, allToolIds) : []

    // Execute the workflow chain using the existing function from workflow.ts
    const executionResults = await executeWorkflowChain(
      execution.id,
      rootStepExecution.id,
      allTools,
      {
        [rootStepExecution.name || "Slack Trigger"]: {
          stepId: rootStepExecution.id,
          result: {
            triggerData: context.triggerData,
            slackUser: context.triggerData.slackUser,
            slackChannel: context.triggerData.slackChannel,
            command: context.triggerData.command,
            data: context.triggerData.data,
            timestamp: context.triggerData.timestamp,
            message: `Slack trigger activated: ${context.triggerData.command}`,
          },
          status: 'success',
          toolType: 'slack_trigger'
        }
      }
    )

    // Get final status
    const finalStepExecutions = await db
      .select()
      .from(workflowStepExecution)
      .where(eq(workflowStepExecution.workflowExecutionId, execution.id))

    const completedSteps = finalStepExecutions.filter(se => se.status === WorkflowStatus.COMPLETED).length
    const totalSteps = finalStepExecutions.length

    // Mark workflow as completed if all steps are done
    if (completedSteps === totalSteps) {
      await db
        .update(workflowExecution)
        .set({
          status: WorkflowStatus.COMPLETED,
          completedAt: new Date(),
          completedBy: "slack-trigger",
        })
        .where(eq(workflowExecution.id, execution.id))
    }

    Logger.info({
      executionId: execution.id,
      completedSteps,
      totalSteps
    }, "🎉 Workflow execution completed")

    return {
      executionId: execution.id,
      totalSteps,
      completedSteps,
      status: completedSteps === totalSteps ? 'completed' : 'active'
    }

  } catch (error) {
    Logger.error(error, "❌ Failed to execute Slack-triggered workflow")
    throw error
  }
}

