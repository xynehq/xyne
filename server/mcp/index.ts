import { FastMCP, UserError } from "fastmcp";
import { z } from "zod";
import JiraClient from "./jiraClient.js";
import BitbucketClient from "./bitbucketClient.js";

export function startMcpServer() {
  const server = new FastMCP({
    name: "xyne-server",
    version: "0.0.1",
  });

  console.log("JIRA_BASE_URL:", process.env.JIRA_BASE_URL);
  console.log("BITBUCKET_BASE_URL:", process.env.BITBUCKET_BASE_URL);

  const jira = new JiraClient(
    process.env.JIRA_BASE_URL!,
    process.env.JIRA_USER_EMAIL!,
    process.env.JIRA_API_TOKEN!
  );

  const bitbucket = new BitbucketClient(
    process.env.BITBUCKET_BASE_URL!,
    process.env.BITBUCKET_USER_NAME!,
    process.env.BITBUCKET_APP_PASSWORD!
  );

  // -------- Jira tool --------
  server.addTool({
    name: "jira_get_issue",
    description: "Get Jira issue details by issue key",
    parameters: z.object({
      issueKey: z.string(),
    }),
    execute: async ({ issueKey }: { issueKey: string }) => {
      try {
        const issue = await jira.getIssue(issueKey);
        const issueData = {
          key: issue.key,
          summary: issue.fields.summary,
          description:
            issue.fields.description?.content ||
            issue.fields.description ||
            "No description",
          status: issue.fields.status.name,
          assignee: issue.fields.assignee?.displayName || "Unassigned",
          reporter: issue.fields.reporter?.displayName || "Unknown",
          priority: issue.fields.priority?.name || "Unknown",
          issueType: issue.fields.issuetype.name,
          created: issue.fields.created,
          updated: issue.fields.updated,
          url: `${process.env.JIRA_BASE_URL}/browse/${issue.key}`,
        };
        return JSON.stringify(issueData, null, 2);
      } catch (err) {
        throw new UserError(`Error fetching Jira issue: ${(err as Error).message}`);
      }
    },
  });

  // -------- Bitbucket tool --------
  server.addTool({
    name: "bitbucket_get_git_blame",
    description: "Get Git blame for a file in Bitbucket",
    parameters: z.object({
      projectKey: z.string(),
      repoSlug: z.string(),
      filePath: z.string(),
      startLine: z.union([z.number(), z.string().transform(Number)]),
      endLine: z.union([z.number(), z.string().transform(Number)]),
    }),
    execute: async ({
      projectKey,
      repoSlug,
      filePath,
      startLine,
      endLine,
    }: {
      projectKey: string;
      repoSlug: string;
      filePath: string;
      startLine: number;
      endLine: number;
    }) => {
      try {
        const blame = await bitbucket.getGitBlame(
          projectKey,
          repoSlug,
          filePath
        );
        let processed = blame.map((b: any) => ({
          name: b.author.name,
          emailAddress: b.author.emailAddress,
          commitId: b.commitHash,
          lineNoFrom: b.lineNumber,
          lineNoTo: b.lineNumber + b.spannedLines - 1,
        }));

        if (startLine > 0 && endLine > 0) {
          processed = processed.filter(
            (b: any) =>
              Math.max(b.lineNoFrom, startLine) <=
              Math.min(b.lineNoTo, endLine)
          );
        }

        const uniqueCommits = [
          ...new Set(processed.map((b: any) => b.commitId)),
        ] as string[];
        const commits = await Promise.all(
          uniqueCommits.map((cid: string) =>
            bitbucket.getCommit(projectKey, repoSlug, cid)
          )
        );

        const commitMap = Object.fromEntries(
          commits.map((c: any) => [
            c.id,
            {
              message: c.message,
              jiraKey: c.properties?.["jira-key"]?.[0],
            },
          ])
        );

        const final = processed.map((b: any) => ({
          ...b,
          ...commitMap[b.commitId],
        }));

        return JSON.stringify(final, null, 2);
      } catch (err) {
        throw new UserError(`Error fetching Git blame: ${(err as Error).message}`);
      }
    },
  });

  server.start({
    transportType: "httpStream",
    httpStream: {
      port: 7320,
    },
  });

  console.error("MCP-HTTPStream server listening on http://localhost:7320/mcp");
}
