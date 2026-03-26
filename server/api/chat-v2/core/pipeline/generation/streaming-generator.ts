/**
 * Streaming Generator
 * 
 * Generates streaming responses with citation extraction
 */

import type { GenerationPipeline, GenerationEvent, GenerationOptions } from "./generation-pipeline.interface"
import type { AssembledChatContext, Fragment, ConversationMessage } from "../../../models"
import type { Tool } from "../../../plugins/tools/tool.interface"
import type { RequestContextLike as RequestContext } from "../../orchestrator/request-context.types"
import type { CitationRegistry } from "../../../plugins/citations/citation-registry"

export interface StreamingGeneratorConfig {
  /** LLM provider function */
  llmProvider: LLMProvider
  /** Citation extractor */
  citationRegistry?: CitationRegistry
  /** Max tokens to generate */
  maxTokens?: number
  /** Temperature */
  temperature?: number
}

export interface LLMProvider {
  streamCompletion(params: {
    messages: Array<{ role: string; content: string }>
    model: string
    temperature?: number
    maxTokens?: number
    tools?: Tool[]
  }): AsyncIterable<LLMStreamEvent>
}

export type LLMStreamEvent =
  | { type: "token"; content: string }
  | { type: "tool-call"; tool: string; toolCallId: string; arguments: Record<string, unknown> }
  | { type: "error"; error: Error }
  | { type: "complete"; finishReason: string; usage?: { inputTokens: number; outputTokens: number } }

export class StreamingGenerator implements GenerationPipeline {
  private config: StreamingGeneratorConfig
  
  constructor(config: StreamingGeneratorConfig) {
    this.config = config
  }
  
  async *generate(
    context: AssembledChatContext,
    fragments: Fragment[],
    requestContext: RequestContext
  ): AsyncIterable<GenerationEvent> {
    const { llmProvider, citationRegistry } = this.config
    
    // Build messages from context
    const messages = this.buildMessages(context, fragments)
    
    // Build tools if agent mode
    const tools = context.agentConfig
      ? this.buildTools(context, requestContext)
      : undefined
    
    // Get model from config
    const model = context.agentConfig?.model || requestContext.config.defaultModel
    
    // Register citations from fragments
    if (citationRegistry) {
      for (const fragment of fragments) {
        citationRegistry.register(fragment.source)
      }
    }
    
    // Track accumulated text for citation extraction
    let accumulatedText = ""
    
    // Stream from LLM
    const stream = llmProvider.streamCompletion({
      messages,
      model,
      temperature: this.config.temperature ?? 0.7,
      maxTokens: this.config.maxTokens ?? 4096,
      tools,
    })
    
    for await (const event of stream) {
      switch (event.type) {
        case "token":
          accumulatedText += event.content
          
          // Extract citations from accumulated text
          if (citationRegistry) {
            const citations = this.extractCitationsFromText(accumulatedText)
            for (const citationIndex of citations) {
              const citation = citationRegistry.getByIndex(citationIndex)
              if (citation) {
                yield {
                  type: "citation",
                  citation: {
                    index: citationIndex,
                    docId: citation.docId,
                    title: citation.title || "Untitled",
                    url: citation.url,
                  },
                }
              }
            }
          }
          
          yield {
            type: "token",
            content: event.content,
          }
          break
          
        case "tool-call":
          yield {
            type: "tool-call",
            tool: event.tool,
            toolCallId: event.toolCallId,
            arguments: event.arguments,
          }
          break
          
        case "error":
          yield {
            type: "error",
            error: {
              code: "LLM_ERROR",
              message: event.error.message,
              recoverable: false,
            },
          }
          break
          
        case "complete":
          yield {
            type: "complete",
            finishReason: event.finishReason as any,
            usage: event.usage,
          }
          break
      }
    }
  }
  
  supportsCapability(capability: import("./generation-pipeline.interface").GenerationCapability): boolean {
    const capabilities: import("./generation-pipeline.interface").GenerationCapability[] = [
      "streaming",
      "tool-calling",
      "citations",
    ]
    return capabilities.includes(capability)
  }
  
  private buildMessages(
    context: AssembledChatContext,
    fragments: Fragment[]
  ): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = []
    
    // System prompt
    if (context.agentConfig?.systemPrompt) {
      messages.push({
        role: "system",
        content: context.agentConfig.systemPrompt,
      })
    }
    
    // Add context from fragments
    if (fragments.length > 0) {
      const contextPrompt = this.buildContextPrompt(fragments)
      messages.push({
        role: "system",
        content: contextPrompt,
      })
    }
    
    // Conversation history
    for (const msg of context.conversationHistory) {
      messages.push({
        role: msg.role,
        content: msg.content,
      })
    }
    
    // Current user message
    messages.push({
      role: "user",
      content: context.userMessage,
    })
    
    return messages
  }
  
  private buildContextPrompt(fragments: Fragment[]): string {
    const contextParts = fragments.map((f, i) => 
      `[${i + 1}] ${f.content.substring(0, 500)}${f.content.length > 500 ? "..." : ""}`
    )
    
    return `Use the following context to answer the user's question. Cite sources using [1], [2], etc. format.\n\n${contextParts.join("\n\n")}`
  }
  
  private buildTools(
    context: AssembledChatContext,
    requestContext: RequestContext
  ): Tool[] {
    // Get tools from registry based on agent config
    const toolRegistry = requestContext.tools
    
    if (context.agentConfig?.tools) {
      return context.agentConfig.tools
        .map(name => toolRegistry.get(name))
        .filter((t): t is Tool => !!t)
    }
    
    return []
  }
  
  private extractCitationsFromText(text: string): number[] {
    const citations: number[] = []
    const regex = /\[(\d+)\]/g
    let match
    
    while ((match = regex.exec(text)) !== null) {
      const index = parseInt(match[1], 10)
      if (!citations.includes(index)) {
        citations.push(index)
      }
    }
    
    return citations
  }
}
