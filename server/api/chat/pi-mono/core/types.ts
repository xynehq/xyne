/**
 * Core Types for Pi-Mono Agentic RAG Abstraction
 *
 * Generic base types that can be extended for specific implementations.
 * Provides the foundation for runtime, event routing, and state management.
 */

/**
 * Generic agent state - extend this for your use case
 */
export interface AgentState {
  [key: string]: any
}

/**
 * Context provided to tools during execution
 */
export interface ToolExecutionContext<TState extends AgentState = AgentState> {
  state: TState
  userId: string
  workspaceId: string
  emit: (event: string, data: unknown) => void
  signal: AbortSignal | undefined
}

/**
 * Event types from pi-mono runtime
 */
export type PiMonoEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start"; turnIndex: number }
  | { type: "turn_end"; turnIndex: number }
  | { type: "tool_execution_start"; toolName: string; args: unknown }
  | {
      type: "tool_execution_end"
      toolName: string
      result: unknown
      isError: boolean
    }
  | { type: "tool_call"; toolName: string; args: unknown }
  | {
      type: "message_update"
      assistantMessageEvent: { type: string; delta?: string }
    }
  | { type: "assistant_message"; message: { content: string } }
  | { type: "error"; error: { message: string } }

/**
 * Configuration for creating an agent session
 */
export interface AgentSessionConfig<TState extends AgentState = AgentState> {
  model: string
  systemPrompt: string
  tools: any[] // Pi-mono ToolDefinition[]
  state: TState
  resourceLoader?: any // Pi-mono ResourceLoader
  authStorage?: any // Pi-mono AuthStorage
  modelRegistry?: any // Pi-mono ModelRegistry
}

/**
 * Handler for pi-mono events
 * Return true to stop processing, false to continue
 */
export type EventHandler<TState extends AgentState = AgentState> = (
  event: PiMonoEvent,
  context: {
    state: TState
    session: any // Pi-mono AgentSession
    emit: (event: string, data: unknown) => void
  },
) => Promise<boolean> | boolean

/**
 * Runtime configuration for connecting to LLM backend
 */
export interface RuntimeConfig {
  baseUrl: string
  apiKey?: string
  timeoutMs?: number
}

/**
 * Agent session interface - wraps pi-mono session
 */
export interface AgentSession {
  /**
   * Start the agent with a user message
   */
  start(message: string): Promise<void>

  /**
   * Subscribe to events
   */
  subscribe(handler: (event: unknown) => void): () => void

  /**
   * Force stop the agent
   */
  stop(): void

  /**
   * Access the underlying pi-mono session
   */
  getUnderlyingSession(): unknown

  /**
   * Update system prompt dynamically
   */
  updateSystemPrompt(prompt: string): void

  /**
   * Access user state attached to session
   */
  getState(): unknown
}

/**
 * Event router configuration
 */
export interface EventRouterConfig<TState extends AgentState> {
  state: TState
  session: any // Pi-mono session
  handlers: EventHandler<TState>[]
  onError?: (error: Error) => void
}

/**
 * State manager configuration
 */
export interface StateManagerConfig<TState extends AgentState> {
  initialState: TState
  onPersist?: (state: TState) => Promise<void>
}

/**
 * Typed event handler map for createEventHandler helper
 */
export type EventHandlerMap<TState extends AgentState> = Partial<{
  [K in PiMonoEvent["type"]]: (
    event: Extract<PiMonoEvent, { type: K }>,
    context: {
      state: TState
      session: any
      emit: (e: string, d: unknown) => void
    },
  ) => Promise<boolean> | boolean
}>
