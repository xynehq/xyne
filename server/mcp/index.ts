import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from 'http';
import { randomUUID } from "node:crypto";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"

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
