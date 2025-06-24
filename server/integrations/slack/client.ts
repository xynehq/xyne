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
    let messageText = `Search results for: "${processedText}"\n\n`;
    if (results.length > 0) {
      // Log a sample result to debug the structure
      Logger.info(`Sample search result: ${JSON.stringify(results[0])}`);
      
      results.slice(0, 5).forEach((result: any, index: number) => {
        // Extract title from various possible fields
        let title = 'Untitled';
        if (result.subject) title = result.subject;
        else if (result.title) title = result.title;
        else if (result.name) title = result.name;
        
        // Extract content or snippet
        let snippet = '';
        if (result.content) snippet = result.content;
        else if (result.snippet) snippet = result.snippet;
        else if (result.chunks_summary && result.chunks_summary.length > 0) {
          // Special handling for email/document chunks
          snippet = result.chunks_summary[0].chunk || '';
          // Remove any HTML tags
          snippet = snippet.replace(/<[^>]*>/g, '');
        }
        
        // Get URL if available
        const url = result.url || '';
        
        // Get document type
        const docType = result.type || '';
        
        // Get relevance score if available
        let relevance = '';
        if (result.relevance !== undefined) {
          const score = parseFloat(result.relevance);
          if (!isNaN(score)) {
            relevance = `(Score: ${score.toFixed(2)})`;
          }
        }
        
        // Build the message with better formatting
        messageText += `${index + 1}. *${title}*${docType ? ` (${docType})` : ''} ${relevance}\n`;
        
        if (snippet) {
          // Clean the snippet - remove excessive whitespace and truncate
          snippet = snippet.replace(/\s+/g, ' ').trim();
          messageText += `   ${snippet.substring(0, 150)}${snippet.length > 150 ? '...' : ''}\n`;
        } else {
          // If no snippet, try to provide some useful info from available fields
          const usefulFields = [];
          if (result.from) usefulFields.push(`From: ${result.from}`);
          if (result.to) usefulFields.push(`To: ${Array.isArray(result.to) ? result.to.join(', ') : result.to}`);
          if (result.timestamp) {
            const date = new Date(result.timestamp);
            usefulFields.push(`Date: ${date.toLocaleDateString()}`);
          }
          
          if (usefulFields.length > 0) {
            messageText += `   ${usefulFields.join(' | ')}\n`;
          }
        }
        
        if (url) {
          messageText += `   🔗 ${url}\n`;
        }
        messageText += '\n';
      });
      
      if (results.length > 5) {
        messageText += `... and ${results.length - 5} more results`;
      }
    } else {
      messageText += "No results found for your query.";
    }
    
    await client.chat.postMessage({ 
      channel, 
      text: messageText, 
      thread_ts: ts 
    });

  } catch (error: any) {
    Logger.error(error, "Error processing app_mention event");
    await client.chat.postMessage({ channel, text: `An error occurred: ${error.message}`, thread_ts: ts });
  }
});

export default app;
