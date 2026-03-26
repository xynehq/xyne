import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db/client"
import { resetStuckProcessingTocRowsToPending } from "@/db/knowledgeBaseToc"
import { collectionItems } from "@/db/schema"
import type { TocToolStatus } from "@/knowledgeBase/toc"
import { getLogger } from "@/logger"
import { boss } from "@/queue/api-server-queue"
import { enqueueTocGenerationJob } from "@/queue/toc-generation"
import { UploadStatus } from "@/shared/types"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"

const Logger = getLogger(Subsystem.Api).child({ module: "admin.kbToc" })

const DEFAULT_REQUEUE_STATUSES: TocToolStatus[] = ["missing", "pending", "failed"]

const dateStringSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Invalid date string",
  })

export const adminKbTocRequeueSchema = z.object({
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
  collectionIds: z.array(z.string().min(1)).optional(),
  fileIds: z.array(z.string().min(1)).optional(),
  statuses: z
    .array(
      z.enum([
        "missing",
        "pending",
        "processing",
        "failed",
        "completed",
        "not_found",
      ]),
    )
    .optional()
    .default(DEFAULT_REQUEUE_STATUSES),
  limit: z.number().int().min(1).max(500).optional().default(100),
  dryRun: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
})

type AdminKbTocRequeueInput = z.infer<typeof adminKbTocRequeueSchema>

type TocRecoverySummary = {
  fileId: string
  collectionId: string
  status: TocToolStatus
  attempts: number
  hasToc: boolean
  processedAt: Date | null
  lastError: string | null
}

const tocStatusSql = sql<TocToolStatus>`coalesce(${collectionItems.tocInfo} ->> 'status', 'missing')`
const tocAttemptsSql = sql<number>`coalesce(((${collectionItems.tocInfo} ->> 'attempts')::int), 0)`
const tocHasTocSql = sql<boolean>`${collectionItems.toc} IS NOT NULL`
const tocLastErrorSql = sql<string | null>`${collectionItems.tocInfo} ->> 'lastError'`

function buildSqlValueList(values: string[]) {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )
}

function normalizeStatuses(input: AdminKbTocRequeueInput): TocToolStatus[] {
  const deduped = Array.from(
    new Set((input.statuses?.length ? input.statuses : DEFAULT_REQUEUE_STATUSES) as TocToolStatus[]),
  )

  if (deduped.includes("processing") && !input.force) {
    throw new HTTPException(400, {
      message:
        "Requeueing rows in processing state requires `force: true` and statuses including `processing`.",
    })
  }

  return deduped.filter((status) => {
    if (status === "completed" || status === "not_found") {
      return input.force
    }
    if (status === "processing") {
      return input.force
    }
    return true
  })
}

function buildRecoveryConditions(input: AdminKbTocRequeueInput) {
  const statuses = normalizeStatuses(input)
  if (!statuses.length) {
    return { statuses, conditions: null as null | ReturnType<typeof and> }
  }

  const conditions = [
    isNull(collectionItems.deletedAt),
    eq(collectionItems.type, "file"),
    eq(collectionItems.mimeType, "application/pdf"),
    eq(collectionItems.uploadStatus, UploadStatus.COMPLETED),
    sql`${tocStatusSql} IN (${buildSqlValueList(statuses)})`,
  ]

  if (input.collectionIds?.length) {
    conditions.push(inArray(collectionItems.collectionId, input.collectionIds))
  }

  if (input.fileIds?.length) {
    conditions.push(inArray(collectionItems.id, input.fileIds))
  }

  if (input.from || input.to) {
    const datedConditions = [isNotNull(collectionItems.processedAt)]
    if (input.from) {
      datedConditions.push(gte(collectionItems.processedAt, new Date(input.from)))
    }
    if (input.to) {
      datedConditions.push(lte(collectionItems.processedAt, new Date(input.to)))
    }

    const rangedProcessedAtCondition = and(...datedConditions)!
    if (input.fileIds?.length) {
      conditions.push(
        or(isNull(collectionItems.processedAt), rangedProcessedAtCondition)!,
      )
    } else {
      conditions.push(rangedProcessedAtCondition)
    }
  }

  return { statuses, conditions: and(...conditions) }
}

function summarizeRecoveryRows(
  rows: Array<{
    fileId: string
    collectionId: string
    status: TocToolStatus
    attempts: number
    hasToc: boolean
    processedAt: Date | null
    lastError: string | null
  }>,
): TocRecoverySummary[] {
  return rows.map((row) => ({
    fileId: row.fileId,
    collectionId: row.collectionId,
    status: row.status,
    attempts: row.attempts,
    hasToc: row.hasToc,
    processedAt: row.processedAt,
    lastError: row.lastError,
  }))
}

export const AdminKbTocRequeueApi = async (c: Context) => {
  const input = adminKbTocRequeueSchema.parse(await c.req.json())
  const { conditions } = buildRecoveryConditions(input)

  if (!conditions) {
    return c.json({
      dryRun: input.dryRun,
      matchedCount: 0,
      enqueuedCount: 0,
      items: [],
    })
  }

  const rows = await db
    .select({
      fileId: collectionItems.id,
      collectionId: collectionItems.collectionId,
      status: tocStatusSql.as("status"),
      attempts: tocAttemptsSql.as("attempts"),
      hasToc: tocHasTocSql.as("has_toc"),
      processedAt: collectionItems.processedAt,
      lastError: tocLastErrorSql.as("last_error"),
    })
    .from(collectionItems)
    .where(conditions)
    .orderBy(asc(collectionItems.processedAt), asc(collectionItems.id))
    .limit(input.limit)

  const items = summarizeRecoveryRows(rows)

  if (input.dryRun) {
    return c.json({
      dryRun: true,
      matchedCount: items.length,
      items,
    })
  }

  const processingFileIds = items
    .filter((item) => item.status === "processing")
    .map((item) => item.fileId)

  if (processingFileIds.length) {
    await resetStuckProcessingTocRowsToPending(db, processingFileIds)
  }

  const enqueueErrors: Array<{ fileId: string; error: string }> = []
  let enqueuedCount = 0

  for (const item of items) {
    try {
      await enqueueTocGenerationJob(boss, {
        fileId: item.fileId,
        force: input.force,
      })
      enqueuedCount += 1
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      enqueueErrors.push({ fileId: item.fileId, error: errorMessage })
      Logger.error(
        error,
        `Failed to enqueue TOC recovery job for file ${item.fileId}: ${errorMessage}`,
      )
    }
  }

  return c.json({
    dryRun: false,
    matchedCount: items.length,
    enqueuedCount,
    items,
    enqueueErrors,
  })
}
