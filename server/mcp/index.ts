import { FastMCP } from "fastmcp";
import JiraClient from "./jiraClient.js";
import BitbucketClient from "./bitbucketClient.js";
import KibanaClient from "./kibanaClient.js";
import { getLogger } from "../logger/index.js";
import { Subsystem } from "../types.js";
import { addTools } from "./tools.js";

export function startMcpServer() {
  const logger = getLogger(Subsystem.MCP);
  
  // Validate required environment variables
  const requiredEnvVars = {
    JIRA_BASE_URL: process.env.JIRA_BASE_URL,
    JIRA_USER_EMAIL: process.env.JIRA_USER_EMAIL,
    JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
    BITBUCKET_BASE_URL: process.env.BITBUCKET_BASE_URL,
    BITBUCKET_USER_NAME: process.env.BITBUCKET_USER_NAME,
    BITBUCKET_APP_PASSWORD: process.env.BITBUCKET_APP_PASSWORD,
    KIBANA_BASE_URL: process.env.KIBANA_BASE_URL,
    KIBANA_COOKIE: process.env.KIBANA_COOKIE,
  };

  const missingVars = Object.entries(requiredEnvVars)
    .filter(([_, value]) => !value)
    .map(([key, _]) => key);

  if (missingVars.length > 0) {
    logger.warn(`MCP server starting with missing environment variables: ${missingVars.join(', ')}`);
  }

  const server = new FastMCP({
    name: "xyne-server",
    version: "0.0.1",
  });

  // Only initialize clients if their required env vars are present
  let jira: JiraClient | null = null;
  let bitbucket: BitbucketClient | null = null;
  let kibana: KibanaClient | null = null;

  if (process.env.JIRA_BASE_URL && process.env.JIRA_USER_EMAIL && process.env.JIRA_API_TOKEN) {
    jira = new JiraClient(
      process.env.JIRA_BASE_URL,
      process.env.JIRA_USER_EMAIL,
      process.env.JIRA_API_TOKEN
    );
  }

  if (process.env.BITBUCKET_BASE_URL && process.env.BITBUCKET_USER_NAME && process.env.BITBUCKET_APP_PASSWORD) {
    bitbucket = new BitbucketClient(
      process.env.BITBUCKET_BASE_URL,
      process.env.BITBUCKET_USER_NAME,
      process.env.BITBUCKET_APP_PASSWORD
    );
  }

  if (process.env.KIBANA_BASE_URL && process.env.KIBANA_COOKIE) {
    kibana = new KibanaClient(
      process.env.KIBANA_BASE_URL,
      process.env.KIBANA_COOKIE,
      process.env.KIBANA_PREFERENCE
    );
  }

  // Add all tools using the separated tools module
  addTools(server, jira, bitbucket, kibana);

  server.start({
    transportType: "httpStream",
    httpStream: {
      port: 7320,
    },
  });

  
  logger.info("MCP server started on port 7320");
}
