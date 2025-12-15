import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { getProviderByModel } from "@/ai/provider"
import config from "@/config"

const logger = getLogger(Subsystem.Integrations).child({
  module: "summary-service",
})

/**
 * Generate summary for a single thread or comment
 * Minimum 80-100 words to capture sufficient detail
 */
export async function generateIndividualSummary(
  itemText: string,
  authorEmail: string,
  itemType: "thread" | "comment",
): Promise<string> {
  const prompt = `Summarize this support ticket ${itemType} message in 80-100 words (minimum).

Author: ${authorEmail}

Message:
${itemText}

Include in your summary:
- Who wrote this message
- Main issue, question, or response
- Important details, context, or data mentioned
- Any specific requests, actions, or next steps

Be comprehensive - capture all important information. Write in third person (e.g., "Customer reported that...", "Agent explained that...").`

  try {
    logger.info(`Generating individual ${itemType} summary`, {
      textLength: itemText.length,
    })

    const { text: response } = await getProviderByModel(
      config.defaultBestModel,
    ).converse(
      [
        {
          role: "user",
          content: [{ text: prompt }],
        },
      ],
      {
        modelId: config.defaultBestModel,
        max_new_tokens: 350, // ~150-200 words max
        temperature: 0.3, // Lower temperature for consistent summaries
        stream: false,
        json: false,
      },
    )

    // Check if LLM returned a valid response
    if (!response) {
      throw new Error("LLM returned no text for summary generation")
    }

    logger.info(`Successfully generated ${itemType} summary`, {
      summaryLength: response.length,
    })

    return response.trim()
  } catch (error) {
    const errorObj = error as Error
    logger.error(`Failed to generate ${itemType} summary`, {
      error: errorObj.message,
    })

    throw new Error(
      `Failed to generate ${itemType} summary: ${errorObj.message}`,
    )
  }
}

/**
 * Generate aggregated summary from multiple individual summaries
 * Combines all thread or comment summaries into cohesive narrative
 */
export async function generateAggregateSummary(
  individualSummaries: Array<{ itemIndex: number; summaryText: string }>,
  summaryType: "thread" | "comment",
  ticketId: string,
): Promise<string> {
  // Combine summaries in order
  const combinedText = individualSummaries
    .sort((a, b) => a.itemIndex - b.itemIndex)
    .map(
      (s, idx) =>
        `${summaryType === "thread" ? "Thread" : "Comment"} ${idx + 1}:\n${s.summaryText}`,
    )
    .join("\n\n")

  const prompt = `Create a comprehensive summary of this entire support ticket ${summaryType === "thread" ? "conversation" : "internal comments"}.

Below are summaries of individual ${summaryType === "thread" ? "thread messages" : "agent comments"}. Combine them into a cohesive narrative.

${combinedText}

Create a summary that includes:
${
  summaryType === "thread"
    ? `- How the conversation started (initial problem/question)
- Key developments and responses throughout the conversation
- Important details, decisions, or commitments made
- Current status or latest update`
    : `- Key observations and notes from the support team
- Actions taken or planned
- Important internal context or decisions
- Current handling status`
}

Format as 2-4 well-structured paragraphs. Maintain chronological flow.`

  try {
    logger.info(`Generating aggregate ${summaryType} summary`, {
      ticketId,
      individualCount: individualSummaries.length,
    })

    const { text: response } = await getProviderByModel(
      config.defaultBestModel,
    ).converse(
      [
        {
          role: "user",
          content: [{ text: prompt }],
        },
      ],
      {
        modelId: config.defaultBestModel,
        max_new_tokens: 1000, // Allow longer aggregated summaries
        temperature: 0.3,
        stream: false,
        json: false,
      },
    )

    // Check if LLM returned a valid response
    if (!response) {
      throw new Error("LLM returned no text for aggregate summary generation")
    }

    logger.info(`Successfully generated aggregate ${summaryType} summary`, {
      ticketId,
      summaryLength: response.length,
    })

    return response.trim()
  } catch (error) {
    const errorObj = error as Error
    logger.error(`Failed to generate aggregate ${summaryType} summary`, {
      error: errorObj.message,
      ticketId,
    })

    throw new Error(
      `Failed to generate aggregate ${summaryType} summary: ${errorObj.message}`,
    )
  }
}

/**
 * Generate comprehensive whole resolution summary
 * Combines ticket metadata, thread summary, and comment summary
 */
export async function generateWholeResolutionSummary(
  ticketData: {
    ticketId: string
    ticketNumber: string
    subject: string
    description: string
    status: string
    priority: string
    department?: string
    requester?: string
    assignee?: string
    createdTime: string
    modifiedTime: string
    closedTime?: string
    resolution?: string
  },
  threadAggregate?: string,
  commentAggregate?: string,
): Promise<string> {
  const metadataSection = `Ticket #${ticketData.ticketNumber}: ${ticketData.subject}
Status: ${ticketData.status}
Priority: ${ticketData.priority}
${ticketData.department ? `Department: ${ticketData.department}` : ""}
${ticketData.requester ? `Requester: ${ticketData.requester}` : ""}
${ticketData.assignee ? `Assignee: ${ticketData.assignee}` : ""}
Created: ${ticketData.createdTime}
Modified: ${ticketData.modifiedTime}
${ticketData.closedTime ? `Closed: ${ticketData.closedTime}` : ""}

Description:
${ticketData.description}`

  const conversationSection = threadAggregate
    ? `\n\nCustomer Conversation Summary:\n${threadAggregate}`
    : ""

  const commentsSection = commentAggregate
    ? `\n\nInternal Team Notes:\n${commentAggregate}`
    : ""

  const resolutionSection = ticketData.resolution
    ? `\n\nResolution:\n${ticketData.resolution}`
    : ""

  const prompt = `Create a complete comprehensive summary of this support ticket.

${metadataSection}${conversationSection}${commentsSection}${resolutionSection}

Generate a comprehensive ticket summary that includes:
1. Ticket overview (subject, priority, people involved, key timestamps)
2. Problem description and what the customer reported
3. Conversation flow and key developments
4. Internal team actions and notes
5. Final resolution or current status

Format as a well-structured summary (3-5 paragraphs). This summary should give a complete picture of the ticket from start to current state.`

  try {
    logger.info(`Generating whole resolution summary`, {
      ticketId: ticketData.ticketId,
      hasThreadAggregate: !!threadAggregate,
      hasCommentAggregate: !!commentAggregate,
    })

    const { text: response } = await getProviderByModel(
      config.defaultBestModel,
    ).converse(
      [
        {
          role: "user",
          content: [{ text: prompt }],
        },
      ],
      {
        modelId: config.defaultBestModel,
        max_new_tokens: 1500, // Allow comprehensive summary
        temperature: 0.3,
        stream: false,
        json: false,
      },
    )

    // Check if LLM returned a valid response
    if (!response) {
      throw new Error(
        "LLM returned no text for whole resolution summary generation",
      )
    }

    logger.info(`Successfully generated whole resolution summary`, {
      ticketId: ticketData.ticketId,
      summaryLength: response.length,
    })

    return response.trim()
  } catch (error) {
    const errorObj = error as Error
    logger.error(`Failed to generate whole resolution summary`, {
      error: errorObj.message,
      ticketId: ticketData.ticketId,
    })

    throw new Error(
      `Failed to generate whole resolution summary: ${errorObj.message}`,
    )
  }
}
