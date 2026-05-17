// ChatService — business logic on top of the storage strategies.
// Auth checks live here, NOT in the repos.

import type { AgentDeps } from "../wiring"
import { type AgentScope, loadAgentScope } from "../agent-scope"
import { runPiMonoTurn } from "../pi-mono/runner"
import { generateTitle } from "../title/generate"
import { baseLogger } from "../log"

const Logger = baseLogger("backendv2/chat")
import {
  type AppendTurnResult,
  type Block,
  type Conversation,
  type ConversationId,
  type Cursor,
  type Message,
  type MessageWithBlocks,
  type Page,
  type RunId,
  type ToolCallId,
  type Turn,
  type UserId,
  type WorkspaceId,
  asAgentId,
  asToolCallId,
  asUserId,
  asWorkspaceId,
} from "../storage/types"

export type Viewer = {
  userId: UserId
  workspaceId: WorkspaceId
}

export const viewerFromPayload = (p: {
  sub: string
  workspaceId: string
}): Viewer => ({
  userId: asUserId(p.sub),
  workspaceId: asWorkspaceId(p.workspaceId),
})

export class ConversationNotFoundError extends Error {
  public override readonly name = "ConversationNotFoundError"
  public constructor(public readonly id: ConversationId) {
    super(`Conversation ${String(id)} not found`)
  }
}

export class ForbiddenError extends Error {
  public override readonly name = "ForbiddenError"
}

/** Raised when the caller tries to send a new message on a conversation that
 *  already has an in-flight assistant run. The UI blocks this via the pending
 *  Composer state, but the server enforces it independently so a misbehaving
 *  client (or two tabs) can't fan out parallel runs and orphan the first. */
export class ConcurrentRunError extends Error {
  public override readonly name = "ConcurrentRunError"
  public constructor(public readonly conversationId: ConversationId) {
    super(`Conversation ${String(conversationId)} already has an in-flight run`)
  }
}

/** Raised when the caller passes an `agentId` they can't access — either the
 *  agent doesn't exist, is soft-deleted, or is private to another user.
 *  Surfaces as HTTP 403 from the route. */
export class AgentNotAccessibleError extends Error {
  public override readonly name = "AgentNotAccessibleError"
  public constructor(public readonly agentExternalId: string) {
    super(`Agent ${agentExternalId} is not accessible to this viewer`)
  }
}

export class ChatService {
  // Tracks the in-flight pi-mono run per conversation so an explicit
  // `interrupt` call can abort it. We deliberately key by conversation rather
  // than runId because the UI's "stop" is naturally a conversation-scoped
  // gesture (and at-most-one run is active per conversation today).
  private readonly inflight = new Map<string, AbortController>()

  public constructor(private readonly deps: AgentDeps) {}

  /** Best-effort cancel of the conversation's in-flight assistant run.
   *  Returns true if a run was found and aborted, false if there was nothing
   *  to interrupt (idle, or already finished). */
  public async interrupt(
    viewer: Viewer,
    conversationId: ConversationId,
  ): Promise<{ interrupted: boolean }> {
    await this.getConversation(viewer, conversationId) // permission check
    const key = String(conversationId)
    const ctrl = this.inflight.get(key)
    if (!ctrl) {
      return { interrupted: false }
    }
    ctrl.abort()
    // Don't delete from the map here — sendMessage's finally handler removes
    // its own entry (so a late interrupt for an already-cleaned-up run is a
    // harmless no-op rather than a race).
    return { interrupted: true }
  }

  // ─── Conversations ─────────────────────────────────────────────────────
  public async createConversation(
    viewer: Viewer,
    title: string,
    idemKey?: string,
  ): Promise<Conversation> {
    return this.deps.convs.create(
      {
        ownerId: viewer.userId,
        workspaceId: viewer.workspaceId,
        title: title.trim().length > 0 ? title.trim() : "New chat",
      },
      idemKey ?? newIdemKey(),
    )
  }

  public async listConversations(
    viewer: Viewer,
    page: Cursor,
  ): Promise<Page<Conversation>> {
    return this.deps.convs.listByOwner(viewer.userId, page)
  }

  public async getConversation(
    viewer: Viewer,
    id: ConversationId,
  ): Promise<Conversation> {
    const conv = await this.deps.convs.get(id)
    if (!conv) {
      throw new ConversationNotFoundError(id)
    }
    if (conv.ownerId !== viewer.userId) {
      throw new ForbiddenError("Not your conversation")
    }
    return conv
  }

  public async renameConversation(
    viewer: Viewer,
    id: ConversationId,
    title: string,
  ): Promise<void> {
    await this.getConversation(viewer, id) // permission check
    await this.deps.convs.patch(id, { title })
  }

  public async archiveConversation(
    viewer: Viewer,
    id: ConversationId,
  ): Promise<void> {
    await this.getConversation(viewer, id)
    await this.deps.convs.softDelete(id)
  }

  // ─── Messages ──────────────────────────────────────────────────────────
  // For now: a stubbed echo assistant so we can prove the round-trip.
  // pi-mono will plug in here as a follow-up.
  public async sendMessage(
    viewer: Viewer,
    input: {
      conversationId: ConversationId
      text: string
      model?: string
      idemKey?: string
      /** Optional abort signal. The HTTP route deliberately does NOT pass
       *  c.req.raw.signal here — we want the run to outlive client disconnects
       *  so refresh/tab-close lets the user resume via SSE. Pass a signal only
       *  for an explicit cancel pathway (not wired yet). */
      signal?: AbortSignal
      /** External ID of a custom agent the viewer wants to query through.
       *  When set, the agent's allowlist (apps, docIds, KB collections, etc.)
       *  drives doc visibility — that's how a user reads documents shared
       *  through a public agent without owning them. Permission is checked
       *  against v1's `userAgentPermissions` + `isPublic` model. */
      agentId?: string
    },
  ): Promise<AppendTurnResult & { assistantMessage: Message }> {
    const conv = await this.getConversation(viewer, input.conversationId)
    const text = input.text.trim()
    if (!text) {
      throw new Error("Message text required")
    }

    // Resolve the agent scope up-front. Doing it BEFORE the inflight check
    // means an unauthorized request fails fast (no slot taken, no DB writes)
    // — the user just sees a 403 and can retry with a valid agentId.
    let agentScope: AgentScope | undefined
    if (input.agentId) {
      const scope = await loadAgentScope(viewer, input.agentId)
      if (!scope) {
        throw new AgentNotAccessibleError(input.agentId)
      }
      agentScope = scope
    }

    // Reject a second concurrent send for the same conversation. The UI's
    // pending Composer state already blocks this clientside; we enforce it
    // independently so two tabs / a buggy client / a retried POST can't fan
    // out parallel runs against the same conversation (which would orphan the
    // first run's AbortController and double-bill the user).
    const inflightKey = String(conv.id)
    if (this.inflight.has(inflightKey)) {
      throw new ConcurrentRunError(conv.id)
    }

    // Register this turn's AbortController so `interrupt()` can find it.
    // Chained off any externally-supplied signal so both sources can cancel.
    const ctrl = new AbortController()
    if (input.signal) {
      if (input.signal.aborted) {
        ctrl.abort()
      } else {
        input.signal.addEventListener("abort", () => ctrl.abort(), {
          once: true,
        })
      }
    }
    this.inflight.set(inflightKey, ctrl)

    // Synchronous phase: create turn + user message + run + empty assistant
    // placeholder, publish initial SSE events, then return to the HTTP caller.
    // The long-running pi-mono iteration is launched as a detached promise
    // (`void this.streamRun(...)`) so POST /messages returns in milliseconds
    // instead of holding open for the entire turn. The client's SSE
    // subscription is the real read channel for the streaming content.
    let setup: AppendTurnResult & {
      assistantMessage: Message
      runId: RunId
      runLog: import("../log").Log
    }
    try {
      setup = await this.deps.uow.run(async (tx) => {
        const turnIdem = input.idemKey ?? newIdemKey()
        const runIdem = `${turnIdem}:run`
        const asstIdem = `${turnIdem}:asst`

        const baseLog = Logger.child({
          conversationId: String(conv.id),
          userId: String(viewer.userId),
          workspaceId: String(viewer.workspaceId),
          modelLabel: input.model,
        })
        baseLog.info(
          { messageChars: text.length, idemKey: turnIdem },
          "chat: sendMessage start",
        )

        const userBlock: Block = { kind: "text", text }
        const turnResult = await this.deps.msgs.appendTurn(
          {
            conversationId: conv.id,
            userMessage: { blocks: [userBlock] },
          },
          turnIdem,
          tx,
        )
        const turnLog = baseLog.child({
          turnId: String(turnResult.turn.id),
          userMessageId: String(turnResult.userMessage.id),
        })
        turnLog.info(
          { ordinal: turnResult.userMessage.ordinal },
          "chat: turn appended",
        )

        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "turn_started",
          turnId: turnResult.turn.id,
          conversationId: conv.id,
        })
        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "message_appended",
          messageId: turnResult.userMessage.id,
          role: "user",
        })

        // First user message → generate an AI title in the background.
        if (turnResult.userMessage.ordinal === 1) {
          void this.renameFromFirstMessage(conv.id, text, turnLog)
        }

        const run = await this.deps.msgs.startRun(
          turnResult.turn.id,
          {
            agentId: asAgentId("main"),
            model: input.model ?? "default",
          },
          runIdem,
          tx,
        )
        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "run_started",
          runId: run.id,
          turnId: turnResult.turn.id,
          agentId: run.agentId,
        })

        // Open an empty assistant message; blocks get appended live as pi-mono
        // streams. listMessages always returns the latest snapshot.
        const assistantMessage = await this.deps.msgs.appendAssistantMessage(
          run.id,
          { blocks: [] },
          asstIdem,
          tx,
        )
        const runLog = turnLog.child({
          runId: String(run.id),
          agentId: String(run.agentId),
          assistantMessageId: String(assistantMessage.id),
        })
        runLog.info("chat: run started")
        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "message_appended",
          messageId: assistantMessage.id,
          role: "assistant",
        })

        return { ...turnResult, assistantMessage, runId: run.id, runLog }
      })
    } catch (err) {
      // Setup failed (DB, idempotency conflict, etc.) — release the slot so a
      // legitimate retry can re-attempt instead of bouncing off the 409 we
      // added above.
      if (this.inflight.get(inflightKey) === ctrl) {
        this.inflight.delete(inflightKey)
      }
      throw err
    }

    // Background phase: the pi-mono iteration. Detached on purpose so the POST
    // returns now. Everything the client needs lives on the SSE stream.
    void this.streamRun({
      conv,
      ctrl,
      inflightKey,
      input,
      viewerUserId: viewer.userId,
      runId: setup.runId,
      assistantMessage: setup.assistantMessage,
      turn: setup.turn,
      runLog: setup.runLog,
      ...(agentScope ? { agentScope } : {}),
    })

    return {
      turn: setup.turn,
      userMessage: setup.userMessage,
      assistantMessage: setup.assistantMessage,
    }
  }

  /** Background pi-mono iteration. Runs after sendMessage's synchronous setup
   *  resolves, publishing deltas/blocks/commits and end-of-turn events to the
   *  StreamBus. The HTTP caller has already gone; clients read this entirely
   *  through SSE (live + ring-buffer resume). Never rejects — any error is
   *  captured into a turn_ended event with status "errored". */
  private async streamRun(args: {
    conv: Conversation
    ctrl: AbortController
    inflightKey: string
    input: { text: string; model?: string }
    viewerUserId: UserId
    runId: RunId
    assistantMessage: Message
    turn: Turn
    runLog: import("../log").Log
    agentScope?: AgentScope
  }): Promise<void> {
    const {
      conv,
      ctrl,
      inflightKey,
      input,
      viewerUserId,
      runId,
      assistantMessage,
      turn,
      runLog,
      agentScope,
    } = args
    const text = input.text.trim()
    try {
      const pendingToolCalls = new Map<string, ToolCallId>()
      // Diagnostic counters so log shows whether *any* deltas flowed. Logged
      // once per first delta and once at the end so the run log isn't spammed.
      let textDeltaCount = 0
      let thinkingDeltaCount = 0
      // Accumulates text deltas between tool boundaries. Flushed as a single
      // committed text block whenever pi-mono switches to a tool call or
      // finishes — this preserves document order on the wire and in MessageRepo.
      let pendingText = ""
      const flushPendingText = async (): Promise<void> => {
        const trimmed = pendingText.replace(/^\s+/, "")
        if (!trimmed) {
          pendingText = ""
          return
        }
        const block: Block = { kind: "text", text: trimmed }
        await this.deps.msgs.appendBlock(assistantMessage.id, block)
        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "text_committed",
          messageId: assistantMessage.id,
          text: trimmed,
        })
        pendingText = ""
      }

      // Same buffer/flush for reasoning. Pi-mono emits thinking_start →
      // thinking_delta* → thinking_end; we flush on thinking_end (and as a
      // safety on tool boundaries / final flush).
      let pendingThinking = ""
      const flushPendingThinking = async (): Promise<void> => {
        const trimmed = pendingThinking.trim()
        if (!trimmed) {
          pendingThinking = ""
          return
        }
        const block: Block = { kind: "thinking", text: trimmed }
        await this.deps.msgs.appendBlock(assistantMessage.id, block)
        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "thinking_committed",
          messageId: assistantMessage.id,
          text: trimmed,
        })
        pendingThinking = ""
      }

      const piResult = await runPiMonoTurn({
        conversationId: String(conv.id),
        userEmail: String(viewerUserId),
        message: text,
        logger: runLog,
        ...(input.model ? { modelLabel: input.model } : {}),
        ...(agentScope ? { agentScope } : {}),
        signal: ctrl.signal,
        onTextDelta: async (delta) => {
          if (textDeltaCount === 0) {
            runLog.info(
              { firstDeltaChars: delta.length },
              "pi-mono: first text_delta",
            )
          }
          textDeltaCount++
          pendingText += delta
          await this.deps.stream.publish(channelFor(conv.id), {
            kind: "text_delta",
            messageId: assistantMessage.id,
            delta,
          })
        },
        onThinkingDelta: async (delta) => {
          if (thinkingDeltaCount === 0) {
            runLog.info(
              { firstDeltaChars: delta.length },
              "pi-mono: first thinking_delta",
            )
          }
          thinkingDeltaCount++
          pendingThinking += delta
          await this.deps.stream.publish(channelFor(conv.id), {
            kind: "thinking_delta",
            messageId: assistantMessage.id,
            delta,
          })
        },
        onThinkingEnd: async () => {
          await flushPendingThinking()
        },
        onToolCall: async (call) => {
          runLog.info(
            { toolName: call.toolName, toolCallId: call.toolCallId },
            "pi-mono: tool_call event",
          )
          // Flush any text/thinking accumulated before this tool call so the
          // tool chip renders AFTER its preceding content.
          await flushPendingThinking()
          await flushPendingText()
          const id = asToolCallId(call.toolCallId)
          pendingToolCalls.set(call.toolCallId, id)
          const block: Block = {
            kind: "tool_use",
            toolCallId: id,
            toolName: call.toolName,
            args: call.args,
          }
          await this.deps.msgs.appendBlock(assistantMessage.id, block)
          await this.deps.stream.publish(channelFor(conv.id), {
            kind: "block_appended",
            messageId: assistantMessage.id,
            block,
          })
        },
        onToolResult: async (result) => {
          const id =
            pendingToolCalls.get(result.toolCallId) ??
            asToolCallId(result.toolCallId)
          const block: Block = {
            kind: "tool_result",
            toolCallId: id,
            output: result.result,
            isError: result.isError,
          }
          await this.deps.msgs.appendBlock(assistantMessage.id, block)
          await this.deps.stream.publish(channelFor(conv.id), {
            kind: "block_appended",
            messageId: assistantMessage.id,
            block,
          })
        },
      })

      runLog.info(
        {
          textDeltaCount,
          thinkingDeltaCount,
          toolCalls: pendingToolCalls.size,
        },
        "pi-mono: stream summary",
      )

      // Final flush — any text/thinking after the last tool call (or the
      // whole answer if there were no tool calls).
      await flushPendingThinking()
      await flushPendingText()

      // Stats event — attaches token usage, cache hit ratio, context usage,
      // and compaction/retry counts to the assistant message so the UI can
      // render a one-line telemetry footer under the response. We BOTH
      // persist the stats on the Message record (so a page refresh hydrates
      // them via listMessages) AND publish the SSE event (so the live view
      // sees them appear the moment the run ends).
      const persistedStats = {
        tokenUsage: piResult.stats.tokenUsage,
        cacheHitRatio: piResult.stats.cacheHitRatio,
        ...(piResult.stats.contextUsage
          ? { contextUsage: piResult.stats.contextUsage }
          : {}),
        compactionRounds: piResult.stats.compactionRounds,
        retryAttempts: piResult.stats.retryAttempts,
        durationMs: piResult.stats.durationMs,
      }
      await this.deps.msgs.setStats(assistantMessage.id, persistedStats)
      await this.deps.stream.publish(channelFor(conv.id), {
        kind: "run_stats",
        runId,
        messageId: assistantMessage.id,
        ...persistedStats,
      })

      if (piResult.error) {
        const errBlock: Block = {
          kind: "error",
          code: "pi_mono_error",
          message: piResult.error,
        }
        await this.deps.msgs.appendBlock(assistantMessage.id, errBlock)
        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "block_appended",
          messageId: assistantMessage.id,
          block: errBlock,
        })
      }

      const runStatus = piResult.error ? "errored" : "completed"
      await this.deps.msgs.endRun(
        runId,
        piResult.error
          ? { status: runStatus, error: piResult.error }
          : { status: runStatus },
      )
      await this.deps.stream.publish(channelFor(conv.id), {
        kind: "run_ended",
        runId,
        stats: piResult.error
          ? { status: runStatus, error: piResult.error }
          : { status: runStatus },
      })
      await this.deps.msgs.endTurn(turn.id, runStatus, piResult.error)
      await this.deps.stream.publish(channelFor(conv.id), {
        kind: "turn_ended",
        turnId: turn.id,
        status: runStatus,
        ...(piResult.error ? { error: piResult.error } : {}),
      })

      runLog.info(
        {
          status: runStatus,
          stopReason: piResult.stopReason,
          assistantTextChars: piResult.text.length,
          error: piResult.error,
        },
        "chat: turn finished",
      )
    } catch (err) {
      // streamRun is detached (fire-and-forget). Any error here would
      // otherwise become an unhandled rejection that kills the process under
      // strict Node/Bun policies. Surface it through the same end-of-turn SSE
      // event the happy path uses so the UI can show an error bubble.
      const message = err instanceof Error ? err.message : String(err)
      runLog.error({ err }, "streamRun: unhandled error")
      try {
        await this.deps.msgs.endRun(runId, {
          status: "errored",
          error: message,
        })
        await this.deps.msgs.endTurn(turn.id, "errored", message)
        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "turn_ended",
          turnId: turn.id,
          status: "errored",
          error: message,
        })
      } catch (cleanupErr) {
        runLog.error({ err: cleanupErr }, "streamRun: cleanup also failed")
      }
    } finally {
      // Release the inflight slot so the next sendMessage on this conv can
      // proceed. Guard against clobbering a slot that's already been replaced
      // by a fresh run (won't happen today thanks to the 409, but cheap to be
      // correct).
      if (this.inflight.get(inflightKey) === ctrl) {
        this.inflight.delete(inflightKey)
      }
    }
  }

  public async listMessages(
    viewer: Viewer,
    conversationId: ConversationId,
    page: Cursor,
  ): Promise<Page<MessageWithBlocks>> {
    await this.getConversation(viewer, conversationId)
    return this.deps.msgs.listMessages(conversationId, page)
  }

  public async subscribe(
    viewer: Viewer,
    conversationId: ConversationId,
    onEvent: (e: import("../storage/types").StreamEvent, seq: number) => void,
    opts?: { sinceSeq?: number },
  ): Promise<() => void> {
    await this.getConversation(viewer, conversationId) // permission check
    return this.deps.stream.subscribe(channelFor(conversationId), onEvent, opts)
  }

  private async renameFromFirstMessage(
    conversationId: ConversationId,
    text: string,
    parentLog: import("../log").Log,
  ): Promise<void> {
    const log = parentLog.child({ task: "rename" })
    const startedAt = Date.now()
    log.info("rename: title generation start")
    try {
      const title = await generateTitle(text, log)
      if (!title) {
        log.info(
          { durationMs: Date.now() - startedAt },
          "rename: empty title — skipping",
        )
        return
      }
      await this.deps.convs.patch(conversationId, { title })
      await this.deps.stream.publish(channelFor(conversationId), {
        kind: "conversation_renamed",
        conversationId,
        title,
      })
      log.info(
        { title, durationMs: Date.now() - startedAt },
        "rename: applied + broadcast",
      )
    } catch (err) {
      log.warn(
        { err, durationMs: Date.now() - startedAt },
        "rename failed; keeping placeholder",
      )
    }
  }
}

export const channelFor = (conversationId: ConversationId): string =>
  `conv:${String(conversationId)}`

const newIdemKey = (): string =>
  crypto.randomUUID().split("-").slice(0, 2).join("") ||
  Math.random().toString(36).slice(2)
