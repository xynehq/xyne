import type { AttachmentMetadata } from "@/shared/types"
import type { Apps, Entity } from "@xyne/vespa-ts/types"
import type { Citation } from "./citation"
import type { Fragment } from "./fragment"

/**
 * Incoming chat request from HTTP API
 */
export interface ChatRequest {
  /** User's message text */
  message: string

  /** Existing chat ID (optional for new chats) */
  chatId?: string

  /** Agent ID for agentic mode */
  agentId?: string

  /** Whether to use agentic mode (tool-based retrieval) */
  isAgentic?: boolean

  /** Model and capability configuration */
  modelConfig?: ModelConfig

  /** File attachments */
  attachments?: AttachmentMetadata[]

  /** MCP connector tool configurations */
  toolsList?: MCPConnectorConfig[]
}

export interface ModelConfig {
  /** Model identifier */
  model: string

  /** Enable reasoning/thinking mode */
  reasoning?: boolean

  /** Enable web search capability */
  webSearch?: boolean

  /** Enable deep research mode */
  deepResearch?: boolean

  /** Sampling temperature */
  temperature?: number

  /** Maximum tokens to generate */
  maxTokens?: number

  metadata?: any
}

export interface MCPConnectorConfig {
  connectorId: string
  tools: string[]
}

/**
 * User context extracted from JWT
 */
export interface UserContext {
  id: string
  email: string
  workspaceId: string
  workspaceNumericId?: number
  timeZone: string
}

/**
 * Chat session context
 */
export interface ChatContext {
  id?: number
  externalId: string
  title?: string
  agentId?: string
  metadata: Record<string, unknown>
}

/**
 * Complete chat context assembled for processing
 */
export interface AssembledChatContext {
  userMessage: string
  normalizedUserMessage: string
  conversationHistory: ConversationMessage[]
  attachments?: AttachmentContext
  memories?: MemoryContext
  agentConfig?: AgentConfig
}

export interface ConversationMessage {
  role: "user" | "assistant" | "system" | "tool"
  content: string
  timestamp?: Date
  sources?: Citation[]
  toolCalls?: ToolCallReference[]
}

export interface AttachmentContext {
  files: AttachmentFile[]
  fragments: Fragment[]
  summary: string
}

export interface AttachmentFile {
  fileId: string
  fileName?: string
  mimeType?: string
  isImage: boolean
}

export interface MemoryContext {
  episodic?: string
  chatHistory?: string
  workspace?: string
}

export interface AgentConfig {
  id: string
  name: string
  prompt: string
  systemPrompt?: string
  model?: string
  tools?: string[]
  allowedApps?: Apps[]
  resourceConstraints?: ResourceConstraints
}

export interface ResourceConstraints {
  collectionIds?: string[]
  folderIds?: string[]
  fileIds?: string[]
  channelIds?: string[]
}

export interface ToolCallReference {
  id: string
  toolName: string
  arguments: Record<string, unknown>
}
