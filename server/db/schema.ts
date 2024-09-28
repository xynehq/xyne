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
import { ConnectorType } from "@/types";
import { Apps, AuthType, ConnectorStatus } from "@/shared/types";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

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
        googleAccessToken: encryptedText(accesskeyEncryption)("google_access_token"),
        googleRefreshToken: encryptedText(accesskeyEncryption)("google_refresh_token"),
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
        // TODO: turn user role to actual enum type
        role: text("role", { enum: ["user", "admin", "superadmin"] })
            .notNull()
            .default("user"),
    },
    (table) => ({
        emailUniqueIndex: uniqueIndex("email_unique_index").on(sql`LOWER(${table.email})`),
    })
);

// Define PostgreSQL enums based on your TypeScript enums
export const connectorTypeEnum = pgEnum('connector_type', Object.values(ConnectorType) as [string, ...string[]]);
export const authTypeEnum = pgEnum('auth_type', Object.values(AuthType) as [string, ...string[]]);
export const appTypeEnum = pgEnum('app_type', Object.values(Apps) as [string, ...string[]]);
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
    app: appTypeEnum('app_type').notNull(),
    config: jsonb("config").notNull(),
    credentials: encryptedText(serviceAccountEncryption)("credentials"),
    // for oauth this can be used as created by
    subject: encryptedText(accesskeyEncryption)("subject"),
    oauthCredentials: encryptedText(accesskeyEncryption)("oauth_credentials"),
    // by default when created will be in the connecting status
    // for oauth we must send not connected when first created
    status: statusEnum('status').notNull().default(ConnectorStatus.Connecting),
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
    clientId: text('client_id'),
    clientSecret: encryptedText(accesskeyEncryption)('client_secret'),
    oauthScopes: text('oauth_scopes').array().notNull().default(sql`ARRAY[]::text[]`),
    app: appTypeEnum('app_type').notNull(),
    connectorId: integer("container_id")
        .notNull()
        .references(() => connectors.id),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .default(sql`NOW()`),
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
    config: z.any()
})

export type SelectConnector = z.infer<typeof selectConnectorSchema>