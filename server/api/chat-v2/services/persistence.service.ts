/**
 * Persistence Service Interface
 * 
 * Handles storage and retrieval of chat data
 */

import type { ChatContext, ConversationMessage, UserContext } from "../models"
import { db } from "@/db/client"

export interface PersistenceService {
  /**
   * Load or create chat context
   */
  loadChatContext(
    externalId: string,
    userContext: UserContext
  ): Promise<ChatContext>
  
  /**
   * Save chat context
   */
  saveChatContext(context: ChatContext): Promise<void>
  
  /**
   * Load conversation history
   */
  loadConversationHistory(
    chatId: string,
    limit?: number
  ): Promise<ConversationMessage[]>
  
  /**
   * Append a message to conversation history
   */
  appendMessage(
    chatId: string,
    message: ConversationMessage
  ): Promise<void>
  
  /**
   *     Save tool execution results
   */
  saveToolExecution(
    chatId: string,
    toolExecution: {
      toolName: string
      arguments: Record<string, unknown>
      result: unknown
      durationMs: number
    }
  ): Promise<void>
  
  /**
   * Get agent by ID with permission check
   */
  getAgentById?(agentId: string, workspaceId: string): Promise<AgentRecord | null>
}

export interface AgentRecord {
  id?: number
  externalId?: string
  name: string
  prompt: string
  systemPrompt?: string
  model?: string
  tools?: string[]
  allowedApps?: string[]
  resourceConstraints?: {
    collectionIds?: string[]
    folderIds?: string[]
    fileIds?: string[]
  }
  workspaceId: string
}

/**
 * Bridge to existing database operations
 */
export class DatabasePersistenceService implements PersistenceService {
  async loadChatContext(
    externalId: string,
    userContext: UserContext
  ): Promise<ChatContext> {
    const { getChatByExternalId } = await import("@/db/chat")
    
    try {
      const chat = await getChatByExternalId(db, externalId)
      return {
        id: chat.id,
        externalId: chat.externalId,
        title: chat.title || undefined,
        metadata: {},
      }
    } catch {
      // Return minimal context if chat not found
      return {
        externalId,
        metadata: {},
      }
    }
  }
  
  async saveChatContext(context: ChatContext): Promise<void> {
    // Implementation would update chat metadata
    // For now, this is a no-op as existing code handles this
  }
  
  async loadConversationHistory(
    chatId: string,
    limit?: number
  ): Promise<ConversationMessage[]> {
    // Placeholder - getChatMessagesWithAuth requires auth context
    // For now, return empty array
    console.warn("loadConversationHistory: not yet implemented")
    return []
  }
  
  async appendMessage(
    chatId: string,
    message: ConversationMessage
  ): Promise<void> {
    const { insertMessage } = await import("@/db/message")
    await insertMessage(db, {
      chatExternalId: chatId,
      role: message.role,
      content: message.content,
      userId: 0, // Will be set from context
    })
  }
  
  async saveToolExecution(
    chatId: string,
    toolExecution: {
      toolName: string
      arguments: Record<string, unknown>
      result: unknown
      durationMs: number
    }
  ): Promise<void> {
    // Tool execution logging would go here
    // For now, this is a placeholder
  }
  
  async getAgentById(agentId: string, workspaceId: string, userId: string): Promise<AgentRecord | null> {
    const { getAgentByExternalIdWithPermissionCheck } = await import("@/db/agent")
    try {
      const agent = await getAgentByExternalIdWithPermissionCheck(db, agentId, parseInt(workspaceId), parseInt(userId))
      if (!agent) return null
      
      return {
        id: agent.id,
        externalId: agent.externalId,
        name: agent.name,
        prompt: agent.prompt || "",
        systemPrompt: agent.systemPrompt || undefined,
        model: agent.model || undefined,
        tools: agent.tools || [],
        allowedApps: agent.allowedApps || [],
        resourceConstraints: {
          collectionIds: agent.allowedCollections || [],
          folderIds: agent.allowedFolders || [],
          fileIds: agent.allowedFiles || [],
        },
        workspaceId: String(agent.workspaceId),
      }
    } catch {
      return null
    }
  }
}
