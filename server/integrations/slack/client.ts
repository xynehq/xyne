import { WebClient } from "@slack/web-api";
import { SocketModeClient, type LogLevel } from "@slack/socket-mode";
import type { View } from "@slack/types";
import { db } from "@/db/client";
import { getUserByEmail } from "@/db/user";
import { getLogger } from "@/logger";
import { Subsystem } from "@/types";
import { SearchApi } from "@/api/search";
import config from "@/config";
import {
  createSearchResultsModal,
  createSharedResultBlocks,
  createAgentResponseModal,
  createSharedAgentResponseBlocks,
  createAllSourcesModal,
} from "./formatters";
import {
  type SearchCacheEntry,
  type AgentCacheEntry,
  type DbUser,
} from "./types";
import {
  CACHE_TTL,
  ACTION_IDS,
} from "./config";
import { getUserAccessibleAgents } from "@/db/userAgentPermission";
import { getUserAndWorkspaceByEmail } from "@/db/user";
import { UnderstandMessageAndAnswer } from "@/api/chat/chat";
import { generateSearchQueryOrAnswerFromConversation } from "@/ai/provider";
import { userContext } from "@/ai/context";
import { getAgentByExternalIdWithPermissionCheck } from "@/db/agent";
import { QueryType } from "@/ai/types";
import { Apps } from "@/search/types";
import { getTracer } from "@/tracer";

const Logger = getLogger(Subsystem.Slack);

// Check if Slack environment variables are available
const hasSlackConfig = !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);

if (!hasSlackConfig) {
  Logger.warn("Slack BOT_TOKEN and/or SLACK_APP_TOKEN not set. Slack integration will be disabled.");
  Logger.info("To enable Slack integration, set SLACK_BOT_TOKEN and SLACK_APP_TOKEN environment variables.");
}

let webClient: WebClient | null = null;
let socketModeClient: SocketModeClient | null = null;
let isSocketModeConnected = false;

// Event deduplication
const processedEvents = new Set<string>();
const EVENT_CACHE_TTL = 30000; // 30 seconds

// Clean up old processed events periodically
setInterval(() => {
  processedEvents.clear();
}, EVENT_CACHE_TTL);

// --- Global Cache with TTL Management ---
declare global {
  var _searchResultsCache: Record<string, SearchCacheEntry>;
  var _agentResponseCache: Record<string, AgentCacheEntry>;
}
global._searchResultsCache = global._searchResultsCache || {};
global._agentResponseCache = global._agentResponseCache || {};

// Socket Mode implementation using official Slack SDK
const connectSocketMode = async (): Promise<void> => {
  if (!webClient || !process.env.SLACK_APP_TOKEN) {
    Logger.error("Cannot connect to Socket Mode: missing WebClient or APP_TOKEN");
    return;
  }

  try {
    Logger.info("Attempting to connect to Slack Socket Mode...");
    
    // Create Socket Mode client
    socketModeClient = new SocketModeClient({
      appToken: process.env.SLACK_APP_TOKEN,
      logLevel: 'warn' as LogLevel, // Reduce log noise
    });

    // Set up event handlers
    socketModeClient.on('connected', () => {
      Logger.info("Socket Mode WebSocket connected successfully");
      isSocketModeConnected = true;
    });

    socketModeClient.on('disconnected', () => {
      Logger.warn("Socket Mode WebSocket disconnected");
      isSocketModeConnected = false;
    });

    socketModeClient.on('error', (error) => {
      Logger.error(error, "Socket Mode WebSocket error");
    });

    // Handle app_mention events
    socketModeClient.on('app_mention', async ({ event, ack }) => {
      try {
        await ack();
        
        // Create unique event ID for deduplication
        const eventId = `${event.type}_${event.ts}_${event.user}_${event.channel}`;
        
        if (processedEvents.has(eventId)) {
          Logger.info(`Skipping duplicate event: ${eventId}`);
          return;
        }
        
        processedEvents.add(eventId);
        Logger.info(`Received Socket Mode event: ${event.type}`);
        await processSlackEvent(event);
      } catch (error) {
        Logger.error(error, "Error handling app_mention event");
      }
    });

    // Handle interactive components (buttons, modals, etc.)
    socketModeClient.on('interactive', async (args) => {
      try {
        // Log the full args structure to understand what we're receiving
        Logger.info(`Received interactive event with args:`, JSON.stringify(args, null, 2));
        
        await args.ack();
        
        // Try different ways to access the payload
        const payload = args.payload || args.body || args;
        
        if (!payload) {
          Logger.warn("Received interactive event with undefined payload after checking args.payload, args.body, and args");
          Logger.warn("Full args structure:", JSON.stringify(args, null, 2));
          return;
        }
        
        // Create unique interaction ID for deduplication
        const interactionId = `interactive_${payload.trigger_id || 'unknown'}_${payload.user?.id || 'unknown'}`;
        
        if (processedEvents.has(interactionId)) {
          Logger.info(`Skipping duplicate interaction: ${interactionId}`);
          return;
        }
        
        processedEvents.add(interactionId);
        Logger.info("Received Socket Mode interactive component");
        await processSlackInteraction(payload);
      } catch (error) {
        Logger.error(error, "Error handling interactive component");
        Logger.error("Args structure when error occurred:", JSON.stringify(args, null, 2));
      }
    });

    // Start the Socket Mode connection
    await socketModeClient.start();
    Logger.info("Socket Mode client started successfully");

  } catch (error) {
    Logger.error(error, "Failed to connect to Socket Mode");
    socketModeClient = null;
    throw error;
  }
};

// Only initialize Slack client if environment variables are present
if (hasSlackConfig) {
  // Validate token formats
  if (!process.env.SLACK_BOT_TOKEN!.startsWith("xoxb-")) {
    Logger.error("SLACK_BOT_TOKEN does not start with xoxb-. Slack integration disabled.");
  } else if (!process.env.SLACK_APP_TOKEN!.startsWith("xapp-")) {
    Logger.error("SLACK_APP_TOKEN does not start with xapp-. Slack integration disabled.");
  } else {
    try {
      webClient = new WebClient(process.env.SLACK_BOT_TOKEN);
      Logger.info("Slack Web API client initialized");

      /**
       * Periodically cleans up expired entries from the search results cache.
       */
      const cleanupCache = async () => {
        const maxRetries = 3;
        const baseDelay = 1000; // 1 second

        for (let attempt = 0; attempt < maxRetries; attempt++) {
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

            // Success - exit retry loop
            return;
          } catch (error) {
            const isLastAttempt = attempt === maxRetries - 1;

            if (isLastAttempt) {
              Logger.error(
                error,
                `Cache cleanup failed after ${maxRetries} attempts`
              );
              return;
            }

            // Calculate exponential backoff delay
            const delay = baseDelay * Math.pow(2, attempt);
            Logger.warn(
              error,
              `Cache cleanup failed on attempt ${attempt + 1}, retrying in ${delay}ms`
            );

            // Wait before retry
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      };

      // Use setInterval with async function wrapper
      setInterval(() => {
        cleanupCache().catch((error) => {
          Logger.error(error, "Unexpected error in cache cleanup interval");
        });
      }, 5 * 60 * 1000);

      // Note: Socket Mode connection will be started via startSocketMode() from server.ts

    } catch (error) {
      Logger.error(error, "Failed to initialize Slack Web API client. Slack integration disabled.");
      webClient = null;
    }
  }
}

// --- Command Logic ---
const handleAgentsCommand = async (
  client: WebClient,
  channel: string,
  user: string,
  dbUser: DbUser
) => {
  Logger.info(`Listing agents for user ${dbUser.email}`);

  try {
    // Validate workspaceId before proceeding
    if (!dbUser.workspaceId || dbUser.workspaceId <= 0) {
      Logger.error(`Invalid or missing workspaceId for user ${dbUser.email}: ${dbUser.workspaceId}`);
      await client.chat.postEphemeral({
        channel,
        user,
        text: "There's an issue with your workspace configuration. Please contact your administrator.",
      });
      return;
    }

    const agents = await getUserAccessibleAgents(
      db,
      dbUser.id,
      dbUser.workspaceId,
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

    agents.forEach((agent: any, index: number) => {
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
  const match = trimmedCommand.match(/^\/([a-zA-Z0-9_-]+)\s+(.+)$/);

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
    // Validate workspaceId before proceeding
    if (!dbUser.workspaceId || dbUser.workspaceId <= 0) {
      Logger.error(`Invalid or missing workspaceId for user ${dbUser.email}: ${dbUser.workspaceId}`);
      await client.chat.postEphemeral({
        channel,
        user,
        text: "There's an issue with your workspace configuration. Please contact your administrator.",
      });
      return;
    }

    // Get accessible agents and find the requested one
    const agents = await getUserAccessibleAgents(
      db,
      dbUser.id,
      dbUser.workspaceId,
      100,
      0
    );
    const selectedAgent = agents.find(
      (agent: any) => agent.name.toLowerCase() === agentName.toLowerCase()
    );

    if (!selectedAgent) {
      const availableAgents = agents.map((a: any) => `/${a.name}`).join(", ");
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
      text: `Querying the agent "/${agentName}"...`,
      ...(isThreadMessage && { thread_ts: threadTs }),
    });

    try {
      // Validate workspaceExternalId before using it
      if (!dbUser.workspaceExternalId) {
        Logger.error(`Missing workspaceExternalId for user ${dbUser.email}`);
        await client.chat.postEphemeral({
          channel,
          user,
          text: "Your workspace ID is not configured correctly. Please contact your administrator.",
          ...(isThreadMessage && { thread_ts: threadTs }),
        });
        return;
      }
      // Get user and workspace data using the proper function
      const userAndWorkspace = await getUserAndWorkspaceByEmail(
        db,
        dbUser.workspaceExternalId,
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

        let errorMessage = `❌ You don't have permission to use agent "/${agentName}".`;

        if (selectedAgent.isPublic) {
          errorMessage += `\n\n🌐 This is a **public agent**, but you may need additional permissions or there might be a workspace configuration issue.`;
        } else {
          errorMessage += `\n\n🔒 This is a **private agent** that requires explicit access permissions.`;
        }

        errorMessage += `\n\n**What you can do:**\n• Use \`/agents\` to see all available agents\n• Contact your workspace administrator to request access\n• Try using a different agent from your available list`;
        errorMessage += `\n\n**For administrators:** Check agent permissions in the workspace settings or verify the agent configuration.`;

        await client.chat.postEphemeral({
          channel,
          user,
          text: errorMessage,
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
          
          // Only attempt to parse if buffer has content and looks like JSON
          if (buffer.trim() && (buffer.trim().startsWith('{') || buffer.trim().startsWith('['))) {
            try {
              parsed = JSON.parse(buffer) || {};
            } catch (err) {
              // Continue if we can't parse yet (incomplete JSON)
              continue;
            }
          }
        }
      }

      // Final validation: ensure we have a valid parsed object after streaming completes
      if (buffer.trim() && !parsed) {
        try {
          parsed = JSON.parse(buffer) || {};
        } catch (err) {
          Logger.warn(err, `Failed to parse final buffer content: ${buffer.substring(0, 100)}...`);
          // Set default values if parsing fails completely
          parsed = {
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
          text: `Agent "/${agentName}" couldn't generate a response for "${query}". Try rephrasing your question.`,
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
        text: `Agent "/${agentName}" response is ready.`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `Agent */${agentName}* has responded to your query: "_${query}_"\n${
                citations.length > 0
                  ? `Found ${citations.length} relevant sources`
                  : "Direct response from agent"
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

const executeSearch = async (
  userEmail: string,
  workspaceExternalId: string,
  query: string,
  options: {
    groupCount?: boolean;
    page?: number;
    app?: string | null;
    entity?: string | null;
    offset?: number;
    debug?: boolean;
  } = {}
): Promise<any[]> => {
  try {
    // Get user and workspace data properly
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceExternalId,
      userEmail
    );

    if (!userAndWorkspace) {
      throw new Error("User or workspace not found");
    }

    // Create proper context with actual authentication data
    const ctx = userContext(userAndWorkspace);
    
    // Create a proper request context for the search API
    const searchContext = {
      get: (key: string) => {
        if (key === config.JwtPayloadKey) {
          return {
            sub: userAndWorkspace.user.email,
            workspaceId: userAndWorkspace.workspace.externalId,
            role: userAndWorkspace.user.role,
            userId: userAndWorkspace.user.id,
            workspaceIdInternal: userAndWorkspace.workspace.id,
          };
        }
       return undefined;
      },
      req: {
        valid: (type: "query") => ({
          query,
          groupCount: options.groupCount || false,
          page: options.page || 10,
          app: options.app || null,
          entity: options.entity || null,
          offset: options.offset || 0,
          debug: options.debug || false,
        }),
      },
      json: (data: any) => data,
    };

    const searchApiResponse = await SearchApi(searchContext as any);
    return (searchApiResponse as any)?.results || [];
  } catch (error) {
    Logger.error(error, "Error in executeSearch function");
    throw error;
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
    // Validate workspaceExternalId before using it
    if (!dbUser.workspaceExternalId) {
      Logger.error(`Missing workspaceExternalId for user ${dbUser.email}`);
      await client.chat.postEphemeral({
        channel,
        user,
        text: "Your workspace ID is not configured correctly. Please contact your administrator.",
      });
      return;
    }
    // Use the new secure search function
    results = await executeSearch(
      dbUser.email,
      dbUser.workspaceExternalId,
      query,
      {
        groupCount: false,
        page: 10,
        app: null,
        entity: null,
        offset: 0,
        debug: false,
      }
    );
    
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
        text: { type: "mrkdwn", text: "*Available Commands:*" },
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

// --- Event Processing Function (to be called by external webhook handler) ---
export const processSlackEvent = async (event: any) => {
  if (!webClient) {
    Logger.warn("Slack client not initialized, ignoring event");
    return;
  }

  if (event.type === "app_mention") {
    Logger.info(`Received app_mention event: ${JSON.stringify(event.text)}`);

    const { user, text, channel, ts, thread_ts } = event;

    try {
      await webClient.conversations.join({ channel });

      if (!user) {
        Logger.warn("No user ID found in app_mention event");
        return;
      }

      const userInfo = await webClient.users.info({ user });
      if (!userInfo.ok || !userInfo.user?.profile?.email) {
        Logger.warn(`Could not retrieve email for user ${user}.`);
        await webClient.chat.postEphemeral({
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
        await webClient.chat.postEphemeral({
          channel,
          user,
          text: "It seems you're not registered in our system. Please contact support.",
        });
        return;
      }

      const processedText = text.replace(/<@.*?>\s*/, "").trim();

      if (processedText.toLowerCase().startsWith("/agents")) {
        await handleAgentsCommand(webClient, channel, user, dbUser[0]);
      } else if (processedText.toLowerCase().startsWith("/search ")) {
        const query = processedText.substring(8).trim();
        await handleSearchQuery(
          webClient,
          channel,
          user,
          query,
          dbUser[0],
          ts,
          thread_ts ?? ""
        );
      } else if (processedText.startsWith("/")) {
        await handleAgentSearchCommand(
          webClient,
          channel,
          user,
          processedText,
          dbUser[0],
          ts,
          thread_ts ?? ""
        );
      } else {
        await handleHelpCommand(webClient, channel, user);
      }
    } catch (error: any) {
      Logger.error(error, "Error processing app_mention event");
      if (user) {
        await webClient.chat.postEphemeral({
          channel,
          user,
          text: `An unexpected error occurred: ${error.message}. Please try again.`,
        });
      }
    }
  }
};

// --- Interactive Component Handler (to be called by external webhook handler) ---
export const processSlackInteraction = async (payload: any) => {
  if (!webClient) {
    Logger.warn("Slack client not initialized, ignoring interaction");
    return;
  }

  // Add null checks and safer destructuring
  if (!payload) {
    Logger.warn("Received null/undefined payload in processSlackInteraction");
    return;
  }

  const type = payload.type;
  const actions = payload.actions;
  const trigger_id = payload.trigger_id;
  const view = payload.view;
  const channel = payload.channel;
  const user = payload.user;
  const container = payload.container;

  if (type === "block_actions" && actions?.[0]) {
    const action = actions[0];
    
    try {
      // Log the payload structure for debugging
      Logger.info(`Processing action: ${action.action_id}, trigger_id: ${trigger_id}`);
      
      switch (action.action_id) {
        case ACTION_IDS.VIEW_SEARCH_MODAL:
          await handleViewSearchModal(action, trigger_id, channel, user, container);
          break;
        case ACTION_IDS.VIEW_AGENT_MODAL:
          await handleViewAgentModal(action, trigger_id, channel, user, container);
          break;
        case ACTION_IDS.SHARE_FROM_MODAL:
          await handleShareFromModal(action, view, false);
          break;
        case ACTION_IDS.SHARE_IN_THREAD_FROM_MODAL:
          await handleShareFromModal(action, view, true);
          break;
        case ACTION_IDS.SHARE_AGENT_FROM_MODAL:
          await handleShareAgentFromModal(action, view, false);
          break;
        case ACTION_IDS.SHARE_AGENT_IN_THREAD_FROM_MODAL:
          await handleShareAgentFromModal(action, view, true);
          break;
        case ACTION_IDS.VIEW_ALL_SOURCES:
          await handleViewAllSources(action, trigger_id, view);
          break;
        default:
          Logger.warn(`Unknown action_id: ${action.action_id}`);
      }
    } catch (error: any) {
      Logger.error(error, `Error handling action ${action.action_id}`);
      Logger.error(`Payload structure:`, JSON.stringify(payload, null, 2));
    }
  }
};

// --- Individual Action Handlers ---
const handleViewSearchModal = async (
  action: any,
  trigger_id: string,
  channel: any,
  user: any,
  container: any
) => {
  try {
    // Validate required parameters
    if (!trigger_id) {
      throw new Error("Missing trigger_id for modal");
    }
    
    if (!user?.id) {
      throw new Error("Missing user information for modal");
    }

    const interactionId = action?.value;
    if (!interactionId) {
      throw new Error("No interaction ID provided");
    }

    const cachedData = global._searchResultsCache[interactionId];
    if (!cachedData) {
      throw new Error(`No cached search results found. They may have expired.`);
    }

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
            value: (block.elements[0] as any).value,
          });
        }
        return block;
      });
    }

    Logger.info(`Attempting to open search modal with trigger_id: ${trigger_id}`);

    await webClient!.views.open({
      trigger_id: trigger_id,
      view: {
        ...modal,
        callback_id: `search_results_modal`,
        private_metadata: JSON.stringify({
          channel_id: channel?.id,
          thread_ts: container?.thread_ts || undefined,
          user_id: user.id,
        }),
      },
    });
    
    Logger.info(`Successfully opened search results modal for user ${user.id}`);
  } catch (error: any) {
    Logger.error(
      error,
      `Error opening search modal. trigger_id: ${trigger_id}, user: ${user?.id}, channel: ${channel?.id}`
    );
    
    if (channel?.id && user?.id) {
      await webClient!.chat.postEphemeral({
        channel: channel.id,
        user: user.id,
        text: `Sorry, I couldn't open the results. ${error.message}. Please try again.`,
      });
    } else {
      Logger.warn("Could not send error message - missing channel or user information");
    }
  }
};

const handleViewAgentModal = async (
  action: any,
  trigger_id: string,
  channel: any,
  user: any,
  container: any
) => {
  try {
    // Validate required parameters
    if (!trigger_id) {
      throw new Error("Missing trigger_id for modal");
    }
    
    if (!user?.id) {
      throw new Error("Missing user information for modal");
    }

    const interactionId = action?.value;
    if (interactionId === "no_interaction_id" || !interactionId) {
      throw new Error("Cannot open modal: No interaction ID available");
    }

    const cachedData = global._agentResponseCache[interactionId];
    if (!cachedData) {
      throw new Error(`No cached agent response found. It may have expired.`);
    }

    const { query, agentName, response, citations, isFromThread } = cachedData;
    
    if (!query || !agentName || !response) {
      throw new Error("Invalid cached data - missing required fields");
    }

    const modal = createAgentResponseModal(
      query,
      agentName,
      response,
      citations || [],
      interactionId,
      isFromThread || false
    );

    if (isFromThread) {
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

    Logger.info(`Attempting to open agent modal with trigger_id: ${trigger_id}`);

    await webClient!.views.open({
      trigger_id: trigger_id,
      view: {
        ...modal,
        callback_id: `agent_response_modal`,
        private_metadata: JSON.stringify({
          channel_id: channel?.id,
          thread_ts: container?.thread_ts,
          user_id: user.id,
        }),
      },
    });
    
    Logger.info(`Successfully opened agent response modal for user ${user.id}`);
  } catch (error: any) {
    Logger.error(
      error,
      `Error opening agent modal. trigger_id: ${trigger_id}, user: ${user?.id}, channel: ${channel?.id}`
    );
    
    if (channel?.id && user?.id) {
      await webClient!.chat.postEphemeral({
        channel: channel.id,
        user: user.id,
        text: `Sorry, I couldn't open the agent response. ${error.message}. Please try again.`,
      });
    } else {
      Logger.warn("Could not send error message - missing channel or user information");
    }
  }
};

const handleShareFromModal = async (
  action: any,
  view: any,
  isThreadShare: boolean
) => {
  try {
    if (!view || !view.private_metadata) {
      throw new Error("Cannot access required modal metadata.");
    }

    if (!action.value) {
      throw new Error("No action value provided");
    }
    
    const { url, title, query, snippet, metadata } = JSON.parse(action.value);
    const { channel_id, thread_ts, user_id } = JSON.parse(view.private_metadata);

    if (!channel_id) throw new Error("Channel ID not found in modal metadata.");
    if (isThreadShare && !thread_ts)
      throw new Error("Thread timestamp not found for a thread share action.");

    await webClient!.chat.postMessage({
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

    await webClient!.views.update({
      view_id: view.id,
      hash: view.hash,
      view: updatedView,
    });
  } catch (error: any) {
    Logger.error(
      error,
      `Error sharing result to ${isThreadShare ? "thread" : "channel"} from modal`
    );
    
    if (view?.private_metadata) {
      try {
        const metadata = JSON.parse(view.private_metadata);
        const channelId = metadata?.channel_id;
        const userId = metadata?.user_id;
        
        if (channelId && userId) {
          await webClient!.chat.postEphemeral({
            channel: channelId,
            user: userId,
            text: `Sorry, I couldn't share the result. ${error.message}. Please try again.`,
          });
        }
      } catch (parseError) {
        Logger.warn("Could not parse modal metadata for error message");
      }
    }
  }
};

const handleShareAgentFromModal = async (
  action: any,
  view: any,
  isThreadShare: boolean
) => {
  try {
    if (!view || !view.private_metadata)
      throw new Error("Cannot access required modal metadata.");

    const interactionId = action.value;

    if (interactionId === "no_interaction_id" || !interactionId) {
      throw new Error("Cannot share: No interaction ID available");
    }

    const agentResponseData = global._agentResponseCache[interactionId];
    if (!agentResponseData) {
      throw new Error(
        "Agent response data not found in cache. The response may have expired."
      );
    }

    const { agentName, query, response, citations } = agentResponseData;
    const { channel_id, thread_ts, user_id } = JSON.parse(view.private_metadata);

    if (!channel_id)
      throw new Error("Channel ID not found in modal metadata.");
    if (isThreadShare && !thread_ts)
      throw new Error("Thread timestamp not found for a thread share action.");

    await webClient!.chat.postMessage({
      channel: channel_id,
      thread_ts: isThreadShare ? thread_ts : undefined,
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
      b.block_id === action.block_id
        ? {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `✅ *Agent response shared in ${
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

    await webClient!.views.update({
      view_id: view.id,
      hash: view.hash,
      view: updatedView,
    });
  } catch (error: any) {
    Logger.error(
      error,
      `Error sharing agent response to ${isThreadShare ? "thread" : "channel"} from modal`
    );
  }
};

const handleViewAllSources = async (
  action: any,
  trigger_id: string,
  view: any
) => {
  const interactionId = action.value;

  try {
    if (interactionId === "no_interaction_id" || !interactionId) {
      throw new Error("Cannot open sources: No interaction ID available");
    }

    const cachedData = global._agentResponseCache[interactionId];
    if (!cachedData) {
      throw new Error(`No cached agent response found. It may have expired.`);
    }

    const { query, agentName, citations } = cachedData;
    
    if (!query || !agentName) {
      throw new Error("Invalid cached data - missing required fields");
    }

    if (!citations || citations.length === 0) {
      throw new Error("No sources available for this response.");
    }

    const modal = createAllSourcesModal(agentName, query, citations);

    await webClient!.views.open({
      trigger_id: trigger_id,
      view: modal,
    });

    Logger.info(`Opened all sources modal for interaction ${interactionId}`);
  } catch (error: any) {
    Logger.error(
      error,
      `Error opening sources modal for interaction ${interactionId}`
    );

    try {
      const errorDetails = error.message.includes('No interaction ID') 
        ? 'The response data has expired or is no longer available.'
        : error.message.includes('No cached agent response')
        ? 'The response data has expired. Please run your query again.'
        : error.message.includes('No sources available')
        ? 'This response was generated without source citations.'
        : `Unexpected error: ${error.message}`;

      const troubleshootingTips = error.message.includes('expired') || error.message.includes('No cached')
        ? '\n\n**What to do:**\n• Run your agent query again\n• The system keeps responses for 10 minutes only'
        : error.message.includes('No sources')
        ? '\n\n**Note:** This response was generated from the agent\'s training data without citing external sources.'
        : '\n\n**Troubleshooting:**\n• Try refreshing and running the query again\n• Contact support if the issue persists';

      await webClient!.views.open({
        trigger_id: trigger_id,
        view: {
          type: "modal",
          title: {
            type: "plain_text",
            text: "Unable to Open Sources",
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
                text: `❌ *Could not display sources*\n\n${errorDetails}${troubleshootingTips}`,
              },
            },
          ],
        },
      });
    } catch (modalError) {
      Logger.error(modalError, "Failed to show error modal");
    }
  }
};

// Export Socket Mode status and control functions
export const getSocketModeStatus = () => isSocketModeConnected;
export const startSocketMode = async () => {
  if (hasSlackConfig && webClient && !isSocketModeConnected && !socketModeClient) {
    await connectSocketMode();
    return true;
  }
  Logger.info("Socket Mode already connected or configuration missing");
  return false;
};

// Export the client and utility functions
export const getSlackClient = () => webClient;
export const isSlackEnabled = () => webClient !== null;

// Export for backward compatibility (remove after updating server.ts)
export default {
  processSlackEvent,
  processSlackInteraction,
  isSlackEnabled,
  getSlackClient,
  startSocketMode,
  isSocketModeConnected,
};
