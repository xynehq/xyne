/**
 * Chat V2 Adapter for Legacy Routes
 *
 * Bridges the existing GET /message/create endpoint to the new Chat V2 architecture
 * Maintains backward compatibility with existing request/response formats
 */

import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { getGlobalOrchestrator } from "../../core/orchestrator/orchestrator-factory"
import { toSSEEvent, type ChatEvent } from "../../shared/events"
import type { ChatRequest, ModelConfig } from "../../models"
import type { AttachmentMetadata } from "@/shared/types"
import { parseAttachmentMetadata } from "@/utils/parseAttachment"
import config from "@/config"

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
 */
export async function MessageApiV2(c: Context) {
  console.log("MessageApiV2 started")
  const startTime = Date.now()

  try {
    // Extract JWT payload
    const jwtPayload = c.get(JwtPayloadKey)
    if (!jwtPayload) {
      throw new HTTPException(401, { message: "Unauthorized" })
    }

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

    // Convert to Chat V2 request format
    const chatRequest: ChatRequest = {
      message: message as string,
      chatId: chatId as string | undefined,
      agentId: agentId as string | undefined,
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

    // Set up SSE stream (compatible with legacy format)
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Process request through orchestrator
          for await (const event of orchestrator.process(
            chatRequest,
            jwtPayload,
          )) {
            // Convert to legacy SSE format
            const legacyEvent = convertToLegacyEvent(event)

            // Send event
            controller.enqueue(
              new TextEncoder().encode(
                `event: ${legacyEvent.event}\ndata: ${legacyEvent.data}\n\n`,
              ),
            )

            // Stop if complete or error
            if (event.type === "complete" || event.type === "error") {
              controller.close()
              break
            }
          }
        } catch (error) {
          // Send error event in legacy format
          const errorEvent = {
            event: "ERROR",
            data: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          }

          controller.enqueue(
            new TextEncoder().encode(
              `event: ${errorEvent.event}\ndata: ${errorEvent.data}\n\n`,
            ),
          )
          controller.close()
        }
      },

      cancel() {
        console.log("[MessageApiV2] Client disconnected")
      },
    })

    // Return SSE response with same headers as legacy
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
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

/**
 * Convert Chat V2 event to legacy SSE format
 *
 * Legacy format:
 * - event: "RESPONSE_UPDATE", data: string
 * - event: "CITATIONS_UPDATE", data: { index, item }
 * - event: "REASONING", data: { stage, message }
 * - event: "ERROR", data: { message }
 * - event: "END", data: {}
 */
function convertToLegacyEvent(event: ChatEvent): {
  event: string
  data: string
} {
  switch (event.type) {
    case "token":
      return {
        event: "RESPONSE_UPDATE",
        data: JSON.stringify(event.content),
      }

    case "citation":
      return {
        event: "CITATIONS_UPDATE",
        data: JSON.stringify({
          index: event.citation.index,
          item: event.citation,
        }),
      }

    case "reasoning":
      return {
        event: "REASONING",
        data: JSON.stringify({
          stage: event.step.stage,
          message: event.step.message,
          details: event.step.details,
        }),
      }

    case "tool-call":
      return {
        event: "REASONING",
        data: JSON.stringify({
          stage: "tool_execution",
          message: `Calling tool: ${event.tool}`,
          details: { tool: event.tool, arguments: event.arguments },
        }),
      }

    case "tool-result":
      return {
        event: "REASONING",
        data: JSON.stringify({
          stage: "tool_result",
          message: `Tool ${event.tool} completed`,
          details: { tool: event.tool, success: event.success },
        }),
      }

    case "error":
      return {
        event: "ERROR",
        data: JSON.stringify({
          message: event.error.message,
          code: event.error.code,
        }),
      }

    case "complete":
      return {
        event: "END",
        data: JSON.stringify({}),
      }

    case "start":
      // Legacy doesn't have a start event, map to reasoning
      return {
        event: "REASONING",
        data: JSON.stringify({
          stage: "start",
          message: "Starting chat processing",
        }),
      }

    default:
      return {
        event: "RESPONSE_UPDATE",
        data: JSON.stringify(""),
      }
  }
}
