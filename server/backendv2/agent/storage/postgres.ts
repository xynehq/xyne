// Postgres implementations of the four storage strategies.
//
// Direct swap-in for InMemory*: every method honors the same idempotency,
// ordering, and tool-call-projection semantics. Writes that span more than
// one statement run inside a transaction — either an explicit Tx passed by
// the caller (via UnitOfWork.run) or one we open ourselves.

import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm"
import { db } from "@/db/client"
import type { TxnOrClient } from "@/types"
import {
  v2ChatConversations,
  v2ChatMessageFeedback,
  v2ChatMessages,
  v2ChatRuns,
  v2ChatToolCalls,
  v2ChatTurns,
} from "@/db/schema/v2Chat"
import {
  type AppendTurnInput,
  type AppendTurnResult,
  type Block,
  type Conversation,
  type ConversationId,
  type ConversationInit,
  type ConversationPatch,
  type ConversationRepo,
  type Cursor,
  type IdemKey,
  type Message,
  type MessageFeedback,
  type MessageFeedbackInput,
  type MessageFeedbackRating,
  type MessageFeedbackRepo,
  type MessageId,
  type MessageRepo,
  type MessageRole,
  type MessageStats,
  type MessageWithBlocks,
  type NewAssistantMessage,
  type Page,
  type Run,
  type RunId,
  type RunInit,
  type RunStats,
  type RunStatus,
  type ToolCall,
  type ToolCallId,
  type ToolCallStatus,
  type Turn,
  type TurnId,
  type TurnStatus,
  type Tx,
  type UnitOfWork,
  type UserId,
  type WorkspaceId,
  asAgentId,
  asConversationId,
  asMessageFeedbackId,
  asMessageId,
  asRunId,
  asToolCallId,
  asTurnId,
  asUserId,
  asWorkspaceId,
} from "./types"

// ─── Tx plumbing ────────────────────────────────────────────────────────────
// The Tx type from storage/types.ts is an opaque handle. Postgres impls
// smuggle the live TxnOrClient through it; in-memory impls ignore the body.
interface PgTx extends Tx {
  client: TxnOrClient
}

const wrapTx = (client: TxnOrClient): PgTx => ({ _tx: true, client })

const clientOf = (tx: Tx | undefined): TxnOrClient =>
  tx ? (tx as PgTx).client : db

/** Use the caller's transaction if provided; otherwise open our own. Keeps
 *  multi-statement writes atomic even when a caller forgets to wrap in UoW. */
const inTx = async <T>(
  tx: Tx | undefined,
  fn: (client: TxnOrClient) => Promise<T>,
): Promise<T> => {
  if (tx) {
    return fn((tx as PgTx).client)
  }
  return db.transaction(fn)
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`
const now = (): number => Date.now()
const clampLimit = (n: number): number => Math.max(1, Math.min(n, 200))

// ─── Row → domain converters ────────────────────────────────────────────────
type ConvRow = typeof v2ChatConversations.$inferSelect
type TurnRow = typeof v2ChatTurns.$inferSelect
type RunRow = typeof v2ChatRuns.$inferSelect
type MsgRow = typeof v2ChatMessages.$inferSelect
type ToolCallRow = typeof v2ChatToolCalls.$inferSelect
type FeedbackRow = typeof v2ChatMessageFeedback.$inferSelect

const rowToConversation = (row: ConvRow): Conversation => {
  const c: Conversation = {
    id: asConversationId(row.id),
    ownerId: asUserId(row.ownerId),
    workspaceId: asWorkspaceId(row.workspaceId),
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (row.agentId) c.agentId = asAgentId(row.agentId)
  if (row.archivedAt !== null) c.archivedAt = row.archivedAt
  return c
}

const rowToTurn = (row: TurnRow): Turn => {
  const t: Turn = {
    id: asTurnId(row.id),
    conversationId: asConversationId(row.conversationId),
    status: row.status as TurnStatus,
    startedAt: row.startedAt,
  }
  if (row.endedAt !== null) t.endedAt = row.endedAt
  if (row.error) t.error = row.error
  return t
}

const rowToRun = (row: RunRow): Run => {
  const r: Run = {
    id: asRunId(row.id),
    conversationId: asConversationId(row.conversationId),
    turnId: asTurnId(row.turnId),
    agentId: asAgentId(row.agentId),
    model: row.model,
    status: row.status as RunStatus,
    startedAt: row.startedAt,
  }
  if (row.parentRunId) r.parentRunId = asRunId(row.parentRunId)
  if (row.subAgentId) r.subAgentId = row.subAgentId
  if (row.endedAt !== null) r.endedAt = row.endedAt
  if (row.tokensIn !== null) r.tokensIn = row.tokensIn
  if (row.tokensOut !== null) r.tokensOut = row.tokensOut
  if (row.costUsd !== null) r.costUsd = Number(row.costUsd)
  if (row.error) r.error = row.error
  return r
}

const rowToMessage = (row: MsgRow): Message => {
  const m: Message = {
    id: asMessageId(row.id),
    conversationId: asConversationId(row.conversationId),
    turnId: asTurnId(row.turnId),
    role: row.role as MessageRole,
    ordinal: row.ordinal,
    createdAt: row.createdAt,
  }
  if (row.runId) m.runId = asRunId(row.runId)
  if (row.parentMessageId) m.parentMessageId = asMessageId(row.parentMessageId)
  if (row.stats) m.stats = row.stats as MessageStats
  return m
}

const rowToMessageWithBlocks = (row: MsgRow): MessageWithBlocks => ({
  ...rowToMessage(row),
  blocks: (row.blocks as Block[] | null) ?? [],
})

const rowToFeedback = (row: FeedbackRow): MessageFeedback => {
  const f: MessageFeedback = {
    id: asMessageFeedbackId(row.id),
    messageId: asMessageId(row.messageId),
    conversationId: asConversationId(row.conversationId),
    userId: asUserId(row.userId),
    workspaceId: asWorkspaceId(row.workspaceId),
    rating: row.rating as MessageFeedbackRating,
    tags: (row.tags as string[] | null) ?? [],
    shareChat: row.shareChat,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (row.runId) f.runId = asRunId(row.runId)
  if (row.comment) f.comment = row.comment
  if (row.modelSnapshot) f.modelSnapshot = row.modelSnapshot
  if (row.latencyMs !== null) f.latencyMs = row.latencyMs
  if (row.tokensIn !== null) f.tokensIn = row.tokensIn
  if (row.tokensOut !== null) f.tokensOut = row.tokensOut
  if (row.retrievedSourceIds) {
    f.retrievedSourceIds = row.retrievedSourceIds as string[]
  }
  return f
}

const rowToToolCall = (row: ToolCallRow): ToolCall => {
  const t: ToolCall = {
    id: asToolCallId(row.id),
    conversationId: asConversationId(row.conversationId),
    turnId: asTurnId(row.turnId),
    runId: asRunId(row.runId),
    agentId: asAgentId(row.agentId),
    messageId: asMessageId(row.messageId),
    toolName: row.toolName,
    args: row.args,
    isError: row.isError,
    status: row.status as ToolCallStatus,
    startedAt: row.startedAt,
  }
  if (row.result !== null) t.result = row.result
  if (row.completedAt !== null) t.completedAt = row.completedAt
  return t
}

// ─── Boot reconciliation ────────────────────────────────────────────────────
// A process kill (deploy, crash, bun --watch restart) leaves turns and runs
// frozen in `running` forever — there's no in-process actor left to end them.
// On boot, mark anything still `running` as `aborted` with an explanatory
// error string. Pure additive UPDATE; no risk to data outside this subsystem.
export const reconcileRunningOnBoot = async (): Promise<{
  turns: number
  runs: number
}> => {
  const ts = now()
  const reason = "reconciled on boot: process was not running"
  const turnRows = await db
    .update(v2ChatTurns)
    .set({ status: "aborted", endedAt: ts, error: reason })
    .where(eq(v2ChatTurns.status, "running"))
    .returning({ id: v2ChatTurns.id })
  const runRows = await db
    .update(v2ChatRuns)
    .set({ status: "aborted", endedAt: ts, error: reason })
    .where(eq(v2ChatRuns.status, "running"))
    .returning({ id: v2ChatRuns.id })
  return { turns: turnRows.length, runs: runRows.length }
}

// ─── UnitOfWork ─────────────────────────────────────────────────────────────
export class PostgresUnitOfWork implements UnitOfWork {
  public async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (trx) => fn(wrapTx(trx)))
  }
}

// ─── ConversationRepo ───────────────────────────────────────────────────────
export class PostgresConversationRepo implements ConversationRepo {
  public async create(
    init: ConversationInit,
    idemKey: IdemKey,
    tx?: Tx,
  ): Promise<Conversation> {
    const client = clientOf(tx)
    const existing = await client
      .select()
      .from(v2ChatConversations)
      .where(eq(v2ChatConversations.idemKey, idemKey))
      .limit(1)
    if (existing.length > 0 && existing[0]) {
      return rowToConversation(existing[0])
    }

    const id = newId("conv")
    const ts = now()
    const rows = await client
      .insert(v2ChatConversations)
      .values({
        id,
        ownerId: init.ownerId,
        workspaceId: init.workspaceId,
        title: init.title,
        agentId: init.agentId ?? null,
        createdAt: ts,
        updatedAt: ts,
        nextOrdinal: 0,
        idemKey,
      })
      .returning()
    const row = rows[0]
    if (!row) {
      throw new Error("v2ChatConversations: insert returned no row")
    }
    return rowToConversation(row)
  }

  public async get(
    id: ConversationId,
    tx?: Tx,
  ): Promise<Conversation | null> {
    const client = clientOf(tx)
    const rows = await client
      .select()
      .from(v2ChatConversations)
      .where(eq(v2ChatConversations.id, id))
      .limit(1)
    if (rows.length === 0 || !rows[0]) return null
    return rowToConversation(rows[0])
  }

  public async listByOwner(
    ownerId: UserId,
    page: Cursor,
    tx?: Tx,
  ): Promise<Page<Conversation>> {
    const client = clientOf(tx)
    const limit = clampLimit(page.limit)

    // Cursor: token is the prior page's last conversation id. Look up its
    // (createdAt, id) so we can drive a tuple-based WHERE that matches the
    // ORDER BY exactly — no skipped/duplicated rows when timestamps tie.
    let cursorCreatedAt: number | null = null
    let cursorId: string | null = null
    if (page.kind === "after") {
      const cursor = await client
        .select({
          createdAt: v2ChatConversations.createdAt,
          id: v2ChatConversations.id,
        })
        .from(v2ChatConversations)
        .where(eq(v2ChatConversations.id, page.token))
        .limit(1)
      if (cursor.length > 0 && cursor[0]) {
        cursorCreatedAt = cursor[0].createdAt
        cursorId = cursor[0].id
      }
    }

    const conditions = [
      eq(v2ChatConversations.ownerId, ownerId),
      isNull(v2ChatConversations.archivedAt),
    ]
    if (cursorCreatedAt !== null && cursorId !== null) {
      const tupleAfter = or(
        lt(v2ChatConversations.createdAt, cursorCreatedAt),
        and(
          eq(v2ChatConversations.createdAt, cursorCreatedAt),
          lt(v2ChatConversations.id, cursorId),
        ),
      )
      if (tupleAfter) conditions.push(tupleAfter)
    }

    const rows = await client
      .select()
      .from(v2ChatConversations)
      .where(and(...conditions))
      .orderBy(
        desc(v2ChatConversations.createdAt),
        desc(v2ChatConversations.id),
      )
      .limit(limit + 1)

    const items = rows.slice(0, limit).map(rowToConversation)
    const last = items[items.length - 1]
    const nextCursor = rows.length > limit && last ? last.id : undefined
    return nextCursor ? { items, nextCursor } : { items }
  }

  public async patch(
    id: ConversationId,
    patch: ConversationPatch,
    tx?: Tx,
  ): Promise<void> {
    const client = clientOf(tx)
    // Build patch object lazily so we don't overwrite columns the caller
    // didn't touch.
    const set: Record<string, unknown> = { updatedAt: now() }
    if (patch.title !== undefined) set.title = patch.title
    if (patch.archivedAt === null) set.archivedAt = null
    else if (typeof patch.archivedAt === "number") {
      set.archivedAt = patch.archivedAt
    }
    await client
      .update(v2ChatConversations)
      .set(set)
      .where(eq(v2ChatConversations.id, id))
  }

  public async softDelete(id: ConversationId, tx?: Tx): Promise<void> {
    await this.patch(id, { archivedAt: now() }, tx)
  }
}

// ─── MessageRepo ────────────────────────────────────────────────────────────
export class PostgresMessageRepo implements MessageRepo {
  /** Atomic counter for per-conversation message ordinal — UPDATE … RETURNING
   *  is single-statement atomic, no race even under concurrent writes. */
  private async nextOrdinal(
    client: TxnOrClient,
    conversationId: ConversationId,
  ): Promise<number> {
    const rows = await client
      .update(v2ChatConversations)
      .set({
        nextOrdinal: sql`${v2ChatConversations.nextOrdinal} + 1`,
      })
      .where(eq(v2ChatConversations.id, conversationId))
      .returning({ ordinal: v2ChatConversations.nextOrdinal })
    if (rows.length === 0 || !rows[0]) {
      throw new Error(`Conversation not found: ${conversationId}`)
    }
    return rows[0].ordinal
  }

  public async appendTurn(
    input: AppendTurnInput,
    idemKey: IdemKey,
    tx?: Tx,
  ): Promise<AppendTurnResult> {
    return inTx(tx, async (client) => {
      // Idempotency: same idemKey returns the same turn + user message.
      const existingTurnRows = await client
        .select()
        .from(v2ChatTurns)
        .where(eq(v2ChatTurns.idemKey, idemKey))
        .limit(1)
      const existingTurn = existingTurnRows[0]
      if (existingTurn) {
        const userMsgRows = await client
          .select()
          .from(v2ChatMessages)
          .where(
            and(
              eq(v2ChatMessages.turnId, existingTurn.id),
              eq(v2ChatMessages.role, "user"),
            ),
          )
          .limit(1)
        const userMsg = userMsgRows[0]
        if (userMsg) {
          return {
            turn: rowToTurn(existingTurn),
            userMessage: rowToMessage(userMsg),
          }
        }
      }

      const turnId = newId("turn")
      const ts = now()
      const turnRows = await client
        .insert(v2ChatTurns)
        .values({
          id: turnId,
          conversationId: input.conversationId,
          status: "running",
          startedAt: ts,
          idemKey,
        })
        .returning()
      const turnRow = turnRows[0]
      if (!turnRow) throw new Error("v2ChatTurns: insert returned no row")

      const ordinal = await this.nextOrdinal(client, input.conversationId)

      const msgId = newId("msg")
      const msgRows = await client
        .insert(v2ChatMessages)
        .values({
          id: msgId,
          conversationId: input.conversationId,
          turnId,
          role: "user",
          ordinal,
          parentMessageId: input.userMessage.parentMessageId ?? null,
          createdAt: ts,
          blocks: input.userMessage.blocks,
        })
        .returning()
      const msgRow = msgRows[0]
      if (!msgRow) throw new Error("v2ChatMessages: insert returned no row")

      return {
        turn: rowToTurn(turnRow),
        userMessage: rowToMessage(msgRow),
      }
    })
  }

  public async startRun(
    turnId: TurnId,
    init: RunInit,
    idemKey: IdemKey,
    tx?: Tx,
  ): Promise<Run> {
    return inTx(tx, async (client) => {
      const existing = await client
        .select()
        .from(v2ChatRuns)
        .where(eq(v2ChatRuns.idemKey, idemKey))
        .limit(1)
      if (existing.length > 0 && existing[0]) {
        return rowToRun(existing[0])
      }

      const turnRows = await client
        .select({ conversationId: v2ChatTurns.conversationId })
        .from(v2ChatTurns)
        .where(eq(v2ChatTurns.id, turnId))
        .limit(1)
      const turn = turnRows[0]
      if (!turn) throw new Error(`Turn not found: ${turnId}`)

      const id = newId("run")
      const rows = await client
        .insert(v2ChatRuns)
        .values({
          id,
          conversationId: turn.conversationId,
          turnId,
          parentRunId: init.parentRunId ?? null,
          agentId: init.agentId,
          model: init.model,
          status: "running",
          startedAt: now(),
          idemKey,
          ...(init.subAgentId ? { subAgentId: init.subAgentId } : {}),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("v2ChatRuns: insert returned no row")
      return rowToRun(row)
    })
  }

  public async endRun(
    runId: RunId,
    stats: RunStats,
    tx?: Tx,
  ): Promise<void> {
    const client = clientOf(tx)
    const set: Record<string, unknown> = {
      status: stats.status,
      endedAt: now(),
    }
    if (stats.tokensIn !== undefined) set.tokensIn = stats.tokensIn
    if (stats.tokensOut !== undefined) set.tokensOut = stats.tokensOut
    if (stats.costUsd !== undefined) set.costUsd = String(stats.costUsd)
    if (stats.error) set.error = stats.error
    await client.update(v2ChatRuns).set(set).where(eq(v2ChatRuns.id, runId))
  }

  public async appendAssistantMessage(
    runId: RunId,
    input: NewAssistantMessage,
    idemKey: IdemKey,
    tx?: Tx,
  ): Promise<Message> {
    return inTx(tx, async (client) => {
      const existing = await client
        .select()
        .from(v2ChatMessages)
        .where(eq(v2ChatMessages.idemKey, idemKey))
        .limit(1)
      if (existing.length > 0 && existing[0]) {
        return rowToMessage(existing[0])
      }

      const runRows = await client
        .select({
          conversationId: v2ChatRuns.conversationId,
          turnId: v2ChatRuns.turnId,
        })
        .from(v2ChatRuns)
        .where(eq(v2ChatRuns.id, runId))
        .limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`Run not found: ${runId}`)

      const ordinal = await this.nextOrdinal(
        client,
        asConversationId(run.conversationId),
      )
      const id = newId("msg")
      const rows = await client
        .insert(v2ChatMessages)
        .values({
          id,
          conversationId: run.conversationId,
          turnId: run.turnId,
          runId,
          role: "assistant",
          ordinal,
          parentMessageId: input.parentMessageId ?? null,
          createdAt: now(),
          blocks: [],
          idemKey,
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("v2ChatMessages: insert returned no row")

      // Service always opens an assistant message with blocks=[] — blocks
      // stream in via appendBlock. The loop below is a defensive carry-over
      // from the in-memory impl for the case where callers pre-seed blocks
      // (so tool-call projection still runs for those blocks).
      for (const b of input.blocks) {
        await this.appendBlockInternal(client, asMessageId(id), b)
      }
      return rowToMessage(row)
    })
  }

  public async appendBlock(
    messageId: MessageId,
    block: Block,
    tx?: Tx,
  ): Promise<void> {
    return inTx(tx, async (client) => {
      await this.appendBlockInternal(client, messageId, block)
    })
  }

  /** The actual append. Assumes a transaction is already in scope. */
  private async appendBlockInternal(
    client: TxnOrClient,
    messageId: MessageId,
    block: Block,
  ): Promise<void> {
    // Single-statement JSONB concat: blocks || [block]. Atomic per row.
    const updated = await client
      .update(v2ChatMessages)
      .set({
        blocks: sql`${v2ChatMessages.blocks} || ${JSON.stringify([block])}::jsonb`,
      })
      .where(eq(v2ChatMessages.id, messageId))
      .returning({
        id: v2ChatMessages.id,
        conversationId: v2ChatMessages.conversationId,
        turnId: v2ChatMessages.turnId,
        runId: v2ChatMessages.runId,
      })
    const msg = updated[0]
    if (!msg) throw new Error(`Message not found: ${messageId}`)

    if (block.kind === "tool_use") {
      if (!msg.runId) return // user messages don't carry tool calls
      const runRows = await client
        .select({ agentId: v2ChatRuns.agentId })
        .from(v2ChatRuns)
        .where(eq(v2ChatRuns.id, msg.runId))
        .limit(1)
      const run = runRows[0]
      if (!run) return
      await client
        .insert(v2ChatToolCalls)
        .values({
          id: block.toolCallId,
          conversationId: msg.conversationId,
          turnId: msg.turnId,
          runId: msg.runId,
          agentId: run.agentId,
          messageId: msg.id,
          toolName: block.toolName,
          args: block.args ?? null,
          isError: false,
          status: "pending",
          startedAt: now(),
        })
        .onConflictDoNothing()
      return
    }

    if (block.kind === "tool_result") {
      const ts = now()
      const updatedRows = await client
        .update(v2ChatToolCalls)
        .set({
          result: block.output ?? null,
          isError: block.isError,
          status: block.isError ? "error" : "completed",
          completedAt: ts,
        })
        .where(eq(v2ChatToolCalls.id, block.toolCallId))
        .returning({ id: v2ChatToolCalls.id })
      if (updatedRows.length > 0) return

      // Orphan result (no matching tool_use seen): record what we can.
      if (!msg.runId) return
      const runRows = await client
        .select({ agentId: v2ChatRuns.agentId })
        .from(v2ChatRuns)
        .where(eq(v2ChatRuns.id, msg.runId))
        .limit(1)
      const run = runRows[0]
      if (!run) return
      await client
        .insert(v2ChatToolCalls)
        .values({
          id: block.toolCallId,
          conversationId: msg.conversationId,
          turnId: msg.turnId,
          runId: msg.runId,
          agentId: run.agentId,
          messageId: msg.id,
          toolName: "(unknown)",
          args: null,
          result: block.output ?? null,
          isError: block.isError,
          status: block.isError ? "error" : "completed",
          startedAt: ts,
          completedAt: ts,
        })
        .onConflictDoNothing()
    }
  }

  public async setStats(
    messageId: MessageId,
    stats: MessageStats,
    tx?: Tx,
  ): Promise<void> {
    const client = clientOf(tx)
    await client
      .update(v2ChatMessages)
      .set({ stats })
      .where(eq(v2ChatMessages.id, messageId))
  }

  public async endTurn(
    turnId: TurnId,
    status: TurnStatus,
    error: string | undefined,
    tx?: Tx,
  ): Promise<void> {
    const client = clientOf(tx)
    const set: Record<string, unknown> = { status, endedAt: now() }
    if (error) set.error = error
    await client.update(v2ChatTurns).set(set).where(eq(v2ChatTurns.id, turnId))
  }

  public async listMessages(
    conversationId: ConversationId,
    page: Cursor,
    tx?: Tx,
  ): Promise<Page<MessageWithBlocks>> {
    const client = clientOf(tx)
    const limit = clampLimit(page.limit)

    let cursorOrdinal: number | null = null
    if (page.kind === "after") {
      const cursor = await client
        .select({ ordinal: v2ChatMessages.ordinal })
        .from(v2ChatMessages)
        .where(eq(v2ChatMessages.id, page.token))
        .limit(1)
      if (cursor[0]) cursorOrdinal = cursor[0].ordinal
    }

    const conditions = [eq(v2ChatMessages.conversationId, conversationId)]
    if (cursorOrdinal !== null) {
      conditions.push(gt(v2ChatMessages.ordinal, cursorOrdinal))
    }

    // Hide messages produced by nested runs (sub-agents dispatched via
    // dispatchSubagent — M7). The parent's view of a turn is its own
    // assistant message; the sub-agent's persisted trace lives under
    // the nested run row and is reachable separately for the M8 replay
    // tree. Without this filter the nested assistant message bubbles
    // up to the conversation list (1) showing the sub-agent's text
    // twice (once inside the dispatch tool_result, once standalone)
    // and (2) defeating the UI's "is the turn in flight?" heuristic,
    // which keys off the absence of `stats` on the last message — the
    // nested message has no stats by design (only the parent run
    // carries them).
    const nestedRunIds = client
      .select({ id: v2ChatRuns.id })
      .from(v2ChatRuns)
      .where(
        and(
          eq(v2ChatRuns.conversationId, conversationId),
          isNotNull(v2ChatRuns.parentRunId),
        ),
      )
    conditions.push(
      or(
        isNull(v2ChatMessages.runId),
        notInArray(v2ChatMessages.runId, nestedRunIds),
      )!,
    )

    const rows = await client
      .select()
      .from(v2ChatMessages)
      .where(and(...conditions))
      .orderBy(asc(v2ChatMessages.ordinal))
      .limit(limit + 1)

    const items = rows.slice(0, limit).map(rowToMessageWithBlocks)
    const last = items[items.length - 1]
    const nextCursor = rows.length > limit && last ? last.id : undefined
    return nextCursor ? { items, nextCursor } : { items }
  }

  public async getMessage(
    id: MessageId,
    tx?: Tx,
  ): Promise<MessageWithBlocks | null> {
    const client = clientOf(tx)
    const rows = await client
      .select()
      .from(v2ChatMessages)
      .where(eq(v2ChatMessages.id, id))
      .limit(1)
    if (!rows[0]) return null
    return rowToMessageWithBlocks(rows[0])
  }

  public async listRunsForTurn(turnId: TurnId, tx?: Tx): Promise<Run[]> {
    const client = clientOf(tx)
    const rows = await client
      .select()
      .from(v2ChatRuns)
      .where(eq(v2ChatRuns.turnId, turnId))
      .orderBy(asc(v2ChatRuns.startedAt), asc(v2ChatRuns.id))
    return rows.map(rowToRun)
  }

  public async listChildRuns(
    conversationId: ConversationId,
    parentRunId: RunId,
    tx?: Tx,
  ): Promise<Run[]> {
    const client = clientOf(tx)
    // conversation_id is required (cheap defensive scope) AND
    // parent_run_id matches the dispatcher. Order by startedAt so the
    // UI can match the Nth dispatch tool_call to the Nth nested run.
    const rows = await client
      .select()
      .from(v2ChatRuns)
      .where(
        and(
          eq(v2ChatRuns.conversationId, conversationId),
          eq(v2ChatRuns.parentRunId, parentRunId),
        ),
      )
      .orderBy(asc(v2ChatRuns.startedAt), asc(v2ChatRuns.id))
    return rows.map(rowToRun)
  }

  public async listMessagesByRun(
    runId: RunId,
    tx?: Tx,
  ): Promise<MessageWithBlocks[]> {
    const client = clientOf(tx)
    const rows = await client
      .select()
      .from(v2ChatMessages)
      .where(eq(v2ChatMessages.runId, runId))
      .orderBy(asc(v2ChatMessages.ordinal))
    return rows.map(rowToMessageWithBlocks)
  }

  public async listRunsForConversation(
    conversationId: ConversationId,
    page: Cursor,
    tx?: Tx,
  ): Promise<Page<Run>> {
    const client = clientOf(tx)
    const limit = clampLimit(page.limit)

    let cursorStartedAt: number | null = null
    let cursorId: string | null = null
    if (page.kind === "after") {
      const cursor = await client
        .select({
          startedAt: v2ChatRuns.startedAt,
          id: v2ChatRuns.id,
        })
        .from(v2ChatRuns)
        .where(eq(v2ChatRuns.id, page.token))
        .limit(1)
      if (cursor[0]) {
        cursorStartedAt = cursor[0].startedAt
        cursorId = cursor[0].id
      }
    }

    const conditions = [eq(v2ChatRuns.conversationId, conversationId)]
    if (cursorStartedAt !== null && cursorId !== null) {
      const tupleAfter = or(
        gt(v2ChatRuns.startedAt, cursorStartedAt),
        and(
          eq(v2ChatRuns.startedAt, cursorStartedAt),
          gt(v2ChatRuns.id, cursorId),
        ),
      )
      if (tupleAfter) conditions.push(tupleAfter)
    }

    const rows = await client
      .select()
      .from(v2ChatRuns)
      .where(and(...conditions))
      .orderBy(asc(v2ChatRuns.startedAt), asc(v2ChatRuns.id))
      .limit(limit + 1)

    const items = rows.slice(0, limit).map(rowToRun)
    const last = items[items.length - 1]
    const nextCursor = rows.length > limit && last ? last.id : undefined
    return nextCursor ? { items, nextCursor } : { items }
  }

  public async getToolCall(
    id: ToolCallId,
    tx?: Tx,
  ): Promise<ToolCall | null> {
    const client = clientOf(tx)
    const rows = await client
      .select()
      .from(v2ChatToolCalls)
      .where(eq(v2ChatToolCalls.id, id))
      .limit(1)
    if (!rows[0]) return null
    return rowToToolCall(rows[0])
  }

  public async listToolCalls(
    filter: {
      conversationId?: ConversationId
      turnId?: TurnId
      runId?: RunId
      toolName?: string
    },
    page: Cursor,
    tx?: Tx,
  ): Promise<Page<ToolCall>> {
    const client = clientOf(tx)
    const limit = clampLimit(page.limit)

    let cursorStartedAt: number | null = null
    let cursorId: string | null = null
    if (page.kind === "after") {
      const cursor = await client
        .select({
          startedAt: v2ChatToolCalls.startedAt,
          id: v2ChatToolCalls.id,
        })
        .from(v2ChatToolCalls)
        .where(eq(v2ChatToolCalls.id, page.token))
        .limit(1)
      if (cursor[0]) {
        cursorStartedAt = cursor[0].startedAt
        cursorId = cursor[0].id
      }
    }

    const conditions = []
    if (filter.conversationId) {
      conditions.push(eq(v2ChatToolCalls.conversationId, filter.conversationId))
    }
    if (filter.turnId) {
      conditions.push(eq(v2ChatToolCalls.turnId, filter.turnId))
    }
    if (filter.runId) {
      conditions.push(eq(v2ChatToolCalls.runId, filter.runId))
    }
    if (filter.toolName) {
      conditions.push(eq(v2ChatToolCalls.toolName, filter.toolName))
    }
    if (cursorStartedAt !== null && cursorId !== null) {
      const tupleAfter = or(
        gt(v2ChatToolCalls.startedAt, cursorStartedAt),
        and(
          eq(v2ChatToolCalls.startedAt, cursorStartedAt),
          gt(v2ChatToolCalls.id, cursorId),
        ),
      )
      if (tupleAfter) conditions.push(tupleAfter)
    }

    const query = client
      .select()
      .from(v2ChatToolCalls)
      .orderBy(asc(v2ChatToolCalls.startedAt), asc(v2ChatToolCalls.id))
      .limit(limit + 1)
    const rows = await (conditions.length > 0
      ? query.where(and(...conditions))
      : query)

    const items = rows.slice(0, limit).map(rowToToolCall)
    const last = items[items.length - 1]
    const nextCursor = rows.length > limit && last ? last.id : undefined
    return nextCursor ? { items, nextCursor } : { items }
  }

  public async dumpConversation(
    conversationId: ConversationId,
    tx?: Tx,
  ): Promise<{
    messages: MessageWithBlocks[]
    runs: Run[]
    toolCalls: ToolCall[]
  }> {
    const client = clientOf(tx)
    // Three parallel scans — each table has the conversation_id index
    // so this is bounded and fast even on busy conversations.
    // Importantly we DON'T filter out nested-run messages here (unlike
    // listMessages) — the dump's job is to give the operator
    // everything for offline inspection.
    const [messageRows, runRows, toolCallRows] = await Promise.all([
      client
        .select()
        .from(v2ChatMessages)
        .where(eq(v2ChatMessages.conversationId, conversationId))
        .orderBy(asc(v2ChatMessages.ordinal), asc(v2ChatMessages.id)),
      client
        .select()
        .from(v2ChatRuns)
        .where(eq(v2ChatRuns.conversationId, conversationId))
        .orderBy(asc(v2ChatRuns.startedAt), asc(v2ChatRuns.id)),
      client
        .select()
        .from(v2ChatToolCalls)
        .where(eq(v2ChatToolCalls.conversationId, conversationId))
        .orderBy(asc(v2ChatToolCalls.startedAt), asc(v2ChatToolCalls.id)),
    ])
    return {
      messages: messageRows.map(rowToMessageWithBlocks),
      runs: runRows.map(rowToRun),
      toolCalls: toolCallRows.map(rowToToolCall),
    }
  }
}

// ─── MessageFeedbackRepo ────────────────────────────────────────────────────
export class PostgresMessageFeedbackRepo implements MessageFeedbackRepo {
  public async upsert(
    keys: {
      messageId: MessageId
      conversationId: ConversationId
      userId: UserId
      workspaceId: WorkspaceId
      runId?: RunId
    },
    input: MessageFeedbackInput,
    tx?: Tx,
  ): Promise<MessageFeedback> {
    const client = clientOf(tx)
    const ts = now()
    const id = newId("mfb")
    // ON CONFLICT (user_id, message_id) DO UPDATE — flipping like→dislike or
    // editing tags/comment replaces the row. We bump updated_at but keep
    // created_at so analytics can distinguish first-rating-at vs last-edit-at.
    const rows = await client
      .insert(v2ChatMessageFeedback)
      .values({
        id,
        messageId: keys.messageId,
        conversationId: keys.conversationId,
        runId: keys.runId ?? null,
        userId: keys.userId,
        workspaceId: keys.workspaceId,
        rating: input.rating,
        tags: input.tags ?? [],
        comment: input.comment ?? null,
        shareChat: input.shareChat ?? false,
        modelSnapshot: input.modelSnapshot ?? null,
        latencyMs: input.latencyMs ?? null,
        tokensIn: input.tokensIn ?? null,
        tokensOut: input.tokensOut ?? null,
        retrievedSourceIds: input.retrievedSourceIds ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: [
          v2ChatMessageFeedback.userId,
          v2ChatMessageFeedback.messageId,
        ],
        set: {
          rating: input.rating,
          tags: input.tags ?? [],
          comment: input.comment ?? null,
          shareChat: input.shareChat ?? false,
          modelSnapshot: input.modelSnapshot ?? null,
          latencyMs: input.latencyMs ?? null,
          tokensIn: input.tokensIn ?? null,
          tokensOut: input.tokensOut ?? null,
          retrievedSourceIds: input.retrievedSourceIds ?? null,
          updatedAt: ts,
        },
      })
      .returning()
    const row = rows[0]
    if (!row) {
      throw new Error("v2ChatMessageFeedback: upsert returned no row")
    }
    return rowToFeedback(row)
  }

  public async get(
    keys: { messageId: MessageId; userId: UserId },
    tx?: Tx,
  ): Promise<MessageFeedback | null> {
    const client = clientOf(tx)
    const rows = await client
      .select()
      .from(v2ChatMessageFeedback)
      .where(
        and(
          eq(v2ChatMessageFeedback.messageId, keys.messageId),
          eq(v2ChatMessageFeedback.userId, keys.userId),
        ),
      )
      .limit(1)
    if (!rows[0]) return null
    return rowToFeedback(rows[0])
  }

  public async delete(
    keys: { messageId: MessageId; userId: UserId },
    tx?: Tx,
  ): Promise<boolean> {
    const client = clientOf(tx)
    const rows = await client
      .delete(v2ChatMessageFeedback)
      .where(
        and(
          eq(v2ChatMessageFeedback.messageId, keys.messageId),
          eq(v2ChatMessageFeedback.userId, keys.userId),
        ),
      )
      .returning({ id: v2ChatMessageFeedback.id })
    return rows.length > 0
  }
}
