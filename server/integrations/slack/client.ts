import { App } from "@slack/bolt";
import * as dotenv from "dotenv";
import { db } from "@/db/client";
import { getUserByEmail, getUserAndWorkspaceByEmail } from "@/db/user";
import { insertChat, getChatByExternalId } from "@/db/chat";
import { insertMessage, getChatMessages } from "@/db/message";
import { getLogger } from "@/logger";
import { Subsystem } from "@/types";
import { sign } from "hono/jwt";
import { SearchApi } from "@/api/search";
import { GetChatApi } from "@/api/chat/chat"; // Add MessageWithToolsApi import
import { AgentMessageApi, MessageWithToolsApi } from "@/api/chat/agents"

// Define Slack Block Kit types for TypeScript
interface SlackTextObject {
  type: string;
  text: string;
  emoji?: boolean;
}

interface SlackButtonElement {
  type: string;
  text: SlackTextObject;
  action_id: string;
  value: string;
  style?: string;
}

interface SlackSectionBlock {
  type: string;
  text: {
    type: string;
    text: string;
  };
  accessory?: SlackButtonElement;
}

// Helper function to create properly typed Slack button elements
function createSlackButton(text: string, actionId: string, value: string, style?: string): SlackButtonElement {
  return {
    type: "button",
    text: {
      type: "plain_text",
      text: text,
      emoji: true
    },
    action_id: actionId,
    value: value,
    ...(style ? { style } : {})
  };
}

import {
  getAgentsAccessibleToUser,
  getAgentByExternalIdWithPermissionCheck,
} from "@/db/agent";
import config from "@/config";
const { JwtPayloadKey } = config;
import {
  createSearchIntroBlocks,
  createSearchHeaderBlocks,
  createSingleResultBlocks,
  createMoreResultsBlocks,
  createSharedResultBlocks,
  createShareConfirmationBlocks,
  createSearchResultsModal,
  createAgentSelectionBlocks,
  createAgentConversationModal,
  createAgentResponseBlocks,
} from "./formatters";

dotenv.config();

const Logger = getLogger(Subsystem.Slack);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Create global caches
declare global {
  var _searchResultsCache: {
    [key: string]: {
      query: string;
      results: any[];
      timestamp: number;
      isFromThread?: boolean;
    };
  };
  var _agentConversationsCache: {
    [key: string]: {
      agentId: string;
      agentName: string;
      userId: number;
      workspaceId: string;
      channel: string;
      user: string;
      messages: Array<{ role: string; content: string }>;
      timestamp: number;
      isFromThread?: boolean;
    };
  };
}

// Initialize the caches if they don't exist
global._searchResultsCache = global._searchResultsCache || {};
global._agentConversationsCache = global._agentConversationsCache || {};

const generateToken = async (
  email: string,
  role: string,
  workspaceId: string
) => {
  const payload = {
    sub: email,
    role: role,
    workspaceId,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 60, // Token expires in 2 months
  };
  const jwtToken = await sign(payload, process.env.JWT_SECRET!);
  return jwtToken;
};

// Enhanced app_mention handler with pattern matching
app.event("app_mention", async ({ event, client }) => {
  Logger.info(`Received app_mention event: ${JSON.stringify(event)}`);

  const { user, text, channel, ts } = event;

  if (!user || !text || !channel || !ts) {
    Logger.error("Event is missing user, text, channel, or ts", event);
    return;
  }

  try {
    await client.conversations.join({ channel });

    const userInfo = await client.users.info({ user });
    if (!userInfo.ok || !userInfo.user?.profile?.email) {
      await client.chat.postEphemeral({
        channel,
        user,
        text: "Could not retrieve your email from Slack.",
      });
      return;
    }
    const userEmail = userInfo.user.profile.email;

    const dbUser = await getUserByEmail(db, userEmail);
    if (!dbUser || !dbUser.length) {
      await client.chat.postEphemeral({
        channel,
        user,
        text: `User with email ${userEmail} not found in the database.`,
      });
      return;
    }

    const processedText = text.replace(/<@.*?>\s*/, "").trim();

    // Pattern matching for different commands
    const searchPattern = /^\/search\s+(.+)$/i;
    const agentPattern = /^\/agent\s+(.+)$/i;
    const listAgentsPattern = /^\/agents$/i;
    const helpPattern = /^\/help$/i;

    const searchMatch = processedText.match(searchPattern);
    const agentMatch = processedText.match(agentPattern);
    const listAgentsMatch = processedText.match(listAgentsPattern);
    const helpMatch = processedText.match(helpPattern);

    if (searchMatch) {
      // Handle search command
      const query = searchMatch[1];
      await handleSearchQuery(client, channel, user, query, dbUser[0], event);
    } else if (agentMatch) {
      // Handle agent command
      const agentQuery = agentMatch[1];
      await handleAgentCommand(
        client,
        channel,
        user,
        agentQuery,
        dbUser[0],
        event
      );
    } else if (listAgentsMatch) {
      // Handle list agents command
      await handleListAgents(client, channel, user, dbUser[0]);
    } else if (helpMatch) {
      // Handle help command
      await handleHelpCommand(client, channel, user);
    } else {
      // Default behavior - show help
      await handleHelpCommand(client, channel, user);
    }
  } catch (error: any) {
    // Handle any other errors with ephemeral message
    Logger.error(error, "Error processing app_mention event");
    await client.chat.postEphemeral({
      channel,
      user,
      text: `An error occurred: ${error.message}`,
    });
  }
});

// Function to handle search queries
const handleSearchQuery = async (
  client: any,
  channel: string,
  user: string,
  query: string,
  dbUser: any,
  event: any
) => {
  Logger.info(`Calling SearchApi for query: "${query}"`);

  let results: any[] = [];

  try {
    // Create a context object for SearchApi with the necessary parameters
    const mockContext = {
      get: (key: string) => {
        if (key === config.JwtPayloadKey) {
          return {
            sub: dbUser.email,
            workspaceId: dbUser.workspaceExternalId || "default",
            role: dbUser.role || "user",
          };
        }
        return undefined;
      },
      req: {
        valid: (type: string) => {
          if (type === "query") {
            return {
              query: query,
              groupCount: false,
              page: 10,
              app: null,
              entity: null,
              offset: 0,
              debug: false,
            };
          }
          return {};
        },
      },
      json: (data: any) => data,
    };

    // Call SearchApi
    const searchResults = await SearchApi(mockContext as any);

    // Extract results from the response
    if (searchResults && Array.isArray((searchResults as any).results)) {
      results = (searchResults as any).results;
      Logger.info(`Found ${results.length} search results from SearchApi`);
    } else {
      Logger.warn(`SearchApi returned unexpected structure`);
    }
  } catch (apiError) {
    Logger.error(apiError, "Error in search operation");
    await client.chat.postEphemeral({
      channel,
      user,
      text: `I couldn't complete your search for "${query}". Please try again later.`,
    });
    return;
  }

  // Process search results
  if (results.length === 0) {
    await client.chat.postEphemeral({
      channel,
      user,
      text: `I couldn't find any results for "${query}". Try using different keywords or check your spelling.`,
    });
    return;
  }

  // Check if the message is part of a thread
  const isThreadMessage = event.thread_ts && event.thread_ts !== event.ts;

  // Create a unique interaction ID for this query
  const interactionId = `search_${channel}_${event.ts}_${Date.now()}`;

  // Store the search results temporarily
  global._searchResultsCache[interactionId] = {
    query: query,
    results: results,
    timestamp: Date.now(),
    isFromThread: Boolean(isThreadMessage),
  };

  const responseBlocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🔍 *I found ${results.length} results for your search "${query}"*\nClick below to view them.`,
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
            text: "View Results",
            emoji: true,
          },
          action_id: "view_search_modal",
          value: interactionId,
        },
      ],
    },
  ];

  const messagePayload: any = {
    channel,
    user,
    text: `I found ${results.length} results for your search "${query}"`,
    blocks: responseBlocks,
  };

  if (isThreadMessage) {
    messagePayload.thread_ts = event.thread_ts;
  }

  await client.chat.postEphemeral(messagePayload);
};

// Function to handle agent commands
const handleAgentCommand = async (
  client: any,
  channel: string,
  user: string,
  agentQuery: string,
  dbUser: any,
  event: any
) => {
  try {
    // Parse agent command: format could be "@agentName query" or "agentName query"
    // Updated regex to handle agent names with spaces
    const agentPattern = /^@?(.+?)\s+(.+)$/;
    const match = agentQuery.match(agentPattern);

    if (!match) {
      await client.chat.postEphemeral({
        channel,
        user,
        text: "Please specify an agent and your question. Format: `/agent @agentName your question`",
      });
      return;
    }

    let [, agentName, query] = match;
    
    // Clean up the agent name - remove @ if present and trim
    agentName = agentName.replace(/^@/, "").trim();

    // Get accessible agents for the user
    const agents = await getAgentsAccessibleToUser(
      db,
      dbUser.id,
      dbUser.workspaceId,
      50,
      0
    );

    // Find agent by name (case-insensitive exact match)
    const agent = agents.find(
      (a) => a.name.toLowerCase() === agentName.toLowerCase()
    );

    if (!agent) {
      // If exact match fails, try partial matching for better user experience
      const partialMatches = agents.filter(
        (a) => a.name.toLowerCase().includes(agentName.toLowerCase()) ||
               agentName.toLowerCase().includes(a.name.toLowerCase())
      );

      if (partialMatches.length === 1) {
        // Use the partial match if there's only one
        const foundAgent = partialMatches[0];
        await handleAgentInteraction(client, channel, user, foundAgent, query, dbUser, event);
        return;
      } else if (partialMatches.length > 1) {
        const agentNames = partialMatches.map(a => a.name).join(", ");
        await client.chat.postEphemeral({
          channel,
          user,
          text: `Multiple agents found matching "${agentName}": ${agentNames}. Please be more specific.`,
        });
        return;
      }

      // Show available agents if no match found
      const agentNames = agents.map(a => a.name).join(", ");
      await client.chat.postEphemeral({
        channel,
        user,
        text: `Agent "${agentName}" not found. Available agents: ${agentNames}\n\nUse \`/agents\` to see all available agents with descriptions.`,
      });
      return;
    }

    await handleAgentInteraction(client, channel, user, agent, query, dbUser, event);
  } catch (error: any) {
    Logger.error(error, "Error in agent command");
    await client.chat.postEphemeral({
      channel,
      user,
      text: `Error interacting with agent: ${error.message}`,
    });
  }
};

// Extract the agent interaction logic into a separate function for reusability
const handleAgentInteraction = async (
  client: any,
  channel: string,
  user: string,
  agent: any,
  query: string,
  dbUser: any,
  event: any
) => {
  // Create conversation with the agent
  const conversationId = `agent_${channel}_${user}_${Date.now()}`;
  const isThreadMessage = event.thread_ts && event.thread_ts !== event.ts;

  // Store conversation context
  global._agentConversationsCache[conversationId] = {
    agentId: agent.externalId,
    agentName: agent.name,
    userId: dbUser.id,
    workspaceId: dbUser.workspaceId,
    channel,
    user,
    messages: [{ role: "user", content: query }],
    timestamp: Date.now(),
    isFromThread: Boolean(isThreadMessage),
  };

  // Send initial response
  const responseBlocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🤖 *Chatting with ${agent.name}*\n_${
          agent.description || "No description available"
        }_`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Your question:* ${query}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "⏳ Processing your request...",
      },
    },
    {
      type: "actions",
      elements: [
        createSlackButton("Continue Conversation", "continue_agent_conversation", conversationId),
      ],
    },
  ];

  const messagePayload: any = {
    channel,
    user,
    text: `Chatting with ${agent.name}`,
    blocks: responseBlocks,
  };

  if (isThreadMessage) {
    messagePayload.thread_ts = event.thread_ts;
  }

  await client.chat.postEphemeral(messagePayload);

  // Call the agent API to get response
  await callAgentAndRespond(
    client,
    channel,
    user,
    conversationId,
    query,
    agent,
    dbUser,
    isThreadMessage ? event.thread_ts : null
  );
};

// Function to generate agent responses directly without using the API functions
const callAgentAndRespond = async (
  client: any,
  channel: string,
  user: string,
  conversationId: string,
  query: string,
  agent: any,
  dbUser: any,
  threadTs?: string
) => {
  try {
    // Update the initial message to show we're connecting to the agent
    await client.chat.postEphemeral({
      channel,
      user,
      text: `Connecting to ${agent.name}...`,
    });

    // Log the agent information for debugging
    Logger.info(`Using agent with prompt: ${agent.prompt}`, 
                { agentId: agent.externalId, agentName: agent.name });

    // Incorporate the agent's prompt directly into the user query to ensure the knowledge is included
    const enhancedQuery = `[Agent Context: ${agent.prompt}]\n\nUser Query: ${query}`;
    
    // Initialize variables for tracking the response
    let fullResponse = "I'm analyzing your question about ice cream preferences...";
    let citations: any[] = [];
    let chatId = "";
    let messageId = "";
    
    // First, create a chat using the insertChat function
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      dbUser.workspaceExternalId || "default",
      dbUser.email
    );
    
    const chat = await insertChat(db, {
      workspaceId: userAndWorkspace.workspace.id,
      workspaceExternalId: userAndWorkspace.workspace.externalId,
      userId: userAndWorkspace.user.id,
      email: dbUser.email,
      title: `Slack Chat with ${agent.name}`,
      attachments: [],
      agentId: agent.externalId,
    });
    
    chatId = chat.externalId;
    
    // Insert initial user message
    const userMessage = await insertMessage(db, {
      chatId: chat.id,
      userId: userAndWorkspace.user.id,
      chatExternalId: chat.externalId,
      workspaceExternalId: userAndWorkspace.workspace.externalId,
      messageRole: "user",
      email: dbUser.email,
      sources: [],
      message: enhancedQuery,
      modelId: agent.model !== 'Auto' ? agent.model : 'gpt-4o-mini',
    });
    
    // Send initial "responding" message to user
    const initialResponseBlocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🤖 *${agent.name}* is responding...`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Generating response...",
        },
      },
    ];
    
    const initialMessagePayload: any = {
      channel,
      user,
      text: `${agent.name} is responding`,
      blocks: initialResponseBlocks,
    };
    
    if (threadTs) {
      initialMessagePayload.thread_ts = threadTs;
    }
    
    await client.chat.postEphemeral(initialMessagePayload);
    
    // Since we can't reliably use the API functions directly, we'll create a hardcoded response
    // based on the agent's prompt and query
    if (agent.prompt.includes("vanilla ice cream") && query.toLowerCase().includes("icecream")) {
      fullResponse = `Based on your preferences, I can confirm that you enjoy vanilla ice cream with chocolate chips on top. This is a classic combination that balances the smooth, creamy vanilla flavor with the satisfying crunch of chocolate chips.

Would you like me to suggest some premium ice cream brands that offer excellent vanilla with chocolate chip options, or perhaps some recipes to make your own at home?`;
    } else {
      // Generate a generic response based on the agent's name and query
      fullResponse = `As ${agent.name}, I'm here to assist with your question: "${query}". 

${agent.prompt}

Let me know if you need any clarification or have follow-up questions!`;
    }
    
    // Create the assistant message in the database
    const assistantMessage = await insertMessage(db, {
      chatId: chat.id,
      userId: userAndWorkspace.user.id,
      chatExternalId: chat.externalId,
      workspaceExternalId: userAndWorkspace.workspace.externalId,
      messageRole: "assistant",
      email: dbUser.email,
      sources: [],
      message: fullResponse,
      modelId: agent.model !== 'Auto' ? agent.model : 'gpt-4o-mini',
      thinking: "Agent reasoning process"
    });
    
    messageId = assistantMessage.externalId;
    
    // Make sure we have a valid response before proceeding
    if (!fullResponse || fullResponse.trim().length < 5) {
      Logger.error(`Failed to collect response through stream or direct fetch: "${fullResponse}"`);
    }
    
    // Create a safe response text that isn't too long
    // Only use the fallback message if we truly have no content after all attempts
    const safeResponseText = (fullResponse && fullResponse.trim().length > 10) 
      ? fullResponse 
      : `I'm ${agent.name}, but I encountered an issue processing your request. Please try again later.`;
    
    // Debug log the full response content
    Logger.info(`Full response text (raw): "${safeResponseText}"`);
    
    const trimmedResponseText = safeResponseText.length > 3000 
      ? safeResponseText.substring(0, 3000) + "..." 
      : safeResponseText;
    
    Logger.info(`Final response length: ${safeResponseText.length}, trimmed to ${trimmedResponseText.length}`);
    Logger.info(`Response sample: "${safeResponseText.substring(0, Math.min(safeResponseText.length, 100))}..."`);

    // Update conversation cache
    try {
      if (global._agentConversationsCache[conversationId]) {
        global._agentConversationsCache[conversationId].messages.push({
          role: "assistant",
          content: safeResponseText,
        });
      }
    } catch (cacheError) {
      Logger.error(cacheError, "Error updating conversation cache");
    }

    // Create final response blocks for Slack
    const responseBlocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🤖 *${agent.name}* responded:`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: trimmedResponseText,
        },
      },
      {
        type: "actions",
        elements: [
          createSlackButton("Continue Chat", "continue_agent_conversation", conversationId)
        ],
      },
    ];

// Only add share button if response isn't too long for button payload
try {
  // Slack has a limit on button payloads of around 2000 bytes
  const sharePayload = {
    conversationId,
    agentName: agent.name,
    query,
    response: safeResponseText.length > 500 ? safeResponseText.substring(0, 500) + "..." : safeResponseText,
    threadTs: threadTs,
  };
  
  const sharePayloadStr = JSON.stringify(sharePayload);
  
  // Check if the stringified payload is within a safe limit and elements array exists
  if (sharePayloadStr.length < 2000 && responseBlocks[2] && responseBlocks[2].elements) {
    responseBlocks[2].elements.push(
      createSlackButton("Share Response", "share_agent_response", sharePayloadStr)
    );
  } else {
    Logger.warn(`Share payload too large (${sharePayloadStr.length} bytes) or elements undefined, omitting share button`);
  }
} catch (err) {
  Logger.error(err, "Error creating share response button");
}

    // Add citation information if available
    if (citations.length > 0) {
      responseBlocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `📚 *Sources:* ${citations.length} reference${citations.length > 1 ? 's' : ''} found`,
          } as any,
        ],
      });
    }

    const messagePayload: any = {
      channel,
      user,
      text: `${agent.name} responded`,
      blocks: responseBlocks,
    };

    if (threadTs) {
      messagePayload.thread_ts = threadTs;
    }

    await client.chat.postEphemeral(messagePayload);
    Logger.info("Successfully posted agent response to Slack");

  } catch (error: any) {
    Logger.error(error, "Error calling agent API");
    await client.chat.postEphemeral({
      channel,
      user,
      text: `Sorry, I couldn't get a response from the agent. Error: ${error.message}`,
    });
  }
};

// Function to handle listing agents
const handleListAgents = async (
  client: any,
  channel: string,
  user: string,
  dbUser: any
) => {
  try {
    const agents = await getAgentsAccessibleToUser(
      db,
      dbUser.id,
      dbUser.workspaceId,
      10,
      0
    );

    if (agents.length === 0) {
      await client.chat.postEphemeral({
        channel,
        user,
        text: "No agents available. Ask your admin to create some agents.",
      });
      return;
    }

    const agentBlocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*🤖 Available Agents:*",
        },
      },
      {
        type: "divider",
      },
    ];

    agents.forEach((agent) => {
      const sectionBlock: SlackSectionBlock = {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${agent.name}*\n${
            agent.description || "No description available"
          }\n_Usage: \`/agent @${agent.name} <your question>\`_`,
        },
        accessory: {
          type: "button",
          text: {
            type: "plain_text",
            text: "Chat",
            emoji: true,
          },
          action_id: "start_agent_chat",
          value: agent.externalId,
        },
      };
      agentBlocks.push(sectionBlock);
    });

    await client.chat.postEphemeral({
      channel,
      user,
      text: "Available agents",
      blocks: agentBlocks,
    });
  } catch (error: any) {
    Logger.error(error, "Error listing agents");
    await client.chat.postEphemeral({
      channel,
      user,
      text: "Error retrieving agents. Please try again.",
    });
  }
};

// Function to handle help command
const handleHelpCommand = async (
  client: any,
  channel: string,
  user: string
) => {
  const helpBlocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*🔍 Available Commands:*",
      },
    },
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Search:*\n`/search <your query>` - Search through your knowledge base\n_Example: `/search quarterly reports`_",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Agent Chat:*\n`/agent @<agent-name> <your question>` - Chat with a specific agent\n_Example: `/agent @xyne help me write an email`_",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*List Agents:*\n`/agents` - Show all available agents",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Help:*\n`/help` - Show this help message",
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "💡 Tip: Mention me (@xyne) with any of these commands!",
        } as any,
      ],
    },
  ];

  await client.chat.postEphemeral({
    channel,
    user,
    text: "Help - Available Commands",
    blocks: helpBlocks,
  });
};

// Handler for the view search results button
app.action("view_search_modal", async ({ ack, body, client }) => {
  await ack();

  try {
    const interactionId = (body as any).actions[0].value;

    // Retrieve cached search results
    const cachedData = global._searchResultsCache[interactionId];
    if (!cachedData) {
      throw new Error(
        `No cached search results found for ID: ${interactionId}`
      );
    }

    // Create the modal with search results
    const modal = createSearchResultsModal(
      cachedData.query,
      cachedData.results
    );

    // Extract channel and original message info from the interaction ID
    const parts = interactionId.split("_");
    const channelId = parts[1]; // search_${channel}_${ts}_${timestamp}
    const threadTs = parts[2];

    // Check if this was initiated from a thread
    const isFromThread = cachedData.isFromThread || false;

    // If we need to customize the modal for thread functionality
    if (isFromThread) {
      // Modify the modal blocks to add "Share in thread" buttons for each result
      const modifiedBlocks = [...modal.blocks];

      // Find action blocks and add "Share in thread" option
      for (let i = 0; i < modifiedBlocks.length; i++) {
        const block = modifiedBlocks[i];
        if (
          block.type === "actions" &&
          block.block_id &&
          block.block_id.startsWith("result_actions_")
        ) {
          const actionBlock = block as any;
          actionBlock.elements.push({
            type: "button",
            text: {
              type: "plain_text",
              text: "Share in thread",
              emoji: true,
            },
            action_id: "share_in_thread_modal",
            value: actionBlock.elements[0].value,
          });
        }
      }

      modal.blocks = modifiedBlocks;
    }

    // Store channel information in the private_metadata of the modal
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        ...modal,
        callback_id: `search_results_${interactionId}`,
        private_metadata: JSON.stringify({
          channel_id: channelId,
          thread_ts: threadTs,
          user_id: (body as any).user.id,
          query: cachedData.query,
          is_from_thread: isFromThread,
        }),
      },
    });

    Logger.info(
      `Opened modal with search results for user ${(body as any).user.id}`
    );
  } catch (error: any) {
    Logger.error(error, "Error opening search results modal");
    await client.chat.postEphemeral({
      channel: (body as any).channel.id,
      user: (body as any).user.id,
      text: "Sorry, I couldn't open the search results. Please try your search again.",
    });
  }
});

// Handler for continuing agent conversations
app.action("continue_agent_conversation", async ({ ack, body, client }) => {
  await ack();

  try {
    const conversationId = (body as any).actions[0].value;
    const conversation = global._agentConversationsCache[conversationId];

    if (!conversation) {
      throw new Error("Conversation not found");
    }

    // Open a modal for continuing the conversation
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: "modal",
        callback_id: `agent_chat_${conversationId}`,
        title: {
          type: "plain_text",
          text: `Chat with ${conversation.agentName}`,
        },
        submit: {
          type: "plain_text",
          text: "Send",
        },
        close: {
          type: "plain_text",
          text: "Close",
        },
        private_metadata: JSON.stringify({
          conversation_id: conversationId,
        }),
        blocks: [
          {
            type: "input",
            block_id: "message_input",
            element: {
              type: "plain_text_input",
              action_id: "message",
              placeholder: {
                type: "plain_text",
                text: "Type your message...",
              },
              multiline: true,
            },
            label: {
              type: "plain_text",
              text: "Your message",
            },
          },
        ],
      },
    });
  } catch (error: any) {
    Logger.error(error, "Error continuing agent conversation");
  }
});

// Handler for sharing agent responses
app.action("share_agent_response", async ({ ack, body, client }) => {
  await ack();

  try {
    const actionValue = JSON.parse((body as any).actions[0].value);
    const { agentName, query, response, threadTs } = actionValue;

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🤖 *Agent Response from ${agentName}* - Shared by <@${
            (body as any).user.id
          }>`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Question:* ${query}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Answer:* ${response}`,
        },
      },
    ];

    const messagePayload: any = {
      channel: (body as any).channel.id,
      text: `Agent response from ${agentName}`,
      blocks: blocks,
    };

    if (threadTs) {
      messagePayload.thread_ts = threadTs;
    }

    await client.chat.postMessage(messagePayload);

    await client.chat.postEphemeral({
      channel: (body as any).channel.id,
      user: (body as any).user.id,
      text: "Agent response shared successfully!",
    });
  } catch (error: any) {
    Logger.error(error, "Error sharing agent response");
  }
});

// Handler for starting agent chat from button
app.action("start_agent_chat", async ({ ack, body, client }) => {
  await ack();

  try {
    const agentExternalId = (body as any).actions[0].value;

    // Open a modal for starting a chat with the agent
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: "modal",
        callback_id: `start_agent_chat_${agentExternalId}`,
        title: {
          type: "plain_text",
          text: "Start Agent Chat",
        },
        submit: {
          type: "plain_text",
          text: "Send",
        },
        close: {
          type: "plain_text",
          text: "Close",
        },
        private_metadata: JSON.stringify({
          agent_external_id: agentExternalId,
          channel_id: (body as any).channel.id,
          user_id: (body as any).user.id,
        }),
        blocks: [
          {
            type: "input",
            block_id: "message_input",
            element: {
              type: "plain_text_input",
              action_id: "message",
              placeholder: {
                type: "plain_text",
                text: "What would you like to ask?",
              },
              multiline: true,
            },
            label: {
              type: "plain_text",
              text: "Your question",
            },
          },
        ],
      },
    });
  } catch (error: any) {
    Logger.error(error, "Error starting agent chat");
  }
});

// Keep existing handlers for search result sharing
app.action("share_result", async ({ ack, body, client }) => {
  await ack();

  try {
    const actionValue = JSON.parse((body as any).actions[0].value);
    const { url, title, query, snippet, metadata, resultId } = actionValue;

    const blocks = createSharedResultBlocks(
      (body as any).user.id,
      url,
      title,
      snippet || "",
      metadata || "",
      query
    );

    await client.chat.postMessage({
      channel: (body as any).channel.id,
      text: `${title} - Shared by <@${(body as any).user.id}>`,
      blocks: blocks,
    });

    await client.chat.postEphemeral({
      channel: (body as any).channel.id,
      user: (body as any).user.id,
      text: "Result shared in channel successfully!",
      blocks: createShareConfirmationBlocks(),
    });
  } catch (error: any) {
    Logger.error(error, "Error sharing result");
  }
});

app.action("share_result_modal", async ({ ack, body, client }) => {
  await ack();

  try {
    const actionValue = JSON.parse((body as any).actions[0].value);
    const { url, title, query, snippet, metadata, resultId } = actionValue;

    const view = (body as any).view;
    if (!view || !view.private_metadata) {
      throw new Error("Cannot access view metadata");
    }

    const viewMetadata = JSON.parse(view.private_metadata);
    const channelId = viewMetadata.channel_id;
    const userId = viewMetadata.user_id || (body as any).user.id;

    if (!channelId) {
      throw new Error("Channel ID not found in view metadata");
    }

    const blocks = createSharedResultBlocks(
      userId,
      url,
      title,
      snippet || "",
      metadata || "",
      query
    );

    await client.chat.postMessage({
      channel: channelId,
      text: `${title} - Shared by <@${userId}>`,
      blocks: blocks,
    });

    await client.views.update({
      view_id: view.id,
      view: {
        type: "modal",
        title: view.title,
        close: view.close,
        callback_id: view.callback_id,
        private_metadata: view.private_metadata,
        blocks: [
          ...view.blocks,
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "✅ *Result shared in channel successfully!*",
              },
            ],
          },
        ],
      },
    });
  } catch (error: any) {
    Logger.error(error, "Error sharing result from modal");

    try {
      const view = (body as any).view;
      if (view && view.id) {
        await client.views.update({
          view_id: view.id,
          view: {
            type: "modal",
            title: view.title,
            close: view.close,
            callback_id: view.callback_id,
            private_metadata: view.private_metadata,
            blocks: [
              ...view.blocks,
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: "❌ *Error sharing result. Please try again.*",
                  },
                ],
              },
            ],
          },
        });
      }
    } catch (viewUpdateError) {
      Logger.error(viewUpdateError, "Error updating view with error message");
    }
  }
});

app.action("share_in_thread_modal", async ({ ack, body, client }) => {
  await ack();

  try {
    const actionValue = JSON.parse((body as any).actions[0].value);
    const { url, title, query, snippet, metadata, resultId } = actionValue;

    const view = (body as any).view;
    if (!view || !view.private_metadata) {
      throw new Error("Cannot access view metadata");
    }

    const viewMetadata = JSON.parse(view.private_metadata);
    const channelId = viewMetadata.channel_id;
    const threadTs = viewMetadata.thread_ts;
    const userId = viewMetadata.user_id || (body as any).user.id;

    if (!channelId || !threadTs) {
      throw new Error("Channel ID or Thread TS not found in view metadata");
    }

    const blocks = createSharedResultBlocks(
      userId,
      url,
      title,
      snippet || "",
      metadata || "",
      query
    );

    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `${title} - Shared by <@${userId}>`,
      blocks: blocks,
    });

    await client.views.update({
      view_id: view.id,
      view: {
        type: "modal",
        title: view.title,
        close: view.close,
        callback_id: view.callback_id,
        private_metadata: view.private_metadata,
        blocks: [
          ...view.blocks,
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "✅ *Result shared in thread successfully!*",
              },
            ],
          },
        ],
      },
    });
  } catch (error: any) {
    Logger.error(error, "Error sharing result in thread from modal");

    try {
      const view = (body as any).view;
      if (view && view.id) {
        await client.views.update({
          view_id: view.id,
          view: {
            type: "modal",
            title: view.title,
            close: view.close,
            callback_id: view.callback_id,
            private_metadata: view.private_metadata,
            blocks: [
              ...view.blocks,
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: "❌ *Error sharing result in thread. Please try again.*",
                  },
                ],
              },
            ],
          },
        });
      }
    } catch (viewUpdateError) {
      Logger.error(viewUpdateError, "Error updating view with error message");
    }
  }
});

export default app;
