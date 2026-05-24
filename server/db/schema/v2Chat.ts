// Persistence for the backendv2 agent storage layer.
//
// Mirrors the in-memory shape defined in
// `/server/backendv2/agent/storage/types.ts` 1:1 so PostgresConversationRepo /
// PostgresMessageRepo are a direct swap-in for the InMemory* variants.
//
// Key shape decisions:
//   • IDs are the same prefixed strings the in-memory impl produces (conv_*,
//     turn_*, run_*, msg_*) — opaque to the rest of the system. No serial PKs.
//   • Timestamps are bigint(ms) so Date.now() round-trips exactly without any
//     Date<->number conversion in the hot path.
//   • Blocks live as a JSONB array on the message row (matches MessageWithBlocks
//     in memory). Pi-mono runs serially per conversation, so appendBlock's
//     `blocks || $newBlock::jsonb` UPDATE is race-free in practice.
//   • `next_ordinal` is an aux counter on conversations; UPDATE … RETURNING
//     gives us an atomic per-conversation message sequence.

import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"

// ─── Enums ──────────────────────────────────────────────────────────────────
// Shared between turns and runs: same status set.
export const v2ChatTurnStatusEnum = pgEnum("v2_chat_turn_status", [
  "running",
  "completed",
  "errored",
  "aborted",
])

export const v2ChatMessageRoleEnum = pgEnum("v2_chat_message_role", [
  "user",
  "assistant",
  "system",
])

export const v2ChatToolCallStatusEnum = pgEnum("v2_chat_tool_call_status", [
  "pending",
  "completed",
  "error",
])

// Mirrors v1's shared `MessageFeedback` enum so future cross-version analytics
// can union both tables without translating values.
export const v2ChatMessageFeedbackRatingEnum = pgEnum(
  "v2_chat_message_feedback_rating",
  ["like", "dislike"],
)

// What produced this conversation. `chat` is the normal user-driven chat
// surface; `extract` is the programmatic extractor endpoint, which writes
// to the same tables so its run is replayable and debug-inspectable but is
// filtered out of the default chat sidebar.
export const v2ChatConversationOriginEnum = pgEnum(
  "v2_chat_conversation_origin",
  ["chat", "extract"],
)

// ─── Conversations ──────────────────────────────────────────────────────────
export const v2ChatConversations = pgTable(
  "v2_chat_conversations",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull(),
    agentId: text("agent_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    archivedAt: bigint("archived_at", { mode: "number" }),
    nextOrdinal: integer("next_ordinal").notNull().default(0),
    idemKey: text("idem_key").notNull(),
    originKind: v2ChatConversationOriginEnum("origin_kind")
      .notNull()
      .default("chat"),
  },
  (table) => ({
    idemUnique: uniqueIndex("v2_chat_conv_idem_unique").on(table.idemKey),
    ownerCreatedIndex: index("v2_chat_conv_owner_created_index").on(
      table.ownerId,
      table.createdAt,
    ),
    originIndex: index("v2_chat_conv_origin_index").on(table.originKind),
  }),
)

// ─── Turns ──────────────────────────────────────────────────────────────────
export const v2ChatTurns = pgTable(
  "v2_chat_turns",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => v2ChatConversations.id, { onDelete: "cascade" }),
    status: v2ChatTurnStatusEnum("status").notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    endedAt: bigint("ended_at", { mode: "number" }),
    error: text("error"),
    idemKey: text("idem_key").notNull(),
  },
  (table) => ({
    idemUnique: uniqueIndex("v2_chat_turn_idem_unique").on(table.idemKey),
    convIndex: index("v2_chat_turn_conv_index").on(table.conversationId),
  }),
)

// ─── Runs ───────────────────────────────────────────────────────────────────
export const v2ChatRuns = pgTable(
  "v2_chat_runs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => v2ChatConversations.id, { onDelete: "cascade" }),
    turnId: text("turn_id")
      .notNull()
      .references(() => v2ChatTurns.id, { onDelete: "cascade" }),
    parentRunId: text("parent_run_id").references(
      (): AnyPgColumn => v2ChatRuns.id,
    ),
    agentId: text("agent_id").notNull(),
    // Nested-run pointer (M3, used in M7). When this run was spawned by
    // the parent agent's `dispatchSubagent` tool, holds the sub-agent's
    // `external_id`; null for top-level (parent) runs. Stored as plain
    // text without an FK constraint — mirrors how `agent_id` is held —
    // so deleting a sub-agent row doesn't cascade-orphan historical
    // chat traces.
    subAgentId: text("sub_agent_id"),
    model: text("model").notNull(),
    status: v2ChatTurnStatusEnum("status").notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    endedAt: bigint("ended_at", { mode: "number" }),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    // numeric returns string from postgres-js; repo parses to number on read.
    costUsd: numeric("cost_usd"),
    error: text("error"),
    idemKey: text("idem_key").notNull(),
  },
  (table) => ({
    idemUnique: uniqueIndex("v2_chat_run_idem_unique").on(table.idemKey),
    turnIndex: index("v2_chat_run_turn_index").on(table.turnId),
    convIndex: index("v2_chat_run_conv_index").on(table.conversationId),
    // Used to walk the parent → nested-run tree when reconstructing a
    // turn for replay (M8). Without this, the tree walk would scan all
    // runs in a turn.
    parentRunIndex: index("v2_chat_run_parent_index").on(table.parentRunId),
    // Lets us filter runs by sub-agent for "what did the researcher
    // sub-agent do?" style analytics.
    subAgentIndex: index("v2_chat_run_subagent_index").on(table.subAgentId),
  }),
)

// ─── Messages ───────────────────────────────────────────────────────────────
// Blocks live inline as JSONB to match MessageWithBlocks. Stats are nullable
// JSONB — only set on assistant messages after the run wraps.
export const v2ChatMessages = pgTable(
  "v2_chat_messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => v2ChatConversations.id, { onDelete: "cascade" }),
    turnId: text("turn_id")
      .notNull()
      .references(() => v2ChatTurns.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => v2ChatRuns.id),
    role: v2ChatMessageRoleEnum("role").notNull(),
    ordinal: integer("ordinal").notNull(),
    parentMessageId: text("parent_message_id").references(
      (): AnyPgColumn => v2ChatMessages.id,
    ),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    blocks: jsonb("blocks").notNull().default(sql`'[]'::jsonb`),
    stats: jsonb("stats"),
    // Nullable: user messages share their turn's idem key and don't carry one.
    // Postgres uniqueIndex permits multiple NULLs by default — that's what we
    // want.
    idemKey: text("idem_key"),
  },
  (table) => ({
    idemUnique: uniqueIndex("v2_chat_msg_idem_unique").on(table.idemKey),
    convOrdIndex: index("v2_chat_msg_conv_ord_index").on(
      table.conversationId,
      table.ordinal,
    ),
    turnIndex: index("v2_chat_msg_turn_index").on(table.turnId),
  }),
)

// ─── Message feedback ───────────────────────────────────────────────────────
// One row per (user, message). Upsert on conflict — flipping like→dislike
// replaces the row rather than appending history. Snapshot fields
// (model, latency, tokens, retrievedSourceIds) freeze the run context at the
// moment the user rated; joins to v2_chat_runs / v2_chat_messages would drift
// if the message is later regenerated. workspaceId is denormalized for
// workspace-scoped admin/eval queries without a 4-table join.
export const v2ChatMessageFeedback = pgTable(
  "v2_chat_message_feedback",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => v2ChatMessages.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => v2ChatConversations.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => v2ChatRuns.id),
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    rating: v2ChatMessageFeedbackRatingEnum("rating").notNull(),
    tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),
    comment: text("comment"),
    shareChat: boolean("share_chat").notNull().default(false),
    modelSnapshot: text("model_snapshot"),
    latencyMs: integer("latency_ms"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    retrievedSourceIds: jsonb("retrieved_source_ids"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => ({
    userMessageUnique: uniqueIndex("v2_chat_msg_feedback_user_msg_unique").on(
      table.userId,
      table.messageId,
    ),
    convIndex: index("v2_chat_msg_feedback_conv_index").on(
      table.conversationId,
    ),
    ratingCreatedIndex: index("v2_chat_msg_feedback_rating_created_index").on(
      table.rating,
      table.createdAt,
    ),
    workspaceIndex: index("v2_chat_msg_feedback_workspace_index").on(
      table.workspaceId,
      table.createdAt,
    ),
  }),
)

// ─── Tool calls (projection) ────────────────────────────────────────────────
// Sideways index over tool_use + tool_result blocks for analytics. Populated
// by the repo on every appendBlock so listToolCalls can answer filtered
// queries without parsing JSONB.
export const v2ChatToolCalls = pgTable(
  "v2_chat_tool_calls",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => v2ChatConversations.id, { onDelete: "cascade" }),
    turnId: text("turn_id")
      .notNull()
      .references(() => v2ChatTurns.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => v2ChatRuns.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    messageId: text("message_id")
      .notNull()
      .references(() => v2ChatMessages.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    args: jsonb("args"),
    result: jsonb("result"),
    isError: boolean("is_error").notNull().default(false),
    status: v2ChatToolCallStatusEnum("status").notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    completedAt: bigint("completed_at", { mode: "number" }),
  },
  (table) => ({
    convStartedIndex: index("v2_chat_toolcall_conv_started_index").on(
      table.conversationId,
      table.startedAt,
    ),
    runIndex: index("v2_chat_toolcall_run_index").on(table.runId),
    toolNameIndex: index("v2_chat_toolcall_name_index").on(table.toolName),
  }),
)
