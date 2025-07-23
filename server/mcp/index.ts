import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from 'http';
import { randomUUID } from "node:crypto";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import JiraClient from "./jiraClient.js";
import BitbucketClient from "./bitbucketClient.js";

export function startMcpServer() {
  const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  const server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else {
        let parsedBody;
        try {
          parsedBody = JSON.parse(body);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32700, message: 'Parse error' },
            id: null
          }));
          return;
        }

        if (isInitializeRequest(parsedBody)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => {
              transports[sessionId] = transport;
            },
          });

          transport.onclose = () => {
            if (transport.sessionId) {
              delete transports[transport.sessionId];
            }
          };

          const mcpServer = new McpServer({
            name: "xyne-server",
            version: "0.0.1"
          });

          mcpServer.tool(
            "add",
            "Add two numbers",
            { a: z.number(), b: z.number() },
            async ({ a, b }: { a: number, b: number }) => ({
              content: [{ type: "text", text: String(a + b) }]
            })
          );

          // Initialize Jira client
          console.log('JIRA_BASE_URL:', process.env.JIRA_BASE_URL);
          console.log('BITBUCKET_BASE_URL:', process.env.BITBUCKET_BASE_URL);
          const jiraClient = new JiraClient(
            process.env.JIRA_BASE_URL!,
            process.env.JIRA_USER_EMAIL!,
            process.env.JIRA_API_TOKEN!
          );

          // Initialize Bitbucket client
          const bitbucketClient = new BitbucketClient(
            process.env.BITBUCKET_BASE_URL!,
            process.env.BITBUCKET_USER_NAME!,
            process.env.BITBUCKET_APP_PASSWORD!
          );

          // Add Jira tool
          mcpServer.tool(
            "jira_get_issue",
            "Get Jira issue details by issue key",
            {
              issueKey: z.string().describe("Jira issue key (e.g., EUL-14500)")
            },
            async ({ issueKey }: { issueKey: string }) => {
              try {
                const issue = await jiraClient.getIssue(issueKey);

                // Extract relevant information
                const issueData = {
                  key: issue.key,
                  summary: issue.fields.summary,
                  description: issue.fields.description?.content || issue.fields.description || "No description",
                  status: issue.fields.status.name,
                  assignee: issue.fields.assignee?.displayName || "Unassigned",
                  reporter: issue.fields.reporter?.displayName || "Unknown",
                  priority: issue.fields.priority?.name || "Unknown",
                  issueType: issue.fields.issuetype.name,
                  created: issue.fields.created,
                  updated: issue.fields.updated,
                  url: `${process.env.JIRA_BASE_URL}/browse/${issue.key}`
                };

                return {
                  content: [{
                    type: "text",
                    text: JSON.stringify(issueData, null, 2)
                  }]
                };
              } catch (error) {
                return {
                  content: [{
                    type: "text",
                    text: `Error fetching Jira issue: ${(error as Error).message}`
                  }]
                };
              }
            }
          );

          // Add Bitbucket tool
          mcpServer.tool(
            "bitbucket_get_git_blame",
            "Get Git blame for a file in Bitbucket",
            {
              projectKey: z.string().describe("Bitbucket project key (e.g., JBIZ)"),
              repoSlug: z.string().describe("Bitbucket repository slug (e.g., euler-api-txns)"),
              filePath: z.string().describe("Path to the file in the repository (e.g., nix/stan.nix)"),
            },
            async ({ projectKey, repoSlug, filePath }: { projectKey: string, repoSlug: string, filePath: string }) => {
              try {
                const blame = await bitbucketClient.getGitBlame(projectKey, repoSlug, filePath);
                return {
                  content: [{
                    type: "text",
                    text: JSON.stringify(blame, null, 2)
                  }]
                };
              } catch (error) {
                return {
                  content: [{
                    type: "text",
                    text: `Error fetching Git blame from Bitbucket: ${(error as Error).message}`
                  }]
                };
              }
            }
          );

          await mcpServer.connect(transport);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
            id: null
          }));
          return;
        }
      }
      if (req.method === 'POST') {
        await transport.handleRequest(req, res, JSON.parse(body));
      } else {
        await transport.handleRequest(req, res);
      }
    });
  });

  const port = 7320;
  server.listen(port, () => {
    console.error(`MCP server listening on port ${port}`);
  });
}
