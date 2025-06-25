import { App, AppMentionEvent, BlockAction, ButtonAction, LogLevel, WebClient, View } from "@slack/bolt";
import * as dotenv from "dotenv";
import { db } from "@/db/client";
import { getUserByEmail } from "@/db/user";
import { getLogger } from "@/logger";
import { Subsystem } from "@/types";
import { SearchApi } from "@/api/search";
import config from "@/config";
import {
  createSearchResultsModal,
  createShareConfirmationBlocks,
  createSharedResultBlocks,
} from "./formatters";

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

    if (processedText.toLowerCase().startsWith("search ")) {
      const query = processedText.substring(7).trim();
      await handleSearchQuery(client, channel, user, query, dbUser[0], ts, thread_ts);
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
      { type: "section", text: { type: "mrkdwn", text: "*🔍 Available Commands:*" }},
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: "*Search:*\n`search <your query>` - Search the knowledge base.\n_Example: `search quarterly reports`_" }},
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
