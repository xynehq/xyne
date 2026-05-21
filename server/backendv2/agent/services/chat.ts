// ChatService — business logic on top of the storage strategies.
// Auth checks live here, NOT in the repos.

import type { AgentDeps } from "../wiring"
import {
  type AgentScope,
  type DispatchableSubAgent,
  loadAgentScope,
  loadWorkspaceDefaultPromptInputs,
} from "../agent-scope"
import { runPiMonoTurn } from "../pi-mono/runner"
import { resolveAgentSystemPrompt } from "../pi-mono/system-prompt"
import type { NestedRunPersistence } from "../pi-mono/tools/dispatch-subagent"
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
  type MessageFeedback,
  type MessageFeedbackRating,
  type MessageId,
  type MessageWithBlocks,
  type Page,
  type RunId,
  type ToolCallId,
  type Turn,
  type UserId,
  type WorkspaceId,
  asAgentId,
  asRunId,
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

export class MessageNotFoundError extends Error {
  public override readonly name = "MessageNotFoundError"
  public constructor(id: MessageId) {
    super(`Message ${String(id)} not found`)
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
      /** Reasoning effort for this turn. Maps to pi-ai's ThinkingLevel.
       *  Absent = server default (medium). */
      thinkingLevel?: "minimal" | "low" | "medium" | "high"
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
      viewerWorkspaceId: viewer.workspaceId,
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
    input: {
      text: string
      model?: string
      thinkingLevel?: "minimal" | "low" | "medium" | "high"
    }
    viewerUserId: UserId
    viewerWorkspaceId: WorkspaceId
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
      viewerWorkspaceId,
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

      // Compose the system prompt for this turn. Resolution order:
      //   1. Custom agent selected (agentScope is set) → use its
      //      section overrides + sub-agents.
      //   2. No agent selected → fall back to the workspace default
      //      agent's row (M4b). The default row's appIntegrations are
      //      NOT applied to vespa search (we deliberately skip
      //      AgentScope construction for this path so search stays
      //      KB-only); only its prompt + tools + sub-agents are used.
      //   3. No default row exists yet → omit `systemPrompt` so the
      //      runner uses its baked DEFAULT_SYSTEM_PROMPT. Matches
      //      pre-M4b behaviour.
      let assembledPrompt: string | undefined
      let resolvedToolNames: string[] = []
      let resolvedSubAgents: DispatchableSubAgent[] = []
      let resolvedAgentId: string = "default-agent"
      if (agentScope) {
        assembledPrompt = resolveAgentSystemPrompt({
          systemPromptMain: agentScope.systemPromptMain,
          systemPromptTools: agentScope.systemPromptTools,
          systemPromptSubagents: agentScope.systemPromptSubagents,
          subAgents: agentScope.subAgents,
        })
        resolvedToolNames = agentScope.tools
        resolvedSubAgents = agentScope.subAgents
        resolvedAgentId = agentScope.externalId
      } else {
        const defaults = await loadWorkspaceDefaultPromptInputs({
          userId: viewerUserId,
          workspaceId: viewerWorkspaceId,
        })
        if (defaults) {
          assembledPrompt = resolveAgentSystemPrompt(defaults)
          resolvedToolNames = defaults.tools
          resolvedSubAgents = defaults.subAgents
          // Workspace-default agentId is opaque to the runner here; the
          // dispatch persistence call below sets agent_id on the nested
          // run to the parent's run.agentId (the default agent's id is
          // already on the parent run row from setup).
        }
      }

      // M7 — wire the dispatch tool's persistence callbacks. Only the
      // start/finish lifecycle: insert a nested v2_chat_runs row when
      // dispatch begins, then close it + persist the sub-agent's
      // tool_call / message trace when it ends. The dispatch tool
      // itself owns the in-memory iteration; chat.ts only sees the
      // boundaries.
      const dispatchPersistence: NestedRunPersistence = {
        start: async ({ subAgentExternalId, model }) => {
          const nested = await this.deps.msgs.startRun(
            turn.id,
            {
              parentRunId: runId,
              agentId: asAgentId(resolvedAgentId),
              subAgentId: subAgentExternalId,
              model,
            },
            `${runId}:sub:${subAgentExternalId}:${Date.now()}`,
          )
          return String(nested.id)
        },
        finish: async (nestedRunIdStr, batch) => {
          const nestedRunIdTyped = asRunId(nestedRunIdStr)
          // 1) Open an assistant message under the nested run.
          const nestedMsg = await this.deps.msgs.appendAssistantMessage(
            nestedRunIdTyped,
            { blocks: [] },
            `${nestedRunIdStr}:msg`,
          )
          // 2) Persist the sub-agent's trace as blocks. Order
          //    preserved: thinking → each tool_use + tool_result pair
          //    by startedAt → final text. v2_chat_tool_calls rows
          //    fall out as a side effect of the tool_use / tool_result
          //    block writes (the postgres MessageRepo writes both).
          if (batch.thinkingText.trim().length > 0) {
            await this.deps.msgs.appendBlock(nestedMsg.id, {
              kind: "thinking",
              text: batch.thinkingText.trim(),
            })
          }
          const sortedCalls = [...batch.toolCalls].sort(
            (a, b) => a.startedAt - b.startedAt,
          )
          for (const c of sortedCalls) {
            await this.deps.msgs.appendBlock(nestedMsg.id, {
              kind: "tool_use",
              toolCallId: asToolCallId(c.toolCallId),
              toolName: c.toolName,
              args: c.args,
            })
            await this.deps.msgs.appendBlock(nestedMsg.id, {
              kind: "tool_result",
              toolCallId: asToolCallId(c.toolCallId),
              output: c.result,
              isError: c.isError,
            })
          }
          if (batch.finalText.trim().length > 0) {
            await this.deps.msgs.appendBlock(nestedMsg.id, {
              kind: "text",
              text: batch.finalText.trim(),
            })
          }
          // 3) Close the nested run row with status + tokens.
          await this.deps.msgs.endRun(nestedRunIdTyped, {
            status: batch.status,
            tokensIn: batch.tokens.input + batch.tokens.cacheRead,
            tokensOut: batch.tokens.output,
            ...(batch.error ? { error: batch.error } : {}),
          })
        },
      }

      const piResult = await runPiMonoTurn({
        conversationId: String(conv.id),
        userEmail: String(viewerUserId),
        message: text,
        logger: runLog,
        ...(input.model ? { modelLabel: input.model } : {}),
        ...(agentScope ? { agentScope } : {}),
        ...(assembledPrompt ? { systemPrompt: assembledPrompt } : {}),
        // Pi-mono tool list — sourced literally from the agent row's
        // `tools` column (custom agent path) or the workspace default
        // agent's `tools` (un-scoped path). Always passed verbatim;
        // [] means the LLM has no tools available, full registry was
        // populated server-side at create time.
        toolNames: resolvedToolNames,
        // M7 — let the runner conditionally append dispatchSubagent
        // when the agent has sub-agents AND we passed persistence
        // callbacks. Both are required: the runner won't enable
        // dispatch without somewhere to write the nested trace.
        ...(resolvedSubAgents.length > 0
          ? {
              dispatchableSubAgents: resolvedSubAgents,
              dispatchPersistence,
            }
          : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
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

  /** M8 — fetch the full trace of every sub-agent dispatched under a
   *  parent run. Returns nested runs in `startedAt` order, each with
   *  the sub-agent's assistant messages (and their tool_use /
   *  tool_result blocks the M7 storage already laid down).
   *
   *  The UI walks the parent's `dispatchSubagent` tool_calls in order
   *  and matches the Nth tool_call to the Nth nested run. Permission
   *  is the conversation's getConversation check — anyone who can see
   *  the parent's chat can see the sub-agent's execution. */
  public async listNestedRuns(
    viewer: Viewer,
    conversationId: ConversationId,
    parentRunId: RunId,
  ): Promise<{
    nestedRuns: Array<{
      run: import("../storage/types").Run
      messages: MessageWithBlocks[]
    }>
  }> {
    await this.getConversation(viewer, conversationId)
    const runs = await this.deps.msgs.listChildRuns(
      conversationId,
      parentRunId,
    )
    const nested = await Promise.all(
      runs.map(async (run) => {
        const messages = await this.deps.msgs.listMessagesByRun(run.id)
        return { run, messages }
      }),
    )
    return { nestedRuns: nested }
  }

  // ─── Message feedback ──────────────────────────────────────────────────
  // Three thin wrappers around MessageFeedbackRepo. The service layer enforces
  // (1) the conversation belongs to the viewer and (2) the targeted message
  // actually lives in that conversation — repos do no auth. We also snapshot
  // model + latency + tokens + retrievedSourceIds at write time so a later
  // regenerate / model swap doesn't silently change what the user rated.
  public async setMessageFeedback(
    viewer: Viewer,
    conversationId: ConversationId,
    messageId: MessageId,
    input: {
      rating: MessageFeedbackRating
      tags?: string[]
      comment?: string
      shareChat?: boolean
    },
  ): Promise<MessageFeedback> {
    await this.getConversation(viewer, conversationId)
    const msg = await this.deps.msgs.getMessage(messageId)
    if (!msg || msg.conversationId !== conversationId) {
      // Collapse both "not found" and "wrong conversation" into a single 404
      // so we don't leak the existence of foreign messages.
      throw new MessageNotFoundError(messageId)
    }
    if (msg.role !== "assistant") {
      throw new ForbiddenError("Only assistant messages can be rated")
    }

    // Snapshot model from the run that produced this message. listRunsForTurn
    // is cheap (one row in practice) so no need for a getRun primitive.
    let modelSnapshot: string | undefined
    if (msg.runId) {
      const runs = await this.deps.msgs.listRunsForTurn(msg.turnId)
      const run = runs.find((r) => r.id === msg.runId)
      if (run) modelSnapshot = run.model
    }

    const retrievedSourceIds = collectCitationDocIds(msg.blocks)
    const stats = msg.stats

    return this.deps.feedback.upsert(
      {
        messageId,
        conversationId,
        userId: viewer.userId,
        workspaceId: viewer.workspaceId,
        ...(msg.runId ? { runId: msg.runId } : {}),
      },
      {
        rating: input.rating,
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.comment ? { comment: input.comment } : {}),
        ...(input.shareChat !== undefined ? { shareChat: input.shareChat } : {}),
        ...(modelSnapshot ? { modelSnapshot } : {}),
        ...(stats?.durationMs !== undefined
          ? { latencyMs: stats.durationMs }
          : {}),
        ...(stats?.tokenUsage.input !== undefined
          ? { tokensIn: stats.tokenUsage.input }
          : {}),
        ...(stats?.tokenUsage.output !== undefined
          ? { tokensOut: stats.tokenUsage.output }
          : {}),
        ...(retrievedSourceIds.length > 0 ? { retrievedSourceIds } : {}),
      },
    )
  }

  public async getMessageFeedback(
    viewer: Viewer,
    conversationId: ConversationId,
    messageId: MessageId,
  ): Promise<MessageFeedback | null> {
    await this.getConversation(viewer, conversationId)
    return this.deps.feedback.get({ messageId, userId: viewer.userId })
  }

  public async deleteMessageFeedback(
    viewer: Viewer,
    conversationId: ConversationId,
    messageId: MessageId,
  ): Promise<boolean> {
    await this.getConversation(viewer, conversationId)
    return this.deps.feedback.delete({ messageId, userId: viewer.userId })
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

// Walk the assistant message's blocks for citation entries and pull out the
// docIds the model actually cited. Empty array when the answer didn't cite
// anything (small talk, no-results, etc.) — feedback snapshots distinguish
// "no retrieval" from "retrieval failed" downstream by this presence.
const collectCitationDocIds = (blocks: Block[]): string[] => {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const b of blocks) {
    if (b.kind === "citation" && !seen.has(b.docId)) {
      seen.add(b.docId)
      ids.push(b.docId)
    }
  }
  return ids
}

const newIdemKey = (): string =>
  crypto.randomUUID().split("-").slice(0, 2).join("") ||
  Math.random().toString(36).slice(2)
