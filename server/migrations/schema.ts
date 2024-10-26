import {
  pgTable,
  uniqueIndex,
  foreignKey,
  unique,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const appType = pgEnum("app_type", [
  "google-workspace",
  "google-drive",
  "notion",
  "gmail",
])
export const authType = pgEnum("auth_type", [
  "oauth",
  "service_account",
  "custom",
  "api_key",
])
export const connectorType = pgEnum("connector_type", [
  "SaaS",
  "Database",
  "Api",
  "File",
  "Website",
])
export const role = pgEnum("role", [
  "User",
  "TeamLeader",
  "Admin",
  "SuperAdmin",
])
export const status = pgEnum("status", [
  "connected",
  "connecting",
  "failed",
  "not-connected",
])
export const syncStatus = pgEnum("sync_status", [
  "NotStarted",
  "Started",
  "Failed",
  "Successful",
])
export const type = pgEnum("type", ["ChangeToken", "Partial", "FullSync"])

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey().notNull(),
    workspaceId: integer("workspace_id").notNull(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    photoLink: text("photoLink"),
    externalId: text("external_id").notNull(),
    workspaceExternalId: text("workspace_external_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" })
      .default("1970-01-01 00:00:00+00")
      .notNull(),
    lastLogin: timestamp("last_login", { withTimezone: true, mode: "string" }),
    role: role("role").default("User").notNull(),
  },
  (table) => {
    return {
      emailUniqueIdx: uniqueIndex("email_unique_index").using(
        "btree",
        sql`lower(email)`,
      ),
      usersWorkspaceIdWorkspacesIdFk: foreignKey({
        columns: [table.workspaceId],
        foreignColumns: [workspaces.id],
        name: "users_workspace_id_workspaces_id_fk",
      }),
      usersExternalIdUnique: unique("users_external_id_unique").on(
        table.externalId,
      ),
    }
  },
)

export const oauthProviders = pgTable(
  "oauth_providers",
  {
    id: serial("id").primaryKey().notNull(),
    workspaceId: integer("workspace_id").notNull(),
    userId: integer("user_id").notNull(),
    externalId: text("external_id").notNull(),
    workspaceExternalId: text("workspace_external_id").notNull(),
    containerId: integer("container_id").notNull(),
    clientId: text("client_id"),
    clientSecret: text("client_secret"),
    oauthScopes: text("oauth_scopes").array().default(["RAY"]).notNull(),
    appType: appType("app_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return {
      oauthProvidersWorkspaceIdWorkspacesIdFk: foreignKey({
        columns: [table.workspaceId],
        foreignColumns: [workspaces.id],
        name: "oauth_providers_workspace_id_workspaces_id_fk",
      }),
      oauthProvidersUserIdUsersIdFk: foreignKey({
        columns: [table.userId],
        foreignColumns: [users.id],
        name: "oauth_providers_user_id_users_id_fk",
      }),
      oauthProvidersContainerIdConnectorsIdFk: foreignKey({
        columns: [table.containerId],
        foreignColumns: [connectors.id],
        name: "oauth_providers_container_id_connectors_id_fk",
      }),
      oauthProvidersExternalIdUnique: unique(
        "oauth_providers_external_id_unique",
      ).on(table.externalId),
    }
  },
)

export const syncJobs = pgTable(
  "sync_jobs",
  {
    id: serial("id").primaryKey().notNull(),
    workspaceId: integer("workspace_id").notNull(),
    externalId: text("external_id").notNull(),
    workspaceExternalId: text("workspace_external_id").notNull(),
    connectorId: integer("connector_id").notNull(),
    type: type("type").notNull(),
    status: syncStatus("status").default("NotStarted").notNull(),
    appType: appType("app_type").notNull(),
    config: jsonb("config").notNull(),
    lastRanOn: timestamp("last_ran_on", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
    email: text("email").notNull(),
    authType: authType("auth_type").notNull(),
  },
  (table) => {
    return {
      syncJobsWorkspaceIdWorkspacesIdFk: foreignKey({
        columns: [table.workspaceId],
        foreignColumns: [workspaces.id],
        name: "sync_jobs_workspace_id_workspaces_id_fk",
      }),
      syncJobsConnectorIdConnectorsIdFk: foreignKey({
        columns: [table.connectorId],
        foreignColumns: [connectors.id],
        name: "sync_jobs_connector_id_connectors_id_fk",
      }),
      syncJobsExternalIdUnique: unique("sync_jobs_external_id_unique").on(
        table.externalId,
      ),
    }
  },
)

export const workspaces = pgTable(
  "workspaces",
  {
    id: serial("id").primaryKey().notNull(),
    name: text("name").notNull(),
    domain: text("domain").notNull(),
    createdBy: text("created_by").notNull(),
    externalId: text("external_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" })
      .default("1970-01-01 00:00:00+00")
      .notNull(),
    photoLink: text("photoLink"),
  },
  (table) => {
    return {
      workspacesDomainUnique: unique("workspaces_domain_unique").on(
        table.domain,
      ),
      workspacesCreatedByUnique: unique("workspaces_created_by_unique").on(
        table.createdBy,
      ),
      workspacesExternalIdUnique: unique("workspaces_external_id_unique").on(
        table.externalId,
      ),
    }
  },
)

export const connectors = pgTable(
  "connectors",
  {
    id: serial("id").primaryKey().notNull(),
    workspaceId: integer("workspace_id").notNull(),
    userId: integer("user_id").notNull(),
    externalId: text("external_id").notNull(),
    workspaceExternalId: text("workspace_external_id").notNull(),
    name: text("name").notNull(),
    type: connectorType("type").notNull(),
    authType: authType("auth_type").notNull(),
    appType: appType("app_type").notNull(),
    config: jsonb("config").notNull(),
    credentials: text("credentials"),
    subject: text("subject"),
    oauthCredentials: text("oauth_credentials"),
    status: status("status").default("connecting").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return {
      connectorsWorkspaceIdWorkspacesIdFk: foreignKey({
        columns: [table.workspaceId],
        foreignColumns: [workspaces.id],
        name: "connectors_workspace_id_workspaces_id_fk",
      }),
      connectorsUserIdUsersIdFk: foreignKey({
        columns: [table.userId],
        foreignColumns: [users.id],
        name: "connectors_user_id_users_id_fk",
      }),
      connectorsWorkspaceIdUserIdAppTypeAuthTypeUnique: unique(
        "connectors_workspace_id_user_id_app_type_auth_type_unique",
      ).on(table.workspaceId, table.userId, table.authType, table.appType),
      connectorsExternalIdUnique: unique("connectors_external_id_unique").on(
        table.externalId,
      ),
    }
  },
)
