/**
 * Generation Pipeline Debug Wrapper
 * 
 * Wraps a generation pipeline to add detailed logging at each step
 */

import type { GenerationPipeline, GenerationEvent } from "./generation-pipeline.interface"
import type { AssembledChatContext, Fragment } from "../../../models"
import type { RequestContextLike as RequestContext } from "../../orchestrator/request-context.types"

export class DebugGenerationPipeline implements GenerationPipeline {
  private wrapped: GenerationPipeline
  private name: string

  constructor(wrapped: GenerationPipeline, name: string = "GenerationPipeline") {
    this.wrapped = wrapped
    this.name = name
  }

  async *generate(
    context: AssembledChatContext,
    fragments: Fragment[],
    requestContext: RequestContext
  ): AsyncIterable<GenerationEvent> {
    console.log(`[${this.name}] ========== GENERATION START ==========`)
    console.log(`[${this.name}] User message: ${context.userMessage.substring(0, 50)}...`)
    console.log(`[${this.name}] Fragments count: ${fragments.length}`)
    console.log(`[${this.name}] Conversation history length: ${context.conversationHistory?.length || 0}`)
    
    try {
      let eventCount = 0
      
      for await (const event of this.wrapped.generate(context, fragments, requestContext)) {
        eventCount++
        console.log(`[${this.name}] Event #${eventCount}: ${event.type}`)
        
        if (event.type === "token") {
          console.log(`[${this.name}] Token: "${event.content?.substring(0, 30)}..."`)
        } else if (event.type === "error") {
          console.error(`[${this.name}] Error: ${event.error.message}`)
        }
        
        yield event
      }
      
      console.log(`[${this.name}] ========== GENERATION COMPLETE (${eventCount} events) ==========`)
    } catch (error) {
      console.error(`[${this.name}] CRITICAL ERROR:`, error)
      console.error(`[${this.name}] Error stack:`, error instanceof Error ? error.stack : "no stack")
      
      // Re-throw the error so it can be handled upstream
      throw error
    }
  }

  supportsCapability(capability: import("./generation-pipeline.interface").GenerationCapability): boolean {
    return this.wrapped.supportsCapability(capability)
  }
}
