/**
 * Retriever Registry - Simplified for Unified Vespa Architecture
 * 
 * Since all retrieval goes through Vespa, this registry primarily:
 * - Manages the single Vespa retriever instance
 * - Provides convenience methods for app-specific searches
 * - Maintains compatibility with the pipeline interface
 */

import type { VespaRetriever, VespaSearchOptions, VespaRetrievalResult } from "./vespa-retriever.interface"
import type { RequestContextLike as RequestContext } from "../../core/orchestrator/request-context.types"
import type { Apps } from "@xyne/vespa-ts/types"

export class RetrieverRegistry {
  private vespaRetriever: VespaRetriever | undefined
  
  /**
   * Register the Vespa retriever
   */
  register(retriever: VespaRetriever): void {
    this.vespaRetriever = retriever
  }
  
  /**
   * Get the Vespa retriever
   */
  get(): VespaRetriever {
    if (!this.vespaRetriever) {
      throw new Error("Vespa retriever not registered")
    }
    return this.vespaRetriever
  }
  
  /**
   * Check if retriever is registered
   */
  isRegistered(): boolean {
    return !!this.vespaRetriever
  }
  
  /**
   * Search across all apps
   */
  async *search(
    query: string,
    options: VespaSearchOptions,
    context: RequestContext
  ): AsyncIterable<VespaRetrievalResult> {
    const retriever = this.get()
    yield* retriever.search(query, options, context)
  }
  
  /**
   * Search specific app
   */
  async *searchApp(
    query: string,
    app: Apps,
    options: Omit<VespaSearchOptions, "apps">,
    context: RequestContext
  ): AsyncIterable<VespaRetrievalResult> {
    const retriever = this.get()
    yield* retriever.searchApp(query, app, options, context)
  }
  
  /**
   * Search Knowledge Base
   */
  async *searchKnowledgeBase(
    query: string,
    options: import("./vespa-retriever.interface").KnowledgeBaseSearchOptions,
    context: RequestContext
  ): AsyncIterable<VespaRetrievalResult> {
    const retriever = this.get()
    yield* retriever.searchKnowledgeBase(query, options, context)
  }
}

export const retrieverRegistry = new RetrieverRegistry()
