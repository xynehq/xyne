/**
 * pi-mono Adapter for Xyne
 *
 * Bridges JAF-style tools to pi-mono ToolDefinition format
 * Maintains XyneAgentState alongside pi-mono's internal state
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Static, TSchema } from "@sinclair/typebox";
import type { AgentRunContext } from "../agent-schemas";

/**
 * Xyne-specific state maintained alongside pi-mono session
 */
export interface XyneAgentState {
  // Clarification tracking
  clarifications: Array<{
    id: string;
    question: string;
    answer?: string;
    timestamp: number;
  }>;
  ambiguityResolved: boolean;
  pendingClarificationId?: string;

  // Existing context fields
  plan: any | null;
  currentSubTask: string | null;
  allFragments: any[];
  toolCallHistory: any[];
  review: any;
  finalSynthesis: any;
  agentPrompt?: string;
  userContext?: string;
  dedicatedAgentSystemPrompt?: string;
  modelId?: string;

  // Turn artifacts
  currentTurnArtifacts: {
    fragments: any[];
    unrankedFragmentsByTool: Map<string, any>;
    expectations: any[];
    toolOutputs: any[];
    images: any[];
    executionToolsCalled: number;
    todoWriteCalled: boolean;
    turnStartedAt: number;
  };

  // Agent delegation
  availableAgents: Array<{
    agentId: string;
    agentName: string;
    description?: string;
    capabilities?: string[];
  }>;
  usedAgents: string[];

  // User context
  user: {
    email: string;
    workspaceId: string;
    id: string;
    numericId: number;
    workspaceNumericId?: number;
    timeZone?: string;
  };
  chat: {
    id?: number;
    externalId: string;
    metadata: Record<string, any>;
  };
  message: {
    text: string;
    attachments: Array<{ fileId: string; isImage: boolean }>;
    timestamp: string;
  };

  // Stop/abort control
  stopController?: AbortController;
  stopSignal?: AbortSignal;
  stopRequested?: boolean;

  // ... other fields from AgentRunContext
}

/**
 * Context passed to tool execute functions
 * Combines pi-mono ExtensionContext with Xyne state
 */
export interface XyneToolContext {
  // pi-mono provided
  events: {
    emit: (event: string, payload: any) => void;
  };

  // Xyne-specific state (stored separately)
  xyneState: XyneAgentState;

  // Helpers
  persistState: () => Promise<void>;
}

/**
 * Convert JAF-style tool to pi-mono ToolDefinition
 *
 * @param name Tool name
 * @param description Tool description
 * @param parameters TypeBox schema for parameters
 * @param execute Execute function with Xyne context
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
      // Get Xyne state from extension context
      const xyneState = getXyneState(extCtx);

      // Create Xyne tool context
      const xyneCtx: XyneToolContext = {
        events: (extCtx as any).events || { emit: () => {} },
        xyneState,
        persistState: async () => {
          await persistXyneState(xyneState);
        },
      };

      // Execute with Xyne context
      return execute(
        toolCallId,
        params as Static<TParams>,
        signal,
        onUpdate,
        xyneCtx,
      );
    },
  };
}

/**
 * Get Xyne state from extension context
 * Uses WeakMap to associate state with context object
 */
const stateMap = new WeakMap<any, XyneAgentState>();

/**
 * Persist function - will be set during initialization
 */
let persistXyneState: PersistXyneStateFn = async () => {
  // Default no-op, should be overridden
  console.warn("persistXyneState not initialized");
};

export function getXyneState(ctx: any): XyneAgentState {
  if (!stateMap.has(ctx)) {
    throw new Error("Xyne state not initialized for this context");
  }
  return stateMap.get(ctx)!;
}

export function setXyneState(ctx: any, state: XyneAgentState): void {
  stateMap.set(ctx, state);
}

/**
 * Set the persist function
 */
export function setPersistFunction(fn: PersistXyneStateFn): void {
  persistXyneState = fn;
}

/**
 * Persist Xyne state to database
 * NOTE: Implement this based on your database schema
 */
export type PersistXyneStateFn = (state: XyneAgentState) => Promise<void>;

/**
 * Load Xyne state from database
 * NOTE: Implement this based on your database schema
 */
export type LoadXyneStateFn = (
  chatExternalId: string,
) => Promise<XyneAgentState | null>;

/**
 * Initialize fresh Xyne state
 */
export function createInitialXyneState(
  email: string,
  workspaceId: string,
  userId: number,
  chatExternalId: string,
  messageText: string,
  attachments: Array<{ fileId: string; isImage: boolean }>,
): XyneAgentState {
  return {
    clarifications: [],
    ambiguityResolved: true,
    plan: null,
    currentSubTask: null,
    allFragments: [],
    toolCallHistory: [],
    review: {
      lastReviewTurn: null,
      reviewFrequency: 5,
      lastReviewedFragmentIndex: 0,
      lastReviewResult: null,
      outstandingAnomalies: [],
      clarificationQuestions: [],
      lockedByFinalSynthesis: false,
      lockedAtTurn: null,
    },
    finalSynthesis: {
      requested: false,
      completed: false,
      suppressAssistantStreaming: false,
      streamedText: "",
      ackReceived: false,
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
      id: String(userId),
      numericId: userId,
    },
    chat: {
      externalId: chatExternalId,
      metadata: {},
    },
    message: {
      text: messageText,
      attachments,
      timestamp: new Date().toISOString(),
    },
  };
}