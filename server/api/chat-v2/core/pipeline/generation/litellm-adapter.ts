/**
 * LiteLLM Generation Adapter
 * 
 * Bridges the existing LiteLLM infrastructure to the Chat V2 GenerationPipeline interface
 */

import type { GenerationPipeline, GenerationEvent } from "./generation-pipeline.interface"
import type { AssembledChatContext, Fragment } from "../../../models"
import type { RequestContextLike as RequestContext } from "../../orchestrator/request-context.types"
import type { Tool } from "../../../plugins/tools/tool.interface"

export class LiteLLMGenerationPipeline implements GenerationPipeline {
  async *generate(
    context: AssembledChatContext,
    fragments: Fragment[],
    requestContext: RequestContext
  ): AsyncIterable<GenerationEvent> {
    try {
      // Import LiteLLM provider dynamically to avoid circular dependencies
      const { generateWithProvider } = await import("@/ai/provider")
      const { Models } = await import("@/ai/types")
      
      // Build messages from context
      const messages = this.buildMessages(context, fragments)
      
      // Get model from config or use default
      const model = context.agentConfig?.model || requestContext.config.defaultModel || Models.GPT_4o
      
      console.log(`[LiteLLMGenerationPipeline] Generating with model: ${model}`)
      console.log(`[LiteLLMGenerationPipeline] Messages count: ${messages.length}`)
      
      // Track if we've started receiving tokens
      let hasStarted = false
      
      // Call LiteLLM provider
      const response = await generateWithProvider({
        messages,
        model,
        stream: true,
      })
      
      if (!response) {
        throw new Error("No response from LLM provider")
      }
      
      // Handle streaming response
      if (typeof response[Symbol.asyncIterator] === 'function') {
        // It's an async iterable (stream)
        for await (const chunk of response as AsyncIterable<any>) {
          if (!hasStarted) {
            hasStarted = true
            console.log("[LiteLLMGenerationPipeline] Started receiving tokens")
          }
          
          const content = chunk.choices?.[0]?.delta?.content || chunk.content
          if (content) {
            yield {
              type: "token",
              content,
            }
          }
          
          // Check for completion
          if (chunk.choices?.[0]?.finish_reason) {
            yield {
              type: "complete",
              finishReason: this.mapFinishReason(chunk.choices[0].finish_reason),
            }
          }
        }
      } else {
        // It's a complete response
        const content = response.content || response.choices?.[0]?.message?.content
        if (content) {
          yield {
            type: "token",
            content,
          }
        }
        
        yield {
          type: "complete",
          finishReason: "stop",
        }
      }
      
      console.log("[LiteLLMGenerationPipeline] Generation complete")
      
    } catch (error) {
      console.error("[LiteLLMGenerationPipeline] Error:", error)
      yield {
        type: "error",
        error: {
          code: "GENERATION_ERROR",
          message: error instanceof Error ? error.message : "Unknown generation error",
          recoverable: false,
        },
      }
    }
  }
  
  supportsCapability(capability: import("./generation-pipeline.interface").GenerationCapability): boolean {
    const capabilities = [
      "streaming",
      "tool-calling",
      "citations",
      "reasoning",
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
    } else {
      // Default system prompt
      messages.push({
        role: "system",
        content: "You are a helpful AI assistant.",
      })
    }
    
    // Add context from fragments
    if (fragments.length > 0) {
      const contextContent = fragments
        .map((f, i) => `[${i + 1}] ${f.content.substring(0, 500)}${f.content.length > 500 ? "..." : ""}`)
        .join("\n\n")
      
      messages.push({
        role: "system",
        content: `Use the following context to answer the user's question. Cite sources using [1], [2], etc. format.\n\n${contextContent}`,
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
  
  private mapFinishReason(reason: string): "stop" | "length" | "tool-calls" | "error" {
    switch (reason) {
      case "stop":
        return "stop"
      case "length":
        return "length"
      case "tool_calls":
        return "tool-calls"
      default:
        return "error"
    }
  }
}
