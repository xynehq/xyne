// API endpoints for managing resumable Slack channel ingestion lifecycle
// Provides cancel, resume, delete, and status operations for ingestion records

import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { eq, and, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { getUserByEmail } from "@/db/user"
import { getConnector } from "@/db/connector"
import {
  getActiveIngestionForUser,
  getIngestionById,
  updateIngestionStatus,
} from "@/db/ingestion"
import { ingestions, type SelectIngestion } from "@/db/schema/ingestions"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import config from "@/config"
import { handleSlackChannelIngestion } from "@/integrations/slack/channelIngest"

const { JwtPayloadKey } = config
const Logger = getLogger(Subsystem.Api)
const loggerWithChild = getLoggerWithChild(Subsystem.Api)

// Zod validation schemas for API request parameters
export const getIngestionStatusSchema = z.object({
  connectorId: z.string(),
})

export const cancelIngestionSchema = z.object({
  ingestionId: z.string(),
})

export const resumeIngestionSchema = z.object({
  ingestionId: z.string(),
})


export const pauseIngestionSchema = z.object({
  ingestionId: z.string(),
})

// API endpoint to check current ingestion status for a connector
// Used by frontend to determine what UI to show when user visits page
// Returns ingestion details including progress and current state
export const GetIngestionStatusApi = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  // @ts-ignore - Payload is validated at the endpoint declaration level in sync-server using zValidator
  const { connectorId } = c.req.valid("query")

  try {
    // Validate user authentication
    const userRes = await getUserByEmail(db, sub)
    if (!userRes || !userRes.length) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const [user] = userRes

    // Validate connector exists and user has access
    const connector = await getConnector(db, parseInt(connectorId))
    if (!connector) {
      throw new HTTPException(404, { message: "Connector not found" })
    }

    // SECURITY: Ensure connector belongs to current user/workspace to prevent cross-tenant access
    if (connector.userId !== user.id || connector.workspaceId !== user.workspaceId) {
      throw new HTTPException(403, { message: "Forbidden: connector does not belong to you" })
    }

    // Check for any active ingestion for this user+connector
    const activeIngestion = await getActiveIngestionForUser(
      db,
      user.id,
      connector.id
    )

    // If no active ingestion, check for recent completed/cancelled ingestion for status display
    let ingestionToReturn = activeIngestion
    if (!activeIngestion) {
      const recentIngestion = await db
        .select()
        .from(ingestions)
        .where(
          and(
            eq(ingestions.userId, user.id),
            eq(ingestions.connectorId, connector.id),
            sql`status IN ('completed', 'cancelled')`
          )
        )
        .orderBy(sql`updated_at DESC`)
        .limit(1)
      
      ingestionToReturn = (recentIngestion[0] as SelectIngestion) || null
    }

    // Return status info for frontend UI state management
    return c.json({
      success: true,
      hasActiveIngestion: !!activeIngestion,
      ingestion: ingestionToReturn,
    })
  } catch (error) {
    loggerWithChild({ email: sub }).error(
      error,
      "Failed to get ingestion status"
    )
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, {
      message: `Failed to get ingestion status: ${getErrorMessage(error)}`,
    })
  }
}

// API endpoint to cancel a currently running ingestion
// Sets status to 'cancelled' and stops processing
// Only works for in_progress ingestions
export const CancelIngestionApi = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  // @ts-ignore - Payload is validated at the endpoint declaration level in sync-server using zValidator
  const payload = c.req.valid("json") as { ingestionId: string }

  try {
    // Validate user authentication
    const userRes = await getUserByEmail(db, sub)
    if (!userRes || !userRes.length) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const [user] = userRes

    // Find the ingestion record
    const ingestion = await getIngestionById(db, parseInt(payload.ingestionId))
    if (!ingestion) {
      throw new HTTPException(404, { message: "Ingestion not found" })
    }

    // Security check - ensure user owns this ingestion
    if (ingestion.userId !== user.id) {
      throw new HTTPException(403, { message: "Access denied" })
    }

    // Business rule - can only cancel active ingestions (in_progress, failed, paused)
    if (!["in_progress", "failed", "paused"].includes(ingestion.status)) {
      throw new HTTPException(400, {
        message: "Can only cancel in-progress, failed, or paused ingestions",
      })
    }

    // Update status to cancelled - sync-server will detect this and stop
    await updateIngestionStatus(db, parseInt(payload.ingestionId), "cancelled")

    return c.json({
      success: true,
      message: "Ingestion cancelled successfully",
    })
  } catch (error) {
    loggerWithChild({ email: sub }).error(error, "Failed to cancel ingestion")
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, {
      message: `Failed to cancel ingestion: ${getErrorMessage(error)}`,
    })
  }
}

// API endpoint to pause a currently running ingestion
// Sets status to 'paused' and stops processing
// Only works for in_progress ingestions
export const PauseIngestionApi = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  // @ts-ignore - Payload is validated at the endpoint declaration level in sync-server using zValidator
  const payload = c.req.valid("json") as { ingestionId: string }

  try {
    // Validate user authentication
    const userRes = await getUserByEmail(db, sub)
    if (!userRes || !userRes.length) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const [user] = userRes

    // Find the ingestion record
    const ingestion = await getIngestionById(db, parseInt(payload.ingestionId))
    if (!ingestion) {
      throw new HTTPException(404, { message: "Ingestion not found" })
    }

    // Security check - ensure user owns this ingestion
    if (ingestion.userId !== user.id) {
      throw new HTTPException(403, { message: "Access denied" })
    }

    // Business rule - can only pause active ingestions
    if (ingestion.status !== "in_progress") {
      throw new HTTPException(400, {
        message: "Can only pause in-progress ingestions",
      })
    }

    // Update status to paused - ingestion process will detect this and pause
    await updateIngestionStatus(db, parseInt(payload.ingestionId), "paused")

    return c.json({
      success: true,
      message: "Ingestion paused successfully",
    })
  } catch (error) {
    loggerWithChild({ email: sub }).error(error, "Failed to pause ingestion")
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, {
      message: `Failed to pause ingestion: ${getErrorMessage(error)}`,
    })
  }
}

// API endpoint to resume a failed or cancelled ingestion
// Extracts stored parameters from metadata and restarts processing
// Continues from where it left off using stored state
export const ResumeIngestionApi = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  // @ts-ignore - Payload is validated at the endpoint declaration level in sync-server using zValidator
  const payload = c.req.valid("json") as { ingestionId: string }

  try {
    // Validate user authentication
    const userRes = await getUserByEmail(db, sub)
    if (!userRes || !userRes.length) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const [user] = userRes

    // Find the ingestion record to resume
    const ingestion = await getIngestionById(db, parseInt(payload.ingestionId))
    if (!ingestion) {
      throw new HTTPException(404, { message: "Ingestion not found" })
    }

    // Security check - ensure user owns this ingestion
    if (ingestion.userId !== user.id) {
      throw new HTTPException(403, { message: "Access denied" })
    }

    // Business rule - can only resume failed, cancelled, or paused ingestions
    if (!["failed", "cancelled", "paused"].includes(ingestion.status)) {
      throw new HTTPException(400, {
        message: "Can only resume failed, cancelled, or paused ingestions",
      })
    }

    // Get connector details for resuming
    const connector = await getConnector(db, ingestion.connectorId)
    if (!connector) {
      throw new HTTPException(404, { message: "Connector not found" })
    }

    // SECURITY: Additional check - ensure connector belongs to current user/workspace (defense in depth)
    if (connector.userId !== user.id || connector.workspaceId !== user.workspaceId) {
      throw new HTTPException(403, { message: "Forbidden: connector does not belong to you" })
    }

    // Extract original ingestion parameters from stored metadata
    // This is key to resumability - all state is preserved in metadata
    const metadata = ingestion.metadata as any
    if (!metadata?.slack?.ingestionState) {
      throw new HTTPException(400, {
        message: "Ingestion metadata not found or invalid",
      })
    }

    const state = metadata.slack.ingestionState
    const channelsToIngest = state.channelsToIngest
    const startDate = state.startDate
    const endDate = state.endDate
    const includeBotMessage = state.includeBotMessage || false

    // Validate the stored parameters are still valid
    if (!channelsToIngest || !Array.isArray(channelsToIngest)) {
      throw new HTTPException(400, {
        message: "Invalid channels data in ingestion metadata",
      })
    }

    // Reset status to pending to prepare for processing
    await updateIngestionStatus(db, parseInt(payload.ingestionId), "pending")

    // Restart the ingestion with the original parameters
    // The processing function will detect the existing state and resume
    handleSlackChannelIngestion(
      connector.id,
      channelsToIngest,
      startDate,
      endDate,
      sub,
      includeBotMessage,
      parseInt(payload.ingestionId)
    ).catch((error) => {
      loggerWithChild({ email: sub }).error(
        error,
        `Background Slack channel ingestion resume failed for ingestion ${payload.ingestionId}: ${getErrorMessage(error)}`
      )
    })

    return c.json({
      success: true,
      message: "Ingestion resumed successfully",
      ingestionId: parseInt(payload.ingestionId),
    })
  } catch (error) {
    loggerWithChild({ email: sub }).error(error, "Failed to resume ingestion")
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, {
      message: `Failed to resume ingestion: ${getErrorMessage(error)}`,
    })
  }
}

