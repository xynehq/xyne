import { FastMCP } from "fastmcp";
import JiraClient from "./jiraClient.js";
import BitbucketClient from "./bitbucketClient.js";
import KibanaClient from "./kibanaClient.js";
import { getLogger } from "../logger/index.js";
import { Subsystem } from "../types.js";
import { addTools } from "./tools.js";

// Define the session data type for storing configuration
interface McpSessionData {
  jiraBaseUrl?: string;
  jiraUserEmail?: string;
  jiraApiToken?: string;
  bitbucketBaseUrl?: string;
  bitbucketUserName?: string;
  bitbucketAppPassword?: string;
  kibanaBaseUrl?: string;
  kibanaCookie?: string;
  kibanaPreference?: string;
  [key: string]: unknown; // Index signature for FastMCPSessionAuth constraint
}

export function startMcpServer() {
  const logger = getLogger(Subsystem.MCP);
  
  const server = new FastMCP<McpSessionData>({
    name: "xyne-server",
    version: "0.0.1",
    // Extract configuration from headers and store in session
    authenticate: async (request): Promise<McpSessionData> => {
      logger.debug("MCP client connected, extracting configuration from headers");
      
      // Helper function to extract string value from header
      const getHeaderString = (value: string | string[] | undefined): string | undefined => {
        if (Array.isArray(value)) return value[0];
        return value;
      };
      
      // Extract configuration from headers
      const headers = request.headers;
      const config: McpSessionData = {
        jiraBaseUrl: getHeaderString(headers["jira-base-url"]) || getHeaderString(headers["x-jira-base-url"]),
        jiraUserEmail: getHeaderString(headers["jira-user-email"]) || getHeaderString(headers["x-jira-user-email"]),
        jiraApiToken: getHeaderString(headers["jira-api-token"]) || getHeaderString(headers["x-jira-api-token"]),
        bitbucketBaseUrl: getHeaderString(headers["bitbucket-base-url"]) || getHeaderString(headers["x-bitbucket-base-url"]),
        bitbucketUserName: getHeaderString(headers["bitbucket-user-name"]) || getHeaderString(headers["x-bitbucket-user-name"]),
        bitbucketAppPassword: getHeaderString(headers["bitbucket-app-password"]) || getHeaderString(headers["x-bitbucket-app-password"]),
        kibanaBaseUrl: getHeaderString(headers["kibana-base-url"]) || getHeaderString(headers["x-kibana-base-url"]),
        kibanaCookie: getHeaderString(headers["kibana-cookie"]) || getHeaderString(headers["x-kibana-cookie"]),
        kibanaPreference: getHeaderString(headers["kibana-preference"]) || getHeaderString(headers["x-kibana-preference"])
      };
      
      logger.debug("Extracted configuration:", Object.keys(config).filter(k => config[k as keyof McpSessionData]));
      
      return config;
    },
  });

  logger.info("MCP server starting - configuration will be extracted from client headers");

  // Add all tools - they will read from context.session
  addTools(server);

  server.start({
    transportType: "httpStream",
    httpStream: {
      port: 7320,
    },
  });

  logger.info("MCP server started on port 7320");
  logger.info("Tools will use configuration from client headers via session");
}
