import { type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { getErrorMessage } from "@/utils"
import { getUserFromJWT } from "@/db/user"
import { db } from "@/db/client"
import { executionClient } from "@/execution-engine/execution-client"
import {
  workflowExecution,
  workflowStepExecution,
  workflowStepTemplate,
  workflowTemplate,
  workflowTool,
  toolExecution,
} from "@/db/schema/workflows"
import { eq, and } from "drizzle-orm"

const { JwtPayloadKey } = config
const Logger = getLogger(Subsystem.WorkflowApi)

// Execute workflow template by ID
export const ExecuteTemplateHandler = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const requestData = await c.req.json()
    const { templateId } = requestData

    if (!templateId) {
      throw new HTTPException(400, { message: "templateId is required in request body" })
    }

    // Start execution using the execution client - returns execution ID immediately
    const executionId = await executionClient.startExecution(templateId, user.id, user.workspaceId)

    return c.json({
      success: true,
      data: {
        executionId,
        templateId,
        status: "ACTIVE",
        message: "Execution started successfully",
      },
      message: "Workflow execution initiated",
    })
  } catch (error) {
    Logger.error(error, "Failed to execute workflow template")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Get execution status by ID
export const GetExecutionStatusApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey)) // Used for authentication, access control handled in execution engine
    const executionId = c.req.param("executionId")

    if (!executionId) {
      throw new HTTPException(400, { message: "executionId is required" })
    }

    // Get status from execution client (user access validation done in execution engine)
    const status = await executionClient.getExecutionStatus(executionId)

    return c.json({
      success: true,
      data: status,
      message: "Execution status retrieved successfully",
    })
  } catch (error) {
    Logger.error(error, "Failed to get execution status")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Stop execution by ID
export const StopExecutionApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey)) // Used for authentication, access control handled in execution engine
    const executionId = c.req.param("executionId")

    if (!executionId) {
      throw new HTTPException(400, { message: "executionId is required" })
    }

    // Stop execution using execution client (user access validation done in execution engine)
    await executionClient.stopExecution(executionId)

    return c.json({
      success: true,
      data: {
        executionId,
        status: "STOPPED",
      },
      message: "Execution stopped successfully",
    })
  } catch (error) {
    Logger.error(error, "Failed to stop execution")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Get execution engine health status
export const GetEngineHealthApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey)) // Used for authentication, health check available to all authenticated users

    // Check health via HTTP call to execution engine service
    const isHealthy = await executionClient.healthCheck()


    return c.json({
      success: true,
      data: {
        healthy: isHealthy,
      },
      message: "Engine health status retrieved",
    })
  } catch (error) {
    Logger.error(error, "Failed to get engine health")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Manual trigger handler that communicates with execution engine via execution client
export const HandleManualTrigger = async (c: Context) => {
  const { workflowId, stepId } = c.req.param()
  
  try {
    Logger.info(`🔴 Manual trigger requested for workflow ${workflowId}, step ${stepId}`)

    // Use execution client to trigger the step (same pattern as ExecuteTemplateHandler)
    const result = await executionClient.triggerManualStep(workflowId, stepId, "manual")

    Logger.info(`✅ Manual trigger processed for step ${stepId}`)

    return c.json({
      success: true,
      message: "Manual trigger completed successfully",
      stepId: stepId,
      workflowId: workflowId,
      result: result
    })

  } catch (error) {
    Logger.error(error, `❌ Manual trigger failed for workflow ${workflowId}, step ${stepId}`)
    
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Enhanced execution details API with comprehensive information
export const GetWorkflowExecutionDetailsApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const executionId = c.req.param("executionId")

    // Get execution with template information
    const executionWithTemplate = await db
      .select({
        // Execution fields
        id: workflowExecution.id,
        name: workflowExecution.name,
        description: workflowExecution.description,
        status: workflowExecution.status,
        metadata: workflowExecution.metadata,
        rootWorkflowStepExeId: workflowExecution.rootWorkflowStepExeId,
        completedBy: workflowExecution.completedBy,
        createdAt: workflowExecution.createdAt,
        updatedAt: workflowExecution.updatedAt,
        completedAt: workflowExecution.completedAt,
        // Template fields
        templateId: workflowTemplate.id,
        templateName: workflowTemplate.name,
        templateDescription: workflowTemplate.description,
        templateVersion: workflowTemplate.version,
        templateStatus: workflowTemplate.status,
        templateState: workflowTemplate.state,
      })
      .from(workflowExecution)
      .leftJoin(workflowTemplate, eq(workflowExecution.workflowTemplateId, workflowTemplate.id))
      .where(and(
        eq(workflowExecution.userId, user.id),
        eq(workflowExecution.workspaceId, user.workspaceId),
        eq(workflowExecution.id, executionId),
      ))

    if (!executionWithTemplate || executionWithTemplate.length === 0) {
      throw new HTTPException(404, { message: "Workflow execution not found" })
    }

    const execution = executionWithTemplate[0]

    // Get step executions with template step information
    const stepExecutionsWithDetails = await db
      .select({
        // Step execution fields
        id: workflowStepExecution.id,
        name: workflowStepExecution.name,
        type: workflowStepExecution.type,
        status: workflowStepExecution.status,
        timeEstimate: workflowStepExecution.timeEstimate,
        metadata: workflowStepExecution.metadata,
        prevStepIds: workflowStepExecution.prevStepIds,
        nextStepIds: workflowStepExecution.nextStepIds,
        createdAt: workflowStepExecution.createdAt,
        updatedAt: workflowStepExecution.updatedAt,
        completedAt: workflowStepExecution.completedAt,
        // Template step fields
        templateStepId: workflowStepTemplate.id,
        templateStepName: workflowStepTemplate.name,
        templateStepDescription: workflowStepTemplate.description,
        templateStepMetadata: workflowStepTemplate.metadata,
      })
      .from(workflowStepExecution)
      .leftJoin(workflowStepTemplate, eq(workflowStepExecution.workflowStepTemplateId, workflowStepTemplate.id))
      .where(eq(workflowStepExecution.workflowExecutionId, executionId))
      .orderBy(workflowStepExecution.createdAt)

    // Get tool executions with tool information
    const toolExecutionsWithDetails = await db
      .select({
        // Tool execution fields
        id: toolExecution.id,
        workflowToolId: toolExecution.workflowToolId,
        workflowExecutionId: toolExecution.workflowExecutionId,
        status: toolExecution.status,
        result: toolExecution.result,
        startedAt: toolExecution.startedAt,
        completedAt: toolExecution.completedAt,
        createdAt: toolExecution.createdAt,
        updatedAt: toolExecution.updatedAt,
        // Tool fields
        toolType: workflowTool.type,
        toolCategory: workflowTool.category,
        toolValue: workflowTool.value,
        toolConfig: workflowTool.config,
      })
      .from(toolExecution)
      .leftJoin(workflowTool, eq(toolExecution.workflowToolId, workflowTool.id))
      .where(eq(toolExecution.workflowExecutionId, executionId))
      .orderBy(toolExecution.createdAt)

    // Calculate execution statistics
    const totalSteps = stepExecutionsWithDetails.length
    const completedSteps = stepExecutionsWithDetails.filter(step => step.status === 'completed').length
    const failedSteps = stepExecutionsWithDetails.filter(step => step.status === 'failed').length
    const inProgressSteps = stepExecutionsWithDetails.filter(step => step.status === 'in_progress').length
    const pendingSteps = totalSteps - completedSteps - failedSteps - inProgressSteps

    const totalTools = toolExecutionsWithDetails.length
    const completedTools = toolExecutionsWithDetails.filter(tool => tool.status === 'completed').length
    const failedTools = toolExecutionsWithDetails.filter(tool => tool.status === 'failed').length

    // Calculate progress percentage
    const progressPercentage = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0

    // Calculate execution duration
    let durationMs = null
    let durationFormatted = null
    if (execution.completedAt) {
      durationMs = new Date(execution.completedAt).getTime() - new Date(execution.createdAt).getTime()
      durationFormatted = formatDuration(durationMs)
    } else if (execution.status !== 'draft') {
      durationMs = Date.now() - new Date(execution.createdAt).getTime()
      durationFormatted = formatDuration(durationMs) + ' (ongoing)'
    }

    return c.json({
      success: true,
      data: {
        execution: {
          id: execution.id,
          name: execution.name,
          description: execution.description,
          status: execution.status,
          metadata: execution.metadata,
          rootWorkflowStepExeId: execution.rootWorkflowStepExeId,
          completedBy: execution.completedBy,
          createdAt: execution.createdAt,
          updatedAt: execution.updatedAt,
          completedAt: execution.completedAt,
          durationMs,
          durationFormatted,
        },
        template: {
          id: execution.templateId,
          name: execution.templateName,
          description: execution.templateDescription,
          version: execution.templateVersion,
          status: execution.templateStatus,
          state: execution.templateState,
        },
        statistics: {
          totalSteps,
          completedSteps,
          failedSteps,
          inProgressSteps,
          pendingSteps,
          totalTools,
          completedTools,
          failedTools,
          progressPercentage,
        },
        stepExecutions: stepExecutionsWithDetails.map(step => ({
          id: step.id,
          name: step.name,
          type: step.type,
          status: step.status,
          timeEstimate: step.timeEstimate,
          metadata: step.metadata,
          prevStepIds: step.prevStepIds,
          nextStepIds: step.nextStepIds,
          createdAt: step.createdAt,
          updatedAt: step.updatedAt,
          completedAt: step.completedAt,
          template: {
            id: step.templateStepId,
            name: step.templateStepName,
            description: step.templateStepDescription,
            metadata: step.templateStepMetadata,
          },
        })),
        toolExecutions: toolExecutionsWithDetails.map(tool => ({
          id: tool.id,
          workflowToolId: tool.workflowToolId,
          status: tool.status,
          result: tool.result,
          startedAt: tool.startedAt,
          completedAt: tool.completedAt,
          createdAt: tool.createdAt,
          updatedAt: tool.updatedAt,
          tool: {
            type: tool.toolType,
            category: tool.toolCategory,
            value: tool.toolValue,
            config: tool.toolConfig,
          },
        })),
      },
    })
  } catch (error) {
    Logger.error(error, "Failed to get workflow execution details")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Helper function to format duration
const formatDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m ${seconds % 60}s`
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`
  } else {
    return `${seconds}s`
  }
}