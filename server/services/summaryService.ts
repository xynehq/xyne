import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { getProviderByModel } from "@/ai/provider"
import { Models } from "@/ai/types"

const logger = getLogger(Subsystem.Integrations).child({
  module: "summary-service",
})

/**
 * Generate summary for a single thread or comment
 * Minimum 80-100 words to capture sufficient detail
 * Uses GPT-4o for high quality summaries
 */
export async function generateIndividualSummary(
  itemText: string,
  authorEmail: string,
  itemType: "thread" | "comment",
  retries = 3,
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

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      logger.info(`Generating individual ${itemType} summary (attempt ${attempt}/${retries})`, {
        author: authorEmail,
        textLength: itemText.length,
      })

      logger.debug(`LLM request for individual ${itemType} summary`, {
        model: Models.Vertex_Gemini_2_5_Flash,
        promptPreview: prompt.substring(0, 200) + "...",
        fullPrompt: prompt,
        maxTokens: 250,
        temperature: 0.3,
      })

      const { text: response } = await getProviderByModel(Models.Vertex_Gemini_2_5_Flash).converse(
        [
          {
            role: "user",
            content: [{ text: prompt }],
          },
        ],
        {
          modelId: Models.Vertex_Gemini_2_5_Flash,
          maxTokens: 250, // ~150-200 words max
          temperature: 0.3, // Lower temperature for consistent summaries
        },
      )

      logger.info(`Successfully generated ${itemType} summary`, {
        author: authorEmail,
        summaryLength: response.length,
        summary: response,
      })

      return response.trim()
    } catch (error) {
      lastError = error as Error
      logger.warn(`Failed to generate ${itemType} summary (attempt ${attempt}/${retries})`, {
        error: lastError.message,
        author: authorEmail,
      })

      if (attempt < retries) {
        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
      }
    }
  }

  throw new Error(`Failed to generate individual summary after ${retries} attempts: ${lastError?.message}`)
}

/**
 * Generate aggregated summary from multiple individual summaries
 * Combines all thread or comment summaries into cohesive narrative
 */
export async function generateAggregateSummary(
  individualSummaries: Array<{ itemIndex: number; summaryText: string }>,
  summaryType: "thread" | "comment",
  ticketId: string,
  retries = 3,
): Promise<string> {
  // Combine summaries in order
  const combinedText = individualSummaries
    .sort((a, b) => a.itemIndex - b.itemIndex)
    .map((s, idx) => `${summaryType === "thread" ? "Thread" : "Comment"} ${idx + 1}:\n${s.summaryText}`)
    .join("\n\n")

  const prompt = `Create a comprehensive summary of this entire support ticket ${summaryType === "thread" ? "conversation" : "internal comments"}.

Below are summaries of individual ${summaryType === "thread" ? "thread messages" : "agent comments"}. Combine them into a cohesive narrative.

${combinedText}

Create a summary that includes:
${summaryType === "thread"
  ? `- How the conversation started (initial problem/question)
- Key developments and responses throughout the conversation
- Important details, decisions, or commitments made
- Current status or latest update`
  : `- Key observations and notes from the support team
- Actions taken or planned
- Important internal context or decisions
- Current handling status`}

Format as 2-4 well-structured paragraphs. Maintain chronological flow.`

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      logger.info(`Generating aggregate ${summaryType} summary (attempt ${attempt}/${retries})`, {
        ticketId,
        individualCount: individualSummaries.length,
      })

      logger.debug(`LLM request for aggregate ${summaryType} summary`, {
        model: Models.Vertex_Gemini_2_5_Flash,
        promptPreview: prompt.substring(0, 200) + "...",
        fullPrompt: prompt,
        individualSummariesCount: individualSummaries.length,
        maxTokens: 1000,
        temperature: 0.3,
      })

      const { text: response } = await getProviderByModel(Models.Vertex_Gemini_2_5_Flash).converse(
        [
          {
            role: "user",
            content: [{ text: prompt }],
          },
        ],
        {
          modelId: Models.Vertex_Gemini_2_5_Flash,
          maxTokens: 1000, // Allow longer aggregated summaries
          temperature: 0.3,
        },
      )

      logger.info(`Successfully generated aggregate ${summaryType} summary`, {
        ticketId,
        summaryLength: response.length,
        summary: response,
      })

      return response.trim()
    } catch (error) {
      lastError = error as Error
      logger.warn(`Failed to generate aggregate summary (attempt ${attempt}/${retries})`, {
        error: lastError.message,
        ticketId,
      })

      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
      }
    }
  }

  throw new Error(`Failed to generate aggregate summary after ${retries} attempts: ${lastError?.message}`)
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
  retries = 3,
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

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      logger.info(`Generating whole resolution summary (attempt ${attempt}/${retries})`, {
        ticketId: ticketData.ticketId,
        hasThreadAggregate: !!threadAggregate,
        hasCommentAggregate: !!commentAggregate,
      })

      logger.debug(`LLM request for whole resolution summary`, {
        model: Models.Vertex_Gemini_2_5_Flash,
        promptPreview: prompt.substring(0, 200) + "...",
        fullPrompt: prompt,
        ticketNumber: ticketData.ticketNumber,
        ticketSubject: ticketData.subject,
        maxTokens: 1500,
        temperature: 0.3,
      })

      const { text: response } = await getProviderByModel(Models.Vertex_Gemini_2_5_Flash).converse(
        [
          {
            role: "user",
            content: [{ text: prompt }],
          },
        ],
        {
          modelId: Models.Vertex_Gemini_2_5_Flash,
          maxTokens: 1500, // Allow comprehensive summary
          temperature: 0.3,
        },
      )

      logger.info(`Successfully generated whole resolution summary`, {
        ticketId: ticketData.ticketId,
        summaryLength: response.length,
        summary: response,
      })

      return response.trim()
    } catch (error) {
      lastError = error as Error
      logger.warn(`Failed to generate whole resolution summary (attempt ${attempt}/${retries})`, {
        error: lastError.message,
        ticketId: ticketData.ticketId,
      })

      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
      }
    }
  }

  throw new Error(`Failed to generate whole resolution summary after ${retries} attempts: ${lastError?.message}`)
}
