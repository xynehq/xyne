// Singleton chat store — lives outside the React tree so streams survive
// route changes. Components subscribe per-conv via useSyncExternalStore so
// only the conversation that actually changed re-renders.
//
// Hot path (text deltas) is rAF-batched: deltas accumulate into a side buffer
// immediately, then once per animation frame we fold the buffer into the
// conv state with an immutable update and notify subscribers.

import { useSyncExternalStore } from "react"
import { apiFetch } from "./api"

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
  | { kind: "citation"; index: number; docId: string; url?: string; title?: string }
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

export type ConvState = {
  id: string
  title?: string
  messages: ServerMessage[]
  streamingMessageId?: string
  streamingText: string
  streamingThinking: string
  status: ConvStatus
  error?: string
}

const EMPTY: ConvState = {
  id: "",
  messages: [],
  streamingText: "",
  streamingThinking: "",
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
const streamReady = new Map<string, Promise<void>>()

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
  | { kind: "run_ended"; runId: string; stats: { status: string; error?: string } }
  | { kind: "message_appended"; messageId: string; role: "user" | "assistant" }
  | { kind: "block_appended"; messageId: string; block: Block }
  | { kind: "text_delta"; messageId: string; delta: string }
  | { kind: "text_committed"; messageId: string; text: string }
  | { kind: "thinking_delta"; messageId: string; delta: string }
  | { kind: "thinking_committed"; messageId: string; text: string }
  | { kind: "turn_ended"; turnId: string; status: string; error?: string }
  | { kind: "conversation_renamed"; conversationId: string; title: string }

const onMessageAppended = (convId: string, evt: StreamEvt): void => {
  if (evt.kind !== "message_appended" || evt.role !== "assistant") {
    return
  }
  updateConv(convId, (prev) => {
    if (prev.messages.some((m) => m.id === evt.messageId)) {
      return prev
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
      blocks: [
        ...target.blocks,
        { kind: "thinking" as const, text: evt.text },
      ],
    }
    const newMessages = p.messages.slice()
    newMessages[idx] = newMsg
    return { ...p, messages: newMessages, streamingThinking: "" }
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
  closeStream(convId)
}

const closeStream = (convId: string): void => {
  const es = eventSources.get(convId)
  if (es) {
    es.close()
    eventSources.delete(convId)
  }
  streamReady.delete(convId)
}

const openStream = (convId: string): Promise<void> => {
  const cached = streamReady.get(convId)
  if (cached) {
    return cached
  }
  const es = new EventSource(`/v2/chat/conversations/${convId}/stream`)
  eventSources.set(convId, es)

  const onParsed = (raw: string): void => {
    let evt: StreamEvt
    try {
      evt = JSON.parse(raw) as StreamEvt
    } catch {
      return
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
    } else if (evt.kind === "turn_ended") {
      onTurnEnded(convId, evt)
    } else if (evt.kind === "conversation_renamed") {
      onConversationRenamed(convId, evt)
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
    "turn_ended",
    "conversation_renamed",
  ] as const) {
    es.addEventListener(kind, (ev) => {
      onParsed((ev as MessageEvent<string>).data)
    })
  }

  es.addEventListener("error", () => {
    // Browser auto-reconnects; v1 doesn't surface terminal failure UI.
  })

  const ready = new Promise<void>((resolve) => {
    es.addEventListener(
      "ready",
      () => {
        resolve()
      },
      { once: true },
    )
  })
  streamReady.set(convId, ready)
  return ready
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
      return
    }
    // Always refresh metadata (title) — cheap and survives reloads.
    void chatStore.loadConvMeta(convId)
    if (prev && prev.messages.length > 0) {
      return
    }
    updateConv(convId, (p) => ({ ...p, status: "loading" }))
    try {
      const page = await apiFetch<{ items: ServerMessage[] }>(
        `/v2/chat/conversations/${convId}/messages?limit=200`,
      )
      updateConv(convId, (p) => ({
        ...p,
        messages: page.items,
        status: "idle",
      }))
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
    options: { model?: string } = {},
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
        await apiFetch<SendResp>(
          `/v2/chat/conversations/${convId}/messages`,
          {
            method: "POST",
            body: JSON.stringify(
              options.model ? { text, model: options.model } : { text },
            ),
          },
        )
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
