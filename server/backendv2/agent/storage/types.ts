// Storage types for the agent layer.
//
// Design rules:
//   • Four narrow interfaces — ConversationRepo, MessageRepo, StreamBus, BlobStore.
//   • Each interface is a strategy slot; implementations swap independently.
//   • No auth in the repos. Services enforce permissions before calling.
//   • Content blocks are a discriminated union — exhaustive switch in render code.
//   • Writes that span multiple repos run inside a UnitOfWork transaction.

// ─── Branded ids ─────────────────────────────────────────────────────────────
type Brand<T, K extends string> = T & { readonly _brand: K }

export type WorkspaceId = Brand<string, "WorkspaceId">
export type UserId = Brand<string, "UserId">
export type AgentId = Brand<string, "AgentId">
export type ConversationId = Brand<string, "ConversationId">
export type TurnId = Brand<string, "TurnId">
export type RunId = Brand<string, "RunId">
export type MessageId = Brand<string, "MessageId">
export type ToolCallId = Brand<string, "ToolCallId">
export type MessageFeedbackId = Brand<string, "MessageFeedbackId">
export type BlobRef = Brand<string, "BlobRef">

export const asWorkspaceId = (v: string): WorkspaceId => v as WorkspaceId
export const asUserId = (v: string): UserId => v as UserId
export const asAgentId = (v: string): AgentId => v as AgentId
export const asConversationId = (v: string): ConversationId =>
  v as ConversationId
export const asTurnId = (v: string): TurnId => v as TurnId
export const asRunId = (v: string): RunId => v as RunId
export const asMessageId = (v: string): MessageId => v as MessageId
export const asToolCallId = (v: string): ToolCallId => v as ToolCallId
export const asMessageFeedbackId = (v: string): MessageFeedbackId =>
  v as MessageFeedbackId
export const asBlobRef = (v: string): BlobRef => v as BlobRef

// ─── Content blocks (discriminated union) ────────────────────────────────────
export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool_use"
      toolCallId: ToolCallId
      toolName: string
      args: unknown
    }
  | {
      kind: "tool_result"
      toolCallId: ToolCallId
      output: unknown
      isError: boolean
      blobRef?: BlobRef
    }
  | { kind: "image"; blobRef: BlobRef; mime: string; alt?: string }
  | {
      kind: "citation"
      index: number
      docId: string
      url?: string
      title?: string
    }
  | { kind: "handoff"; targetAgentId: AgentId; reason: string }
  | { kind: "error"; code: string; message: string }

export type BlockKind = Block["kind"]

// ─── Entities ────────────────────────────────────────────────────────────────
export type Conversation = {
  id: ConversationId
  ownerId: UserId
  workspaceId: WorkspaceId
  title: string
  agentId?: AgentId
  createdAt: number
  updatedAt: number
  archivedAt?: number
}

export type ConversationInit = {
  ownerId: UserId
  workspaceId: WorkspaceId
  title: string
  agentId?: AgentId
}

export type ConversationPatch = {
  title?: string
  archivedAt?: number | null
}

export type TurnStatus = "running" | "completed" | "errored" | "aborted"

export type Turn = {
  id: TurnId
  conversationId: ConversationId
  status: TurnStatus
  startedAt: number
  endedAt?: number
  error?: string
}

export type RunStatus = TurnStatus

export type Run = {
  id: RunId
  conversationId: ConversationId // denormalized for fast filtering / analytics
  turnId: TurnId
  parentRunId?: RunId
  /** M7 — populated on nested runs spawned by `dispatchSubagent`.
   *  Holds the sub-agent's `external_id` as plain text (no FK). */
  subAgentId?: string
  agentId: AgentId
  model: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
  error?: string
}

export type RunInit = {
  parentRunId?: RunId
  agentId: AgentId
  model: string
  /** M7 — set on nested runs spawned by `dispatchSubagent`. Stores the
   *  sub-agent's external_id as plain text (no FK). NULL / omitted on
   *  top-level (parent) runs. */
  subAgentId?: string
}

export type RunStats = {
  status: RunStatus
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
  error?: string
}

export type MessageRole = "user" | "assistant" | "system"

/** Per-turn telemetry attached to the assistant Message at run completion.
 *  Lives on the record so a page refresh's GET /messages restores it — the
 *  in-flight run_stats SSE event is only delivered once. */
export type MessageStats = {
  tokenUsage: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  cacheHitRatio: number
  contextUsage?: {
    tokens?: number
    contextWindow?: number
    percent?: number
  }
  compactionRounds: number
  retryAttempts: number
  durationMs: number
}

export type Message = {
  id: MessageId
  conversationId: ConversationId
  turnId: TurnId
  runId?: RunId // assistant/system messages belong to a Run; user messages don't
  role: MessageRole
  ordinal: number
  parentMessageId?: MessageId
  createdAt: number
  stats?: MessageStats
}

export type MessageWithBlocks = Message & { blocks: Block[] }

// ─── Pagination / transaction ────────────────────────────────────────────────
export type Cursor =
  | { kind: "first"; limit: number }
  | { kind: "after"; token: string; limit: number }

export type Page<T> = {
  items: T[]
  nextCursor?: string
}

// Opaque transaction handle. InMemory uses a no-op; Postgres will use a real tx.
export type Tx = { readonly _tx: true }

export interface UnitOfWork {
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
}

// ─── Inputs for atomic writes ────────────────────────────────────────────────
export type NewUserMessage = {
  blocks: Block[]
  parentMessageId?: MessageId
}

export type AppendTurnInput = {
  conversationId: ConversationId
  userMessage: NewUserMessage
}

export type AppendTurnResult = {
  turn: Turn
  userMessage: Message
}

export type NewAssistantMessage = {
  blocks: Block[]
  parentMessageId?: MessageId
}

// ─── Stream bus events ───────────────────────────────────────────────────────
export type StreamEvent =
  | { kind: "turn_started"; turnId: TurnId; conversationId: ConversationId }
  | {
      kind: "run_started"
      runId: RunId
      turnId: TurnId
      parentRunId?: RunId
      agentId: AgentId
    }
  | { kind: "run_ended"; runId: RunId; stats: RunStats }
  | { kind: "message_appended"; messageId: MessageId; role: MessageRole }
  | { kind: "block_appended"; messageId: MessageId; block: Block }
  // Live text delta — for streaming UI. Not a committed block.
  | { kind: "text_delta"; messageId: MessageId; delta: string }
  // Final commit of accumulated text up to this boundary. Frontend drains
  // its delta buffer and appends a text block to message.blocks.
  | { kind: "text_committed"; messageId: MessageId; text: string }
  // Same pattern for reasoning/thinking, kept on a separate channel so the
  // UI can render it in a collapsible panel distinct from the answer text.
  | { kind: "thinking_delta"; messageId: MessageId; delta: string }
  | { kind: "thinking_committed"; messageId: MessageId; text: string }
  // Per-turn telemetry — emitted once when the pi-mono run wraps. Frontend
  // attaches this to the assistant message so the UI can render token usage,
  // context %, cache hit ratio, and any compaction/retry counts.
  | {
      kind: "run_stats"
      runId: RunId
      messageId: MessageId
      tokenUsage: {
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
      }
      cacheHitRatio: number
      contextUsage?: {
        tokens?: number
        contextWindow?: number
        percent?: number
      }
      compactionRounds: number
      retryAttempts: number
      durationMs: number
    }
  | {
      kind: "turn_ended"
      turnId: TurnId
      status: TurnStatus
      error?: string
    }
  | {
      kind: "conversation_renamed"
      conversationId: ConversationId
      title: string
    }
  // Per-turn debug capture. Only emitted when the caller opted into
  // debug mode on POST /messages; otherwise this kind never fires.
  // Payload shape is the union from
  // server/backendv2/agent/pi-mono/debug/types.ts — kept as `unknown`
  // here to avoid pulling that module into the storage type graph.
  // The frontend filters by `runId` / `kind` and rehydrates.
  | {
      kind: "debug_event"
      runId: RunId
      messageId: MessageId
      // DebugEvent from pi-mono/debug/types.ts (request / response_chunk
      // / tool_call_start / tool_call_end / compaction_start /
      // compaction_end / agent_end / error).
      event: unknown
    }

export type Unsubscribe = () => void

export type BlobMeta = {
  mime: string
  filename?: string
  ownerUserId?: UserId
  byteSize?: number
}

export type StoredBlob = {
  ref: BlobRef
  content: Uint8Array
  meta: BlobMeta
}

// ─── ToolCall projection ─────────────────────────────────────────────────────
// Sideways index of every tool invocation in the system. Populated by the
// repo whenever a `tool_use` or `tool_result` block is appended. Lets you
// answer analytics queries ("all searchKnowledgeBase calls last hour")
// without parsing JSONB.
export type ToolCallStatus = "pending" | "completed" | "error"

export type ToolCall = {
  id: ToolCallId
  conversationId: ConversationId
  turnId: TurnId
  runId: RunId
  agentId: AgentId
  messageId: MessageId // message containing the `tool_use` block
  toolName: string
  args: unknown
  result?: unknown
  isError: boolean
  status: ToolCallStatus
  startedAt: number
  completedAt?: number
}

// Idempotency key. Callers (services) generate it; repos memoize results by
// this key so a network retry that hits the same write doesn't duplicate.
export type IdemKey = string

// ─── The 4 strategy interfaces ───────────────────────────────────────────────
export interface ConversationRepo {
  create(
    init: ConversationInit,
    idemKey: IdemKey,
    tx?: Tx,
  ): Promise<Conversation>
  get(id: ConversationId, tx?: Tx): Promise<Conversation | null>
  listByOwner(
    ownerId: UserId,
    page: Cursor,
    tx?: Tx,
  ): Promise<Page<Conversation>>
  patch(id: ConversationId, patch: ConversationPatch, tx?: Tx): Promise<void>
  softDelete(id: ConversationId, tx?: Tx): Promise<void>
}

export interface MessageRepo {
  // Atomic: create a Turn + insert the user Message + its blocks
  appendTurn(
    input: AppendTurnInput,
    idemKey: IdemKey,
    tx?: Tx,
  ): Promise<AppendTurnResult>

  // Agent execution within a turn (can nest via parentRunId for sub-agents)
  startRun(
    turnId: TurnId,
    init: RunInit,
    idemKey: IdemKey,
    tx?: Tx,
  ): Promise<Run>
  endRun(runId: RunId, stats: RunStats, tx?: Tx): Promise<void>

  // Assistant/system messages produced during a run
  appendAssistantMessage(
    runId: RunId,
    message: NewAssistantMessage,
    idemKey: IdemKey,
    tx?: Tx,
  ): Promise<Message>

  // Stream blocks into an existing message (one block at a time). Tool-call
  // blocks are projected into the `toolCalls` index automatically.
  appendBlock(messageId: MessageId, block: Block, tx?: Tx): Promise<void>

  // Attach per-turn telemetry to an assistant message after the run wraps,
  // so a refresh's listMessages() can rehydrate the stats footer.
  setStats(messageId: MessageId, stats: MessageStats, tx?: Tx): Promise<void>

  endTurn(
    turnId: TurnId,
    status: TurnStatus,
    error: string | undefined,
    tx?: Tx,
  ): Promise<void>

  // Reads — messages / runs
  listMessages(
    conversationId: ConversationId,
    page: Cursor,
    tx?: Tx,
  ): Promise<Page<MessageWithBlocks>>
  getMessage(id: MessageId, tx?: Tx): Promise<MessageWithBlocks | null>
  listRunsForTurn(turnId: TurnId, tx?: Tx): Promise<Run[]>
  listRunsForConversation(
    conversationId: ConversationId,
    page: Cursor,
    tx?: Tx,
  ): Promise<Page<Run>>

  // M8 — nested-run replay surface.
  //
  // listChildRuns: every run whose `parent_run_id = parentRunId`,
  // ordered by `started_at` ASC. Matches the order in which the parent
  // dispatched sub-agents within a single turn.
  //
  // listMessagesByRun: every message whose `run_id = runId`, ordered
  // by ordinal ASC. Bypasses the nested-message filter in
  // listMessages — we WANT the sub-agent's messages here.
  listChildRuns(
    conversationId: ConversationId,
    parentRunId: RunId,
    tx?: Tx,
  ): Promise<Run[]>
  listMessagesByRun(
    runId: RunId,
    tx?: Tx,
  ): Promise<MessageWithBlocks[]>

  // Reads — tool call projection (analytics surface)
  getToolCall(id: ToolCallId, tx?: Tx): Promise<ToolCall | null>
  listToolCalls(
    filter: {
      conversationId?: ConversationId
      turnId?: TurnId
      runId?: RunId
      toolName?: string
    },
    page: Cursor,
    tx?: Tx,
  ): Promise<Page<ToolCall>>

  // Debug — full snapshot of a conversation for offline inspection.
  // Returns every related row regardless of nested-run filtering:
  // every message (incl. sub-agent runs), every run (parent + nested),
  // every tool call. Used by /v2/chat/conversations/:id/dump so an
  // operator can export the entire turn graph as JSON when debugging
  // a misbehaving agent.
  dumpConversation(
    conversationId: ConversationId,
    tx?: Tx,
  ): Promise<{
    messages: MessageWithBlocks[]
    runs: Run[]
    toolCalls: ToolCall[]
  }>
}

// ─── Message feedback ────────────────────────────────────────────────────────
// Mirrors v1's shared enum so cross-version analytics can union the two tables.
export type MessageFeedbackRating = "like" | "dislike"

export type MessageFeedback = {
  id: MessageFeedbackId
  messageId: MessageId
  conversationId: ConversationId
  runId?: RunId
  userId: UserId
  workspaceId: WorkspaceId
  rating: MessageFeedbackRating
  tags: string[]
  comment?: string
  shareChat: boolean
  modelSnapshot?: string
  latencyMs?: number
  tokensIn?: number
  tokensOut?: number
  retrievedSourceIds?: string[]
  createdAt: number
  updatedAt: number
}

export type MessageFeedbackInput = {
  rating: MessageFeedbackRating
  tags?: string[]
  comment?: string
  shareChat?: boolean
  modelSnapshot?: string
  latencyMs?: number
  tokensIn?: number
  tokensOut?: number
  retrievedSourceIds?: string[]
}

export interface MessageFeedbackRepo {
  upsert(
    keys: {
      messageId: MessageId
      conversationId: ConversationId
      userId: UserId
      workspaceId: WorkspaceId
      runId?: RunId
    },
    input: MessageFeedbackInput,
    tx?: Tx,
  ): Promise<MessageFeedback>

  get(
    keys: { messageId: MessageId; userId: UserId },
    tx?: Tx,
  ): Promise<MessageFeedback | null>

  delete(
    keys: { messageId: MessageId; userId: UserId },
    tx?: Tx,
  ): Promise<boolean>
}

export interface StreamBus {
  /** Publish an event to a channel. Returns the per-channel monotonic seq#
   *  assigned to this event — caller (the SSE handler) writes it as the SSE
   *  `id:` field so the browser will send it back as `Last-Event-ID` on
   *  reconnect, enabling exact resume. */
  publish(channelId: string, event: StreamEvent): Promise<number>
  /** Subscribe to a channel.
   *  @param sinceSeq  optional cursor — replay buffered events with seq > sinceSeq
   *                   to the new subscriber BEFORE attaching it for future events.
   *  @param onEvent  delivers each event with its monotonic seq.
   */
  subscribe(
    channelId: string,
    onEvent: (e: StreamEvent, seq: number) => void,
    opts?: { sinceSeq?: number },
  ): Unsubscribe
}

export interface BlobStore {
  put(content: Uint8Array, meta: BlobMeta): Promise<BlobRef>
  get(ref: BlobRef): Promise<StoredBlob | null>
  delete(ref: BlobRef): Promise<void>
}
