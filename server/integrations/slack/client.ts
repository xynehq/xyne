import { App } from "@slack/bolt";
import * as dotenv from "dotenv";
import { db } from "@/db/client";
import { getUserByEmail } from "@/db/user";
import { getLogger } from "@/logger";
import { Subsystem } from "@/types";
import { sign } from "hono/jwt";

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

    const authToken = await generateToken(dbUser[0].email, dbUser[0].role, dbUser[0].workspaceExternalId);
    const processedText = text.replace(/<@.*?>\s*/, "").trim();
    
    // TODO: Replace with dynamic chatId and modelId
    const modelId = "gpt-4o-mini";
    
    // Use message/create endpoint instead of search
    const url = process.env.SLACK_BASE_URL + `/api/v1/message/create?modelId=${modelId}&message=${encodeURIComponent(processedText)}&isReasoningEnabled=false`;
    
    Logger.info(`Sending request to: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        "Accept": "text/event-stream",
        "Cookie": `auth-token=${authToken}`,
      },
    });

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Failed to get response reader");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let contentResponse = "";
    let hasSentMessage = false;
    
    // For debugging
    let allEvents = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');

      while (boundary !== -1) {
        const chunk = buffer.substring(0, boundary);
        buffer = buffer.substring(boundary + 2);
        
        allEvents.push(chunk); // For debugging

        let eventName = '';
        let data = '';

        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) {
            eventName = line.substring(6).trim();
          } else if (line.startsWith('data:')) {
            data = line.substring(5).trim();
          } else if (line.trim() && !eventName) {
            // Handle cases where the event is just a single character without "event:" prefix
            eventName = line.trim();
          }
        }

        if (eventName === 'er' || eventName === 'error') { // Error event
          await client.chat.postMessage({ channel, text: `Error: ${data}`, thread_ts: ts });
          hasSentMessage = true;
          break;
        }

        // Handle text update events - 'u' is the event type for text fragments
        if (eventName === 'u') {
          contentResponse += data || '';
        }
        
        boundary = buffer.indexOf('\n\n');
      }
      if (hasSentMessage) break;
    }
    
    if (!hasSentMessage && contentResponse) {
      await client.chat.postMessage({ channel, text: contentResponse, thread_ts: ts });
    } else if (!hasSentMessage) {
      // If we get here and there's no content, log the events for debugging
      Logger.warn(`No content response. Events received: ${JSON.stringify(allEvents)}`);
      await client.chat.postMessage({ 
        channel, 
        text: "I received a response, but it was empty. Please try again or contact support.", 
        thread_ts: ts 
      });
    }
  } catch (error: any) {
    Logger.error(error, "Error processing app_mention event");
    await client.chat.postMessage({ channel, text: `An error occurred: ${error.message}`, thread_ts: ts });
  }
});

export default app;

