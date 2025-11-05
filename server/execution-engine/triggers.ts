import { type Context } from "hono"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { db } from "@/db/client"
import { workflowStepExecution, toolExecution, WorkflowStatus, ToolExecutionStatus, workflowStepTemplate, workflowTool, type SelectWorkflowTemplate } from "@/db/schema/workflows"
import { eq, and, or, sql } from "drizzle-orm"
import { queueNextSteps, executionBoss } from "./execution-engine-queue"
import type { ExecutionPacket } from "./types"
import { getTool } from "@/workflow-tools/registry"
import { ToolType } from "@/types/workflowTypes"

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
          eq(toolExecution.status, ToolExecutionStatus.PENDING)
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
      tool_id: toolExec.workflowToolId,
      input: toolExec.input || {}
    }

    // Create mock result for queueNextSteps
    const mockResult = {
      success: true,
      stepId: stepId,
      toolId: toolExec.workflowToolId,
      toolResult: {
        status: 'success' as const,
        result: toolExec.result || {}
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

/**
 * Activate workflow template - check root nodes for triggers and schedule them
 */
export const handleActivateTemplate = async (template: SelectWorkflowTemplate) => {
  try {
    Logger.info(`🎯 Activating workflow template ${template.id}`)

    // if (!template.rootWorkflowStepTemplateId) {
    //   Logger.warn(`No root step found for template ${template.id}`)
    //   return {
    //     success: false,
    //     message: "No root step found in template"
    //   }
    // }

    // Check if template has a root step

    // Get the root step template
    // const [rootStep] = await db
    //   .select()
    //   .from(workflowStepTemplate)
    //   .where(eq(workflowStepTemplate.id, template.rootWorkflowStepTemplateId))
    //   .limit(1)

    // if (!rootStep) {
    //   Logger.warn(`Root step ${template.rootWorkflowStepTemplateId} not found`)
    //   return {
    //     success: false,
    //     message: "Root step not found"
    //   }
    // }

    // Find root nodes (steps with no previous IDs or empty previous IDs array)
    const rootSteps = await db
      .select()
      .from(workflowStepTemplate)
      .where(
        and(
          eq(workflowStepTemplate.workflowTemplateId, template.id),
          or(
            sql`${workflowStepTemplate.prevStepIds} IS NULL`,
            sql`array_length(${workflowStepTemplate.prevStepIds}, 1) IS NULL`
          )
        )
      )

    if (rootSteps.length === 0) {
      Logger.warn(`No root steps found for template ${template.id}`)
      return {
        success: false,
        message: "No root steps found in template"
      }
    }

    Logger.info(`Found ${rootSteps.length} root step(s) for template ${template.id}`)

    const schedulingResults = []

    // Process each root step to check for trigger tools
    for (const rootStep of rootSteps) {
      const rootToolIds = rootStep.toolIds || []
      if (rootToolIds.length === 0) {
        Logger.warn(`No tools found in root step ${rootStep.id}`)
        continue
      }
        // Check each tool in this root step
        for (const toolId of rootToolIds) {
          const [toolConfig] = await db
            .select()
            .from(workflowTool)
            .where(eq(workflowTool.id, toolId))
            .limit(1)

          if (!toolConfig) {
            Logger.warn(`Tool ${toolId} not found`)
            continue
          }

          // Get tool implementation to check triggerIfActive
          const toolImplementation = getTool(toolConfig.type as any)
          
          if (!toolImplementation.triggerIfActive) {
            Logger.info(`Tool ${toolConfig.type} does not trigger when active, skipping`)
            continue
          }

          // Switch case for tool types
          switch (toolConfig.type) {
            case ToolType.SCHEDULER_TRIGGER:
              Logger.info(`📅 Processing scheduler trigger for tool ${toolId}`)
              
              // Check if the tool has handleActiveTrigger method
              if (toolImplementation.handleActiveTrigger) {
                const result = await toolImplementation.handleActiveTrigger(toolConfig.config || {}, template.id)
                
                schedulingResults.push({
                  toolId,
                  toolType: ToolType.SCHEDULER_TRIGGER,
                  scheduled: true,
                  message: result.message
                })
              } else {
                Logger.warn(`Scheduler trigger tool ${toolId} does not support activation`)
                schedulingResults.push({
                  toolId,
                  toolType: ToolType.SCHEDULER_TRIGGER,
                  scheduled: false,
                  error: 'Tool does not support handleActiveTrigger method'
                })
              }
              break

            default:
              Logger.info(`Tool type ${toolConfig.type} activation not implemented yet`)
              schedulingResults.push({
                toolId,
                toolType: toolConfig.type,
                scheduled: false,
                error: 'Tool type activation not implemented'
              })
              break
          }
        }
      }

    Logger.info(`🎯 Template activation completed for ${template.id}`)

    return {
      success: true,
      templateId: template.id,
      rootStepIds: rootSteps.map(step => step.id),
      schedulingResults,
      message: `Processed ${schedulingResults.length} trigger tool(s) across ${rootSteps.length} root step(s)`
    }

  } catch (error) {
    Logger.error(error, `Failed to activate template ${template.id}`)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}