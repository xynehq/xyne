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
    console.log(`\n📤 ATTEMPTING TO ENQUEUE SUMMARY JOB`)
    console.log(`Queue Name: ${SUMMARY_QUEUE_NAME}`)
    console.log(`Ticket ID: ${ticketId}`)
    console.log(`Item ID: ${itemId}`)
    console.log(`Summary Type: ${summaryType}`)
    console.log(`Boss object exists: ${!!boss}`)
    console.log(`Boss.send exists: ${boss && typeof boss.send === 'function'}`)
    console.log(`Job payload:`, JSON.stringify(job, null, 2))
    console.log(`\n`)

    await boss.send(SUMMARY_QUEUE_NAME, job, {
      retryLimit: 3,
      retryDelay: 60, // 1 minute between retries
      expireInHours: 23, // Must be less than 24 hours
    })

    console.log(`✅ SUCCESSFULLY SENT JOB TO QUEUE: ${itemId}\n`)

    logger.info(`Enqueued individual ${summaryType} summary job`, {
      ticketId,
      itemId,
      itemIndex,
      totalItems,
    })
  } catch (error) {
    console.error(`\n❌ FAILED TO ENQUEUE INDIVIDUAL SUMMARY JOB`)
    console.error(`Ticket ID: ${ticketId}`)
    console.error(`Item ID: ${itemId}`)
    console.error(`Summary Type: ${summaryType}`)
    console.error(`Error:`, error)
    console.error(`Stack:`, error instanceof Error ? error.stack : 'No stack available')
    console.error(`\n`)

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
    console.error(`\n❌ FAILED TO ENQUEUE AGGREGATE SUMMARY JOB`)
    console.error(`Ticket ID: ${ticketId}`)
    console.error(`Summary Type: ${summaryType}`)
    console.error(`Error:`, error)
    console.error(`Stack:`, error instanceof Error ? error.stack : 'No stack available')
    console.error(`\n`)

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
    console.error(`\n❌ FAILED TO ENQUEUE WHOLE RESOLUTION SUMMARY JOB`)
    console.error(`Ticket ID: ${ticketId}`)
    console.error(`Error:`, error)
    console.error(`Stack:`, error instanceof Error ? error.stack : 'No stack available')
    console.error(`\n`)

    logger.error(`Failed to enqueue whole resolution summary job`, {
      error: error instanceof Error ? error.message : String(error),
      ticketId,
    })
    throw error
  }
}
