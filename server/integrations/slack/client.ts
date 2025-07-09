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
  createErrorBlocks,
} from "./formatters";
import {
  createId
} from "@paralleldrive/cuid2";
import {
  insertMessage,
  getMessageByExternalId
} from "@/db/message";
import {
  getChatByExternalId,
  insertChat
} from "@/db/chat";
import {
  MessageRole
} from "@/types";
import {
  type SearchCacheEntry,
  type AgentCacheEntry,
  type DbUser,
} from "./types";
import {
  ACTION_IDS,
  EVENT_CACHE_TTL
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

const truncateObjectForLog = (obj: any, maxLength: number = 100): string => {
  if (obj === undefined || obj === null) {
    return "";
  }
  // For strings, just truncate
  if (typeof obj === 'string') {
    return obj.length > maxLength ? obj.substring(0, maxLength) + '...' : obj;
  }
  // For other objects, stringify and truncate
  try {
    const str = JSON.stringify(obj);
    if (str.length > maxLength) {
      return str.substring(0, maxLength) + "...(truncated)";
    }
    return str;
  } catch {
    return "Unserializable object";
  }
};

const handleError = async (
  error: any,
  context: {
    client: WebClient;
    channel?: string;
    user?: string;
    threadTs?: string;
    action?: string;
    payload?: any;
  }
) => {
  const errorId = createId();
  const { client, channel, user, threadTs, action, payload } = context;

  Logger.error(
    {
      errorId,
      action,
      channel,
      user,
      threadTs,
      error: truncateObjectForLog(error.message, 200),
      stack: truncateObjectForLog(error.stack, 300),
      payload: truncateObjectForLog(payload, 500),
    },
    `Slack Action Failed: ${action}`
  );

  if (client && channel && user) {
    try {
      await client.chat.postEphemeral({
        channel,
        user,
        thread_ts: threadTs,
        text: "An unexpected error occurred.",
        blocks: createErrorBlocks(
          error.message || "An internal error occurred. Please try again later.",
          errorId,
          `Error during: ${action}`
        ),
      });
    } catch (postError: any) {
      Logger.error(
        {
          errorId,
          originalError: truncateObjectForLog(error.message),
          postError: truncateObjectForLog(postError.message),
        },
        "Failed to post error message to Slack"
      );
    }
  }
};

const getOrCreateChat = async (
  chatExternalId: string,
  dbUser: DbUser,
) => {
  try {
    const chat = await getChatByExternalId(db, chatExternalId);
    return chat;
  } catch (error) {
    // Chat not found, create a new one
    const newChat = await insertChat(db, {
      workspaceId: dbUser.workspaceId,
      userId: dbUser.id,
      title: "Slack Chat",
      email: dbUser.email,
      workspaceExternalId: dbUser.workspaceExternalId,
      attachments: [],
    });
    return newChat;
  }
};

// Check if Slack environment variables are available
const hasSlackConfig = !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);

if (!hasSlackConfig) {
  Logger.warn("Slack BOT_TOKEN and/or SLACK_APP_TOKEN not set. Slack integration will be disabled.");
  Logger.info("To enable Slack integration, set SLACK_BOT_TOKEN and SLACK_APP_TOKEN environment variables.");
}

let webClient: WebClient | null = null;
let socketModeClient: SocketModeClient | null = null;
let isSocketModeConnected = false;

// Event deduplication with timestamp-based expiry
const processedEvents = new Map<string, number>();

// Clean up expired events periodically
const cleanupExpiredEvents = () => {
  const now = Date.now();
  const expiredEvents: string[] = [];
  
  for (const [eventId, timestamp] of processedEvents.entries()) {
    if (now - timestamp > EVENT_CACHE_TTL) {
      expiredEvents.push(eventId);
    }
  }
  
  for (const eventId of expiredEvents) {
    processedEvents.delete(eventId);
  }
  
  if (expiredEvents.length > 0) {
    Logger.debug(`Cleaned up ${expiredEvents.length} expired event entries`);
  }
};

setInterval(cleanupExpiredEvents, EVENT_CACHE_TTL / 2); // Run cleanup twice as often as TTL


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
      const { user, channel, thread_ts } = event;
      try {
        await ack();
        
        // Create unique event ID for deduplication
        const eventId = `${event.type}_${event.ts}_${event.user}_${event.channel}`;
        const now = Date.now();
        
        // Check if event was already processed recently
        const lastProcessedTime = processedEvents.get(eventId);
        if (lastProcessedTime && (now - lastProcessedTime) < EVENT_CACHE_TTL) {
          Logger.info(`Skipping duplicate event: ${eventId} (last processed ${now - lastProcessedTime}ms ago)`);
          return;
        }
        
        processedEvents.set(eventId, now);
        Logger.info({ event: truncateObjectForLog(event) }, `Received Socket Mode event: ${event.type}`);
        await processSlackEvent(event);
      } catch (error: any) {
        await handleError(error, {
          client: webClient!,
          channel,
          user,
          threadTs: thread_ts,
          action: "app_mention",
          payload: event,
        });
      }
    });

    // Handle interactive components (buttons, modals, etc.)
    socketModeClient.on('interactive', async (args) => {
      const payload = args.payload || args.body || args;
      const user = payload?.user?.id;
      const channel = payload?.channel?.id || payload?.container?.channel_id;
      const threadTs = payload?.container?.thread_ts;

      try {
        // Log the full args structure to understand what we're receiving
        Logger.info({ payload: truncateObjectForLog(args) }, `Received interactive event`);
        
        await args.ack();
        
        if (!payload) {
          Logger.warn({ args: truncateObjectForLog(args) }, "Received interactive event with undefined payload");
          return;
        }
        
        // Create unique interaction ID for deduplication
        const interactionId = `interactive_${payload.trigger_id || 'unknown'}_${payload.user?.id || 'unknown'}`;
        const now = Date.now();
        
        // Check if interaction was already processed recently
        const lastProcessedTime = processedEvents.get(interactionId);
        if (lastProcessedTime && (now - lastProcessedTime) < EVENT_CACHE_TTL) {
          Logger.info(`Skipping duplicate interaction: ${interactionId} (last processed ${now - lastProcessedTime}ms ago)`);
          return;
        }
        
        processedEvents.set(interactionId, now);
        Logger.info({ payload: truncateObjectForLog(payload) }, "Processing Socket Mode interactive component");
        await processSlackInteraction(payload);
      } catch (error: any) {
        await handleError(error, {
          client: webClient!,
          channel,
          user,
          threadTs,
          action: "interactive_event",
          payload: args,
        });
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
try {
  if (hasSlackConfig) {
    // Validate token formats
    if (!process.env.SLACK_BOT_TOKEN!.startsWith("xoxb-")) {
      Logger.error(
        "SLACK_BOT_TOKEN does not start with xoxb-. Slack integration disabled."
      );
    } else if (!process.env.SLACK_APP_TOKEN!.startsWith("xapp-")) {
      Logger.error(
        "SLACK_APP_TOKEN does not start with xapp-. Slack integration disabled."
      );
    } else {
      webClient = new WebClient(process.env.SLACK_BOT_TOKEN);
      Logger.info("Slack Web API client initialized");

      // Note: Socket Mode connection will be started via startSocketMode() from server.ts
    }
  }
} catch (error) {
  Logger.error(
    error,
    "Failed to initialize Slack Web API client. Slack integration disabled."
  );
  webClient = null;
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
          text: `*${index + 1}. /${agent.name.replace(/\s+/g, "-")}*${
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
    await handleError(error, {
      client,
      channel,
      user,
      action: "handleAgentsCommand",
      payload: { dbUser },
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
  const match = trimmedCommand.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);

  Logger.info(
    `Trimmed command: "${trimmedCommand}", Match result: ${
      match ? `[${match[0]}, ${match[1]}, ${match[2] || ""}]` : "null"
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
    `Agent search - Agent: ${agentName}, Query: "${query ? query : ''}" by user ${
      dbUser.email
    }`
  );

  try {
    // Validate workspaceId before proceeding
    if (!dbUser.workspaceId || dbUser.workspaceId <= 0) {
      Logger.error(
        `Invalid or missing workspaceId for user ${dbUser.email}: ${dbUser.workspaceId}`
      );
      await client.chat.postEphemeral({
        channel,
        user,
        text: "There's an issue with your workspace configuration. Please contact your administrator.",
      });
      return;
    }

    // Get accessible agents
    const agents = await getUserAccessibleAgents(
      db,
      dbUser.id,
      dbUser.workspaceId,
      100,
      0
    );

    const lowerCaseAgentName = agentName.toLowerCase();
    let selectedAgent: any = null;

    // 1. Exact match (case-insensitive)
    selectedAgent = agents.find(
      (agent: any) =>
        agent.name.replace(/\s+/g, "-").toLowerCase() === lowerCaseAgentName
    );

    // 2. Partial match if no exact match is found
    if (!selectedAgent) {
      const partialMatches = agents.filter((agent: any) =>
        agent.name
          .replace(/\s+/g, "-")
          .toLowerCase()
          .startsWith(lowerCaseAgentName)
      );

      if (partialMatches.length === 1) {
        selectedAgent = partialMatches[0];
      } else if (partialMatches.length > 1) {
        const matchingAgentNames = partialMatches
          .map((a: any) => `/${a.name.replace(/\s+/g, "-")}`)
          .join("\n• ");
        await client.chat.postEphemeral({
          channel,
          user,
          text: `Multiple agents match "/${agentName}". Please be more specific. Did you mean one of these?\n\n• ${matchingAgentNames}`,
        });
        return;
      }
    }

    if (!selectedAgent) {
      const availableAgents = agents
        .map((a: any) => `/${a.name.replace(/\s+/g, "-")}`)
        .join(", ");
      await client.chat.postEphemeral({
        channel,
        user,
        text: `Agent "/${agentName}" not found or not accessible to you.\n\nAvailable agents: ${availableAgents}\n\nUse \`/agents\` to see the full list with descriptions.`,
      });
      return;
    }
    
    const agentDisplayName = selectedAgent.name.replace(/\s+/g, "-");

    if (!query || query.trim() === "") {
      await client.chat.postEphemeral({
        channel,
        user,
        text: `Please provide a query for the agent "/${agentDisplayName}".\n\nExample: \`/${agentDisplayName} your query here\``,
      });
      return;
    }

    const isThreadMessage = !!threadTs;

    Logger.info(
      `Starting agent chat with ${selectedAgent.name} for query: "${query}"`
    );

    await client.chat.postEphemeral({
      channel,
      user,
      text: `Querying the agent "/${agentDisplayName}"...`,
      ...(isThreadMessage && { thread_ts: threadTs }),
    });

    try {
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
      const userAndWorkspace = await getUserAndWorkspaceByEmail(
        db,
        dbUser.workspaceExternalId,
        dbUser.email
      );
      const ctx = userContext(userAndWorkspace);

      const agentConfig = await getAgentByExternalIdWithPermissionCheck(
        db,
        selectedAgent.externalId,
        userAndWorkspace.workspace.id,
        userAndWorkspace.user.id
      );

      if (!agentConfig) {
        let errorMessage = `❌ You don't have permission to use agent "/${agentDisplayName}".`;

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
      const limitedMessages: any[] = [];

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

      for await (const chunk of searchOrAnswerIterator) {
        if (chunk.text) {
          buffer += chunk.text;
          
          if (buffer.trim() && (buffer.trim().startsWith('{') || buffer.trim().startsWith('['))) {
            try {
              parsed = JSON.parse(buffer) || {};
            } catch (err) {
              continue;
            }
          }
        }
      }

      if (buffer.trim() && !parsed) {
        try {
          parsed = JSON.parse(buffer) || {};
        } catch (err) {
          Logger.warn(err, `Failed to parse final buffer content: ${buffer.substring(0, 100)}...`);
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
        finalResponse = parsed.answer;
        Logger.info(
          `Agent provided direct answer: ${finalResponse.substring(0, 100)}...`
        );
      } else {
        const searchQuery = parsed.queryRewrite || query;
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

        const tracer = getTracer("slack-agent");
        const span = tracer.startSpan("slack_agent_rag");

        const iterator = UnderstandMessageAndAnswer(
          dbUser.email,
          ctx,
          searchQuery,
          classification as any,
          limitedMessages,
          0.5,
          false,
          span,
          agentPrompt
        );

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
          text: `Agent "/${agentDisplayName}" couldn't generate a response for "${query}". Try rephrasing your question.`,
          ...(isThreadMessage && { thread_ts: threadTs }),
        });
        return;
      }

      const chat = await getOrCreateChat(threadTs || channel, dbUser);
      const newMessage = await insertMessage(db, {
        message: finalResponse,
        messageRole: MessageRole.Assistant,
        email: dbUser.email,
        workspaceExternalId: dbUser.workspaceExternalId,
        chatExternalId: chat.externalId,
        modelId: selectedAgent.model,
        sources: citations,
        fileIds: [],
        thinking: query,
        userId: dbUser.id,
        chatId: chat.id,
      });

      await client.chat.postEphemeral({
        channel,
        user,
        text: `Agent "/${agentDisplayName}" response is ready.`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `Agent */${agentDisplayName}* has responded to your query: "_${query}_"\n${
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
                value: newMessage.externalId,
              },
            ],
          },
        ],
        ...(isThreadMessage && { thread_ts: threadTs }),
      });
    } catch (agentError: any) {
      Logger.error(agentError, "Error in direct agent processing");
      if(client) {
        await handleError(agentError, {
          client,
          channel,
          user,
          threadTs,
          action: "agent_processing",
          payload: { agentName: agentDisplayName, query },
        });
      }
    }
  } catch (error: any) {
    await handleError(error, {
      client,
      channel,
      user,
      threadTs,
      action: "handleAgentSearchCommand",
      payload: { agentName, query },
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
  } catch (error: any) {
    Logger.error(
      {
        error: error.message,
        stack: error.stack,
        userEmail,
        workspaceExternalId,
        query,
        options,
      },
      "Error in executeSearch function"
    );
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
  } catch (apiError: any) {
    await handleError(apiError, {
      client,
      channel,
      user,
      threadTs,
      action: "handleSearchQuery",
      payload: { query },
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

  const chat = await getOrCreateChat(threadTs || channel, dbUser);
  const newMessage = await insertMessage(db, {
    message: JSON.stringify(results), // Store results as a JSON string
    messageRole: MessageRole.Assistant,
    email: dbUser.email,
    workspaceExternalId: dbUser.workspaceExternalId,
    chatExternalId: chat.externalId,
    modelId: "search", // Or a more appropriate identifier
    sources: results,
    fileIds: [],
    thinking: query,
    userId: dbUser.id,
    chatId: chat.id,
  });

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
            value: newMessage.externalId,
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
    Logger.info(`Received app_mention event: ${truncateObjectForLog(event.text)}`);

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
      if (user && webClient) {
        await handleError(error, {
          client: webClient,
          channel,
          user,
          threadTs: thread_ts,
          action: "processSlackEvent",
          payload: event,
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
    const actionId = action.action_id;
    
    try {
      Logger.info({ action: truncateObjectForLog(action), trigger_id }, `Processing action: ${actionId}`);
      
      switch (actionId) {
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
        case ACTION_IDS.NEXT_SOURCE_PAGE:
        case ACTION_IDS.PREVIOUS_SOURCE_PAGE:
          await handleSourcePagination(action, view);
          break;
        default:
          Logger.warn({ actionId }, `Unknown action_id`);
      }
    } catch (error: any) {
      await handleError(error, {
        client: webClient!,
        channel: channel?.id,
        user: user?.id,
        threadTs: container?.thread_ts,
        action: `block_action: ${actionId}`,
        payload,
      });
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

    const messageId = action?.value;
    if (!messageId) {
      throw new Error("No message ID provided");
    }

    const message = await getMessageByExternalId(db, messageId);
    if (!message) {
      throw new Error(`No search results found for this message. They may have been deleted.`);
    }

    const results = JSON.parse(message.message);
    const query = message.thinking;
    const isFromThread = !!container?.thread_ts;
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
    await handleError(error, {
      client: webClient!,
      channel: channel?.id,
      user: user?.id,
      threadTs: container?.thread_ts,
      action: "handleViewSearchModal",
      payload: { action, trigger_id },
    });
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

    const messageId = action?.value;
    if (messageId === "no_interaction_id" || !messageId) {
      throw new Error("Cannot open modal: No message ID available");
    }

    const message = await getMessageByExternalId(db, messageId);
    if (!message) {
      throw new Error(`No agent response found for this message. It may have been deleted.`);
    }

    const {
      message: response,
      sources: citations,
      modelId: agentName,
      thinking: query,
    } = message;
    const isFromThread = !!container?.thread_ts;

    const modal = createAgentResponseModal(
      query,
      agentName,
      response,
      (citations as any) || [],
      messageId,
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
          message_id: messageId,
        }),
      },
    });
    
    Logger.info(`Successfully opened agent response modal for user ${user.id}`);
  } catch (error: any) {
    await handleError(error, {
      client: webClient!,
      channel: channel?.id,
      user: user?.id,
      threadTs: container?.thread_ts,
      action: "handleViewAgentModal",
      payload: { action, trigger_id },
    });
  }
};

const handleSourcePagination = async (action: any, view: any) => {
  try {
    if (!view || !view.private_metadata) {
      throw new Error("Cannot access required modal metadata for pagination.");
    }

    const { message_id } = JSON.parse(view.private_metadata);
    if (!message_id) {
      throw new Error("Message ID not found in modal metadata.");
    }

    const { page } = JSON.parse(action.value);
    const message = await getMessageByExternalId(db, message_id);

    if (!message) {
      throw new Error("Agent response not found for pagination.");
    }

    const {
      message: response,
      sources: citations,
      modelId: agentName,
      thinking: query,
    } = message;
    const isFromThread = !!view.thread_ts;

    const newModal = createAgentResponseModal(
      query,
      agentName,
      response,
      (citations as any) || [],
      message_id,
      isFromThread,
      page
    );

    newModal.private_metadata = view.private_metadata;

    await webClient!.views.update({
      view_id: view.id,
      hash: view.hash,
      view: newModal,
    });
  } catch (error: any) {
    const metadata = view ? JSON.parse(view.private_metadata || "{}") : {};
    await handleError(error, {
      client: webClient!,
      channel: metadata.channel_id,
      user: metadata.user_id,
      threadTs: metadata.thread_ts,
      action: "handleSourcePagination",
      payload: { action, view },
    });
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
    const metadata = view ? JSON.parse(view.private_metadata || "{}") : {};
    await handleError(error, {
      client: webClient!,
      channel: metadata.channel_id,
      user: metadata.user_id,
      threadTs: metadata.thread_ts,
      action: "handleShareFromModal",
      payload: { action, view, isThreadShare },
    });
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

    const messageId = action.value;

    if (messageId === "no_interaction_id" || !messageId) {
      throw new Error("Cannot share: No message ID available");
    }

    const message = await getMessageByExternalId(db, messageId);
    if (!message) {
      throw new Error(
        "Agent response data not found. The response may have been deleted."
      );
    }

    const {
      modelId: agentName,
      message: response,
      sources: citations,
      thinking: query,
    } = message;
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
        (citations as any) || []
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
    const metadata = view ? JSON.parse(view.private_metadata || "{}") : {};
    await handleError(error, {
      client: webClient!,
      channel: metadata.channel_id,
      user: metadata.user_id,
      threadTs: metadata.thread_ts,
      action: "handleShareAgentFromModal",
      payload: { action, view, isThreadShare },
    });
  }
};


// Export Socket Mode status and control functions
export const getSocketModeStatus = () => isSocketModeConnected;
export const startSocketMode = async () => {
  if (hasSlackConfig && webClient && !isSocketModeConnected && !socketModeClient) {
    try {
      await connectSocketMode();
      return true;
    } catch (error) {
      Logger.error(error, "Failed to start Socket Mode connection");
      return false;
    }
  }
  Logger.info("Socket Mode already connected or configuration missing");
  return false;
};

// Export the client and utility functions
export const getSlackClient = () => webClient;
export const isSlackEnabled = () => webClient !== null;
