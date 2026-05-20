import { randomUUID } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  collectionItems,
  doclingAsyncFiles,
  doclingAsyncParts,
  type DoclingAsyncFile,
  type DoclingAsyncPart,
  type NewDoclingAsyncFile,
} from "@/db/schema"
import type { DoclingStagedParts } from "@/lib/pdfProcessor"
import { UploadStatus } from "@/shared/types"

export const DOCLING_FILE_STATUS = {
  PendingSplit: "pending_split",
  Splitting: "splitting",
  QueuedForOcr: "queued_for_ocr",
  OcrActive: "ocr_active",
  ReadyToWrite: "ready_to_write",
  Writing: "writing",
  Completed: "completed",
  Failed: "failed",
} as const

export const DOCLING_PART_STATUS = {
  Queued: "queued",
  Submitting: "submitting",
  Submitted: "submitted",
  Ready: "ready",
  Written: "written",
  Failed: "failed",
} as const

type RawFileRow = Record<string, unknown>
type RawPartRow = Record<string, unknown>

const dateOrNull = (value: unknown): Date | null =>
  value instanceof Date ? value : value ? new Date(String(value)) : null

const numberValue = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const fileFromRow = (row: RawFileRow): DoclingAsyncFile => ({
  fileId: String(row.file_id),
  vespaDocId: String(row.vespa_doc_id),
  collectionId: String(row.collection_id),
  parentId: row.parent_id ? String(row.parent_id) : null,
  collectionName: String(row.collection_name),
  fileName: String(row.file_name),
  originalName: row.original_name ? String(row.original_name) : null,
  sourcePath: String(row.source_path),
  sourceStorageKey: row.source_storage_key
    ? String(row.source_storage_key)
    : null,
  stageDir: row.stage_dir ? String(row.stage_dir) : null,
  partsDir: row.parts_dir ? String(row.parts_dir) : null,
  resultsDir: row.results_dir ? String(row.results_dir) : null,
  manifestPath: row.manifest_path ? String(row.manifest_path) : null,
  path: String(row.path || "/"),
  mimeType: String(row.mime_type || "application/pdf"),
  baseMimeType: String(row.base_mime_type || "application/pdf"),
  fileSize: numberValue(row.file_size),
  uploadedByEmail: row.uploaded_by_email
    ? String(row.uploaded_by_email)
    : null,
  pageTitle: String(row.page_title || ""),
  metadata: (row.metadata || {}) as Record<string, unknown>,
  sourceKind: String(row.source_kind || "ingestion"),
  basePriority: numberValue(row.base_priority),
  priorityOverride:
    row.priority_override === null || row.priority_override === undefined
      ? null
      : numberValue(row.priority_override),
  effectivePriority: numberValue(row.effective_priority),
  status: String(row.status),
  totalPages: numberValue(row.total_pages),
  totalParts: numberValue(row.total_parts),
  pageChunkSize: numberValue(row.page_chunk_size),
  readyPartsCount: numberValue(row.ready_parts_count),
  submittedPartsCount: numberValue(row.submitted_parts_count),
  activePartsCount: numberValue(row.active_parts_count),
  writeAttemptCount: numberValue(row.write_attempt_count),
  availableAt: dateOrNull(row.available_at) || new Date(),
  leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
  leaseToken: row.lease_token ? String(row.lease_token) : null,
  leaseUntil: dateOrNull(row.lease_until),
  ocrActivatedAt: dateOrNull(row.ocr_activated_at),
  completedAt: dateOrNull(row.completed_at),
  errorMessage: row.error_message ? String(row.error_message) : null,
  createdAt: dateOrNull(row.created_at) || new Date(),
  updatedAt: dateOrNull(row.updated_at) || new Date(),
})

const partFromRow = (row: RawPartRow): DoclingAsyncPart => ({
  fileId: String(row.file_id),
  partIndex: numberValue(row.part_index),
  docId: String(row.doc_id),
  currentJobId: row.current_job_id ? String(row.current_job_id) : null,
  partPath: String(row.part_path),
  resultPath: row.result_path ? String(row.result_path) : null,
  startPage: numberValue(row.start_page),
  endPage: numberValue(row.end_page),
  partSizeBytes: numberValue(row.part_size_bytes),
  status: String(row.status),
  attemptCount: numberValue(row.attempt_count),
  availableAt: dateOrNull(row.available_at) || new Date(),
  submittedAt: dateOrNull(row.submitted_at),
  readyAt: dateOrNull(row.ready_at),
  writtenAt: dateOrNull(row.written_at),
  leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
  leaseUntil: dateOrNull(row.lease_until),
  submitPermitId: row.submit_permit_id
    ? String(row.submit_permit_id)
    : null,
  errorMessage: row.error_message ? String(row.error_message) : null,
  createdAt: dateOrNull(row.created_at) || new Date(),
  updatedAt: dateOrNull(row.updated_at) || new Date(),
})

const firstRow = <T>(result: { rows?: T[] } | T[]): T | null => {
  const rows = Array.isArray(result) ? result : result.rows || []
  return rows[0] || null
}

const allRows = <T>(result: { rows?: T[] } | T[]): T[] =>
  Array.isArray(result) ? result : result.rows || []

const leaseInterval = (leaseMs: number) =>
  sql.raw(`(${Math.max(leaseMs, 1)} || ' milliseconds')::interval`)

export const inferDoclingSourcePriority = (input: {
  collectionId: string
  parentId?: string | null
  metadata?: unknown
}) => {
  const metadata =
    typeof input.metadata === "object" && input.metadata !== null
      ? (input.metadata as Record<string, unknown>)
      : {}
  const explicitKind =
    typeof metadata.doclingSourceKind === "string"
      ? metadata.doclingSourceKind
      : null
  const sourceKind =
    explicitKind ||
    (input.collectionId.startsWith("attachments_") ? "attachment" : "ingestion")
  const basePriority = sourceKind === "attachment" ? 100 : 0

  return { sourceKind, basePriority }
}

export const upsertDoclingAsyncFileForSplit = async (
  input: Omit<
    NewDoclingAsyncFile,
    | "status"
    | "basePriority"
    | "effectivePriority"
    | "sourceKind"
    | "createdAt"
    | "updatedAt"
  > & {
    sourceKind?: string
    basePriority?: number
    priorityOverride?: number | null
  },
) => {
  const sourceKind = input.sourceKind || "ingestion"
  const basePriority = input.basePriority ?? 0
  const effectivePriority = input.priorityOverride ?? basePriority

  const [row] = await db
    .insert(doclingAsyncFiles)
    .values({
      ...input,
      sourceKind,
      basePriority,
      effectivePriority,
      status: DOCLING_FILE_STATUS.PendingSplit,
      availableAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing({
      target: doclingAsyncFiles.fileId,
    })
    .returning()

  return row || null
}

export const claimNextDoclingFileToSplit = async (
  workerId: string,
  leaseMs: number,
): Promise<DoclingAsyncFile | null> => {
  const leaseToken = randomUUID()
  const result = await db.execute(sql`
    UPDATE docling_async_files
    SET status = ${DOCLING_FILE_STATUS.Splitting},
        lease_owner = ${workerId},
        lease_token = ${leaseToken},
        lease_until = NOW() + ${leaseInterval(leaseMs)},
        updated_at = NOW(),
        error_message = NULL
    WHERE file_id = (
      SELECT file_id
      FROM docling_async_files
      WHERE status = ${DOCLING_FILE_STATUS.PendingSplit}
        AND available_at <= NOW()
      ORDER BY COALESCE(priority_override, base_priority) DESC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `)
  const row = firstRow<RawFileRow>(result)
  return row ? fileFromRow(row) : null
}

export const markDoclingFileSplitComplete = async (
  file: DoclingAsyncFile,
  stagedParts: DoclingStagedParts,
  resultsDir: string,
): Promise<boolean> => {
  return await db.transaction(async (tx) => {
    const [claimedFile] = await tx
      .update(doclingAsyncFiles)
      .set({
        status: DOCLING_FILE_STATUS.QueuedForOcr,
        totalPages: stagedParts.totalPages,
        totalParts: stagedParts.partsTotal,
        pageChunkSize: stagedParts.pageChunkSize,
        stageDir: stagedParts.stageDir,
        partsDir: stagedParts.partsDir,
        resultsDir,
        manifestPath: stagedParts.manifestPath,
        readyPartsCount: 0,
        submittedPartsCount: 0,
        activePartsCount: 0,
        leaseOwner: null,
        leaseToken: null,
        leaseUntil: null,
        availableAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(doclingAsyncFiles.fileId, file.fileId),
          eq(doclingAsyncFiles.status, DOCLING_FILE_STATUS.Splitting),
          sql`${doclingAsyncFiles.leaseOwner} = ${file.leaseOwner}`,
          sql`${doclingAsyncFiles.leaseToken} = ${file.leaseToken}`,
          sql`${doclingAsyncFiles.leaseUntil} IS NOT NULL AND ${doclingAsyncFiles.leaseUntil} >= NOW()`,
        ),
      )
      .returning({ fileId: doclingAsyncFiles.fileId })

    if (!claimedFile) {
      return false
    }

    await tx
      .delete(doclingAsyncParts)
      .where(eq(doclingAsyncParts.fileId, file.fileId))

    await tx.insert(doclingAsyncParts).values(
      stagedParts.parts.map((part) => ({
        fileId: file.fileId,
        partIndex: part.partIndex,
        docId: part.partDocId,
        partPath: part.partPath,
        startPage: part.startPage,
        endPage: part.endPage,
        partSizeBytes: part.partSizeBytes,
        status: DOCLING_PART_STATUS.Queued,
        availableAt: new Date(),
      })),
    )

    return true
  })
}

export const markDoclingFileSplitRetry = async (
  file: DoclingAsyncFile,
  errorMessage: string,
  availableAt: Date,
) => {
  const [row] = await db
    .update(doclingAsyncFiles)
    .set({
      status: DOCLING_FILE_STATUS.PendingSplit,
      availableAt,
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      errorMessage,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(doclingAsyncFiles.fileId, file.fileId),
        eq(doclingAsyncFiles.status, DOCLING_FILE_STATUS.Splitting),
        sql`${doclingAsyncFiles.leaseOwner} = ${file.leaseOwner}`,
        sql`${doclingAsyncFiles.leaseToken} = ${file.leaseToken}`,
        sql`${doclingAsyncFiles.leaseUntil} IS NOT NULL AND ${doclingAsyncFiles.leaseUntil} >= NOW()`,
      ),
    )
    .returning({ fileId: doclingAsyncFiles.fileId })
  return Boolean(row)
}

export const admitDoclingOcrFiles = async (
  activeFileLimit: number,
): Promise<number> => {
  if (activeFileLimit <= 0) {
    return 0
  }

  const result = await db.execute(sql`
    WITH admit_lock AS (
      SELECT pg_try_advisory_xact_lock(hashtext('docling_ocr_file_admit')) AS locked
    ),
    capacity AS (
      SELECT GREATEST(${activeFileLimit} - COUNT(*), 0)::int AS slots
      FROM docling_async_files
      WHERE status = ${DOCLING_FILE_STATUS.OcrActive}
    ),
    selected AS (
      SELECT f.file_id
      FROM docling_async_files f, capacity c, admit_lock l
      WHERE f.status = ${DOCLING_FILE_STATUS.QueuedForOcr}
        AND f.available_at <= NOW()
        AND l.locked
        AND c.slots > 0
      ORDER BY COALESCE(f.priority_override, f.base_priority) DESC, f.created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT (SELECT slots FROM capacity)
    )
    UPDATE docling_async_files f
    SET status = ${DOCLING_FILE_STATUS.OcrActive},
        ocr_activated_at = COALESCE(f.ocr_activated_at, NOW()),
        updated_at = NOW()
    FROM selected
    WHERE f.file_id = selected.file_id
    RETURNING f.file_id
  `)

  return allRows(result).length
}

export const claimNextDoclingPartForSubmit = async (input: {
  workerId: string
  permitId: string
  leaseMs: number
  perFileInflightLimit: number
}): Promise<DoclingAsyncPart | null> => {
  const attemptToken = randomUUID()
  const result = await db.execute(sql`
    WITH selected AS (
      SELECT p.file_id, p.part_index
      FROM docling_async_parts p
      JOIN docling_async_files f ON f.file_id = p.file_id
      WHERE p.status = ${DOCLING_PART_STATUS.Queued}
        AND p.available_at <= NOW()
        AND f.status = ${DOCLING_FILE_STATUS.OcrActive}
        AND (
          SELECT COUNT(*)
          FROM docling_async_parts active
          WHERE active.file_id = p.file_id
            AND active.status IN (${DOCLING_PART_STATUS.Submitting}, ${DOCLING_PART_STATUS.Submitted})
        ) < ${input.perFileInflightLimit}
      ORDER BY COALESCE(f.priority_override, f.base_priority) DESC, f.created_at ASC, p.part_index ASC
      FOR UPDATE OF f, p SKIP LOCKED
      LIMIT 1
    ),
    claimed AS (
      UPDATE docling_async_parts p
      SET status = ${DOCLING_PART_STATUS.Submitting},
          attempt_count = p.attempt_count + 1,
          current_job_id = 'docling:' || p.file_id || ':part:' || p.part_index || ':attempt:' || ${attemptToken},
          lease_owner = ${input.workerId},
          lease_until = NOW() + ${leaseInterval(input.leaseMs)},
          submit_permit_id = ${input.permitId},
          error_message = NULL,
          updated_at = NOW()
      FROM selected
      WHERE p.file_id = selected.file_id
        AND p.part_index = selected.part_index
      RETURNING p.*
    ),
    bumped AS (
      UPDATE docling_async_files f
      SET active_parts_count = f.active_parts_count + 1,
          updated_at = NOW()
      FROM claimed
      WHERE f.file_id = claimed.file_id
      RETURNING f.file_id
    )
    SELECT * FROM claimed
  `)

  const row = firstRow<RawPartRow>(result)
  return row ? partFromRow(row) : null
}

export const markDoclingPartSubmitted = async (
  fileId: string,
  partIndex: number,
  jobId: string,
) => {
  await db
    .update(doclingAsyncParts)
    .set({
      status: DOCLING_PART_STATUS.Submitted,
      submittedAt: new Date(),
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(doclingAsyncParts.fileId, fileId),
        eq(doclingAsyncParts.partIndex, partIndex),
        eq(doclingAsyncParts.currentJobId, jobId),
        eq(doclingAsyncParts.status, DOCLING_PART_STATUS.Submitting),
      ),
    )
}

export const markDoclingPartSubmitRetry = async (input: {
  fileId: string
  partIndex: number
  jobId: string
  errorMessage: string
  availableAt: Date
}) => {
  await db.execute(sql`
    WITH reset AS (
      UPDATE docling_async_parts
      SET status = ${DOCLING_PART_STATUS.Queued},
          available_at = ${input.availableAt},
          lease_owner = NULL,
          lease_until = NULL,
          submit_permit_id = NULL,
          error_message = ${input.errorMessage},
          updated_at = NOW()
      WHERE file_id = ${input.fileId}
        AND part_index = ${input.partIndex}
        AND current_job_id = ${input.jobId}
        AND status IN (${DOCLING_PART_STATUS.Submitting}, ${DOCLING_PART_STATUS.Submitted})
      RETURNING file_id
    )
    UPDATE docling_async_files f
    SET active_parts_count = GREATEST(f.active_parts_count - 1, 0),
        updated_at = NOW()
    FROM reset
    WHERE f.file_id = reset.file_id
  `)
}

export const getDoclingPartByJobId = async (
  jobId: string,
): Promise<DoclingAsyncPart | null> => {
  const result = await db.execute(sql`
    SELECT *
    FROM docling_async_parts
    WHERE current_job_id = ${jobId}
    LIMIT 1
  `)
  const row = firstRow<RawPartRow>(result)
  return row ? partFromRow(row) : null
}

export const getDoclingFile = async (
  fileId: string,
): Promise<DoclingAsyncFile | null> => {
  const result = await db.execute(sql`
    SELECT *
    FROM docling_async_files
    WHERE file_id = ${fileId}
    LIMIT 1
  `)
  const row = firstRow<RawFileRow>(result)
  return row ? fileFromRow(row) : null
}

export const getDoclingPartsForFile = async (
  fileId: string,
): Promise<DoclingAsyncPart[]> => {
  const result = await db.execute(sql`
    SELECT *
    FROM docling_async_parts
    WHERE file_id = ${fileId}
    ORDER BY part_index ASC
  `)
  return allRows<RawPartRow>(result).map(partFromRow)
}

export const markDoclingPartReady = async (input: {
  fileId: string
  partIndex: number
  jobId: string
  resultPath: string
}) => {
  await db.execute(sql`
    WITH ready AS (
      UPDATE docling_async_parts
      SET status = ${DOCLING_PART_STATUS.Ready},
          result_path = ${input.resultPath},
          ready_at = NOW(),
          lease_owner = NULL,
          lease_until = NULL,
          updated_at = NOW()
      WHERE file_id = ${input.fileId}
        AND part_index = ${input.partIndex}
        AND current_job_id = ${input.jobId}
        AND status IN (${DOCLING_PART_STATUS.Submitting}, ${DOCLING_PART_STATUS.Submitted})
      RETURNING file_id
    ),
    counts AS (
      UPDATE docling_async_files f
      SET ready_parts_count = f.ready_parts_count + 1,
          active_parts_count = GREATEST(f.active_parts_count - 1, 0),
          updated_at = NOW()
      FROM ready
      WHERE f.file_id = ready.file_id
      RETURNING f.file_id, f.ready_parts_count, f.total_parts
    )
    UPDATE docling_async_files f
    SET status = ${DOCLING_FILE_STATUS.ReadyToWrite},
        available_at = NOW(),
        updated_at = NOW()
    FROM counts
    WHERE f.file_id = counts.file_id
      AND counts.ready_parts_count >= counts.total_parts
  `)
}

export const failDoclingFile = async (
  fileId: string,
  errorMessage: string,
) => {
  await db.transaction(async (tx) => {
    await tx
      .update(doclingAsyncFiles)
      .set({
        status: DOCLING_FILE_STATUS.Failed,
        leaseOwner: null,
        leaseToken: null,
        leaseUntil: null,
        errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(doclingAsyncFiles.fileId, fileId))

    await tx
      .update(doclingAsyncParts)
      .set({
        status: DOCLING_PART_STATUS.Failed,
        errorMessage,
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(doclingAsyncParts.fileId, fileId))

    await tx
      .update(collectionItems)
      .set({
        uploadStatus: UploadStatus.FAILED,
        statusMessage: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, fileId))
  })
}

export const failDoclingFileIfOwned = async (
  file: DoclingAsyncFile,
  expectedStatus: string,
  errorMessage: string,
): Promise<boolean> => {
  return await db.transaction(async (tx) => {
    const [claimedFile] = await tx
      .update(doclingAsyncFiles)
      .set({
        status: DOCLING_FILE_STATUS.Failed,
        leaseOwner: null,
        leaseToken: null,
        leaseUntil: null,
        errorMessage,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(doclingAsyncFiles.fileId, file.fileId),
          eq(doclingAsyncFiles.status, expectedStatus),
          sql`${doclingAsyncFiles.leaseOwner} = ${file.leaseOwner}`,
          sql`${doclingAsyncFiles.leaseToken} = ${file.leaseToken}`,
          sql`${doclingAsyncFiles.leaseUntil} IS NOT NULL AND ${doclingAsyncFiles.leaseUntil} >= NOW()`,
        ),
      )
      .returning({ fileId: doclingAsyncFiles.fileId })

    if (!claimedFile) {
      return false
    }

    await tx
      .update(doclingAsyncParts)
      .set({
        status: DOCLING_PART_STATUS.Failed,
        errorMessage,
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(doclingAsyncParts.fileId, file.fileId))

    await tx
      .update(collectionItems)
      .set({
        uploadStatus: UploadStatus.FAILED,
        statusMessage: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, file.fileId))

    return true
  })
}

export const claimNextDoclingFileToWrite = async (
  workerId: string,
  leaseMs: number,
): Promise<DoclingAsyncFile | null> => {
  const leaseToken = randomUUID()
  const result = await db.execute(sql`
    UPDATE docling_async_files
    SET status = ${DOCLING_FILE_STATUS.Writing},
        lease_owner = ${workerId},
        lease_token = ${leaseToken},
        lease_until = NOW() + ${leaseInterval(leaseMs)},
        write_attempt_count = write_attempt_count + 1,
        updated_at = NOW()
    WHERE file_id = (
      SELECT file_id
      FROM docling_async_files
      WHERE status = ${DOCLING_FILE_STATUS.ReadyToWrite}
        AND available_at <= NOW()
      ORDER BY COALESCE(priority_override, base_priority) DESC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `)
  const row = firstRow<RawFileRow>(result)
  return row ? fileFromRow(row) : null
}

export const markDoclingFileWriteRetry = async (
  file: DoclingAsyncFile,
  errorMessage: string,
  availableAt: Date,
) => {
  const [row] = await db
    .update(doclingAsyncFiles)
    .set({
      status: DOCLING_FILE_STATUS.ReadyToWrite,
      availableAt,
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      errorMessage,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(doclingAsyncFiles.fileId, file.fileId),
        eq(doclingAsyncFiles.status, DOCLING_FILE_STATUS.Writing),
        sql`${doclingAsyncFiles.leaseOwner} = ${file.leaseOwner}`,
        sql`${doclingAsyncFiles.leaseToken} = ${file.leaseToken}`,
        sql`${doclingAsyncFiles.leaseUntil} IS NOT NULL AND ${doclingAsyncFiles.leaseUntil} >= NOW()`,
      ),
    )
    .returning({ fileId: doclingAsyncFiles.fileId })
  return Boolean(row)
}

export const markDoclingFileCompleted = async (input: {
  fileId: string
  vespaDocId: string
  statusMessage: string
  metadata: Record<string, unknown>
  leaseOwner?: string | null
  leaseToken?: string | null
}): Promise<boolean> => {
  return await db.transaction(async (tx) => {
    const [claimedFile] = await tx
      .update(doclingAsyncFiles)
      .set({
        status: DOCLING_FILE_STATUS.Completed,
        completedAt: new Date(),
        leaseOwner: null,
        leaseToken: null,
        leaseUntil: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(doclingAsyncFiles.fileId, input.fileId),
          eq(doclingAsyncFiles.status, DOCLING_FILE_STATUS.Writing),
          sql`${doclingAsyncFiles.leaseOwner} = ${input.leaseOwner}`,
          sql`${doclingAsyncFiles.leaseToken} = ${input.leaseToken}`,
          sql`${doclingAsyncFiles.leaseUntil} IS NOT NULL AND ${doclingAsyncFiles.leaseUntil} >= NOW()`,
        ),
      )
      .returning({ fileId: doclingAsyncFiles.fileId })

    if (!claimedFile) {
      return false
    }

    await tx
      .update(collectionItems)
      .set({
        vespaDocId: input.vespaDocId,
        uploadStatus: UploadStatus.COMPLETED,
        statusMessage: input.statusMessage,
        metadata: input.metadata,
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, input.fileId))

    await tx
      .update(doclingAsyncParts)
      .set({
        status: DOCLING_PART_STATUS.Written,
        writtenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(doclingAsyncParts.fileId, input.fileId))

    return true
  })
}

export const requeueExpiredDoclingLeases = async (now = new Date()) => {
  await db.execute(sql`
    UPDATE docling_async_files
    SET status = CASE
          WHEN status = ${DOCLING_FILE_STATUS.Splitting} THEN ${DOCLING_FILE_STATUS.PendingSplit}
          WHEN status = ${DOCLING_FILE_STATUS.Writing} THEN ${DOCLING_FILE_STATUS.ReadyToWrite}
          ELSE status
        END,
        lease_owner = NULL,
        lease_token = NULL,
        lease_until = NULL,
        available_at = ${now},
        updated_at = NOW()
    WHERE status IN (${DOCLING_FILE_STATUS.Splitting}, ${DOCLING_FILE_STATUS.Writing})
      AND lease_until IS NOT NULL
      AND lease_until < NOW()
  `)

  await db.execute(sql`
    WITH expired AS (
      UPDATE docling_async_parts
      SET status = ${DOCLING_PART_STATUS.Queued},
          lease_owner = NULL,
          lease_until = NULL,
          submit_permit_id = NULL,
          available_at = ${now},
          updated_at = NOW()
      WHERE status = ${DOCLING_PART_STATUS.Submitting}
        AND lease_until IS NOT NULL
        AND lease_until < NOW()
      RETURNING file_id
    )
    UPDATE docling_async_files f
    SET active_parts_count = GREATEST(f.active_parts_count - expired_counts.count, 0),
        updated_at = NOW()
    FROM (
      SELECT file_id, COUNT(*)::int AS count
      FROM expired
      GROUP BY file_id
    ) expired_counts
    WHERE f.file_id = expired_counts.file_id
  `)
}

export const listExpiredSubmittingDoclingParts = async (
  limit: number,
): Promise<DoclingAsyncPart[]> => {
  const result = await db.execute(sql`
    SELECT *
    FROM docling_async_parts
    WHERE status = ${DOCLING_PART_STATUS.Submitting}
      AND lease_until IS NOT NULL
      AND lease_until < NOW()
      AND submit_permit_id IS NOT NULL
    ORDER BY lease_until ASC
    LIMIT ${Math.max(limit, 1)}
  `)
  return allRows<RawPartRow>(result).map(partFromRow)
}

export const listTimedOutSubmittedDoclingParts = async (
  timeoutMs: number,
  limit: number,
): Promise<DoclingAsyncPart[]> => {
  const result = await db.execute(sql`
    SELECT *
    FROM docling_async_parts
    WHERE status = ${DOCLING_PART_STATUS.Submitted}
      AND submitted_at IS NOT NULL
      AND submitted_at < NOW() - ${leaseInterval(timeoutMs)}
    ORDER BY submitted_at ASC
    LIMIT ${Math.max(limit, 1)}
  `)
  return allRows<RawPartRow>(result).map(partFromRow)
}
