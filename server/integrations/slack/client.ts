import { App } from "@slack/bolt";
import * as dotenv from "dotenv";
import { db } from "@/db/client";
import { getUserByEmail } from "@/db/user";
import { getLogger } from "@/logger";
import { Subsystem } from "@/types";
import { sign } from "hono/jwt";
import { SearchApi } from "@/api/search";
import config from "@/config";

dotenv.config();

const Logger = getLogger(Subsystem.Slack);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const generateToken = async (email: string, role: string, workspaceId: string) => {
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
      await client.chat.postMessage({ channel, text: "Could not retrieve your email from Slack.", thread_ts: ts });
      return;
    }
    const userEmail = userInfo.user.profile.email;

    const dbUser = await getUserByEmail(db, userEmail);
    if (!dbUser || !dbUser.length) {
      await client.chat.postMessage({ channel, text: `User with email ${userEmail} not found in the database.`, thread_ts: ts });
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
              workspaceId: dbUser[0].workspaceExternalId || 'default',
              role: dbUser[0].role || 'user'
            };
          }
          return undefined;
        },
        req: {
          valid: (type: string) => {
            if (type === 'query') {
              return {
                query: processedText,
                groupCount: false,  // We don't need group counts for Slack results
                page: 10,           // Number of results to show
                app: null,          // Search all apps
                entity: null,       // Search all entities
                offset: 0,
                debug: false
              };
            }
            return {};
          }
        },
        json: (data: any) => data
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
        throw new Error(`SearchApi error: ${apiError instanceof Error ? apiError.message : 'Unknown error'}`);
      }
    } catch (error: unknown) {
      // Type the error properly
      const searchError = error instanceof Error 
        ? error 
        : new Error(typeof error === 'string' ? error : 'Unknown error');
      
      Logger.error(searchError, "Error in search operation");
      await client.chat.postMessage({ 
        channel, 
        text: `I couldn't complete your search for "${processedText}". Please try again later.`, 
        thread_ts: ts 
      });
      return; // Exit early
    }
    
    // Format search results for Slack
    if (results.length > 0) {
      // Log a sample result to debug the structure
      Logger.info(`Sample search result: ${JSON.stringify(results[0])}`);
      
      // Get the best result (first one)
      const topResult = results[0];
      
      // Extract title from various possible fields
      let title = 'Untitled';
      if (topResult.subject) title = topResult.subject;
      else if (topResult.title) title = topResult.title;
      else if (topResult.name) title = topResult.name;
      
      // Extract content or snippet
      let snippet = '';
      if (topResult.content) snippet = topResult.content;
      else if (topResult.snippet) snippet = topResult.snippet;
      else if (topResult.chunks_summary && topResult.chunks_summary.length > 0) {
        snippet = topResult.chunks_summary[0].chunk || '';
        snippet = snippet.replace(/<[^>]*>/g, '');
      }
      
      // Clean and truncate snippet
      if (snippet) {
        snippet = snippet.replace(/\s+/g, ' ').trim();
        snippet = snippet.length > 200 ? `${snippet.substring(0, 200)}...` : snippet;
      }
      
      // Get metadata
      const url = topResult.url || '';
      const docType = topResult.type || '';
      let author = 'Unknown';
      let dateStr = '';
      
      if (topResult.from) author = topResult.from;
      if (topResult.timestamp) {
        const date = new Date(topResult.timestamp);
        dateStr = date.toLocaleDateString();
      }
      
      // Create the main message
      const contextualIntro = `Hey <@${user}>! Based on your question above, we found a link from your teammates that might have relevant information for you.`;
      
      // Build blocks for rich formatting
      const blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: contextualIntro
          }
        },
        {
          type: "divider"
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*<${url}|${title}>*\n${snippet || 'No preview available'}`
          }
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `📄 By ${author}${dateStr ? ` • Updated ${dateStr}` : ''}${docType ? ` • ${docType}` : ''}`
            }
          ]
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Share in channel"
              },
              style: "primary",
              action_id: "share_result",
              value: JSON.stringify({ url, title, query: processedText })
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "👎 Not helpful"
              },
              action_id: "not_helpful",
              value: JSON.stringify({ query: processedText, resultId: topResult.id || 'unknown' })
            }
          ]
        }
      ];
      
      // Add "See more results" section if there are more results
      if (results.length > 1) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `<${url}|See more results in Glean> (${results.length} total results)`
          }
        });
      }
      
      await client.chat.postMessage({
        channel,
        thread_ts: ts,
        blocks: blocks,
        text: `Search results for: "${processedText}"` // Fallback text
      });
      
    } else {
      await client.chat.postMessage({
        channel,
        text: `Hey <@${user}>! I couldn't find any results for "${processedText}". Try using different keywords or check your spelling.`,
        thread_ts: ts
      });
    }
    
  } catch (error: any) {
    Logger.error(error, "Error processing app_mention event");
    await client.chat.postMessage({ channel, text: `An error occurred: ${error.message}`, thread_ts: ts });
  }
});

// Handle button interactions
app.action("share_result", async ({ ack, body, client }) => {
  await ack();
  
  try {
    const actionValue = JSON.parse((body as any).actions[0].value);
    const { url, title, query } = actionValue;
    
    // Share the result in the channel
    await client.chat.postMessage({
      channel: (body as any).channel.id,
      text: `🔗 *${title}*\n${url}\n\n_Shared in response to: "${query}"_`
    });
    
    // Update the original message to show it was shared
    await client.chat.update({
      channel: (body as any).channel.id,
      ts: (body as any).message.ts,
      blocks: (body as any).message.blocks,
      text: "Result shared in channel!"
    });
    
  } catch (error) {
    Logger.error(error, "Error sharing result");
  }
});

app.action("not_helpful", async ({ ack, body, client }) => {
  await ack();
  
  try {
    const actionValue = JSON.parse((body as any).actions[0].value);
    Logger.info(`User marked result as not helpful for query: ${actionValue.query}`);
    
    // You could store this feedback in your database for improving search results
    
    // Update the message to show feedback was received
    await client.chat.postEphemeral({
      channel: (body as any).channel.id,
      user: (body as any).user.id,
      text: "Thanks for your feedback! We'll use this to improve our search results."
    });
    
  } catch (error) {
    Logger.error(error, "Error processing feedback");
  }
});

export default app;
