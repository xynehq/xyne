/**
 * pi-mono Adapter for Xyne
 *
 * Bridges JAF-style tools to pi-mono ToolDefinition format
 * Maintains XyneAgentState using pi-mono's state-manager
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import type { Static, TSchema } from "@sinclair/typebox"
import type { AgentRunContext } from "../agent-schemas"
import { createStateManager } from "./core/state-manager"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Chat)

export interface XyneAgentState {
  clarifications: Array<{
    id: string
    question: string
    answer?: string
    timestamp: number
  }>
  ambiguityResolved: boolean
  pendingClarificationId?: string
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
  availableAgents: Array<{
    agentId: string
    agentName: string
    description?: string
    capabilities?: string[]
  }>
  usedAgents: string[]
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
  conversationHistoryMessages?: any[]
  episodicMemoriesText?: string
  chatMemoryText?: string
  seenDocuments?: Set<string>
  stopController?: AbortController
  stopSignal?: AbortSignal
  stopRequested?: boolean
  thinkingLog?: string
}

export interface XyneToolContext {
  events: {
    emit: (event: string, payload: any) => void
  }
  xyneState: XyneAgentState
  persistState: () => Promise<void>
  runtime?: {
    streamAnswerText: (text: string) => Promise<void>
    emitReasoning: (payload: any) => Promise<void>
  }
}

function createDefaultInitialState(): XyneAgentState {
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
      email: "",
      workspaceId: "",
      id: "",
    },
    chat: {
      externalId: "",
      metadata: {},
    },
    message: {
      text: "",
      attachments: [],
      timestamp: "",
    },
    seenDocuments: new Set(),
  }
}

export const xyneStateManager = createStateManager<XyneAgentState>({
  initialState: createDefaultInitialState(),
  onPersist: async (state) => {
    Logger.debug({ chatId: state.chat.externalId }, "Persisting Xyne state via state-manager")
  },
})

const runtimeStore = new Map<string, XyneToolContext["runtime"]>()
const persistFnStore = new Map<string, PersistXyneStateFn>()

export function registerSession(
  sessionId: string,
  state: XyneAgentState,
  persistFn: PersistXyneStateFn,
  runtime?: XyneToolContext["runtime"],
): void {
  xyneStateManager.register(sessionId)
  const registeredState = xyneStateManager.get(sessionId)
  Object.assign(registeredState, state)
  runtimeStore.set(sessionId, runtime)
  persistFnStore.set(sessionId, persistFn)
}

export function setSessionRuntime(
  sessionId: string,
  runtime: XyneToolContext["runtime"],
): void {
  runtimeStore.set(sessionId, runtime)
}

export function unregisterSession(sessionId: string): void {
  xyneStateManager.unregister(sessionId)
  runtimeStore.delete(sessionId)
  persistFnStore.delete(sessionId)
}

const stateMap = new WeakMap<any, string>()

export function getXyneState(ctx?: any): XyneAgentState {
  const lookupCtx = ctx && ctx.session ? ctx.session : ctx
  if (lookupCtx && stateMap.has(lookupCtx)) {
    const sessionId = stateMap.get(lookupCtx)!
    return xyneStateManager.get(sessionId)
  }
  return xyneStateManager.get()
}

export function setXyneState(ctx: any, state: XyneAgentState): void {
  const sessionId = state.chat.externalId
  stateMap.set(ctx, sessionId)
}

export function setPersistFunction(fn: PersistXyneStateFn): void {
  const activeSessionId = xyneStateManager.getActiveSessionId()
  if (activeSessionId) {
    persistFnStore.set(activeSessionId, fn)
  }
}

export function setRuntime(runtime: XyneToolContext["runtime"]): void {
  const activeSessionId = xyneStateManager.getActiveSessionId()
  if (activeSessionId) {
    setSessionRuntime(activeSessionId, runtime)
  }
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
      const sessionId = xyneState.chat.externalId
      const runtime = runtimeStore.get(sessionId)
      const persistFn = persistFnStore.get(sessionId)

      const xyneCtx: XyneToolContext = {
        events: (extCtx as any).events || { emit: () => {} },
        xyneState,
        persistState: async () => {
          if (persistFn) {
            await persistFn(xyneState)
          }
          await xyneStateManager.persist(sessionId)
        },
        runtime,
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

export type PersistXyneStateFn = (state: XyneAgentState) => Promise<void>
export type LoadXyneStateFn = (
  chatExternalId: string,
) => Promise<XyneAgentState | null>

export function createInitialXyneState(
  email: string,
  workspaceId: string,
  userId: string,
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
