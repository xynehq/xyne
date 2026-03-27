# Phase 2: Pipeline Implementation - Detailed Migration Guide

## Overview

**Duration**: 2 weeks  
**Goal**: Implement the core pipeline components - Context Assembly, Retrieval (single Vespa-based), and Generation  
**Risk Level**: Medium (new implementations, but isolated from production)  
**Rollback Strategy**: Feature flag disables new pipeline code, falls back to legacy implementation  

---

## Phase 2 Objectives

1. Implement Context Assembler - Extract and isolate context preparation logic
2. **Implement Unified Vespa Retriever** - Single retriever with app-based filtering (NOT multiple retrievers)
3. Implement Generation Pipeline - Streaming and synthesis generators
4. Create Citation Handler abstractions
5. Implement base service layer (Memory, Persistence, PromptBuilder)
6. Build adapter layer to bridge existing Vespa search code
7. Add comprehensive tests for all pipeline components

---

## Key Architectural Insight: Single Vespa Retriever

**IMPORTANT**: Unlike the initial design with multiple retrievers (Vespa, KB, etc.), the actual architecture uses a **single Vespa backend** for all document retrieval. Different data sources are filtered by the `app` parameter:

```typescript
// All searches go through Vespa, differentiated by app filter
Apps.Gmail           // Gmail messages
Apps.GoogleDrive     // Drive files
Apps.Slack           // Slack messages
Apps.KnowledgeBase   // KB documents
Apps.GoogleCalendar  // Calendar events
// ... etc
```

**Knowledge Base search** is NOT a separate retriever - it's Vespa search with:
- `app: Apps.KnowledgeBase`
- Additional scoping via `collectionSelections` (collection/folder/file IDs)

---

## Week 1: Context Assembly & Unified Vespa Retriever

### Day 1-2: Context Assembler Implementation

#### 1.1 Create Context Assembler Interface

**server/api/chat-v2/core/pipeline/context-assembly/context-assembler.interface.ts**
```typescript
/**
 * Context Assembler Interface
 * 
 * REPLACES: Context preparation logic scattered in message-agents.ts (lines 200-400)
 * BENEFITS:
 *   - Isolated context assembly per chat mode
 *   - Testable independently
 *   - Easy to customize for different modes
 */

import type { AssembledChatContext, ChatRequest, UserContext, ChatContext } from "../../../models"
import type { RequestContext } from "../../orchestrator/request-context"

/**
 * Context Assembler - Prepares all context needed for chat processing
 */
export interface ContextAssembler {
  /**
   * Assemble complete chat context
   * @param requestContext - Request-scoped context with dependencies
   * @returns Fully assembled chat context
   */
  assemble(requestContext: RequestContext): Promise<AssembledChatContext>
  
  /**
   * Validate that required context is available
   * @param requestContext - Request context
   * @throws Error if required context is missing
   */
  validate(requestContext: RequestContext): Promise<void>
}

/**
 * Context assembly options
 */
export interface ContextAssemblyOptions {
  /** Include conversation history */
  includeHistory?: boolean
  /** Number of history messages to include */
  historyLimit?: number
  /** Include episodic memories */
  includeEpisodicMemory?: boolean
  /** Include chat memories */
  includeChatMemory?: boolean
  /** Include attachments */
  includeAttachments?: boolean
  /** Include agent configuration */
  includeAgentConfig?: boolean
}

/**
 * Base context assembler with common functionality
 */
export abstract class BaseContextAssembler implements ContextAssembler {
  protected options: ContextAssemblyOptions
  
  constructor(options: ContextAssemblyOptions = {}) {
    this.options = {
      includeHistory: true,
      historyLimit: 20,
      includeEpisodicMemory: true,
      includeChatMemory: true,
      includeAttachments: true,
      includeAgentConfig: false,
      ...options,
    }
  }
  
  abstract assemble(requestContext: RequestContext): Promise<AssembledChatContext>
  
  async validate(requestContext: RequestContext): Promise<void> {
    // Base validation - ensure user and chat are present
    if (!requestContext.user?.id) {
      throw new Error("User context is required")
    }
    if (!requestContext.request?.message) {
      throw new Error("User message is required")
    }
  }
  
  /**
   * Normalize user message (trim, clean, etc.)
   */
  protected normalizeMessage(message: string): string {
    return message.trim().replace(/\s+/g, " ")
  }
}
```

#### 1.2 Implement Normal Context Assembler

**server/api/chat-v2/core/pipeline/context-assembly/normal-context-assembler.ts**
```typescript
/**
 * Normal Context Assembler
 * 
 * Assembles context for standard chat mode (no agent)
 */

import { BaseContextAssembler } from "./context-assembler.interface"
import type { AssembledChatContext, ConversationMessage, MemoryContext } from "../../../models"
import type { RequestContext } from "../../orchestrator/request-context"

export class NormalContextAssembler extends BaseContextAssembler {
  async assemble(requestContext: RequestContext): Promise<AssembledChatContext> {
    const { request, user, chat } = requestContext
    
    // Parallel assembly of independent components
    const [
      conversationHistory,
      memories,
      attachments,
    ] = await Promise.all([
      this.loadConversationHistory(requestContext),
      this.loadMemories(requestContext),
      this.loadAttachments(requestContext),
    ])
    
    return {
      userMessage: request.message,
      normalizedUserMessage: this.normalizeMessage(request.message),
      conversationHistory,
      memories,
      attachments,
    }
  }
  
  private async loadConversationHistory(
    requestContext: RequestContext
  ): Promise<ConversationMessage[]> {
    if (!this.options.includeHistory) {
      return []
    }
    
    const { persistence, memory } = requestContext
    
    // Get recent messages from persistence layer
    const messages = await persistence.getRecentMessages(
      requestContext.chat.externalId,
      this.options.historyLimit ?? 20
    )
    
    return messages.map(msg => ({
      role: msg.role as "user" | "assistant" | "system" | "tool",
      content: msg.content,
      timestamp: msg.createdAt,
      sources: msg.sources,
      toolCalls: msg.toolCalls,
    }))
  }
  
  private async loadMemories(
    requestContext: RequestContext
  ): Promise<MemoryContext | undefined> {
    const memories: MemoryContext = {}
    
    if (this.options.includeEpisodicMemory) {
      memories.episodic = await requestContext.memory.getEpisodicMemories(
        requestContext.user.id,
        requestContext.request.message
      )
    }
    
    if (this.options.includeChatMemory) {
      memories.chatHistory = await requestContext.memory.getChatMemories(
        requestContext.chat.externalId,
        requestContext.request.message
      )
    }
    
    return Object.keys(memories).length > 0 ? memories : undefined
  }
  
  private async loadAttachments(
    requestContext: RequestContext
  ): Promise<import("../../../models").AttachmentContext | undefined> {
    if (!this.options.includeAttachments) {
      return undefined
    }
    
    const { request } = requestContext
    
    if (!request.attachments || request.attachments.length === 0) {
      return undefined
    }
    
    // Process attachments through persistence service
    return requestContext.persistence.prepareAttachmentContext(
      request.attachments
    )
  }
}
```

#### 1.3 Implement Agent Context Assembler

**server/api/chat-v2/core/pipeline/context-assembly/agent-context-assembler.ts**
```typescript
/**
 * Agent Context Assembler
 * 
 * Assembles context for agentic chat mode
 * Includes agent configuration, allowed apps, constraints
 */

import { BaseContextAssembler } from "./context-assembler.interface"
import type { AssembledChatContext, AgentConfig, ResourceConstraints } from "../../../models"
import type { RequestContext } from "../../orchestrator/request-context"
import { Apps } from "@xyne/vespa-ts/types"

export interface AgentContextAssemblyOptions {
  /** Load agent configuration by ID */
  agentId: string
  /** Include resource constraints */
  includeConstraints?: boolean
  /** Include allowed apps */
  includeAllowedApps?: boolean
}

export class AgentContextAssembler extends BaseContextAssembler {
  private agentOptions: AgentContextAssemblyOptions
  
  constructor(
    baseOptions: import("./context-assembler.interface").ContextAssemblyOptions,
    agentOptions: AgentContextAssemblyOptions
  ) {
    super({
      ...baseOptions,
      includeAgentConfig: true,
    })
    this.agentOptions = agentOptions
  }
  
  async assemble(requestContext: RequestContext): Promise<AssembledChatContext> {
    // First assemble base context
    const baseAssembler = new (await import("./normal-context-assembler")).NormalContextAssembler(this.options)
    const baseContext = await baseAssembler.assemble(requestContext)
    
    // Add agent-specific context
    const agentConfig = await this.loadAgentConfig(requestContext)
    
    return {
      ...baseContext,
      agentConfig,
    }
  }
  
  async validate(requestContext: RequestContext): Promise<void> {
    await super.validate(requestContext)
    
    if (!this.agentOptions.agentId) {
      throw new Error("Agent ID is required for agent context assembly")
    }
  }
  
  private async loadAgentConfig(
    requestContext: RequestContext
  ): Promise<AgentConfig> {
    const { persistence, user } = requestContext
    
    // Fetch agent with permission check
    const agent = await persistence.getAgentById(
      this.agentOptions.agentId,
      user.workspaceId
    )
    
    if (!agent) {
      throw new Error(`Agent not found: ${this.agentOptions.agentId}`)
    }
    
    // Parse app integrations (allowed apps)
    const allowedApps = agent.appIntegrations
      ? this.parseAppIntegrations(agent.appIntegrations)
      : undefined
    
    // Parse resource constraints if present
    const resourceConstraints: ResourceConstraints | undefined = 
      agent.allowedCollections || agent.allowedFolders
        ? {
            collectionIds: agent.allowedCollections,
            folderIds: agent.allowedFolders,
            fileIds: agent.allowedFiles,
          }
        : undefined
    
    return {
      id: agent.externalId,
      name: agent.name,
      prompt: agent.prompt,
      systemPrompt: agent.systemPrompt,
      model: agent.model,
      tools: agent.tools,
      allowedApps,
      resourceConstraints,
    }
  }
  
  private parseAppIntegrations(integrations: string[]): Apps[] {
    // Parse app integration strings to Apps enum values
    const appMap: Record<string, Apps> = {
      "gmail": Apps.Gmail,
      "drive": Apps.GoogleDrive,
      "slack": Apps.Slack,
      "calendar": Apps.GoogleCalendar,
      "contacts": Apps.GoogleContacts,
      "knowledge_base": Apps.KnowledgeBase,
      "zoho_desk": Apps.ZohoDesk,
    }
    
    return integrations
      .map(app => appMap[app.toLowerCase()])
      .filter((app): app is Apps => !!app)
  }
}
```

#### 1.4 Create Context Assembler Registry

**server/api/chat-v2/core/pipeline/context-assembly/context-assembler-registry.ts**
```typescript
/**
 * Context Assembler Registry
 * 
 * Maps chat modes to appropriate assemblers
 */

import type { ContextAssembler } from "./context-assembler.interface"
import type { ChatMode } from "../../strategies/chat-mode-strategy"

export class ContextAssemblerRegistry {
  private assemblers = new Map<ChatMode, ContextAssembler>()
  private defaultAssembler: ContextAssembler | undefined
  
  /**
   * Register an assembler for a chat mode
   */
  register(mode: ChatMode, assembler: ContextAssembler): void {
    if (this.assemblers.has(mode)) {
      console.warn(`Assembler for mode "${mode}" already registered, overwriting`)
    }
    this.assemblers.set(mode, assembler)
  }
  
  /**
   * Set default assembler
   */
  setDefault(assembler: ContextAssembler): void {
    this.defaultAssembler = assembler
  }
  
  /**
   * Get assembler for mode
   */
  get(mode: ChatMode): ContextAssembler | undefined {
    return this.assemblers.get(mode)
  }
  
  /**
   * Get assembler or throw
   */
  getOrThrow(mode: ChatMode): ContextAssembler {
    const assembler = this.get(mode) ?? this.defaultAssembler
    if (!assembler) {
      throw new Error(`No assembler registered for mode "${mode}" and no default set`)
    }
    return assembler
  }
  
  /**
   * Check if mode has registered assembler
   */
  has(mode: ChatMode): boolean {
    return this.assemblers.has(mode)
  }
  
  /**
   * Get all registered modes
   */
  getRegisteredModes(): ChatMode[] {
    return Array.from(this.assemblers.keys())
  }
  
  /**
   * Unregister assembler
   */
  unregister(mode: ChatMode): boolean {
    return this.assemblers.delete(mode)
  }
}

export const contextAssemblerRegistry = new ContextAssemblerRegistry()
```

**server/api/chat-v2/core/pipeline/context-assembly/index.ts**
```typescript
export * from "./context-assembler.interface"
export * from "./normal-context-assembler"
export * from "./agent-context-assembler"
export * from "./context-assembler-registry"
```

### Day 3-5: Unified Vespa Retriever

#### 2.1 Create Vespa Retriever Interface

**server/api/chat-v2/plugins/retrievers/vespa-retriever.interface.ts**
```typescript
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

import type { Fragment, RetrievalSource } from "../../models"
import type { RequestContext } from "../../core/orchestrator/request-context"
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
```

#### 2.2 Implement Unified Vespa Retriever

**server/api/chat-v2/plugins/retrievers/vespa-retriever.ts**
```typescript
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
import type { RequestContext } from "../../core/orchestrator/request-context"
import { Apps, type Entity } from "@xyne/vespa-ts/types"

// Import existing search functions (adapter pattern)
import { searchVespa, searchVespaAgent } from "../../../search/vespa"
import { executeVespaSearch } from "../../../api/chat/tools/global"
import { buildKnowledgeBaseCollectionSelections, KnowledgeBaseScope } from "../../../api/chat/knowledgeBaseSelections"

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
      let results: any[]
      
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
  private transformToFragment(result: any, index: number, query: string): Fragment {
    // Handle different result formats from executeVespaSearch
    const docId = result.source?.docId || result.id || `result_${index}`
    const content = result.content || result.text || result.fields?.content || ""
    const app = result.app || result.fields?.app || Apps.KnowledgeBase
    
    const citation: Citation = {
      docId,
      title: result.title || result.fields?.title || "Untitled",
      url: result.url || result.fields?.url,
      app: app as Apps,
      entity: result.entity || result.fields?.entity,
      chunkIndex: result.chunkIndex || result.fields?.chunkIndex,
      metadata: {
        ...result.fields,
        ...result.metadata,
      },
    }
    
    return {
      id: `vespa_${docId}_${index}`,
      content: content.substring(0, 2000), // Limit content length
      source: citation,
      confidence: result.score || result.confidence || 0.5,
      metadata: {
        chunkIndex: result.chunkIndex || result.fields?.chunkIndex,
        totalChunks: result.totalChunks || result.fields?.totalChunks,
        timestamp: result.timestamp || result.fields?.timestamp,
        author: result.author || result.fields?.author,
        app,
        entity: result.entity || result.fields?.entity,
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
```

#### 2.3 Create Retriever Registry (Simple Wrapper)

**server/api/chat-v2/plugins/retrievers/retriever-registry.ts**
```typescript
/**
 * Retriever Registry - Simplified for Unified Vespa Architecture
 * 
 * Since all retrieval goes through Vespa, this registry primarily:
 * - Manages the single Vespa retriever instance
 * - Provides convenience methods for app-specific searches
 * - Maintains compatibility with the pipeline interface
 */

import type { VespaRetriever, VespaSearchOptions, VespaRetrievalResult } from "./vespa-retriever.interface"
import type { RequestContext } from "../../core/orchestrator/request-context"
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
```

**server/api/chat-v2/plugins/retrievers/index.ts**
```typescript
export * from "./vespa-retriever.interface"
export * from "./vespa-retriever"
export * from "./retriever-registry"
```

---

## Week 2: Generation Pipeline & Services

### Day 6-7: Generation Pipeline Interface

#### 3.1 Create Generation Pipeline Interface

**server/api/chat-v2/core/pipeline/generation/generation-pipeline.interface.ts**
```typescript
/**
 * Generation Pipeline Interface
 * 
 * Handles LLM response generation with streaming support
 */

import type { AssembledChatContext, Fragment, Tool } from "../../../models"
import type { RequestContext } from "../../orchestrator/request-context"

/**
 * Generation Pipeline - Produces LLM responses
 */
export interface GenerationPipeline {
  /**
   * Generate response for chat context
   * @param context - Assembled chat context
   * @param fragments - Retrieved fragments for context
   * @param requestContext - Request-scoped dependencies
   * @yields Generation events (tokens, tool calls, citations)
   */
  generate(
    context: AssembledChatContext,
    fragments: Fragment[],
    requestContext: RequestContext
  ): AsyncIterable<GenerationEvent>
  
  /**
   * Optional: Check if pipeline supports specific capabilities
   */
  supportsCapability?(capability: GenerationCapability): boolean
}

/**
 * Generation capability flags
 */
export type GenerationCapability =
  | "streaming"
  | "tool-calling"
  | "citations"
  | "images"
  | "reasoning"
  | "structured-output"

/**
 * Events emitted during generation
 */
export type GenerationEvent =
  | TokenEvent
  | ToolCallEvent
  | ToolResultEvent
  | CitationEvent
  | ReasoningEvent
  | ErrorEvent
  | CompleteEvent

export interface TokenEvent {
  type: "token"
  content: string
  /** Citation references within this token chunk */
  citations?: number[]
}

export interface ToolCallEvent {
  type: "tool-call"
  tool: string
  toolCallId: string
  arguments: Record<string, unknown>
}

export interface ToolResultEvent {
  type: "tool-result"
  tool: string
  toolCallId: string
  result: unknown
  success: boolean
}

export interface CitationEvent {
  type: "citation"
  citation: {
    index: number
    docId: string
    title: string
    url?: string
  }
}

export interface ReasoningEvent {
  type: "reasoning"
  step: string
  details?: Record<string, unknown>
}

export interface ErrorEvent {
  type: "error"
  error: {
    code: string
    message: string
    recoverable: boolean
  }
}

export interface CompleteEvent {
  type: "complete"
  finishReason: "stop" | "length" | "tool-calls" | "error"
  usage?: {
    inputTokens: number
    outputTokens: number
  }
}

/**
 * Generation options
 */
export interface GenerationOptions {
  /** Model to use */
  model?: string
  /** Temperature */
  temperature?: number
  /** Max tokens */
  maxTokens?: number
  /** Enable streaming */
  streaming?: boolean
  /** Available tools */
  tools?: Tool[]
  /** System prompt */
  systemPrompt?: string
}
```

#### 3.2 Implement Streaming Generator

**server/api/chat-v2/core/pipeline/generation/streaming-generator.ts**
```typescript
/**
 * Streaming Generator
 * 
 * Generates streaming responses with citation extraction
 */

import type { GenerationPipeline, GenerationEvent, GenerationOptions } from "./generation-pipeline.interface"
import type { AssembledChatContext, Fragment, Tool } from "../../../models"
import type { RequestContext } from "../../orchestrator/request-context"

export interface StreamingGeneratorConfig {
  /** LLM provider function */
  llmProvider: LLMProvider
  /** Citation extractor */
  citationHandler?: import("../../../plugins/citations/citation-handler.interface").CitationHandler
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
    const { llmProvider, citationHandler } = this.config
    
    // Build messages from context
    const messages = this.buildMessages(context, fragments)
    
    // Build tools if agent mode
    const tools = context.agentConfig
      ? this.buildTools(context, requestContext)
      : undefined
    
    // Get model from config
    const model = context.agentConfig?.model || requestContext.config.defaultModel
    
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
          if (citationHandler) {
            const citations = await this.extractCitations(
              accumulatedText,
              fragments,
              citationHandler
            )
            for (const citation of citations) {
              yield citation
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
    
    return toolRegistry.getForMode("agentic" as any)
  }
  
  private async extractCitations(
    text: string,
    fragments: Fragment[],
    citationHandler: import("../../../plugins/citations/citation-handler.interface").CitationHandler
  ): Promise<import("./generation-pipeline.interface").CitationEvent[]> {
    const citations: import("./generation-pipeline.interface").CitationEvent[] = []
    
    for await (const event of citationHandler.extractCitations(text, fragments, null as any)) {
      if (event.citation) {
        citations.push({
          type: "citation",
          citation: {
            index: event.citation.index,
            docId: event.citation.item.docId,
            title: event.citation.item.title || "Untitled",
            url: event.citation.item.url,
          },
        })
      }
    }
    
    return citations
  }
}
```

### Day 8-10: Service Layer Implementation

#### 4.1 Implement Memory Service

**server/api/chat-v2/services/memory.service.ts**
```typescript
/**
 * Memory Service
 * 
 * Manages episodic and chat memory retrieval
 */

export interface MemoryService {
  /**
   * Get episodic memories for user
   */
  getEpisodicMemories(userId: string, query: string): Promise<string>
  
  /**
   * Get chat history memories
   */
  getChatMemories(chatId: string, query: string): Promise<string>
  
  /**
   * Add episodic memory
   */
  addEpisodicMemory(userId: string, content: string, importance?: number): Promise<void>
  
  /**
   * Add chat memory
   */
  addChatMemory(chatId: string, message: string, response: string): Promise<void>
}

/**
 * Bridge to existing memory retrieval functions
 */
export class HybridMemoryService implements MemoryService {
  async getEpisodicMemories(userId: string, query: string): Promise<string> {
    // Bridge to existing episodic memory retriever
    const { retrieveEpisodicMemories } = await import("../../../services/episodicMemoryRetriever")
    return retrieveEpisodicMemories(userId, query)
  }
  
  async getChatMemories(chatId: string, query: string): Promise<string> {
    // Bridge to existing chat memory retriever
    const { retrieveRelevantChatHistory } = await import("../../../services/chatMemoryRetriever")
    return retrieveRelevantChatHistory(chatId, query)
  }
  
  async addEpisodicMemory(userId: string, content: string, importance?: number): Promise<void> {
    // Bridge to existing memory storage
    const { storeEpisodicMemory } = await import("../../../services/memoryStorage")
    await storeEpisodicMemory(userId, content, importance)
  }
  
  async addChatMemory(chatId: string, message: string, response: string): Promise<void> {
    // Bridge to existing chat memory storage
    const { storeChatMemory } = await import("../../../services/memoryStorage")
    await storeChatMemory(chatId, message, response)
  }
}
```

#### 4.2 Implement Persistence Service

**server/api/chat-v2/services/persistence.service.ts**
```typescript
/**
 * Persistence Service
 * 
 * Handles database operations for chat persistence
 */

import type { AttachmentMetadata } from "../../../shared/types"

export interface PersistenceService {
  // Chat operations
  getOrCreateChat(externalId: string, userId: string, workspaceId: string): Promise<ChatRecord>
  updateChatTitle(chatId: string, title: string): Promise<void>
  
  // Message operations
  getRecentMessages(chatId: string, limit: number): Promise<MessageRecord[]>
  saveUserMessage(chatId: string, content: string, metadata?: Record<string, unknown>): Promise<MessageRecord>
  saveAssistantMessage(
    chatId: string,
    content: string,
    citations?: CitationRecord[],
    metadata?: Record<string, unknown>
  ): Promise<MessageRecord>
  
  // Agent operations
  getAgentById(agentId: string, workspaceId: string): Promise<AgentRecord | null>
  
  // Attachment operations
  prepareAttachmentContext(attachments: AttachmentMetadata[]): Promise<AttachmentContext>
  
  // Trace/audit operations
  saveTrace(trace: TraceRecord): Promise<void>
}

export interface ChatRecord {
  id: number
  externalId: string
  userId: string
  workspaceId: string
  title?: string
  createdAt: Date
  updatedAt: Date
  metadata: Record<string, unknown>
}

export interface MessageRecord {
  id: number
  chatId: number
  role: string
  content: string
  createdAt: Date
  sources?: any[]
  toolCalls?: any[]
  metadata: Record<string, unknown>
}

export interface AgentRecord {
  id: number
  externalId: string
  name: string
  prompt: string
  systemPrompt?: string
  model?: string
  tools?: string[]
  allowedApps?: string[]
  appIntegrations?: string[]
  allowedCollections?: string[]
  allowedFolders?: string[]
  allowedFiles?: string[]
  workspaceId: string
}

export interface AttachmentContext {
  files: Array<{
    fileId: string
    fileName?: string
    mimeType?: string
    isImage: boolean
  }>
  fragments: Array<{
    id: string
    content: string
    source: any
  }>
  summary: string
}

export interface CitationRecord {
  docId: string
  title: string
  url?: string
  app: string
  entity: string
  chunkIndex?: number
}

export interface TraceRecord {
  chatId: string
  requestId: string
  events: Array<{
    type: string
    timestamp: Date
    data: Record<string, unknown>
  }>
  metadata: Record<string, unknown>
}

/**
 * Bridge to existing database operations
 */
export class DatabasePersistenceService implements PersistenceService {
  async getOrCreateChat(
    externalId: string,
    userId: string,
    workspaceId: string
  ): Promise<ChatRecord> {
    const { getChatByExternalId, createChat } = await import("../../../db/chat")
    
    let chat = await getChatByExternalId(externalId)
    
    if (!chat) {
      chat = await createChat({
        externalId,
        userId,
        workspaceId,
        title: "New Chat",
      })
    }
    
    return chat as ChatRecord
  }
  
  async updateChatTitle(chatId: string, title: string): Promise<void> {
    const { updateChat } = await import("../../../db/chat")
    await updateChat(chatId, { title })
  }
  
  async getRecentMessages(chatId: string, limit: number): Promise<MessageRecord[]> {
    const { getChatMessages } = await import("../../../db/message")
    return getChatMessages(chatId, limit)
  }
  
  async saveUserMessage(
    chatId: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<MessageRecord> {
    const { createMessage } = await import("../../../db/message")
    return createMessage({
      chatId,
      role: "user",
      content,
      metadata,
    })
  }
  
  async saveAssistantMessage(
    chatId: string,
    content: string,
    citations?: CitationRecord[],
    metadata?: Record<string, unknown>
  ): Promise<MessageRecord> {
    const { createMessage } = await import("../../../db/message")
    return createMessage({
      chatId,
      role: "assistant",
      content,
      sources: citations,
      metadata,
    })
  }
  
  async getAgentById(agentId: string, workspaceId: string): Promise<AgentRecord | null> {
    const { getAgentByExternalIdWithPermissionCheck } = await import("../../../db/agent")
    return getAgentByExternalIdWithPermissionCheck(agentId, workspaceId)
  }
  
  async prepareAttachmentContext(
    attachments: AttachmentMetadata[]
  ): Promise<AttachmentContext> {
    // Bridge to existing attachment processing
    const { processAttachments } = await import("../../../utils/attachments")
    return processAttachments(attachments)
  }
  
  async saveTrace(trace: TraceRecord): Promise<void> {
    const { saveChatTrace } = await import("../../../db/trace")
    await saveChatTrace(trace)
  }
}
```

#### 4.3 Implement Prompt Builder Service

**server/api/chat-v2/services/prompt-builder.service.ts**
```typescript
/**
 * Prompt Builder Service
 * 
 * Composes prompts from sections
 */

import type { AssembledChatContext, AgentConfig } from "../models"

export interface PromptBuilderService {
  /**
   * Build complete system prompt
   */
  buildSystemPrompt(context: AssembledChatContext): string
  
  /**
   * Build tool instructions
   */
  buildToolInstructions(tools: string[]): string
  
  /**
   * Build context section from fragments
   */
  buildContextSection(fragments: Array<{ content: string; source: any }>): string
  
  /**
   * Build agent-specific prompt
   */
  buildAgentPrompt(agent: AgentConfig): string
}

export interface PromptSection {
  name: string
  content: string
  priority: number
  condition?: (context: AssembledChatContext) => boolean
}

export class ModularPromptBuilder implements PromptBuilderService {
  private sections: PromptSection[] = []
  
  constructor() {
    this.registerDefaultSections()
  }
  
  registerSection(section: PromptSection): void {
    this.sections.push(section)
    // Sort by priority
    this.sections.sort((a, b) => b.priority - a.priority)
  }
  
  buildSystemPrompt(context: AssembledChatContext): string {
    const applicableSections = this.sections
      .filter(s => !s.condition || s.condition(context))
      .map(s => s.content)
    
    return applicableSections.join("\n\n")
  }
  
  buildToolInstructions(tools: string[]): string {
    if (tools.length === 0) return ""
    
    return `You have access to the following tools:\n${tools.map(t => `- ${t}`).join("\n")}\n\nUse these tools when appropriate to help answer the user's question.`
  }
  
  buildContextSection(fragments: Array<{ content: string; source: any }>): string {
    if (fragments.length === 0) return ""
    
    const contextParts = fragments.map((f, i) => {
      const citation = `[${i + 1}]`
      return `${citation} ${f.content.substring(0, 500)}${f.content.length > 500 ? "..." : ""}`
    })
    
    return `Relevant context:\n\n${contextParts.join("\n\n")}\n\nCite sources using [1], [2], etc. format when referencing this context.`
  }
  
  buildAgentPrompt(agent: AgentConfig): string {
    const parts: string[] = []
    
    if (agent.systemPrompt) {
      parts.push(agent.systemPrompt)
    }
    
    parts.push(agent.prompt)
    
    if (agent.tools && agent.tools.length > 0) {
      parts.push(this.buildToolInstructions(agent.tools))
    }
    
    return parts.join("\n\n")
  }
  
  private registerDefaultSections(): void {
    this.registerSection({
      name: "identity",
      content: "You are a helpful AI assistant.",
      priority: 100,
    })
    
    this.registerSection({
      name: "citation-format",
      content: "Always cite your sources using [1], [2], etc. format when referencing external information.",
      priority: 90,
    })
    
    this.registerSection({
      name: "agent-context",
      content: "",
      priority: 80,
      condition: (ctx) => !!ctx.agentConfig,
    })
  }
}
```

**server/api/chat-v2/services/index.ts**
```typescript
export * from "./memory.service"
export * from "./persistence.service"
export * from "./prompt-builder.service"
```

### Day 11-14: Update Dependency Container & Testing

#### 5.1 Update Dependency Container with Real Implementations

**server/api/chat-v2/core/orchestrator/dependency-container.ts**
```typescript
/**
 * Dependency Container - Updated for Phase 2
 * 
 * Now wires up real implementations instead of mocks
 */

import { ToolRegistry } from "../../plugins/tools/tool-registry"
import { RetrieverRegistry, UnifiedVespaRetriever } from "../../plugins/retrievers"
import { CitationRegistry } from "../../plugins/citations/citation-registry"
import { HybridMemoryService, DatabasePersistenceService, ModularPromptBuilder } from "../../services"
import type { MemoryService, PersistenceService, PromptBuilderService } from "../../services"
import { NormalContextAssembler, AgentContextAssembler, contextAssemblerRegistry } from "../pipeline/context-assembly"
import { ChatMode } from "../strategies/chat-mode-strategy"

export interface DependencyContainer {
  // Registries
  tools: ToolRegistry
  retrievers: RetrieverRegistry
  citations: CitationRegistry
  assemblers: typeof contextAssemblerRegistry
  
  // Services
  memory: MemoryService
  persistence: PersistenceService
  promptBuilder: PromptBuilderService
  
  // Configuration
  config: ChatConfig
}

export interface ChatConfig {
  defaultModel: string
  defaultFastModel: string
  defaultAgenticModel?: string
  maxTurns: number
  maxTokens: number
  reviewFrequency: number
  features: {
    reasoning: boolean
    webSearch: boolean
    deepResearch: boolean
    delegation: boolean
  }
}

/**
 * Factory for creating dependency container with real implementations
 */
export function createDependencyContainer(
  overrides?: Partial<DependencyContainer>
): DependencyContainer {
  // Create registries
  const tools = new ToolRegistry()
  const retrievers = new RetrieverRegistry()
  const citations = new CitationRegistry()
  
  // Create services
  const memory = new HybridMemoryService()
  const persistence = new DatabasePersistenceService()
  const promptBuilder = new ModularPromptBuilder()
  
  // Register unified Vespa retriever
  retrievers.register(new UnifiedVespaRetriever())
  
  // Register context assemblers
  contextAssemblerRegistry.register(
    ChatMode.Normal,
    new NormalContextAssembler()
  )
  contextAssemblerRegistry.register(
    ChatMode.Agentic,
    new AgentContextAssembler(
      { includeAgentConfig: true },
      { agentId: "" } // Will be set at runtime
    )
  )
  contextAssemblerRegistry.setDefault(
    new NormalContextAssembler()
  )
  
  return {
    tools: overrides?.tools ?? tools,
    retrievers: overrides?.retrievers ?? retrievers,
    citations: overrides?.citations ?? citations,
    assemblers: contextAssemblerRegistry,
    memory: overrides?.memory ?? memory,
    persistence: overrides?.persistence ?? persistence,
    promptBuilder: overrides?.promptBuilder ?? promptBuilder,
    config: overrides?.config ?? getDefaultConfig(),
  }
}

function getDefaultConfig(): ChatConfig {
  return {
    defaultModel: "gpt-4o",
    defaultFastModel: "gpt-4o-mini",
    maxTurns: 10,
    maxTokens: 4096,
    reviewFrequency: 5,
    features: {
      reasoning: true,
      webSearch: true,
      deepResearch: false,
      delegation: true,
    },
  }
}
```

#### 5.2 Create Tests for Pipeline Components

**server/api/chat-v2/core/pipeline/context-assembly/__tests__/normal-context-assembler.test.ts**
```typescript
/**
 * Tests for NormalContextAssembler
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { NormalContextAssembler } from "../normal-context-assembler"
import type { RequestContext } from "../../../orchestrator/request-context"
import type { ChatRequest, UserContext, ChatContext } from "../../../../models"

describe("NormalContextAssembler", () => {
  let assembler: NormalContextAssembler
  let mockContext: RequestContext
  
  beforeEach(() => {
    assembler = new NormalContextAssembler()
    
    mockContext = {
      request: { message: "Hello, how are you?" } as ChatRequest,
      user: { id: "user-123", workspaceId: "ws-456" } as UserContext,
      chat: { externalId: "chat-789", metadata: {} } as ChatContext,
      persistence: {
        getRecentMessages: vi.fn().mockResolvedValue([]),
        prepareAttachmentContext: vi.fn(),
      },
      memory: {
        getEpisodicMemories: vi.fn().mockResolvedValue(""),
        getChatMemories: vi.fn().mockResolvedValue(""),
        addEpisodicMemory: vi.fn(),
        addChatMemory: vi.fn(),
      },
    } as unknown as RequestContext
  })
  
  it("should assemble basic context", async () => {
    const result = await assembler.assemble(mockContext)
    
    expect(result.userMessage).toBe("Hello, how are you?")
    expect(result.normalizedUserMessage).toBe("Hello, how are you?")
    expect(result.conversationHistory).toEqual([])
  })
  
  it("should normalize user message", async () => {
    mockContext.request.message = "  Hello   world  "
    
    const result = await assembler.assemble(mockContext)
    
    expect(result.normalizedUserMessage).toBe("Hello world")
  })
  
  it("should load conversation history when enabled", async () => {
    const history = [
      { role: "user", content: "Previous message" },
      { role: "assistant", content: "Previous response" },
    ]
    mockContext.persistence.getRecentMessages = vi.fn().mockResolvedValue(history)
    
    const result = await assembler.assemble(mockContext)
    
    expect(result.conversationHistory).toHaveLength(2)
    expect(mockContext.persistence.getRecentMessages).toHaveBeenCalledWith("chat-789", 20)
  })
  
  it("should skip history when disabled", async () => {
    assembler = new NormalContextAssembler({ includeHistory: false })
    
    const result = await assembler.assemble(mockContext)
    
    expect(result.conversationHistory).toEqual([])
    expect(mockContext.persistence.getRecentMessages).not.toHaveBeenCalled()
  })
  
  it("should validate required context", async () => {
    mockContext.user.id = ""
    
    await expect(assembler.validate(mockContext)).rejects.toThrow("User context is required")
  })
  
  it("should validate message presence", async () => {
    mockContext.request.message = ""
    
    await expect(assembler.validate(mockContext)).rejects.toThrow("User message is required")
  })
})
```

**server/api/chat-v2/plugins/retrievers/__tests__/vespa-retriever.test.ts**
```typescript
/**
 * Tests for UnifiedVespaRetriever
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { UnifiedVespaRetriever } from "../vespa-retriever"
import { Apps } from "@xyne/vespa-ts/types"
import type { RequestContext } from "../../../core/orchestrator/request-context"

// Mock the existing search functions
vi.mock("../../../../search/vespa", () => ({
  searchVespa: vi.fn(),
  searchVespaAgent: vi.fn(),
}))

vi.mock("../../../../api/chat/tools/global", () => ({
  executeVespaSearch: vi.fn(),
}))

describe("UnifiedVespaRetriever", () => {
  let retriever: UnifiedVespaRetriever
  let mockContext: RequestContext
  
  beforeEach(() => {
    retriever = new UnifiedVespaRetriever()
    
    mockContext = {
      user: {
        email: "test@example.com",
        workspaceNumericId: 123,
      },
      getMetadata: vi.fn().mockReturnValue(undefined),
    } as unknown as RequestContext
  })
  
  it("should search all apps by default", async () => {
    const { executeVespaSearch } = await import("../../../../api/chat/tools/global")
    executeVespaSearch.mockResolvedValue([
      { id: "1", content: "Result 1", score: 0.9 },
    ])
    
    const results: any[] = []
    for await (const result of retriever.search("test query", {}, mockContext)) {
      results.push(result)
    }
    
    expect(results).toHaveLength(1)
    expect(results[0].fragments).toHaveLength(1)
    expect(results[0].metadata.searchedApps).toBeNull() // All apps
  })
  
  it("should search specific app", async () => {
    const { executeVespaSearch } = await import("../../../../api/chat/tools/global")
    executeVespaSearch.mockResolvedValue([])
    
    const results: any[] = []
    for await (const result of retriever.searchApp(
      "test query",
      Apps.Gmail,
      {},
      mockContext
    )) {
      results.push(result)
    }
    
    expect(executeVespaSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        app: [Apps.Gmail],
      })
    )
  })
  
  it("should use agent app restrictions", async () => {
    const { executeVespaSearch } = await import("../../../../api/chat/tools/global")
    executeVespaSearch.mockResolvedValue([])
    
    const results: any[] = []
    for await (const result of retriever.search(
      "test query",
      { agentAppEnums: [Apps.Gmail, Apps.GoogleDrive] },
      mockContext
    )) {
      results.push(result)
    }
    
    expect(executeVespaSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        agentAppEnums: [Apps.Gmail, Apps.GoogleDrive],
      })
    )
  })
  
  it("should search Knowledge Base with scoping", async () => {
    const { executeVespaSearch } = await import("../../../../api/chat/tools/global")
    executeVespaSearch.mockResolvedValue([
      { id: "kb-1", content: "KB Result", app: Apps.KnowledgeBase, score: 0.85 },
    ])
    
    const results: any[] = []
    for await (const result of retriever.searchKnowledgeBase(
      "test query",
      { collectionIds: ["col-123"] },
      mockContext
    )) {
      results.push(result)
    }
    
    expect(results).toHaveLength(1)
    expect(results[0].app).toBe(Apps.KnowledgeBase)
    expect(results[0].fragments).toHaveLength(1)
  })
  
  it("should handle search errors gracefully", async () => {
    const { executeVespaSearch } = await import("../../../../api/chat/tools/global")
    executeVespaSearch.mockRejectedValue(new Error("Search failed"))
    
    const results: any[] = []
    for await (const result of retriever.search("test query", {}, mockContext)) {
      results.push(result)
    }
    
    expect(results).toHaveLength(1)
    expect(results[0].fragments).toEqual([])
    expect(results[0].confidence).toBe(0)
    expect(results[0].metadata.errors).toContain("Search failed")
  })
  
  it("should transform results to fragments correctly", async () => {
    const { executeVespaSearch } = await import("../../../../api/chat/tools/global")
    executeVespaSearch.mockResolvedValue([
      {
        id: "doc-1",
        content: "Document content",
        title: "Doc Title",
        app: Apps.GoogleDrive,
        entity: "file",
        score: 0.92,
        url: "https://drive.google.com/...",
      },
    ])
    
    const results: any[] = []
    for await (const result of retriever.search("test query", {}, mockContext)) {
      results.push(result)
    }
    
    const fragment = results[0].fragments[0]
    expect(fragment.id).toContain("doc-1")
    expect(fragment.content).toBe("Document content")
    expect(fragment.source.title).toBe("Doc Title")
    expect(fragment.source.app).toBe(Apps.GoogleDrive)
    expect(fragment.confidence).toBe(0.92)
  })
})
```

---

## Phase 2 Deliverables

### Code Structure

```
server/api/chat-v2/
├── core/
│   ├── pipeline/
│   │   ├── context-assembly/
│   │   │   ├── context-assembler.interface.ts
│   │   │   ├── normal-context-assembler.ts
│   │   │   ├── agent-context-assembler.ts
│   │   │   ├── context-assembler-registry.ts
│   │   │   └── __tests__/
│   │   │       └── normal-context-assembler.test.ts
│   │   └── generation/
│   │       ├── generation-pipeline.interface.ts
│   │       └── streaming-generator.ts
│   └── orchestrator/
│       └── dependency-container.ts       # Updated with real implementations
├── plugins/
│   ├── retrievers/
│   │   ├── vespa-retriever.interface.ts  # Unified interface
│   │   ├── vespa-retriever.ts            # Single Vespa retriever
│   │   ├── retriever-registry.ts         # Simplified registry
│   │   ├── index.ts
│   │   └── __tests__/
│   │       └── vespa-retriever.test.ts
│   └── citations/
│       └── (Phase 2.5 - see below)
└── services/
    ├── memory.service.ts
    ├── persistence.service.ts
    ├── prompt-builder.service.ts
    └── index.ts
```

### Components Implemented

1. **Context Assemblers**
   - `ContextAssembler` interface
   - `NormalContextAssembler` - Standard chat context
   - `AgentContextAssembler` - Agent-specific context with app restrictions
   - `ContextAssemblerRegistry` - Mode-to-assembler mapping

2. **Unified Vespa Retriever** ⭐
   - `UnifiedVespaRetriever` - **Single retriever for ALL document sources**
   - App-based filtering (`Apps.Gmail`, `Apps.KnowledgeBase`, etc.)
   - Agent-scoped search with `agentAppEnums` restrictions
   - Knowledge Base search with collection/folder/file scoping
   - Simplified `RetrieverRegistry`

3. **Generation Pipeline**
   - `GenerationPipeline` interface with streaming events
   - `StreamingGenerator` - Token streaming with citation extraction
   - Support for tool calling and reasoning events

4. **Service Layer**
   - `MemoryService` - Episodic and chat memory
   - `PersistenceService` - Database operations
   - `PromptBuilderService` - Modular prompt composition

5. **Updated DI Container**
   - Real implementations wired up
   - Unified Vespa retriever registered
   - Context assemblers registered

### Key Architectural Decision: Unified Vespa Retriever

**Before (Initial Design):**
```typescript
// Multiple retrievers
registry.register(new VespaRetriever())
registry.register(new KnowledgeBaseRetriever())
registry.register(new GmailRetriever())
// ... etc
```

**After (Correct Architecture):**
```typescript
// Single Vespa retriever with app filtering
retrievers.register(new UnifiedVespaRetriever())

// Usage:
retrievers.searchApp(query, Apps.Gmail, options, context)
retrievers.searchApp(query, Apps.KnowledgeBase, kbOptions, context)
retrievers.search(query, { apps: [Apps.Gmail, Apps.Slack] }, context)
```

**Why This Matters:**
- **Single source of truth** - All search goes through Vespa
- **Unified ranking** - Consistent scoring across all apps
- **Simpler architecture** - No need for multiple retriever implementations
- **Consistent with existing code** - Matches current implementation

### Bridge Components

All components use adapter pattern to bridge to existing code:

| New Component | Bridges To | File |
|--------------|-----------|------|
| UnifiedVespaRetriever | executeVespaSearch() | server/api/chat/tools/global/index.ts |
| UnifiedVespaRetriever | searchVespaAgent() | server/search/vespa.ts |
| UnifiedVespaRetriever | buildKnowledgeBaseCollectionSelections() | server/api/chat/knowledgeBaseSelections.ts |
| HybridMemoryService | retrieveEpisodicMemories() | server/services/episodicMemoryRetriever.ts |
| DatabasePersistenceService | getChatByExternalId(), createChat() | server/db/chat.ts |
| StreamingGenerator | LLM streaming via pi-mono/JAF | server/api/chat/pi-mono/ |

---

## Integration Points

### Using Unified Vespa Retriever

```typescript
// Example: Search across all apps
const results: Fragment[] = []
for await (const result of requestContext.retrievers.search(
  chatContext.normalizedUserMessage,
  { limit: 20 },
  requestContext
)) {
  results.push(...result.fragments)
}

// Example: Search specific app (Gmail)
const gmailResults: Fragment[] = []
for await (const result of requestContext.retrievers.searchApp(
  query,
  Apps.Gmail,
  { limit: 10 },
  requestContext
)) {
  gmailResults.push(...result.fragments)
}

// Example: Search Knowledge Base with scoping
const kbResults: Fragment[] = []
for await (const result of requestContext.retrievers.searchKnowledgeBase(
  query,
  { collectionIds: ["col-123"], folderIds: ["fld-456"] },
  requestContext
)) {
  kbResults.push(...result.fragments)
}

// Example: Agent-scoped search (respects agent app restrictions)
const agentResults: Fragment[] = []
for await (const result of requestContext.retrievers.search(
  query,
  { 
    agentAppEnums: agentConfig.allowedApps, // Only these apps
    limit: 15 
  },
  requestContext
)) {
  agentResults.push(...result.fragments)
}
```

---

## Next Steps (Phase 3 Preview)

After Phase 2 is complete:

1. **Citation Handler Implementation**
   - `CitationHandler` interface
   - `StandardCitationHandler` for [1], [2] format
   - `ChunkCitationHandler` for K[1_0] format

2. **Chat Mode Strategies**
   - `NormalChatStrategy` - Simple direct generation
   - `AgenticChatStrategy` - Full agent loop with tools
   - `AttachmentChatStrategy` - Attachment-first context

3. **Orchestrator Implementation**
   - Route requests to appropriate strategy
   - Manage request lifecycle
   - Handle SSE streaming

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Vespa API changes | Adapter layer isolates changes (executeVespaSearch) |
| App filtering complexity | Unified interface handles all filtering |
| KB scoping complexity | KB-specific method with clear options |
| Database schema changes | Service interface abstracts schema |
| LLM provider differences | Generation pipeline uses provider abstraction |
| Memory leaks in pipelines | RequestContext ensures cleanup |

---

## Success Criteria

- [ ] Context assemblers correctly extract all context types
- [ ] UnifiedVespaRetriever correctly searches all apps
- [ ] KB search correctly applies collection/folder/file scoping
- [ ] Agent-scoped search respects app restrictions
- [ ] Streaming generator produces correct event sequence
- [ ] All services bridge correctly to existing code
- [ ] 90%+ test coverage for pipeline components
- [ ] No breaking changes to existing endpoints
- [ ] Feature flag controls new code path
- [ ] Performance parity with existing implementation

---

## Migration Notes

### Understanding the Unified Architecture

**Current Flow (Legacy):**
```
User Query
    ↓
Tool Selection (searchGmail, searchDrive, searchKnowledgeBase)
    ↓
Each tool calls executeVespaSearch() with different app filters
    ↓
executeVespaSearch() → searchVespa() or searchVespaAgent()
    ↓
Vespa Search
```

**New Flow (Phase 2):**
```
User Query
    ↓
UnifiedVespaRetriever.search() or searchApp()
    ↓
executeVespaSearch() (bridge to existing)
    ↓
searchVespa() or searchVespaAgent()
    ↓
Vespa Search
```

**Key Difference:**
- Old: Multiple tools call search → each adds own logic
- New: Single retriever handles all apps → cleaner abstraction

### Gradual Adoption

The pipeline components can be adopted incrementally:

1. **Phase 2.1**: Use `NormalContextAssembler` in existing code for context preparation
2. **Phase 2.2**: Use `UnifiedVespaRetriever` for new search endpoints
3. **Phase 2.3**: Use `StreamingGenerator` for new streaming endpoints
4. **Phase 2.4**: Migrate services one at a time

### Backward Compatibility

All existing code continues to work:

```typescript
// Old way (still works)
import { searchGlobalTool } from "./pi-mono/tools/search-global"
const results = await searchGlobalTool.execute(params, context)

// New way (opt-in)
import { UnifiedVespaRetriever } from "./chat-v2/plugins/retrievers"
const retriever = new UnifiedVespaRetriever()
for await (const result of retriever.search(query, options, context)) {
  // Process results
}
```
