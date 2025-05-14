import { sql, type InferModelFromColumns } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
  jsonb,
  boolean,
  pgEnum,
  unique,
  index,
} from "drizzle-orm/pg-core"
import { encryptedText } from "./customType"
import { Encryption } from "@/utils/encryption"
import { ConnectorType, MessageRole, SyncConfigSchema, SyncCron } from "@/types"
import {
  Apps,
  AuthType,
  ConnectorStatus,
  SyncJobStatus,
  UserRole,
} from "@/shared/types"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { SearchModes } from "@/search/vespa"

const encryptionKey = process.env.ENCRYPTION_KEY!
if (!encryptionKey) {
  throw new Error("ENCRYPTION_KEY environment variable is not set.")
}
const serviceAccountEncryptionKey = process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY
if (!serviceAccountEncryptionKey) {
  throw new Error(
    "SERVICE_ACCOUNT_ENCRYPTION_KEY environment variable is not set.",
  )
}

const accesskeyEncryption = new Encryption(encryptionKey)
const apiKeyEncryption = new Encryption(encryptionKey)

const serviceAccountEncryption = new Encryption(serviceAccountEncryptionKey)

// Workspaces Table
export const workspaces = pgTable("workspaces", {
  id: serial("id").notNull().primaryKey(),
  name: text("name").notNull(),
  domain: text("domain").notNull().unique(),
  // email
  createdBy: text("created_by").notNull().unique(),
  externalId: text("external_id").unique().notNull(),
  photoLink: text("photoLink"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
})

export const userRoleEnum = pgEnum(
  "role",
  Object.values(UserRole) as [string, ...string[]],
)

// Users Table
export const users = pgTable(
  "users",
  {
    id: serial("id").notNull().primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    email: text("email").notNull(),
    name: text("name").notNull(),
    photoLink: text("photoLink"),
    externalId: text("external_id").unique().notNull(),
    // this will come handy for jwt token
    workspaceExternalId: text("workspace_external_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
      .notNull()
      .default(sql`'1970-01-01T00:00:00Z'`),
    lastLogin: timestamp("last_login", { withTimezone: true }),
    role: userRoleEnum("role").notNull().default(UserRole.User),
  },
  (table) => ({
    emailUniqueIndex: uniqueIndex("email_unique_index").on(
      sql`LOWER(${table.email})`,
    ),
  }),
)

// User Personalization Table
export const userPersonalization = pgTable(
  "user_personalization",
  {
    id: serial("id").notNull().primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id)
      .unique(), // Each user has only one personalization setting
    email: text("email").notNull(),
    // Store parameters as a JSON object keyed by rank profile name
    parameters: jsonb("parameters").notNull().default(sql`'{}'::jsonb`), // Default to empty JSON object
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => ({
    userIdx: index("user_personalization_user_idx").on(t.userId),
    emailIdx: index("user_personalization_email_idx").on(t.email),
    workspaceIdx: index("user_personalization_workspace_idx").on(t.workspaceId),
  }),
)

const AppEnumField = "app_type"

export const connectorTypeEnum = pgEnum(
  "connector_type",
  Object.values(ConnectorType) as [string, ...string[]],
)
export const authTypeEnum = pgEnum(
  "auth_type",
  Object.values(AuthType) as [string, ...string[]],
)
// used by connectors, oauth_providers and sync_jobs
export const appTypeEnum = pgEnum(
  AppEnumField,
  Object.values(Apps) as [string, ...string[]],
)
export const statusEnum = pgEnum(
  "status",
  Object.values(ConnectorStatus) as [string, ...string[]],
)

// Connectors Table
// data source + credentails(if needed) + status of ingestion job
// for OAuth the setup data is in the OAuth Provider
// table and Connectors contains the credentails as well
// as the data fetching status.
export const connectors = pgTable(
  "connectors",
  {
    id: serial("id").notNull().primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    externalId: text("external_id").unique().notNull(),
    workspaceExternalId: text("workspace_external_id").notNull(),
    name: text("name").notNull(),
    type: connectorTypeEnum("type").notNull(),
    authType: authTypeEnum("auth_type").notNull(),
    app: appTypeEnum(AppEnumField).notNull(),
    config: jsonb("config").notNull(),
    credentials: encryptedText(serviceAccountEncryption)("credentials"),
    // for oauth this can be used as created by
    subject: encryptedText(accesskeyEncryption)("subject"),
    oauthCredentials: encryptedText(accesskeyEncryption)("oauth_credentials"),
    apiKey: encryptedText(apiKeyEncryption)("api_key"),
    // by default when created will be in the connecting status
    // for oauth we must send not connected when first created
    status: statusEnum("status").notNull().default(ConnectorStatus.Connecting),
    // TODO: add these fields
    // accessTokenExpiresAt:
    // refreshTokenExpiresAt:

    // connector now contains the state needed to resume / restart from a crash
    // it will contain different state for different app and auth types
    // Ingestion state, default to empty object
    state: jsonb("state").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => ({
    uniqueConnector: unique().on(t.workspaceId, t.userId, t.app, t.authType, t.name),
  }),
)

// anytime we make a oauth provider we make a corresponding
// connector with not connected status.
export const oauthProviders = pgTable("oauth_providers", {
  id: serial("id").notNull().primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  externalId: text("external_id").unique().notNull(),
  workspaceExternalId: text("workspace_external_id").notNull(),
  connectorId: integer("connector_id")
    .notNull()
    .references(() => connectors.id),
  clientId: text("client_id"),
  clientSecret: encryptedText(accesskeyEncryption)("client_secret"),
  oauthScopes: text("oauth_scopes")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  app: appTypeEnum("app_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
})

export const syncJobEnum = pgEnum(
  "type",
  Object.values(SyncCron) as [string, ...string[]],
)
export const syncJobStatusEnum = pgEnum(
  "sync_status",
  Object.values(SyncJobStatus) as [string, ...string[]],
)

export const syncJobs = pgTable("sync_jobs", {
  id: serial("id").notNull().primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  externalId: text("external_id").unique().notNull(),
  workspaceExternalId: text("workspace_external_id").notNull(),

  // this is the user for whom this sync job will run
  // It's very helpful for service account where we
  // create a sync job per user
  email: text("email").notNull(),
  connectorId: integer("connector_id")
    .notNull()
    .references(() => connectors.id),
  type: syncJobEnum("type").notNull(),
  status: syncJobStatusEnum("status")
    .notNull()
    .default(SyncJobStatus.NotStarted),
  app: appTypeEnum(AppEnumField).notNull(),
  authType: authTypeEnum("auth_type").notNull(),
  config: jsonb("config").notNull(),
  lastRanOn: timestamp("last_ran_on", { withTimezone: true }).default(
    sql`NOW()`,
  ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
})

// can be helpful as an audit log
// snapshot of sync jobs
// or to know how much got synced when
export const syncHistory = pgTable("sync_history", {
  id: serial("id").notNull().primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  externalId: text("external_id").unique().notNull(),
  workspaceExternalId: text("workspace_external_id").notNull(),
  // providerId: integer("provider_id")
  //     .notNull()
  //     .references(() => oauthProviders.id),
  dataAdded: integer("data_added").notNull().default(0),
  dataUpdated: integer("data_updated").notNull().default(0),
  dataDeleted: integer("data_deleted").notNull().default(0),
  summary: jsonb("summary").notNull(), // JSON summary of the sync (could store metadata like sync duration, etc.)
  errorMessage: text("error_message").default(""), // Error message in case the sync fails
  type: syncJobEnum("type").notNull(),
  status: syncJobStatusEnum("status").notNull(),
  authType: authTypeEnum("auth_type").notNull(),
  app: appTypeEnum(AppEnumField).notNull(),
  config: jsonb("config").notNull(),
  lastRanOn: timestamp("last_ran_on", { withTimezone: true }).default(
    sql`NOW()`,
  ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
})

export const chats = pgTable(
  "chats",
  {
    id: serial("id").notNull().primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    externalId: text("external_id").unique().notNull(),
    workspaceExternalId: text("workspace_external_id").notNull(),
    isBookmarked: boolean("is_bookmarked").notNull().default(false),
    email: text("email").notNull(),
    title: text("title").notNull(),
    // metadata for any file that is uploaded as
    // attachment for that chat
    attachments: jsonb("attachments").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    isBookmarkedIndex: index("is_bookmarked_index").on(table.isBookmarked),
  }),
)

const messageRoleField = "message_role"
export const messageRoleEnum = pgEnum(
  messageRoleField,
  Object.values(MessageRole) as [string, ...string[]],
)

export const messages = pgTable(
  "messages",
  {
    id: serial("id").notNull().primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    externalId: text("external_id").unique().notNull(),
    workspaceExternalId: text("workspace_external_id").notNull(),
    chatExternalId: text("chat_external_id").notNull(),
    message: text("message").notNull(),
    messageRole: messageRoleEnum(messageRoleField).notNull(),
    thinking: text("thinking").notNull().default(""),
    // model id is present in the app itself
    // <provider><modelId>
    modelId: text("modelId").notNull(),
    email: text("email").notNull(),
    sources: jsonb("sources").notNull().default(sql`'[]'::jsonb`),
    fileIds: jsonb("fileIds").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    errorMessage: text("error_message").default(""),
  },
  (table) => ({
    chatIdIndex: index("chat_id_index").on(table.chatId),
  }),
)

export const chatTrace = pgTable(
  "chat_trace",
  {
    id: serial("id").notNull().primaryKey(),
    workspaceId: integer("workspace_id") // Add workspaceId
      .notNull()
      .references(() => workspaces.id),
    userId: integer("user_id") // Add userId
      .notNull()
      .references(() => users.id),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id),
    chatExternalId: text("chat_external_id").notNull(),
    messageExternalId: text("message_external_id").notNull(),
    email: text("email").notNull(),
    traceJson: jsonb("trace_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (table) => ({
    workspaceIdIndex: index("chat_trace_workspace_id_index").on(
      table.workspaceId,
    ), // Add index
    userIdIndex: index("chat_trace_user_id_index").on(table.userId), // Add index
    chatExternalIdIndex: index("chat_trace_chat_external_id_index").on(
      table.chatExternalId,
    ),
    messageExternalIdIndex: index("chat_trace_message_external_id_index").on(
      table.messageExternalId,
    ),
  }),
)

export const insertProviderSchema = createInsertSchema(oauthProviders, {
  // added to prevent type error
  oauthScopes: z.array(z.string()),
}).omit({
  createdAt: true,
  updatedAt: true,
  id: true,
})
export type InsertOAuthProvider = z.infer<typeof insertProviderSchema>

export const selectProviderSchema = createSelectSchema(oauthProviders, {
  // added to prevent type error
  oauthScopes: z.array(z.string()),
})

export type SelectOAuthProvider = z.infer<typeof selectProviderSchema>

export const slackOAuthIngestionStateSchema = z.object({
  app: z.literal(Apps.Slack),
  authType: z.literal(AuthType.OAuth),
  currentChannelId: z.string().optional(),
  lastMessageTs: z.string().optional(),
  lastUpdated: z.string(),
})

export const googleDriveOAuthIngestionStateSchema = z.object({
  app: z.literal(Apps.GoogleDrive),
  authType: z.literal(AuthType.OAuth),
  // currentFolderId: z.string().optional(),
  // lastFileId: z.string().optional(),
  // lastChangeId: z.string().optional(),
  // completedFolders: z.array(z.string()),
  lastUpdated: z.string(),
})

export const ingestionStateSchema = z.discriminatedUnion("app", [
  slackOAuthIngestionStateSchema,
  googleDriveOAuthIngestionStateSchema,
  // googleDriveServiceAccountIngestionStateSchema,
])

export const selectConnectorSchema = createSelectSchema(connectors, {
  app: z.nativeEnum(Apps),
  config: z.any(),
  state: ingestionStateSchema.or(z.object({}).optional()),
})

export type IngestionStateUnion = z.infer<typeof ingestionStateSchema>
export type SlackOAuthIngestionState = z.infer<
  typeof slackOAuthIngestionStateSchema
>

export type SelectConnector = z.infer<typeof selectConnectorSchema>

export const insertSyncJob = createInsertSchema(syncJobs).omit({
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  id: true,
  lastRanOn: true,
})
export type InsertSyncJob = z.infer<typeof insertSyncJob>

export const selectSyncJobSchema = createSelectSchema(syncJobs, {
  config: SyncConfigSchema,
})
export type SelectSyncJob = z.infer<typeof selectSyncJobSchema>

export const insertSyncHistorySchema = createInsertSchema(syncHistory).omit({
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  id: true,
})
export type InsertSyncHistory = z.infer<typeof insertSyncHistorySchema>

export const selectSyncHistorySchema = createSelectSchema(syncHistory, {
  config: SyncConfigSchema,
})
export type SelectSyncHistory = z.infer<typeof selectSyncHistorySchema>

export const selectUserSchema = createSelectSchema(users)
export type SelectUser = z.infer<typeof selectUserSchema>

export const selectWorkspaceSchema = createSelectSchema(workspaces)
export type SelectWorkspace = z.infer<typeof selectWorkspaceSchema>

export const userPublicSchema = selectUserSchema.omit({
  lastLogin: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  id: true,
  workspaceId: true,
})
export const workspacePublicSchema = selectWorkspaceSchema.omit({
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  id: true,
})

export type PublicUser = z.infer<typeof userPublicSchema>
export type PublicWorkspace = z.infer<typeof workspacePublicSchema>
export type PublicUserWorkspace = {
  user: PublicUser
  workspace: PublicWorkspace
}

// if data is not sent out, we can keep all fields
export type InternalUserWorkspace = {
  user: SelectUser
  workspace: SelectWorkspace
}

export const insertChatSchema = createInsertSchema(chats).omit({
  id: true,
})
export type InsertChat = z.infer<typeof insertChatSchema>

export const selectChatSchema = createSelectSchema(chats)
export type SelectChat = z.infer<typeof selectChatSchema>

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
})
export type InsertMessage = z.infer<typeof insertMessageSchema>

// Select schema for messages
export const selectMessageSchema = createSelectSchema(messages)
export type SelectMessage = z.infer<typeof selectMessageSchema>

export const selectPublicMessageSchema = selectMessageSchema.omit({
  id: true,
  chatId: true,
  userId: true,
})

export const selectPublicMessagesSchema = z.array(selectPublicMessageSchema)
export type SelectPublicMessage = z.infer<typeof selectPublicMessageSchema>

export const selectPublicChatSchema = selectChatSchema.omit({
  id: true,
  userId: true,
})
export type SelectPublicChat = z.infer<typeof selectPublicChatSchema>

// Schemas for User Personalization
// Define the structure for a single rank profile's parameters
const rankProfileParamsSchema = z.object({
  alpha: z.number().min(0).max(1).optional(), // Alpha range 0.0-1.0
  // Add other potential parameters here, e.g.:
  // beta: z.number().optional(),
})

// Define the main parameters schema as a record (dictionary)
const parametersSchema = z.record(
  z.nativeEnum(SearchModes),
  rankProfileParamsSchema,
) // Keys are SearchModes enum

export const selectPersonalizationSchema = createSelectSchema(
  userPersonalization,
  {
    parameters: parametersSchema, // Validate the JSON structure on select
  },
)
export const insertPersonalizationSchema = createInsertSchema(
  userPersonalization,
  {
    parameters: parametersSchema, // Validate the JSON structure on insert
    email: z.string().email(),
    workspaceId: z.number().int(), // Add workspaceId validation
  },
)

export type SelectPersonalization = z.infer<typeof selectPersonalizationSchema>
export type InsertPersonalization = z.infer<typeof insertPersonalizationSchema>

// Tools Table
export const tools = pgTable(
  "tools",
  {
    id: serial("id").notNull().primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    connectorId: integer("connector_id")
      .notNull()
      .references(() => connectors.id),
    toolName: text("tool_name").notNull(),
    toolSchema: text("tool_schema").notNull(), // Store the entire schema as a string
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (table) => ({
    // Create a unique index on the combination of workspaceId, connectorId, and toolName
    uniqueTool: unique().on(
      table.workspaceId,
      table.connectorId,
      table.toolName,
    ),
    // Add indexes for common query patterns
    connectorIdIdx: index("tools_connector_id_idx").on(table.connectorId),
    toolNameIdx: index("tools_tool_name_idx").on(table.toolName),
  }),
)

// Create Zod schemas for the tools table
export const insertToolSchema = createInsertSchema(tools).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
})
export type InsertTool = z.infer<typeof insertToolSchema>

export const selectToolSchema = createSelectSchema(tools)
export type SelectTool = z.infer<typeof selectToolSchema>

// Schema for tool schema validation (optional but recommended)
export const toolSchemaStructure = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.object({
    type: z.literal("object"),
    properties: z.record(z.any()),
  }),
  annotations: z
    .object({
      title: z.string().optional(),
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
})
export type ToolSchemaStructure = z.infer<typeof toolSchemaStructure>
