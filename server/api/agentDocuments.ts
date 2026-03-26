import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import {
  getAgentDocumentByExternalId,
  getAgentDocumentContent,
  getAgentDocumentsByChatExternalId,
} from "@/db/agentDocuments"
import { getChatByExternalId, getChatById } from "@/db/chat"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { db } from "@/db/client"
import config from "@/config"

const loggerWithChild = getLoggerWithChild(Subsystem.Api)
const { JwtPayloadKey } = config

// Schema for getting agent document by external ID
export const getAgentDocumentSchema = z.object({
  externalId: z.string(),
})

// Schema for listing agent documents by chat
export const listAgentDocumentsSchema = z.object({
  chatExternalId: z.string(),
})

/**
 * Get agent document by external ID
 * GET /api/v1/agent-documents/:externalId
 */
export const GetAgentDocumentApi = async (c: Context) => {
  try {
    const externalId = c.req.param("externalId")
    const { sub: email } = c.get(JwtPayloadKey)

    // Get document
    const document = await getAgentDocumentByExternalId(externalId)

    if (!document) {
      throw new HTTPException(404, { message: "Agent document not found" })
    }

    // Verify user has access to the chat this document belongs to
    const chat = await getChatById(db, document.chatId)

    const userWorkspace = await getUserAndWorkspaceByEmail(
      db,
      chat.workspaceExternalId,
      email,
    )
    if (!userWorkspace || userWorkspace.workspace.id !== chat.workspaceId) {
      throw new HTTPException(403, { message: "Access denied" })
    }

    loggerWithChild().info(
      { externalId, chatId: document.chatId, userEmail: email },
      "Agent document retrieved successfully",
    )

    // Return public-safe document data
    return c.json({
      externalId: document.externalId,
      agentId: document.agentId,
      agentName: document.agentName,
      content: document.content,
      summary: document.summary,
      reasoning: document.reasoning,
      citations: document.citations,
      confidence: document.confidence,
      createdAt: document.createdAt,
    })
  } catch (error) {
    loggerWithChild().error(
      { error: getErrorMessage(error), externalId: c.req.param("externalId") },
      "Failed to get agent document",
    )

    if (error instanceof HTTPException) {
      throw error
    }

    throw new HTTPException(500, { message: "Failed to get agent document" })
  }
}

/**
 * Get agent document content by external ID
 * GET /api/v1/agent-documents/:externalId/content
 * Returns the content in a format suitable for the text viewer
 */
export const GetAgentDocumentContentApi = async (c: Context) => {
  try {
    const externalId = c.req.param("externalId")
    const { sub: email } = c.get(JwtPayloadKey)

    // Get document content with permission check fields
    const document = await getAgentDocumentContent(externalId)

    if (!document) {
      throw new HTTPException(404, { message: "Agent document not found" })
    }

    // Verify user has access to the workspace this document belongs to
    const workspaceUser = await getUserAndWorkspaceByEmail(
      db,
      document.workspaceExternalId,
      email,
    )
    if (!workspaceUser) {
      throw new HTTPException(403, { message: "Access denied" })
    }

    loggerWithChild().info(
      { externalId, userEmail: email },
      "Agent document content retrieved successfully",
    )

    // Return formatted content for the viewer
    return c.json({
      externalId: document.externalId,
      title: `Agent Output: ${document.agentName}`,
      agentName: document.agentName,
      content: document.content,
      summary: document.summary,
      reasoning: document.reasoning,
      citations: document.citations,
      confidence: document.confidence,
      createdAt: document.createdAt,
    })
  } catch (error) {
    loggerWithChild().error(
      { error: getErrorMessage(error), externalId: c.req.param("externalId") },
      "Failed to get agent document content",
    )

    if (error instanceof HTTPException) {
      throw error
    }

    throw new HTTPException(500, { message: "Failed to get agent document content" })
  }
}

/**
 * List agent documents by chat external ID
 * GET /api/v1/agent-documents?chatExternalId=:chatExternalId
 */
export const ListAgentDocumentsApi = async (c: Context) => {
  try {
    const { chatExternalId } = c.req.query()
    const { sub: email } = c.get(JwtPayloadKey)

    if (!chatExternalId) {
      throw new HTTPException(400, { message: "chatExternalId is required" })
    }

    // Verify user has access to the chat
    const chat = await getChatByExternalId(db, chatExternalId)
    if (!chat) {
      throw new HTTPException(404, { message: "Chat not found" })
    }

    const userWorkspace = await getUserAndWorkspaceByEmail(
      db,
      chat.workspaceExternalId,
      email,
    )
    if (!userWorkspace || userWorkspace.workspace.id !== chat.workspaceId) {
      throw new HTTPException(403, { message: "Access denied" })
    }

    // Get documents for this chat
    const documents = await getAgentDocumentsByChatExternalId(chatExternalId)

    loggerWithChild().info(
      { chatExternalId, count: documents.length, userEmail: email },
      "Agent documents listed successfully",
    )

    // Return public-safe document list
    return c.json({
      documents: documents.map((doc) => ({
        externalId: doc.externalId,
        agentId: doc.agentId,
        agentName: doc.agentName,
        summary: doc.summary,
        createdAt: doc.createdAt,
      })),
    })
  } catch (error) {
    loggerWithChild().error(
      { error: getErrorMessage(error), chatExternalId: c.req.query().chatExternalId },
      "Failed to list agent documents",
    )

    if (error instanceof HTTPException) {
      throw error
    }

    throw new HTTPException(500, { message: "Failed to list agent documents" })
  }
}
