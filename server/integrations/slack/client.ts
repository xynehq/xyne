import { App } from "@slack/bolt";
import * as dotenv from "dotenv";
import { db } from "@/db/client";
import { getUserByEmail } from "@/db/user";
import { getLogger } from "@/logger";
import { Subsystem } from "@/types";
import { sign } from "hono/jwt";
import { SearchApi } from "@/api/search";
import config from "@/config";
import {
  createSearchIntroBlocks,
  createSearchHeaderBlocks,
  createSingleResultBlocks,
  createMoreResultsBlocks,
  createSharedResultBlocks,
  createShareConfirmationBlocks,
  createSearchResultsModal,
} from "./formatters";

dotenv.config();

const Logger = getLogger(Subsystem.Slack);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Create a global cache for search results
declare global {
  var _searchResultsCache: {
    [key: string]: {
      query: string;
      results: any[];
      timestamp: number;
      isFromThread?: boolean; // Add this property
    };
  };
}

// Initialize the cache if it doesn't exist
global._searchResultsCache = global._searchResultsCache || {};

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

    Logger.info(`Calling SearchApi for query: "${processedText}"`);

    let results: any[] = [];

    try {
      // Create a context object for SearchApi with the necessary parameters
      const mockContext = {
        get: (key: string) => {
          if (key === config.JwtPayloadKey) {
            return {
              sub: dbUser[0].email,
              workspaceId: dbUser[0].workspaceExternalId || "default",
              role: dbUser[0].role || "user",
            };
          }
          return undefined;
        },
        req: {
          valid: (type: string) => {
            if (type === "query") {
              return {
                query: processedText,
                groupCount: false, // We don't need group counts for Slack results
                page: 10, // Number of results to show
                app: null, // Search all apps
                entity: null, // Search all entities
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
      // If search fails, log the error and notify the user with ephemeral message
      Logger.error(apiError, "Error in search operation");
      await client.chat.postEphemeral({
        channel,
        user,
        text: `I couldn't complete your search for "${processedText}". Please try again later.`,
      });
      return;
    }

    // Process search results
    if (results.length === 0) {
      // No results found
      await client.chat.postEphemeral({
        channel,
        user,
        text: `I couldn't find any results for "${processedText}". Try using different keywords or check your spelling.`,
      });
      return;
    }

    // Check if the message is part of a thread
    const isThreadMessage = event.thread_ts && event.thread_ts !== ts;

    // Create a unique interaction ID for this query
    const interactionId = `${channel}_${ts}_${Date.now()}`;

    // Store the search results temporarily
    global._searchResultsCache = global._searchResultsCache || {};
    global._searchResultsCache[interactionId] = {
      query: processedText,
      results: results,
      timestamp: Date.now(),
      isFromThread: Boolean(isThreadMessage), // Explicitly cast to boolean
    };

    // If it's a thread message, respond in that thread with an ephemeral message
    if (isThreadMessage) {
      Logger.info(`Message is part of a thread: ${event.thread_ts}`);

      // Send ephemeral message in the thread
      await client.chat.postEphemeral({
        channel,
        user,
        thread_ts: event.thread_ts, // Use the thread_ts from the event
        text: `I found ${results.length} results for your query "${processedText}"`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*I found ${results.length} results for your query "${processedText}"*\nClick below to view them.`,
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
        ],
      });
    } else {
      // For top-level messages, use the standard ephemeral message
      await client.chat.postEphemeral({
        channel,
        user,
        text: `I found ${results.length} results for your query "${processedText}"`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*I found ${results.length} results for your query "${processedText}"*\nClick below to view them.`,
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
        ],
      });
    }

    // Also send a message to trigger_id the user's DM to ensure they notice
    try {
      // Open a DM with the user
      const conversationResponse = await client.conversations.open({
        users: user,
      });

      if (
        conversationResponse.ok &&
        conversationResponse.channel &&
        conversationResponse.channel.id
      ) {
        // Send a message in DM
        await client.chat.postMessage({
          channel: conversationResponse.channel.id,
          text: `I found ${results.length} results for your query: "${processedText}"`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*I found ${results.length} results for your query*\nClick below to view them.`,
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
          ],
        });
        Logger.info(`Sent DM with search results button for user ${user}`);
      }
    } catch (dmError) {
      Logger.error(dmError, "Error sending DM with search results");
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

// Handler for the view search results button - opens the modal when clicked
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
    const channelId = parts[0];
    const threadTs = parts[1];

    // Check if this was initiated from a thread
    const isFromThread = cachedData.isFromThread || false;

    // If we need to customize the modal for thread functionality
    if (isFromThread) {
      // Modify the modal blocks to add "Share in thread" buttons for each result
      const modifiedBlocks = [...modal.blocks];

      // Find action blocks (which contain the buttons) and add "Share in thread" option
      for (let i = 0; i < modifiedBlocks.length; i++) {
        const block = modifiedBlocks[i];
        if (
          block.type === "actions" &&
          block.block_id &&
          block.block_id.startsWith("result_actions_")
        ) {
          // Cast the block to ActionsBlock to access elements
          const actionBlock = block as any; // Cast to any to avoid TypeScript errors

          // Add "Share in thread" button to this action block
          actionBlock.elements.push({
            type: "button",
            text: {
              type: "plain_text",
              text: "Share in thread",
              emoji: true,
            },
            action_id: "share_in_thread_modal",
            value: actionBlock.elements[0].value, // Reuse the same value from the casted object
          });
        }
      }

      // Use the modified blocks in the modal
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

    // Clean up the ephemeral message if possible
    try {
      if ((body as any).message && (body as any).message.ts) {
        await client.chat.delete({
          channel: (body as any).channel.id,
          ts: (body as any).message.ts,
        });
      }
    } catch (deleteErr) {
      // It's okay if we can't delete it
      Logger.warn("Could not delete ephemeral message");
    }

    Logger.info(
      `Opened modal with search results for user ${(body as any).user.id}`
    );
  } catch (error) {
    Logger.error(error, "Error opening search results modal");
    await client.chat.postEphemeral({
      channel: (body as any).channel.id,
      user: (body as any).user.id,
      text: "Sorry, I couldn't open the search results. Please try your search again.",
    });
  }
});

// Handle button interactions in thread
app.action("share_result", async ({ ack, body, client }) => {
  await ack();

  try {
    const actionValue = JSON.parse((body as any).actions[0].value);
    const { url, title, query, snippet, metadata, resultId } = actionValue;

    // Use the enhanced shared result blocks that include content
    const blocks = createSharedResultBlocks(
      (body as any).user.id,
      url,
      title,
      snippet || "",
      metadata || "",
      query
    );

    // Share the result in the channel with full content
    await client.chat.postMessage({
      channel: (body as any).channel.id,
      text: `${title} - Shared by <@${(body as any).user.id}>`,
      blocks: blocks,
    });

    // Show confirmation only to the user who shared
    await client.chat.postEphemeral({
      channel: (body as any).channel.id,
      user: (body as any).user.id,
      text: "Result shared in channel successfully!",
      blocks: createShareConfirmationBlocks(),
    });
  } catch (error) {
    Logger.error(error, "Error sharing result");
  }
});

// Handle button interactions in modal
app.action("share_result_modal", async ({ ack, body, client }) => {
  await ack();

  try {
    // Extract the action value and the view's metadata
    const actionValue = JSON.parse((body as any).actions[0].value);
    const { url, title, query, snippet, metadata, resultId } = actionValue;

    // Get the view container and its private_metadata
    const view = (body as any).view;
    if (!view || !view.private_metadata) {
      throw new Error("Cannot access view metadata");
    }

    // Parse the metadata to get channel information
    const viewMetadata = JSON.parse(view.private_metadata);
    const channelId = viewMetadata.channel_id;
    const userId = viewMetadata.user_id || (body as any).user.id;

    if (!channelId) {
      throw new Error("Channel ID not found in view metadata");
    }

    // Use the enhanced shared result blocks that include content
    const blocks = createSharedResultBlocks(
      userId,
      url,
      title,
      snippet || "",
      metadata || "",
      query
    );

    // Share the result in the original channel
    await client.chat.postMessage({
      channel: channelId,
      text: `${title} - Shared by <@${userId}>`,
      blocks: blocks,
    });

    // Show confirmation to the user - create a new clean view object instead of spreading the original
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
  } catch (error) {
    Logger.error(error, "Error sharing result from modal");

    // Show error message in the modal
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

// Handle "Share in thread" button clicks from the modal
app.action("share_in_thread_modal", async ({ ack, body, client }) => {
  await ack();

  try {
    // Extract the action value and the view's metadata
    const actionValue = JSON.parse((body as any).actions[0].value);
    const { url, title, query, snippet, metadata, resultId } = actionValue;

    // Get the view container and its private_metadata
    const view = (body as any).view;
    if (!view || !view.private_metadata) {
      throw new Error("Cannot access view metadata");
    }

    // Parse the metadata to get channel and thread information
    const viewMetadata = JSON.parse(view.private_metadata);
    const channelId = viewMetadata.channel_id;
    const threadTs = viewMetadata.thread_ts;
    const userId = viewMetadata.user_id || (body as any).user.id;

    if (!channelId || !threadTs) {
      throw new Error("Channel ID or Thread TS not found in view metadata");
    }

    // Use the enhanced shared result blocks that include content
    const blocks = createSharedResultBlocks(
      userId,
      url,
      title,
      snippet || "",
      metadata || "",
      query
    );

    // Share the result in the thread
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `${title} - Shared by <@${userId}>`,
      blocks: blocks,
    });

    // Show confirmation to the user
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
  } catch (error) {
    Logger.error(error, "Error sharing result in thread from modal");

    // Show error message in the modal
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
