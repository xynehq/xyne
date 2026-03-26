/**
 * Unified Vespa Retriever
 * 
 * REPLACES: Multiple retriever pattern with single Vespa-based retriever
 * All document retrieval goes through Vespa, filtered by app type.
 * 
 * BENEFITS:
 *   - Single source of truth for search
 *   - App-based filtering instead of separate retrievers
 *   - Unified ranking and scoring
 *   - Simpler architecture
 */

import type { Fragment } from "../../models"
import type { RequestContextLike as RequestContext } from "../../core/orchestrator/request-context.types"
import type { Apps, Entity } from "@xyne/vespa-ts/types"

/**
 * Vespa Retriever - Single retriever for all document sources
 */
export interface VespaRetriever {
  /** Retriever name */
  readonly name: string
  
  /**
   * Search across all apps or specific apps
   * @param query - Search query
   * @param options - Search options including app filters
   * @param context - Request context for auth/workspace scoping
   * @yields Retrieval results
   */
  search(
    query: string,
    options: VespaSearchOptions,
    context: RequestContext
  ): AsyncIterable<VespaRetrievalResult>
  
  /**
   * Search specific app (convenience method)
   */
  searchApp(
    query: string,
    app: Apps,
    options: Omit<VespaSearchOptions, "apps">,
    context: RequestContext
  ): AsyncIterable<VespaRetrievalResult>
  
  /**
   * Search Knowledge Base with scoping
   */
  searchKnowledgeBase(
    query: string,
    kbOptions: KnowledgeBaseSearchOptions,
    context: RequestContext
  ): AsyncIterable<VespaRetrievalResult>
}

/**
 * Options for Vespa search
 */
export interface VespaSearchOptions {
  /** Filter by apps (if not specified, searches all allowed apps) */
  apps?: Apps[]
  /** Filter by entity types */
  entities?: Entity[]
  /** Maximum results to return */
  limit?: number
  /** Pagination offset */
  offset?: number
  /** Minimum confidence threshold */
  minConfidence?: number
  /** Time range filter */
  timestampRange?: {
    from?: Date
    to?: Date
  }
  /** IDs to exclude from results */
  excludedIds?: string[]
  /** Specific schema to search */
  schema?: string
  /** Mail participant filter */
  mailParticipant?: {
    name?: string
    email?: string
  }
  /** Channel IDs for Slack search */
  channelIds?: string[]
  /** Owner filter for Drive */
  owner?: string
  /** Event status filter for Calendar */
  eventStatus?: string
  /** Agent app restrictions */
  agentAppEnums?: Apps[]
}

/**
 * Knowledge Base specific search options
 */
export interface KnowledgeBaseSearchOptions extends VespaSearchOptions {
  /** Collection IDs to scope to */
  collectionIds?: string[]
  /** Folder IDs to scope to */
  collectionFolderIds?: string[]
  /** File IDs to scope to */
  collectionFileIds?: string[]
  /** Structured collection selections (preferred) */
  collectionSelections?: Array<{
    collectionIds?: string[]
    collectionFolderIds?: string[]
    collectionFileIds?: string[]
  }>
}

/**
 * Result from Vespa retrieval
 */
export interface VespaRetrievalResult {
  /** Retrieved fragments */
  fragments: Fragment[]
  
  /** Source app */
  app: Apps
  
  /** Confidence score (0-1) */
  confidence: number
  
  /** Query used */
  query: string
  
  /** Execution metadata */
  metadata: {
    /** Time taken in milliseconds */
    durationMs: number
    /** Total documents searched */
    documentsSearched: number
    /** Apps that were searched */
    searchedApps: Apps[]
    /** Any errors encountered */
    errors?: string[]
  }
}

/**
 * App-specific search strategies
 */
export interface AppSearchStrategy {
  app: Apps
  /** Build app-specific query enhancements */
  enhanceQuery?(baseQuery: string, options: VespaSearchOptions): string
  /** App-specific result transformation */
  transformResult?(rawResult: any): Fragment
  /** Check if app is available for user */
  isAvailable?(context: RequestContext): Promise<boolean>
}
