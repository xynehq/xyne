/**
 * Context Assembler Interface
 * 
 * REPLACES: Context preparation logic scattered in message-agents.ts (lines 200-400)
 * BENEFITS:
 *   - Isolated context assembly per chat mode
 *   - Testable independently
 *   - Easy to customize for different modes
 */

import type { AssembledChatContext, ChatRequest, UserContext, ChatContext, ConversationMessage, MemoryContext, AttachmentContext } from "../../../models"
import type { RequestContextLike } from "../../orchestrator/request-context.types"

// Re-export for convenience
export type RequestContext = RequestContextLike

/**
 * Context Assembler - Prepares all context needed for chat processing
 */
export interface ContextAssembler {
  /**
   * Assemble complete chat context
   * @param requestContext - Request-scoped context with dependencies
   * @returns Fully assembled chat context
   */
  assemble(requestContext: RequestContext): Promise<AssembledChatContext>
  
  /**
   * Validate that required context is available
   * @param requestContext - Request context
   * @throws Error if required context is missing
   */
  validate(requestContext: RequestContext): Promise<void>
}

/**
 * Context assembly options
 */
export interface ContextAssemblyOptions {
  /** Include conversation history */
  includeHistory?: boolean
  /** Number of history messages to include */
  historyLimit?: number
  /** Include episodic memories */
  includeEpisodicMemory?: boolean
  /** Include chat memories */
  includeChatMemory?: boolean
  /** Include attachments */
  includeAttachments?: boolean
  /** Include agent configuration */
  includeAgentConfig?: boolean
}

/**
 * Base context assembler with common functionality
 */
export abstract class BaseContextAssembler implements ContextAssembler {
  protected options: ContextAssemblyOptions
  
  constructor(options: ContextAssemblyOptions = {}) {
    this.options = {
      includeHistory: true,
      historyLimit: 20,
      includeEpisodicMemory: true,
      includeChatMemory: true,
      includeAttachments: true,
      includeAgentConfig: false,
      ...options,
    }
  }
  
  abstract assemble(requestContext: RequestContext): Promise<AssembledChatContext>
  
  async validate(requestContext: RequestContext): Promise<void> {
    // Base validation - ensure user and chat are present
    if (!requestContext.user?.id) {
      throw new Error("User context is required")
    }
    if (!requestContext.request?.message) {
      throw new Error("User message is required")
    }
  }
  
  /**
   * Normalize user message (trim, clean, etc.)
   */
  protected normalizeMessage(message: string): string {
    return message.trim().replace(/\s+/g, " ")
  }
}
