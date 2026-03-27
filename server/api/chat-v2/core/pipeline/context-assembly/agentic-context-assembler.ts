/**
 * Agentic Chat Assembler
 *
 * Assembles context for tool-based agentic chat mode (MessageAgentsPiMono equivalent)
 *
 * DIFFERENCE from AgentContextAssembler:
 * - AgentContextAssembler: Loads documents based on allowedApps (RAG-based, for AgentMessageApi)
 * - AgenticChatAssembler: Loads tools and initializes empty state for multi-turn execution (tool-based, for MessageAgentsPiMono)
 *
 * Key characteristics:
 * - Tools are loaded from registry (not documents)
 * - Fragments are collected DURING execution via tool calls
 * - State is initialized empty and populated during the agent loop
 * - Uses episodic/chat memories for grounding (not document context)
 */

import {
  BaseContextAssembler,
  type RequestContext,
} from "./context-assembler.interface"
import type {
  AssembledChatContext,
  AgentConfig,
  ResourceConstraints,
  MemoryContext,
  ConversationMessage,
  AttachmentContext,
} from "../../../models"
import { Apps } from "@xyne/vespa-ts/types"

export interface AgenticContextAssemblerOptions {
  /** Agent ID to load configuration for (optional - agentic works without an agent) */
  agentId?: string
  /** Include resource constraints */
  includeConstraints?: boolean
}

/**
 * Extended context for agentic chat mode
 * Includes tool registry access and initial state setup
 */
export interface AgenticChatContext extends AssembledChatContext {
  /** Tool names that this agent is allowed to use */
  allowedTools?: string[]
  /** Resource constraints for the agent */
  resourceConstraints?: ResourceConstraints
}

export class AgenticContextAssembler extends BaseContextAssembler {
  private agenticOptions: AgenticContextAssemblerOptions

  constructor(
    baseOptions: import("./context-assembler.interface").ContextAssemblyOptions,
    agenticOptions: AgenticContextAssemblerOptions,
  ) {
    super({
      ...baseOptions,
      includeAgentConfig: true,
      includeHistory: true,
      includeEpisodicMemory: true,
      includeChatMemory: true,
      includeAttachments: true,
    })
    this.agenticOptions = agenticOptions
  }

  async assemble(requestContext: RequestContext): Promise<AgenticChatContext> {
    // Parallel assembly of context components
    // If agentId is provided, load agent config; otherwise use defaults
    const agentConfigPromise = this.agenticOptions.agentId
      ? this.loadAgentConfig(requestContext)
      : Promise.resolve(undefined)

    const [conversationHistory, memories, attachments, agentConfig] =
      await Promise.all([
        this.loadConversationHistory(requestContext),
        this.loadMemories(requestContext),
        this.loadAttachments(requestContext),
        agentConfigPromise,
      ])

    const { request } = requestContext

    return {
      userMessage: request.message,
      normalizedUserMessage: this.normalizeMessage(request.message),
      conversationHistory,
      memories,
      attachments,
      agentConfig,
      // Agentic-specific: tool list comes from agent config (if provided)
      // If no agent, all available tools can be used
      allowedTools: agentConfig?.tools,
      resourceConstraints: agentConfig?.resourceConstraints,
    }
  }

  async validate(requestContext: RequestContext): Promise<void> {
    await super.validate(requestContext)

    // Agent ID is optional for agentic mode
    // If provided, validate it exists
    if (this.agenticOptions.agentId) {
      const { persistence } = requestContext
      const agent = await persistence.getAgentById?.(
        this.agenticOptions.agentId,
        requestContext.user.workspaceId,
      )

      if (!agent) {
        throw new Error(`Agent not found: ${this.agenticOptions.agentId}`)
      }
    }
  }

  /**
   * Load agent configuration for agentic mode
   * Focuses on tools and identity, not document retrieval scope
   */
  private async loadAgentConfig(
    requestContext: RequestContext,
  ): Promise<AgentConfig> {
    const { persistence, user } = requestContext

    // Fetch agent with permission check
    const agent = await persistence.getAgentById?.(
      this.agenticOptions.agentId,
      user.workspaceId,
    )

    if (!agent) {
      throw new Error(`Agent not found: ${this.agenticOptions.agentId}`)
    }

    // Parse app integrations (allowed apps) - used for tool filtering
    const allowedApps = agent.allowedApps
      ? this.parseAppIntegrations(agent.allowedApps)
      : undefined

    // Parse resource constraints if present
    const resourceConstraints: ResourceConstraints | undefined =
      agent.resourceConstraints ? agent.resourceConstraints : undefined

    return {
      id: agent.id || this.agenticOptions.agentId,
      name: agent.name || "Agent",
      prompt: agent.prompt || "",
      systemPrompt: agent.systemPrompt,
      model: agent.model,
      // Tools are the key difference - agentic mode uses these for tool calling
      tools: agent.tools,
      allowedApps,
      resourceConstraints,
    }
  }

  /**
   * Load conversation history for the agent loop
   */
  private async loadConversationHistory(
    requestContext: RequestContext,
  ): Promise<ConversationMessage[]> {
    if (!this.options.includeHistory) {
      return []
    }

    const { persistence } = requestContext

    // Get recent messages from persistence layer
    const messages = await persistence.loadConversationHistory(
      requestContext.chat.externalId,
      this.options.historyLimit ?? 20,
    )

    return messages
  }

  /**
   * Load memories for agent grounding
   * Agentic mode uses memories for context, not pre-fetched documents
   */
  private async loadMemories(
    requestContext: RequestContext,
  ): Promise<MemoryContext | undefined> {
    const memories: MemoryContext = {}

    if (this.options.includeEpisodicMemory) {
      memories.episodic = await requestContext.memory.getEpisodicMemory(
        requestContext.user.id,
      )
    }

    if (this.options.includeChatMemory) {
      memories.chatHistory = await requestContext.memory.getChatHistoryMemory(
        requestContext.user.id,
        requestContext.chat.externalId,
      )
    }

    if (this.options.includeEpisodicMemory) {
      memories.workspace = await requestContext.memory.getWorkspaceMemory(
        requestContext.user.workspaceId,
      )
    }

    return Object.keys(memories).length > 0 ? memories : undefined
  }

  /**
   * Load attachments if present
   */
  private async loadAttachments(
    requestContext: RequestContext,
  ): Promise<AttachmentContext | undefined> {
    if (!this.options.includeAttachments) {
      return undefined
    }

    const { request } = requestContext

    if (!request.attachments || request.attachments.length === 0) {
      return undefined
    }

    // Process attachments
    return {
      files: request.attachments.map((att) => ({
        fileId: att.fileId || "",
        fileName: att.fileName,
        mimeType: att.mimeType,
        isImage: att.mimeType?.startsWith("image/") ?? false,
      })),
      // Fragments start empty - will be populated by attachment processing tools
      fragments: [],
      summary: "",
    }
  }

  private parseAppIntegrations(integrations: string[]): Apps[] {
    // Parse app integration strings to Apps enum values
    const appMap: Record<string, Apps> = {
      gmail: Apps.Gmail,
      drive: Apps.GoogleDrive,
      slack: Apps.Slack,
      calendar: Apps.GoogleCalendar,
      knowledge_base: Apps.KnowledgeBase,
      zoho_desk: Apps.ZohoDesk,
    }

    return integrations
      .map((app) => appMap[app.toLowerCase()])
      .filter((app): app is Apps => !!app)
  }
}
