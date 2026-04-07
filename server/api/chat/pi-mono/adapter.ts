/**
 * Pi-Mono Adapter for Xyne
 *
 * Bridges JAF-style tools to pi-mono ToolDefinition format.
 * Simplified session storage using single Map keyed by chatExternalId.
 */

import type { Message } from "@aws-sdk/client-bedrock-runtime"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import type { Static, TSchema } from "@sinclair/typebox"
import type {
  Clarification,
  Decision,
  ToolExecutionRecord,
} from "../agent-schemas"
import type { MinimalAgentFragment } from "../types"

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

export interface ToolExpectationAssignment {
  toolName: string
  expectation: ToolExpectation
}

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
  sessionId?: string
  turnCount: number
  clarifications: Clarification[]
  ambiguityResolved: boolean
  pendingClarificationId?: string
  plan: any | null
  currentSubTask: string | null
  allFragments: MinimalAgentFragment[]
  turnFragments: Map<number, MinimalAgentFragment[]>
  toolCallHistory: ToolExecutionRecord[]
  failedTools: Map<string, ToolFailureInfo>
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
  pendingExpectations: ToolExpectationAssignment[]
  expectationHistory: Map<number, ToolExpectationAssignment[]>
  expectedResultsByCallId: Map<string, ToolExpectation>
  finalSynthesis: any
  agentPrompt?: string
  userContext: string
  dedicatedAgentSystemPrompt?: string
  modelId?: string
  delegationEnabled: boolean
  maxOutputTokens?: number
  mcpAgents: MCPVirtualAgentRuntime[]
  currentTurnArtifacts: {
    fragments: MinimalAgentFragment[]
    unrankedFragmentsByTool: Map<
      string,
      { query: string; fragments: MinimalAgentFragment[] }
    >
    expectations: ToolExpectationAssignment[]
    toolOutputs: any[]
    executionToolsCalled: number
    todoWriteCalled: boolean
    turnStartedAt: number
  }
  availableAgents: Array<{
    agentId: string
    agentName: string
    description?: string
    capabilities?: string[]
  }>
  usedAgents: string[]
  totalLatency: number
  totalCost: number
  tokenUsage: { input: number; output: number }
  enabledTools: Set<string>
  retryCount: number
  maxRetries: number
  decisions: Decision[]
  user: {
    email: string
    workspaceId: string
    id: string
    numericId?: number
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
  conversationHistoryMessages: Message[]
  episodicMemoriesText?: string
  chatMemoryText?: string
  seenDocuments: Set<string> // Kept for backward compatibility, not used for deduplication
  seenChunks: Set<string> // Tracks seen docId_chunkIndex pairs for chunk-level deduplication
  seenDocIds: Set<string> // Tracks seen document IDs for fallback deduplication when chunk tracking unavailable
  citationDocIdMapping: Map<number, string>
  searchQueryHistory: Array<{
    query: string
    keywords: string[]
    filters: string
    timestamp: number
  }>
  stopController?: AbortController
  stopSignal?: AbortSignal
  stopRequested: boolean
  thinkingLog?: string
  reviewCount: number
}

/**
 * Context passed to tool execute functions
 */
export interface XyneToolContext {
  events: { emit: (event: string, payload: any) => void }
  xyneState: XyneAgentState
  runtime?: {
    streamAnswerText: (text: string) => Promise<void>
    emitReasoning: (payload: any) => Promise<void>
  }
}

export type PersistXyneStateFn = (state: XyneAgentState) => Promise<void>

interface SessionContext {
  state: XyneAgentState
  runtime?: XyneToolContext["runtime"]
}

/** Single Map for session storage keyed by sessionId */
const sessionStore = new Map<string, SessionContext>()

export function registerSession(
  sessionId: string,
  state: XyneAgentState,
  runtime?: XyneToolContext["runtime"],
): void {
  state.sessionId = sessionId
  sessionStore.set(sessionId, { state, runtime })
}

export function setSessionRuntime(
  sessionId: string,
  runtime: XyneToolContext["runtime"],
): void {
  const session = sessionStore.get(sessionId)
  if (session) session.runtime = runtime
}

export function unregisterSession(sessionId: string): void {
  sessionStore.delete(sessionId)
}

/**
 * Get Xyne state from extension context
 */
export function getXyneState(ctx: any): XyneAgentState {
  const piMonoSessionId = ctx?.sessionManager?.sessionId
  if (piMonoSessionId && sessionStore.has(piMonoSessionId)) {
    return sessionStore.get(piMonoSessionId)!.state
  }

  throw new Error(
    `Xyne session not found for pi-mono session: ${piMonoSessionId || "unknown"}`,
  )
}

export function setRuntime(runtime: XyneToolContext["runtime"]): void {
  const lastSession = Array.from(sessionStore.values()).pop()
  if (lastSession) lastSession.runtime = runtime
}

export function setXyneState(ctx: any, state: XyneAgentState): void {
  const sessionId = state.chat.externalId
  const session = sessionStore.get(sessionId)
  if (session) session.state = state
}

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
      const xyneState = getXyneState(extCtx)
      const sessionId = xyneState.sessionId || xyneState.chat.externalId
      const session = sessionStore.get(sessionId)
      if (!session) throw new Error(`Session not found: ${sessionId}`)

      const xyneCtx: XyneToolContext = {
        events: (extCtx as any).events || { emit: () => {} },
        xyneState,
        runtime: session.runtime,
      }

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

/**
 * Initialize fresh Xyne state
 */
export function createInitialXyneState(
  email: string,
  workspaceId: string,
  userId: string,
  numericId: number,
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
    delegationEnabled: true,
    mcpAgents: [],
    currentTurnArtifacts: {
      fragments: [],
      unrankedFragmentsByTool: new Map(),
      expectations: [],
      toolOutputs: [],
      executionToolsCalled: 0,
      todoWriteCalled: false,
      turnStartedAt: Date.now(),
    },
    availableAgents: [],
    usedAgents: [],
    totalLatency: 0,
    totalCost: 0,
    tokenUsage: { input: 0, output: 0 },
    enabledTools: new Set(),
    retryCount: 0,
    maxRetries: 3,
    decisions: [],
    user: { email, workspaceId, id: userId, numericId },
    chat: { externalId: chatExternalId, metadata: {} },
    message: {
      text: messageText,
      attachments: [],
      timestamp: messageTimestamp,
    },
    userContext: "",
    conversationHistoryMessages: [],
    seenDocuments: new Set(),
    seenChunks: new Set(),
    seenDocIds: new Set(),
    citationDocIdMapping: new Map(),
    searchQueryHistory: [],
    stopRequested: false,
    reviewCount: 0,
  }
}
