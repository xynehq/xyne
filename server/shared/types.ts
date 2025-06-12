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
} from "search/types"
export type { Entity } from "search/types"

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
export type { Citation } from "@/api/chat"
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

const AutocompleteSchema = z.discriminatedUnion("type", [
  AutocompleteFileSchema,
  AutocompleteUserSchema,
  AutocompleteMailSchema,
  AutocompleteEventSchema,
  AutocompleteUserQueryHSchema,
  AutocompleteMailAttachmentSchema,
  AutocompleteChatUserSchema,
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

// Search Response Schema
export const SearchResultsSchema = z.discriminatedUnion("type", [
  UserResponseSchema,
  FileResponseSchema,
  MailResponseSchema,
  EventResponseSchema,
  MailAttachmentResponseSchema,
  ChatMessageResponseSchema,
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
  Reasoning = "rz",
  Error = "er",
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

export interface AgentReasoningIteration {
  type: AgentReasoningStepType.Iteration
  iteration: number
}

export interface AgentReasoningPlanning {
  type: AgentReasoningStepType.Planning
  details: string // e.g., "Planning next step..."
}

export interface AgentReasoningToolSelected {
  type: AgentReasoningStepType.ToolSelected
  toolName: AgentToolName | string // string for flexibility if new tools are added without enum update
}

export interface AgentReasoningToolParameters {
  type: AgentReasoningStepType.ToolParameters
  parameters: Record<string, any> // Parameters as an object
}

export interface AgentReasoningToolExecuting {
  type: AgentReasoningStepType.ToolExecuting
  toolName: AgentToolName | string
}

export interface AgentReasoningToolResult {
  type: AgentReasoningStepType.ToolResult
  toolName: AgentToolName | string
  resultSummary: string
  itemsFound?: number
  error?: string // If the tool execution resulted in an error
}

export interface AgentReasoningSynthesis {
  type: AgentReasoningStepType.Synthesis
  details: string // e.g., "Synthesizing answer from X fragments..."
}

export interface AgentReasoningValidationError {
  type: AgentReasoningStepType.ValidationError
  details: string // e.g., "Single result validation failed (POOR_MATCH #X). Will continue searching."
}

export interface AgentReasoningBroadeningSearch {
  type: AgentReasoningStepType.BroadeningSearch
  details: string // e.g., "Specific search failed validation X times. Attempting to broaden search."
}

export interface AgentReasoningAnalyzingQuery {
  type: AgentReasoningStepType.AnalyzingQuery
  details: string // e.g., "Analyzing your question..."
}

export interface AgentReasoningLogMessage {
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
}

export enum IngestionType {
  fullIngestion = "full_ingestion",
  partialIngestion = "partial_ingestion",
}
