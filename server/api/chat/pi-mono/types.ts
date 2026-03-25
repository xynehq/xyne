/**
 * Xyne Pi-Mono Types
 *
 * Type definitions for the Xyne pi-mono integration.
 */

import type { SelectChat, SelectMessage } from "@/db/schema"
import type { Citation } from "@/api/chat/types"
import type { AttachmentMetadata } from "@/shared/types"

/**
 * Parameters for bootstrapping a chat session
 */
export type ChatBootstrapParams = {
  chatId?: string
  email: string
  user: { id: number; email: string }
  workspace: { id: number; externalId: string }
  message: string
  fileIds: string[]
  attachmentMetadata: AttachmentMetadata[]
  modelId?: string
  agentId?: string | null
}

/**
 * Result of chat bootstrap operation
 */
export type ChatBootstrapResult = {
  chat: SelectChat
  userMessage: SelectMessage
  conversationHistory: SelectMessage[]
  attachmentError?: Error
}

/**
 * Context for persisting an assistant message
 */
export type PersistAssistantMessageContext = {
  chatRecord: SelectChat
  user: { id: number; email: string }
  workspace: { externalId: string }
  agenticModelId: string
  totalCost: number
  tokenUsage: { input: number; output: number }
  requestStartMs: number
}

/**
 * Data for persisting an assistant message
 */
export type PersistAssistantMessageData = {
  answer: string
  citations: Citation[]
  imageCitations: any[]
  citationMap: Record<number, number>
  thinkingLog: string
}
