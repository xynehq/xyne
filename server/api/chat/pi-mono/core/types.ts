import type { ImageContent, Model, ThinkingLevel } from "@mariozechner/pi-ai"
import type {
  AgentSession,
  AgentSessionEvent,
  CreateAgentSessionOptions,
  ExtensionFactory,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent"
import type { Static, TSchema } from "@sinclair/typebox"

export interface RAGAgentConfig<TState = unknown> {
  // --- Model ---
  /** Model ID string (resolved to LiteLLM config) or full pi-mono Model object */
  model: string | Model<any>
  /** LiteLLM base URL (required when model is a string) */
  baseUrl?: string
  /** API key for the model provider */
  apiKey?: string

  // --- Tools ---
  /** Custom tools for the agent (pi-mono ToolDefinition format) */
  tools: ToolDefinition<any, any, any>[]

  // --- Prompt ---
  /** System prompt for the agent */
  systemPrompt: string
  /** Additional text appended to the system prompt */
  appendSystemPrompt?: string

  // --- Session persistence ---
  /** Session manager — pass a pi-mono SessionManager directly.
   *  Use SessionManager.inMemory(), SessionManager.open(path), etc. */
  sessionManager?: CreateAgentSessionOptions["sessionManager"]

  // --- Settings ---
  /** Settings manager — controls compaction, retry, etc. */
  settingsManager?: CreateAgentSessionOptions["settingsManager"]

  // --- Extensions ---
  /** Pi-mono extension factories (full SDK compatibility) */
  extensions?: ExtensionFactory[]

  // --- Model options ---
  /** Thinking level for the model */
  thinkingLevel?: ThinkingLevel
  /** Models available for cycling */
  scopedModels?: CreateAgentSessionOptions["scopedModels"]

  // --- Auth & Model Registry ---
  /** Auth storage for credentials */
  authStorage?: CreateAgentSessionOptions["authStorage"]
  /** Model registry for API key resolution */
  modelRegistry?: CreateAgentSessionOptions["modelRegistry"]

  // --- Resource loader ---
  /** Custom resource loader (overrides default; when set, systemPrompt/extensions config is ignored) */
  resourceLoader?: CreateAgentSessionOptions["resourceLoader"]

  // --- User state ---
  /** Application-specific state carried through the agent lifecycle */
  state?: TState

  // --- Timeouts ---
  /** Max time to wait for agent completion (ms). Default: 5 minutes */
  timeoutMs?: number
}

// ============================================================================
// RAG AGENT INTERFACE
// ============================================================================

/**
 * A running RAG agent instance.
 */
export interface RAGAgent<TState = unknown> {
  /**
   * Run the agent with a user message.
   * Subscribes to events and yields them as an async iterable.
   */
  run(message: string, options?: RunOptions): AsyncIterable<RAGEvent>

  /** Force stop the agent */
  stop(): Promise<void>

  /** Access the underlying pi-mono AgentSession */
  getSession(): AgentSession

  /** Get current user state */
  getState(): TState | undefined

  /** Update the system prompt between turns */
  setSystemPrompt(prompt: string): void

  /** Dispose the agent session — call when done */
  dispose(): void
}

export interface RunOptions {
  /** Image attachments to include with the user message */
  images?: ImageContent[]
  /** Timeout override for this run (ms) */
  timeoutMs?: number
}

// ============================================================================
// RAG EVENTS
// ============================================================================

/**
 * Events emitted during agent execution.
 * Thin normalization of pi-mono's AgentSessionEvent.
 * Use `raw` type to access the original event when needed.
 */
export type RAGEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start"; turnIndex: number }
  | { type: "turn_end"; turnIndex: number }
  | {
      type: "tool_call"
      toolName: string
      toolCallId: string
      args: unknown
    }
  | {
      type: "tool_result"
      toolName: string
      toolCallId: string
      result: unknown
      isError: boolean
    }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; delta: string; contentIndex: number }
  | { type: "thinking_end"; contentIndex: number; contentSignature?: string }
  | {
      type: "message_end"
      message: { role: string; content?: string; stopReason?: string }
    }
  | { type: "error"; error: { message: string; code?: string } }
  | { type: "raw"; event: AgentSessionEvent }

export interface SimpleToolDefinition<
  TParams extends TSchema = TSchema,
  TState = unknown,
> {
  name: string
  description: string
  parameters: TParams
  /** Optional snippet for the system prompt's "Available tools" section */
  promptSnippet?: string
  execute: (
    toolCallId: string,
    params: Static<TParams>,
    context: ToolContext<TState>,
  ) => Promise<ToolResult>
}

export interface ToolContext<TState = unknown> {
  /** Application state (the TState from RAGAgentConfig) */
  state: TState
  /** Abort signal — cancelled when the agent is stopped */
  signal: AbortSignal | undefined
  /** Pi-mono extension context (for advanced use) */
  extensionContext: unknown
}

export interface ToolResult {
  /** Data returned to the LLM */
  data: unknown
  /** Optional details for rendering/logging (not sent to LLM) */
  details?: unknown
  /** Whether this result represents an error */
  isError?: boolean
}
