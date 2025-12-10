import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { boss } from "./boss"

const logger = getLogger(Subsystem.Queue).child({
  module: "summary-generation-queue",
})

// Queue name for all summary generation jobs
export const SUMMARY_QUEUE_NAME = "summary-generation"

/**
 * Job payload for individual thread/comment summary generation
 */
export interface IndividualSummaryJob {
  type: "individual-summary"
  ticketId: string
  itemId: string // threadId or commentId
  itemText: string
  authorEmail: string
  summaryType: "thread" | "comment"
  itemIndex: number
  totalItems: number
}

/**
 * Job payload for aggregate summary generation (combine multiple individual summaries)
 */
export interface AggregateSummaryJob {
  type: "aggregate-summary"
  ticketId: string
  summaryType: "thread" | "comment"
}

/**
 * Job payload for whole resolution summary generation (final comprehensive summary)
 * Ticket data will be fetched from Vespa when processing
 */
export interface WholeResolutionSummaryJob {
  type: "whole-resolution-summary"
  ticketId: string
}

export type SummaryJob =
  | IndividualSummaryJob
  | AggregateSummaryJob
  | WholeResolutionSummaryJob

/**
 * Enqueue individual summary job for a single thread or comment
 * Called from transformer during ticket ingestion
 */
export async function enqueueIndividualSummary(
  ticketId: string,
  itemId: string,
  itemText: string,
  authorEmail: string,
  summaryType: "thread" | "comment",
  itemIndex: number,
  totalItems: number,
) {
  const job: IndividualSummaryJob = {
    type: "individual-summary",
    ticketId,
    itemId,
    itemText,
    authorEmail,
    summaryType,
    itemIndex,
    totalItems,
  }

  try {

    await boss.send(SUMMARY_QUEUE_NAME, job, {
      retryLimit: 3,
      retryDelay: 60, // 1 minute between retries
      expireInHours: 23, // Must be less than 24 hours
    })

    logger.info(`Enqueued individual ${summaryType} summary job`, {
      ticketId,
      itemId,
      itemIndex,
      totalItems,
    })
  } catch (error) {

    logger.error(`Failed to enqueue individual summary job`, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ticketId,
      itemId,
      jobPayload: job,
    })
    throw error
  }
}

/**
 * Enqueue aggregate summary job
 * Called from worker after all individual summaries for a ticket are complete
 */
export async function enqueueAggregateSummary(
  ticketId: string,
  summaryType: "thread" | "comment",
) {
  const job: AggregateSummaryJob = {
    type: "aggregate-summary",
    ticketId,
    summaryType,
  }

  try {
    await boss.send(SUMMARY_QUEUE_NAME, job, {
      retryLimit: 3,
      retryDelay: 60,
      expireInHours: 23, // Must be less than 24 hours
    })

    logger.info(`Enqueued aggregate ${summaryType} summary job`, {
      ticketId,
    })
  } catch (error) {

    logger.error(`Failed to enqueue aggregate summary job`, {
      error: error instanceof Error ? error.message : String(error),
      ticketId,
      summaryType,
    })
    throw error
  }
}

/**
 * Enqueue whole resolution summary job
 * Called from worker after aggregate summary completes
 * Ticket data will be fetched from Vespa when processing
 */
export async function enqueueWholeResolutionSummary(ticketId: string) {
  const job: WholeResolutionSummaryJob = {
    type: "whole-resolution-summary",
    ticketId,
  }

  try {
    await boss.send(SUMMARY_QUEUE_NAME, job, {
      retryLimit: 3,
      retryDelay: 60,
      expireInHours: 23, // Must be less than 24 hours
    })

    logger.info(`Enqueued whole resolution summary job`, {
      ticketId,
    })
  } catch (error) {

    logger.error(`Failed to enqueue whole resolution summary job`, {
      error: error instanceof Error ? error.message : String(error),
      ticketId,
    })
    throw error
  }
}
