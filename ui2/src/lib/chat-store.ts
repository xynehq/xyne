// Singleton chat store — lives outside the React tree so streams survive
// route changes. Components subscribe per-conv via useSyncExternalStore so
// only the conversation that actually changed re-renders.
//
// Hot path (text deltas) is rAF-batched: deltas accumulate into a side buffer
// immediately, then once per animation frame we fold the buffer into the
// conv state with an immutable update and notify subscribers.

import { useSyncExternalStore } from "react"
import {
  apiFetch,
  submitMessageFeedback as apiSubmitFeedback,
  type FeedbackRating,
} from "./api"
import { appendDebugEvent } from "./debug-store"
import { preferencesStore } from "./preferences"

// ─── Wire types (match backendv2 storage/types.ts) ──────────────────────────
export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; toolCallId: string; toolName: string; args: unknown }
  | {
      kind: "tool_result"
      toolCallId: string
      output: unknown
      isError: boolean
    }
  | { kind: "image"; blobRef: string; mime: string; alt?: string }
  | {
      kind: "citation"
      index: number
      docId: string
      url?: string
      title?: string
    }
  | { kind: "handoff"; targetAgentId: string; reason: string }
  | { kind: "error"; code: string; message: string }

export type ServerMessage = {
  id: string
  conversationId: string
  turnId: string
  runId?: string
  role: "user" | "assistant" | "system"
  ordinal: number
  createdAt: number
  blocks: Block[]
  // Persisted per-turn telemetry — present on assistant messages whose run
  // has completed. Mirrors what the live `run_stats` SSE event carries, so a
  // refresh's listMessages() can rehydrate the footer.
  stats?: MessageStats
}

export type Conversation = {
  id: string
  ownerId: string
  workspaceId: string
  title: string
  createdAt: number
  updatedAt: number
}

type ConvStatus = "idle" | "loading" | "streaming" | "error"

/** Per-message telemetry emitted by backendv2 once a run completes. Indexed
 *  by assistantMessageId on ConvState so MessageBubble can render a footer. */
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

export type ConvState = {
  id: string
  title?: string
  messages: ServerMessage[]
  streamingMessageId?: string
  streamingText: string
  streamingThinking: string
  statsByMessageId: Record<string, MessageStats>
  // In-memory only: rating per assistant message. Survives navigation within
  // the same session but not page refresh (server has the durable record;
  // we just don't currently preload it). Update path: user submits → action
  // posts to server → on success this map is set so the icon paints filled.
  feedbackByMessageId: Record<string, FeedbackRating>
  status: ConvStatus
  error?: string
}

const EMPTY: ConvState = {
  id: "",
  messages: [],
  streamingText: "",
  streamingThinking: "",
  statsByMessageId: {},
  feedbackByMessageId: {},
  status: "idle",
}

// ─── Store state ────────────────────────────────────────────────────────────
const convs = new Map<string, ConvState>()
let convList: Conversation[] = []

// Per-conv listener buckets so a delta on conv A doesn't wake conv B's render.
const convListeners = new Map<string, Set<() => void>>()
const listListeners = new Set<() => void>()

// EventSource bookkeeping — outside React state on purpose.
const eventSources = new Map<string, EventSource>()
// We track the "ready" promise as a pending-pair so it can survive an
// EventSource being torn down before it fires. React 19 strict mode
// double-mounts the chat route synchronously, which closes the ES the
// composer just opened; without survival, sendMessage's `await
// openStream(...)` would deadlock and the POST /messages never fires.
type ReadyPair = { promise: Promise<void>; resolve: () => void }
const streamReady = new Map<string, ReadyPair>()

// Per-conv resume cursor. We persist the last seq# the client received for
// each conv to sessionStorage so a page refresh can ask the server for events
// >cursor, instead of either (a) re-replaying the whole ring buffer (which
// produces duplicates against the GET /messages baseline) or (b) missing
// in-flight deltas. Browser's native EventSource only re-sends Last-Event-ID
// for same-instance reconnects (network blips) — not full page reloads, so
// we manage the cursor manually and pass it as ?sinceSeq=N.
//
// Map keyed by convId so multiple conversations carry independent cursors —
// switching tabs or having two convs open at once doesn't cross-contaminate.
const LAST_SEQ_STORAGE_KEY = "ui2.chat.lastSeqByConv"
const lastSeqByConv: Record<string, number> = (() => {
  try {
    const raw = sessionStorage.getItem(LAST_SEQ_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch {
    return {}
  }
})()
const persistLastSeq = (): void => {
  try {
    sessionStorage.setItem(LAST_SEQ_STORAGE_KEY, JSON.stringify(lastSeqByConv))
  } catch {
    // sessionStorage full or unavailable — best-effort only.
  }
}
const recordSeq = (convId: string, seq: number): void => {
  const prev = lastSeqByConv[convId] ?? 0
  if (seq > prev) {
    lastSeqByConv[convId] = seq
    persistLastSeq()
  }
}
// Drop the cursor when a turn ends — the server will have evicted its ring
// buffer for that channel, so the next subscribe should start fresh.
const clearSeq = (convId: string): void => {
  if (lastSeqByConv[convId] !== undefined) {
    delete lastSeqByConv[convId]
    persistLastSeq()
  }
}

// rAF-batched delta buffers: separate per-channel (text/thinking) so the
// UI can show them in distinct surfaces. Flushed once per animation frame.
const pendingDeltas = new Map<string, string>()
const pendingThinking = new Map<string, string>()
let rafScheduled = false
const scheduleDeltaFlush = (convId: string, delta: string): void => {
  pendingDeltas.set(convId, (pendingDeltas.get(convId) ?? "") + delta)
  if (rafScheduled) {
    return
  }
  rafScheduled = true
  requestAnimationFrame(flushDeltas)
}

const scheduleThinkingFlush = (convId: string, delta: string): void => {
  pendingThinking.set(convId, (pendingThinking.get(convId) ?? "") + delta)
  if (rafScheduled) {
    return
  }
  rafScheduled = true
  requestAnimationFrame(flushDeltas)
}

const flushDeltas = (): void => {
  rafScheduled = false
  for (const [convId, delta] of pendingDeltas) {
    const prev = convs.get(convId) ?? { ...EMPTY, id: convId }
    const next: ConvState = {
      ...prev,
      streamingText: prev.streamingText + delta,
    }
    convs.set(convId, next)
    notifyConv(convId)
  }
  pendingDeltas.clear()
  for (const [convId, delta] of pendingThinking) {
    const prev = convs.get(convId) ?? { ...EMPTY, id: convId }
    const next: ConvState = {
      ...prev,
      streamingThinking: prev.streamingThinking + delta,
    }
    convs.set(convId, next)
    notifyConv(convId)
  }
  pendingThinking.clear()
}

const notifyConv = (convId: string): void => {
  const set = convListeners.get(convId)
  if (!set) {
    return
  }
  for (const fn of set) {
    fn()
  }
}

const notifyList = (): void => {
  for (const fn of listListeners) {
    fn()
  }
}

// Immutable update helper — read, transform, write back, notify.
const updateConv = (
  convId: string,
  updater: (prev: ConvState) => ConvState,
): void => {
  const prev = convs.get(convId) ?? { ...EMPTY, id: convId }
  const next = updater(prev)
  convs.set(convId, next)
  notifyConv(convId)
}

// ─── EventSource handlers ───────────────────────────────────────────────────
type StreamEvt =
  | { kind: "turn_started"; turnId: string; conversationId: string }
  | { kind: "run_started"; runId: string; turnId: string; agentId: string }
  | {
      kind: "run_ended"
      runId: string
      stats: { status: string; error?: string }
    }
  | { kind: "message_appended"; messageId: string; role: "user" | "assistant" }
  | { kind: "block_appended"; messageId: string; block: Block }
  | { kind: "text_delta"; messageId: string; delta: string }
  | { kind: "text_committed"; messageId: string; text: string }
  | { kind: "thinking_delta"; messageId: string; delta: string }
  | { kind: "thinking_committed"; messageId: string; text: string }
  | {
      kind: "run_stats"
      runId: string
      messageId: string
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
  | { kind: "turn_ended"; turnId: string; status: string; error?: string }
  | { kind: "conversation_renamed"; conversationId: string; title: string }
  // Per-turn debug capture. Only arrives when the caller opted into
  // debug mode on POST /messages. We don't narrow `event` further
  // here — the debug-store does the discrimination at render time.
  | { kind: "debug_event"; runId: string; messageId: string; event: unknown }

const onMessageAppended = (convId: string, evt: StreamEvt): void => {
  if (evt.kind !== "message_appended" || evt.role !== "assistant") {
    return
  }
  updateConv(convId, (prev) => {
    // Message may already exist if it was loaded via GET /messages before SSE
    // replay caught up (refresh-during-stream case). In that case we still
    // need to mark it as the streaming target so subsequent replayed deltas
    // are routed to it instead of being dropped.
    if (prev.messages.some((m) => m.id === evt.messageId)) {
      return {
        ...prev,
        streamingMessageId: evt.messageId,
        streamingText: "",
        streamingThinking: "",
      }
    }
    const msg: ServerMessage = {
      id: evt.messageId,
      conversationId: convId,
      turnId: "",
      role: "assistant",
      ordinal: prev.messages.length + 1,
      createdAt: Date.now(),
      blocks: [],
    }
    return {
      ...prev,
      messages: [...prev.messages, msg],
      streamingMessageId: evt.messageId,
      streamingText: "",
      streamingThinking: "",
    }
  })
}

const onBlockAppended = (convId: string, evt: StreamEvt): void => {
  if (evt.kind !== "block_appended") {
    return
  }
  // Append the block to its target message immediately, immutably. Text
  // streaming flows through `text_delta` + `text_committed` events now; this
  // handler is for tool_use / tool_result / error / image / citation blocks.
  updateConv(convId, (p) => {
    const idx = p.messages.findIndex((m) => m.id === evt.messageId)
    if (idx < 0) {
      return p
    }
    const target = p.messages[idx]
    if (!target) {
      return p
    }
    const newMsg = { ...target, blocks: [...target.blocks, evt.block] }
    const newMessages = p.messages.slice()
    newMessages[idx] = newMsg
    return { ...p, messages: newMessages }
  })
}

const onTextDelta = (convId: string, evt: StreamEvt): void => {
  if (evt.kind !== "text_delta") {
    return
  }
  const prev = convs.get(convId)
  if (!prev || evt.messageId !== prev.streamingMessageId) {
    return
  }
  scheduleDeltaFlush(convId, evt.delta)
}

const onTextCommitted = (convId: string, evt: StreamEvt): void => {
  if (evt.kind !== "text_committed") {
    return
  }
  // Drain any pending rAF-buffered deltas so they don't paint over the
  // about-to-be-committed text on the next frame.
  pendingDeltas.delete(convId)
  updateConv(convId, (p) => {
    const idx = p.messages.findIndex((m) => m.id === evt.messageId)
    if (idx < 0) {
      return p
    }
    const target = p.messages[idx]
    if (!target) {
      return p
    }
    const newMsg = {
      ...target,
      blocks: [...target.blocks, { kind: "text" as const, text: evt.text }],
    }
    const newMessages = p.messages.slice()
    newMessages[idx] = newMsg
    // Clear the live buffer — those deltas just became committed.
    return { ...p, messages: newMessages, streamingText: "" }
  })
}

const onThinkingDelta = (convId: string, evt: StreamEvt): void => {
  if (evt.kind !== "thinking_delta") {
    return
  }
  const prev = convs.get(convId)
  if (!prev || evt.messageId !== prev.streamingMessageId) {
    return
  }
  scheduleThinkingFlush(convId, evt.delta)
}

const onThinkingCommitted = (convId: string, evt: StreamEvt): void => {
  if (evt.kind !== "thinking_committed") {
    return
  }
  pendingThinking.delete(convId)
  updateConv(convId, (p) => {
    const idx = p.messages.findIndex((m) => m.id === evt.messageId)
    if (idx < 0) {
      return p
    }
    const target = p.messages[idx]
    if (!target) {
      return p
    }
    const newMsg = {
      ...target,
      blocks: [...target.blocks, { kind: "thinking" as const, text: evt.text }],
    }
    const newMessages = p.messages.slice()
    newMessages[idx] = newMsg
    return { ...p, messages: newMessages, streamingThinking: "" }
  })
}

const onDebugEvent = (convId: string, evt: StreamEvt): void => {
  if (evt.kind !== "debug_event") return
  // Trust the server's `kind` discriminant inside `event`. The
  // debug-store keeps the same shape regardless of verbosity, so
  // narrowing happens at render time inside DebugPanel.
  appendDebugEvent(evt.runId, evt.event as Parameters<typeof appendDebugEvent>[1])
  // Stamp runId on the matching assistant message so MessageBubble's
  // DebugPanel gate (`debugMode && runId`) fires on the live stream
  // — chat-store didn't track runId on messages before, only via the
  // GET /messages refresh which carries `run_id` on the row.
  updateConv(convId, (p) => {
    const idx = p.messages.findIndex((m) => m.id === evt.messageId)
    if (idx < 0) return p
    const existing = p.messages[idx]
    if (!existing || existing.runId === evt.runId) return p
    const next = p.messages.slice()
    next[idx] = { ...existing, runId: evt.runId }
    return { ...p, messages: next }
  })
}

const onConversationRenamed = (convId: string, evt: StreamEvt): void => {
  if (evt.kind !== "conversation_renamed") {
    return
  }
  updateConv(convId, (p) => ({ ...p, title: evt.title }))
  // Also reflect in the sidebar list.
  const idx = convList.findIndex((c) => c.id === convId)
  if (idx >= 0) {
    const existing = convList[idx]
    if (existing) {
      const next = convList.slice()
      next[idx] = { ...existing, title: evt.title }
      convList = next
      notifyList()
    }
  }
}

const onRunStats = (convId: string, evt: StreamEvt): void => {
  if (evt.kind !== "run_stats") {
    return
  }
  updateConv(convId, (p) => ({
    ...p,
    statsByMessageId: {
      ...p.statsByMessageId,
      [evt.messageId]: {
        tokenUsage: evt.tokenUsage,
        cacheHitRatio: evt.cacheHitRatio,
        ...(evt.contextUsage ? { contextUsage: evt.contextUsage } : {}),
        compactionRounds: evt.compactionRounds,
        retryAttempts: evt.retryAttempts,
        durationMs: evt.durationMs,
      },
    },
  }))
}

const onTurnEnded = (convId: string, evt: StreamEvt): void => {
  if (evt.kind !== "turn_ended") {
    return
  }
  // Make sure any pending delta buffer is folded before finalizing.
  if (pendingDeltas.has(convId)) {
    flushDeltas()
  }
  updateConv(convId, (p) => {
    let messages = p.messages
    if (p.streamingMessageId && p.streamingText.length > 0) {
      const idx = messages.findIndex((m) => m.id === p.streamingMessageId)
      const target = idx >= 0 ? messages[idx] : undefined
      if (idx >= 0 && target) {
        const hasFinalText = target.blocks.some((b) => b.kind === "text")
        if (!hasFinalText) {
          const newMsg: ServerMessage = {
            ...target,
            blocks: [...target.blocks, { kind: "text", text: p.streamingText }],
          }
          messages = messages.slice()
          messages[idx] = newMsg
        }
      }
    }
    const out: ConvState = {
      ...p,
      messages,
      streamingText: "",
      streamingThinking: "",
      status: evt.status === "completed" ? "idle" : "error",
    }
    delete out.streamingMessageId
    if (evt.error) {
      out.error = evt.error
    }
    return out
  })
  // NOTE: do NOT closeStream here. The same EventSource serves many turns —
  // closing on every turn_ended (a) wastes a roundtrip per send and (b) when
  // the next send triggers openStream, the server's ring buffer still holds
  // this turn_ended and replays it to the fresh subscriber, which would
  // re-close the just-opened stream. The route-level cleanup hook (when the
  // user navigates away from /c/$chatId) is the right place to closeStream.
}

const closeStream = (convId: string): void => {
  const es = eventSources.get(convId)
  if (es) {
    es.close()
    eventSources.delete(convId)
  }
  // Intentionally NOT deleting streamReady. The pending awaiter (e.g.
  // sendMessage's `await openStream`) holds the pair's promise; if we
  // dropped it, the next openStream would create a NEW promise that
  // never resolves the original awaiter. Strict-mode mount→cleanup→
  // mount synchronously closes the ES we just opened — keeping the
  // pair lets the re-mount's openStream attach a fresh ES that
  // resolves the SAME promise on its "ready". We only drop the pair
  // when the conversation itself is dropped (deleteConv).
}

const openStream = (convId: string): Promise<void> => {
  // If we already have a live ES + a still-pending or resolved ready
  // promise, reuse it. The pair survives closeStream so a fresh ES can
  // resolve the same awaiter — see ReadyPair comment above.
  let pair = streamReady.get(convId)
  if (!pair) {
    let resolveFn: () => void = (): void => {}
    const promise = new Promise<void>((res): void => {
      resolveFn = res
    })
    pair = { promise, resolve: resolveFn }
    streamReady.set(convId, pair)
  }
  if (eventSources.has(convId)) {
    return pair.promise
  }
  const readyPair = pair
  // Resume from the last seq we persisted for this conv, if any. Each conv
  // has its own cursor — multi-conv tabs don't interfere.
  const since = lastSeqByConv[convId] ?? 0
  const url =
    since > 0
      ? `/v2/chat/conversations/${convId}/stream?sinceSeq=${since}`
      : `/v2/chat/conversations/${convId}/stream`
  const es = new EventSource(url)
  eventSources.set(convId, es)

  const onParsed = (raw: string, seq: number): void => {
    let evt: StreamEvt
    try {
      evt = JSON.parse(raw) as StreamEvt
    } catch {
      return
    }
    // Record cursor BEFORE dispatch so even handlers that throw don't leave
    // us re-replaying the same event on next refresh.
    if (seq > 0) {
      recordSeq(convId, seq)
    }
    if (evt.kind === "message_appended") {
      onMessageAppended(convId, evt)
    } else if (evt.kind === "block_appended") {
      onBlockAppended(convId, evt)
    } else if (evt.kind === "text_delta") {
      onTextDelta(convId, evt)
    } else if (evt.kind === "text_committed") {
      onTextCommitted(convId, evt)
    } else if (evt.kind === "thinking_delta") {
      onThinkingDelta(convId, evt)
    } else if (evt.kind === "thinking_committed") {
      onThinkingCommitted(convId, evt)
    } else if (evt.kind === "run_stats") {
      onRunStats(convId, evt)
    } else if (evt.kind === "turn_ended") {
      onTurnEnded(convId, evt)
      // Server evicts its ring buffer on turn_ended — drop our cursor too,
      // so the next refresh-after-completion starts clean (no replay needed,
      // GET /messages carries the durable state).
      clearSeq(convId)
    } else if (evt.kind === "conversation_renamed") {
      onConversationRenamed(convId, evt)
    } else if (evt.kind === "debug_event") {
      onDebugEvent(convId, evt)
    }
  }

  for (const kind of [
    "turn_started",
    "run_started",
    "run_ended",
    "message_appended",
    "block_appended",
    "text_delta",
    "text_committed",
    "thinking_delta",
    "thinking_committed",
    "run_stats",
    "turn_ended",
    "conversation_renamed",
    "debug_event",
  ] as const) {
    es.addEventListener(kind, (ev) => {
      const mev = ev as MessageEvent<string>
      // `lastEventId` is the SSE `id:` field — the server writes the
      // monotonic seq# there; we trust it for cursor updates.
      const seq = Number(mev.lastEventId)
      onParsed(mev.data, Number.isFinite(seq) ? seq : 0)
    })
  }

  es.addEventListener("error", () => {
    // Browser auto-reconnects; v1 doesn't surface terminal failure UI.
  })

  es.addEventListener(
    "ready",
    () => {
      readyPair.resolve()
    },
    { once: true },
  )
  return readyPair.promise
}

// ─── Public actions ─────────────────────────────────────────────────────────
type SendResp = {
  turn: { id: string; conversationId: string }
  userMessage: ServerMessage
  assistantMessage: ServerMessage
}

const ensureConv = (convId: string): ConvState => {
  let conv = convs.get(convId)
  if (!conv) {
    conv = { ...EMPTY, id: convId }
    convs.set(convId, conv)
  }
  return conv
}

export const chatStore = {
  getConv(convId: string): ConvState {
    return ensureConv(convId)
  },

  getList(): Conversation[] {
    return convList
  },

  subscribeConv(convId: string, listener: () => void): () => void {
    let set = convListeners.get(convId)
    if (!set) {
      set = new Set()
      convListeners.set(convId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) {
        convListeners.delete(convId)
      }
    }
  },

  subscribeList(listener: () => void): () => void {
    listListeners.add(listener)
    return () => {
      listListeners.delete(listener)
    }
  },

  async loadList(): Promise<void> {
    const page = await apiFetch<{ items: Conversation[] }>(
      "/v2/chat/conversations?limit=50",
    )
    convList = page.items
    notifyList()
  },

  async loadConv(convId: string): Promise<void> {
    const prev = convs.get(convId)
    if (prev && (prev.status === "loading" || prev.status === "streaming")) {
      // Already populated and possibly mid-stream. Make sure an EventSource
      // is attached — React 19 strict mode double-fires the route's mount
      // effect (mount → cleanup closes the stream → re-mount), and without
      // this reopen we'd land with state intact but no live SSE feed.
      // When status is "streaming" we ALWAYS try to reopen if there's no
      // live ES, regardless of whether the last message is user or
      // assistant — the composer-initiated flow on `/` lands here with
      // a user-tail and still needs the stream re-attached.
      if (!eventSources.has(convId) && prev.status === "streaming") {
        void openStream(convId)
        return
      }
      const last = prev.messages[prev.messages.length - 1]
      if (last?.role === "assistant" && !last.stats) {
        void openStream(convId)
      }
      return
    }
    // Always refresh metadata (title) — cheap and survives reloads.
    void chatStore.loadConvMeta(convId)
    if (prev && prev.messages.length > 0) {
      // Same belt-and-suspenders reopen for the rare path where we have a
      // cached idle conv whose last message later turned out to be in-flight
      // (e.g., navigated away and back during a slow run).
      const last = prev.messages[prev.messages.length - 1]
      if (last?.role === "assistant" && !last.stats) {
        void openStream(convId)
      }
      return
    }
    updateConv(convId, (p) => ({ ...p, status: "loading" }))
    try {
      const page = await apiFetch<{ items: ServerMessage[] }>(
        `/v2/chat/conversations/${convId}/messages?limit=200`,
      )
      // Hydrate statsByMessageId from any messages that carry persisted
      // stats — the live `run_stats` SSE event isn't replayed on reconnect.
      const hydratedStats: Record<string, MessageStats> = {}
      for (const m of page.items) {
        if (m.stats) {
          hydratedStats[m.id] = m.stats
        }
      }
      // Detect an in-flight assistant turn: the last message is assistant and
      // has no persisted stats yet (stats land only at end-of-run). If so, we
      // need to (a) mark it as the streaming target so live deltas paint and
      // (b) open the SSE stream so we receive those deltas + the eventual
      // commits and run_stats. For a completed conversation we skip the
      // EventSource entirely — listMessages is the durable answer.
      const last = page.items[page.items.length - 1]
      const inFlight = last?.role === "assistant" && !last.stats
      updateConv(convId, (p) => {
        const next: ConvState = {
          ...p,
          messages: page.items,
          statsByMessageId: { ...p.statsByMessageId, ...hydratedStats },
          status: inFlight ? "streaming" : "idle",
        }
        if (inFlight && last) {
          next.streamingMessageId = last.id
          // Reset live buffers — deltas that arrive will start fresh; any
          // text that was already committed is already in `blocks`.
          next.streamingText = ""
          next.streamingThinking = ""
        }
        return next
      })
      if (inFlight) {
        void openStream(convId)
      }
    } catch (err) {
      updateConv(convId, (p) => ({
        ...p,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  },

  async loadConvMeta(convId: string): Promise<void> {
    try {
      const meta = await apiFetch<Conversation>(
        `/v2/chat/conversations/${convId}`,
      )
      updateConv(convId, (p) => ({ ...p, title: meta.title }))
      const idx = convList.findIndex((c) => c.id === convId)
      if (idx >= 0) {
        const existing = convList[idx]
        if (existing) {
          const next = convList.slice()
          next[idx] = { ...existing, ...meta }
          convList = next
          notifyList()
        }
      }
    } catch {
      // Title is non-critical; ignore failures.
    }
  },

  async createConv(title: string): Promise<Conversation> {
    const conv = await apiFetch<Conversation>("/v2/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title }),
    })
    convList = [conv, ...convList.filter((c) => c.id !== conv.id)]
    updateConv(conv.id, (p) => ({ ...p, id: conv.id, title: conv.title }))
    notifyList()
    return conv
  },

  sendMessage(
    convId: string,
    text: string,
    options: {
      model?: string
      agentId?: string
      thinkingLevel?: "minimal" | "low" | "medium" | "high"
    } = {},
  ): void {
    updateConv(convId, (p) => ({
      ...p,
      status: "streaming",
      messages: [
        ...p.messages,
        {
          id: `tmp-${crypto.randomUUID().split("-")[0] ?? String(Date.now())}`,
          conversationId: convId,
          turnId: "",
          role: "user",
          ordinal: p.messages.length + 1,
          createdAt: Date.now(),
          blocks: [{ kind: "text", text }],
        },
      ],
    }))

    void (async (): Promise<void> => {
      try {
        // Wait for the SSE subscriber to be registered server-side before
        // firing the POST — otherwise pi-mono's early events (turn_started,
        // message_appended, run_started) fire on the bus with no listener.
        await openStream(convId)
        // Build the body conditionally so we don't send empty `model`/
        // `agentId` keys — the server treats absence as "use defaults".
        const body: {
          text: string
          model?: string
          agentId?: string
          thinkingLevel?: "minimal" | "low" | "medium" | "high"
          debug?: boolean
          debugVerbosity?: "summary" | "detailed"
        } = { text }
        if (options.model) body.model = options.model
        if (options.agentId) body.agentId = options.agentId
        if (options.thinkingLevel) body.thinkingLevel = options.thinkingLevel
        // Attach the debug flags from the user's persisted preference.
        // Reading at send-time (not closure capture) keeps the flag in
        // sync with the toggle if the user flips it between turns.
        const prefs = preferencesStore.get()
        if (prefs.debugMode) {
          body.debug = true
          body.debugVerbosity = prefs.debugVerbosity
        }
        await apiFetch<SendResp>(`/v2/chat/conversations/${convId}/messages`, {
          method: "POST",
          body: JSON.stringify(body),
        })
      } catch (err) {
        updateConv(convId, (p) => ({
          ...p,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        }))
        closeStream(convId)
      }
    })()
  },

  /** Best-effort interrupt of the in-flight assistant run server-side. The
   *  pi-mono runner stops at its next yield point; whatever text/thinking has
   *  already streamed stays committed, and the usual turn_ended/run_stats
   *  events still fire so the UI footer settles correctly. */
  async interrupt(convId: string): Promise<void> {
    try {
      await apiFetch<{ interrupted: boolean }>(
        `/v2/chat/conversations/${convId}/interrupt`,
        { method: "POST", body: "{}" },
      )
    } catch {
      // Swallowing is intentional — interrupt is best-effort. If the run has
      // already finished by the time we POST, the server returns interrupted:
      // false and we get a normal 200. Any other error means the network is
      // sad anyway and the SSE stream will tell the truth.
    }
  },

  abort(convId: string): void {
    closeStream(convId)
    updateConv(convId, (p) => {
      const out: ConvState = {
        ...p,
        status: "idle",
        streamingText: "",
        streamingThinking: "",
      }
      delete out.streamingMessageId
      return out
    })
  },

  /** Called from the chat-thread route on unmount so we tear down the SSE
   *  connection when the user navigates away. Resume on return is handled by
   *  the cursor persisted in sessionStorage. */
  closeStream(convId: string): void {
    closeStream(convId)
  },

  /** Submit feedback for an assistant message. Server upserts on (user,
   *  message); flipping like→dislike replaces the row. On success we cache
   *  the rating so the icon paints filled. Throws on failure — caller
   *  surfaces the error in the modal. */
  async submitFeedback(
    convId: string,
    messageId: string,
    payload: {
      rating: FeedbackRating
      tags: string[]
      comment?: string
      shareChat: boolean
    },
  ): Promise<void> {
    await apiSubmitFeedback(convId, messageId, payload)
    updateConv(convId, (p) => ({
      ...p,
      feedbackByMessageId: {
        ...p.feedbackByMessageId,
        [messageId]: payload.rating,
      },
    }))
  },

  async renameConv(convId: string, title: string): Promise<void> {
    const trimmed = title.trim()
    if (!trimmed) {
      throw new Error("title required")
    }
    await apiFetch<{ ok: true }>(`/v2/chat/conversations/${convId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: trimmed }),
    })
    updateConv(convId, (p) => ({ ...p, title: trimmed }))
    const idx = convList.findIndex((c) => c.id === convId)
    if (idx >= 0) {
      const existing = convList[idx]
      if (existing) {
        const next = convList.slice()
        next[idx] = { ...existing, title: trimmed, updatedAt: Date.now() }
        convList = next
        notifyList()
      }
    }
  },

  async deleteConv(convId: string): Promise<void> {
    closeStream(convId)
    streamReady.delete(convId)
    await apiFetch<{ ok: true }>(`/v2/chat/conversations/${convId}`, {
      method: "DELETE",
    })
    convList = convList.filter((c) => c.id !== convId)
    convs.delete(convId)
    notifyList()
    notifyConv(convId)
  },
}

// ─── React hooks ────────────────────────────────────────────────────────────
export function useConversation(convId: string): ConvState {
  return useSyncExternalStore(
    (listener) => chatStore.subscribeConv(convId, listener),
    () => chatStore.getConv(convId),
    () => chatStore.getConv(convId),
  )
}

export function useConversationList(): Conversation[] {
  return useSyncExternalStore(
    (listener) => chatStore.subscribeList(listener),
    () => chatStore.getList(),
    () => chatStore.getList(),
  )
}
