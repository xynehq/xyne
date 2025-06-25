// Define types for Slack blocks to avoid import issues
import type {
  SectionBlock,
  HeaderBlock,
  DividerBlock,
  ContextBlock,
  ActionsBlock,
  View,
} from "@slack/types";

// Define a union type for all block types we use
// Using 'any' for Block type to work around type checking issues with Slack's typing
type Block = any;

export function createAnalysisParentMessage(
  userId: string,
  text: string,
  analysisType: string,
  status: "working" | "complete" | "error" | "failed"
): Block[] {
  const statusInfo = {
    working: { icon: "⏳", text: "In Progress" },
    complete: { icon: "✅", text: "Complete" },
    error: { icon: "❌", text: "Error" },
    failed: { icon: "❗", text: "Failed" },
  };

  const { icon, text: statusText } = statusInfo[status];

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
  ];
}

export function createErrorBlocks(error: string, sessionId: string): Block[] {
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
  ];
}

/**
 * Create initial message blocks when search results are found
 * @param userId The Slack user ID to mention
 * @param count The number of results found
 * @returns Slack blocks for the initial message
 */
export function createSearchIntroBlocks(
  userId: string,
  count: number
): Block[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Hey <@${userId}>! I found ${count} results for your query. Check out the thread for details.`,
      },
    },
  ];
}

/**
 * Create a header message for search results in a thread
 * @param query The search query string
 * @param count The number of results being shown
 * @returns Slack blocks for the thread header
 */
export function createSearchHeaderBlocks(
  query: string,
  count: number
): Block[] {
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
  ];
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
  query: string
): Block[] {
  // Extract title with fallbacks
  let title = "Untitled";
  if (result.subject) title = result.subject;
  else if (result.title) title = result.title;
  else if (result.name) title = result.name;

  // Extract content or snippet
  let snippet = "";
  if (result.content) snippet = result.content;
  else if (result.snippet) snippet = result.snippet;
  else if (result.chunks_summary && result.chunks_summary.length > 0) {
    snippet = result.chunks_summary[0].chunk || "";
    // Remove any HTML tags
    snippet = snippet.replace(/<[^>]*>/g, "");
  }

  // Clean and truncate snippet
  if (snippet) {
    snippet = snippet.replace(/\s+/g, " ").trim();
    snippet =
      snippet.length > 200 ? `${snippet.substring(0, 200)}...` : snippet;
  }

  // Get metadata
  const url = result.url || "";
  const docType = result.type || "";
  let author = "Unknown";
  let dateStr = "";

  if (result.from) author = result.from;
  if (result.timestamp) {
    const date = new Date(result.timestamp);
    dateStr = date.toLocaleDateString();
  }

  // Format metadata text
  let metadataText = "";
  if (docType) metadataText += docType + " • ";
  if (author !== "Unknown") metadataText += "By " + author + " • ";
  if (dateStr) metadataText += dateStr;

  // Trim trailing separator if needed
  metadataText = metadataText.replace(/\s•\s$/, "");

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${index + 1}. ${title}*\n${snippet ? snippet : ""}`,
      },
    },
  ];

  if (metadataText) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: metadataText,
        },
      ],
    });
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
  });

  return blocks;
}

/**
 * Create blocks for the "more results" message
 * @param totalCount Total number of results available
 * @param shownCount Number of results already shown
 * @returns Slack blocks for more results message
 */
export function createMoreResultsBlocks(
  totalCount: number,
  shownCount: number
): Block[] {
  const remaining = totalCount - shownCount;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${remaining} more results available*`,
      },
    },
  ];
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
  query: string
): Block[] {
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
  ];

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
    });
  }

  blocks.push({
    type: "divider",
  });

  // Add link to view original if URL is available
  if (url) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<${url}|View original document> 🔗`,
      },
    });
  }

  return blocks;
}

/**
 * Create blocks for a successful share confirmation
 * @returns Slack blocks for the share confirmation
 */
export function createShareConfirmationBlocks(): Block[] {
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
  ];
}

/**
 * Create a modal view for search results
 * @param query The search query string
 * @param results Array of search results
 * @returns Slack modal view object
 */
export function createSearchResultsModal(query: string, results: any[]): View {
  // Create blocks for the modal content
  const blocks: Block[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "🔍 Knowledge Base Results",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Results for:* "${query}"`,
      },
    },
    {
      type: "divider",
    },
  ];

  // Display up to 5 results in the modal
  const displayResults = results.slice(0, 5);
  for (let i = 0; i < displayResults.length; i++) {
    const result = displayResults[i];

    // Extract title with fallbacks
    let title = "Untitled";
    if (result.subject) title = result.subject;
    else if (result.title) title = result.title;
    else if (result.name) title = result.name;

    // Extract content or snippet
    let snippet = "";
    if (result.content) snippet = result.content;
    else if (result.snippet) snippet = result.snippet;
    else if (result.chunks_summary && result.chunks_summary.length > 0) {
      snippet = result.chunks_summary[0].chunk || "";
      // Remove any HTML tags
      snippet = snippet.replace(/<[^>]*>/g, "");
    }

    // Clean and truncate snippet
    if (snippet) {
      snippet = snippet.replace(/\s+/g, " ").trim();
      snippet =
        snippet.length > 200 ? `${snippet.substring(0, 200)}...` : snippet;
    }

    // Get metadata
    const url = result.url || "";
    const docType = result.type || "";
    let author = "Unknown";
    let dateStr = "";

    if (result.from) author = result.from;
    if (result.timestamp) {
      const date = new Date(result.timestamp);
      dateStr = date.toLocaleDateString();
    }

    // Format metadata text
    let metadataText = "";
    if (docType) metadataText += docType + " • ";
    if (author !== "Unknown") metadataText += "By " + author + " • ";
    if (dateStr) metadataText += dateStr;

    // Trim trailing separator if needed
    metadataText = metadataText.replace(/\s•\s$/, "");

    // Add result to blocks
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${i + 1}. ${title}*\n${snippet ? snippet : ""}`,
      },
    });

    if (metadataText) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: metadataText,
          },
        ],
      });
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
          action_id: "share_result_modal",
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
    });

    // Add divider between results (except after the last one)
    if (i < displayResults.length - 1) {
      blocks.push({
        type: "divider",
      });
    }
  }

  // If there are more results than what's shown in the modal
  if (results.length > 5) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_${
            results.length - 5
          } more results available. Refine your search for better results._`,
        },
      ],
    });
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
  };
}


export const createAgentSelectionBlocks = (agents: any[]) => {
  const blocks = [
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
  ];

  if (agents.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_No agents available. Contact your administrator to create agents._",
      },
    });
    return blocks;
  }

  // Create agent selection options
  const agentOptions = agents.slice(0, 10).map(agent => ({
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
  }));

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
  });

  return blocks;
};

export const createAgentConversationModal = (
  agentId: string,
  agentName: string,
  agentDescription?: string,
  conversationHistory?: Array<{ role: string; content: string }>
) => {
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🤖 ${agentName}*\n${agentDescription || "_No description available_"}`,
      },
    },
    {
      type: "divider",
    },
  ];

  // Add conversation history if available
  if (conversationHistory && conversationHistory.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Conversation History:*",
      },
    });

    // Show last 3 messages for context
    const recentMessages = conversationHistory.slice(-3);
    recentMessages.forEach(msg => {
      const roleIcon = msg.role === 'user' ? '👤' : '🤖';
      const roleText = msg.role === 'user' ? 'You' : agentName;
      
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${roleIcon} *${roleText}:* ${msg.content.substring(0, 200)}${msg.content.length > 200 ? '...' : ''}`,
        },
      });
    });

    blocks.push({
      type: "divider",
    });
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
      max_length: 1000,
    },
    label: {
      type: "plain_text",
      text: "Your Message",
    },
  });

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
  };
};

export const createAgentResponseBlocks = (
  agentName: string,
  userQuestion: string,
  agentResponse: string,
  conversationId?: string,
  citations?: any[],
  metadata?: any
) => {
  const blocks = [
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
  ];

  // Add citations if available
  if (citations && citations.length > 0) {
    blocks.push({
      type: "divider",
    });

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*📚 Sources:*",
      },
    });

    citations.slice(0, 3).forEach((citation, index) => {
      const citationText = citation.url 
        ? `<${citation.url}|${citation.title || 'Source'}>`
        : citation.title || 'Source';
      
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${index + 1}. ${citationText}`,
        },
      });
    });

    if (citations.length > 3) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `_...and ${citations.length - 3} more sources_`,
          },
        ],
      });
    }
  }

  // Add action buttons
  const actionElements = [];

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
    });
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
  });

  if (actionElements.length > 0) {
    blocks.push({
      type: "actions",
      elements: actionElements,
    });
  }

  // Add metadata context if available
  if (metadata) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_Model: ${metadata.model || 'Unknown'} • Response time: ${metadata.responseTime || 'Unknown'}_`,
        },
      ],
    });
  }

  return blocks;
};