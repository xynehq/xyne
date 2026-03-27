# Phase 1: Foundation - Detailed Migration Guide

## Overview

**Duration**: 2 weeks  
**Goal**: Establish architectural foundation without changing any existing behavior  
**Risk Level**: Low (additive changes only, no deletion of existing code)  
**Rollback Strategy**: Delete new `/api/chat-v2/` directory

---

## Phase 1 Objectives

1. Create new folder structure parallel to existing code
2. Define core TypeScript interfaces (no implementations)
3. Implement RequestContext system (replaces global state)
4. Create ToolRegistry abstraction (wraps existing tools)
5. Establish testing patterns for new architecture
6. Add feature flag infrastructure for gradual rollout

---

## Week 1: Structure & Interfaces

### Day 1-2: Folder Structure Setup

#### 1.1 Create Directory Structure

```bash
# Create new parallel structure
mkdir -p server/api/chat-v2/{api/{handlers,middleware},core/{orchestrator,strategies,pipeline/{context-assembly,retrieval,generation},runtime},plugins/{tools/{base,implementations},retrievers,citations,memory},models,services,shared}

# Create __tests__ directories
mkdir -p server/api/chat-v2/{core,plugins,services}/__tests__
```

**Directory Layout:**
```
server/api/chat-v2/
├── api/
│   ├── handlers/
│   │   └── .gitkeep
│   └── middleware/
│       └── .gitkeep
├── core/
│   ├── orchestrator/
│   │   └── .gitkeep
│   ├── strategies/
│   │   └── .gitkeep
│   ├── pipeline/
│   │   ├── context-assembly/
│   │   │   └── .gitkeep
│   │   ├── retrieval/
│   │   │   └── .gitkeep
│   │   └── generation/
│   │       └── .gitkeep
│   └── runtime/
│       └── .gitkeep
├── plugins/
│   ├── tools/
│   │   ├── base/
│   │   │   └── .gitkeep
│   │   └── implementations/
│   │       └── .gitkeep
│   ├── retrievers/
│   │   └── .gitkeep
│   ├── citations/
│   │   └── .gitkeep
│   └── memory/
│       └── .gitkeep
├── models/
│   └── .gitkeep
├── services/
│   └── .gitkeep
├── shared/
│   └── .gitkeep
└── index.ts
```

#### 1.2 Create Index Files

**server/api/chat-v2/index.ts**
```typescript
/**
 * Chat V2 - New Architecture
 * 
 * This module contains the refactored chat architecture.
 * Phase 1: Foundation - Interfaces and basic abstractions
 * 
 * @module chat-v2
 */

// Feature flag check
import config from "@/config"

export const CHAT_V2_ENABLED = config.features?.chatV2 === true

// Re-export types for consumption
export type { ChatRequest } from "./models/chat-request"
export type { ChatEvent } from "./shared/events"
export { ChatMode } from "./core/strategies/chat-mode-strategy"
export type { RequestContext } from "./core/orchestrator/request-context"
export type { Tool, ToolExecutionContext } from "./plugins/tools/tool.interface"

// Phase 1 exports - only interfaces and registries
export { ToolRegistry } from "./plugins/tools/tool-registry"
export { ChatModeStrategyRegistry } from "./core/strategies/chat-mode-strategy"
```

### Day 3-4: Core Type Definitions

#### 1.3 Create Base Models

**server/api/chat-v2/models/chat-request.ts**
```typescript
import type { AttachmentMetadata } from "@/shared/types"
import type { Apps, Entity } from "@xyne/vespa-ts/types"

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
```

**server/api/chat-v2/models/fragment.ts**
```typescript
import type { Citation } from "./citation"

/**
 * A fragment of context retrieved for the chat
 */
export interface Fragment {
  /** Unique identifier for this fragment */
  id: string
  
  /** Text content of the fragment */
  content: string
  
  /** Source citation for attribution */
  source: Citation
  
  /** Relevance confidence score (0-1) */
  confidence: number
  
  /** Optional associated images */
  images?: FragmentImage[]
  
  /** Metadata for ranking/filtering */
  metadata?: FragmentMetadata
}

export interface FragmentImage {
  fileName: string
  filePath?: string
  addedAtTurn: number
  sourceFragmentId: string
  sourceToolName: string
  isUserAttachment: boolean
}

export interface FragmentMetadata {
  chunkIndex?: number
  totalChunks?: number
  timestamp?: string
  author?: string
  app?: string
  entity?: string
  [key: string]: unknown
}

/**
 * Collection of fragments from a single retrieval source
 */
export interface FragmentCollection {
  source: RetrievalSource
  fragments: Fragment[]
  query: string
  timestamp: Date
}

export enum RetrievalSource {
  Vespa = "vespa",
  KnowledgeBase = "knowledge-base",
  Attachment = "attachment",
  Memory = "memory",
  Web = "web",
  Notion = "notion",
  Confluence = "confluence",
  Custom = "custom",
}
```

**server/api/chat-v2/models/citation.ts**
```typescript
import type { Apps, Entity } from "@xyne/vespa-ts/types"

/**
 * A citation for attribution
 */
export interface Citation {
  /** Document identifier */
  docId: string
  
  /** Human-readable title */
  title?: string
  
  /** URL to source */
  url?: string
  
  /** Application source */
  app: Apps
  
  /** Entity type */
  entity: Entity
  
  /** Chunk/index within document */
  chunkIndex?: number
  
  /** Thread ID (for threaded content like email/Slack) */
  threadId?: string
  
  /** Additional metadata */
  metadata?: CitationMetadata
}

export interface CitationMetadata {
  pageTitle?: string
  itemId?: string
  collectionId?: string
  createdAt?: string
  resolvedAt?: string
  status?: string
  ticketNumber?: string
  [key: string]: unknown
}

/**
 * Image citation for inline image references
 */
export interface ImageCitation {
  citationKey: string
  imagePath: string
  imageData: string
  item: Citation
  mimeType?: string
}

/**
 * Chunk-level citation (e.g., K[1_0])
 */
export interface ChunkCitation {
  docIndex: number
  chunkIndex: number
  fragmentId: string
  source: Citation
}

/**
 * Formatted citation for client display
 */
export interface FormattedCitation {
  index: number
  docId: string
  title: string
  url?: string
  app: string
  entity: string
  snippet?: string
}
```

**server/api/chat-v2/models/agent-state.ts**
```typescript
import type { Fragment } from "./fragment"
import type { Plan } from "./plan"
import type { ToolExecution } from "./tool-execution"
import type { Clarification } from "./clarification"

/**
 * Mutable state maintained during agent execution
 */
export interface AgentState {
  /** Current turn number */
  turnCount: number
  
  /** Execution plan */
  plan: Plan | null
  
  /** Currently active subtask */
  currentSubTask: string | null
  
  /** All collected fragments */
  fragments: Fragment[]
  
  /** Fragments organized by turn */
  fragmentsByTurn: Map<number, Fragment[]>
  
  /** All collected images */
  images: FragmentImageReference[]
  
  /** Images organized by turn */
  imagesByTurn: Map<number, FragmentImageReference[]>
  
  /** Recently used images (sliding window) */
  recentImages: FragmentImageReference[]
  
  /** History of tool executions */
  toolHistory: ToolExecution[]
  
  /** User clarifications */
  clarifications: Clarification[]
  
  /** Whether ambiguity has been resolved */
  ambiguityResolved: boolean
  
  /** Pending clarification ID */
  pendingClarificationId?: string
  
  /** Review state */
  review: ReviewState
  
  /** Final synthesis state */
  synthesis: SynthesisState
  
  /** Performance tracking */
  metrics: ExecutionMetrics
  
  /** Decision log for debugging */
  decisions: Decision[]
  
  /** Set of seen document IDs (for dedup) */
  seenDocuments: Set<string>
  
  /** Citation mapping */
  citationMapping: Map<number, string>
}

export interface FragmentImageReference {
  fileName: string
  addedAtTurn: number
  sourceFragmentId: string
  sourceToolName: string
  isUserAttachment: boolean
}

export interface ReviewState {
  lastReviewTurn: number | null
  reviewFrequency: number
  lastReviewedFragmentIndex: number
  outstandingAnomalies: string[]
  clarificationQuestions: string[]
  lastReviewResult: ReviewResult | null
  lockedByFinalSynthesis: boolean
  lockedAtTurn: number | null
  pendingReview?: Promise<void>
  cachedPlanSummary?: string
  cachedContextSummary?: string
}

export interface ReviewResult {
  status: "ok" | "needs_attention"
  notes: string
  toolFeedback: ToolFeedback[]
  unmetExpectations: string[]
  planChangeNeeded: boolean
  planChangeReason?: string
  anomaliesDetected: boolean
  anomalies: string[]
  recommendation: "proceed" | "gather_more" | "clarify_query" | "replan"
  ambiguityResolved: boolean
  clarificationQuestions?: string[]
}

export interface ToolFeedback {
  toolName: string
  outcome: "met" | "missed" | "error"
  summary: string
  expectationGoal?: string
  followUp?: string
}

export interface SynthesisState {
  requested: boolean
  completed: boolean
  suppressAssistantStreaming: boolean
  streamedText: string
  ackReceived: boolean
}

export interface ExecutionMetrics {
  totalLatency: number
  totalCost: number
  tokenUsage: {
    input: number
    output: number
  }
}

export interface Decision {
  timestamp: Date
  turn: number
  type: string
  description: string
  reasoning?: string
}

/**
 * Immutable snapshot of agent state
 */
export interface AgentStateSnapshot {
  timestamp: Date
  turn: number
  plan: Plan | null
  fragmentCount: number
  toolCallCount: number
  metrics: ExecutionMetrics
}
```

**server/api/chat-v2/models/plan.ts**
```typescript
/**
 * Execution plan for agentic mode
 */
export interface Plan {
  /** Plan goal/description */
  goal: string
  
  /** Individual subtasks */
  subTasks: SubTask[]
  
  /** When the plan was created */
  createdAt: number
  
  /** When the plan was last updated */
  updatedAt: number
}

export interface SubTask {
  /** Unique task ID */
  id: string
  
  /** Task description */
  description: string
  
  /** Current status */
  status: SubTaskStatus
  
  /** Tools required for this task */
  toolsRequired?: string[]
  
  /** Task result (if completed) */
  result?: string
  
  /** Error message (if failed) */
  error?: string
  
  /** When task was started */
  startedAt?: number
  
  /** When task was completed */
  completedAt?: number
  
  /** Dependencies on other tasks */
  dependsOn?: string[]
}

export type SubTaskStatus = 
  | "pending"
  | "in_progress" 
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
```

**server/api/chat-v2/models/tool-execution.ts**
```typescript
/**
 * Record of a tool execution
 */
export interface ToolExecution {
  /** Unique call ID */
  callId: string
  
  /** Tool name */
  toolName: string
  
  /** Connector ID (for MCP tools) */
  connectorId?: string
  
  /** Arguments passed to tool */
  arguments: Record<string, unknown>
  
  /** Turn number when executed */
  turnNumber: number
  
  /** When execution started */
  startedAt: Date
  
  /** Execution duration in ms */
  durationMs: number
  
  /** Estimated cost in USD */
  estimatedCostUsd?: number
  
  /** Execution status */
  status: "success" | "error" | "cancelled"
  
  /** Error details (if failed) */
  error?: ToolError
  
  /** Result summary */
  result?: string
  
  /** Fragments produced by tool */
  fragments?: string[] // Fragment IDs
}

export interface ToolError {
  code: string
  message: string
  stack?: string
  isRetryable: boolean
}

/**
 * Tool execution expectation
 */
export interface ToolExpectation {
  goal: string
  successCriteria: string[]
  failureSignals?: string[]
  stopCondition?: string
  evidencePlan?: string
}
```

**server/api/chat-v2/models/clarification.ts**
```typescript
/**
 * User clarification Q&A
 */
export interface Clarification {
  /** Unique ID */
  id: string
  
  /** Question asked by agent */
  question: string
  
  /** User's answer */
  answer: string
  
  /** When clarification was requested */
  askedAt: Date
  
  /** When clarification was answered */
  answeredAt?: Date
  
  /** Related turn */
  turn: number
}
```

**server/api/chat-v2/models/index.ts**
```typescript
// Re-export all models
export * from "./chat-request"
export * from "./fragment"
export * from "./citation"
export * from "./agent-state"
export * from "./plan"
export * from "./tool-execution"
export * from "./clarification"
```

### Day 5: Shared Types & Events

#### 1.4 Create Event Definitions

**server/api/chat-v2/shared/events.ts**
```typescript
/**
 * Events emitted during chat processing
 * Used for SSE streaming to client
 */

export type ChatEvent =
  | StartEvent
  | MetadataEvent
  | ReasoningEvent
  | TokenEvent
  | ToolCallEvent
  | ToolResultEvent
  | CitationEvent
  | ImageCitationEvent
  | ErrorEvent
  | CompleteEvent

export interface StartEvent {
  type: "start"
}

export interface MetadataEvent {
  type: "metadata"
  data: ResponseMetadata
}

export interface ResponseMetadata {
  chatId: string
  messageId?: string
  timeTakenMs?: number
  model?: string
}

export interface ReasoningEvent {
  type: "reasoning"
  step: ReasoningStep
}

export interface ReasoningStep {
  stage: ReasoningStage
  message?: string
  details?: Record<string, unknown>
  timestamp: Date
}

export type ReasoningStage =
  | "turn_started"
  | "planning"
  | "tool_selected"
  | "tool_executing"
  | "tool_completed"
  | "reviewing"
  | "synthesizing"
  | "documents_ranking"
  | "attachment_analyzing"
  | "attachment_extracted"
  | "synthesis_started"
  | "synthesis_completed"
  | "turn_ended"
  | "agent_started"
  | "agent_ended"

export interface TokenEvent {
  type: "token"
  content: string
}

export interface ToolCallEvent {
  type: "tool-call"
  tool: string
  args: Record<string, unknown>
  callId: string
}

export interface ToolResultEvent {
  type: "tool-result"
  tool: string
  result: unknown
  callId: string
  durationMs: number
}

export interface CitationEvent {
  type: "citation"
  citation: {
    index: number
    item: import("../models/citation").Citation
    chunkIndex?: number
  }
  citationMap: Record<number, number>
}

export interface ImageCitationEvent {
  type: "image-citation"
  citation: import("../models/citation").ImageCitation
}

export interface ErrorEvent {
  type: "error"
  error: ChatError
}

export interface ChatError {
  code: string
  message: string
  details?: Record<string, unknown>
  recoverable: boolean
}

export interface CompleteEvent {
  type: "complete"
}

/**
 * Convert ChatEvent to SSE format
 */
export function toSSEEvent(event: ChatEvent): { event: string; data: string } {
  const eventName = event.type
    .replace(/([A-Z])/g, "_$1")
    .toUpperCase()
  
  return {
    event: eventName,
    data: JSON.stringify(event),
  }
}
```

**server/api/chat-v2/shared/constants.ts**
```typescript
/**
 * Constants for chat-v2
 */

export const DEFAULT_REVIEW_FREQUENCY = 5
export const MIN_REVIEW_FREQUENCY = 1
export const MAX_REVIEW_FREQUENCY = 50
export const DEFAULT_MAX_RETRIES = 3
export const DEFAULT_WORKING_MEMORY_MESSAGES = 6
export const RECENT_IMAGE_WINDOW = 2
export const MAX_FILES_PER_REQUEST = 12
export const MAX_CITATIONS_PER_SENTENCE = 2

export const CHAT_V2_FEATURE_FLAG = "CHAT_V2_ENABLED"

export enum ChatSSEvents {
  Start = "START",
  ResponseMetadata = "RESPONSE_METADATA",
  Reasoning = "REASONING",
  ResponseUpdate = "RESPONSE_UPDATE",
  CitationsUpdate = "CITATIONS_UPDATE",
  ImageCitationUpdate = "IMAGE_CITATION_UPDATE",
  ToolCall = "TOOL_CALL",
  ToolResult = "TOOL_RESULT",
  Error = "ERROR",
  End = "END",
  AttachmentUpdate = "ATTACHMENT_UPDATE",
  ChatTitleUpdate = "CHAT_TITLE_UPDATE",
}
```

**server/api/chat-v2/shared/index.ts**
```typescript
export * from "./events"
export * from "./constants"
```

---

## Week 2: RequestContext & ToolRegistry

### Day 6-7: RequestContext Implementation

#### 2.1 Create Dependency Container

**server/api/chat-v2/core/orchestrator/dependency-container.ts**
```typescript
/**
 * Dependency Container for dependency injection
 * Provides access to services without tight coupling
 */

import type { ToolRegistry } from "../../plugins/tools/tool-registry"
import type { RetrieverRegistry } from "../../plugins/retrievers/retriever-registry"
import type { CitationRegistry } from "../../plugins/citations/citation-registry"
import type { MemoryService } from "../../services/memory.service"
import type { PersistenceService } from "../../services/persistence.service"
import type { PromptBuilderService } from "../../services/prompt-builder.service"

export interface DependencyContainer {
  // Registries
  tools: ToolRegistry
  retrievers: RetrieverRegistry
  citations: CitationRegistry
  
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
 * Factory for creating dependency container
 * This is the composition root - all wiring happens here
 */
export function createDependencyContainer(
  overrides?: Partial<DependencyContainer>
): DependencyContainer {
  // Phase 1: Return minimal container with mock implementations
  // Phase 2-3: Wire up real implementations
  
  return {
    tools: overrides?.tools ?? createMockToolRegistry(),
    retrievers: overrides?.retrievers ?? createMockRetrieverRegistry(),
    citations: overrides?.citations ?? createMockCitationRegistry(),
    memory: overrides?.memory ?? createMockMemoryService(),
    persistence: overrides?.persistence ?? createMockPersistenceService(),
    promptBuilder: overrides?.promptBuilder ?? createMockPromptBuilder(),
    config: overrides?.config ?? getDefaultConfig(),
  }
}

// Mock implementations for Phase 1
function createMockToolRegistry(): ToolRegistry {
  throw new Error("ToolRegistry not implemented yet")
}

function createMockRetrieverRegistry(): RetrieverRegistry {
  throw new Error("RetrieverRegistry not implemented yet")
}

function createMockCitationRegistry(): CitationRegistry {
  throw new Error("CitationRegistry not implemented yet")
}

function createMockMemoryService(): MemoryService {
  throw new Error("MemoryService not implemented yet")
}

function createMockPersistenceService(): PersistenceService {
  throw new Error("PersistenceService not implemented yet")
}

function createMockPromptBuilder(): PromptBuilderService {
  throw new Error("PromptBuilderService not implemented yet")
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

#### 2.2 Create RequestContext

**server/api/chat-v2/core/orchestrator/request-context.ts**
```typescript
/**
 * RequestContext - Per-request context container
 * 
 * REPLACES: Global sessionStore and activeSessionId in adapter.ts
 * BENEFITS: 
 *   - Isolation between concurrent requests
 *   - No memory leaks (garbage collected after request)
 *   - Easy to test (just create a new instance)
 *   - Clear lifecycle (create -> use -> dispose)
 */

import type { ChatRequest, UserContext, ChatContext } from "../../models"
import type { AgentState } from "../../models/agent-state"
import type { DependencyContainer } from "./dependency-container"

/**
 * Unique request identifier
 */
export type RequestId = string

/**
 * Context for a single chat request
 * Thread-safe and isolated per request
 */
export class RequestContext {
  public readonly requestId: RequestId
  public readonly user: UserContext
  public readonly chat: ChatContext
  public readonly request: ChatRequest
  public readonly dependencies: DependencyContainer
  
  private _agentState?: AgentState
  private _abortController: AbortController
  private _startTime: number
  private _metadata: Map<string, unknown> = new Map()
  
  constructor(params: {
    requestId: RequestId
    user: UserContext
    chat: ChatContext
    request: ChatRequest
    dependencies: DependencyContainer
    abortSignal?: AbortSignal
  }) {
    this.requestId = params.requestId
    this.user = params.user
    this.chat = params.chat
    this.request = params.request
    this.dependencies = params.dependencies
    this._abortController = new AbortController()
    this._startTime = Date.now()
    
    // Link external abort signal if provided
    if (params.abortSignal) {
      params.abortSignal.addEventListener("abort", () => {
        this._abortController.abort()
      })
    }
  }
  
  /**
   * Check if request has been aborted
   */
  get isAborted(): boolean {
    return this._abortController.signal.aborted
  }
  
  /**
   * Get abort signal for cancellation
   */
  get signal(): AbortSignal {
    return this._abortController.signal
  }
  
  /**
   * Abort the request
   */
  abort(reason?: string): void {
    this._abortController.abort(reason)
  }
  
  /**
   * Get elapsed time since request started
   */
  get elapsedMs(): number {
    return Date.now() - this._startTime
  }
  
  /**
   * Get or create agent state
   */
  getAgentState(): AgentState {
    if (!this._agentState) {
      this._agentState = createInitialAgentState()
    }
    return this._agentState
  }
  
  /**
   * Set agent state
   */
  setAgentState(state: AgentState): void {
    this._agentState = state
  }
  
  /**
   * Store metadata for this request
   */
  setMetadata(key: string, value: unknown): void {
    this._metadata.set(key, value)
  }
  
  /**
   * Get metadata
   */
  getMetadata(key: string): unknown | undefined {
    return this._metadata.get(key)
  }
  
  /**
   * Convenience accessors for registries
   */
  get tools() {
    return this.dependencies.tools
  }
  
  get retrievers() {
    return this.dependencies.retrievers
  }
  
  get citations() {
    return this.dependencies.citations
  }
  
  get memory() {
    return this.dependencies.memory
  }
  
  get persistence() {
    return this.dependencies.persistence
  }
  
  get promptBuilder() {
    return this.dependencies.promptBuilder
  }
  
  get config() {
    return this.dependencies.config
  }
  
  /**
   * Factory method to create context from HTTP request
   */
  static async create(
    request: ChatRequest,
    jwtPayload: JWTPayload,
    dependencies: DependencyContainer,
    abortSignal?: AbortSignal
  ): Promise<RequestContext> {
    // Generate unique request ID
    const requestId = generateRequestId()
    
    // Extract user context from JWT
    const user: UserContext = {
      id: String(jwtPayload.userId),
      email: jwtPayload.email,
      workspaceId: String(jwtPayload.workspaceId),
      workspaceNumericId: jwtPayload.workspaceNumericId,
      timeZone: jwtPayload.timeZone || "UTC",
    }
    
    // Create chat context (will be populated by persistence service)
    const chat: ChatContext = {
      externalId: request.chatId || "",
      metadata: {},
    }
    
    return new RequestContext({
      requestId,
      user,
      chat,
      request,
      dependencies,
      abortSignal,
    })
  }
}

/**
 * JWT payload structure
 */
export interface JWTPayload {
  sub: string // email
  userId: number
  workspaceId: number
  workspaceNumericId?: number
  timeZone?: string
}

function generateRequestId(): RequestId {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
}

function createInitialAgentState(): AgentState {
  return {
    turnCount: 0,
    plan: null,
    currentSubTask: null,
    fragments: [],
    fragmentsByTurn: new Map(),
    images: [],
    imagesByTurn: new Map(),
    recentImages: [],
    toolHistory: [],
    clarifications: [],
    ambiguityResolved: false,
    review: {
      lastReviewTurn: null,
      reviewFrequency: 5,
      lastReviewedFragmentIndex: 0,
      outstandingAnomalies: [],
      clarificationQuestions: [],
      lastReviewResult: null,
      lockedByFinalSynthesis: false,
      lockedAtTurn: null,
    },
    synthesis: {
      requested: false,
      completed: false,
      suppressAssistantStreaming: false,
      streamedText: "",
      ackReceived: false,
    },
    metrics: {
      totalLatency: 0,
      totalCost: 0,
      tokenUsage: { input: 0, output: 0 },
    },
    decisions: [],
    seenDocuments: new Set(),
    citationMapping: new Map(),
  }
}
```

#### 2.3 Create Strategy Interface

**server/api/chat-v2/core/strategies/chat-mode-strategy.ts**
```typescript
/**
 * Chat Mode Strategy Pattern
 * 
 * Different chat modes (normal, agentic, attachment, etc.) implement this interface
 * Strategy is selected by Orchestrator based on request characteristics
 */

import type { ChatRequest } from "../../models"
import type { ChatEvent } from "../../shared/events"
import type { RequestContext } from "../orchestrator/request-context"

/**
 * Available chat modes
 */
export enum ChatMode {
  /** Simple chat without agentic loop */
  Normal = "normal",
  
  /** Agentic mode with tool calling */
  Agentic = "agentic",
  
  /** Chat focused on attachment analysis */
  Attachment = "attachment",
  
  /** Knowledge base scoped chat */
  KnowledgeBase = "knowledge-base",
  
  /** Multi-agent delegation */
  MultiAgent = "multi-agent",
  
  /** Structured reasoning mode */
  StructuredReasoning = "structured-reasoning",
}

/**
 * Strategy interface for chat modes
 */
export interface ChatModeStrategy {
  /** Unique mode identifier */
  readonly mode: ChatMode
  
  /**
   * Determine if this strategy can handle the request
   * Called by orchestrator to select appropriate strategy
   */
  canHandle(request: ChatRequest): boolean
  
  /**
   * Execute the chat flow
   * Returns async iterable of events for SSE streaming
   */
  execute(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent>
  
  /**
   * Optional: Prepare context before execution
   * Called by orchestrator before execute()
   */
  prepare?(
    request: ChatRequest,
    context: RequestContext
  ): Promise<void>
  
  /**
   * Optional: Cleanup after execution
   * Called by orchestrator after execute() completes or errors
   */
  cleanup?(
    request: ChatRequest,
    context: RequestContext
  ): Promise<void>
}

/**
 * Strategy registry for discovering and selecting strategies
 */
export class ChatModeStrategyRegistry {
  private strategies = new Map<ChatMode, ChatModeStrategy>()
  private defaultStrategy: ChatModeStrategy | undefined
  
  /**
   * Register a strategy
   */
  register(mode: ChatMode, strategy: ChatModeStrategy): void {
    if (this.strategies.has(mode)) {
      throw new Error(`Strategy for mode "${mode}" already registered`)
    }
    this.strategies.set(mode, strategy)
  }
  
  /**
   * Set default strategy when no specific strategy matches
   */
  setDefault(strategy: ChatModeStrategy): void {
    this.defaultStrategy = strategy
  }
  
  /**
   * Get strategy by mode
   */
  get(mode: ChatMode): ChatModeStrategy | undefined {
    return this.strategies.get(mode)
  }
  
  /**
   * Get all registered strategies
   */
  getAll(): ChatModeStrategy[] {
    return Array.from(this.strategies.values())
  }
  
  /**
   * Find strategy for request
   * Uses canHandle() to determine match, falls back to default
   */
  findFor(request: ChatRequest): ChatModeStrategy {
    // Check each strategy in priority order
    for (const strategy of this.strategies.values()) {
      if (strategy.canHandle(request)) {
        return strategy
      }
    }
    
    if (this.defaultStrategy) {
      return this.defaultStrategy
    }
    
    throw new Error("No suitable strategy found for request and no default set")
  }
  
  /**
   * Check if a mode is registered
   */
  has(mode: ChatMode): boolean {
    return this.strategies.has(mode)
  }
  
  /**
   * Unregister a strategy
   */
  unregister(mode: ChatMode): boolean {
    return this.strategies.delete(mode)
  }
}

/**
 * Singleton registry instance
 * Import this to register strategies
 */
export const strategyRegistry = new ChatModeStrategyRegistry()
```

### Day 8-9: Tool System

#### 3.1 Create Tool Interface

**server/api/chat-v2/plugins/tools/tool.interface.ts**
```typescript
/**
 * Tool Interface - Core abstraction for agent tools
 * 
 * REPLACES: Hardcoded tool list in message-agents.ts buildXyneTools()
 * BENEFITS:
 *   - New tools implement interface, no editing of central file
 *   - Tools can be dynamically discovered and registered
 *   - Easy to mock for testing
 *   - Versioning support (multiple implementations)
 */

import type { JSONSchema7 } from "json-schema"
import type { RequestContext } from "../../core/orchestrator/request-context"
import type { Citation, Fragment } from "../../models"

/**
 * Tool interface - all tools implement this
 */
export interface Tool<TParams = unknown, TResult = unknown> {
  /** Unique tool name (used in tool calls) */
  readonly name: string
  
  /** Human-readable description for LLM */
  readonly description: string
  
  /** JSON Schema for parameters */
  readonly parameters: JSONSchema7
  
  /**
   * Execute the tool
   * @param params - Validated parameters
   * @param context - Execution context
   * @returns Tool result
   */
  execute(
    params: TParams,
    context: ToolExecutionContext
  ): Promise<ToolResult<TResult>>
  
  /**
   * Optional: Check if tool is available in current context
   * Called before adding to available tools list
   */
  isAvailable?(context: RequestContext): boolean
  
  /**
   * Optional: Get tool category for organization
   */
  readonly category?: ToolCategory
  
  /**
   * Optional: Tool version for compatibility
   */
  readonly version?: string
}

/**
 * Tool categories for organization
 */
export enum ToolCategory {
  Search = "search",
  Retrieval = "retrieval",
  Generation = "generation",
  Delegation = "delegation",
  Planning = "planning",
  Utility = "utility",
  Integration = "integration",
}

/**
 * Context provided during tool execution
 */
export interface ToolExecutionContext {
  /** Tool call ID from LLM */
  toolCallId: string
  
  /** Request context */
  requestContext: RequestContext
  
  /** Abort signal for cancellation */
  signal: AbortSignal
  
  /**
   * Report progress updates during long operations
   * Called multiple times for streaming updates
   */
  onProgress?: (update: ToolProgressUpdate) => void
}

/**
 * Progress update during tool execution
 */
export interface ToolProgressUpdate {
  stage: string
  message?: string
  percentComplete?: number
  metadata?: Record<string, unknown>
}

/**
 * Result of tool execution
 */
export interface ToolResult<TResult = unknown> {
  /** Success flag */
  success: boolean
  
  /** Result data (if success) */
  data?: TResult
  
  /** Error details (if failed) */
  error?: ToolError
  
  /** Citations produced by tool */
  citations?: Citation[]
  
  /** Fragments produced by tool */
  fragments?: Fragment[]
  
  /** Human-readable summary for LLM */
  summary?: string
  
  /** Execution metadata */
  metadata?: ToolResultMetadata
}

export interface ToolError {
  code: string
  message: string
  details?: Record<string, unknown>
  isRetryable: boolean
  suggestedAction?: string
}

export interface ToolResultMetadata {
  durationMs: number
  tokensUsed?: number
  costUsd?: number
  cacheHit?: boolean
}

/**
 * Tool factory for creating tool instances
 * Allows dependency injection
 */
export interface ToolFactory {
  createTool<TParams, TResult>(
    name: string,
    config?: Record<string, unknown>
  ): Tool<TParams, TResult>
}

/**
 * Tool metadata for discovery
 */
export interface ToolMetadata {
  name: string
  description: string
  parameters: JSONSchema7
  category: ToolCategory
  version: string
  requiresAuth?: boolean
  allowedRoles?: string[]
}

/**
 * Type guard for tool results
 */
export function isToolSuccess<TResult>(
  result: ToolResult<TResult>
): result is ToolResult<TResult> & { success: true; data: TResult } {
  return result.success === true && result.data !== undefined
}

export function isToolError<TResult>(
  result: ToolResult<TResult>
): result is ToolResult<TResult> & { success: false; error: ToolError } {
  return result.success === false && result.error !== undefined
}
```

#### 3.2 Create Tool Registry

**server/api/chat-v2/plugins/tools/tool-registry.ts**
```typescript
/**
 * Tool Registry - Manages tool registration and discovery
 * 
 * REPLACES: buildXyneTools() function in message-agents.ts
 * BENEFITS:
 *   - Dynamic tool registration
 *   - Scoped tool availability per mode
 *   - Tool versioning
 *   - Easy to test (inject mock registry)
 */

import type { Tool, ToolMetadata } from "./tool.interface"
import type { RequestContext } from "../../core/orchestrator/request-context"
import type { ChatMode } from "../../core/strategies/chat-mode-strategy"

/**
 * Tool filter for selecting subset of tools
 */
export interface ToolFilter {
  categories?: string[]
  names?: string[]
  modes?: ChatMode[]
  availableInContext?: RequestContext
}

/**
 * Tool registry for managing available tools
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>()
  private metadata = new Map<string, ToolMetadata>()
  private modeTools = new Map<ChatMode, Set<string>>()
  
  /**
   * Register a tool
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`Tool "${tool.name}" already registered, overwriting`)
    }
    
    this.tools.set(tool.name, tool)
    this.metadata.set(tool.name, {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      category: tool.category || "utility",
      version: tool.version || "1.0.0",
    })
  }
  
  /**
   * Register multiple tools
   */
  registerMany(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }
  
  /**
   * Associate tools with a chat mode
   */
  registerForMode(mode: ChatMode, toolNames: string[]): void {
    const existing = this.modeTools.get(mode) || new Set()
    for (const name of toolNames) {
      if (!this.tools.has(name)) {
        throw new Error(`Cannot register non-existent tool "${name}" for mode "${mode}"`)
      }
      existing.add(name)
    }
    this.modeTools.set(mode, existing)
  }
  
  /**
   * Get a tool by name
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }
  
  /**
   * Check if tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name)
  }
  
  /**
   * Get all registered tools
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values())
  }
  
  /**
   * Get all tool names
   */
  getNames(): string[] {
    return Array.from(this.tools.keys())
  }
  
  /**
   * Get tools for a specific mode
   */
  getForMode(mode: ChatMode): Tool[] {
    const toolNames = this.modeTools.get(mode)
    if (!toolNames) {
      return []
    }
    
    return Array.from(toolNames)
      .map(name => this.tools.get(name))
      .filter((tool): tool is Tool => tool !== undefined)
  }
  
  /**
   * Get tools available in context (respects isAvailable)
   */
  getAvailable(context: RequestContext): Tool[] {
    return this.getAll().filter(tool => {
      if (tool.isAvailable) {
        return tool.isAvailable(context)
      }
      return true
    })
  }
  
  /**
   * Filter tools based on criteria
   */
  filter(filter: ToolFilter): Tool[] {
    let tools = this.getAll()
    
    if (filter.names) {
      tools = tools.filter(t => filter.names!.includes(t.name))
    }
    
    if (filter.categories) {
      tools = tools.filter(t => 
        t.category && filter.categories!.includes(t.category)
      )
    }
    
    if (filter.modes) {
      const modeToolNames = new Set<string>()
      for (const mode of filter.modes) {
        const names = this.modeTools.get(mode)
        if (names) {
          names.forEach(n => modeToolNames.add(n))
        }
      }
      tools = tools.filter(t => modeToolNames.has(t.name))
    }
    
    if (filter.availableInContext) {
      tools = tools.filter(t => {
        if (t.isAvailable) {
          return t.isAvailable(filter.availableInContext!)
        }
        return true
      })
    }
    
    return tools
  }
  
  /**
   * Get tool metadata
   */
  getMetadata(name: string): ToolMetadata | undefined {
    return this.metadata.get(name)
  }
  
  /**
   * Get all metadata
   */
  getAllMetadata(): ToolMetadata[] {
    return Array.from(this.metadata.values())
  }
  
  /**
   * Unregister a tool
   */
  unregister(name: string): boolean {
    this.metadata.delete(name)
    // Remove from mode associations
    for (const [mode, tools] of this.modeTools) {
      tools.delete(name)
    }
    return this.tools.delete(name)
  }
  
  /**
   * Clear all tools
   */
  clear(): void {
    this.tools.clear()
    this.metadata.clear()
    this.modeTools.clear()
  }
  
  /**
   * Get count of registered tools
   */
  get count(): number {
    return this.tools.size
  }
}

/**
 * Singleton instance
 */
export const toolRegistry = new ToolRegistry()
```

#### 3.3 Create Tool Adapters (Bridge to Existing Tools)

**server/api/chat-v2/plugins/tools/implementations/adapter-utils.ts**
```typescript
/**
 * Adapter utilities for wrapping existing tools
 * 
 * These utilities bridge the new Tool interface to existing tool implementations
 * in pi-mono/tools/ directory
 */

import { Type } from "@sinclair/typebox"
import type { Static, TSchema } from "@sinclair/typebox"
import type { Tool, ToolExecutionContext, ToolResult } from "../tool.interface"
import type { XyneToolContext } from "../../pi-mono/adapter"
import { getXyneState } from "../../pi-mono/adapter"
import { ChatSSEvents } from "../../../shared/types"
import type { RequestContext } from "../../../core/orchestrator/request-context"

/**
 * Convert TypeBox schema to JSON Schema for Tool interface
 */
export function typeboxToJsonSchema(schema: TSchema): Record<string, unknown> {
  // TypeBox schemas are already JSON Schema compatible
  return schema as Record<string, unknown>
}

/**
 * Create ToolExecutionContext from RequestContext
 * This bridges the new context to the existing pi-mono adapter
 */
export function createToolExecutionBridge(
  requestContext: RequestContext,
  toolCallId: string
): XyneToolContext {
  return {
    events: {
      emit: (event: string, payload: unknown) => {
        // Bridge events to new event system
        if (event === "reasoning") {
          // Emit reasoning event
        }
      },
    },
    xyneState: requestContext.getAgentState() as unknown as import("../../../pi-mono/adapter").XyneAgentState,
    persistState: async () => {
      // State is persisted via RequestContext
    },
    runtime: requestContext.getMetadata("runtime") as {
      streamAnswerText: (text: string) => Promise<void>
      emitReasoning: (payload: unknown) => Promise<void>
    },
  }
}

/**
 * Adapter for wrapping existing pi-mono tools
 */
export function wrapExistingTool(
  name: string,
  existingTool: {
    name: string
    description: string
    parameters: TSchema
    execute: (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: XyneToolContext
    ) => Promise<{
      content: Array<{ type: string; text: string }>
      isError?: boolean
      details?: Record<string, unknown>
    }>
  }
): Tool {
  return {
    name: existingTool.name,
    description: existingTool.description,
    parameters: typeboxToJsonSchema(existingTool.parameters),
    
    async execute(params, context) {
      const xyneCtx = createToolExecutionBridge(
        context.requestContext,
        context.toolCallId
      )
      
      try {
        const result = await existingTool.execute(
          context.toolCallId,
          params,
          context.signal,
          {}, // onUpdate
          xyneCtx
        )
        
        if (result.isError) {
          return {
            success: false,
            error: {
              code: "TOOL_ERROR",
              message: result.content[0]?.text || "Tool execution failed",
              isRetryable: false,
            },
          }
        }
        
        return {
          success: true,
          data: result.details,
          summary: result.content[0]?.text,
        }
      } catch (error) {
        return {
          success: false,
          error: {
            code: "EXECUTION_ERROR",
            message: error instanceof Error ? error.message : String(error),
            isRetryable: true,
          },
        }
      }
    },
  }
}
```

### Day 10: Testing & Integration

#### 4.1 Create Test Utilities

**server/api/chat-v2/core/__tests__/request-context.test.ts**
```typescript
/**
 * Tests for RequestContext
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { RequestContext } from "../orchestrator/request-context"
import { createDependencyContainer } from "../orchestrator/dependency-container"
import type { ChatRequest, UserContext, ChatContext } from "../../models"

// Mock dependencies container
function createMockContainer() {
  return createDependencyContainer({
    // Provide mock implementations for testing
  })
}

describe("RequestContext", () => {
  let mockRequest: ChatRequest
  let mockUser: UserContext
  let mockChat: ChatContext
  let mockContainer: ReturnType<typeof createMockContainer>
  
  beforeEach(() => {
    mockRequest = {
      message: "Test message",
    }
    
    mockUser = {
      id: "user-123",
      email: "test@example.com",
      workspaceId: "ws-456",
      timeZone: "UTC",
    }
    
    mockChat = {
      externalId: "chat-789",
      metadata: {},
    }
    
    mockContainer = createMockContainer()
  })
  
  it("should create context with unique request ID", () => {
    const ctx1 = new RequestContext({
      requestId: "req-1",
      user: mockUser,
      chat: mockChat,
      request: mockRequest,
      dependencies: mockContainer,
    })
    
    const ctx2 = new RequestContext({
      requestId: "req-2",
      user: mockUser,
      chat: mockChat,
      request: mockRequest,
      dependencies: mockContainer,
    })
    
    expect(ctx1.requestId).toBe("req-1")
    expect(ctx2.requestId).toBe("req-2")
    expect(ctx1.requestId).not.toBe(ctx2.requestId)
  })
  
  it("should track elapsed time", async () => {
    const ctx = new RequestContext({
      requestId: "req-1",
      user: mockUser,
      chat: mockChat,
      request: mockRequest,
      dependencies: mockContainer,
    })
    
    expect(ctx.elapsedMs).toBeGreaterThanOrEqual(0)
    
    await new Promise(resolve => setTimeout(resolve, 10))
    
    expect(ctx.elapsedMs).toBeGreaterThanOrEqual(10)
  })
  
  it("should handle abort signal", () => {
    const abortController = new AbortController()
    
    const ctx = new RequestContext({
      requestId: "req-1",
      user: mockUser,
      chat: mockChat,
      request: mockRequest,
      dependencies: mockContainer,
      abortSignal: abortController.signal,
    })
    
    expect(ctx.isAborted).toBe(false)
    
    abortController.abort()
    
    expect(ctx.isAborted).toBe(true)
  })
  
  it("should manage agent state", () => {
    const ctx = new RequestContext({
      requestId: "req-1",
      user: mockUser,
      chat: mockChat,
      request: mockRequest,
      dependencies: mockContainer,
    })
    
    // Initially no state
    const state = ctx.getAgentState()
    expect(state).toBeDefined()
    expect(state.turnCount).toBe(0)
    expect(state.fragments).toEqual([])
    
    // Modify state
    state.turnCount = 5
    
    // Get returns same instance
    expect(ctx.getAgentState().turnCount).toBe(5)
  })
  
  it("should store and retrieve metadata", () => {
    const ctx = new RequestContext({
      requestId: "req-1",
      user: mockUser,
      chat: mockChat,
      request: mockRequest,
      dependencies: mockContainer,
    })
    
    ctx.setMetadata("key1", "value1")
    ctx.setMetadata("key2", { nested: true })
    
    expect(ctx.getMetadata("key1")).toBe("value1")
    expect(ctx.getMetadata("key2")).toEqual({ nested: true })
    expect(ctx.getMetadata("nonexistent")).toBeUndefined()
  })
  
  it("should provide convenience accessors", () => {
    const ctx = new RequestContext({
      requestId: "req-1",
      user: mockUser,
      chat: mockChat,
      request: mockRequest,
      dependencies: mockContainer,
    })
    
    expect(ctx.tools).toBeDefined()
    expect(ctx.retrievers).toBeDefined()
    expect(ctx.citations).toBeDefined()
    expect(ctx.memory).toBeDefined()
    expect(ctx.persistence).toBeDefined()
    expect(ctx.promptBuilder).toBeDefined()
    expect(ctx.config).toBeDefined()
  })
})
```

**server/api/chat-v2/plugins/tools/__tests__/tool-registry.test.ts**
```typescript
/**
 * Tests for ToolRegistry
 */

import { describe, it, expect, beforeEach } from "vitest"
import { ToolRegistry } from "../tool-registry"
import { ToolCategory, type Tool } from "../tool.interface"
import { ChatMode } from "../../../core/strategies/chat-mode-strategy"

// Mock tools for testing
const mockTool1: Tool = {
  name: "searchGlobal",
  description: "Search across all data",
  parameters: { type: "object", properties: {} },
  category: ToolCategory.Search,
  execute: async () => ({ success: true, data: {} }),
}

const mockTool2: Tool = {
  name: "synthesize",
  description: "Synthesize final answer",
  parameters: { type: "object", properties: {} },
  category: ToolCategory.Generation,
  execute: async () => ({ success: true, data: {} }),
}

const mockTool3: Tool = {
  name: "listAgents",
  description: "List available agents",
  parameters: { type: "object", properties: {} },
  category: ToolCategory.Delegation,
  execute: async () => ({ success: true, data: {} }),
}

describe("ToolRegistry", () => {
  let registry: ToolRegistry
  
  beforeEach(() => {
    registry = new ToolRegistry()
  })
  
  it("should register and retrieve tools", () => {
    registry.register(mockTool1)
    
    const retrieved = registry.get("searchGlobal")
    expect(retrieved).toBe(mockTool1)
  })
  
  it("should check if tool exists", () => {
    expect(registry.has("searchGlobal")).toBe(false)
    
    registry.register(mockTool1)
    
    expect(registry.has("searchGlobal")).toBe(true)
    expect(registry.has("nonexistent")).toBe(false)
  })
  
  it("should get all tools", () => {
    registry.register(mockTool1)
    registry.register(mockTool2)
    
    const all = registry.getAll()
    expect(all).toHaveLength(2)
    expect(all).toContain(mockTool1)
    expect(all).toContain(mockTool2)
  })
  
  it("should register tools for modes", () => {
    registry.register(mockTool1)
    registry.register(mockTool2)
    registry.register(mockTool3)
    
    registry.registerForMode(ChatMode.Normal, ["searchGlobal"])
    registry.registerForMode(ChatMode.Agentic, ["searchGlobal", "synthesize", "listAgents"])
    
    const normalTools = registry.getForMode(ChatMode.Normal)
    expect(normalTools).toHaveLength(1)
    expect(normalTools[0].name).toBe("searchGlobal")
    
    const agenticTools = registry.getForMode(ChatMode.Agentic)
    expect(agenticTools).toHaveLength(3)
  })
  
  it("should filter tools by category", () => {
    registry.register(mockTool1)
    registry.register(mockTool2)
    registry.register(mockTool3)
    
    const searchTools = registry.filter({
      categories: [ToolCategory.Search],
    })
    
    expect(searchTools).toHaveLength(1)
    expect(searchTools[0].name).toBe("searchGlobal")
  })
  
  it("should throw when registering non-existent tool for mode", () => {
    expect(() => {
      registry.registerForMode(ChatMode.Normal, ["nonexistent"])
    }).toThrow('Cannot register non-existent tool')
  })
  
  it("should unregister tools", () => {
    registry.register(mockTool1)
    expect(registry.has("searchGlobal")).toBe(true)
    
    const removed = registry.unregister("searchGlobal")
    expect(removed).toBe(true)
    expect(registry.has("searchGlobal")).toBe(false)
    
    const notFound = registry.unregister("nonexistent")
    expect(notFound).toBe(false)
  })
  
  it("should get tool metadata", () => {
    registry.register(mockTool1)
    
    const metadata = registry.getMetadata("searchGlobal")
    expect(metadata).toBeDefined()
    expect(metadata?.name).toBe("searchGlobal")
    expect(metadata?.category).toBe(ToolCategory.Search)
  })
  
  it("should track tool count", () => {
    expect(registry.count).toBe(0)
    
    registry.register(mockTool1)
    expect(registry.count).toBe(1)
    
    registry.register(mockTool2)
    expect(registry.count).toBe(2)
    
    registry.unregister("searchGlobal")
    expect(registry.count).toBe(1)
  })
  
  it("should clear all tools", () => {
    registry.register(mockTool1)
    registry.register(mockTool2)
    expect(registry.count).toBe(2)
    
    registry.clear()
    expect(registry.count).toBe(0)
    expect(registry.has("searchGlobal")).toBe(false)
  })
})
```

#### 4.2 Add Feature Flag

**server/config/index.ts** (add to existing config)
```typescript
// Add to config object
features: {
  chatV2: process.env.ENABLE_CHAT_V2 === "true",
  // other feature flags
}
```

**server/api/chat/index.ts** (add conditional export)
```typescript
// Add at end of file
import { CHAT_V2_ENABLED } from "./chat-v2"

export { CHAT_V2_ENABLED }

// Re-export v2 types when enabled
if (CHAT_V2_ENABLED) {
  console.log("[Chat] V2 architecture enabled")
}
```

---

## Phase 1 Deliverables

### Code Structure

```
server/api/chat-v2/
├── index.ts                              # Module entry point
├── api/
│   ├── handlers/
│   │   └── .gitkeep
│   └── middleware/
│       └── .gitkeep
├── core/
│   ├── orchestrator/
│   │   ├── dependency-container.ts       # DI container
│   │   ├── request-context.ts            # Per-request context (REPLACES global state)
│   │   └── __tests__/
│   │       └── request-context.test.ts
│   ├── strategies/
│   │   └── chat-mode-strategy.ts         # Strategy interface & registry
│   └── [other dirs with .gitkeep]
├── plugins/
│   ├── tools/
│   │   ├── tool.interface.ts             # Tool interface
│   │   ├── tool-registry.ts              # Tool registry (REPLACES buildXyneTools)
│   │   ├── implementations/
│   │   │   └── adapter-utils.ts          # Bridge to existing tools
│   │   └── __tests__/
│   │       └── tool-registry.test.ts
│   └── [other dirs with .gitkeep]
├── models/
│   ├── index.ts
│   ├── chat-request.ts                   # Request DTOs
│   ├── fragment.ts                       # Fragment model
│   ├── citation.ts                       # Citation model
│   ├── agent-state.ts                    # Agent state
│   ├── plan.ts                           # Plan model
│   ├── tool-execution.ts                 # Tool execution model
│   └── clarification.ts                  # Clarification model
└── shared/
    ├── index.ts
    ├── events.ts                         # ChatEvent definitions
    └── constants.ts                      # Constants
```

### Interfaces Defined

1. **ChatModeStrategy** - Strategy pattern for chat modes
2. **RequestContext** - Per-request context (replaces global state)
3. **Tool** - Tool interface with execution context
4. **ChatEvent** - Event types for SSE streaming
5. **Fragment, Citation, AgentState** - Data models

### Registries Implemented

1. **ChatModeStrategyRegistry** - Strategy discovery
2. **ToolRegistry** - Tool registration and filtering

### Tests Added

1. RequestContext lifecycle and functionality
2. ToolRegistry registration and filtering
3. Abort signal handling
4. State management

### No Breaking Changes

- All existing code remains untouched
- New code is isolated in `chat-v2/` directory
- Feature flag controls enablement
- Existing tests continue to pass

---

## Next Steps (Phase 2 Preview)

After Phase 1 is complete and stable:

1. **Context Assembler Implementation**
   - Extract logic from message-agents.ts prepare phase
   - Create NormalContextAssembler, AgentContextAssembler

2. **Retrieval Pipeline**
   - VespaRetriever implementation
   - KnowledgeBaseRetriever implementation
   - Bridge to existing search functions

3. **Generation Pipeline**
   - Streaming generator
   - Synthesis generator

4. **First Strategy Implementation**
   - NormalChatStrategy (simplest)
   - Integrate with existing endpoint behind feature flag

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Type conflicts with existing code | Use separate `chat-v2/` namespace, explicit imports |
| Memory leaks in RequestContext | Ensure proper disposal, add lifecycle logging |
| Performance regression | Benchmark before/after, keep existing code path |
| Developer confusion | Clear documentation, code comments, ADR |
| Partial migration state | Feature flags allow rollback, keep both implementations |

---

## Success Criteria

- [ ] All new interfaces compile without errors
- [ ] ToolRegistry can wrap existing tools via adapter
- [ ] RequestContext replaces global state in test scenarios
- [ ] 100% test coverage for registry and context classes
- [ ] Feature flag controls access to new code
- [ ] No changes to existing production code paths
- [ ] Documentation complete and reviewed
