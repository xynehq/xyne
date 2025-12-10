import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { boss } from "@/queue"
import {
  SUMMARY_QUEUE_NAME,
  type SummaryJob,
  type IndividualSummaryJob,
  type AggregateSummaryJob,
  type WholeResolutionSummaryJob,
  enqueueAggregateSummary,
  enqueueWholeResolutionSummary,
} from "@/queue/summary-generation"
import {
  insertIndividualSummary,
  updateIndividualSummary,
  getCompletedCount,
  getAllIndividualSummaries,
  insertAggregateSummary,
  updateAggregateSummary,
  getAggregateSummary,
  checkAggregatesComplete,
  getAllAggregateSummaries,
  deleteTicketSummaries,
} from "@/db/summaries"
import {
  generateIndividualSummary,
  generateAggregateSummary,
  generateWholeResolutionSummary,
} from "@/ai/provider/summary"
import { UpdateDocument, GetDocument } from "@/search/vespa"
import { db } from "@/db/client"
import { threadSummaries } from "@/db/schema/summaries"
import { eq } from "drizzle-orm"

const logger = getLogger(Subsystem.Worker).child({
  module: "summary-worker",
})

/**
 * Handle individual thread/comment summary generation
 * Steps:
 * 1. Insert record in DB
 * 2. Call LLM to generate summary
 * 3. Update DB with summary
 * 4. Check if all items done → trigger aggregate
 */
async function handleIndividualSummary(job: IndividualSummaryJob) {
  const {
    ticketId,
    itemId,
    itemText,
    authorEmail,
    summaryType,
    itemIndex,
    totalItems,
  } = job

  logger.info(`Processing individual ${summaryType} summary`, {
    ticketId,
    itemId,
    itemIndex,
    totalItems,
  })

  try {
    // Step 1: Insert record in DB
    logger.debug(`Inserting individual ${summaryType} summary record in DB`, {
      ticketId,
      itemId,
      itemIndex,
      totalItems,
      textLength: itemText.length,
    })

    await insertIndividualSummary({
      ticketId,
      itemId,
      itemIndex,
      itemText,
      totalItems,
      summaryType,
    })

    logger.debug(`DB record inserted for individual ${summaryType} summary`, {
      ticketId,
      itemId,
    })

    // Step 2: Generate summary using LLM
    const summaryText = await generateIndividualSummary(
      itemText,
      authorEmail,
      summaryType
    )

    // Step 3: Update DB with generated summary
    await updateIndividualSummary(
      ticketId,
      itemId,
      summaryType,
      summaryText,
      "completed",
    )

    logger.info(`Successfully generated individual ${summaryType} summary`, {
      ticketId,
      itemId,
      summaryLength: summaryText.length,
    })

    // Step 4: Check if all items are done
    const { completed, total } = await getCompletedCount(ticketId, summaryType)

    logger.info(`Progress check for ${summaryType} summaries`, {
      ticketId,
      itemId,
      itemIndex,
      completed,
      total,
      progress: `${completed}/${total}`,
    })

    if (completed === total && total > 0) {
      // All items done! Trigger aggregate summary
      logger.info(
        `✅ All ${summaryType} summaries complete, enqueueing aggregate`,
        {
          ticketId,
          total,
          summaryType,
        },
      )

      await enqueueAggregateSummary(ticketId, summaryType)

      logger.info(
        `Successfully enqueued aggregate ${summaryType} summary job`,
        {
          ticketId,
        },
      )
    } else {
      logger.info(`Waiting for more ${summaryType} summaries to complete`, {
        ticketId,
        remaining: total - completed,
      })
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)

    logger.error(`Failed to process individual ${summaryType} summary`, {
      error: errorMessage,
      ticketId,
      itemId,
    })

    // Update DB with failed status
    await updateIndividualSummary(
      ticketId,
      itemId,
      summaryType,
      "",
      "failed",
      errorMessage,
    )

    throw error
  }
}

/**
 * Handle aggregate summary generation
 * Steps:
 * 1. Fetch all individual summaries
 * 2. Call LLM to combine them
 * 3. Store aggregate summary
 * 4. Check if both thread AND comment done → trigger whole resolution
 */
async function handleAggregateSummary(job: AggregateSummaryJob) {
  const { ticketId, summaryType } = job

  logger.info(`Processing aggregate ${summaryType} summary`, {
    ticketId,
  })

  try {
    // Step 1: Insert aggregate record (marks as pending)
    await insertAggregateSummary(ticketId, summaryType)

    // Step 2: Fetch all individual summaries
    const individualSummaries = await getAllIndividualSummaries(
      ticketId,
      summaryType,
    )

    if (individualSummaries.length === 0) {
      throw new Error(
        `No completed individual summaries found for ${summaryType}`,
      )
    }

    logger.info(`Fetched ${individualSummaries.length} individual summaries`, {
      ticketId,
      summaryType,
    })

    // Step 3: Generate aggregated summary using LLM
    const aggregatedSummary = await generateAggregateSummary(
      individualSummaries.map((s) => ({
        itemIndex: s.itemIndex,
        summaryText: s.summaryText || "",
      })),
      summaryType,
      ticketId
    )

    // Step 4: Update DB with aggregated summary
    await updateAggregateSummary(
      ticketId,
      summaryType,
      aggregatedSummary,
      "completed",
    )

    logger.info(`Successfully generated aggregate ${summaryType} summary`, {
      ticketId,
      summaryLength: aggregatedSummary.length,
    })

    // Determine what types of summaries exist for this ticket by checking DB
    const allIndividualSummaries = await db
      .select()
      .from(threadSummaries)
      .where(eq(threadSummaries.ticketId, ticketId))

    const hasThreads = allIndividualSummaries.some(
      (s) => s.summaryType === "thread",
    )
    const hasComments = allIndividualSummaries.some(
      (s) => s.summaryType === "comment",
    )

    logger.info(`Checking aggregate completion status`, {
      ticketId,
      hasThreads,
      hasComments,
      justCompleted: summaryType,
    })

    const { readyForWholeResolution, threadComplete, commentComplete } =
      await checkAggregatesComplete(ticketId, hasThreads, hasComments)

    if (readyForWholeResolution) {


      logger.info(
        `✅ All required aggregates complete, enqueueing whole resolution`,
        {
          ticketId,
          threadComplete,
          commentComplete,
        },
      )

      await enqueueWholeResolutionSummary(ticketId)

      logger.info(`Successfully enqueued whole resolution summary job`, {
        ticketId,
      })
    } else {

      logger.info(
        `Waiting for other aggregate to complete before whole resolution`,
        {
          ticketId,
          completedType: summaryType,
          threadComplete,
          commentComplete,
          hasThreads,
          hasComments,
        },
      )
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(`Failed to process aggregate ${summaryType} summary`, {
      error: errorMessage,
      ticketId,
    })

    // Update DB with failed status
    await updateAggregateSummary(
      ticketId,
      summaryType,
      "",
      "failed",
      errorMessage,
    )

    throw error
  }
}

/**
 * Handle whole resolution summary generation
 * Steps:
 * 1. Fetch ticket data from Vespa
 * 2. Fetch thread and comment aggregates
 * 3. Call LLM to create comprehensive summary
 * 4. Update Vespa with all three summaries
 * 5. Delete all summary records (cleanup)
 */
async function handleWholeResolutionSummary(job: WholeResolutionSummaryJob) {
  const { ticketId } = job

  logger.info(`Processing whole resolution summary`, {
    ticketId,
  })

  try {
    // Step 1: Check if already processed (idempotency check)
    const existingWholeResolution = await getAggregateSummary(
      ticketId,
      "whole-resolution",
    )
    if (
      existingWholeResolution &&
      existingWholeResolution.processingStatus === "completed"
    ) {
      logger.info(
        `Whole resolution summary already completed, skipping duplicate job`,
        {
          ticketId,
        },
      )
      return // Exit early - already done
    }

    // Step 2: Insert record (or update if pending/failed)
    await insertAggregateSummary(ticketId, "whole-resolution")

    // Step 2: Fetch ticket data from Vespa

    const vespaTicketDoc = await GetDocument("ticket" as any, ticketId)

    if (!vespaTicketDoc) {
      throw new Error(`Ticket not found in Vespa: ${ticketId}`)
    }

    const vespaTicket = vespaTicketDoc.fields as any

    const ticketData = {
      ticketNumber: vespaTicket.ticketNumber || "",
      subject: vespaTicket.subject || "",
      description: vespaTicket.description || "",
      status: vespaTicket.status || "",
      priority: vespaTicket.priority || "",
      department: vespaTicket.departmentName,
      requester: vespaTicket.contactEmail,
      assignee: vespaTicket.assigneeEmail,
      createdTime: vespaTicket.createdTime || "",
      modifiedTime: vespaTicket.modifiedTime || "",
      closedTime: vespaTicket.closedTime,
      resolution: vespaTicket.resolution,
    }

    // Step 3: Fetch aggregate summaries
    const allAggregates = await getAllAggregateSummaries(ticketId)
    const threadAggregate = allAggregates.find(
      (a) => a.summaryType === "thread",
    )
    const commentAggregate = allAggregates.find(
      (a) => a.summaryType === "comment",
    )

    logger.info(`Fetched aggregate summaries`, {
      ticketId,
      hasThreadAggregate: !!threadAggregate?.finalSummary,
      hasCommentAggregate: !!commentAggregate?.finalSummary,
    })

    // Step 4: Generate whole resolution summary
    const wholeResolutionSummary = await generateWholeResolutionSummary(
      {
        ticketId,
        ...ticketData,
      },
      threadAggregate?.finalSummary || undefined,
      commentAggregate?.finalSummary || undefined,
    )

    // Step 5: Update DB with whole resolution summary
    await updateAggregateSummary(
      ticketId,
      "whole-resolution",
      wholeResolutionSummary,
      "completed",
    )

    logger.info(`Successfully generated whole resolution summary`, {
      ticketId,
      summaryLength: wholeResolutionSummary.length,
    })

    // Step 6: Update Vespa with all three summaries
    const vespaUpdate: any = {
      wholeResolutionSummary,
    }

    if (threadAggregate?.finalSummary) {
      vespaUpdate.threadSummary = threadAggregate.finalSummary
    }

    if (commentAggregate?.finalSummary) {
      vespaUpdate.commentSummary = commentAggregate.finalSummary
    }

    logger.info(`Updating Vespa document with summaries`, {
      ticketId,
      hasThreadSummary: !!vespaUpdate.threadSummary,
      hasCommentSummary: !!vespaUpdate.commentSummary,
      hasWholeResolutionSummary: !!vespaUpdate.wholeResolutionSummary,
      threadSummaryLength: vespaUpdate.threadSummary?.length || 0,
      commentSummaryLength: vespaUpdate.commentSummary?.length || 0,
      wholeResolutionSummaryLength:
        vespaUpdate.wholeResolutionSummary?.length || 0,
    })
    await UpdateDocument("ticket" as any, ticketId, vespaUpdate)

    logger.info(`Successfully updated Vespa`, {
      ticketId,
    })

    // Step 7: Cleanup - delete all summary records from DB
    await deleteTicketSummaries(ticketId)

    logger.info(`Cleaned up summary records from DB`, {
      ticketId,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(`Failed to process whole resolution summary`, {
      error: errorMessage,
      ticketId,
    })

    // Update DB with failed status (don't cleanup on failure)
    await updateAggregateSummary(
      ticketId,
      "whole-resolution",
      "",
      "failed",
      errorMessage,
    )

    throw error
  }
}

/**
 * Main worker function - routes jobs to appropriate handler
 */
export async function startSummaryWorker() {
  logger.info("Starting summary generation worker")

  await boss.work(
    SUMMARY_QUEUE_NAME,
    {
      batchSize: 5, // Process 5 jobs concurrently
    },
    async (jobs) => {
      // Process all jobs in parallel
      await Promise.all(
        jobs.map(async (job) => {
          const payload = job.data as SummaryJob

          logger.info(`Received summary job`, {
            type: payload.type,
            ticketId: payload.ticketId,
          })

          try {
            switch (payload.type) {
              case "individual-summary":
                await handleIndividualSummary(payload)
                break

              case "aggregate-summary":
                await handleAggregateSummary(payload)
                break

              case "whole-resolution-summary":
                await handleWholeResolutionSummary(payload)
                break

              default:
                logger.error("Unknown job type", {
                  type: (payload as any).type,
                })
                throw new Error(`Unknown job type: ${(payload as any).type}`)
            }

            logger.info(`Successfully completed summary job`, {
              type: payload.type,
              ticketId: payload.ticketId,
            })
          } catch (error) {
            logger.error(`Failed to process summary job`, {
              type: payload.type,
              ticketId: payload.ticketId,
              error: error instanceof Error ? error.message : String(error),
            })
            throw error // Re-throw to trigger retry
          }
        }),
      )
    },
  )

  logger.info("Summary worker started successfully")
}
