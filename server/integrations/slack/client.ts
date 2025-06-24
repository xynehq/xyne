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
  createFeedbackConfirmationBlocks,
} from "./formatters";

dotenv.config();

const Logger = getLogger(Subsystem.Slack);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

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
      await client.chat.postMessage({
        channel,
        text: "Could not retrieve your email from Slack.",
        thread_ts: ts,
      });
      return;
    }
    const userEmail = userInfo.user.profile.email;

    const dbUser = await getUserByEmail(db, userEmail);
    if (!dbUser || !dbUser.length) {
      await client.chat.postMessage({
        channel,
        text: `User with email ${userEmail} not found in the database.`,
        thread_ts: ts,
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

      try {
        // Now we can directly call SearchApi since we fixed the destructuring issue
        const searchResults = await SearchApi(mockContext as any);

        // Extract results from the response
        if (searchResults && Array.isArray((searchResults as any).results)) {
          results = (searchResults as any).results;
          Logger.info(`Found ${results.length} search results from SearchApi`);
        } else {
          Logger.warn(`SearchApi returned unexpected structure`);
        }
      } catch (apiError) {
        // If this fails, log the specific error
        Logger.error(apiError, "Error in SearchApi call");
        throw new Error(
          `SearchApi error: ${
            apiError instanceof Error ? apiError.message : "Unknown error"
          }`
        );
      }
    } catch (error: unknown) {
      // Type the error properly
      const searchError =
        error instanceof Error
          ? error
          : new Error(typeof error === "string" ? error : "Unknown error");

      Logger.error(searchError, "Error in search operation");
      await client.chat.postMessage({
        channel,
        text: `I couldn't complete your search for "${processedText}". Please try again later.`,
        thread_ts: ts,
      });
      return; // Exit early
    }

    // Format search results for Slack using modular formatters
    if (results.length > 0) {
      Logger.info(`Found ${results.length} search results`);

      // Create all blocks for the consolidated message including intro
      const allBlocks = [];
      
      // Add intro block
      allBlocks.push(...createSearchIntroBlocks(user, results.length));
      
      // Add header blocks
      allBlocks.push(...createSearchHeaderBlocks(
        processedText,
        Math.min(3, results.length)
      ));

      // Display up to 3 results, add all their blocks to the array
      const displayResults = results.slice(0, 3);

      for (let i = 0; i < displayResults.length; i++) {
        const result = displayResults[i];
        const resultBlocks = createSingleResultBlocks(result, i, processedText);
        
        // Add all blocks from this result
        allBlocks.push(...resultBlocks);
        
        // Add a divider between results (except after the last one)
        if (i < displayResults.length - 1) {
          allBlocks.push({
            type: "divider"
          });
        }
      }

      // Add "more results" blocks if there are more than 3 results
      if (results.length > 3) {
        allBlocks.push({
          type: "divider"
        });
        allBlocks.push(...createMoreResultsBlocks(results.length, 3));
      }

      // Send everything as a single message in the thread
      await client.chat.postMessage({
        channel,
        thread_ts: ts,
        blocks: allBlocks,
        text: `Hey <@${user}>! I found ${results.length} results for your query.`, // Fallback text
      });

    } else {
      await client.chat.postMessage({
        channel,
        text: `Hey <@${user}>! I couldn't find any results for "${processedText}". Try using different keywords or check your spelling.`,
        thread_ts: ts,
      });
    }
  } catch (error: any) {
    Logger.error(error, "Error processing app_mention event");
    await client.chat.postMessage({
      channel,
      text: `An error occurred: ${error.message}`,
      thread_ts: ts,
    });
  }
});

// Handle button interactions
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

app.action("not_helpful", async ({ ack, body, client }) => {
  await ack();

  try {
    const actionValue = JSON.parse((body as any).actions[0].value);
    Logger.info(
      `User marked result as not helpful for query: ${actionValue.query}`
    );

    // You could store this feedback in your database for improving search results

    // Update the message to show feedback was received
    await client.chat.postEphemeral({
      channel: (body as any).channel.id,
      user: (body as any).user.id,
      text: "Thanks for your feedback! We'll use this to improve our search results.",
      blocks: createFeedbackConfirmationBlocks(actionValue.query),
    });
  } catch (error) {
    Logger.error(error, "Error processing feedback");
  }
});

export default app;
