// Define types for Slack blocks to avoid import issues
import type {
  SectionBlock,
  HeaderBlock,
  ActionsBlock,
  View,
  Block,
  KnownBlock,
} from "@slack/types"
import {
  SNIPPET_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  TITLE_MAX_LENGTH_SHARED,
  SNIPPET_MAX_LENGTH_SHARED,
  SNIPPET_MAX_LENGTH_SOURCES,
  QUERY_DISPLAY_MAX_LENGTH,
  RESPONSE_MODAL_MAX_LENGTH,
  RESPONSE_SHARED_MAX_LENGTH,
  MESSAGE_MAX_LENGTH,
  MODAL_MAX_CHARACTERS,
  MODAL_HEADER_CHARACTERS,
  MODAL_DIVIDER_CHARACTERS,
  MAX_RESULTS_IN_MODAL,
  MAX_AGENTS_IN_DROPDOWN,
  MAX_RECENT_MESSAGES,
  MAX_CITATIONS_IN_MODAL,
  MAX_CITATIONS_IN_SHARED,
  MAX_SOURCES_IN_MODAL,
} from "./config"
import {
  type SearchResult,
  type Citation,
  type Agent,
  type ConversationMessage,
  validateSearchResults,
  validateCitations,
  validateAgents,
  validateConversationHistory,
} from "./types"

/**
 * Helper function to parse and format result data
 * @param result The search result object
 * @returns Parsed result data with title, snippet, metadata, etc.
 */
function parseResultData(result: any) {
  // Extract title with fallbacks
  let title = "Untitled"
  if (result.subject) title = result.subject
  else if (result.title) title = result.title
  else if (result.name) title = result.name

  // Extract content or snippet
  let snippet = ""
  if (result.content) snippet = result.content
  else if (result.snippet) snippet = result.snippet
  else if (result.chunks_summary && result.chunks_summary.length > 0) {
    snippet = result.chunks_summary[0]?.chunk || ""
    // Remove any HTML tags
    snippet = snippet.replace(/<[^>]*>/g, "")
  }

  // Clean and truncate snippet
  if (snippet) {
    snippet = snippet.replace(/\s+/g, " ").trim()
    snippet =
      snippet.length > SNIPPET_MAX_LENGTH
        ? `${snippet.substring(0, SNIPPET_MAX_LENGTH)}...`
        : snippet
  }

  // Get metadata
  const url = result.url || ""
  const docType = result.type || ""
  let author = "Unknown"
  let dateStr = ""

  if (result.from) author = result.from
  if (result.timestamp) {
    const date = new Date(result.timestamp)
    dateStr = date.toLocaleDateString()
  }

  // Format metadata text
  let metadataText = ""
  if (docType) metadataText += docType + " • "
  if (author !== "Unknown") metadataText += "By " + author + " • "
  if (dateStr) metadataText += dateStr

  // Trim trailing separator if needed
  metadataText = metadataText.replace(/\s•\s$/, "")

  return {
    title,
    snippet,
    metadataText,
    url,
    docType,
    author,
    dateStr,
  }
}

export function createAnalysisParentMessage(
  userId: string,
  text: string,
  analysisType: string,
  status: "working" | "complete" | "error" | "failed",
): (KnownBlock | Block)[] {
  const statusInfo = {
    working: { icon: "⏳", text: "In Progress" },
    complete: { icon: "✅", text: "Complete" },
    error: { icon: "❌", text: "Error" },
    failed: { icon: "❗", text: "Failed" },
  }

  const { icon, text: statusText } = statusInfo[status]

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${analysisType} Analysis for <@${userId}>*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `> ${text}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${icon} *Status:* ${statusText}`,
        },
      ],
    },
  ]
}

export function createErrorBlocks(
  error: string,
  sessionId: string,
): (KnownBlock | Block)[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*An error occurred:*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```" + error + "```",
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Session ID: \`${sessionId}\``,
        },
      ],
    },
  ]
}

/**
 * Create initial message blocks when search results are found
 * @param userId The Slack user ID to mention
 * @param count The number of results found
 * @returns Slack blocks for the initial message
 */
export function createSearchIntroBlocks(
  userId: string,
  count: number,
): (KnownBlock | Block)[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Hey <@${userId}>! I found ${count} results for your query. Check out the thread for details.`,
      },
    },
  ]
}

/**
 * Create a header message for search results in a thread
 * @param query The search query string
 * @param count The number of results being shown
 * @returns Slack blocks for the thread header
 */
export function createSearchHeaderBlocks(
  query: string,
  count: number,
): (KnownBlock | Block)[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🔍 *Knowledge Base Results*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Top ${count} results for: "${query}"`,
      },
    },
    {
      type: "divider",
    },
  ]
}

/**
 * Create blocks for a single search result with action buttons
 * @param result The search result object
 * @param index The index of this result (0-based)
 * @param query The original search query
 * @returns Slack blocks for a single result message
 */
export function createSingleResultBlocks(
  result: any,
  index: number,
  query: string,
): (KnownBlock | Block)[] {
  const { title, snippet, metadataText, url } = parseResultData(result)

  const blocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${index + 1}. ${title}*\n${snippet ? snippet : ""}`,
      },
    },
  ]

  if (metadataText) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: metadataText,
        },
      ],
    } as any)
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Share in channel",
          emoji: true,
        },
        style: "primary",
        action_id: "share_result",
        value: JSON.stringify({
          url: url,
          title: title,
          query: query,
          snippet: snippet,
          metadata: metadataText,
          resultId: result.id || `result-${index}`,
        }),
      },
    ],
  } as any)

  return blocks
}

/**
 * Create blocks for the "more results" message
 * @param totalCount Total number of results available
 * @param shownCount Number of results already shown
 * @returns Slack blocks for more results message
 */
export function createMoreResultsBlocks(
  totalCount: number,
  shownCount: number,
): (KnownBlock | Block)[] {
  const remaining = totalCount - shownCount
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${remaining} more results available*`,
      },
    },
  ]
}

/**
 * Create blocks for sharing a result in the main channel
 * @param userId The Slack user ID of the person sharing
 * @param url The URL of the shared result
 * @param title The title of the shared result
 * @param snippet The content snippet from the result
 * @param metadata The metadata string (type, author, date)
 * @param query The query that led to this result
 * @returns Slack blocks for the shared message in channel
 */
export function createSharedResultBlocks(
  userId: string,
  url: string,
  title: string,
  snippet: string,
  metadata: string,
  query: string,
): (KnownBlock | Block)[] {
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${title}*\n${snippet ? snippet : ""}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Shared by <@${userId}> in response to: "${query}"`,
      },
    },
  ]

  // Add metadata if available
  if (metadata) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: metadata,
        },
      ],
    } as any)
  }

  blocks.push({
    type: "divider",
  } as any)

  // Add link to view original if URL is available
  if (url) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<${url}|View original document> 🔗`,
      },
    })
  }

  return blocks
}

/**
 * Create blocks for a successful share confirmation
 * @returns Slack blocks for the share confirmation
 */
export function createShareConfirmationBlocks(): (KnownBlock | Block)[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "✅ Result shared in channel successfully!",
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_This message is only visible to you_`,
        },
      ],
    },
  ]
}

/**
 * Create a modal view for search results
 * @param query The search query string
 * @param results Array of search results
 * @returns Slack modal view object
 */
export function createSearchResultsModal(
  query: string,
  results: unknown[],
): View {
  // Validate and filter results
  const validResults = validateSearchResults(results)
  // Create blocks for the modal content
  const blocks: (KnownBlock | Block)[] = []

  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: "🔍 Knowledge Base Results",
      emoji: true,
    },
  })

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Results for:* "${query}"`,
    },
  })

  blocks.push({
    type: "divider",
  })

  // Display up to 5 results in the modal
  const displayResults = validResults.slice(0, MAX_RESULTS_IN_MODAL)
  for (let i = 0; i < displayResults.length; i++) {
    const result = displayResults[i]
    const { title, snippet, metadataText, url } = parseResultData(result)

    // Add result to blocks
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${i + 1}. ${title}*\n${snippet ? snippet : ""}`,
      },
    })

    if (metadataText) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: metadataText,
          },
        ],
      })
    }

    // Add action buttons for each result
    blocks.push({
      type: "actions",
      block_id: `result_actions_${i}`,
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Share in channel",
            emoji: true,
          },
          style: "primary",
          action_id: "share_from_modal",
          value: JSON.stringify({
            url: url,
            title: title,
            query: query,
            snippet: snippet,
            metadata: metadataText,
            resultId: result.id || `result-${i}`,
          }),
        },
      ],
    })

    // Add divider between results (except after the last one)
    if (i < displayResults.length - 1) {
      blocks.push({
        type: "divider",
      })
    }
  }

  // If there are more results than what's shown in the modal
  if (results.length > MAX_RESULTS_IN_MODAL) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_${
            results.length - MAX_RESULTS_IN_MODAL
          } more results available. Refine your search for better results._`,
        },
      ],
    })
  }

  // Create the modal view object
  return {
    type: "modal",
    title: {
      type: "plain_text",
      text: "Search Results",
      emoji: true,
    },
    close: {
      type: "plain_text",
      text: "Close",
      emoji: true,
    },
    blocks: blocks,
  }
}

export const createAgentSelectionBlocks = (agents: any[]) => {
  const blocks: (KnownBlock | Block)[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*🤖 Select an Agent to Chat With:*",
      },
    },
    {
      type: "divider",
    },
  ]

  if (agents.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_No agents available. Contact your administrator to create agents._",
      },
    })
    return blocks
  }

  // Create agent selection options
  const agentOptions = agents.slice(0, MAX_AGENTS_IN_DROPDOWN).map((agent) => ({
    text: {
      type: "plain_text",
      text: agent.name,
      emoji: true,
    },
    value: agent.externalId,
    description: {
      type: "plain_text",
      text: agent.description || "No description available",
    },
  }))

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "Choose an agent from the dropdown below:",
    },
    accessory: {
      type: "static_select",
      action_id: "select_agent",
      placeholder: {
        type: "plain_text",
        text: "Select an agent...",
        emoji: true,
      },
      options: agentOptions,
    },
  } as any)

  return blocks
}

export const createAgentConversationModal = (
  agentId: string,
  agentName: string,
  agentDescription?: string,
  conversationHistory?: Array<{ role: string; content: string }>,
) => {
  const blocks: (KnownBlock | Block)[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🤖 ${agentName}*\n${
          agentDescription || "_No description available_"
        }`,
      },
    },
    {
      type: "divider",
    },
  ]

  // Add conversation history if available
  if (conversationHistory && conversationHistory.length > 0) {
    const validMessages = validateConversationHistory(conversationHistory)
    if (validMessages.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Conversation History:*",
        },
      })

      // Show last 3 messages for context
      const recentMessages = validMessages.slice(-MAX_RECENT_MESSAGES)
      recentMessages.forEach((msg) => {
        const roleIcon = msg.role === "user" ? "👤" : "🤖"
        const roleText = msg.role === "user" ? "You" : agentName

        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${roleIcon} *${roleText}:* ${msg.content.substring(0, SNIPPET_MAX_LENGTH)}${
              msg.content.length > SNIPPET_MAX_LENGTH ? "..." : ""
            }`,
          },
        })
      })

      blocks.push({
        type: "divider",
      })
    }
  }

  // Add input field for new message
  blocks.push({
    type: "input",
    block_id: "message_input",
    element: {
      type: "plain_text_input",
      action_id: "agent_message",
      placeholder: {
        type: "plain_text",
        text: "Type your message to the agent...",
      },
      multiline: true,
      max_length: MESSAGE_MAX_LENGTH,
    },
    label: {
      type: "plain_text",
      text: "Your Message",
    },
  } as any)

  return {
    type: "modal",
    callback_id: `agent_conversation_${agentId}`,
    title: {
      type: "plain_text",
      text: `Chat: ${agentName}`,
      emoji: true,
    },
    submit: {
      type: "plain_text",
      text: "Send Message",
      emoji: true,
    },
    close: {
      type: "plain_text",
      text: "Close",
      emoji: true,
    },
    blocks: blocks,
    private_metadata: JSON.stringify({
      agent_id: agentId,
      agent_name: agentName,
    }),
  }
}

export const createAgentResponseBlocks = (
  agentName: string,
  userQuestion: string,
  agentResponse: string,
  conversationId?: string,
  citations?: any[],
  metadata?: any,
) => {
  const blocks: (KnownBlock | Block)[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🤖 *${agentName}* responded:`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Your Question:* ${userQuestion}`,
      },
    },
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Response:*\n${agentResponse}`,
      },
    },
  ]

  // Add citations if available
  if (citations && citations.length > 0) {
    blocks.push({
      type: "divider",
    })

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*📚 Sources:*",
      },
    })

    citations.slice(0, MAX_RECENT_MESSAGES).forEach((citation, index) => {
      const citationText = citation?.url
        ? `<${citation.url}|${citation.title || "Source"}>`
        : citation?.title || "Source"

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${index + 1}. ${citationText}`,
        },
      })
    })

    if (citations.length > MAX_RECENT_MESSAGES) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `_...and ${citations.length - MAX_RECENT_MESSAGES} more sources_`,
          },
        ],
      } as any)
    }
  }

  // Add action buttons
  const actionElements = []

  if (conversationId) {
    actionElements.push({
      type: "button",
      text: {
        type: "plain_text",
        text: "Continue Chat",
        emoji: true,
      },
      action_id: "continue_agent_conversation",
      value: conversationId,
    })
  }

  actionElements.push({
    type: "button",
    text: {
      type: "plain_text",
      text: "Share Response",
      emoji: true,
    },
    style: "primary",
    action_id: "share_agent_response",
    value: JSON.stringify({
      agent_name: agentName,
      question: userQuestion,
      response: agentResponse,
      conversation_id: conversationId,
    }),
  })

  if (actionElements.length > 0) {
    blocks.push({
      type: "actions",
      elements: actionElements,
    } as any)
  }

  // Add metadata context if available
  if (metadata) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_Model: ${metadata.model || "Unknown"} • Response time: ${
            metadata.responseTime || "Unknown"
          }_`,
        },
      ],
    } as any)
  }

  return blocks
}

/**
 * Clean and format agent response text for Slack markdown display
 * @param response The raw agent response text
 * @returns Cleaned and formatted response text
 */
export function cleanAgentResponse(response: string): string {
  return response
    .replace(/:\w+:/g, "") // Remove emoji codes like :robot_face:, :books:
    .replace(/\[\d+\]/g, "") // Remove citation numbers
    .replace(/\*\*(.*?)\*\*/g, "*$1*") // Convert **bold** to *bold*
    .replace(/^#{1,}\s*(.+)$/gm, "*$1*") // Convert # headings to *bold* format
    .replace(/^- /gm, "• ") // Convert '- ' list items to '• '
    .replace(/^Response from \/[\w-]+\s*/gm, "") // Remove "Response from /agent-name" lines
    .replace(/^Your Query:\s*/gm, "") // Remove standalone "Your Query:" lines
    .replace(/^Response:\s*/gm, "") // Remove standalone "Response:" lines
    .trim()
}

/**
 * Create a modal view for agent responses
 * @param query The original query string
 * @param agentName Name of the agent that responded
 * @param response The agent's response text
 * @param citations Array of citations if available
 * @param interactionId The cache key for this interaction (required)
 * @returns Slack modal view object
 */
export function createAgentResponseModal(
  query: string,
  agentName: string,
  response: string,
  citations: unknown[],
  interactionId: string,
  isFromThread: boolean,
): View {
  // Validate and filter citations
  const validCitations = validateCitations(citations)
  // Clean up and format the main response body for Slack mrkdwn
  const displayResponse = cleanAgentResponse(response)

  const blocks: (KnownBlock | Block)[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🤖 */${agentName}* responded to: "_${
          query.length > QUERY_DISPLAY_MAX_LENGTH
            ? query.substring(0, QUERY_DISPLAY_MAX_LENGTH) + "..."
            : query
        }_"`,
      },
    },
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${
          displayResponse.length > RESPONSE_MODAL_MAX_LENGTH
            ? displayResponse.substring(0, RESPONSE_MODAL_MAX_LENGTH) +
              "\n\n..._[Response truncated for display]_"
            : displayResponse
        }`,
      },
    },
  ]

  // Add citations if available (keep original order but limit to prevent excessive scrolling)
  if (validCitations && validCitations.length > 0) {
    blocks.push({ type: "divider" })
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*📚 Sources (${validCitations.length}):*`,
      },
    })

    // Limit citations in modal to prevent excessive scrolling
    const displayCitations = validCitations.slice(0, MAX_CITATIONS_IN_MODAL)
    for (let i = 0; i < displayCitations.length; i++) {
      const citation = displayCitations[i]
      const rawTitle = citation.title || citation.name || "Untitled"
      let url = citation.url || ""
      let title = rawTitle

      // Check for and parse Slack's <url|text> format
      const slackLinkMatch = rawTitle.match(/<(https?:\/\/[^|]+)\|([\s\S]+)>/)
      if (slackLinkMatch) {
        url = slackLinkMatch[1]
        title = slackLinkMatch[2]
      }

      // Clean the title from any HTML tags and extra whitespace
      title = title
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim()
      if (title.length > TITLE_MAX_LENGTH) {
        title = `${title.substring(0, TITLE_MAX_LENGTH)}...`
      }

      let snippet = citation.snippet || citation.content || ""
      if (snippet) {
        snippet = snippet
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim()
        snippet =
          snippet.length > SNIPPET_MAX_LENGTH_SOURCES
            ? `${snippet.substring(0, SNIPPET_MAX_LENGTH_SOURCES)}...`
            : snippet
      }

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${i + 1}. ${url ? `<${url}|${title}>` : title}*\n${
            snippet || "_No preview available_"
          }`,
        },
      })
    }

    // Show "See all sources" button if there are more than 2 sources
    if (validCitations.length > MAX_CITATIONS_IN_MODAL) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `_${validCitations.length - MAX_CITATIONS_IN_MODAL} more sources available_`,
        },
        accessory: {
          type: "button",
          text: {
            type: "plain_text",
            text: "See all sources",
            emoji: true,
          },
          action_id: "view_all_sources",
          value: interactionId,
        },
      })
    }
  }

  // Add sharing actions at the bottom (keep original order)
  blocks.push({ type: "divider" })
  const actions: any[] = [
    {
      type: "button",
      text: {
        type: "plain_text",
        text: "Share in channel",
        emoji: true,
      },
      style: "primary",
      action_id: "share_agent_from_modal",
      value: interactionId,
    },
  ]

  if (isFromThread) {
    actions.push({
      type: "button",
      text: {
        type: "plain_text",
        text: "Share in Thread",
        emoji: true,
      },
      action_id: "share_agent_in_thread_from_modal", // Use the constant here
      value: interactionId,
    })
  }

  blocks.push({
    type: "actions",
    block_id: "agent_response_actions",
    elements: actions,
  })

  return {
    type: "modal",
    title: {
      type: "plain_text",
      text: "Agent Response",
      emoji: true,
    },
    close: {
      type: "plain_text",
      text: "Close",
      emoji: true,
    },
    blocks: blocks,
  }
}

/**
 * Create blocks for sharing an agent response in the main channel
 * @param userId The Slack user ID of the person sharing
 * @param agentName Name of the agent that provided the response
 * @param query The original query
 * @param response The agent's response text (may be truncated)
 * @param citations Array of citations if available
 * @returns Slack blocks for the shared agent response in channel
 */
export function createSharedAgentResponseBlocks(
  userId: string,
  agentName: string,
  query: string,
  response: string,
  citations: any[] = [],
): (KnownBlock | Block)[] {
  // Clean up and format the main response body for Slack markdown
  const displayResponse = cleanAgentResponse(response)

  const blocks: (KnownBlock | Block)[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🤖 ${agentName} Response*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Your Query:*\n> ${query}`,
      },
    },
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${
          displayResponse.length > RESPONSE_SHARED_MAX_LENGTH
            ? displayResponse.substring(0, RESPONSE_SHARED_MAX_LENGTH) +
              "\n\n..._[Response truncated]_"
            : displayResponse
        }`,
      },
    },
  ]

  // Format citations
  if (citations && citations.length > 0) {
    blocks.push({
      type: "divider",
    })
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*📚 Sources (${citations.length}):*`,
      },
    })

    const maxCitationsToShow = Math.min(
      citations.length,
      MAX_CITATIONS_IN_SHARED,
    )
    citations.slice(0, maxCitationsToShow).forEach((citation, index) => {
      const rawTitle = citation?.title || citation?.name || "Untitled"
      let url = citation?.url || ""
      let title = rawTitle

      const slackLinkMatch = rawTitle.match(/<(https?:\/\/[^|]+)\|([\s\S]+)>/)
      if (slackLinkMatch) {
        url = slackLinkMatch[1]
        title = slackLinkMatch[2]
      }

      title = title
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim()
      if (title.length > TITLE_MAX_LENGTH_SHARED) {
        title = `${title.substring(0, TITLE_MAX_LENGTH_SHARED)}...`
      }

      let snippet = citation?.snippet || citation?.content || ""
      if (snippet) {
        snippet = snippet
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim()
        snippet =
          snippet.length > SNIPPET_MAX_LENGTH_SHARED
            ? `${snippet.substring(0, SNIPPET_MAX_LENGTH_SHARED)}...`
            : snippet
      }

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${index + 1}. ${url ? `<${url}|${title}>` : title}*\n${
            snippet || "_No preview available_"
          }`,
        },
      })
    })

    if (citations.length > maxCitationsToShow) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `_...and ${
              citations.length - maxCitationsToShow
            } more sources_`,
          },
        ],
      })
    }
  }

  // Add attribution and divider
  blocks.push(
    {
      type: "divider",
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Shared by <@${userId}>`,
        },
      ],
    },
  )

  return blocks
}

/**
 * Create a modal view for displaying all sources/citations
 * @param agentName Name of the agent that provided the response
 * @param query The original query string
 * @param citations Array of all citations
 * @returns Slack modal view object
 */
export function createAllSourcesModal(
  agentName: string,
  query: string,
  citations: unknown[],
): View {
  // Validate and filter citations
  const validCitations = validateCitations(citations)
  const blocks: (KnownBlock | Block)[] = [
    {
      type: "section",
      text: {
        type: "plain_text",
        text: `📚 All Sources from /${agentName}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Query:* "${
          query.length > QUERY_DISPLAY_MAX_LENGTH
            ? query.substring(0, QUERY_DISPLAY_MAX_LENGTH) + "..."
            : query
        }"`,
      },
    },
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${citations.length} Sources:*`,
      },
    },
  ]

  // Display sources with smart truncation to avoid exceeding modal limits
  // Slack modal has a ~50 block limit and each block has character limits
  let totalCharacters = MODAL_HEADER_CHARACTERS // Start with header characters
  const maxSources = Math.min(citations.length, MAX_SOURCES_IN_MODAL) // Limit sources to prevent modal overflow

  for (let i = 0; i < maxSources; i++) {
    const citation = validCitations?.[i]
    if (!citation) continue

    const title = citation.title || citation.name || "Untitled"
    const url = citation.url || ""
    let snippet = citation.snippet || citation.content || ""

    // Clean and truncate snippet more aggressively for the sources modal
    if (snippet) {
      snippet = snippet.replace(/\s+/g, " ").trim()
      snippet =
        snippet.length > TITLE_MAX_LENGTH
          ? `${snippet.substring(0, TITLE_MAX_LENGTH)}...`
          : snippet
    }

    const sourceText = `*${i + 1}. ${title}*\n${
      snippet ? snippet : "No preview available"
    }${url ? `\n<${url}|View Source>` : ""}`

    // Check if adding this source would exceed our character limit
    if (totalCharacters + sourceText.length > MODAL_MAX_CHARACTERS) {
      // Add a note about remaining sources
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `_...and ${
            citations.length - i
          } more sources (content truncated due to display limits)_`,
        },
      })
      break
    }

    totalCharacters += sourceText.length

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: sourceText,
      },
    })

    // Add divider between citations (except after the last one or if we're at the limit)
    if (i < maxSources - 1 && i < citations.length - 1) {
      blocks.push({
        type: "divider",
      })
      totalCharacters += MODAL_DIVIDER_CHARACTERS // Approximate divider character cost
    }
  }

  // Create the modal view object
  return {
    type: "modal",
    title: {
      type: "plain_text",
      text: "All Sources",
      emoji: true,
    },
    close: {
      type: "plain_text",
      text: "Close",
      emoji: true,
    },
    blocks: blocks,
  }
}
