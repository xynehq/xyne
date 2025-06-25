import { App, AppMentionEvent, BlockAction, ButtonAction, LogLevel, WebClient, View } from "@slack/bolt";
import * as dotenv from "dotenv";
import { db } from "@/db/client";
import { getUserByEmail } from "@/db/user";
import { getLogger } from "@/logger";
import { Subsystem } from "@/types";
import { SearchApi } from "@/api/search";
import { AgentMessageApi } from "@/api/chat/agents";
import config from "@/config";
import {
  createSearchResultsModal,
  createShareConfirmationBlocks,
  createSharedResultBlocks,
} from "./formatters";
import { getUserAccessibleAgents } from "@/db/userAgentPermission";
import { getUserAndWorkspaceByEmail } from "@/db/user";
import { UnderstandMessageAndAnswer } from "@/api/chat/chat";
import { generateSearchQueryOrAnswerFromConversation } from "@/ai/provider";
import { userContext } from "@/ai/context";
import { getAgentByExternalIdWithPermissionCheck } from "@/db/agent";
import { QueryType } from "@/ai/types";
import { Apps } from "@/search/types";
import { getTracer } from "@/tracer";

dotenv.config();

const Logger = getLogger(Subsystem.Slack, { logLevel: LogLevel.INFO });

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

/**
 * Interface for the data cached for each search interaction.
 */
interface SearchCacheEntry {
  query: string;
  results: any[];
  timestamp: number;
  isFromThread: boolean;
}

// --- Global Cache with TTL Management ---
declare global {
  var _searchResultsCache: Record<string, SearchCacheEntry>;
}
global._searchResultsCache = global._searchResultsCache || {};
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Periodically cleans up expired entries from the search results cache.
 */
const cleanupCache = () => {
  const now = Date.now();
  let cleanedCount = 0;
  for (const key in global._searchResultsCache) {
    if (now - global._searchResultsCache[key].timestamp > CACHE_TTL) {
      delete global._searchResultsCache[key];
      cleanedCount++;
    }
  }
  if (cleanedCount > 0) {
    Logger.info(`Cleaned up ${cleanedCount} expired cache entries.`);
  }
};
setInterval(cleanupCache, 5 * 60 * 1000);

/**
 * Defined separate, explicit action IDs for sharing from the modal
 * to a channel vs. to a thread to resolve ambiguity.
 */
const ACTION_IDS = {
  VIEW_SEARCH_MODAL: "view_search_modal",
  SHARE_RESULT_DIRECTLY: "share_result",
  SHARE_FROM_MODAL: "share_from_modal", // For sharing to the channel
  SHARE_IN_THREAD_FROM_MODAL: "share_in_thread_from_modal", // For sharing to a thread
};


// --- Event Handlers ---

app.event("app_mention", async ({ event, client }) => {
  Logger.info(`Received app_mention event: ${JSON.stringify(event.text)}`);

  const { user, text, channel, ts, thread_ts } = event;

  try {
    await client.conversations.join({ channel });

    const userInfo = await client.users.info({ user });
    if (!userInfo.ok || !userInfo.user?.profile?.email) {
      Logger.warn(`Could not retrieve email for user ${user}.`);
      await client.chat.postEphemeral({
        channel,
        user,
        text: "I couldn't retrieve your email from Slack. Please ensure your profile email is visible.",
      });
      return;
    }
    const userEmail = userInfo.user.profile.email;

    const dbUser = await getUserByEmail(db, userEmail);
    if (!dbUser?.length) {
      Logger.warn(`User with email ${userEmail} not found in the database.`);
      await client.chat.postEphemeral({
        channel,
        user,
        text: "It seems you're not registered in our system. Please contact support.",
      });
      return;
    }

    const processedText = text.replace(/<@.*?>\s*/, "").trim();

    if (processedText.toLowerCase().startsWith("/agents")) {
      await handleAgentsCommand(client, channel, user, dbUser[0]);
    } else if (processedText.toLowerCase().startsWith("/search ")) {
      const query = processedText.substring(8).trim();
      await handleSearchQuery(client, channel, user, query, dbUser[0], ts, thread_ts);
    } else if (processedText.toLowerCase().startsWith("/agent ")) {
      const agentCommand = processedText.substring(7).trim();
      await handleAgentSearchCommand(client, channel, user, agentCommand, dbUser[0], ts, thread_ts);
    } else {
      await handleHelpCommand(client, channel, user);
    }
  } catch (error: any) {
    Logger.error(error, "Error processing app_mention event");
    await client.chat.postEphemeral({
      channel,
      user,
      text: `An unexpected error occurred: ${error.message}. Please try again.`,
    });
  }
});

// --- Command Logic ---

const handleAgentsCommand = async (
  client: WebClient,
  channel: string,
  user: string,
  dbUser: any
) => {
  Logger.info(`Listing agents for user ${dbUser.email}`);

  try {
    const agents = await getUserAccessibleAgents(db, dbUser.id, dbUser.workspaceId || 1, 20, 0);
    
    if (agents.length === 0) {
      await client.chat.postEphemeral({
        channel,
        user,
        text: "You don't have access to any agents yet. Please contact your administrator.",
      });
      return;
    }

    const agentBlocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🤖 *Available Agents (${agents.length})*\nYou can use any of these agents with \`/agent @agent_name <your query>\``
        }
      },
      { type: "divider" }
    ];

    agents.forEach((agent, index) => {
      agentBlocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${index + 1}. @${agent.name}*${agent.isPublic ? ' 🌐' : ''}\n${agent.description || 'No description available'}\n_Model: ${agent.model}_`
        }
      });
    });

    agentBlocks.push(
      { type: "divider" },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "💡 *Usage:* `/agent @agent_name your question here` | 🌐 = Public agent"
          }
        ]
      }
    );

    await client.chat.postEphemeral({
      channel,
      user,
      text: `Available agents (${agents.length})`,
      blocks: agentBlocks,
    });

  } catch (error: any) {
    Logger.error(error, "Error fetching agents");
    await client.chat.postEphemeral({
      channel,
      user,
      text: "I couldn't fetch the list of agents. Please try again later.",
    });
  }
};

const handleAgentSearchCommand = async (
  client: WebClient,
  channel: string,
  user: string,
  agentCommand: string,
  dbUser: any,
  messageTs: string,
  threadTs: string | undefined
) => {
  // Parse the command: @agent_name query
  const match = agentCommand.match(/^@(\w+)\s+(.+)$/);
  if (!match) {
    await client.chat.postEphemeral({
      channel,
      user,
      text: "Invalid format. Use: `/agent @agent_name your query here`\nExample: `/agent @support_bot how to reset password`",
    });
    return;
  }

  const [, agentName, query] = match;
  Logger.info(`Agent search - Agent: ${agentName}, Query: "${query}" by user ${dbUser.email}`);

  try {
    // Get accessible agents and find the requested one
    const agents = await getUserAccessibleAgents(db, dbUser.id, dbUser.workspaceId || 1, 100, 0);
    const selectedAgent = agents.find(agent => agent.name.toLowerCase() === agentName.toLowerCase());

    if (!selectedAgent) {
      const availableAgents = agents.map(a => `@${a.name}`).join(', ');
      await client.chat.postEphemeral({
        channel,
        user,
        text: `Agent "@${agentName}" not found or not accessible to you.\n\nAvailable agents: ${availableAgents}\n\nUse \`/agents\` to see the full list with descriptions.`,
      });
      return;
    }

    const isThreadMessage = !!threadTs;

    Logger.info(`Starting agent chat with ${selectedAgent.name} for query: "${query}"`);

    // Show initial message to user
    await client.chat.postEphemeral({
      channel,
      user,
      text: `🤖 Starting conversation with agent "@${agentName}"...`,
      ...(isThreadMessage && { thread_ts: threadTs }),
    });

    try {
      // Get user and workspace data using the proper function
      const userAndWorkspace = await getUserAndWorkspaceByEmail(
        db,
        dbUser.workspaceExternalId || "default",
        dbUser.email
      );
      const ctx = userContext(userAndWorkspace);

      // Get the full agent configuration with permission check
      const agentConfig = await getAgentByExternalIdWithPermissionCheck(
        db,
        selectedAgent.externalId,
        userAndWorkspace.workspace.id,
        userAndWorkspace.user.id
      );

      if (!agentConfig) {
        await client.chat.postEphemeral({
          channel,
          user,
          text: `❌ You don't have permission to use agent "@${agentName}".`,
          ...(isThreadMessage && { thread_ts: threadTs }),
        });
        return;
      }

      const agentPrompt = JSON.stringify(agentConfig);

      // First, let's check if we need to classify the query or if the agent can answer directly
      const limitedMessages: any[] = []; // Empty for new conversation in Slack
      
      // Use the same classification logic as AgentMessageApi
      const searchOrAnswerIterator = generateSearchQueryOrAnswerFromConversation(
        query,
        ctx,
        {
          modelId: config.defaultBestModel,
          stream: true,
          json: true,
          reasoning: false,
          messages: limitedMessages,
          agentPrompt: agentPrompt,
        }
      );

      let buffer = "";
      let parsed = {
        answer: "",
        queryRewrite: "",
        temporalDirection: null,
        filter_query: "",
        type: "",
        filters: {
          app: "",
          entity: "",
          startTime: "",
          endTime: "",
          count: 0,
          sortDirection: "",
        }
      };

      // Process the classification/answer response
      for await (const chunk of searchOrAnswerIterator) {
        if (chunk.text) {
          buffer += chunk.text;
          try {
            parsed = JSON.parse(buffer) || {};
          } catch (err) {
            // Continue if we can't parse yet
            continue;
          }
        }
      }

      let finalResponse = "";
      let citations: any[] = [];

      if (parsed.answer && parsed.answer.trim()) {
        // Agent provided direct answer from conversation context
        finalResponse = parsed.answer;
        Logger.info(`Agent provided direct answer: ${finalResponse.substring(0, 100)}...`);
      } else {
        // Need to do RAG - use the rewritten query if available
        const searchQuery = parsed.queryRewrite || query;
        
        // Build classification object for RAG
        const classification = {
          direction: parsed.temporalDirection,
          type: (parsed.type as QueryType) || QueryType.GENERAL,
          filterQuery: parsed.filter_query || "",
          filters: {
            app: (parsed.filters?.app as Apps) || null,
            entity: parsed.filters?.entity || null,
            startTime: parsed.filters?.startTime || "",
            endTime: parsed.filters?.endTime || "",
            count: parsed.filters?.count || 0,
            sortDirection: parsed.filters?.sortDirection || "",
          },
        };

        Logger.info(`Running RAG for agent with query: "${searchQuery}"`);

        // Create a tracer span for the RAG operation
        const tracer = getTracer("slack-agent");
        const span = tracer.startSpan("slack_agent_rag");

        // Call the core RAG function directly
        const iterator = UnderstandMessageAndAnswer(
          dbUser.email,
          ctx,
          searchQuery,
          classification,
          limitedMessages,
          0.5, // threshold
          false, // reasoning enabled
          span,
          agentPrompt
        );

        // Process the streaming response
        let response = "";
        const ragCitations: any[] = [];
        
        for await (const chunk of iterator) {
          if (chunk.text && !chunk.reasoning) {
            response += chunk.text;
          }
          if (chunk.citation) {
            ragCitations.push(chunk.citation.item);
          }
        }

        finalResponse = response;
        citations = ragCitations;
        span.end();

        Logger.info(`Agent RAG completed. Response length: ${finalResponse.length}, Citations: ${citations.length}`);
      }

      if (!finalResponse.trim()) {
        await client.chat.postEphemeral({
          channel,
          user,
          text: `🤖 Agent "@${agentName}" couldn't generate a response for "${query}". Try rephrasing your question.`,
          ...(isThreadMessage && { thread_ts: threadTs }),
        });
        return;
      }

      // Format the response for Slack
      const blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🤖 *Response from @${agentName}:*\n\n${finalResponse}`
          }
        }
      ];

      // Add citations if available
      if (citations.length > 0) {
        blocks.push({
          type: "divider"
        });
        
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `📚 *Sources (${citations.length}):*`
          }
        });

        citations.slice(0, 5).forEach((citation, index) => {
          blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${index + 1}.* ${citation.title || 'Untitled'}\n${citation.url ? `<${citation.url}|View Source>` : citation.snippet?.substring(0, 100) || 'No preview available'}...`
            }
          });
        });

        if (citations.length > 5) {
          blocks.push({
            type: "context",
            elements: [{
              type: "mrkdwn",
              text: `_... and ${citations.length - 5} more sources_`
            }]
          });
        }
      }

      // Add context info
      blocks.push({
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `💡 _Agent: ${selectedAgent.name} | Model: ${selectedAgent.model} | ${citations.length > 0 ? 'With sources' : 'Direct response'}_`
        }]
      });

      await client.chat.postEphemeral({
        channel,
        user,
        text: `Response from @${agentName}`,
        blocks: blocks,
        ...(isThreadMessage && { thread_ts: threadTs }),
      });

    } catch (agentError: any) {
      Logger.error(agentError, "Error in direct agent processing");
      await client.chat.postEphemeral({
        channel,
        user,
        text: `❌ I encountered an error while processing your request with agent "@${agentName}". Please try again later.`,
        ...(isThreadMessage && { thread_ts: threadTs }),
      });
    }

  } catch (error: any) {
    Logger.error(error, "Error in agent search command");
    await client.chat.postEphemeral({
      channel,
      user,
      text: `An error occurred while searching with agent "@${agentName}". Please try again.`,
    });
  }
};

const handleSearchQuery = async (
  client: WebClient,
  channel: string,
  user: string,
  query: string,
  dbUser: any,
  messageTs: string,
  threadTs: string | undefined
) => {
  Logger.info(`Executing search for query: "${query}" by user ${dbUser.email}`);
  const isThreadMessage = !!threadTs;

  let results: any[] = [];
  try {
    const mockContext = {
      get: (key: string) => key === config.JwtPayloadKey ? { sub: dbUser.email, workspaceId: dbUser.workspaceExternalId || "default", role: dbUser.role || "user" } : undefined,
      req: { valid: (type: "query") => ({ query, groupCount: false, page: 10, app: null, entity: null, offset: 0, debug: false }) },
      json: (data: any) => data,
    };
    const searchApiResponse = await SearchApi(mockContext as any);
    results = searchApiResponse?.results || [];
    Logger.info(`Found ${results.length} results from SearchApi.`);
  } catch (apiError) {
    Logger.error(apiError, "Error calling SearchApi");
    await client.chat.postEphemeral({ channel, user, text: `I couldn't complete your search for "${query}". The search service might be down.` });
    return;
  }

  if (results.length === 0) {
    await client.chat.postEphemeral({ channel, user, text: `I couldn't find any results for "${query}". Try different keywords.` });
    return;
  }

  const interactionId = `search_${user}_${messageTs}_${Date.now()}`;
  global._searchResultsCache[interactionId] = { query, results, isFromThread: isThreadMessage, timestamp: Date.now() };

  await client.chat.postEphemeral({
    channel, user,
    text: `Search results for "${query}" are ready.`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `🔍 I found *${results.length} results* for your query: "_${query}_"\nClick the button to view them.` }},
      { type: "actions", elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: "View Results", emoji: true }, action_id: ACTION_IDS.VIEW_SEARCH_MODAL, value: interactionId }] },
    ],
    ...(isThreadMessage && { thread_ts: threadTs }),
  });
};

const handleHelpCommand = async (client: WebClient, channel: string, user: string) => {
  const botUserId = (await client.auth.test()).user_id;
  await client.chat.postEphemeral({
    channel, user,
    text: "Help - Available Commands",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: "*🤖 Available Commands:*" }},
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: "*List Agents:*\n`/agents` - Shows all available agents you can use.\n_Example: `/agents`_" }},
      { type: "section", text: { type: "mrkdwn", text: "*Search with Agent:*\n`/agent @agent_name <query>` - Search using a specific agent.\n_Example: `/agent @support_bot password reset`_" }},
      { type: "section", text: { type: "mrkdwn", text: "*General Search:*\n`/search <query>` - Search the knowledge base.\n_Example: `/search quarterly reports`_" }},
      { type: "section", text: { type: "mrkdwn", text: "*Help:*\n`help` - Shows this message." }},
      { type: "context", elements: [{ type: "mrkdwn", text: `💡 Tip: Mention me (<@${botUserId}>) with a command!` }] },
    ],
  });
};

// --- Action Handlers ---

app.action<ButtonAction>(ACTION_IDS.VIEW_SEARCH_MODAL, async ({ ack, body, client }) => {
  await ack();
  const interactionId = body.actions[0].value;
  const cachedData = global._searchResultsCache[interactionId];

  try {
    if (!cachedData) throw new Error(`No cached search results found. They may have expired.`);

    const { query, results, isFromThread } = cachedData;
    const modal = createSearchResultsModal(query, results);

    if (isFromThread) {
      modal.blocks = modal.blocks.map(block => {
        if (block.type === 'actions' && block.block_id?.startsWith('result_actions_')) {
          (block as any).elements.push({
            type: 'button',
            text: { type: 'plain_text', text: 'Share in Thread', emoji: true },
            action_id: ACTION_IDS.SHARE_IN_THREAD_FROM_MODAL,
            value: (block.elements[0] as ButtonAction).value,
          });
        }
        return block;
      });
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        ...modal,
        callback_id: `search_results_modal`,
        private_metadata: JSON.stringify({
          channel_id: body.channel?.id,
          thread_ts: (body.container as any)?.thread_ts,
          user_id: body.user.id,
        }),
      },
    });
    Logger.info(`Opened search results modal for user ${body.user.id}`);
  } catch (error: any) {
    Logger.error(error, `Error opening search modal for interaction ${interactionId}`);
    await client.chat.postEphemeral({ channel: body.channel!.id, user: body.user.id, text: `Sorry, I couldn't open the results. ${error.message}. Please try again.` });
  }
});

/**
 * Handles sharing a result from the modal to the main channel.
 */
app.action<BlockAction<ButtonAction>>(ACTION_IDS.SHARE_FROM_MODAL, async ({ ack, body, client, action }) => {
  await ack();
  const view = body.view;
  try {
    if (!view || !view.private_metadata) throw new Error("Cannot access required modal metadata.");
    
    const { url, title, query, snippet, metadata } = JSON.parse(action.value);
    const { channel_id, user_id } = JSON.parse(view.private_metadata);

    if (!channel_id) throw new Error("Channel ID not found in modal metadata.");

    await client.chat.postMessage({
      channel: channel_id,
      text: `${title} - Shared by <@${user_id}>`,
      blocks: createSharedResultBlocks(user_id, url, title, snippet || "", metadata || "", query),
    });

    const newBlocks = view.blocks.map(b => (b.block_id === action.block_id) ? { type: "context", elements: [{ type: "mrkdwn", text: "✅ *Result shared in channel successfully!*" }] } : b);
    
    const updatedView: View = {
        type: 'modal',
        title: view.title,
        blocks: newBlocks,
        private_metadata: view.private_metadata,
        callback_id: view.callback_id,
    };
    if (view.close) {
        updatedView.close = view.close;
    }

    await client.views.update({ view_id: view.id, hash: view.hash, view: updatedView });
  } catch (error: any) {
    Logger.error(error, "Error sharing result to channel from modal");
  }
});

/**
 * Handles sharing a result from the modal to a thread.
 */
app.action<BlockAction<ButtonAction>>(ACTION_IDS.SHARE_IN_THREAD_FROM_MODAL, async ({ ack, body, client, action }) => {
  await ack();
  const view = body.view;
  try {
    if (!view || !view.private_metadata) throw new Error("Cannot access required modal metadata.");

    const { url, title, query, snippet, metadata } = JSON.parse(action.value);
    const { channel_id, thread_ts, user_id } = JSON.parse(view.private_metadata);

    if (!channel_id) throw new Error("Channel ID not found in modal metadata.");
    if (!thread_ts) throw new Error("Thread timestamp not found for a thread share action.");

    await client.chat.postMessage({
      channel: channel_id,
      thread_ts: thread_ts,
      text: `${title} - Shared by <@${user_id}>`,
      blocks: createSharedResultBlocks(user_id, url, title, snippet || "", metadata || "", query),
    });

    const newBlocks = view.blocks.map(b => (b.block_id === action.block_id) ? { type: "context", elements: [{ type: "mrkdwn", text: "✅ *Result shared in thread successfully!*" }] } : b);

    const updatedView: View = {
        type: 'modal',
        title: view.title,
        blocks: newBlocks,
        private_metadata: view.private_metadata,
        callback_id: view.callback_id,
    };
    if (view.close) {
        updatedView.close = view.close;
    }

    await client.views.update({ view_id: view.id, hash: view.hash, view: updatedView });
  } catch (error: any) {
    Logger.error(error, "Error sharing result to thread from modal");
  }
});

export default app;
