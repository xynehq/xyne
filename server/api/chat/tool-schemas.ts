/**
 * Universal Tool Schema System for JAF Agentic Architecture
 * 
 * Defines strict input/output schemas for ALL tools to ensure:
 * - LLM outputs conform to structured formats
 * - Type safety and validation
 * - Consistent tool execution patterns
 * - Easy tool discovery and documentation
 */

import { z } from "zod"
import { ToolReviewFindingSchema } from "./agent-schemas"
import type { Apps, Entity, MailParticipant } from "@xyne/vespa-ts/types"

// ============================================================================
// UNIVERSAL TOOL SCHEMA STRUCTURE
// ============================================================================

export interface ToolSchema<TInput = any, TOutput = any> {
  name: string
  description: string
  category: ToolCategory
  inputSchema: z.ZodType<TInput>
  outputSchema: z.ZodType<TOutput>
  examples?: ToolExample<TInput, TOutput>[]
  prerequisites?: string[]
}

export enum ToolCategory {
  Planning = "planning",
  Search = "search",
  Metadata = "metadata", 
  Agent = "agent",
  Clarification = "clarification",
  Review = "review",
  Fallback = "fallback",
}

export interface ToolExample<TInput, TOutput> {
  input: TInput
  output: TOutput
  scenario: string
}

// ============================================================================
// BASE SCHEMAS
// ============================================================================

// Common timestamp range schema
export const TimestampRangeSchema = z.object({
  startTime: z.string().optional().describe("ISO 8601 date string (e.g., '2024-01-01' or '2024-01-01T00:00:00Z')"),
  endTime: z.string().optional().describe("ISO 8601 date string (e.g., '2024-12-31' or '2024-12-31T23:59:59Z')"),
}).optional()

// Pagination schema
export const PaginationSchema = z.object({
  limit: z.number().min(1).max(100).optional().default(20).describe("Maximum number of results to return (1-100)"),
  offset: z.number().min(0).optional().default(0).describe("Number of results to skip for pagination"),
})

// Sort direction schema
export const SortDirectionSchema = z.enum(["asc", "desc"]).optional()

// Mail participant schema
export const MailParticipantSchema = z.object({
  from: z.array(z.string().email()).optional().describe("Sender email addresses"),
  to: z.array(z.string().email()).optional().describe("Recipient email addresses"),
  cc: z.array(z.string().email()).optional().describe("CC email addresses"),
  bcc: z.array(z.string().email()).optional().describe("BCC email addresses"),
}).optional()

// ============================================================================
// TOOL OUTPUT SCHEMAS
// ============================================================================

// Standard tool output with contexts
export const ToolOutputSchema = z.object({
  result: z.string().describe("Human-readable summary of the tool execution result"),
  contexts: z.array(z.object({
    id: z.string(),
    content: z.string(),
    source: z.object({
      docId: z.string(),
      title: z.string(),
      url: z.string(),
      app: z.string(),
      entity: z.string().optional(),
    }),
    confidence: z.number().min(0).max(1),
  })).optional().describe("Retrieved context fragments"),
  error: z.string().optional().describe("Error message if execution failed"),
  metadata: z.record(z.any()).optional().describe("Additional metadata about execution"),
})

export type ToolOutput = z.infer<typeof ToolOutputSchema>

// ============================================================================
// PLANNING TOOL SCHEMAS
// ============================================================================

// SubTask schema for planning
export const SubTaskSchema = z.object({
  id: z.string(),
  description: z.string().describe("Clear description of what this sub-goal achieves"),
  status: z.enum(["pending", "in_progress", "completed", "blocked", "failed"]).default("pending"),
  toolsRequired: z.array(z.string()).describe("All tools needed to achieve this sub-goal"),
  result: z.string().optional(),
  completedAt: z.number().optional(),
  error: z.string().optional(),
})

// toDoWrite input schema
export const ToDoWriteInputSchema = z.object({
  goal: z.string().describe("The overarching goal to accomplish"),
  subTasks: z
    .array(SubTaskSchema)
    .min(1)
    .describe("Sequential tasks, each representing one sub-goal"),
})

export type ToDoWriteInput = z.infer<typeof ToDoWriteInputSchema>

// toDoWrite output schema
export const ToDoWriteOutputSchema = z.object({
  result: z.string().describe("Confirmation message"),
  plan: z.object({
    goal: z.string(),
    subTasks: z.array(SubTaskSchema),
  }),
})

export type ToDoWriteOutput = z.infer<typeof ToDoWriteOutputSchema>

// ============================================================================
// SEARCH TOOL SCHEMAS
// ============================================================================

// Global search input
export const SearchGlobalInputSchema = z.object({
  query: z.string().optional().describe("Search query keywords"),
  limit: z.number().optional(),
  offset: z.number().optional(),
  excludedIds: z.array(z.string()).optional().describe("Document IDs to exclude from results"),
})

export type SearchGlobalInput = z.infer<typeof SearchGlobalInputSchema>

// Gmail search input
export const SearchGmailInputSchema = z.object({
  query: z.string().describe("Email search query"),
  participants: MailParticipantSchema,
  labels: z.array(z.string()).optional().describe("Gmail labels to filter by"),
  timeRange: TimestampRangeSchema,
  limit: z.number().optional(),
  offset: z.number().optional(),
  sortBy: SortDirectionSchema,
  excludedIds: z.array(z.string()).optional(),
})

export type SearchGmailInput = z.infer<typeof SearchGmailInputSchema>

// Drive search input
export const SearchDriveInputSchema = z.object({
  query: z.string().describe("Drive file search query"),
  owner: z.string().email().optional().describe("Filter by file owner email"),
  filetype: z.array(z.string()).optional().describe("File entity types (e.g., 'document', 'spreadsheet')"),
  timeRange: TimestampRangeSchema,
  limit: z.number().optional(),
  offset: z.number().optional(),
  sortBy: SortDirectionSchema,
  excludedIds: z.array(z.string()).optional(),
})

export type SearchDriveInput = z.infer<typeof SearchDriveInputSchema>

// Calendar search input
export const SearchCalendarInputSchema = z.object({
  query: z.string().describe("Calendar event search query"),
  attendees: z.array(z.string().email()).optional().describe("Filter by attendee emails"),
  status: z.enum(["confirmed", "tentative", "cancelled"]).optional().describe("Event status"),
  timeRange: TimestampRangeSchema,
  limit: z.number().optional(),
  offset: z.number().optional(),
  sortBy: SortDirectionSchema,
  excludedIds: z.array(z.string()).optional(),
})

export type SearchCalendarInput = z.infer<typeof SearchCalendarInputSchema>

// Google Contacts search input
export const SearchGoogleContactsInputSchema = z.object({
  query: z.string().describe("Contact search query (name, email, phone, etc.)"),
  limit: z.number().optional(),
  offset: z.number().optional(),
  excludedIds: z.array(z.string()).optional(),
})

export type SearchGoogleContactsInput = z.infer<typeof SearchGoogleContactsInputSchema>

// Slack messages input
export const GetSlackMessagesInputSchema = z.object({
  filter_query: z.string().optional().describe("Keywords to search within messages"),
  channel_name: z.string().optional().describe("Specific channel name"),
  user_email: z.string().email().optional().describe("Filter by user email"),
  date_from: z.string().optional().describe("Start date (ISO 8601)"),
  date_to: z.string().optional().describe("End date (ISO 8601)"),
  limit: z.number().optional(),
  offset: z.number().optional(),
  order_direction: SortDirectionSchema,
})

export type GetSlackMessagesInput = z.infer<typeof GetSlackMessagesInputSchema>

// Slack user profile input
export const GetSlackUserProfileInputSchema = z.object({
  user_email: z.string().email().describe("Email of user whose Slack profile to retrieve"),
})

export type GetSlackUserProfileInput = z.infer<typeof GetSlackUserProfileInputSchema>

// ============================================================================
// AGENT TOOL SCHEMAS
// ============================================================================

// List custom agents input
export const ListCustomAgentsInputSchema = z.object({
  query: z.string().describe("User query to find relevant agents"),
  requiredCapabilities: z.array(z.string()).optional().describe("Required agent capabilities"),
  maxAgents: z.number().min(1).max(10).optional().default(5).describe("Maximum agents to return"),
})

export type ListCustomAgentsInput = z.infer<typeof ListCustomAgentsInputSchema>

// List custom agents output
export const ListCustomAgentsOutputSchema = z.object({
  result: z.string(),
  agents: z.array(z.object({
    agentId: z.string(),
    agentName: z.string(),
    description: z.string(),
    capabilities: z.array(z.string()),
    domains: z.array(z.string()),
    suitabilityScore: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    estimatedCost: z.enum(["low", "medium", "high"]),
    averageLatency: z.number(),
  })),
  totalEvaluated: z.number(),
})

export type ListCustomAgentsOutput = z.infer<typeof ListCustomAgentsOutputSchema>

// Run public agent input
export const RunPublicAgentInputSchema = z.object({
  agentId: z.string().describe("Agent ID from list_custom_agents"),
  query: z.string().describe("Detailed, specific query for the agent"),
  context: z.string().optional().describe("Additional context for the agent"),
  maxTokens: z.number().optional().describe("Maximum tokens for agent response"),
})

export type RunPublicAgentInput = z.infer<typeof RunPublicAgentInputSchema>

// Review agent input
export const ReviewAgentInputSchema = z.object({
  focus: z
    .enum(["quality", "completeness", "replan", "general"])
    .optional()
    .describe("Primary focus for this review invocation"),
  examineTools: z
    .array(z.string())
    .optional()
    .describe("Subset of tool names to inspect"),
  includePlan: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to include the current execution plan in analysis"),
  maxFindings: z
    .number()
    .min(1)
    .max(10)
    .optional()
    .default(5)
    .describe("Maximum findings to enumerate"),
})

export type ReviewAgentInput = z.infer<typeof ReviewAgentInputSchema>

export const ReviewAgentOutputSchema = z.object({
  result: z.string().describe("High level summary of review outcome"),
  recommendation: z
    .enum(["proceed", "gather_more", "clarify_query", "replan"])
    .describe("Next action recommendation"),
  metExpectations: z.boolean().describe("Whether tool expectations were satisfied"),
  unmetExpectations: z
    .array(z.string())
    .describe("List of expectation goals that remain unmet"),
  planChangeNeeded: z
    .boolean()
    .describe("Whether the current plan needs to be updated"),
  planChangeReason: z
    .string()
    .optional()
    .describe("Why a plan change is required"),
  toolFeedback: z
    .array(ToolReviewFindingSchema)
    .describe("Per-tool assessment for this turn"),
  anomaliesDetected: z
    .boolean()
    .describe("Whether any anomalies were found"),
  anomalies: z
    .array(z.string())
    .describe("Descriptions of detected anomalies"),
})

export type ReviewAgentOutput = z.infer<typeof ReviewAgentOutputSchema>

// ============================================================================
// FALLBACK TOOL SCHEMA
// ============================================================================

export const FallbackToolInputSchema = z.object({
  originalQuery: z.string().describe("The original user query"),
  agentScratchpad: z.string().describe("Agent reasoning history"),
  toolLog: z.string().describe("Tool execution log"),
  gatheredFragments: z.string().describe("Gathered context fragments"),
})

export type FallbackToolInput = z.infer<typeof FallbackToolInputSchema>

export const FallbackToolOutputSchema = z.object({
  result: z.string(),
  fallbackReasoning: z.string().describe("Detailed reasoning about why search failed"),
  error: z.string().optional(),
})

export type FallbackToolOutput = z.infer<typeof FallbackToolOutputSchema>

// ============================================================================
// TOOL REGISTRY
// ============================================================================

export const TOOL_SCHEMAS: Record<string, ToolSchema> = {
  // Planning Tools
  toDoWrite: {
    name: "toDoWrite",
    description: "Create or update an execution plan with sequential tasks. MUST be called first before any other tool.",
    category: ToolCategory.Planning,
    inputSchema: ToDoWriteInputSchema,
    outputSchema: ToDoWriteOutputSchema,
    examples: [{
      input: {
        goal: "Find what Alex says about Q4",
        subTasks: [
          {
            id: "task_1",
            description: "Identify which Alex user is referring to",
            status: "pending" as const,
            toolsRequired: ["searchGoogleContacts"],
          },
          {
            id: "task_2", 
            description: "Search all of Alex's Q4 communications",
            status: "pending" as const,
            toolsRequired: ["searchGmail", "getSlackMessages", "searchDriveFiles"],
          },
        ],
      },
      output: {
        result: "Plan created successfully",
        plan: {
          goal: "Find what Alex says about Q4",
          subTasks: [
            {
              id: "task_1",
              description: "Identify which Alex user is referring to",
              status: "pending" as const,
              toolsRequired: ["searchGoogleContacts"],
            },
          ],
        },
      },
      scenario: "Creating a task-based plan for ambiguous query",
    }],
  },

  // Search Tools
  searchGlobal: {
    name: "searchGlobal",
    description: "Search across all accessible data sources. Use for broad searches when specific app is unknown.",
    category: ToolCategory.Search,
    inputSchema: SearchGlobalInputSchema,
    outputSchema: ToolOutputSchema,
  },

  searchGmail: {
    name: "searchGmail",
    description: "Search Gmail messages with filters for participants, labels, and time range.",
    category: ToolCategory.Search,
    inputSchema: SearchGmailInputSchema,
    outputSchema: ToolOutputSchema,
  },

  searchDriveFiles: {
    name: "searchDriveFiles",
    description: "Search Google Drive files with filters for owner, file type, and time range.",
    category: ToolCategory.Search,
    inputSchema: SearchDriveInputSchema,
    outputSchema: ToolOutputSchema,
  },

  searchCalendarEvents: {
    name: "searchCalendarEvents",
    description: "Search Google Calendar events with filters for attendees, status, and time range.",
    category: ToolCategory.Search,
    inputSchema: SearchCalendarInputSchema,
    outputSchema: ToolOutputSchema,
  },

  searchGoogleContacts: {
    name: "searchGoogleContacts",
    description: "Search Google Contacts by name, email, or phone. Use for disambiguating person names.",
    category: ToolCategory.Search,
    inputSchema: SearchGoogleContactsInputSchema,
    outputSchema: ToolOutputSchema,
    prerequisites: ["Must be used before contacting people with ambiguous names"],
  },

  getSlackMessages: {
    name: "getSlackMessages",
    description: "Search Slack messages with flexible filters for channel, user, time range.",
    category: ToolCategory.Search,
    inputSchema: GetSlackMessagesInputSchema,
    outputSchema: ToolOutputSchema,
  },

  getSlackUserProfile: {
    name: "getSlackUserProfile",
    description: "Get a user's Slack profile by email address.",
    category: ToolCategory.Metadata,
    inputSchema: GetSlackUserProfileInputSchema,
    outputSchema: ToolOutputSchema,
  },

  // Agent Tools
  list_custom_agents: {
    name: "list_custom_agents",
    description: "Find relevant custom agents for a query. MUST be called before run_public_agent.",
    category: ToolCategory.Agent,
    inputSchema: ListCustomAgentsInputSchema,
    outputSchema: ListCustomAgentsOutputSchema,
    prerequisites: ["Must be called before run_public_agent"],
  },

  run_public_agent: {
    name: "run_public_agent",
    description: "Execute a custom agent. Can only be used after ambiguity is resolved and list_custom_agents is called.",
    category: ToolCategory.Agent,
    inputSchema: RunPublicAgentInputSchema,
    outputSchema: ToolOutputSchema,
    prerequisites: [
      "Must call list_custom_agents first",
      "ambiguityResolved must be true",
    ],
  },

  review_agent: {
    name: "review_agent",
    description: "Evaluate gathered evidence, compare against expected results for recent tool calls, and recommend next actions.",
    category: ToolCategory.Review,
    inputSchema: ReviewAgentInputSchema,
    outputSchema: ReviewAgentOutputSchema,
    prerequisites: [
      "Use after completing at least one tool call",
      "Provide updated plan if you expect review to consider it",
    ],
  },

  // Fallback Tool
  fall_back: {
    name: "fall_back",
    description: "Generate reasoning about why search failed when max iterations reached. Used automatically by system.",
    category: ToolCategory.Fallback,
    inputSchema: FallbackToolInputSchema,
    outputSchema: FallbackToolOutputSchema,
  },
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get tool schema by name
 */
export function getToolSchema(toolName: string): ToolSchema | undefined {
  return TOOL_SCHEMAS[toolName]
}

/**
 * Validate tool input against schema
 */
export function validateToolInput<T>(
  toolName: string,
  input: unknown
): { success: true; data: T } | { success: false; error: z.ZodError } {
  const schema = getToolSchema(toolName)
  if (!schema) {
    throw new Error(`Tool schema not found: ${toolName}`)
  }

  const result = schema.inputSchema.safeParse(input)
  if (result.success) {
    return { success: true, data: result.data as T }
  } else {
    return { success: false, error: result.error }
  }
}

/**
 * Validate tool output against schema
 */
export function validateToolOutput<T>(
  toolName: string,
  output: unknown
): { success: true; data: T } | { success: false; error: z.ZodError } {
  const schema = getToolSchema(toolName)
  if (!schema) {
    throw new Error(`Tool schema not found: ${toolName}`)
  }

  const result = schema.outputSchema.safeParse(output)
  if (result.success) {
    return { success: true, data: result.data as T }
  } else {
    return { success: false, error: result.error }
  }
}

/**
 * Generate tool descriptions for LLM prompt
 */
export function generateToolDescriptions(toolNames: string[]): string {
  const descriptions: string[] = []

  for (const toolName of toolNames) {
    const schema = getToolSchema(toolName)
    if (!schema) continue

    let desc = `## ${schema.name}\n`
    desc += `**Category**: ${schema.category}\n`
    desc += `**Description**: ${schema.description}\n\n`

    if (schema.prerequisites && schema.prerequisites.length > 0) {
      desc += `**Prerequisites**:\n${schema.prerequisites.map(p => `- ${p}`).join('\n')}\n\n`
    }

    desc += `**Input Schema**: Use the defined Zod schema for this tool\n\n`

    if (schema.examples && schema.examples.length > 0) {
      desc += `**Example**:\n`
      desc += `Scenario: ${schema.examples[0].scenario}\n`
      desc += `\`\`\`json\n${JSON.stringify(schema.examples[0].input, null, 2)}\n\`\`\`\n\n`
    }

    descriptions.push(desc)
  }

  return descriptions.join('\n---\n\n')
}

/**
 * Get tools by category
 */
export function getToolsByCategory(category: ToolCategory): string[] {
  return Object.entries(TOOL_SCHEMAS)
    .filter(([_, schema]) => schema.category === category)
    .map(([name, _]) => name)
}
