/**
 * Chat V2 Adapter for Legacy Routes
 *
 * Bridges the existing GET /message/create endpoint to the new Chat V2 architecture
 * Maintains backward compatibility with existing request/response formats
 *
 * CRITICAL: This must replicate the exact behavior of the legacy MessageApi including:
 * - Database operations (create chat, save messages)
 * - SSE event sequence
 * - Response format
 */

import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import { getGlobalOrchestrator } from "../../core/orchestrator/orchestrator-factory"
import type { ChatEvent } from "../../shared/events"
import type { ChatRequest, ModelConfig } from "../../models"
import { ChatSSEvents, type AttachmentMetadata } from "@/shared/types"
import { parseAttachmentMetadata } from "@/utils/parseAttachment"
import config from "@/config"
import { db } from "@/db/client"
import {
  insertChat,
  getChatByExternalId,
  updateChatByExternalIdWithAuth,
} from "@/db/chat"
import { insertMessage, getChatMessagesWithAuth } from "@/db/message"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { createId } from "@paralleldrive/cuid2"
import { MessageRole } from "@/types"
import { ChatType } from "@/db/schema"

// JwtPayloadKey is exported from config
const { JwtPayloadKey } = config

/**
 * Check if Chat V2 is enabled via feature flag
 */
export function isChatV2Enabled(): boolean {
  return (
    config.features?.chatV2 === true || process.env.CHAT_V2_ENABLED === "true"
  )
}

/**
 * MessageApi adapter for Chat V2
 *
 * This handler wraps the new Chat V2 orchestrator to work with the existing
 * GET /message/create endpoint format (query parameters instead of JSON body)
 *
 * REPLICATES: All database operations from legacy MessageApi
 * - Creates/gets chat
 * - Saves user message
 * - Streams response
 * - Saves assistant message
 */
export async function MessageApiV2(c: Context) {
  console.log("[MessageApiV2] ========== Starting request ==========")
  const startTime = Date.now()

  try {
    // Extract JWT payload
    const jwtPayload = c.get(JwtPayloadKey)
    if (!jwtPayload) {
      throw new HTTPException(401, { message: "Unauthorized" })
    }

    const email = jwtPayload.sub
    const workspaceId = jwtPayload.workspaceId

    // Parse query parameters (same as legacy MessageApi)
    const query = c.req.query()
    const {
      message,
      chatId,
      selectedModelConfig,
      agentId,
      toolsList,
      agentPromptPayload,
    } = query

    if (!message) {
      throw new HTTPException(400, { message: "Message is required" })
    }

    // Parse attachments from query (same as legacy)
    const attachmentMetadata = parseAttachmentMetadata(c)

    // Get user and workspace
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const user = userAndWorkspace.user
    const workspace = userAndWorkspace.workspace

    // Create or get existing chat and save user message
    let chat: any
    let userMessage: any

    if (!chatId) {
      // New chat - create chat with "Untitled" and insert user message
      // (Matches legacy behavior - title is updated later)
      console.log("[MessageApiV2] Creating new chat...")

      // Create chat and insert user message in transaction
      const result = await db.transaction(async (tx) => {
        const newChat = await insertChat(tx, {
          workspaceId: workspace.id,
          workspaceExternalId: workspace.externalId,
          userId: user.id,
          email: user.email,
          title: "Untitled", // Initially untitled, like legacy
          attachments: [],
          chatType: ChatType.Default,
        })

        const insertedMsg = await insertMessage(tx, {
          chatId: newChat.id,
          userId: user.id,
          workspaceExternalId: workspace.externalId,
          chatExternalId: newChat.externalId,
          messageRole: MessageRole.User,
          email: user.email,
          sources: [],
          message,
          modelId: config.defaultBestModel,
        })

        return { chat: newChat, userMessage: insertedMsg }
      })

      chat = result.chat
      userMessage = result.userMessage
      console.log(`[MessageApiV2] Created new chat: ${chat.externalId}`)
    } else {
      // Existing chat - get chat and insert user message
      console.log(`[MessageApiV2] Using existing chat: ${chatId}`)

      const result = await db.transaction(async (tx) => {
        const existingChat = await updateChatByExternalIdWithAuth(
          db,
          chatId,
          email,
          {},
        )

        const insertedMsg = await insertMessage(tx, {
          chatId: existingChat.id,
          userId: user.id,
          workspaceExternalId: workspace.externalId,
          chatExternalId: existingChat.externalId,
          messageRole: MessageRole.User,
          email: user.email,
          sources: [],
          message,
          modelId: config.defaultBestModel,
        })

        return { chat: existingChat, userMessage: insertedMsg }
      })

      chat = result.chat
      userMessage = result.userMessage
      console.log(`[MessageApiV2] Added user message to existing chat`)
    }

    // Check if agentic mode is enabled from query params
    const isAgentic = query.agentic === "true"

    // Convert to Chat V2 request format
    const chatRequest: ChatRequest = {
      message: message as string,
      chatId: chat.externalId,
      agentId: agentId as string | undefined,
      isAgentic,
      modelConfig: (selectedModelConfig
        ? parseModelConfig(selectedModelConfig as string)
        : undefined) as ModelConfig,
      attachments:
        attachmentMetadata.length > 0
          ? attachmentMetadata.map((att) => ({
              fileId: att.fileId,
              fileName: att.fileName,
              fileType: att.fileType,
              fileSize: att.fileSize,
              isImage: att.isImage,
              thumbnailUrl: att.thumbnailUrl,
              url: att.url,
              createdAt: att.createdAt,
            }))
          : undefined,
      toolsList: toolsList ? parseToolsList(toolsList as string) : undefined,
      metadata: {
        agentPromptPayload: agentPromptPayload
          ? JSON.parse(agentPromptPayload as string)
          : undefined,
        originalQuery: query,
      },
    }

    // Get orchestrator
    const orchestrator = getGlobalOrchestrator()
    console.log("[MessageApiV2] Got orchestrator, starting streamSSE...")

    // Use Hono's streamSSE like the legacy code
    return streamSSE(c, async (stream) => {
      let eventCount = 0
      let assistantContent = ""
      let assistantMessageId: string | null = null

      console.log("[MessageApiV2] streamSSE started")

      try {
        // Send ResponseMetadata with chatId (same as legacy)
        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({ chatId: chat.externalId }),
        })
        console.log("[MessageApiV2] Sent ResponseMetadata")

        // Send START event
        await stream.writeSSE({
          event: ChatSSEvents.Start,
          data: "",
        })
        console.log("[MessageApiV2] Sent START")

        // Process request through orchestrator
        for await (const event of orchestrator.process(
          chatRequest,
          jwtPayload,
        )) {
          eventCount++

          // Accumulate assistant content for saving to DB
          if (event.type === "token") {
            assistantContent += event.content

            // Send token immediately (frontend expects plain text, not JSON)
            await stream.writeSSE({
              event: ChatSSEvents.ResponseUpdate,
              data: event.content, // Direct string, not JSON.stringify
            })
          }

          // When complete, save message and send final metadata
          else if (event.type === "complete") {
            console.log("[MessageApiV2] Got complete event")

            // Save assistant message to DB
            if (assistantContent) {
              console.log("[MessageApiV2] Saving assistant message to DB...")
              const assistantMsg = await insertMessage(db, {
                chatId: chat.id,
                userId: user.id,
                workspaceExternalId: workspace.externalId,
                chatExternalId: chat.externalId,
                messageRole: MessageRole.Assistant,
                email: user.email,
                sources: [],
                message: assistantContent,
                modelId: config.defaultBestModel,
              })
              assistantMessageId = assistantMsg.externalId
              console.log(
                `[MessageApiV2] Assistant message saved: ${assistantMessageId}`,
              )

              // Send final ResponseMetadata with both chatId and messageId
              await stream.writeSSE({
                event: ChatSSEvents.ResponseMetadata,
                data: JSON.stringify({
                  chatId: chat.externalId,
                  messageId: assistantMessageId,
                }),
              })
              console.log("[MessageApiV2] Sent final ResponseMetadata")
            }

            // Send END event (legacy sends empty string, not JSON)
            await stream.writeSSE({
              event: ChatSSEvents.End,
              data: "",
            })
            console.log("[MessageApiV2] Sent END")

            break
          }

          // Handle error
          else if (event.type === "error") {
            await stream.writeSSE({
              event: ChatSSEvents.Error,
              data: JSON.stringify({
                message: event.error.message,
                code: event.error.code,
              }),
            })
            console.log("[MessageApiV2] Sent Error")
            break
          }
        }

        console.log(
          `[MessageApiV2] Stream completed. Total events: ${eventCount}`,
        )
      } catch (error) {
        console.error("[MessageApiV2] Stream error:", error)

        // Send error event
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        })
      }
    })
  } catch (error) {
    console.error("[MessageApiV2] Error:", error)

    if (error instanceof HTTPException) {
      throw error
    }

    throw new HTTPException(500, {
      message: error instanceof Error ? error.message : "Internal server error",
    })
  }
}

/**
 * Parse model config JSON string
 */
function parseModelConfig(configStr: string): {
  model?: string
  reasoning?: boolean
  websearch?: boolean
  deepResearch?: boolean
  capabilities?: string[]
} {
  try {
    const parsed = JSON.parse(configStr)
    return {
      model: parsed.model,
      reasoning:
        parsed.reasoning === true || parsed.capabilities?.includes("reasoning"),
      websearch:
        parsed.websearch === true || parsed.capabilities?.includes("websearch"),
      deepResearch:
        parsed.deepResearch === true ||
        parsed.capabilities?.includes("deepResearch"),
      capabilities: parsed.capabilities,
    }
  } catch {
    return {}
  }
}

/**
 * Parse tools list JSON string
 */
function parseToolsList(toolsStr: string): Array<{
  connectorId: string
  tools: string[]
}> {
  try {
    return JSON.parse(toolsStr)
  } catch {
    return []
  }
}
