/**
 * Unified Vespa Retriever Implementation
 * 
 * Bridges to existing search functionality in server/search/vespa.ts
 * All document retrieval goes through this single retriever.
 */

import type {
  VespaRetriever,
  VespaSearchOptions,
  KnowledgeBaseSearchOptions,
  VespaRetrievalResult,
} from "./vespa-retriever.interface"
import { RetrievalSource, type Fragment, type Citation } from "../../models"
import type { RequestContextLike as RequestContext } from "../../core/orchestrator/request-context.types"
import { Apps, type Entity } from "@xyne/vespa-ts/types"

// Import existing search functions (adapter pattern)
import { executeVespaSearch } from "@/api/chat/tools/global"
import {
  buildKnowledgeBaseCollectionSelections,
  KnowledgeBaseScope,
} from "@/api/chat/knowledgeBaseSelections"
import type { MinimalAgentFragment } from "@/api/chat/types"

export interface UnifiedVespaRetrieverOptions {
  /** Default result limit */
  defaultLimit?: number
  /** Default ranking profile */
  rankingProfile?: string
  /** Enable connector status checks */
  checkConnectorStatus?: boolean
}

export class UnifiedVespaRetriever implements VespaRetriever {
  readonly name = "vespa"
  
  private options: UnifiedVespaRetrieverOptions
  
  constructor(options: UnifiedVespaRetrieverOptions = {}) {
    this.options = {
      defaultLimit: 15,
      rankingProfile: "default",
      checkConnectorStatus: true,
      ...options,
    }
  }
  
  async *search(
    query: string,
    options: VespaSearchOptions,
    context: RequestContext
  ): AsyncIterable<VespaRetrievalResult> {
    const startTime = Date.now()
    const searchedApps: Apps[] = []
    const errors: string[] = []
    
    try {
      // Determine which apps to search
      const appsToSearch = await this.determineAppsToSearch(options, context)
      
      // Build search parameters
      const searchParams = this.buildSearchParams(query, options, context)
      
      // Execute search
      let results: MinimalAgentFragment[]
      
      if (options.agentAppEnums && options.agentAppEnums.length > 0) {
        // Agent-scoped search with app restrictions
        results = await executeVespaSearch({
          ...searchParams,
          agentAppEnums: options.agentAppEnums,
        })
        searchedApps.push(...options.agentAppEnums)
      } else {
        // Regular search
        results = await executeVespaSearch(searchParams)
        searchedApps.push(...(appsToSearch || Object.values(Apps)))
      }
      
      // Transform to fragments
      const fragments = results.map((result, index) =>
        this.transformToFragment(result, index, query)
      )
      
      // Calculate confidence
      const confidence = this.calculateConfidence(fragments)
      
      yield {
        fragments,
        app: appsToSearch?.[0] || Apps.KnowledgeBase, // Primary app
        confidence,
        query,
        metadata: {
          durationMs: Date.now() - startTime,
          documentsSearched: results.length,
          searchedApps,
          errors: errors.length > 0 ? errors : undefined,
        },
      }
    } catch (error) {
      yield {
        fragments: [],
        app: Apps.KnowledgeBase,
        confidence: 0,
        query,
        metadata: {
          durationMs: Date.now() - startTime,
          documentsSearched: 0,
          searchedApps,
          errors: [error instanceof Error ? error.message : String(error)],
        },
      }
    }
  }
  
  async *searchApp(
    query: string,
    app: Apps,
    options: Omit<VespaSearchOptions, "apps">,
    context: RequestContext
  ): AsyncIterable<VespaRetrievalResult> {
    yield* this.search(query, { ...options, apps: [app] }, context)
  }
  
  async *searchKnowledgeBase(
    query: string,
    kbOptions: KnowledgeBaseSearchOptions,
    context: RequestContext
  ): AsyncIterable<VespaRetrievalResult> {
    const startTime = Date.now()
    
    try {
      // Build KB selections from options
      const collectionSelections = this.buildKBSelections(kbOptions)
      
      // Determine KB scope (agent-scoped vs user-owned)
      const agentPrompt = context.getMetadata("agentPrompt") as string | undefined
      const kbScope = agentPrompt ? KnowledgeBaseScope.AgentScoped : KnowledgeBaseScope.UserOwned
      
      // Get base selections based on scope
      const baseSelections = await buildKnowledgeBaseCollectionSelections({
        scope: kbScope,
        email: context.user.email,
        selectedItems: agentPrompt ? this.parseSelectedItems(agentPrompt) : {},
      })
      
      // Merge with specific selections from options
      const finalSelections = collectionSelections.length > 0
        ? collectionSelections
        : baseSelections
      
      // Execute KB search via Vespa
      const results = await executeVespaSearch({
        email: context.user.email,
        query,
        app: Apps.KnowledgeBase,
        agentAppEnums: [Apps.KnowledgeBase],
        limit: kbOptions.limit ?? this.options.defaultLimit,
        offset: kbOptions.offset ?? 0,
        excludedIds: kbOptions.excludedIds,
        collectionSelections: finalSelections,
        userId: context.user.workspaceNumericId,
        workspaceId: context.user.workspaceNumericId,
      })
      
      // Transform to fragments
      const fragments = results.map((result, index) =>
        this.transformToFragment(result, index, query)
      )
      
      yield {
        fragments,
        app: Apps.KnowledgeBase,
        confidence: this.calculateConfidence(fragments),
        query,
        metadata: {
          durationMs: Date.now() - startTime,
          documentsSearched: results.length,
          searchedApps: [Apps.KnowledgeBase],
        },
      }
    } catch (error) {
      yield {
        fragments: [],
        app: Apps.KnowledgeBase,
        confidence: 0,
        query,
        metadata: {
          durationMs: Date.now() - startTime,
          documentsSearched: 0,
          searchedApps: [Apps.KnowledgeBase],
          errors: [error instanceof Error ? error.message : String(error)],
        },
      }
    }
  }
  
  /**
   * Determine which apps to search based on options and context
   */
  private async determineAppsToSearch(
    options: VespaSearchOptions,
    context: RequestContext
  ): Promise<Apps[] | null> {
    // If specific apps requested, use those
    if (options.apps && options.apps.length > 0) {
      return options.apps
    }
    
    // If agent has app restrictions, respect those
    if (options.agentAppEnums && options.agentAppEnums.length > 0) {
      return options.agentAppEnums
    }
    
    // Otherwise search all apps (null = no app filter)
    return null
  }
  
  /**
   * Build search parameters for executeVespaSearch
   */
  private buildSearchParams(
    query: string,
    options: VespaSearchOptions,
    context: RequestContext
  ): any {
    const params: any = {
      email: context.user.email,
      query,
      app: options.apps ?? null,
      entity: options.entities ?? null,
      limit: options.limit ?? this.options.defaultLimit,
      offset: options.offset ?? 0,
      excludedIds: options.excludedIds,
      agentAppEnums: options.agentAppEnums,
      channelIds: options.channelIds,
      mailParticipant: options.mailParticipant,
      owner: options.owner,
      eventStatus: options.eventStatus,
      userId: context.user.workspaceNumericId,
      workspaceId: context.user.workspaceNumericId,
    }
    
    // Add timestamp range if provided
    if (options.timestampRange) {
      params.timestampRange = {
        from: options.timestampRange.from?.getTime(),
        to: options.timestampRange.to?.getTime(),
      }
    }
    
    return params
  }
  
  /**
   * Build KB selections from options
   */
  private buildKBSelections(kbOptions: KnowledgeBaseSearchOptions): any[] {
    // If structured selections provided, use those
    if (kbOptions.collectionSelections && kbOptions.collectionSelections.length > 0) {
      return kbOptions.collectionSelections
    }
    
    // Build from individual IDs
    const selection: any = {}
    if (kbOptions.collectionIds?.length) {
      selection.collectionIds = kbOptions.collectionIds
    }
    if (kbOptions.collectionFolderIds?.length) {
      selection.collectionFolderIds = kbOptions.collectionFolderIds
    }
    if (kbOptions.collectionFileIds?.length) {
      selection.collectionFileIds = kbOptions.collectionFileIds
    }
    
    return Object.keys(selection).length > 0 ? [selection] : []
  }
  
  /**
   * Parse selected items from agent prompt
   */
  private parseSelectedItems(agentPrompt: string): Record<string, string[]> {
    try {
      const parsed = JSON.parse(agentPrompt)
      return parsed.selectedItems || {}
    } catch {
      return {}
    }
  }
  
  /**
   * Transform Vespa result to Fragment
   */
  private transformToFragment(result: MinimalAgentFragment, index: number, query: string): Fragment {
    // MinimalAgentFragment has content and source (Citation) properties
    const content = result.content || ""
    const source = result.source
    
    const citation: Citation = {
      docId: source.docId || `result_${index}`,
      title: source.title || "Untitled",
      url: source.url,
      app: source.app || Apps.KnowledgeBase,
      entity: source.entity,
      chunkIndex: source.chunkIndices?.[0],
      metadata: {
        ...source,
      },
    }
    
    return {
      id: `vespa_${citation.docId}_${index}`,
      content: content.substring(0, 2000), // Limit content length
      source: citation,
      confidence: result.confidence || 0.5,
      metadata: {
        chunkIndex: citation.chunkIndex,
        app: citation.app,
        entity: citation.entity,
      },
    }
  }
  
  /**
   * Calculate overall confidence from fragments
   */
  private calculateConfidence(fragments: Fragment[]): number {
    if (fragments.length === 0) return 0
    const avgConfidence = fragments.reduce((sum, f) => sum + f.confidence, 0) / fragments.length
    return Math.min(1, avgConfidence)
  }
}
