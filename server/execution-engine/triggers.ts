import { type Context } from "hono"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { db } from "@/db/client"
import { workflowStepExecution, toolExecution, WorkflowStatus, ToolExecutionStatus, workflowStepTemplate, workflowTool, type SelectWorkflowTemplate } from "@/db/schema/workflows"
import { eq, and, or, sql } from "drizzle-orm"
import { queueNextSteps, executionBoss } from "./execution-engine-queue"
import type { ExecutionPacket } from "./types"
import { getTool, type WorkflowTool } from "@/workflow-tools/registry"
import { TemplateState, ToolCategory, ToolType } from "@/types/workflowTypes"

const Logger = getLogger(Subsystem.ExecutionEngine)

/**
 * Manual trigger handler for workflows
 * Route: POST /workflow/:workflowId/manual-trigger/:stepId
 */
export const handleManualTrigger = async (c: Context) => {
  const { workflowId, stepId } = c.req.param()
  
  try {
    Logger.info(`🔴 Manual trigger requested for workflow ${workflowId}, step ${stepId}`)

    // 1. Find the step and validate it's waiting for user input
    const [step] = await db
      .select()
      .from(workflowStepExecution)
      .where(
        and(
          eq(workflowStepExecution.id, stepId),
          eq(workflowStepExecution.workflowExecutionId, workflowId),
          eq(workflowStepExecution.status, WorkflowStatus.WAITING)
        )
      )
      .limit(1)

    if (!step) {
      Logger.warn(`Step ${stepId} not found or not waiting for input`)
      return c.json({
        error: "Step not found or not waiting for user input"
      }, 404)
    }

    // 2. Find the tool execution that's pending for this step
    const [toolExec] = await db
      .select()
      .from(toolExecution)
      .where(
        and(
          eq(toolExecution.workflowExecutionId, workflowId),
          eq(toolExecution.status, ToolExecutionStatus.AWAITING_USER_INPUT)
        )
      )
      .limit(1)

    if (!toolExec) {
      Logger.warn(`No pending tool execution found for step ${stepId}`)
      return c.json({
        error: "No pending tool execution found"
      }, 404)
    }

    // 3. Mark the tool execution as completed
    await db
      .update(toolExecution)
      .set({
        status: ToolExecutionStatus.COMPLETED,
        completedAt: new Date(),
        result: {
          triggeredAt: new Date().toISOString(),
          triggeredBy: "manual", // TODO: Get from request body
          triggerReason: "Manual trigger activated"
        }
      })
      .where(eq(toolExecution.id, toolExec.id))

    // 4. Mark the step as completed
    await db
      .update(workflowStepExecution)
      .set({
        status: WorkflowStatus.COMPLETED,
        completedAt: new Date(),
        completedBy: "manual" // TODO: Get from request body
      })
      .where(eq(workflowStepExecution.id, stepId))

    // 5. Create execution packet for queuing next steps
    const currentPacket: ExecutionPacket = {
      template_id: step.workflowStepTemplateId, // Using template ID from step
      workflow_id: workflowId,
      step_id: stepId,
      input: toolExec.result || {}
    }

    // Create mock result for queueNextSteps
    const mockResult = {
      success: true,
      stepId: stepId,
      // toolId: toolExec.workflowToolId,
      toolResult: {
        status: ToolExecutionStatus.COMPLETED,
        output: toolExec.result || {}
      },
      nextAction: 'continue' as const
    }

    // 6. Queue next steps
    await queueNextSteps(currentPacket, mockResult)

    Logger.info(`✅ Manual trigger completed for step ${stepId}`)

    return c.json({
      success: true,
      message: "Manual trigger completed successfully",
      stepId: stepId,
      workflowId: workflowId
    })

  } catch (error) {
    Logger.error(error, `❌ Manual trigger failed for workflow ${workflowId}, step ${stepId}`)
    
    return c.json({
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error"
    }, 500)
  }
}


export const handleTemplateStateChange = async (template: SelectWorkflowTemplate, state: TemplateState) => {
  try {
    Logger.info(`🎯 handling state change in workflow template ${template.id}`)

    // Find trigger steps in the template
    const triggerSteps = await db
      .select()
      .from(workflowStepTemplate)
      .where(
        and(
          eq(workflowStepTemplate.workflowTemplateId, template.id),
          eq(workflowStepTemplate.toolCategory, ToolCategory.TRIGGER),
        )
      )

    if (triggerSteps.length === 0) {
      Logger.warn(`No root steps found for template ${template.id}`)
      return {
        success: false,
        message: "No root steps found in template"
      }
    }

    Logger.info(`Found ${triggerSteps.length} root step(s) for template ${template.id}`)

    const stateChangeTriggerResults = []

    // Process each trigger step to check for trigger tools
    for (const triggerStep of triggerSteps) {
          if (!triggerStep.toolConfig) {
            Logger.warn(`Tool config of ${triggerStep.id} not found`)
            continue
          }

          // Get tool implementation
          const toolImplementation = getTool(triggerStep.toolType as ToolType)
          switch (triggerStep.toolType) {
            case ToolType.SCHEDULER_TRIGGER:
              Logger.info(`📅 Processing scheduler trigger for tool ${triggerStep.id}`)
              const result = await callStateImplementation(state, toolImplementation, triggerStep.toolConfig || {}, template)
              stateChangeTriggerResults.push({
                toolType: ToolType.SCHEDULER_TRIGGER,
                scheduled: true,
                message: result.message
              })
              break

            default:
              Logger.info(`Tool type ${triggerStep.toolType} ${state} method not implemented yet`)
              stateChangeTriggerResults.push({
                toolType: triggerStep.toolType,
                scheduled: false,
                error: `Tool type ${triggerStep.toolType} ${state} method not implemented`
              })
              break
          }
        // }
      }

    Logger.info(`🎯 Template activation completed for ${template.id}`)

    return {
      success: true,
      templateId: template.id,
      rootStepIds: triggerSteps.map(step => step.id),
      stateChangeTriggerResults,
      message: `Processed ${stateChangeTriggerResults.length} trigger tool(s) across ${triggerSteps.length} root step(s)`
    }

  } catch (error) {
    Logger.error(error, `Failed to ${state} template ${template.id}`)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

const callStateImplementation = (state: TemplateState, toolImplementation: WorkflowTool, config: Record<string, any>, template:SelectWorkflowTemplate) => {
  switch (state) {
    case TemplateState.ACTIVE:
      if (toolImplementation.handleActiveTrigger) {
        return toolImplementation.handleActiveTrigger(config, template)
      } else {
        return {"message":'Tool does not support handleActiveTrigger method'}
      }
    case TemplateState.INACTIVE:
      if (toolImplementation.handleInactiveTrigger) {
        return toolImplementation.handleInactiveTrigger(config, template)
      } else {
        return {"message":'Tool does not support handleInactiveTrigger method'}
      }
  }
}