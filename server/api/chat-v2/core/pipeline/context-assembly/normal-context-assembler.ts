/**
 * Normal Context Assembler
 * 
 * Assembles context for standard chat mode (no agent)
 */

import { BaseContextAssembler } from "./context-assembler.interface"
import type { AssembledChatContext, ConversationMessage, MemoryContext } from "../../../models"
import type { RequestContextLike as RequestContext } from "../../orchestrator/request-context.types"

export class NormalContextAssembler extends BaseContextAssembler {
  async assemble(requestContext: RequestContext): Promise<AssembledChatContext> {
    const { request, user, chat } = requestContext
    
    // Parallel assembly of independent components
    const [
      conversationHistory,
      memories,
      attachments,
    ] = await Promise.all([
      this.loadConversationHistory(requestContext),
      this.loadMemories(requestContext),
      this.loadAttachments(requestContext),
    ])
    
    return {
      userMessage: request.message,
      normalizedUserMessage: this.normalizeMessage(request.message),
      conversationHistory,
      memories,
      attachments,
    }
  }
  
  private async loadConversationHistory(
    requestContext: RequestContext
  ): Promise<ConversationMessage[]> {
    if (!this.options.includeHistory) {
      return []
    }
    
    const { persistence } = requestContext
    
    // Get recent messages from persistence layer
    const messages = await persistence.loadConversationHistory(
      requestContext.chat.externalId,
      this.options.historyLimit ?? 20
    )
    
    return messages
  }
  
  private async loadMemories(
    requestContext: RequestContext
  ): Promise<MemoryContext | undefined> {
    const memories: MemoryContext = {}
    
    if (this.options.includeEpisodicMemory) {
      memories.episodic = await requestContext.memory.getEpisodicMemory(
        requestContext.user.id
      )
    }
    
    if (this.options.includeChatMemory) {
      memories.chatHistory = await requestContext.memory.getChatHistoryMemory(
        requestContext.user.id,
        requestContext.chat.externalId
      )
    }
    
    if (this.options.includeEpisodicMemory) {
      memories.workspace = await requestContext.memory.getWorkspaceMemory(
        requestContext.user.workspaceId
      )
    }
    
    return Object.keys(memories).length > 0 ? memories : undefined
  }
  
  private async loadAttachments(
    requestContext: RequestContext
  ): Promise<import("../../../models").AttachmentContext | undefined> {
    if (!this.options.includeAttachments) {
      return undefined
    }
    
    const { request } = requestContext
    
    if (!request.attachments || request.attachments.length === 0) {
      return undefined
    }
    
    // Process attachments through persistence service
    return {
      files: request.attachments.map(att => ({
        fileId: att.fileId || "",
        fileName: att.fileName,
        mimeType: att.mimeType,
        isImage: att.mimeType?.startsWith("image/") ?? false,
      })),
      fragments: [],
      summary: "",
    }
  }
}
