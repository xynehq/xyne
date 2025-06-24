// Define types for Slack blocks to avoid import issues
import type { SectionBlock, HeaderBlock, DividerBlock, ContextBlock } from '@slack/types';

// Define a union type for all block types we use
type Block = SectionBlock | HeaderBlock | DividerBlock | ContextBlock | any;

export function createAnalysisParentMessage(
  userId: string,
  text: string,
  analysisType: string,
  status: "working" | "complete" | "error" | "failed",
): Block[] {
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
): Block[] {
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
  count: number
): Block[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Hey <@${userId}>! I found ${count} results for your query. Check out the thread for details. 👍`
      }
    }
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
        text: `🔍 *Knowledge Base Results*`
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Top ${count} results for: "${query}"`
      }
    },
    {
      type: "divider"
    }
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
  let title = 'Untitled';
  if (result.subject) title = result.subject;
  else if (result.title) title = result.title;
  else if (result.name) title = result.name;
  
  // Extract content or snippet
  let snippet = '';
  if (result.content) snippet = result.content;
  else if (result.snippet) snippet = result.snippet;
  else if (result.chunks_summary && result.chunks_summary.length > 0) {
    snippet = result.chunks_summary[0].chunk || '';
    // Remove any HTML tags
    snippet = snippet.replace(/<[^>]*>/g, '');
  }
  
  // Clean and truncate snippet
  if (snippet) {
    snippet = snippet.replace(/\s+/g, ' ').trim();
    snippet = snippet.length > 200 ? `${snippet.substring(0, 200)}...` : snippet;
  }
  
  // Get metadata
  const url = result.url || '';
  const docType = result.type || '';
  let author = 'Unknown';
  let dateStr = '';
  
  if (result.from) author = result.from;
  if (result.timestamp) {
    const date = new Date(result.timestamp);
    dateStr = date.toLocaleDateString();
  }
  
  // Format metadata text
  let metadataText = '';
  if (docType) metadataText += docType + ' • ';
  if (author !== 'Unknown') metadataText += 'By ' + author + ' • ';
  if (dateStr) metadataText += dateStr;
  
  // Trim trailing separator if needed
  metadataText = metadataText.replace(/\s•\s$/, '');
  
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${index + 1}. ${title}*\n${snippet ? snippet : ''}`
      }
    }
  ];
  
  if (metadataText) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: metadataText
        }
      ]
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
          emoji: true
        },
        style: "primary",
        action_id: "share_result",
        value: JSON.stringify({ 
          url: url, 
          title: title, 
          query: query,
          resultId: result.id || `result-${index}`
        })
      },
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Not helpful",
          emoji: true
        },
        action_id: "not_helpful",
        value: JSON.stringify({ 
          query: query, 
          resultId: result.id || `result-${index}`
        })
      }
    ]
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
        text: `*${remaining} more results available*`
      }
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_Only you can see this message_`
        }
      ]
    }
  ];
}

/**
 * Create blocks for sharing a result in the main channel
 * @param userId The Slack user ID of the person sharing
 * @param url The URL of the shared result
 * @param title The title of the shared result
 * @param query The query that led to this result
 * @returns Slack blocks for the shared message in channel
 */
export function createSharedResultBlocks(
  userId: string,
  url: string,
  title: string,
  query: string
): Block[] {
  // Get the full result details from our client to display in the channel
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: title,
        emoji: true
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Shared by <@${userId}> in response to: "${query}"`
      }
    },
    {
      type: "divider"
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<${url}|View original document> 🔗`
      }
    }
  ];
}

/**
 * Create blocks for a notification about feedback received
 * @param query The query that the feedback is for
 * @returns Slack blocks for the feedback confirmation
 */
export function createFeedbackConfirmationBlocks(
  query: string
): Block[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Thanks for your feedback! We'll use this to improve our search results."
      }
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_This message is only visible to you_`
        }
      ]
    }
  ];
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
        text: "✅ Result shared in channel successfully!"
      }
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_This message is only visible to you_`
        }
      ]
    }
  ];
}
