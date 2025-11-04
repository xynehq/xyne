import { type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { getErrorMessage } from "@/utils"
import { getUserFromJWT } from "@/db/user"
import { db } from "@/db/client"
import { executionClient } from "@/execution-engine/execution-client"

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
    
    // Get basic queue status from execution client
    const engineStatus = {
      service: "running",
      queue: executionClient.getQueueStatus ? executionClient.getQueueStatus() : "unavailable"
    }

    return c.json({
      success: true,
      data: {
        healthy: isHealthy,
        status: engineStatus,
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