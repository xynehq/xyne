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
import { createId } from "@paralleldrive/cuid2";
import { encryptedText } from "./customType";
import { Encryption } from "@/utils/encryption";
import { Apps, AuthType, ConnectorType } from "@/types";

// Workspaces Table
export const workspaces = pgTable("workspaces", {
    id: serial("id").notNull().primaryKey(),
    name: text("name").notNull(),
    domain: text("domain").notNull().unique(),
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
const encryptionKey = process.env.ENCRYPTION_KEY;
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


// Connectors Table
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
    name: text("name").notNull(),
    type: connectorTypeEnum('type').notNull(),
    authType: authTypeEnum('auth_type').notNull(),
    app: appTypeEnum('app_type').notNull(),
    config: jsonb("config").notNull(),
    credentials: encryptedText(serviceAccountEncryption)("credentials"),
    subject: encryptedText(accesskeyEncryption)("subject"),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .default(sql`NOW()`),
}, (t) => ({
    uniqueConnector: unique().on(t.workspaceId, t.userId, t.app, t.authType)
}));