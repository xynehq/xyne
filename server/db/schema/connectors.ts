import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { encryptedText } from "../customType"
import { Encryption } from "@/utils/encryption"
import { Apps, AuthType, ConnectorStatus, ConnectorType } from "@/shared/types"
import { workspaces } from "./workspaces"
import { users } from "./users"

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
    uniqueConnector: unique().on(
      t.workspaceId,
      t.userId,
      t.app,
      t.authType,
      t.name,
    ),
  }),
)

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
