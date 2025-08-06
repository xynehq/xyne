import { FastMCP, UserError } from "fastmcp";
import { z } from "zod";
import JiraClient from "./jiraClient.js";
import BitbucketClient from "./bitbucketClient.js";
import KibanaClient from "./kibanaClient.js";

// Helper functions to create clients from session data
interface SessionData {
  jiraBaseUrl?: string;
  jiraUserEmail?: string;
  jiraApiToken?: string;
  bitbucketBaseUrl?: string;
  bitbucketUserName?: string;
  bitbucketAppPassword?: string;
  kibanaBaseUrl?: string;
  kibanaCookie?: string;
  kibanaPreference?: string;
  [key: string]: unknown;
}

function createJiraClient(session?: SessionData): JiraClient | null {
  const baseUrl = session?.jiraBaseUrl || process.env.JIRA_BASE_URL;
  const email = session?.jiraUserEmail || process.env.JIRA_USER_EMAIL;
  const token = session?.jiraApiToken || process.env.JIRA_API_TOKEN;
  
  if (baseUrl && email && token) {
    return new JiraClient(baseUrl, email, token);
  }
  return null;
}

function createBitbucketClient(session?: SessionData): BitbucketClient | null {
  const baseUrl = session?.bitbucketBaseUrl || process.env.BITBUCKET_BASE_URL;
  const userName = session?.bitbucketUserName || process.env.BITBUCKET_USER_NAME;
  const appPassword = session?.bitbucketAppPassword || process.env.BITBUCKET_APP_PASSWORD;
  
  if (baseUrl && userName && appPassword) {
    return new BitbucketClient(baseUrl, userName, appPassword);
  }
  return null;
}

function createKibanaClient(session?: SessionData): KibanaClient | null {
  const baseUrl = session?.kibanaBaseUrl || process.env.KIBANA_BASE_URL;
  const cookie = session?.kibanaCookie || process.env.KIBANA_COOKIE;
  const preference = session?.kibanaPreference || process.env.KIBANA_PREFERENCE;
  
  if (baseUrl && cookie) {
    return new KibanaClient(baseUrl, cookie, preference);
  }
  return null;
}

export function addTools(server: FastMCP) {
  // -------- Jira tool --------
  server.addTool({
    name: "jira_get_issue",
    description: "Get Jira issue details by issue key",
    parameters: z.object({
      issueKey: z.string(),
    }),
    execute: async ({ issueKey }: { issueKey: string }, context?: any) => {
      const jira = createJiraClient(context?.session);
      if (!jira) {
        throw new UserError("Jira client not configured - missing session data (jiraBaseUrl, jiraUserEmail, jiraApiToken)");
      }
      try {
        const issue = await jira.getIssue(issueKey);
        const issueData = {
          key: issue.key,
          summary: issue.fields.summary,
          // description:
          //   issue.fields.description?.content ||
          //   issue.fields.description ||
          //   "No description",
          // status: issue.fields.status.name,
          assignee: issue.fields.assignee?.displayName || "Unassigned",
          reporter: issue.fields.reporter?.displayName || "Unknown",
          priority: issue.fields.priority?.name || "Unknown",
          issueType: issue.fields.issuetype.name,
          created: issue.fields.created,
          // updated: issue.fields.updated,
          url: `${context?.session?.jiraBaseUrl || process.env.JIRA_BASE_URL}/browse/${issue.key}`,
        };
        return JSON.stringify(issueData, null, 2);
      } catch (err) {
        throw new UserError(`Error fetching Jira issue: ${(err as Error).message}`);
      }
    },
  });

  // -------- Find Code Lines tool --------
  server.addTool({
    name: "find_code_lines",
    description: "Find the exact line numbers of a code snippet within a file. Gets the whole file content and searches for your code snippet. Use this tool BEFORE using bitbucket_get_git_blame to ensure accurate line numbers.",
    parameters: z.object({
      projectKey: z.string(),
      repoSlug: z.string(),
      filePath: z.string(),
      codeSnippet: z.string().describe("Code snippet to locate in the file."),
      searchAroundLine: z.number().optional().describe("If provided, search for the code snippet around this specific line number")
    }),
    execute: async ({
      projectKey,
      repoSlug,
      filePath,
      codeSnippet,
      searchAroundLine,
    }: {
      projectKey: string;
      repoSlug: string;
      filePath: string;
      codeSnippet: string;
      searchAroundLine?: number;
    }, context?: any) => {
      // Debug: Log what we're receiving
      // console.log("=== MCP Tool Debug Info ===");
      // console.log("Context:", JSON.stringify(context, null, 2));
      // console.log("Process env BITBUCKET_BASE_URL:", process.env.BITBUCKET_BASE_URL);
      // console.log("Process env keys:", Object.keys(process.env).filter(k => k.includes('BITBUCKET')));
      // console.log("=========================");
      
      const bitbucket = createBitbucketClient(context?.session);
      if (!bitbucket) {
        throw new UserError("Bitbucket client not configured - missing session data (bitbucketBaseUrl, bitbucketUserName, bitbucketAppPassword)");
      }
      try {
        // console.log(`Fetching file content for: ${projectKey}/${repoSlug}/${filePath}`);
        const fileContent = await bitbucket.getFileContent(projectKey, repoSlug, filePath);
        
        if (!fileContent) {
          throw new Error("File content is empty or null");
        }
        
        // Add file size limit to prevent memory issues
        const MAX_FILE_SIZE = 1000000; // 1MB limit
        if (fileContent.length > MAX_FILE_SIZE) {
          throw new UserError(`File too large (${fileContent.length} characters). Maximum size is ${MAX_FILE_SIZE} characters.`);
        }
        
        const lines = fileContent.split("\n");
        
        // Check if file seems truncated
        const lastLine = lines[lines.length - 1];
        if (fileContent.length > 50000 && !lastLine.trim()) {
          console.warn("File might be truncated - large size but ends abruptly");
        }
        
        // Enhanced search for code snippet - process the entire file thoroughly
        let foundLine = -1;
        const cleanSnippet = codeSnippet.trim();
        
        // console.log(`Searching for snippet in ${lines.length} lines:`);
        // console.log(`Snippet: "${cleanSnippet}"`);
        
        // If searchAroundLine is provided, check that specific area first
        if (searchAroundLine && codeSnippet) {
          // console.log(`Searching around line ${searchAroundLine} for snippet...`);
          const searchStart = Math.max(0, searchAroundLine - 50);
          const searchEnd = Math.min(lines.length, searchAroundLine + 50);
          
          // console.log(`Checking lines ${searchStart + 1} to ${searchEnd} around target line ${searchAroundLine}`);
          
          for (let i = searchStart; i < searchEnd; i++) {
            const line = lines[i].trim();
            if (line.includes(cleanSnippet.trim())) {
              foundLine = i + 1;
              // console.log(`Found snippet near expected line ${searchAroundLine}: actual line ${foundLine}`);
              // console.log(`Content: "${line}"`);
              break;
            }
          }
          
          // If found around the expected line, skip other strategies
          if (foundLine !== -1) {
            // console.log(`Success: Found code around expected line ${searchAroundLine}`);
          } else {
            // console.log(`Code not found around line ${searchAroundLine}, will try other strategies`);
            
            // Show context around the expected line for debugging
            const contextStart = Math.max(0, searchAroundLine - 10);
            const contextEnd = Math.min(lines.length, searchAroundLine + 10);
            // console.log(`Context around line ${searchAroundLine}:`);
            for (let i = contextStart; i < contextEnd; i++) {
              // console.log(`${i + 1}: ${lines[i]}`);
            }
          }
        }
        
        // Multiple search strategies with detailed logging
        const searchStrategies = [
          { name: "exact_line", description: "Exact line match (trimmed)" },
          { name: "exact_multiline", description: "Exact multi-line sequence match" },
          { name: "substring_match", description: "Substring match (non-comment lines)" },
          { name: "contains_all_words", description: "Contains all significant words" },
          { name: "fuzzy_match", description: "Fuzzy matching with scoring" }
        ];
        
        // Continue with existing search strategies if not found around specific line
        if (foundLine === -1) {
          // Strategy 1: Exact line match (for single lines)
          if (!cleanSnippet.includes('\n')) {
            // console.log("Trying exact line match...");
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].trim() === cleanSnippet) {
                foundLine = i + 1;
                // console.log(`Found exact match at line ${foundLine}`);
                break;
              }
            }
          }
        
        // Strategy 2: Exact multi-line sequence match
        if (foundLine === -1 && cleanSnippet.includes('\n')) {
          // console.log("Trying exact multi-line match...");
          const snippetLines = cleanSnippet.split('\n').map(line => line.trim());
          
          for (let i = 0; i <= lines.length - snippetLines.length; i++) {
            let allLinesMatch = true;
            
            for (let j = 0; j < snippetLines.length; j++) {
              const fileLine = lines[i + j].trim();
              const snippetLine = snippetLines[j];
              
              if (fileLine !== snippetLine) {
                allLinesMatch = false;
                break;
              }
            }
            
            if (allLinesMatch) {
              foundLine = i + 1;
              // console.log(`Found exact multi-line match starting at line ${foundLine}`);
              break;
            }
          }
        }
        
        // Strategy 3: Substring match (skip comments and empty lines)
        if (foundLine === -1) {
          // console.log("Trying substring match...");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Skip empty lines and comments
            if (!line || line.startsWith('--') || line.startsWith('//') || 
                line.startsWith('/*') || line.startsWith('*') || line.startsWith('#')) {
              continue;
            }
            
            if (line.includes(cleanSnippet)) {
              foundLine = i + 1;
              // console.log(`Found substring match at line ${foundLine}: "${line}"`);
              break;
            }
          }
        }
        
        // Strategy 4: Contains all significant words (for function signatures, etc.)
        if (foundLine === -1) {
          // console.log("Trying contains all words match...");
          const snippetWords = cleanSnippet.split(/\s+/)
            .filter(word => word.length > 2 && !/^(::|\->|=>|{|}|\(|\)|;|,)$/.test(word));
          
          if (snippetWords.length > 0) {
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();
              
              // Skip empty lines and comments
              if (!line || line.startsWith('--') || line.startsWith('//') || 
                  line.startsWith('/*') || line.startsWith('*') || line.startsWith('#')) {
                continue;
              }
              
              const lineText = line.toLowerCase();
              let wordsFound = 0;
              
              for (const word of snippetWords) {
                if (lineText.includes(word.toLowerCase())) {
                  wordsFound++;
                }
              }
              
              // Must contain ALL significant words
              if (wordsFound === snippetWords.length) {
                foundLine = i + 1;
                // console.log(`Found all-words match at line ${foundLine}: "${line}"`);
                // console.log(`Matched words: ${snippetWords.join(', ')}`);
                break;
              }
            }
          }
        }
        
        // Strategy 5: Fuzzy matching with detailed scoring
        if (foundLine === -1) {
          // console.log("Trying fuzzy match with scoring...");
          const snippetWords = cleanSnippet.split(/\s+/).filter(word => word.length > 1);
          let bestMatch = { line: -1, score: 0, matchedLine: "" };
          
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Skip empty lines and comments
            if (!line || line.startsWith('--') || line.startsWith('//') || 
                line.startsWith('/*') || line.startsWith('*') || line.startsWith('#')) {
              continue;
            }
            
            const lineText = line.toLowerCase();
            const snippetText = cleanSnippet.toLowerCase();
            
            // Calculate multiple similarity scores
            let wordMatchCount = 0;
            let totalWordScore = 0;
            
            for (const word of snippetWords) {
              if (lineText.includes(word.toLowerCase())) {
                wordMatchCount++;
                totalWordScore += word.length; // Weight by word length
              }
            }
            
            const wordMatchRatio = snippetWords.length > 0 ? wordMatchCount / snippetWords.length : 0;
            const substringScore = lineText.includes(snippetText.slice(0, 20)) ? 0.5 : 0; // Partial substring
            const lengthPenalty = Math.abs(line.length - cleanSnippet.length) / Math.max(line.length, cleanSnippet.length);
            
            const finalScore = (wordMatchRatio * 0.7) + (substringScore * 0.3) - (lengthPenalty * 0.1);
            
            if (finalScore > bestMatch.score && finalScore >= 0.6) {
              bestMatch = { line: i + 1, score: finalScore, matchedLine: line };
            }
          }
          
          if (bestMatch.line > 0) {
            foundLine = bestMatch.line;
            // console.log(`Found fuzzy match at line ${foundLine} (score: ${bestMatch.score.toFixed(3)}): "${bestMatch.matchedLine}"`);
          }
        }
        
        if (foundLine === -1) {
          // console.log("No match found with any strategy");
          
          // Enhanced debugging - show file structure and sample lines
          const debugInfo = {
            totalLines: lines.length,
            searchedSnippet: cleanSnippet,
            searchStrategies: searchStrategies.map(s => s.description),
            fileSample: {
              firstLines: lines.slice(0, 10).map((line, idx) => `${idx + 1}: ${line}`),
              middleLines: lines.slice(Math.floor(lines.length/2) - 5, Math.floor(lines.length/2) + 5)
                .map((line, idx) => `${Math.floor(lines.length/2) - 4 + idx}: ${line}`),
              lastLines: lines.slice(-10).map((line, idx) => `${lines.length - 9 + idx}: ${line}`)
            },
            potentialMatches: [] as Array<{lineNumber: number, content: string, similarity: string}>
          };
          
          // Find potential partial matches for debugging
          const snippetLower = cleanSnippet.toLowerCase();
          const firstWord = cleanSnippet.split(/\s+/)[0];
          
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const lineLower = line.toLowerCase();
            
            if (line && (lineLower.includes(firstWord.toLowerCase()) || 
                         lineLower.includes(snippetLower.slice(0, 10)))) {
              debugInfo.potentialMatches.push({
                lineNumber: i + 1,
                content: line,
                similarity: "Contains first word or partial match"
              });
              
              if (debugInfo.potentialMatches.length >= 20) break; // Limit output
            }
          }
          
          return JSON.stringify({
            found: false,
            message: "Code snippet not found in the file after exhaustive search.",
            debugInfo,
            suggestion: "Check if the code snippet is exact, or try searching for a unique function name or variable"
          }, null, 2);
        }
        
        } // End of search strategies
        
        // Show context around found line
        const contextStart = Math.max(1, foundLine - 5);
        const contextEnd = Math.min(lines.length, foundLine + 5);
        const contextLines = lines.slice(contextStart - 1, contextEnd).map((line, idx) => {
          const lineNum = contextStart + idx;
          const marker = lineNum === foundLine ? " >>> " : "     ";
          return `${marker}${lineNum}: ${line}`;
        });
        
        // For multi-line snippets, calculate the end line
        const snippetLineCount = cleanSnippet.includes('\n') ? cleanSnippet.split('\n').length : 1;
        const endLineNumber = foundLine + snippetLineCount - 1;
        
        return JSON.stringify({
          found: true,
          startLine: foundLine,
          endLine: endLineNumber,
          lineNumber: foundLine, // Keep for backward compatibility
          message: `Code snippet found at line${snippetLineCount > 1 ? 's' : ''} ${foundLine}${snippetLineCount > 1 ? `-${endLineNumber}` : ''}`,
          matchedLine: lines[foundLine - 1],
          matchedLines: snippetLineCount > 1 ? lines.slice(foundLine - 1, endLineNumber) : undefined,
          context: contextLines,
          totalLines: lines.length,
          nextStep: `Use with bitbucket_get_git_blame (startLine: ${foundLine}, endLine: ${endLineNumber})`
        }, null, 2);
        
      } catch (err) {
        throw new UserError(`Error processing file: ${(err as Error).message}`);
      }
    },
  });

  // -------- Bitbucket git blame tool --------
  server.addTool({
    name: "bitbucket_get_git_blame",
    description: "Get Git blame for a file in Bitbucket with the correct lines the given code covers. After this tool, it is mandatory to call jira_get_issue tool to get the Jira description and link from the Jira ticket. For calling this tool you need to be absolutely be sure about the lines of the code. For each of the Jira ID in the response call the jira_get_issue tool to get the description and link. And provide a super detailed output at the end.",
    parameters: z.object({
      projectKey: z.string(),
      repoSlug: z.string(),
      filePath: z.string(),
      startLine: z.number(),
      endLine: z.number(),
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
    }, context?: any) => {
      const bitbucket = createBitbucketClient(context?.session);
      if (!bitbucket) {
        throw new UserError("Bitbucket client not configured - missing session data (bitbucketBaseUrl, bitbucketUserName, bitbucketAppPassword)");
      }
      try {
        const blameResponse = await bitbucket.getGitBlame(
          projectKey,
          repoSlug,
          filePath,
          startLine,
          endLine
        );
        const blame = blameResponse.blame || blameResponse.values || [];
        const processed = blame.map((b: any) => ({
          name: b.author.name,
          emailAddress: b.author.emailAddress,
          commitId: b.commitHash,
          lineNoFrom: b.lineNumber,
          lineNoTo: b.lineNumber + b.spannedLines - 1,
        }));

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

  // -------- Kibana Search tool --------
  server.addTool({
    name: "kibana_search_logs",
    description: "Search Kibana logs using OpenSearch API with support for AND, OR, and NOT conditions. Includes progressive token counting and result truncation.",
    parameters: z.object({
      start_time: z.string().describe("Start time for log search in ISO format (e.g., '2024-01-01T00:00:00Z')"),
      end_time: z.string().describe("End time for log search in ISO format (e.g., '2024-01-01T23:59:59Z')"),
      query_terms: z.array(z.string()).optional().describe("Terms that must all be present (AND condition)"),
      or_terms: z.array(z.string()).optional().describe("Terms where at least one must be present (OR condition)"),
      not_terms: z.array(z.string()).optional().describe("Terms that must not be present (NOT condition)"),
      max_results: z.number().optional().default(500).describe("Maximum number of results to return"),
      response_format: z.enum(["concise", "detailed"]).optional().default("concise").describe("Format of response - 'concise' for just messages, 'detailed' for full log entries"),
      max_tokens: z.number().optional().default(50000).describe("Maximum tokens in response before truncation")
    }),
    execute: async ({
      start_time,
      end_time,
      query_terms,
      or_terms,
      not_terms,
      max_results = 500,
      response_format = "concise",
      max_tokens = 50000
    }: {
      start_time: string;
      end_time: string;
      query_terms?: string[];
      or_terms?: string[];
      not_terms?: string[];
      max_results?: number;
      response_format?: "concise" | "detailed";
      max_tokens?: number;
    }, context?: any) => {
      const kibana = createKibanaClient(context?.session);
      if (!kibana) {
        throw new UserError("Kibana client not configured - missing session data (kibanaBaseUrl, kibanaCookie)");
      }
      try {
        const searchResult = await kibana.searchLogs({
          start_time,
          end_time,
          query_terms,
          or_terms,
          not_terms,
          max_results,
          response_format,
          max_tokens
        });
        
        return JSON.stringify(searchResult, null, 2);
      } catch (err) {
        throw new UserError(`Error searching Kibana logs: ${(err as Error).message}`);
      }
    },
  });
}
