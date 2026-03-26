/**
 * pi-mono Adapter for Xyne
 *
 * Bridges JAF-style tools to pi-mono ToolDefinition format
 * Maintains XyneAgentState using pi-mono's state-manager
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import type { Static, TSchema } from "@sinclair/typebox"
import type {
  AgentRunContext,
  Clarification,
  Decision,
  ToolExecutionRecord,
} from "../agent-schemas"
import type { Message } from "@aws-sdk/client-bedrock-runtime"
import type { FragmentImageReference, MinimalAgentFragment } from "../types"

/**
 * MCP Virtual Agent Runtime
 */
export interface MCPVirtualAgentRuntime {
  agentId: string
  connectorId: string
  connectorName?: string
  description?: string
  tools: Array<{
    toolName: string
    toolSchema?: string | null
    description?: string
  }>
  client: {
    callTool: (args: { name: string; arguments: unknown }) => Promise<unknown>
    close?: () => Promise<void>
  }
}

/**
 * Tool expectation for review system
 */
export interface ToolExpectation {
  goal: string
  successCriteria: string[]
  failureSignals?: string[]
  stopCondition?: string
  evidencePlan?: string
}

export interface ToolFailureInfo {
  count: number
  lastError: string
  lastAttempt: number
  cooldownUntilTurn: number
}

/**
 * Assignment of expectation to a tool call
 */
export interface ToolExpectationAssignment {
  toolName: string
  expectation: ToolExpectation
}

/**
 * Review result from automatic turn-end review
 */
export interface ReviewResult {
  status: "ok" | "needs_attention"
  notes: string
  toolFeedback: Array<{
    toolName: string
    outcome: "met" | "missed" | "error"
    summary: string
    expectationGoal?: string
    followUp?: string
  }>
  unmetExpectations: string[]
  planChangeNeeded: boolean
  planChangeReason?: string
  anomaliesDetected: boolean
  anomalies: string[]
  recommendation: "proceed" | "gather_more" | "clarify_query" | "replan"
  ambiguityResolved: boolean
  clarificationQuestions?: string[]
}

/**
 * Xyne-specific state maintained alongside pi-mono session
 */
export interface XyneAgentState {
  // Turn tracking
  turnCount: number

  // Clarification tracking
  clarifications: Clarification[]
  ambiguityResolved: boolean
  pendingClarificationId?: string

  // Existing context fields
  plan: any | null
  currentSubTask: string | null
  allFragments: MinimalAgentFragment[]
  turnFragments: Map<number, MinimalAgentFragment[]>
  allImages: FragmentImageReference[]
  imagesByTurn: Map<number, FragmentImageReference[]>
  recentImages: FragmentImageReference[]
  toolCallHistory: ToolExecutionRecord[]

  // Failed tools tracking (for cooldowns)
  failedTools: Map<string, ToolFailureInfo>

  // Review and expectation tracking (ported from JAF)
  review: {
    lastReviewTurn: number | null
    reviewFrequency: number
    lastReviewedFragmentIndex: number
    outstandingAnomalies: string[]
    clarificationQuestions: string[]
    lastReviewResult: ReviewResult | null
    lockedByFinalSynthesis: boolean
    lockedAtTurn: number | null
    pendingReview?: Promise<void>
  }

  // Expectation tracking
  pendingExpectations: ToolExpectationAssignment[]
  expectationHistory: Map<number, ToolExpectationAssignment[]>
  expectedResultsByCallId: Map<string, ToolExpectation>

  finalSynthesis: any
  agentPrompt?: string
  userContext: string
  dedicatedAgentSystemPrompt?: string
  modelId?: string

  // Delegation
  delegationEnabled: boolean
  maxOutputTokens?: number
  mcpAgents: MCPVirtualAgentRuntime[]

  // Turn artifacts
  currentTurnArtifacts: {
    fragments: MinimalAgentFragment[]
    unrankedFragmentsByTool: Map<
      string,
      { query: string; fragments: MinimalAgentFragment[] }
    >
    expectations: ToolExpectationAssignment[]
    toolOutputs: any[]
    images: FragmentImageReference[]
    executionToolsCalled: number
    todoWriteCalled: boolean
    turnStartedAt: number
  }

  // Agent delegation
  availableAgents: Array<{
    agentId: string
    agentName: string
    description?: string
    capabilities?: string[]
  }>
  usedAgents: string[]

  // Performance metrics
  totalLatency: number
  totalCost: number
  tokenUsage: {
    input: number
    output: number
  }

  // Agent & tool tracking
  enabledTools: Set<string>

  // Error & retry tracking
  retryCount: number
  maxRetries: number

  // Decision log (for debugging)
  decisions: Decision[]

  // User context
  user: {
    email: string
    workspaceId: string
    id: string
    workspaceNumericId?: number
    timeZone?: string
  }
  chat: {
    id?: number
    externalId: string
    metadata: Record<string, any>
  }
  message: {
    text: string
    attachments: Array<{ fileId: string; isImage: boolean }>
    timestamp: string
  }

  // Conversation history for synthesis
  conversationHistoryMessages: Message[]

  // Memory
  episodicMemoriesText?: string
  chatMemoryText?: string

  // Seen documents (for dedup across turns)
  seenDocuments: Set<string>

  // Citation mapping for reliable citation resolution
  // Maps citationDocId (1, 2, 3...) to fragment.id
  citationDocIdMapping: Map<number, string>

  // Stop/abort control
  stopController?: AbortController
  stopSignal?: AbortSignal
  stopRequested: boolean

  // Thinking log for fallback synthesis
  thinkingLog?: string
}

/**
 * Context passed to tool execute functions
 * Combines pi-mono ExtensionContext with Xyne state
 */
export interface XyneToolContext {
  // pi-mono provided
  events: {
    emit: (event: string, payload: any) => void
  }

  // Xyne-specific state (stored separately)
  xyneState: XyneAgentState

  // Helpers
  persistState: () => Promise<void>

  // Runtime callbacks for streaming output (used by synthesizeFinalAnswer)
  runtime?: {
    streamAnswerText: (text: string) => Promise<void>
    emitReasoning: (payload: any) => Promise<void>
  }
}

// ============================================================================
// SESSION-SCOPED STATE STORAGE
// Prevents concurrent request corruption by keying state/runtime/persist per session.
// ============================================================================

interface SessionContext {
  state: XyneAgentState
  runtime?: XyneToolContext["runtime"]
  persistFn: PersistXyneStateFn
}

/** Session-scoped storage keyed by chatExternalId */
const sessionStore = new Map<string, SessionContext>()

/** Currently active session ID (set when a request starts processing) */
let activeSessionId: string | null = null

/**
 * Register a session with its state, persist function, and runtime
 */
export function registerSession(
  sessionId: string,
  state: XyneAgentState,
  persistFn: PersistXyneStateFn,
  runtime?: XyneToolContext["runtime"],
): void {
  sessionStore.set(sessionId, { state, runtime, persistFn })
  activeSessionId = sessionId
}

/**
 * Update runtime for an active session
 */
export function setSessionRuntime(
  sessionId: string,
  runtime: XyneToolContext["runtime"],
): void {
  const session = sessionStore.get(sessionId)
  if (session) {
    session.runtime = runtime
  }
}

/**
 * Clean up session when request completes
 */
export function unregisterSession(sessionId: string): void {
  sessionStore.delete(sessionId)
  if (activeSessionId === sessionId) {
    activeSessionId = null
  }
}

/**
 * Get session context by session ID or active session fallback
 */
function getSessionContext(sessionId?: string): SessionContext {
  const id = sessionId || activeSessionId
  if (id && sessionStore.has(id)) {
    return sessionStore.get(id)!
  }
  throw new Error(`Xyne session not found: ${id || "no active session"}`)
}

// Legacy API — delegates to session store for backward compatibility
const stateMap = new WeakMap<any, string>() // maps pi-mono ctx → sessionId

export function getXyneState(ctx: any): XyneAgentState {
  // Try to get sessionId from WeakMap mapping either the ExtensionContext or SessionManager
  const lookupCtx = ctx && ctx.session ? ctx.session : ctx
  if (lookupCtx && stateMap.has(lookupCtx)) {
    const sessionId = stateMap.get(lookupCtx)!
    return getSessionContext(sessionId).state
  }
  // Fallback to active session
  return getSessionContext().state
}

export function setXyneState(ctx: any, state: XyneAgentState): void {
  const sessionId = state.chat.externalId
  stateMap.set(ctx, sessionId)
}

// Legacy compat — these now delegate to active session
export function setPersistFunction(fn: PersistXyneStateFn): void {
  if (activeSessionId) {
    const session = sessionStore.get(activeSessionId)
    if (session) session.persistFn = fn
  }
}

export function setRuntime(runtime: XyneToolContext["runtime"]): void {
  if (activeSessionId) {
    setSessionRuntime(activeSessionId, runtime)
  }
}

/**
 * Convert JAF-style tool to pi-mono ToolDefinition
 */
export function createXyneTool<TParams extends TSchema>(
  name: string,
  description: string,
  parameters: TParams,
  execute: (
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: XyneToolContext,
  ) => Promise<any>,
): ToolDefinition<TParams, any, any> {
  return {
    name,
    label: name,
    description,
    parameters,
    execute: async (toolCallId, params, signal, onUpdate, extCtx) => {
      // Get Xyne state from extension context (resolves via session store)
      const xyneState = getXyneState(extCtx)
      const sessionId = xyneState.chat.externalId
      const session = getSessionContext(sessionId)

      // Create Xyne tool context with session-scoped runtime and persist
      const xyneCtx: XyneToolContext = {
        events: (extCtx as any).events || { emit: () => {} },
        xyneState,
        persistState: async () => {
          await session.persistFn(xyneState)
        },
        runtime: session.runtime,
      }

      // Execute with Xyne context
      return execute(
        toolCallId,
        params as Static<TParams>,
        signal,
        onUpdate,
        xyneCtx,
      )
    },
  }
}

// ============================================================================
// TYPES
// ============================================================================

export type PersistXyneStateFn = (state: XyneAgentState) => Promise<void>
export type LoadXyneStateFn = (
  chatExternalId: string,
) => Promise<XyneAgentState | null>

/**
 * Initialize fresh Xyne state
 */
export function createInitialXyneState(
  email: string,
  workspaceId: string,
  userId: string,
  chatExternalId: string,
  messageText: string,
  messageTimestamp: string,
): XyneAgentState {
  return {
    turnCount: 0,
    clarifications: [],
    ambiguityResolved: false,
    plan: null,
    currentSubTask: null,
    allFragments: [],
    turnFragments: new Map(),
    allImages: [],
    imagesByTurn: new Map(),
    recentImages: [],
    toolCallHistory: [],
    failedTools: new Map(),
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
    pendingExpectations: [],
    expectationHistory: new Map(),
    expectedResultsByCallId: new Map(),
    finalSynthesis: {
      requested: false,
      completed: false,
      suppressAssistantStreaming: false,
      streamedText: "",
    },
    delegationEnabled: true, // Default to enabled for main agent
    mcpAgents: [],
    currentTurnArtifacts: {
      fragments: [],
      unrankedFragmentsByTool: new Map(),
      expectations: [],
      toolOutputs: [],
      images: [],
      executionToolsCalled: 0,
      todoWriteCalled: false,
      turnStartedAt: Date.now(),
    },
    availableAgents: [],
    usedAgents: [],
    totalLatency: 0,
    totalCost: 0,
    tokenUsage: {
      input: 0,
      output: 0,
    },
    enabledTools: new Set(),
    retryCount: 0,
    maxRetries: 3,
    decisions: [],
    user: {
      email,
      workspaceId,
      id: userId,
    },
    chat: {
      externalId: chatExternalId,
      metadata: {},
    },
    message: {
      text: messageText,
      attachments: [],
      timestamp: messageTimestamp,
    },
    userContext: "",
    conversationHistoryMessages: [],
    seenDocuments: new Set(),
    citationDocIdMapping: new Map(),
    stopRequested: false,
    thinkingLog: "",
  }
}
