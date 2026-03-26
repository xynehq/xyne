/**
 * Prompt Builder Service Interface
 * 
 * Constructs prompts for LLM interactions
 */

import type { AssembledChatContext, AgentConfig, ConversationMessage } from "../models"

export interface PromptBuilderService {
  /**
   * Build the system prompt
   */
  buildSystemPrompt(
    config: PromptBuildConfig
  ): string
  
  /**
   * Build the user message with context
   */
  buildUserPrompt(
    assembledContext: AssembledChatContext
  ): string
  
  /**
   * Build conversation messages array for LLM
   */
  buildConversationMessages(
    systemPrompt: string,
    history: ConversationMessage[],
    userMessage: string
  ): ConversationMessage[]
  
  /**
   * Build tool selection prompt
   */
  buildToolSelectionPrompt(
    userMessage: string,
    availableTools: string[]
  ): string
}

export interface PromptBuildConfig {
  agentConfig?: AgentConfig
  hasAttachments?: boolean
  hasMemories?: boolean
  mode: "normal" | "agentic" | "attachment"
  capabilities?: {
    webSearch?: boolean
    reasoning?: boolean
    deepResearch?: boolean
  }
}
