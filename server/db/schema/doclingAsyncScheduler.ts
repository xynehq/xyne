import { sql } from "drizzle-orm"
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { collectionItems } from "@/db/schema/knowledgeBase"

export const doclingAsyncFiles = pgTable(
  "docling_async_files",
  {
    fileId: text("file_id")
      .primaryKey()
      .references(() => collectionItems.id, { onDelete: "cascade" }),
    vespaDocId: text("vespa_doc_id").notNull(),
    collectionId: text("collection_id").notNull(),
    parentId: text("parent_id"),
    collectionName: text("collection_name").notNull(),
    fileName: text("file_name").notNull(),
    originalName: text("original_name"),
    sourcePath: text("source_path").notNull(),
    sourceStorageKey: text("source_storage_key"),
    stageDir: text("stage_dir"),
    partsDir: text("parts_dir"),
    resultsDir: text("results_dir"),
    manifestPath: text("manifest_path"),
    path: text("path").notNull().default("/"),
    mimeType: text("mime_type").notNull().default("application/pdf"),
    baseMimeType: text("base_mime_type").notNull().default("application/pdf"),
    fileSize: integer("file_size").notNull().default(0),
    uploadedByEmail: text("uploaded_by_email"),
    pageTitle: text("page_title").notNull().default(""),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    sourceKind: text("source_kind").notNull().default("ingestion"),
    basePriority: integer("base_priority").notNull().default(0),
    priorityOverride: integer("priority_override"),
    effectivePriority: integer("effective_priority").notNull().default(0),
    status: text("status").notNull().default("pending_split"),
    totalPages: integer("total_pages").notNull().default(0),
    totalParts: integer("total_parts").notNull().default(0),
    pageChunkSize: integer("page_chunk_size").notNull().default(0),
    readyPartsCount: integer("ready_parts_count").notNull().default(0),
    submittedPartsCount: integer("submitted_parts_count").notNull().default(0),
    activePartsCount: integer("active_parts_count").notNull().default(0),
    writeAttemptCount: integer("write_attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    ocrActivatedAt: timestamp("ocr_activated_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (table) => ({
    statusPriorityIdx: index("docling_async_files_status_priority_idx").on(
      table.status,
      table.availableAt,
      table.effectivePriority,
      table.createdAt,
    ),
    activeStatusIdx: index("docling_async_files_active_status_idx").on(
      table.status,
      table.leaseUntil,
    ),
    collectionIdx: index("docling_async_files_collection_idx").on(
      table.collectionId,
    ),
  }),
)

export const doclingAsyncParts = pgTable(
  "docling_async_parts",
  {
    fileId: text("file_id")
      .notNull()
      .references(() => doclingAsyncFiles.fileId, { onDelete: "cascade" }),
    partIndex: integer("part_index").notNull(),
    docId: text("doc_id").notNull(),
    currentJobId: text("current_job_id"),
    partPath: text("part_path").notNull(),
    resultPath: text("result_path"),
    startPage: integer("start_page").notNull(),
    endPage: integer("end_page").notNull(),
    partSizeBytes: integer("part_size_bytes").notNull().default(0),
    status: text("status").notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    writtenAt: timestamp("written_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    submitPermitId: text("submit_permit_id"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.fileId, table.partIndex],
      name: "docling_async_parts_pk",
    }),
    currentJobIdIdx: uniqueIndex("docling_async_parts_current_job_id_uidx")
      .on(table.currentJobId)
      .where(sql`${table.currentJobId} IS NOT NULL`),
    statusAvailableIdx: index("docling_async_parts_status_available_idx").on(
      table.status,
      table.availableAt,
      table.createdAt,
    ),
    fileStatusIdx: index("docling_async_parts_file_status_idx").on(
      table.fileId,
      table.status,
    ),
    submitPermitIdx: index("docling_async_parts_submit_permit_idx").on(
      table.submitPermitId,
    ),
  }),
)

export type DoclingAsyncFile = typeof doclingAsyncFiles.$inferSelect
export type NewDoclingAsyncFile = typeof doclingAsyncFiles.$inferInsert
export type DoclingAsyncPart = typeof doclingAsyncParts.$inferSelect
export type NewDoclingAsyncPart = typeof doclingAsyncParts.$inferInsert
