/**
 * Universal Tool Schema System for JAF Agentic Architecture
 *
 * Defines strict input/output schemas for ALL tools to ensure:
 * - LLM outputs conform to structured formats
 * - Type safety and validation
 * - Consistent tool execution patterns
 * - Easy tool discovery and documentation
 */

import type { JSONSchema7, JSONSchema7Definition } from "json-schema"
import { z } from "zod"
import { Apps } from "@xyne/vespa-ts/types"
import {
  ToolReviewFindingSchema,
  ListCustomAgentsInputSchema,
  RunPublicAgentInputSchema,
  SubTaskSchema,
} from "./agent-schemas"
import type { Entity, MailParticipant } from "@xyne/vespa-ts/types"
import { zodSchemaToJsonSchema } from "./jaf-provider-utils"
import { timeRangeSchema } from "./tools/schemas"
import { XyneTools } from "@/shared/types"
import {
  LsKnowledgeBaseInputSchema,
  LS_KNOWLEDGE_BASE_TOOL_DESCRIPTION,
  SEARCH_KNOWLEDGE_BASE_TOOL_DESCRIPTION,
  SearchKnowledgeBaseInputSchema,
} from "./tools/knowledgeBaseFlow"

export type {
  ListCustomAgentsInput,
  RunPublicAgentInput,
} from "./agent-schemas"
export type {
  KnowledgeBaseTarget,
  LsKnowledgeBaseToolParams,
  SearchKnowledgeBaseToolParams,
} from "./tools/knowledgeBaseFlow"

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
  Finalization = "finalization",
}

export interface ToolExample<TInput, TOutput> {
  input: TInput
  output: TOutput
  scenario: string
}

// ============================================================================
// BASE SCHEMAS
// ============================================================================

const STANDARD_LIMIT_DESCRIPTION =
  "Maximum number of results to return. Keep this small for precision-first retrieval and increase only when broader coverage is necessary."

const STANDARD_OFFSET_DESCRIPTION =
  "Pagination offset. Use it after reviewing the current page to continue from the next unseen results."

const FOLLOW_UP_EXCLUDED_IDS_DESCRIPTION =
  "Previously seen result document `docId`s to suppress on follow-up searches. Prefer prior `fragment.source.docId` values. Do not pass collection, folder, file, path, or fragment IDs."

// Pagination schema
export const PaginationSchema = z.object({
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe(STANDARD_LIMIT_DESCRIPTION),
  offset: z
    .number()
    .min(0)
    .optional()
    .default(0)
    .describe(STANDARD_OFFSET_DESCRIPTION),
})

// Sort direction schema
export const SortDirectionSchema = z
  .enum(["asc", "desc"])
  .describe(
    "Sort direction. Use `desc` for newest-first or highest-priority-first ordering when supported, and `asc` for oldest-first ordering.",
  )
  .optional()

// Mail participant schema
export const MailParticipantSchema = z
  .object({
    from: z
      .array(z.string())
      .optional()
      .describe(
        "Sender identifiers as strings. Email addresses are best; full names or organization names are also accepted when needed.",
      ),
    to: z
      .array(z.string())
      .optional()
      .describe(
        "Primary recipient identifiers as strings. Email addresses are best; full names or organization names are also accepted when needed.",
      ),
    cc: z
      .array(z.string())
      .optional()
      .describe(
        "CC recipient identifiers as strings. Email addresses are best; full names or organization names are also accepted when needed.",
      ),
    bcc: z
      .array(z.string())
      .optional()
      .describe(
        "BCC recipient identifiers as strings. Email addresses are best; full names or organization names are also accepted when needed.",
      ),
  })
  .describe(
    "Structured Gmail participant filter object with optional `from`, `to`, `cc`, and `bcc` string arrays. Use only the fields that are explicitly relevant to the query.",
  )
  .optional()

// ============================================================================
// TOOL OUTPUT SCHEMAS
// ============================================================================

// Standard tool output with contexts
export const ToolOutputSchema = z.object({
  result: z
    .string()
    .describe("Human-readable summary of the tool execution result"),
  contexts: z
    .array(
      z.object({
        id: z.string(),
        content: z.string(),
        source: z
          .object({
            docId: z.string(),
            title: z.string(),
            url: z.string().default(""),
            app: z.string(),
            entity: z.any().optional(),
            // Preserve rich citation metadata for downstream consumers (KB, Slack threads, etc.)
            itemId: z.string().optional(),
            clId: z.string().optional(),
            page_title: z.string().optional(),
            threadId: z.string().optional(),
            parentThreadId: z.string().optional(),
          })
          .catchall(z.any()),
        confidence: z.number().min(0).max(1),
      }),
    )
    .optional()
    .describe("Retrieved context fragments"),
  error: z.string().optional().describe("Error message if execution failed"),
  metadata: z
    .record(z.string(), z.any())
    .optional()
    .describe("Additional metadata about execution"),
})

export type ToolOutput = z.infer<typeof ToolOutputSchema>

// ============================================================================
// PLANNING TOOL SCHEMAS
// ============================================================================

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
  plan: z.object({
    goal: z.string(),
    subTasks: z.array(SubTaskSchema),
  }),
})

export type ToDoWriteOutput = z.infer<typeof ToDoWriteOutputSchema>

// ============================================================================
// FINAL SYNTHESIS TOOL SCHEMAS
// ============================================================================

export const SynthesizeFinalAnswerInputSchema = z
  .object({})
  .describe(
    "No arguments allowed. Invoke only when you are fully ready to deliver the final answer.",
  )

export const SynthesizeFinalAnswerOutputSchema = z.object({
  result: z
    .string()
    .describe(
      "Confirmation that the final synthesis was executed (the actual answer is streamed to the user).",
    ),
  streamed: z
    .boolean()
    .describe(
      "Indicates whether the answer was streamed to the user directly during tool execution.",
    ),
  metadata: z
    .object({
      textLength: z.number().describe("Characters streamed to the user."),
      totalImagesAvailable: z
        .number()
        .describe("Total tracked images across the run."),
      imagesProvided: z
        .number()
        .describe("Images forwarded to the final synthesis call, post limit."),
    })
    .partial()
    .optional(),
})

export type SynthesizeFinalAnswerInput = z.infer<
  typeof SynthesizeFinalAnswerInputSchema
>
export type SynthesizeFinalAnswerOutput = z.infer<
  typeof SynthesizeFinalAnswerOutputSchema
>

// ============================================================================
// SEARCH TOOL SCHEMAS
// ============================================================================

// Global search input
export const SearchGlobalInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Required broad retrieval query string for cross-app search when the right source is not yet known. Prefer app-specific tools when the likely source is already clear.",
    ),
  limit: z.number().optional().describe(STANDARD_LIMIT_DESCRIPTION),
  offset: z.number().optional().describe(STANDARD_OFFSET_DESCRIPTION),
  excludedIds: z
    .array(z.string())
    .optional()
    .describe(FOLLOW_UP_EXCLUDED_IDS_DESCRIPTION),
})

export type SearchGlobalInput = z.infer<typeof SearchGlobalInputSchema>

// Gmail search input
export const SearchGmailInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Optional short email-content retrieval query string. Omit it when participant, label, or time filters already define the request well enough.",
    ),
  participants: MailParticipantSchema,
  labels: z
    .array(z.string())
    .optional()
    .describe(
      "Optional Gmail label strings to narrow the search, for example `INBOX`, `UNREAD`, `IMPORTANT`, `SENT`, or category labels.",
    ),
  timeRange: timeRangeSchema,
  limit: z.number().optional().describe(STANDARD_LIMIT_DESCRIPTION),
  offset: z.number().optional().describe(STANDARD_OFFSET_DESCRIPTION),
  sortBy: SortDirectionSchema,
  excludedIds: z
    .array(z.string())
    .optional()
    .describe(FOLLOW_UP_EXCLUDED_IDS_DESCRIPTION),
})

export type SearchGmailInput = z.infer<typeof SearchGmailInputSchema>

// Drive search input
export const SearchDriveInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Optional short content or title retrieval query string for Drive files. Omit it when owner, file-type, or time filters already define the request well enough.",
    ),
  owner: z
    .string()
    .optional()
    .describe(
      "Optional Drive owner identifier string. Email is preferred; owner display name can also work.",
    ),
  filetype: z
    .array(z.string())
    .optional()
    .describe(
      "Optional Drive file-type strings. Valid values come from Drive entity types such as `docs`, `sheets`, `slides`, `presentation`, `pdf`, `folder`, `image`, `video`, `audio`, or `zip`.",
    ),
  timeRange: timeRangeSchema,
  limit: z.number().optional().describe(STANDARD_LIMIT_DESCRIPTION),
  offset: z.number().optional().describe(STANDARD_OFFSET_DESCRIPTION),
  sortBy: SortDirectionSchema,
  excludedIds: z
    .array(z.string())
    .optional()
    .describe(FOLLOW_UP_EXCLUDED_IDS_DESCRIPTION),
})

export type SearchDriveInput = z.infer<typeof SearchDriveInputSchema>
//NOTE : Knowledgebase scehma is defined in knowledgeBaseFlow file since it has some specific types related to KB targets and projections.
export type SearchKnowledgeBaseInput = z.infer<
  typeof SearchKnowledgeBaseInputSchema
>

// Calendar search input
export const SearchCalendarInputSchema = z.object({
  query: z.string().describe(
    "Short meeting/topic retrieval query for calendar events. Put attendee, status, and time constraints in the dedicated filters.",
  ),
  attendees: z
    .array(z.string())
    .optional()
    .describe(
      "Optional attendee identifiers as strings. Email addresses are preferred; attendee display names can also work.",
    ),
  status: z
    .enum(["confirmed", "tentative", "cancelled"])
    .optional()
    .describe("Optional event status filter."),
  timeRange: timeRangeSchema,
  limit: z.number().optional().describe(STANDARD_LIMIT_DESCRIPTION),
  offset: z.number().optional().describe(STANDARD_OFFSET_DESCRIPTION),
  sortBy: SortDirectionSchema,
  excludedIds: z
    .array(z.string())
    .optional()
    .describe(FOLLOW_UP_EXCLUDED_IDS_DESCRIPTION),
})

export type SearchCalendarInput = z.infer<typeof SearchCalendarInputSchema>

// Google Contacts search input
export const SearchGoogleContactsInputSchema = z.object({
  query: z
    .string()
    .describe(
      "Person or company identifier such as a name, email, phone number, or title. Use this to disambiguate people before searching other sources.",
    ),
  limit: z.number().optional().describe(STANDARD_LIMIT_DESCRIPTION),
  offset: z.number().optional().describe(STANDARD_OFFSET_DESCRIPTION),
  excludedIds: z
    .array(z.string())
    .optional()
    .describe(FOLLOW_UP_EXCLUDED_IDS_DESCRIPTION),
})

export type SearchGoogleContactsInput = z.infer<
  typeof SearchGoogleContactsInputSchema
>

// Slack messages input
export const GetSlackRelatedMessagesInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Optional short Slack message-content query string. Omit it when channel, author, mentions, or time filters already define the request well enough.",
    ),
  channelName: z
    .string()
    .optional()
    .describe(
      "Optional Slack channel name string, such as `eng-launches`. Pass the human-facing channel name, not a Slack channel ID.",
    ),
  user: z
    .string()
    .optional()
    .describe(
      "Optional Slack user identifier string to restrict messages by author. Email is preferred; display name can also work.",
    ),
  mentions: z
    .array(z.string())
    .optional()
    .describe(
      "Optional list of mentioned-user identifier strings, usually emails or usernames, to find messages that mention specific people.",
    ),
  timeRange: timeRangeSchema,
  limit: z.number().optional().describe(STANDARD_LIMIT_DESCRIPTION),
  offset: z.number().optional().describe(STANDARD_OFFSET_DESCRIPTION),
  sortBy: SortDirectionSchema,
  excludedIds: z
    .array(z.string())
    .optional()
    .describe(FOLLOW_UP_EXCLUDED_IDS_DESCRIPTION),
})

export const GetSlackMessagesInputSchema = GetSlackRelatedMessagesInputSchema

export type GetSlackMessagesInput = z.infer<
  typeof GetSlackRelatedMessagesInputSchema
>

// Slack user profile input
export const GetSlackUserProfileInputSchema = z.object({
  user_email: z
    .string()
    .email()
    .describe("Email of user whose Slack profile to retrieve"),
})

export type GetSlackUserProfileInput = z.infer<
  typeof GetSlackUserProfileInputSchema
>

export const SearchChatHistoryInputSchema = z.object({
  query: z.string().describe("Search query to find relevant earlier messages in the conversation"),
  chatId: z.string().optional().describe("Conversation to search. Use the chatId from 'Relevant Past Experiences' when searching a past conversation; omit to search the current conversation only. Without a valid chatId no results are returned."),
  limit: z.number().min(1).max(10).optional().describe("Max number of conversation messages to return"),
})
export type SearchChatHistoryInput = z.infer<typeof SearchChatHistoryInputSchema>

// ============================================================================
// AGENT TOOL SCHEMAS
// ============================================================================

// List custom agents output
const ResourceItemSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  type: z.string().optional(),
})

const ResourceAccessSummarySchema = z.object({
  app: z.nativeEnum(Apps),
  status: z.enum(["available", "partial", "missing", "check_at_usage"]),
  availableItems: z.array(ResourceItemSchema).optional(),
  missingItems: z.array(ResourceItemSchema).optional(),
  note: z.string().optional(),
})

export const ListCustomAgentsOutputSchema = z.object({
  agents: z
    .array(
      z.object({
        agentId: z.string(),
        agentName: z.string(),
        description: z.string(),
        capabilities: z.array(z.string()),
        domains: z.array(z.string()),
        suitabilityScore: z.number().min(0).max(1),
        confidence: z.number().min(0).max(1),
        estimatedCost: z.enum(["low", "medium", "high"]),
        averageLatency: z.number(),
        resourceAccess: z.array(ResourceAccessSummarySchema).optional(),
      }),
    )
    .nullable()
    .describe(
      "Ordered list of best-fit agents. Return null when no agent is sufficiently certain.",
    ),
  totalEvaluated: z.number(),
})

export type ListCustomAgentsOutput = z.infer<
  typeof ListCustomAgentsOutputSchema
>
export type ResourceAccessItem = z.infer<typeof ResourceItemSchema>
export type ResourceAccessSummary = z.infer<typeof ResourceAccessSummarySchema>

// Review agent input
export const ReviewAgentInputSchema = z.object({})

export type ReviewAgentInput = z.infer<typeof ReviewAgentInputSchema>

export const ReviewAgentOutputSchema = z.object({
  result: z.string().describe("High level summary of review outcome"),
  recommendation: z
    .enum(["proceed", "gather_more", "clarify_query", "replan"])
    .describe("Next action recommendation"),
  metExpectations: z
    .boolean()
    .describe("Whether tool expectations were satisfied"),
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
  anomaliesDetected: z.boolean().describe("Whether any anomalies were found"),
  anomalies: z.array(z.string()).describe("Descriptions of detected anomalies"),
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
  reasoning: z.string().describe("Detailed reasoning about why search failed"),
})

export type FallbackToolOutput = z.infer<typeof FallbackToolOutputSchema>

// ============================================================================
// TOOL REGISTRY
// ============================================================================

export const TOOL_SCHEMAS: Record<string, ToolSchema> = {
  // Planning Tools
  toDoWrite: {
    name: XyneTools.toDoWrite,
    description: "Create or update an execution plan with sequential tasks. MUST be called first before any other tool.",
    category: ToolCategory.Planning,
    inputSchema: ToDoWriteInputSchema,
    outputSchema: ToDoWriteOutputSchema,
    examples: [
      {
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
              toolsRequired: [
                "searchGmail",
                "getSlackRelatedMessages",
                "searchDriveFiles",
              ],
            },
          ],
        },
        output: {
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
      },
    ],
  },

  // Search Tools
  searchGlobal: {
    name: XyneTools.searchGlobal,
    description:
      "Search across all accessible data sources when the likely source is unclear. Prefer a more specific tool when the query already points clearly to Gmail, Drive, Slack, Calendar, Contacts, or a known KB location.",
    category: ToolCategory.Search,
    inputSchema: SearchGlobalInputSchema,
    outputSchema: ToolOutputSchema,
  },

  searchKnowledgeBase: {
    name: XyneTools.searchKnowledgeBase,
    description: SEARCH_KNOWLEDGE_BASE_TOOL_DESCRIPTION,
    category: ToolCategory.Search,
    inputSchema: SearchKnowledgeBaseInputSchema,
    outputSchema: ToolOutputSchema,
    examples: [
      {
        scenario: "Search a known KB folder directly without browsing first",
        input: {
          query: "security review exception policy",
          filters: {
            targets: [
              {
                type: "path" as const,
                collectionId: "kb-collection-123",
                path: "/Policies/Security",
              },
            ],
          },
          limit: 5,
          excludedIds: ["doc-prev-1"],
        },
        output: {
          result: "Found relevant policy fragments in the targeted KB folder.",
          contexts: [],
        },
      },
      {
        scenario:
          "Search only the PDF files identified from a prior ls call",
        input: {
          query: "vendor risk questionnaire requirements",
          filters: {
            targets: [
              {
                type: "file" as const,
                fileId: "kb-file-pdf-1",
              },
              {
                type: "file" as const,
                fileId: "kb-file-pdf-2",
              },
            ],
          },
          limit: 5,
        },
        output: {
          result: "Searched only the selected PDF documents from the folder.",
          contexts: [],
        },
      },
    ],
  },

  ls: {
    name: "ls",
    description: LS_KNOWLEDGE_BASE_TOOL_DESCRIPTION,
    category: ToolCategory.Metadata,
    inputSchema: LsKnowledgeBaseInputSchema,
    outputSchema: ToolOutputSchema,
    examples: [
      {
        scenario: "Inspect a known collection root before deciding whether to search inside it",
        input: {
          target: {
            type: "collection" as const,
            collectionId: "kb-collection-123",
          },
          depth: 1,
          limit: 20,
          metadata: false,
        },
        output: {
          result: "Listed the top-level folders and files in the collection.",
          contexts: [],
        },
      },
      {
        scenario:
          "Inspect a folder with metadata so you can keep only PDF files for a later KB search",
        input: {
          target: {
            type: "path" as const,
            collectionId: "kb-collection-123",
            path: "/Policies/Security",
          },
          depth: 2,
          limit: 50,
          metadata: true,
        },
        output: {
          result:
            "Listed files with mime types and timestamps so PDF rows can be selected for targeted search.",
          contexts: [],
        },
      },
    ],
  },

  searchGmail: {
    name: XyneTools.searchGmail,
    description:
      "Search Gmail messages by content, participants, labels, and time range. Use participant filters for people and organizations instead of stuffing them into the query.",
    category: ToolCategory.Search,
    inputSchema: SearchGmailInputSchema,
    outputSchema: ToolOutputSchema,
  },

  searchDriveFiles: {
    name: XyneTools.searchDriveFiles,
    description:
      "Search Google Drive files by title/content with optional owner, file-type, and time filters.",
    category: ToolCategory.Search,
    inputSchema: SearchDriveInputSchema,
    outputSchema: ToolOutputSchema,
  },

  searchCalendarEvents: {
    name: XyneTools.searchCalendarEvents,
    description:
      "Search Google Calendar events by topic with optional attendee, status, and time filters.",
    category: ToolCategory.Search,
    inputSchema: SearchCalendarInputSchema,
    outputSchema: ToolOutputSchema,
  },

  searchGoogleContacts: {
    name: XyneTools.searchGoogleContacts,
    description:
      "Search Google Contacts by name, email, phone, or title. Use this first when person identity is ambiguous.",
    category: ToolCategory.Search,
    inputSchema: SearchGoogleContactsInputSchema,
    outputSchema: ToolOutputSchema,
    prerequisites: [
      "Must be used before contacting people with ambiguous names",
    ],
  },

  getSlackRelatedMessages: {
    name: XyneTools.getSlackRelatedMessages,
    description:
      "Search Slack messages with flexible filters for content, channel, author, mentions, and time range. When no query and no Slack filter fields are provided, the live tool defaults to recent Slack history.",
    category: ToolCategory.Search,
    inputSchema: GetSlackRelatedMessagesInputSchema,
    outputSchema: ToolOutputSchema,
  },

  getSlackUserProfile: {
    name: XyneTools.getSlackUserProfile,
    description:
      "Get a user's Slack profile by email address. Use when you need identity, channel, or profile metadata before deeper Slack search.",
    category: ToolCategory.Metadata,
    inputSchema: GetSlackUserProfileInputSchema,
    outputSchema: ToolOutputSchema,
  },

  searchChatHistory: {
    name: XyneTools.searchChatHistory,
    description:
      "Search earlier parts of this conversation for relevant context. Use when you need to recall what was said or decided in prior messages.",
    category: ToolCategory.Search,
    inputSchema: SearchChatHistoryInputSchema,
    outputSchema: ToolOutputSchema,
  },

  // Agent Tools
  list_custom_agents: {
    name: XyneTools.listCustomAgents,
    description: [
      "Find relevant custom agents for a query.",
      "Parameters: query (user intent), requiredCapabilities (capabilities string[]), maxAgents (upper bound).",
      "Always run this before calling run_public_agent; it returns null when no agent is confident enough.",
      "Use the output to compare multiple candidates before choosing one.",
    ].join(" "),
    category: ToolCategory.Agent,
    inputSchema: ListCustomAgentsInputSchema,
    outputSchema: ListCustomAgentsOutputSchema,
    prerequisites: ["Must be called before run_public_agent"],
    examples: [
      {
        scenario: "Identify renewal-focused agents for ACME Q4 blockers",
        input: {
          query: "Need a renewal specialist who can review ACME Q4 blockers",
          requiredCapabilities: ["renewal_strategy"],
          maxAgents: 2,
        },
        output: {
          agents: [
            {
              agentId: "agent_renewal_nav",
              agentName: "Renewal Navigator",
              description:
                "Summarizes customer renewals and risks across ACME accounts.",
              capabilities: ["renewal_strategy", "deal_health"],
              domains: ["salesforce", "revops"],
              suitabilityScore: 0.93,
              confidence: 0.9,
              estimatedCost: "medium",
              averageLatency: 3800,
              resourceAccess: [
                {
                  app: Apps.Slack,
                  status: "available",
                  availableItems: [{ id: "chan-ops", label: "#ops-alerts" }],
                },
              ],
            },
            {
              agentId: "agent_revops_deepdive",
              agentName: "RevOps Deep Dive",
              description:
                "Explains revenue risk drivers for enterprise deals.",
              capabilities: ["renewal_strategy", "pipeline_insights"],
              domains: ["revops"],
              suitabilityScore: 0.81,
              confidence: 0.78,
              estimatedCost: "low",
              averageLatency: 3200,
              resourceAccess: [
                {
                  app: Apps.GoogleDrive,
                  status: "available",
                },
              ],
            },
          ],
          totalEvaluated: 7,
        },
      },
    ],
  },

  run_public_agent: {
    name: XyneTools.runPublicAgent,
    description: [
      "Execute a vetted custom agent using a precise query.",
      "Arguments: agentId (from list_custom_agents), query (tailored instructions), optional context (extra grounding), optional maxTokens (cap output cost).",
      "Only call this after ambiguity is resolved and you've logged why this specific agent is the best fit.",
    ].join(" "),
    category: ToolCategory.Agent,
    inputSchema: RunPublicAgentInputSchema,
    outputSchema: ToolOutputSchema,
    prerequisites: [
      "Must call list_custom_agents first",
      "ambiguityResolved must be true",
    ],
    examples: [
      {
        scenario: "Delegate Delta Airlines renewal recap to Renewal Navigator",
        input: {
          agentId: "agent_renewal_nav",
          query:
            "Summarize Delta Airlines Q3 renewal blockers and list owners for each blocker.",
          context:
            "Delta Airlines confirmed as DAL GTM account; timeframe Q3 FY25.",
          maxTokens: 900,
        },
        output: {
          result:
            "Renewal Navigator summarized Delta Airlines blockers with owners.",
          contexts: [
            {
              id: "delta-renewal-summary",
              content:
                "Risk stems from security review and pending legal redlines.",
              source: {
                docId: "drive-doc-123",
                title: "Delta Renewal Brief",
                url: "https://drive.google.com/file/delta",
                app: "GoogleDrive",
                entity: "Delta Airlines",
              },
              confidence: 0.86,
            },
          ],
          metadata: {
            agentId: "agent_renewal_nav",
            tokensUsed: 640,
          },
        },
      },
    ],
  },

  // Fallback Tool
  fall_back: {
    name: XyneTools.fallBack,
    description:
      "Generate reasoning about why search failed when max iterations reached. Used automatically by system.",
    category: ToolCategory.Fallback,
    inputSchema: FallbackToolInputSchema,
    outputSchema: FallbackToolOutputSchema,
  },

  // Finalization Tool
  synthesize_final_answer: {
    name: XyneTools.synthesizeFinalAnswer,
    description: [
      "MANDATORY FINAL STEP.",
      "Call this tool exactly once when you have gathered all required context and are ready to deliver the final answer.",
      "It streams the final response to the user using the full text + image context.",
      "After calling this tool, do NOT call any other tools—simply acknowledge completion in your next assistant turn.",
    ].join(" "),
    category: ToolCategory.Finalization,
    inputSchema: SynthesizeFinalAnswerInputSchema,
    outputSchema: SynthesizeFinalAnswerOutputSchema,
    prerequisites: [
      "All necessary evidence collected",
      "Citations ready",
      "No further tool calls will be needed afterwards",
    ],
  },
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get tool schema by name
 */
export function getToolSchema(toolName: string): ToolSchema | undefined {
  return TOOL_SCHEMAS[toolName as XyneTools]
}

/**
 * Validate tool input against schema
 */
export function validateToolInput<T>(
  toolName: string,
  input: unknown,
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
  toolName: XyneTools,
  output: unknown,
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

function isJsonSchemaObject(
  value: JSONSchema7Definition | undefined,
): value is JSONSchema7 {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function formatJsonSchemaType(schema: JSONSchema7): string {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return `enum(${schema.enum.map((value) => JSON.stringify(value)).join(", ")})`
  }

  if (schema.type === "array") {
    const itemType = Array.isArray(schema.items)
      ? Array.from(
          new Set(
            schema.items
              .filter(isJsonSchemaObject)
              .map((item) => formatJsonSchemaType(item)),
          ),
        ).join(" | ") || "value"
      : isJsonSchemaObject(schema.items)
        ? formatJsonSchemaType(schema.items)
        : "value"
    return `array<${itemType}>`
  }

  if (typeof schema.type === "string") {
    return schema.type
  }

  if (Array.isArray(schema.type)) {
    return schema.type.join(" | ")
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const parts = schema.anyOf
      .filter(isJsonSchemaObject)
      .map((entry) => formatJsonSchemaType(entry))
    return Array.from(new Set(parts)).join(" | ") || "value"
  }

  if (schema.properties) return "object"
  if (schema.additionalProperties) return "record"

  return "value"
}

function formatParameterLines(
  schema: JSONSchema7,
  pathPrefix = "",
  depth = 0,
): string[] {
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const lines: string[] = []

  for (const [name, definition] of Object.entries(properties)) {
    if (!isJsonSchemaObject(definition)) continue

    const fullPath = pathPrefix ? `${pathPrefix}.${name}` : name
    const requiredLabel = required.has(name) ? "required" : "optional"
    const description = definition.description
      ? `: ${definition.description}`
      : ""

    lines.push(
      `${"  ".repeat(depth)}- \`${fullPath}\` (${formatJsonSchemaType(definition)}, ${requiredLabel})${description}`,
    )

    if (depth >= 1) continue

    if (definition.properties) {
      lines.push(...formatParameterLines(definition, fullPath, depth + 1))
    }
  }

  return lines
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
      desc += `**Prerequisites**:\n${schema.prerequisites.map((p) => `- ${p}`).join("\n")}\n\n`
    }

    const jsonSchema = zodSchemaToJsonSchema(schema.inputSchema)
    const parameterLines = formatParameterLines(jsonSchema)

    if (parameterLines.length > 0) {
      desc += `**Parameters**:\n${parameterLines.join("\n")}\n\n`
    } else {
      desc += `**Parameters**: No arguments.\n\n`
    }

    if (schema.examples && schema.examples.length > 0) {
      desc += `**Examples**:\n`
      for (const example of schema.examples.slice(0, 2)) {
        desc += `Scenario: ${example.scenario}\n`
        desc += `\`\`\`json\n${JSON.stringify(example.input, null, 2)}\n\`\`\`\n\n`
      }
    }

    descriptions.push(desc)
  }

  return descriptions.join("\n---\n\n")
}

/**
 * Get tools by category
 */
export function getToolsByCategory(category: ToolCategory): string[] {
  return Object.entries(TOOL_SCHEMAS)
    .filter(([_, schema]) => schema.category === category)
    .map(([name, _]) => name)
}
