// ChatService — business logic on top of the storage strategies.
// Auth checks live here, NOT in the repos.

import type { AgentDeps } from "../wiring"
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
  type ToolCallId,
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

export class ChatService {
  public constructor(private readonly deps: AgentDeps) {}

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
    },
  ): Promise<AppendTurnResult & { assistantMessage: Message }> {
    const conv = await this.getConversation(viewer, input.conversationId)
    const text = input.text.trim()
    if (!text) {
      throw new Error("Message text required")
    }

    return this.deps.uow.run(async (tx) => {
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
      turnLog.info({ ordinal: turnResult.userMessage.ordinal }, "chat: turn appended")

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
        userEmail: String(viewer.userId),
        message: text,
        logger: runLog,
        ...(input.model ? { modelLabel: input.model } : {}),
        onTextDelta: async (delta) => {
          if (textDeltaCount === 0) {
            runLog.info({ firstDeltaChars: delta.length }, "pi-mono: first text_delta")
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
            runLog.info({ firstDeltaChars: delta.length }, "pi-mono: first thinking_delta")
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
          const id = pendingToolCalls.get(result.toolCallId)
            ?? asToolCallId(result.toolCallId)
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
        { textDeltaCount, thinkingDeltaCount, toolCalls: pendingToolCalls.size },
        "pi-mono: stream summary",
      )

      // Final flush — any text/thinking after the last tool call (or the
      // whole answer if there were no tool calls).
      await flushPendingThinking()
      await flushPendingText()
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
        run.id,
        piResult.error
          ? { status: runStatus, error: piResult.error }
          : { status: runStatus },
        tx,
      )
      await this.deps.stream.publish(channelFor(conv.id), {
        kind: "run_ended",
        runId: run.id,
        stats: piResult.error
          ? { status: runStatus, error: piResult.error }
          : { status: runStatus },
      })
      await this.deps.msgs.endTurn(
        turnResult.turn.id,
        runStatus,
        piResult.error,
        tx,
      )
      await this.deps.stream.publish(channelFor(conv.id), {
        kind: "turn_ended",
        turnId: turnResult.turn.id,
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

      return { ...turnResult, assistantMessage }
    })
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
    onEvent: (e: import("../storage/types").StreamEvent) => void,
  ): Promise<() => void> {
    await this.getConversation(viewer, conversationId) // permission check
    return this.deps.stream.subscribe(channelFor(conversationId), onEvent)
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
