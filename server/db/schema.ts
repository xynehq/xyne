import { sql, type InferModelFromColumns } from "drizzle-orm";
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
} from "drizzle-orm/pg-core";
import { encryptedText } from "./customType";
import { Encryption } from "@/utils/encryption";
import { ConnectorType, SyncConfigSchema, SyncCron, UserRole } from "@/types";
import { Apps, AuthType, ConnectorStatus, SyncJobStatus } from "@/shared/types";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

const encryptionKey = process.env.ENCRYPTION_KEY!;
if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY environment variable is not set.');
}
const serviceAccountEncryptionKey = process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY;
if (!serviceAccountEncryptionKey) {
    throw new Error('SERVICE_ACCOUNT_ENCRYPTION_KEY environment variable is not set.');
}

const accesskeyEncryption = new Encryption(encryptionKey);

const serviceAccountEncryption = new Encryption(serviceAccountEncryptionKey)

// Workspaces Table
export const workspaces = pgTable("workspaces", {
    id: serial("id").notNull().primaryKey(),
    name: text("name").notNull(),
    domain: text("domain").notNull().unique(),
    // email
    createdBy: text('created_by').notNull().unique(),
    externalId: text("external_id")
        .unique()
        .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .default(sql`NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
        .notNull()
        .default(sql`'1970-01-01T00:00:00Z'`),
});

export const userRoleEnum = pgEnum('role', Object.values(UserRole) as [string, ...string[]]);

// Users Table
export const users = pgTable(
    "users",
    {
        id: serial("id").notNull().primaryKey(),
        workspaceId: integer("workspace_id")
            .notNull()
            .references(() => workspaces.id),
        email: text("email").notNull(),
        name: text('name').notNull(),
        photoLink: text('photoLink'),
        externalId: text("external_id")
            .unique()
            .notNull(),
        // this will come handy for jwt token
        workspaceExternalId: text("workspace_external_id")
            .notNull(),
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
        role: userRoleEnum('role').notNull().default(UserRole.User),
    },
    (table) => ({
        emailUniqueIndex: uniqueIndex("email_unique_index").on(sql`LOWER(${table.email})`),
    })
);

const AppEnumField = 'app_type'

export const connectorTypeEnum = pgEnum('connector_type', Object.values(ConnectorType) as [string, ...string[]]);
export const authTypeEnum = pgEnum('auth_type', Object.values(AuthType) as [string, ...string[]]);
// used by connectors, oauth_providers and sync_jobs
export const appTypeEnum = pgEnum(AppEnumField, Object.values(Apps) as [string, ...string[]]);
export const statusEnum = pgEnum('status', Object.values(ConnectorStatus) as [string, ...string[]]);

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
    externalId: text("external_id")
        .unique()
        .notNull(),
    workspaceExternalId: text("workspace_external_id")
        .notNull(),
    name: text("name").notNull(),
    type: connectorTypeEnum('type').notNull(),
    authType: authTypeEnum('auth_type').notNull(),
    app: appTypeEnum(AppEnumField).notNull(),
    config: jsonb("config").notNull(),
    credentials: encryptedText(serviceAccountEncryption)("credentials"),
    // for oauth this can be used as created by
    subject: encryptedText(accesskeyEncryption)("subject"),
    oauthCredentials: encryptedText(accesskeyEncryption)("oauth_credentials"),
    // by default when created will be in the connecting status
    // for oauth we must send not connected when first created
    status: statusEnum('status').notNull().default(ConnectorStatus.Connecting),
    // TODO: add these fields
    // accessTokenExpiresAt: 
    // refreshTokenExpiresAt:
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .default(sql`NOW()`),
}, (t) => ({
    uniqueConnector: unique().on(t.workspaceId, t.userId, t.app, t.authType)
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
    externalId: text("external_id")
        .unique()
        .notNull(),
    workspaceExternalId: text("workspace_external_id")
        .notNull(),
    connectorId: integer("container_id")
        .notNull()
        .references(() => connectors.id),
    clientId: text('client_id'),
    clientSecret: encryptedText(accesskeyEncryption)('client_secret'),
    oauthScopes: text('oauth_scopes').array().notNull().default(sql`ARRAY[]::text[]`),
    app: appTypeEnum('app_type').notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .default(sql`NOW()`),
})

export const syncJobEnum = pgEnum('type', Object.values(SyncCron) as [string, ...string[]]);
export const syncJobStatusEnum = pgEnum('sync_status', Object.values(SyncJobStatus) as [string, ...string[]]);

export const syncJobs = pgTable("sync_jobs", {
    id: serial("id").notNull().primaryKey(),
    workspaceId: integer("workspace_id")
        .notNull()
        .references(() => workspaces.id),
    externalId: text("external_id")
        .unique()
        .notNull(),
    workspaceExternalId: text("workspace_external_id")
        .notNull(),
    // providerId: integer("provider_id")
    //     .notNull()
    //     .references(() => oauthProviders.id),
    connectorId: integer("connector_id")
        .notNull()
        .references(() => connectors.id),
    type: syncJobEnum('type').notNull(),
    status: syncJobStatusEnum('status'),
    app: appTypeEnum(AppEnumField).notNull(),
    config: jsonb("config").notNull(),
    lastRanOn: timestamp("last_ran_on", { withTimezone: true })
        .default(sql`NOW()`),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .default(sql`NOW()`),
    deletedAt: timestamp('deleted_at', { withTimezone: true })
})

// can be helpful as an audit log
// snapshot of sync jobs
// or to know how much got synced when
export const syncHistory = pgTable("sync_history", {
    id: serial("id").notNull().primaryKey(),
    workspaceId: integer("workspace_id")
        .notNull()
        .references(() => workspaces.id),
    externalId: text("external_id")
        .unique()
        .notNull(),
    workspaceExternalId: text("workspace_external_id")
        .notNull(),
    // providerId: integer("provider_id")
    //     .notNull()
    //     .references(() => oauthProviders.id),
    dataAdded: integer("data_added").notNull().default(0),
    dataUpdated: integer("data_updated").notNull().default(0),
    dataDeleted: integer("data_deleted").notNull().default(0),
    summary: jsonb("summary")
        .notNull(),  // JSON summary of the sync (could store metadata like sync duration, etc.)
    errorMessage: text("error_message")
        .default(""),  // Error message in case the sync fails
    type: syncJobEnum('type').notNull(),
    status: syncJobStatusEnum('status'),
    app: appTypeEnum(AppEnumField).notNull(),
    config: jsonb("config").notNull(),
    lastRanOn: timestamp("last_ran_on", { withTimezone: true })
        .default(sql`NOW()`),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .default(sql`NOW()`),
    deletedAt: timestamp('deleted_at', { withTimezone: true })
})

export const insertProviderSchema = createInsertSchema(oauthProviders, {
    // added to prevent type error
    oauthScopes: z.array(z.string())
}).omit({
    createdAt: true,
    updatedAt: true,
    id: true
})
export type InsertOAuthProvider = z.infer<typeof insertProviderSchema>

export const selectProviderSchema = createSelectSchema(oauthProviders, {
    // added to prevent type error
    oauthScopes: z.array(z.string())
})

export type SelectOAuthProvider = z.infer<typeof selectProviderSchema>

export const selectConnectorSchema = createSelectSchema(connectors, {
    app: z.nativeEnum(Apps),
    config: z.any()
})

export type SelectConnector = z.infer<typeof selectConnectorSchema>

export const insertSyncJob = createInsertSchema(syncJobs).omit({
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
    id: true,
    lastRanOn: true
})
export type InsertSyncJob = z.infer<typeof insertSyncJob>

export const selectSyncJob = createSelectSchema(syncJobs, {
    config: SyncConfigSchema
})
export type SelectSyncJob = z.infer<typeof selectSyncJob>

export const selectUserSchema = createSelectSchema(users)
export type SelectUser = z.infer<typeof selectUserSchema>