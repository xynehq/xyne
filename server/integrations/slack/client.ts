import {
  App,
  LogLevel,
  type AllMiddlewareArgs,
  type SlackActionMiddlewareArgs,
} from "@slack/bolt";
import type { BlockAction, ButtonAction } from "@slack/bolt";
import type { View } from "@slack/types";
import type { WebClient, UsersInfoResponse } from "@slack/web-api";
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
  createAgentResponseModal,
  createSharedAgentResponseBlocks,
  createAllSourcesModal,
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

const Logger = getLogger(Subsystem.Slack);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Add basic error handler to log connection issues
app.error(async (error) => {
  Logger.error(error, "Slack app error occurred");
  // Don't exit the process, let it try to reconnect
});

// Add some debugging for the connection issues
Logger.info("Starting Slack app with Socket Mode");
Logger.info("Bot Token present:", !!process.env.SLACK_BOT_TOKEN);
Logger.info("App Token present:", !!process.env.SLACK_APP_TOKEN);

// Check if tokens look valid (should start with xoxb- and xapp-)
if (
  process.env.SLACK_BOT_TOKEN &&
  !process.env.SLACK_BOT_TOKEN.startsWith("xoxb-")
) {
  Logger.error("SLACK_BOT_TOKEN does not start with xoxb-");
}
if (
  process.env.SLACK_APP_TOKEN &&
  !process.env.SLACK_APP_TOKEN.startsWith("xapp-")
) {
  Logger.error("SLACK_APP_TOKEN does not start with xapp-");
}

/**
 * Interface for the data cached for each search interaction.
 */
interface SearchCacheEntry {
  query: string;
  results: any[];
  timestamp: number;
  isFromThread: boolean;
}

/**
 * Interface for the data cached for each agent interaction.
 */
interface AgentCacheEntry {
  query: string;
  agentName: string;
  response: string;
  citations: any[];
  timestamp: number;
  isFromThread: boolean;
}

interface DbUser {
  id: number;
  name: string;
  email: string;
  externalId: string;
  workspaceId: number;
  workspaceExternalId: string;
  role: string;
}

// --- Global Cache with TTL Management ---
declare global {
  var _searchResultsCache: Record<string, SearchCacheEntry>;
  var _agentResponseCache: Record<string, AgentCacheEntry>;
}
global._searchResultsCache = global._searchResultsCache || {};
global._agentResponseCache = global._agentResponseCache || {};
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const MODAL_RESULTS_DISPLAY_LIMIT = 5;
const SNIPPET_TRUNCATION_LENGTH = 200;

/**
 * Periodically cleans up expired entries from the search results cache.
 */
const cleanupCache = () => {
  try {
    const now = Date.now();
    let cleanedCount = 0;

    // Clean search cache
    for (const key in global._searchResultsCache) {
      if (now - global._searchResultsCache[key].timestamp > CACHE_TTL) {
        delete global._searchResultsCache[key];
        cleanedCount++;
      }
    }

    // Clean agent cache
    for (const key in global._agentResponseCache) {
      if (now - global._agentResponseCache[key].timestamp > CACHE_TTL) {
        delete global._agentResponseCache[key];
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      Logger.info(`Cleaned up ${cleanedCount} expired cache entries.`);
    }
  } catch (error) {
    Logger.error(error, "Error occurred during cache cleanup.");
  }
};
setInterval(cleanupCache, 5 * 60 * 1000);

/**
 * Defined separate, explicit action IDs for sharing from the modal
 * to a channel vs. to a thread to resolve ambiguity.
 */
const ACTION_IDS = {
  VIEW_SEARCH_MODAL: "view_search_modal",
  VIEW_AGENT_MODAL: "view_agent_modal",
  SHARE_RESULT_DIRECTLY: "share_result",
  SHARE_FROM_MODAL: "share_from_modal", // For sharing to the channel
  SHARE_IN_THREAD_FROM_MODAL: "share_in_thread_from_modal", // For sharing to a thread
  SHARE_AGENT_FROM_MODAL: "share_agent_from_modal", // For sharing agent responses
  SHARE_AGENT_IN_THREAD_FROM_MODAL: "share_agent_in_thread_from_modal", // For sharing agent responses to a thread
  VIEW_ALL_SOURCES: "view_all_sources", // For viewing all sources in a modal
};

// --- Event Handlers ---

app.event("app_mention", async ({ event, client }) => {
  Logger.info(`Received app_mention event: ${JSON.stringify(event.text)}`);

  const { user, text, channel, ts, thread_ts } = event;

  try {
    await client.conversations.join({ channel });

    if (!user) {
      Logger.warn("No user ID found in app_mention event");
      return;
    }

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
      await handleSearchQuery(
        client,
        channel,
        user,
        query,
        dbUser[0],
        ts,
        thread_ts ?? ""
      );
    } else if (processedText.startsWith("/")) {
      await handleAgentSearchCommand(
        client,
        channel,
        user,
        processedText,
        dbUser[0],
        ts,
        thread_ts ?? ""
      );
    } else {
      await handleHelpCommand(client, channel, user);
    }
  } catch (error: any) {
    Logger.error(error, "Error processing app_mention event");
    if (user) {
      await client.chat.postEphemeral({
        channel,
        user,
        text: `An unexpected error occurred: ${error.message}. Please try again.`,
      });
    }
  }
});

// --- Command Logic ---

const handleAgentsCommand = async (
  client: WebClient,
  channel: string,
  user: string,
  dbUser: DbUser
) => {
  Logger.info(`Listing agents for user ${dbUser.email}`);

  try {
    const agents = await getUserAccessibleAgents(
      db,
      dbUser.id,
      dbUser.workspaceId || 1,
      20,
      0
    );

    if (agents.length === 0) {
      await client.chat.postEphemeral({
        channel,
        user,
        text: "You don't have access to any agents yet. Please contact your administrator.",
      });
      return;
    }

    const agentBlocks: any[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🤖 *Available Agents (${agents.length})*\nYou can use any of these agents with \`/<agent_name> <your query>\``,
        },
      },
      { type: "divider" },
    ];

    agents.forEach((agent, index) => {
      agentBlocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${index + 1}. /${agent.name}*${
            agent.isPublic ? " 🌐" : ""
          }\n${agent.description || "No description available"}\n_Model: ${
            agent.model
          }_`,
        },
      });
    });

    agentBlocks.push(
      { type: "divider" },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "💡 *Usage:* `/<agent_name> your question here` | 🌐 = Public agent",
          },
        ],
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
  dbUser: DbUser,
  messageTs: string,
  threadTs: string | undefined
) => {
  // Add debug logging to see what we're processing
  Logger.info(
    `Processing agent command: "${agentCommand}" (length: ${agentCommand.length})`
  );

  // Parse the command: /agent_name query - trim any leading/trailing whitespace
  const trimmedCommand = agentCommand.trim();
  const match = trimmedCommand.match(/^\/([\w-]+)\s+(.+)$/);

  Logger.info(
    `Trimmed command: "${trimmedCommand}", Match result: ${
      match ? `[${match[0]}, ${match[1]}, ${match[2]}]` : "null"
    }`
  );

  if (!match) {
    await client.chat.postEphemeral({
      channel,
      user,
      text: "Invalid format. Use: `/<agent_name> your query here`\nExample: `/public-test-agent how to reset password`",
    });
    return;
  }

  const [, agentName, query] = match;
  Logger.info(
    `Agent search - Agent: ${agentName}, Query: "${query}" by user ${dbUser.email}`
  );

  try {
    // Get accessible agents and find the requested one
    const agents = await getUserAccessibleAgents(
      db,
      dbUser.id,
      dbUser.workspaceId || 1,
      100,
      0
    );
    const selectedAgent = agents.find(
      (agent) => agent.name.toLowerCase() === agentName.toLowerCase()
    );

    if (!selectedAgent) {
      const availableAgents = agents.map((a) => `/${a.name}`).join(", ");
      await client.chat.postEphemeral({
        channel,
        user,
        text: `Agent "/${agentName}" not found or not accessible to you.\n\nAvailable agents: ${availableAgents}\n\nUse \`/agents\` to see the full list with descriptions.`,
      });
      return;
    }

    const isThreadMessage = !!threadTs;

    Logger.info(
      `Starting agent chat with ${selectedAgent.name} for query: "${query}"`
    );

    // Show initial message to user
    await client.chat.postEphemeral({
      channel,
      user,
      text: `🤖 Querying the agent "/${agentName}"...`,
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
          text: `❌ You don't have permission to use agent "/${agentName}".`,
          ...(isThreadMessage && { thread_ts: threadTs }),
        });
        return;
      }

      const agentPrompt = JSON.stringify(agentConfig);

      // First, let's check if we need to classify the query or if the agent can answer directly
      const limitedMessages: any[] = []; // Empty for new conversation in Slack

      // Use the same classification logic as AgentMessageApi
      const searchOrAnswerIterator =
        generateSearchQueryOrAnswerFromConversation(query, ctx, {
          modelId: config.defaultBestModel,
          stream: true,
          json: true,
          reasoning: false,
          messages: limitedMessages,
          agentPrompt: agentPrompt,
        });

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
        },
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
        Logger.info(
          `Agent provided direct answer: ${finalResponse.substring(0, 100)}...`
        );
      } else {
        // Need to do RAG - use the rewritten query if available
        const searchQuery = parsed.queryRewrite || query;

        // Build classification object for RAG
        const classification = {
          direction: parsed.temporalDirection,
          type: (parsed.type as QueryType) || QueryType.SearchWithoutFilters,
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
          classification as any,
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

        Logger.info(
          `Agent RAG completed. Response length: ${finalResponse.length}, Citations: ${citations.length}`
        );
      }

      if (!finalResponse.trim()) {
        await client.chat.postEphemeral({
          channel,
          user,
          text: `🤖 Agent "/${agentName}" couldn't generate a response for "${query}". Try rephrasing your question.`,
          ...(isThreadMessage && { thread_ts: threadTs }),
        });
        return;
      }

      // Cache the agent response
      const interactionId = `agent_${user}_${messageTs}_${Date.now()}`;
      global._agentResponseCache[interactionId] = {
        query,
        agentName,
        response: finalResponse,
        citations,
        isFromThread: isThreadMessage,
        timestamp: Date.now(),
      };

      // Show button to view the agent response instead of full response
      await client.chat.postEphemeral({
        channel,
        user,
        text: `🤖 Agent "/${agentName}" response is ready.`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `🤖 Agent */${agentName}* has responded to your query: "_${query}_"\n${
                citations.length > 0
                  ? `📚 Found ${citations.length} relevant sources`
                  : "💭 Direct response from agent"
              }\nClick the button to view the full response.`,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                style: "primary",
                text: {
                  type: "plain_text",
                  text: "View Agent Response",
                  emoji: true,
                },
                action_id: ACTION_IDS.VIEW_AGENT_MODAL,
                value: interactionId,
              },
            ],
          },
        ],
        ...(isThreadMessage && { thread_ts: threadTs }),
      });
    } catch (agentError: any) {
      Logger.error(agentError, "Error in direct agent processing");
      await client.chat.postEphemeral({
        channel,
        user,
        text: `❌ I encountered an error while processing your request with agent "/${agentName}". Please try again later.`,
        ...(isThreadMessage && { thread_ts: threadTs }),
      });
    }
  } catch (error: any) {
    Logger.error(error, "Error in agent search command");
    await client.chat.postEphemeral({
      channel,
      user,
      text: `An error occurred while searching with agent "/${agentName}". Please try again.`,
    });
  }
};

const handleSearchQuery = async (
  client: WebClient,
  channel: string,
  user: string,
  query: string,
  dbUser: DbUser,
  messageTs: string,
  threadTs: string | undefined
) => {
  Logger.info(`Executing search for query: "${query}" by user ${dbUser.email}`);
  const isThreadMessage = !!threadTs;

  let results: any[] = [];
  try {
    const mockContext = {
      get: (key: string) =>
        key === config.JwtPayloadKey
          ? {
              sub: dbUser.email,
              workspaceId: dbUser.workspaceExternalId || "default",
              role: dbUser.role || "user",
            }
          : undefined,
      req: {
        valid: (type: "query") => ({
          query,
          groupCount: false,
          page: 10,
          app: null,
          entity: null,
          offset: 0,
          debug: false,
        }),
      },
      json: (data: any) => data,
    };
    const searchApiResponse = await SearchApi(mockContext as any);
    results = (searchApiResponse as any)?.results || [];
    Logger.info(`Found ${results.length} results from SearchApi.`);
  } catch (apiError) {
    Logger.error(apiError, "Error calling SearchApi");
    await client.chat.postEphemeral({
      channel,
      user,
      text: `I couldn't complete your search for "${query}". The search service might be down.`,
    });
    return;
  }

  if (results.length === 0) {
    await client.chat.postEphemeral({
      channel,
      user,
      text: `I couldn't find any results for "${query}". Try different keywords.`,
    });
    return;
  }

  const interactionId = `search_${user}_${messageTs}_${Date.now()}`;
  global._searchResultsCache[interactionId] = {
    query,
    results,
    isFromThread: isThreadMessage,
    timestamp: Date.now(),
  };

  await client.chat.postEphemeral({
    channel,
    user,
    text: `Search results for "${query}" are ready.`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🔍 I found *${results.length} results* for your query: "_${query}_"\nClick the button to view them.`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "View Results", emoji: true },
            action_id: ACTION_IDS.VIEW_SEARCH_MODAL,
            value: interactionId,
          },
        ],
      },
    ],
    ...(isThreadMessage && { thread_ts: threadTs }),
  });
};

const handleHelpCommand = async (
  client: WebClient,
  channel: string,
  user: string
) => {
  const botUserId = (await client.auth.test()).user_id;
  await client.chat.postEphemeral({
    channel,
    user,
    text: "Help - Available Commands",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*🤖 Available Commands:*" },
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*List Agents:*\n`/agents` - Shows all available agents you can use.\n_Example: `/agents`_",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Search with Agent:*\n`/<agent_name> <query>` - Search using a specific agent.\n_Example: `/support_bot password reset`_",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*General Search:*\n`/search <query>` - Search the knowledge base.\n_Example: `/search quarterly reports`_",
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Help:*\n`help` - Shows this message." },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `💡 Tip: Mention me (<@${botUserId}>) with a command!`,
          },
        ],
      },
    ],
  });
};

// --- Action Handlers ---

app.action(ACTION_IDS.VIEW_SEARCH_MODAL, async ({ ack, body, client }) => {
  await ack();
  const action = (body as BlockAction).actions[0];
  if (action.type !== "button") return;

  const interactionId = action.value;
  const cachedData = global._searchResultsCache[interactionId];

  try {
    if (!cachedData)
      throw new Error(`No cached search results found. They may have expired.`);

    const { query, results, isFromThread } = cachedData;
    const modal = createSearchResultsModal(query, results);

    if (isFromThread) {
      modal.blocks = modal.blocks.map((block: any) => {
        if (
          block.type === "actions" &&
          block.block_id?.startsWith("result_actions_")
        ) {
          (block as any).elements.push({
            type: "button",
            text: { type: "plain_text", text: "Share in Thread", emoji: true },
            action_id: ACTION_IDS.SHARE_IN_THREAD_FROM_MODAL,
            value: (block.elements[0] as ButtonAction).value,
          });
        }
        return block;
      });
    }

    await client.views.open({
      trigger_id: (body as BlockAction).trigger_id,
      view: {
        ...modal,
        callback_id: `search_results_modal`,
        private_metadata: JSON.stringify({
          channel_id: (body as BlockAction).channel?.id,
          thread_ts: (body as BlockAction).container?.thread_ts,
          user_id: (body as BlockAction).user.id,
        }),
      },
    });
    Logger.info(`Opened search results modal for user ${body.user.id}`);
  } catch (error: any) {
    Logger.error(
      error,
      `Error opening search modal for interaction ${interactionId}`
    );
    await client.chat.postEphemeral({
      channel: (body as BlockAction).channel!.id,
      user: (body as BlockAction).user.id,
      text: `Sorry, I couldn't open the results. ${error.message}. Please try again.`,
    });
  }
});

/**
 * Handles sharing a result from the modal to the main channel.
 */
const handleShareAction = async (
  {
    ack,
    body,
    client,
    action,
  }: SlackActionMiddlewareArgs<BlockAction<ButtonAction>> & AllMiddlewareArgs,
  isThreadShare: boolean
) => {
  await ack();
  const view = body.view;
  try {
    if (!view || !view.private_metadata)
      throw new Error("Cannot access required modal metadata.");

    const { url, title, query, snippet, metadata } = JSON.parse(action.value);
    const { channel_id, thread_ts, user_id } = JSON.parse(
      view.private_metadata
    );

    if (!channel_id) throw new Error("Channel ID not found in modal metadata.");
    if (isThreadShare && !thread_ts)
      throw new Error("Thread timestamp not found for a thread share action.");

    await client.chat.postMessage({
      channel: channel_id,
      thread_ts: isThreadShare ? thread_ts : undefined,
      text: `${title} - Shared by <@${user_id}>`,
      blocks: createSharedResultBlocks(
        user_id,
        url,
        title,
        snippet || "",
        metadata || "",
        query
      ),
    });

    const newBlocks = view.blocks.map((b: any) =>
      b.block_id === action.block_id
        ? {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `✅ *Result shared in ${
                  isThreadShare ? "thread" : "channel"
                } successfully!*`,
              },
            ],
          }
        : b
    );

    const updatedView: View = {
      type: "modal",
      title: view.title,
      blocks: newBlocks,
      private_metadata: view.private_metadata,
      callback_id: view.callback_id,
    };
    if (view.close) {
      updatedView.close = view.close;
    }

    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: updatedView,
    });
  } catch (error: any) {
    Logger.error(
      error,
      `Error sharing result to ${
        isThreadShare ? "thread" : "channel"
      } from modal`
    );
  }
};

app.action<BlockAction<ButtonAction>>(ACTION_IDS.SHARE_FROM_MODAL, (context) =>
  handleShareAction(context, false)
);

app.action<BlockAction<ButtonAction>>(
  ACTION_IDS.SHARE_IN_THREAD_FROM_MODAL,
  (context) => handleShareAction(context, true)
);

/**
 * Handles opening the agent response modal.
 */
app.action(ACTION_IDS.VIEW_AGENT_MODAL, async ({ ack, body, client }) => {
  await ack();
  const action = (body as BlockAction).actions[0];
  if (action.type !== "button") return;
  const interactionId = action.value;

  try {
    // Check for the special "no_interaction_id" case
    if (interactionId === "no_interaction_id") {
      throw new Error("Cannot open modal: No interaction ID available");
    }

    const cachedData = global._agentResponseCache[interactionId];
    if (!cachedData)
      throw new Error(`No cached agent response found. It may have expired.`);

    const { query, agentName, response, citations, isFromThread } = cachedData;
    const modal = createAgentResponseModal(
      query,
      agentName,
      response,
      citations,
      interactionId,
      isFromThread
    );

    if (isFromThread) {
      // Modify buttons for thread sharing if needed
      modal.blocks = modal.blocks.map((block: any) => {
        if (block.type === "actions" && (block as any).elements) {
          return {
            ...block,
            elements: (block as any).elements.map((element: any) => ({
              ...element,
              action_id:
                element.action_id === ACTION_IDS.SHARE_FROM_MODAL
                  ? ACTION_IDS.SHARE_IN_THREAD_FROM_MODAL
                  : element.action_id,
            })),
          };
        }
        return block;
      });
    }

    await client.views.open({
      trigger_id: (body as BlockAction).trigger_id,
      view: {
        ...modal,
        callback_id: `agent_response_modal`,
        private_metadata: JSON.stringify({
          channel_id: (body as BlockAction).channel?.id,
          thread_ts: (body as BlockAction).container.thread_ts,
          user_id: (body as BlockAction).user.id,
        }),
      },
    });
    Logger.info(
      `Opened agent response modal for user ${(body as BlockAction).user.id}`
    );
  } catch (error: any) {
    Logger.error(
      error,
      `Error opening agent modal for interaction ${interactionId}`
    );
    await client.chat.postEphemeral({
      channel: (body as BlockAction).channel!.id,
      user: (body as BlockAction).user.id,
      text: `Sorry, I couldn't open the agent response. ${error.message}. Please try again.`,
    });
  }
});

/**
 * Handles sharing an agent response from the modal to the main channel.
 */
app.action(
  ACTION_IDS.SHARE_AGENT_FROM_MODAL,
  async ({ ack, body, client, action }) => {
    await ack();
    const view = (body as BlockAction).view;
    try {
      if (!view || !view.private_metadata)
        throw new Error("Cannot access required modal metadata.");

      const interactionId = (action as ButtonAction).value;

      // Check for the special "no_interaction_id" case
      if (interactionId === "no_interaction_id") {
        throw new Error("Cannot share: No interaction ID available");
      }

      // Get agent response from cache
      const agentResponseData = global._agentResponseCache[interactionId];
      if (!agentResponseData) {
        throw new Error(
          "Agent response data not found in cache. The response may have expired."
        );
      }

      const { agentName, query, response, citations } = agentResponseData;
      const { channel_id, user_id } = JSON.parse(view.private_metadata);

      if (!channel_id)
        throw new Error("Channel ID not found in modal metadata.");

      await client.chat.postMessage({
        channel: channel_id,
        text: `Agent response from /${agentName} - Shared by <@${user_id}>`,
        blocks: createSharedAgentResponseBlocks(
          user_id,
          agentName,
          query,
          response,
          citations || []
        ),
      });

      const newBlocks = view.blocks.map((b: any) =>
        b.block_id === (action as ButtonAction).block_id
          ? {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: "✅ *Agent response shared in channel successfully!*",
                },
              ],
            }
          : b
      );

      const updatedView: View = {
        type: "modal",
        title: view.title,
        blocks: newBlocks,
        private_metadata: view.private_metadata,
        callback_id: view.callback_id,
      };
      if (view.close) {
        updatedView.close = view.close;
      }

      await client.views.update({
        view_id: view.id,
        hash: view.hash,
        view: updatedView,
      });
    } catch (error: any) {
      Logger.error(error, "Error sharing agent response to channel from modal");
    }
  }
);

/**
 * Handles sharing an agent response from the modal to a thread.
 */
app.action(
  ACTION_IDS.SHARE_AGENT_IN_THREAD_FROM_MODAL,
  async ({ ack, body, client, action }) => {
    await ack();
    const view = (body as BlockAction).view;
    try {
      if (!view || !view.private_metadata)
        throw new Error("Cannot access required modal metadata.");

      const interactionId = (action as ButtonAction).value;

      // Check for the special "no_interaction_id" case
      if (interactionId === "no_interaction_id") {
        throw new Error("Cannot share: No interaction ID available");
      }

      // Get agent response from cache
      const agentResponseData = global._agentResponseCache[interactionId];
      if (!agentResponseData) {
        throw new Error(
          "Agent response data not found in cache. The response may have expired."
        );
      }

      const { agentName, query, response, citations } = agentResponseData;
      const { channel_id, thread_ts, user_id } = JSON.parse(
        view.private_metadata
      );

      if (!channel_id)
        throw new Error("Channel ID not found in modal metadata.");
      if (!thread_ts)
        throw new Error(
          "Thread timestamp not found for a thread share action."
        );

      await client.chat.postMessage({
        channel: channel_id,
        thread_ts: thread_ts,
        text: `Agent response from /${agentName} - Shared by <@${user_id}>`,
        blocks: createSharedAgentResponseBlocks(
          user_id,
          agentName,
          query,
          response,
          citations || []
        ),
      });

      const newBlocks = view.blocks.map((b: any) =>
        b.block_id === (action as ButtonAction).block_id
          ? {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: "✅ *Agent response shared in thread successfully!*",
                },
              ],
            }
          : b
      );

      const updatedView: View = {
        type: "modal",
        title: view.title,
        blocks: newBlocks,
        private_metadata: view.private_metadata,
        callback_id: view.callback_id,
      };
      if (view.close) {
        updatedView.close = view.close;
      }

      await client.views.update({
        view_id: view.id,
        hash: view.hash,
        view: updatedView,
      });
    } catch (error: any) {
      Logger.error(error, "Error sharing agent response to thread from modal");
    }
  }
);

/**
 * Handles opening a modal to view all sources/citations.
 */
app.action(ACTION_IDS.VIEW_ALL_SOURCES, async ({ ack, body, client }) => {
  await ack();
  const action = (body as BlockAction).actions[0];
  if (action.type !== "button") return;
  const interactionId = action.value;

  try {
    // Check for the special "no_interaction_id" case
    if (interactionId === "no_interaction_id") {
      throw new Error("Cannot open sources: No interaction ID available");
    }

    const cachedData = global._agentResponseCache[interactionId];
    if (!cachedData)
      throw new Error(`No cached agent response found. It may have expired.`);

    const { query, agentName, citations } = cachedData;

    if (!citations || citations.length === 0) {
      throw new Error("No sources available for this response.");
    }

    const modal = createAllSourcesModal(agentName, query, citations);

    await client.views.open({
      trigger_id: (body as BlockAction).trigger_id,
      view: modal,
    });

    Logger.info(
      `Opened all sources modal for user ${(body as BlockAction).user.id}`
    );
  } catch (error: any) {
    Logger.error(
      error,
      `Error opening sources modal for interaction ${interactionId}`
    );

    // Try to show an error modal instead of ephemeral message since we're in a modal context
    try {
      await client.views.open({
        trigger_id: (body as BlockAction).trigger_id,
        view: {
          type: "modal",
          title: {
            type: "plain_text",
            text: "Error",
            emoji: true,
          },
          close: {
            type: "plain_text",
            text: "Close",
            emoji: true,
          },
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `❌ *Error opening sources*\n\n${error.message}\n\nPlease try again or contact support if the issue persists.`,
              },
            },
          ],
        },
      });
    } catch (modalError) {
      Logger.error(modalError, "Failed to show error modal");
      // If we can't show a modal, try to get channel info from the current modal
      const view = (body as BlockAction).view;
      let channelId;
      try {
        if (view?.private_metadata) {
          const metadata = JSON.parse(view.private_metadata);
          channelId = metadata.channel_id;
        }
      } catch (parseError) {
        Logger.warn("Could not parse modal private_metadata for error message");
      }

      if (channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: (body as BlockAction).user.id,
          text: `Sorry, I couldn't open the sources. ${error.message}. Please try again.`,
        });
      }
    }
  }
});

export default app;
