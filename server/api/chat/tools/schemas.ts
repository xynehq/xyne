import { z } from "zod"
import config from "@/config"
import { Apps, GoogleApps } from "@xyne/vespa-ts"

export const retrievalQueryDescription = (app?: GoogleApps | Apps) => `
Create SHORT, targeted search terms optimized for retrieval systems. Focus on 1-3 key terms rather than long descriptive phrases.
      
      Step 1: Identify the MOST IMPORTANT specific keywords:
      - Person names (e.g., "John", "Sarah")
      - Business/project names (e.g., "uber", "zomato") 
      - Core topics (e.g., "contract", "invoice", "proposal")
      - Company names (e.g., "OpenAI", "Google")
      - Product names or key identifiers
      
      Step 2: EXCLUDE these generic terms:
      - Action words: "find", "show", "get", "search", "give", "recent", "latest"
      - Pronouns: "my", "your", "their"
      - Time references: "recent", "latest", "last week", "old", "new"
      - Quantity words: "5", "10", "most", "all", "some"
      - Generic types: "emails", "files", "documents", "meetings" (when used alone)
      - Filler words: "summary", "details", "info", "information", "about", "regarding"
      
      Step 3: Create CONCISE query (1-3 key terms max):
      ${
        app === GoogleApps.Contacts || !app
          ? "- Contact queries: Use person/company names, job titles (e.g., 'John Smith', 'OpenAI', 'CEO')"
          : ""
      }
      
      ${
        app === GoogleApps.Drive || !app
          ? "- File queries: Use topic + context (e.g., 'budget report', 'contract legal', 'project alpha')"
          : ""
      }
      ${
        app === GoogleApps.Calendar || !app
          ? "- Meeting queries: Use meeting topic + type (e.g., 'standup engineering', 'client demo', 'budget review')"
          : ""
      }
      ${
        app === Apps.Slack || !app
          ? "- Slack queries: Use discussion topic + context (e.g., 'deployment issue', 'feature review', 'team sync')"
          : ""
      }
      
      Examples:
      - "reimbursement procedure application process policy guidelines" → "reimbursement policy"
      - "meeting notes from last week about project updates" → "project updates"
      - "emails from John about the marketing campaign" → "John marketing"
      
      Step 4: Apply the rule:
      ${
        !app
          ? `- Global search: query is MANDATORY. Use 1-3 most important terms from available keywords to search across all apps (${Object.values(
              GoogleApps,
            )
              .map((v) => v)
              .join(",")} and ${Apps.Slack})`
          : "- IF specific content keywords found → create SHORT semantic query (1-3 terms)\n      - IF no specific content keywords found → set query to null"
      }
`

// Common pagination schemas
export const limitSchema = z
  .number()
  .min(1)
  .max(100)
  .describe(
    "Maximum number of results to return. Default behavior is to return 20 results.",
  )
  .default(20)

export const offsetSchema = z
  .number()
  .min(0)
  .describe(
    "Number of results to skip from the beginning, useful for pagination.",
  )
  .optional()

export const sortBySchema = z
  .enum(["asc", "desc"])
  .describe("Sort order of results. Accepts 'asc' or 'desc'.")
  .optional()

// Common time range schema
export const timeRangeSchema = z
  .object({
    startTime: z
      .string()
      .describe(`Start time in ${config.llmTimeFormat} format`),
    endTime: z.string().describe(`End time in ${config.llmTimeFormat} format`),
  })
  .describe(
    `Filter within a specific time range. Example: { startTime: ${config.llmTimeFormat}, endTime: ${config.llmTimeFormat} }`,
  )
  .optional()

export const createQuerySchema = (
  app?: Apps | GoogleApps,
  required = false,
) => {
  const baseSchema = z.string().describe(retrievalQueryDescription(app))
  return required
    ? baseSchema.min(1, `Query is required for ${app} search`)
    : baseSchema.optional()
}

// Time range with description factory
export const createTimeRangeSchema = (description?: string) =>
  timeRangeSchema
    .describe(
      description ||
        `Filter within a specific time range. Example: { startTime: ${config.llmTimeFormat}, endTime: ${config.llmTimeFormat} }`,
    )
    .optional()

// Common base parameters
export const baseToolParams = {
  limit: limitSchema,
  offset: offsetSchema,
  sortBy: sortBySchema,
  timeRange: timeRangeSchema,
}
