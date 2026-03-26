/**
 * Legacy Bridge
 * 
 * Provides fallback to legacy implementation when:
 * - Feature flag is off
 * - New implementation encounters error
 * - Specific request requires legacy behavior
 */

import type { ChatRequest } from "../models"
import type { ChatEvent } from "../shared/events"

export interface LegacyBridgeConfig {
  /** Enable automatic fallback on errors */
  enableFallback?: boolean
  /** Log bridge decisions */
  debug?: boolean
}

/**
 * Execute request using legacy implementation
 */
export async function *executeLegacy(
  request: ChatRequest,
  jwtPayload: any,
  config: LegacyBridgeConfig = {}
): AsyncIterable<ChatEvent> {
  const { enableFallback = true, debug = false } = config

  if (debug) {
    console.log("[LegacyBridge] Falling back to legacy implementation")
  }

  try {
    // Import legacy handler dynamically to avoid loading if not needed
    const { MessageAgents } = await import("../../chat/message-agents")
    
    // Convert request to legacy format
    const legacyRequest = convertToLegacyFormat(request, jwtPayload)

    // Execute legacy handler
    const legacyStream = await MessageAgents(legacyRequest)

    // Convert legacy events to new format
    for await (const legacyEvent of legacyStream) {
      yield convertLegacyEvent(legacyEvent)
    }

  } catch (error) {
    if (debug) {
      console.error("[LegacyBridge] Legacy execution failed:", error)
    }

    yield {
      type: "error",
      error: {
        code: "LEGACY_ERROR",
        message: "Both new and legacy implementations failed",
        recoverable: false,
        details: { originalError: String(error) },
      },
    }
  }
}

/**
 * Convert new format request to legacy format
 */
function convertToLegacyFormat(request: ChatRequest, jwtPayload: any): any {
  return {
    message: request.message,
    chatId: request.chatId,
    agentId: request.agentId,
    modelConfig: request.modelConfig,
    attachments: request.attachments,
    toolsList: request.toolsList,
    // JWT info
    user: {
      id: jwtPayload.userId,
      email: jwtPayload.email,
      workspaceId: jwtPayload.workspaceId,
    },
  }
}

/**
 * Convert legacy event to new format
 */
function convertLegacyEvent(legacy: any): ChatEvent {
  switch (legacy.event) {
    case "RESPONSE_UPDATE":
      return { type: "token", content: legacy.data }
    
    case "CITATIONS_UPDATE":
      return {
        type: "citation",
        citation: {
          index: legacy.data.index,
          item: {
            docId: legacy.data.item?.docId || "",
            title: legacy.data.item?.title || "",
            url: legacy.data.item?.url,
            app: legacy.data.item?.app || "document",
            entity: legacy.data.item?.entity || "file",
          },
        },
        citationMap: legacy.data.citationMap || {},
      }
    
    case "REASONING":
      return {
        type: "reasoning",
        step: {
          stage: legacy.data.stage,
          message: legacy.data.message,
          timestamp: new Date(),
        },
      }
    
    case "ERROR":
      return {
        type: "error",
        error: {
          code: legacy.data.code || "LEGACY_ERROR",
          message: legacy.data.message,
          recoverable: false,
        },
      }
    
    case "END":
      return { type: "complete" }
    
    default:
      return { type: "token", content: "" }
  }
}
