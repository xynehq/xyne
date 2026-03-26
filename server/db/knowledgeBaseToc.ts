import { collectionItems, type CollectionItem } from "@/db/schema"
import type { Toc, TocInfo } from "@/knowledgeBase/toc"
import type { TxnOrClient } from "@/types"
import { UploadStatus } from "@/shared/types"
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm"

const TOC_CLAIMABLE_STATUSES = ["pending", "failed"] as const
const TOC_FORCE_CLAIMABLE_STATUSES = [ // normally immutable, but force=true allows regeneration/another attempt
  ...TOC_CLAIMABLE_STATUSES,
  "completed",
  "not_found",
] as const

// Builds the conditional SQL that decides whether a TOC row is eligible to be claimed.
function buildClaimEligibilitySql(force: boolean) {
  const statuses = force
    ? TOC_FORCE_CLAIMABLE_STATUSES
    : TOC_CLAIMABLE_STATUSES

  return sql`(
    ${collectionItems.tocInfo} IS NULL
    OR (${collectionItems.tocInfo} ->> 'status') IN (${sql.join(
      statuses.map((status) => sql`${status}`),
      sql`, `,
    )})
  )`
}

// Builds the canonical tocInfo JSONB payload while allowing SQL expressions for dynamic fields.
function buildTocInfoSql(
  status: TocInfo["status"],
  attemptsSql: SQL,
  lastError: string | null | SQL,
) {
  const statusSql = sql`${status}::text`
  const normalizedAttemptsSql = sql`(${attemptsSql})::int`
  const lastErrorSql =
    typeof lastError === "string" || lastError === null
      ? sql`${lastError}::text`
      : lastError

  return sql`jsonb_build_object(
    'status', ${statusSql},
    'attempts', ${normalizedAttemptsSql},
    'lastError', ${lastErrorSql}
  )`
}

export const __knowledgeBaseTocInternals = {
  buildTocInfoSql,
}

// Fetches the current collection_items row so callers can inspect the stored TOC state.
export async function getCollectionItemTocRecord(
  trx: TxnOrClient,
  fileId: string,
): Promise<CollectionItem | null> {
  const [row] = await trx
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.id, fileId))

  return row ?? null
}

// Atomically claims an eligible PDF row for TOC work and flips tocInfo into processing.
export async function claimCollectionItemTocProcessing(
  trx: TxnOrClient,
  fileId: string,
  force: boolean,
): Promise<CollectionItem | null> {
  const [row] = await trx
    .update(collectionItems)
    .set({
      tocInfo: buildTocInfoSql(
        "processing",
        sql`COALESCE(((${collectionItems.tocInfo} ->> 'attempts')::int), 0) + 1`,
        null,
      ),
      updatedAt: sql`NOW()`,
    })
    .where(
      and(
        eq(collectionItems.id, fileId),
        isNull(collectionItems.deletedAt),
        eq(collectionItems.type, "file"),
        eq(collectionItems.mimeType, "application/pdf"),
        eq(collectionItems.uploadStatus, UploadStatus.COMPLETED),
        buildClaimEligibilitySql(force),
      ),
    )
    .returning()

  return row ?? null
}

// Persists a retryable TOC failure by clearing toc and storing a pending tocInfo payload.
export async function setCollectionItemTocPending(
  trx: TxnOrClient,
  fileId: string,
  attempts: number,
  lastError: string | null,
): Promise<void> {
  await trx
    .update(collectionItems)
    .set({
      toc: null,
      tocInfo: buildTocInfoSql("pending", sql`${attempts}`, lastError),
      updatedAt: sql`NOW()`,
    })
    .where(eq(collectionItems.id, fileId))
}

// Persists a terminal TOC failure by clearing toc and storing a failed tocInfo payload.
export async function setCollectionItemTocProcessingFailed(
  trx: TxnOrClient,
  fileId: string,
  attempts: number,
  lastError: string | null,
): Promise<void> {
  await trx
    .update(collectionItems)
    .set({
      toc: null,
      tocInfo: buildTocInfoSql("failed", sql`${attempts}`, lastError),
      updatedAt: sql`NOW()`,
    })
    .where(eq(collectionItems.id, fileId))
}

// Persists a completed TOC extraction with the final TOC array and completed status.
export async function setCollectionItemTocCompleted(
  trx: TxnOrClient,
  fileId: string,
  attempts: number,
  toc: Exclude<Toc, null>,
): Promise<void> {
  await trx
    .update(collectionItems)
    .set({
      toc,
      tocInfo: buildTocInfoSql("completed", sql`${attempts}`, null),
      updatedAt: sql`NOW()`,
    })
    .where(eq(collectionItems.id, fileId))
}

// Persists the not_found outcome when TOC extraction succeeds but yields no usable TOC.
export async function setCollectionItemTocNotFound(
  trx: TxnOrClient,
  fileId: string,
  attempts: number,
): Promise<void> {
  await trx
    .update(collectionItems)
    .set({
      toc: null,
      tocInfo: buildTocInfoSql("not_found", sql`${attempts}`, null),
      updatedAt: sql`NOW()`,
    })
    .where(eq(collectionItems.id, fileId))
}

// Resets both TOC columns back to null, typically when ingestion completes or is restarted.
export async function resetCollectionItemTocState(
  trx: TxnOrClient,
  fileId: string,
): Promise<void> {
  await trx
    .update(collectionItems)
    .set({
      toc: null,
      tocInfo: null,
      updatedAt: sql`NOW()`,
    })
    .where(eq(collectionItems.id, fileId))
}

// Marks a row as queued for TOC generation only if it does not already have TOC state.
export async function markCollectionItemTocEnqueued(
  trx: TxnOrClient,
  fileId: string,
): Promise<void> {
  await trx
    .update(collectionItems)
    .set({
      toc: null,
      tocInfo: buildTocInfoSql("pending", sql`0`, null),
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(collectionItems.id, fileId), isNull(collectionItems.tocInfo)))
}

// Records a TOC enqueue failure without touching any primary ingestion fields.
export async function markCollectionItemTocEnqueueFailed(
  trx: TxnOrClient,
  fileId: string,
  lastError: string | null,
): Promise<void> {
  await trx
    .update(collectionItems)
    .set({
      toc: null,
      tocInfo: buildTocInfoSql("failed", sql`0`, lastError),
      updatedAt: sql`NOW()`,
    })
    .where(eq(collectionItems.id, fileId))
}

// Resets explicitly selected stuck processing rows back to pending for admin-driven recovery.
export async function resetStuckProcessingTocRowsToPending(
  trx: TxnOrClient,
  fileIds: string[],
): Promise<void> {
  if (!fileIds.length) {
    return
  }

  await trx
    .update(collectionItems)
    .set({
      tocInfo: buildTocInfoSql(
        "pending",
        sql`COALESCE(((${collectionItems.tocInfo} ->> 'attempts')::int), 0)`,
        sql`(${collectionItems.tocInfo} ->> 'lastError')`,
      ),
      updatedAt: sql`NOW()`,
    })
    .where(
      and(
        inArray(collectionItems.id, fileIds),
        sql`${collectionItems.tocInfo} IS NOT NULL`,
        sql`${collectionItems.tocInfo} ->> 'status' = 'processing'`,
      ),
    )
}
