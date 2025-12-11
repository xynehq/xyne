import { db } from "./client"
import { threadSummaries, ticketAggregatedSummaries } from "./schema/summaries"
import { eq, and } from "drizzle-orm"

/**
 * Insert a new individual thread/comment summary record
 * Called when enqueueing jobs during ticket ingestion
 * Uses onConflictDoNothing to prevent duplicates on retries
 */
export async function insertIndividualSummary(data: {
  ticketId: string
  itemId: string
  itemIndex: number
  itemText: string
  totalItems: number
  summaryType: "thread" | "comment"
}) {
  return await db
    .insert(threadSummaries)
    .values({
      ticketId: data.ticketId,
      itemId: data.itemId,
      itemIndex: data.itemIndex,
      itemText: data.itemText,
      summaryText: null,
      totalItems: data.totalItems,
      summaryType: data.summaryType,
      processingStatus: "pending",
    })
    .onConflictDoNothing()
    .returning()
}

/**
 * Update individual summary with LLM-generated text
 * Called by worker after LLM returns summary
 */
export async function updateIndividualSummary(
  ticketId: string,
  itemId: string,
  summaryType: "thread" | "comment",
  summaryText: string,
  status: "completed" | "failed",
  errorMessage?: string,
) {
  return await db
    .update(threadSummaries)
    .set({
      summaryText,
      processingStatus: status,
      errorMessage: errorMessage || null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(threadSummaries.ticketId, ticketId),
        eq(threadSummaries.itemId, itemId),
        eq(threadSummaries.summaryType, summaryType),
      ),
    )
    .returning()
}

/**
 * Get count of completed summaries for a ticket
 * Used to check if all threads/comments are done
 */
export async function getCompletedCount(
  ticketId: string,
  summaryType: "thread" | "comment",
): Promise<{ completed: number; total: number }> {
  const results = await db
    .select()
    .from(threadSummaries)
    .where(
      and(
        eq(threadSummaries.ticketId, ticketId),
        eq(threadSummaries.summaryType, summaryType),
      ),
    )

  const completed = results.filter(
    (r) => r.processingStatus === "completed",
  ).length
  const total = results[0]?.totalItems || 0

  return { completed, total }
}

/**
 * Get all individual summaries for a ticket (for aggregation)
 * Returns summaries ordered by itemIndex
 */
export async function getAllIndividualSummaries(
  ticketId: string,
  summaryType: "thread" | "comment",
) {
  return await db
    .select()
    .from(threadSummaries)
    .where(
      and(
        eq(threadSummaries.ticketId, ticketId),
        eq(threadSummaries.summaryType, summaryType),
        eq(threadSummaries.processingStatus, "completed"),
      ),
    )
    .orderBy(threadSummaries.itemIndex)
}

/**
 * Insert aggregate summary record
 * Called when all individual summaries are done
 */
export async function insertAggregateSummary(
  ticketId: string,
  summaryType: "thread" | "comment" | "whole-resolution",
) {
  return await db
    .insert(ticketAggregatedSummaries)
    .values({
      ticketId,
      summaryType,
      finalSummary: null,
      processingStatus: "pending",
    })
    .onConflictDoNothing()
    .returning()
}

/**
 * Update aggregate summary with final text
 * Called after LLM generates aggregated summary
 */
export async function updateAggregateSummary(
  ticketId: string,
  summaryType: "thread" | "comment" | "whole-resolution",
  finalSummary: string,
  status: "completed" | "failed",
  errorMessage?: string,
) {
  return await db
    .update(ticketAggregatedSummaries)
    .set({
      finalSummary,
      processingStatus: status,
      errorMessage: errorMessage || null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(ticketAggregatedSummaries.ticketId, ticketId),
        eq(ticketAggregatedSummaries.summaryType, summaryType),
      ),
    )
    .returning()
}

/**
 * Get specific aggregate summary
 */
export async function getAggregateSummary(
  ticketId: string,
  summaryType: "thread" | "comment" | "whole-resolution",
) {
  const results = await db
    .select()
    .from(ticketAggregatedSummaries)
    .where(
      and(
        eq(ticketAggregatedSummaries.ticketId, ticketId),
        eq(ticketAggregatedSummaries.summaryType, summaryType),
      ),
    )
  return results[0] || null
}

/**
 * Check if both thread and comment aggregates are complete
 * Used to determine when to trigger whole-resolution summary
 * Returns object with status of each aggregate type
 */
export async function checkAggregatesComplete(
  ticketId: string,
  hasThreads: boolean,
  hasComments: boolean,
): Promise<{
  threadComplete: boolean
  commentComplete: boolean
  readyForWholeResolution: boolean
}> {
  const threadAggregate = hasThreads
    ? await getAggregateSummary(ticketId, "thread")
    : null
  const commentAggregate = hasComments
    ? await getAggregateSummary(ticketId, "comment")
    : null

  const threadComplete =
    !hasThreads || threadAggregate?.processingStatus === "completed"
  const commentComplete =
    !hasComments || commentAggregate?.processingStatus === "completed"

  return {
    threadComplete,
    commentComplete,
    readyForWholeResolution: threadComplete && commentComplete,
  }
}

/**
 * Delete all summaries for a ticket
 * Called after successful Vespa update to cleanup
 */
export async function deleteTicketSummaries(ticketId: string) {
  // Delete individual summaries
  await db.delete(threadSummaries).where(eq(threadSummaries.ticketId, ticketId))

  // Delete aggregated summaries
  await db
    .delete(ticketAggregatedSummaries)
    .where(eq(ticketAggregatedSummaries.ticketId, ticketId))
}

/**
 * Get all aggregate summaries for a ticket
 * Used when generating whole resolution summary
 */
export async function getAllAggregateSummaries(ticketId: string) {
  return await db
    .select()
    .from(ticketAggregatedSummaries)
    .where(eq(ticketAggregatedSummaries.ticketId, ticketId))
}
