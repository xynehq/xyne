import {
  entitySchema,
  VespaFileSchema,
  VespaUserSchema,
  Apps,
  mailSchema,
  userSchema,
  fileSchema,
  MailResponseSchema,
  eventSchema,
  VespaEventSchema,
  userQuerySchema,
  MailAttachmentResponseSchema,
  mailAttachmentSchema,
  scoredChunk,
  chatUserSchema,
  ChatMessageResponseSchema,
  dataSourceFileSchema,
  chatContainerSchema,
  VespaChatContainerSchema,
  KbItemsSchema,
  VespaKbFileSchemaBase,
} from "search/types"
export {
  GooglePeopleEntity,
  DriveEntity,
  NotionEntity,
  CalendarEntity,
  MailAttachmentEntity,
  SlackEntity,
  Apps,
  isMailAttachment,
  SystemEntity,
  dataSourceFileSchema,
  DataSourceEntity,
  WebSearchEntity,
} from "search/types"
export type { Entity, VespaDataSourceFile, VespaGetResult } from "search/types"

// Define an enum for connection types - MOVED HERE FROM server/types.ts
export enum ConnectorType {
  // Google, Notion, Github
  SaaS = "SaaS",
  // DuckDB, Postgres, MySQL
  Database = "Database",
  // Weather api?
  API = "Api",
  // Manually uploaded data like pdf
  File = "File",
  // Where we can scrape and crawl
  Website = "Website",
  // All MCP Clients
  MCP = "Mcp",
}

// @ts-ignore
import type { AppRoutes, WsApp } from "@/server"
import { z } from "zod"

// @ts-ignore
export type { MessageReqType } from "@/api/search"
// @ts-ignore
export type { Citation, ImageCitation } from "@/api/chat"
export type {
  SelectPublicMessage,
  PublicUser,
  SelectPublicChat,
  PublicWorkspace,
  SelectPublicAgent,
  // @ts-ignore
} from "@/db/schema"

export type AppType = typeof AppRoutes
export type WebSocketApp = typeof WsApp

export enum AuthType {
  OAuth = "oauth",
  ServiceAccount = "service_account",
  // where there is a custom JSON
  // we store all the key information
  // needed for end to end encryption
  Custom = "custom",
  ApiKey = "api_key",
}

export enum ConnectorStatus {
  Connected = "connected",
  // Pending = 'pending',
  Connecting = "connecting",
  Paused = "paused",
  Failed = "failed",
  // for oauth we will default to this
  NotConnected = "not-connected",
}

export enum SyncJobStatus {
  // never ran
  NotStarted = "NotStarted",
  // Ongoing
  Started = "Started",
  // last status failed
  Failed = "Failed",
  // last status was good
  Successful = "Successful",
}

export enum OpenAIError {
  RateLimitError = "rate_limit_exceeded",
  InvalidAPIKey = "invalid_api_key",
}
export enum ApiKeyScopes {
  agent_chat = "CREATE_AGENT",
  create_agent = "AGENT_CHAT",
  agent_chat_stop = "AGENT_CHAT_STOP",
  normal_chat = "NORMAL_CHAT",
  upload_kb = "UPLOAD_KB",
}

export const AutocompleteFileSchema = z
  .object({
    type: z.literal(fileSchema),
    relevance: z.number(),
    title: z.string(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
  })
  .strip()

export const AutocompleteUserSchema = z
  .object({
    type: z.literal(userSchema),
    relevance: z.number(),
    // optional due to contacts
    name: z.string().optional(),
    email: z.string(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    photoLink: z.string().optional(),
  })
  .strip()

export const AutocompleteUserQueryHSchema = z
  .object({
    type: z.literal(userQuerySchema),
    docId: z.string(),
    query_text: z.string(),
    timestamp: z.number().optional(),
  })
  .strip()

export const AutocompleteMailSchema = z
  .object({
    type: z.literal(mailSchema),
    relevance: z.number(),
    // optional due to contacts
    subject: z.string().optional(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    threadId: z.string().optional(),
    docId: z.string(),
  })
  .strip()

export const AutocompleteMailAttachmentSchema = z
  .object({
    type: z.literal(mailAttachmentSchema),
    relevance: z.number(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    filename: z.string(),
    docId: z.string(),
  })
  .strip()

export const AutocompleteEventSchema = z
  .object({
    type: z.literal(eventSchema),
    relevance: z.number(),
    name: z.string().optional(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    docId: z.string(),
  })
  .strip()

export const AutocompleteChatUserSchema = z
  .object({
    type: z.literal(chatUserSchema),
    relevance: z.number(),
    // optional due to contacts
    name: z.string().optional(),
    email: z.string().optional(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    image: z.string(),
  })
  .strip()

export const AutocompleteChatContainerSchema = z
  .object({
    type: z.literal(chatContainerSchema),
    relevance: z.number(),
    name: z.string(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    docId: z.string(),
  })
  .strip()

const AutocompleteSchema = z.discriminatedUnion("type", [
  AutocompleteFileSchema,
  AutocompleteUserSchema,
  AutocompleteMailSchema,
  AutocompleteEventSchema,
  AutocompleteUserQueryHSchema,
  AutocompleteMailAttachmentSchema,
  AutocompleteChatUserSchema,
  AutocompleteChatContainerSchema,
])

export const AutocompleteResultsSchema = z.object({
  results: z.array(AutocompleteSchema),
})

export type AutocompleteResults = z.infer<typeof AutocompleteResultsSchema>

// when imported from the frontend the type comes with unknown types
// possibly related to
// https://github.com/colinhacks/zod/issues/3536#issuecomment-2374074951
export type FileAutocomplete = z.infer<typeof AutocompleteFileSchema>
export type UserAutocomplete = z.infer<typeof AutocompleteUserSchema>
export type MailAutocomplete = z.infer<typeof AutocompleteMailSchema>
export type ChatUserAutocomplete = z.infer<typeof AutocompleteChatUserSchema>
export type AutocompleteChatContainer = z.infer<
  typeof AutocompleteChatContainerSchema
>
export type MailAttachmentAutocomplete = z.infer<
  typeof AutocompleteMailAttachmentSchema
>
export type EventAutocomplete = z.infer<typeof AutocompleteEventSchema>
export type UserQueryHAutocomplete = z.infer<
  typeof AutocompleteUserQueryHSchema
>
export type Autocomplete = z.infer<typeof AutocompleteSchema>

// search result

export const FileResponseSchema = VespaFileSchema.pick({
  docId: true,
  title: true,
  url: true,
  app: true,
  entity: true,
  owner: true,
  ownerEmail: true,
  photoLink: true,
  updatedAt: true,
})
  .extend({
    type: z.literal(fileSchema),
    chunk: z.string().optional(),
    chunkIndex: z.number().optional(),
    mimeType: z.string(),
    chunks_summary: z.array(scoredChunk).optional(),
    relevance: z.number(),
    matchfeatures: z.any().optional(), // Add matchfeatures
    rankfeatures: z.any().optional(),
  })
  .strip()

export const KbFileResponseSchema = VespaKbFileSchemaBase.pick({
  docId: true,
  fileName: true,
  app: true,
  entity: true,
  createdBy: true,
  updatedAt: true,
  itemId: true,
  clId: true,
  mimeType: true,
})
  .extend({
    app: z.literal(Apps.KnowledgeBase),
    type: z.literal(KbItemsSchema),
    chunk: z.string().optional(),
    chunkIndex: z.number().optional(),
    chunks_summary: z.array(scoredChunk).optional(),
    relevance: z.number(),
    matchfeatures: z.any().optional(), // Add matchfeatures
    rankfeatures: z.any().optional(),
  })
  .strip()
export const EventResponseSchema = VespaEventSchema.pick({
  docId: true,
  name: true,
  url: true,
  app: true,
  entity: true,
  updatedAt: true,
})
  .extend({
    type: z.literal(eventSchema),
    relevance: z.number(),
    description: z.string().optional(),
    chunks_summary: z.array(z.string()).optional(),
    attendeesNames: z.array(z.string()).optional(),
    matchfeatures: z.any().optional(), // Add matchfeatures
    rankfeatures: z.any().optional(),
  })
  .strip()

export const UserResponseSchema = VespaUserSchema.pick({
  name: true,
  email: true,
  app: true,
  entity: true,
  photoLink: true,
  docId: true,
})
  .strip()
  .extend({
    type: z.literal(userSchema),
    relevance: z.number(),
    matchfeatures: z.any().optional(), // Add matchfeatures
    rankfeatures: z.any().optional(),
  })

export const DataSourceFileResponseSchema = z
  .object({
    docId: z.string(),
    title: z.string().optional(),
    fileName: z.string().optional(),
    url: z.string().optional(),
    owner: z.string().optional(),
    ownerEmail: z.string().email().optional(),
    updatedAt: z.number().optional(),
    createdAt: z.number().optional(),
    mimeType: z.string().optional(),
    size: z.number().optional(),

    type: z.literal(dataSourceFileSchema),
    app: z.literal(Apps.DataSource),
    entity: z.literal("file"),

    chunks_summary: z.array(scoredChunk).optional(),
    relevance: z.number(),
    matchfeatures: z.any().optional(),
    rankfeatures: z.any().optional(),
  })
  .strip()

export const ChatContainerResponseSchema = VespaChatContainerSchema.pick({
  docId: true,
  name: true,
  app: true,
  entity: true,
  updatedAt: true,
  isPrivate: true,
  isArchived: true,
  isGeneral: true,
  isIm: true,
  isMpim: true,
  topic: true,
  description: true,
  count: true,
})
  .extend({
    type: z.literal(chatContainerSchema),
    relevance: z.number(),
    matchfeatures: z.any().optional(),
    rankfeatures: z.any().optional(),
  })
  .strip()

// Search Response Schema
export const SearchResultsSchema = z.discriminatedUnion("type", [
  UserResponseSchema,
  FileResponseSchema,
  DataSourceFileResponseSchema,
  MailResponseSchema,
  EventResponseSchema,
  MailAttachmentResponseSchema,
  ChatMessageResponseSchema,
  ChatContainerResponseSchema,
  KbFileResponseSchema,
])

export type SearchResultDiscriminatedUnion = z.infer<typeof SearchResultsSchema>

export const SearchResponseSchema = z.object({
  count: z.number(),
  results: z.array(SearchResultsSchema),
  groupCount: z.any(),
  trace: z.any().optional(),
})

export type FileResponse = z.infer<typeof FileResponseSchema>

export type SearchResponse = z.infer<typeof SearchResponseSchema>

export const AnswerResponseSchema = z.object({})

// kept it minimal to prevent
// unnecessary data transfer
export enum AnswerSSEvents {
  Start = "s",
  AnswerUpdate = "u",
  End = "e",
}

export enum ChatSSEvents {
  ResponseMetadata = "rm",
  Start = "s",
  ResponseUpdate = "u",
  End = "e",
  ChatTitleUpdate = "ct",
  CitationsUpdate = "cu",
  ImageCitationUpdate = "icu",
  Reasoning = "rz",
  Error = "er",
  AttachmentUpdate = "au",
}

const messageMetadataSchema = z.object({
  chatId: z.string(),
  messageId: z.string(),
})

export type MessageMetadataResponse = z.infer<typeof messageMetadataSchema>

// very rudimentary
export enum UserRole {
  User = "User", // can do oauth of their own data or api key based
  TeamLeader = "TeamLeader", // manage Users
  Admin = "Admin", // Service account related changes
  SuperAdmin = "SuperAdmin", // Admin level changes
}

export enum UserAgentRole {
  Owner = "owner", // User who owns/created the agent
  Editor = "editor", // User who can edit the agent
  Viewer = "viewer", // User who can only view/use the agent
  Shared = "shared", // User who has been shared the agent (general access)
}

export enum MessageFeedback {
  Like = "like",
  Dislike = "dislike",
}

export enum MessageMode {
  Ask = "ask",
  Agentic = "agentic",
}
export enum AgentToolName {
  MetadataRetrieval = "metadata_retrieval",
  Search = "search",
  FilteredSearch = "filtered_search",
  TimeSearch = "time_search",
  SynthesizeAnswer = "SYNTHESIZE_ANSWER", // For the explicit synthesis step
  FallBack = "fall_back",
}

export enum AgentReasoningStepType {
  Iteration = "iteration",
  Planning = "planning",
  ToolSelected = "tool_selected",
  ToolParameters = "tool_parameters",
  ToolExecuting = "tool_executing",
  ToolResult = "tool_result",
  Synthesis = "synthesis",
  ValidationError = "validation_error", // For when single result validation fails
  BroadeningSearch = "broadening_search", // When the agent decides to broaden the search
  AnalyzingQuery = "analyzing_query", // Initial analysis step
  LogMessage = "log_message", // For generic log messages from the agent
}

export enum ContextSysthesisState {
  Complete = "complete",
  Partial = "partial_information",
  NotFound = "information_not_found",
}

// Enhanced reasoning step interfaces with summary support
export interface AgentReasoningStepEnhanced {
  stepId?: string
  stepSummary?: string
  aiGeneratedSummary?: string
  status?: "in_progress" | "completed" | "failed"
  timestamp?: number
  iteration?: number
  isIterationSummary?: boolean
}

export interface AgentReasoningIteration extends AgentReasoningStepEnhanced {
  type: AgentReasoningStepType.Iteration
  iteration: number
  app?: string
  entity?: string
}

export interface AgentReasoningPlanning extends AgentReasoningStepEnhanced {
  type: AgentReasoningStepType.Planning
  details: string // e.g., "Planning next step..."
}

export interface AgentReasoningToolSelected extends AgentReasoningStepEnhanced {
  type: AgentReasoningStepType.ToolSelected
  toolName: AgentToolName | string // string for flexibility if new tools are added without enum update
}

export interface AgentReasoningToolParameters
  extends AgentReasoningStepEnhanced {
  type: AgentReasoningStepType.ToolParameters
  parameters: Record<string, any> // Parameters as an object
}

export interface AgentReasoningToolExecuting
  extends AgentReasoningStepEnhanced {
  type: AgentReasoningStepType.ToolExecuting
  toolName: AgentToolName | string
}

export interface AgentReasoningToolResult extends AgentReasoningStepEnhanced {
  type: AgentReasoningStepType.ToolResult
  toolName: AgentToolName | string
  resultSummary: string
  itemsFound?: number
  error?: string // If the tool execution resulted in an error
}

export interface AgentReasoningSynthesis extends AgentReasoningStepEnhanced {
  type: AgentReasoningStepType.Synthesis
  details: string // e.g., "Synthesizing answer from X fragments..."
}

export interface AgentReasoningValidationError
  extends AgentReasoningStepEnhanced {
  type: AgentReasoningStepType.ValidationError
  details: string // e.g., "Single result validation failed (POOR_MATCH #X). Will continue searching."
}

export interface AgentReasoningBroadeningSearch
  extends AgentReasoningStepEnhanced {
  type: AgentReasoningStepType.BroadeningSearch
  details: string // e.g., "Specific search failed validation X times. Attempting to broaden search."
}

export interface AgentReasoningAnalyzingQuery
  extends AgentReasoningStepEnhanced {
  type: AgentReasoningStepType.AnalyzingQuery
  details: string // e.g., "Analyzing your question..."
}

export interface AgentReasoningLogMessage extends AgentReasoningStepEnhanced {
  type: AgentReasoningStepType.LogMessage
  message: string // Generic message from the agent's log
}

export type AgentReasoningStep =
  | AgentReasoningIteration
  | AgentReasoningPlanning
  | AgentReasoningToolSelected
  | AgentReasoningToolParameters
  | AgentReasoningToolExecuting
  | AgentReasoningToolResult
  | AgentReasoningSynthesis
  | AgentReasoningValidationError
  | AgentReasoningBroadeningSearch
  | AgentReasoningAnalyzingQuery
  | AgentReasoningLogMessage

export enum XyneTools {
  GetUserInfo = "get_user_info",
  MetadataRetrieval = "metadata_retrieval",
  Search = "search",
  FilteredSearch = "filtered_search",
  TimeSearch = "time_search",

  // Conversational tool
  Conversational = "conversational",

  // slack tools
  getSlackRelatedMessages = "get_slack_related_messages",
  getSlackThreads = "get_slack_threads",
  getUserSlackProfile = "get_user_slack_profile",
}

export enum IngestionType {
  fullIngestion = "full_ingestion",
  partialIngestion = "partial_ingestion",
}

// Attachment metadata types for enhanced attachment handling
export const attachmentMetadataSchema = z.object({
  fileId: z.string(),
  fileName: z.string(),
  fileType: z.string(),
  fileSize: z.number(),
  isImage: z.boolean(),
  thumbnailPath: z.string().optional(),
  createdAt: z.union([z.string(), z.date()]).transform((val) => {
    if (typeof val === "string") {
      return new Date(val)
    }
    return val
  }),
  url: z.string().optional(),
})

export type AttachmentMetadata = z.infer<typeof attachmentMetadataSchema>

export const ApiKeyPermissionsSchema = z
  .object({
    scopes: z.array(z.nativeEnum(ApiKeyScopes)),
    agents: z.array(z.string()).optional(),
  })
  .refine(
    (data) => {
      // If scopes contains agent_chat, then agent_id array must be present and non-empty
      const scopeSet = new Set(data.scopes)

      // Agent-related validation
      if (scopeSet.has(ApiKeyScopes.agent_chat) && !data.agents?.length) {
        return false
      }
      return true
    },
    {
      message: "agent_id array is required when scopes contains agent_chat",
      path: ["agents"],
    },
  )

export const CreateApiKeySchema = z.object({
  name: z.string().min(1, "Name is required"),
  permissions: ApiKeyPermissionsSchema,
})

export type ApiKeyPermissions = z.infer<typeof ApiKeyPermissionsSchema>
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeySchema>
