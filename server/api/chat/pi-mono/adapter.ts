/**
 * pi-mono Adapter for Xyne
 *
 * Bridges JAF-style tools to pi-mono ToolDefinition format
 * Maintains XyneAgentState alongside pi-mono's internal state
 *
 * Uses session-scoped storage to prevent state corruption across concurrent requests.
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import type { Static, TSchema } from "@sinclair/typebox"
import type { AgentRunContext } from "../agent-schemas"

/**
 * Xyne-specific state maintained alongside pi-mono session
 */
export interface XyneAgentState {
  // Clarification tracking
  clarifications: Array<{
    id: string
    question: string
    answer?: string
    timestamp: number
  }>
  ambiguityResolved: boolean
  pendingClarificationId?: string

  // Existing context fields
  plan: any | null
  currentSubTask: string | null
  allFragments: any[]
  toolCallHistory: any[]
  review: any
  finalSynthesis: any
  agentPrompt?: string
  userContext?: string
  dedicatedAgentSystemPrompt?: string
  modelId?: string

  // Turn artifacts
  currentTurnArtifacts: {
    fragments: any[]
    unrankedFragmentsByTool: Map<string, any>
    expectations: any[]
    toolOutputs: any[]
    images: any[]
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

  // User context
  user: {
    email: string
    workspaceId: string
    id: string
    numericId: number
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
  conversationHistoryMessages?: any[]

  // Memory
  episodicMemoriesText?: string
  chatMemoryText?: string

  // Seen documents (for dedup across turns)
  seenDocuments?: Set<string>

  // Stop/abort control
  stopController?: AbortController
  stopSignal?: AbortSignal
  stopRequested?: boolean

  // ... other fields from AgentRunContext
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
  numericId: number,
  chatExternalId: string,
  messageText: string,
  messageTimestamp: string,
): XyneAgentState {
  return {
    clarifications: [],
    ambiguityResolved: false,
    plan: null,
    currentSubTask: null,
    allFragments: [],
    toolCallHistory: [],
    review: {
      lockedByFinalSynthesis: false,
      lockedAtTurn: null,
    },
    finalSynthesis: {
      requested: false,
      completed: false,
      suppressAssistantStreaming: false,
      streamedText: "",
    },
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
    user: {
      email,
      workspaceId,
      id: userId,
      numericId,
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
    seenDocuments: new Set(),
  }
}
