import { sql } from "drizzle-orm";
import { serial, pgTable, text, integer, timestamp, uniqueIndex, jsonb, boolean, pgEnum, unique, index, } from "drizzle-orm/pg-core";
import { encryptedText } from "./customType.js"
import { Encryption } from "../utils/encryption.js"
import {
  ConnectorType,
  MessageRole,
  SyncConfigSchema,
  SyncCron,
} from "../types.js"
import {
  Apps,
  AuthType,
  ConnectorStatus,
  SyncJobStatus,
  UserRole,
} from "../shared/types.js"
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import dotenv from "dotenv"
dotenv.config()
const encryptionKey = process.env.ENCRYPTION_KEY;
if (!encryptionKey) {
    throw new Error("ENCRYPTION_KEY environment variable is not set.");
}
const serviceAccountEncryptionKey = process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY;
if (!serviceAccountEncryptionKey) {
    throw new Error("SERVICE_ACCOUNT_ENCRYPTION_KEY environment variable is not set.");
}
const accesskeyEncryption = new Encryption(encryptionKey);
const serviceAccountEncryption = new Encryption(serviceAccountEncryptionKey);
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
        .default(sql `NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .default(sql `NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
export const userRoleEnum = pgEnum("role", Object.values(UserRole));
// Users Table
export const users = pgTable("users", {
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
        .default(sql `NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .default(sql `NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
        .notNull()
        .default(sql `'1970-01-01T00:00:00Z'`),
    lastLogin: timestamp("last_login", { withTimezone: true }),
    role: userRoleEnum("role").notNull().default(UserRole.User),
}, (table) => ({
    emailUniqueIndex: uniqueIndex("email_unique_index").on(sql `LOWER(${table.email})`),
}));
const AppEnumField = "app_type";
export const connectorTypeEnum = pgEnum("connector_type", Object.values(ConnectorType));
export const authTypeEnum = pgEnum("auth_type", Object.values(AuthType));
// used by connectors, oauth_providers and sync_jobs
export const appTypeEnum = pgEnum(AppEnumField, Object.values(Apps));
export const statusEnum = pgEnum("status", Object.values(ConnectorStatus));
// Connectors Table
// data source + credentails(if needed) + status of ingestion job
// for OAuth the setup data is in the OAuth Provider
// table and Connectors contains the credentails as well
// as the data fetching status.
export const connectors = pgTable("connectors", {
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
    // by default when created will be in the connecting status
    // for oauth we must send not connected when first created
    status: statusEnum("status").notNull().default(ConnectorStatus.Connecting),
    // TODO: add these fields
    // accessTokenExpiresAt:
    // refreshTokenExpiresAt:
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .default(sql `NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .default(sql `NOW()`),
}, (t) => ({
    uniqueConnector: unique().on(t.workspaceId, t.userId, t.app, t.authType),
}));
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
    connectorId: integer("container_id")
        .notNull()
        .references(() => connectors.id),
    clientId: text("client_id"),
    clientSecret: encryptedText(accesskeyEncryption)("client_secret"),
    oauthScopes: text("oauth_scopes")
        .array()
        .notNull()
        .default(sql `ARRAY[]::text[]`),
    app: appTypeEnum("app_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .default(sql `NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .default(sql `NOW()`),
});
export const syncJobEnum = pgEnum("type", Object.values(SyncCron));
export const syncJobStatusEnum = pgEnum("sync_status", Object.values(SyncJobStatus));
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
    lastRanOn: timestamp("last_ran_on", { withTimezone: true }).default(sql `NOW()`),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .default(sql `NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .default(sql `NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
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
    lastRanOn: timestamp("last_ran_on", { withTimezone: true }).default(sql `NOW()`),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .default(sql `NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .default(sql `NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
export const chats = pgTable("chats", {
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
        .default(sql `NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .default(sql `NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => ({
    isBookmarkedIndex: index("is_bookmarked_index").on(table.isBookmarked),
}));
const messageRoleField = "message_role";
export const messageRoleEnum = pgEnum(messageRoleField, Object.values(MessageRole));
export const messages = pgTable("messages", {
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
    sources: jsonb("sources").notNull().default(sql `'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .default(sql `NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .default(sql `NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    errorMessage: text("error_message").default(""),
}, (table) => ({
    chatIdIndex: index("chat_id_index").on(table.chatId),
}));
export const insertProviderSchema = createInsertSchema(oauthProviders, {
    // added to prevent type error
    oauthScopes: z.array(z.string()),
}).omit({
    createdAt: true,
    updatedAt: true,
    id: true,
});
export const selectProviderSchema = createSelectSchema(oauthProviders, {
    // added to prevent type error
    oauthScopes: z.array(z.string()),
});
export const selectConnectorSchema = createSelectSchema(connectors, {
    app: z.nativeEnum(Apps),
    config: z.any(),
});
export const insertSyncJob = createInsertSchema(syncJobs).omit({
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
    id: true,
    lastRanOn: true,
});
export const selectSyncJobSchema = createSelectSchema(syncJobs, {
    config: SyncConfigSchema,
});
export const insertSyncHistorySchema = createInsertSchema(syncHistory).omit({
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
    id: true,
});
export const selectSyncHistorySchema = createSelectSchema(syncHistory, {
    config: SyncConfigSchema,
});
export const selectUserSchema = createSelectSchema(users);
export const selectWorkspaceSchema = createSelectSchema(workspaces);
export const userPublicSchema = selectUserSchema.omit({
    lastLogin: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
    id: true,
    workspaceId: true,
});
export const workspacePublicSchema = selectWorkspaceSchema.omit({
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
    id: true,
});
export const insertChatSchema = createInsertSchema(chats).omit({
    id: true,
});
export const selectChatSchema = createSelectSchema(chats);
export const insertMessageSchema = createInsertSchema(messages).omit({
    id: true,
});
// Select schema for messages
export const selectMessageSchema = createSelectSchema(messages);
export const selectPublicMessageSchema = selectMessageSchema.omit({
    id: true,
    chatId: true,
    userId: true,
});
export const selectPublicMessagesSchema = z.array(selectPublicMessageSchema);
export const selectPublicChatSchema = selectChatSchema.omit({
    id: true,
    userId: true,
});
