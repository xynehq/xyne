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
import type { DependencyContainer } from "./dependency-container.types"

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
    // Note: JWT payload uses 'sub' for email (standard JWT claim)
    const user: UserContext = {
      id: String(jwtPayload.userId),
      email: jwtPayload.sub, // 'sub' contains the email
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
  sub: string // email (standard JWT claim)
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
