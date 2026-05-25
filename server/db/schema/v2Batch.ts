// Persistence for the backendv2 batch processing module.
//
// A batch is a CSV/XLSX of questions the user uploads. Each row is processed
// independently through pi-mono (the same engine /v2/chat uses) and the
// answer is written back to a result XLSX that's regenerated progressively
// from the DB as rows complete.
//
// Two tables:
//   • v2_batch_jobs — one row per uploaded sheet. Counters + status.
//   • v2_batch_rows — one row per question. Carries the answer + telemetry.
//
// Shape decisions match v2Chat.ts:
//   • IDs are prefixed strings (bat_*, brow_*) — opaque outside the module.
//   • Timestamps are bigint(ms) so Date.now() round-trips.
//   • The original sheet columns are preserved as JSONB on each row so the
//     result writer can rebuild the workbook without re-parsing the source.

import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"

// ─── Enums ──────────────────────────────────────────────────────────────────
export const v2BatchJobStatusEnum = pgEnum("v2_batch_job_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
])

export const v2BatchRowStatusEnum = pgEnum("v2_batch_row_status", [
  "pending",
  "running",
  "done",
  "error",
])

// ─── Jobs ───────────────────────────────────────────────────────────────────
export const v2BatchJobs = pgTable(
  "v2_batch_jobs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    // External label of the picked model (e.g. "Claude Sonnet 4.5"). The
    // worker resolves this through getModelValueFromLabel at run time, same
    // as /v2/chat does for input.model.
    model: text("model"),
    // External ID of a custom agent the viewer wants the batch to run
    // through. Permission checked at creation time via loadAgentScope.
    agentId: text("agent_id"),
    status: v2BatchJobStatusEnum("status").notNull(),
    // Counters maintained by the worker on every row transition. Source of
    // truth for the progress bar; cheaper than a per-row COUNT(*) on read.
    totalRows: integer("total_rows").notNull().default(0),
    completedRows: integer("completed_rows").notNull().default(0),
    erroredRows: integer("errored_rows").notNull().default(0),
    // Column header in the source sheet that holds the question text. The
    // form submits the user's pick; the parser falls back to a header heuristic
    // when not supplied.
    questionColumn: text("question_column").notNull(),
    // Column names actually used in the result file. Defaults to "answer",
    // "status", "error", etc., but get suffixed (_xyne) when the source
    // sheet already has columns with those names.
    resultColumns: jsonb("result_columns").notNull(),
    sourceFilePath: text("source_file_path").notNull(),
    sourceMime: text("source_mime").notNull(),
    resultFilePath: text("result_file_path").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    startedAt: bigint("started_at", { mode: "number" }),
    finishedAt: bigint("finished_at", { mode: "number" }),
    archivedAt: bigint("archived_at", { mode: "number" }),
    error: text("error"),
  },
  (table) => ({
    ownerCreatedIndex: index("v2_batch_jobs_owner_created_index").on(
      table.ownerId,
      table.createdAt,
    ),
  }),
)

// ─── Rows ───────────────────────────────────────────────────────────────────
// One row per question. `originalColumns` carries the full source row as JSON
// so the result-writer can rebuild a workbook from DB state alone — no need
// to re-open the source file every time a row finishes.
export const v2BatchRows = pgTable(
  "v2_batch_rows",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id")
      .notNull()
      .references(() => v2BatchJobs.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    question: text("question").notNull(),
    // Verbatim copy of the source row (keyed by source column header). The
    // result file is written in the same column order as the source plus the
    // appended answer/status columns.
    originalColumns: jsonb("original_columns").notNull(),
    answer: text("answer"),
    status: v2BatchRowStatusEnum("status").notNull().default("pending"),
    error: text("error"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    durationMs: bigint("duration_ms", { mode: "number" }),
    startedAt: bigint("started_at", { mode: "number" }),
    finishedAt: bigint("finished_at", { mode: "number" }),
  },
  (table) => ({
    batchOrdinalUnique: uniqueIndex("v2_batch_rows_batch_ordinal_unique").on(
      table.batchId,
      table.ordinal,
    ),
    batchStatusIndex: index("v2_batch_rows_batch_status_index").on(
      table.batchId,
      table.status,
    ),
  }),
)
