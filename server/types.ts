import config from "@/config"
import { z } from "zod"
import { Apps, AuthType } from "@/shared/types"
import type { PgTransaction } from "drizzle-orm/pg-core"
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js"
import type { GoogleTokens } from "arctic"
import { JWT, type OAuth2Client } from "google-auth-library"

// type GoogleContacts = people_v1.Schema$Person
// type WorkspaceDirectoryUser = admin_directory_v1.Schema$User

// People graph of google workspace
// type GoogleWorkspacePeople = WorkspaceDirectoryUser | GoogleContacts

// type PeopleData = GoogleWorkspacePeople

export const searchSchema = z.object({
  query: z.string(),
  groupCount: z
    .union([z.string(), z.undefined(), z.null()])
    .transform((x) => (x ? x === "true" : false))
    .pipe(z.boolean())
    .optional(),
  offset: z
    .union([z.string(), z.undefined(), z.null()])
    .transform((x) => Number(x ?? 0))
    .pipe(z.number().min(0))
    .optional(),
  // removed min page size for filters
  page: z
    .union([z.string(), z.undefined(), z.null()])
    .transform((x) => Number(x ?? config.page))
    .pipe(z.number())
    .optional(),
  app: z.nativeEnum(Apps).optional(),
  entity: z.string().min(1).optional(),
})

export const answerSchema = z.object({
  query: z.string(),
  app: z.nativeEnum(Apps).optional(),
  entity: z.string().min(1).optional(),
})

export const searchQuerySchema = searchSchema.extend({
  permissions: z.array(z.string()),
})

export type SearchQuery = z.infer<typeof searchQuerySchema>

export const oauthStartQuerySchema = z.object({
  app: z.nativeEnum(Apps),
})

export type OAuthStartQuery = z.infer<typeof oauthStartQuerySchema>

export const addServiceConnectionSchema = z.object({
  "service-key": z.any(),
  app: z.nativeEnum(Apps),
  email: z.string(),
})

export type ServiceAccountConnection = z.infer<
  typeof addServiceConnectionSchema
>

export const createOAuthProvider = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  scopes: z.array(z.string()),
  app: z.nativeEnum(Apps),
})

export type OAuthProvider = z.infer<typeof createOAuthProvider>

// Define an enum for connection types
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
}

export type SaaSJob = {
  connectorId: number
  workspaceId: number
  userId: number
  app: Apps
  externalId: string
  authType: AuthType
  email: string
}

export type SaaSOAuthJob = Omit<SaaSJob, "userId" | "workspaceId">

// very rudimentary
export enum UserRole {
  User = "User", // can do oauth of their own data or api key based
  TeamLeader = "TeamLeader", // manage Users
  Admin = "Admin", // Service account related changes
  SuperAdmin = "SuperAdmin", // Admin level changes
}

export type TxnOrClient = PgTransaction<any> | PostgresJsDatabase

export type OAuthCredentials = GoogleTokens | any

export enum SyncCron {
  // Sync based on a token provided by the external API
  // Used to track changes since the last sync via change token.
  ChangeToken = "ChangeToken",
  // Sync based on querying the API with a last updated or modified timestamp.
  // Useful when the API allows fetching updated data since a specific time.
  Partial = "Partial",
  // Perform a full data sync by fetching everything and
  // applying filters like modifiedAt/updatedAt internally.
  FullSync = "FullSync",
}

// Define ChangeToken schema
const DefaultTokenSchema = z.object({
  token: z.string(),
  lastSyncedAt: z.coerce.date(),
})

// Google Drive and Contact change token
// clubbing drive, contact and other contact tokens
const GoogleDriveChangeTokenSchema = z.object({
  driveToken: z.string(),
  contactsToken: z.string(),
  otherContactsToken: z.string(),
  lastSyncedAt: z.coerce.date(),
})

const GmailChangeTokenSchema = z.object({
  historyId: z.string(),
  lastSyncedAt: z.coerce.date(),
})

const ChangeTokenSchema = z.union([
  DefaultTokenSchema,
  GoogleDriveChangeTokenSchema,
  GmailChangeTokenSchema,
])

// Define UpdatedAtVal schema
const UpdatedAtValSchema = z.object({
  updatedAt: z.coerce.date(),
})

// Define Config schema (either ChangeToken or UpdatedAtVal)
export const SyncConfigSchema = z.union([ChangeTokenSchema, UpdatedAtValSchema])

// TypeScript type for Config
export type SyncConfig = z.infer<typeof SyncConfigSchema>

export type ChangeToken = z.infer<typeof ChangeTokenSchema>
export type GoogleChangeToken = z.infer<typeof GoogleDriveChangeTokenSchema>
export type GmailChangeToken = z.infer<typeof GmailChangeTokenSchema>

namespace Google {
  export const DriveFileSchema = z.object({
    id: z.string().nullable(),
    webViewLink: z.string().nullable(),
    createdTime: z.string().nullable(),
    modifiedTime: z.string().nullable(),
    name: z.string().nullable(),
    owners: z
      .array(
        z.object({
          displayName: z.string().optional(),
          emailAddress: z.string().optional(),
          kind: z.string().optional(),
          me: z.boolean().optional(),
          permissionId: z.string().optional(),
          photoLink: z.string().optional(),
        }),
      )
      .optional(),
    fileExtension: z.string().nullable(),
    mimeType: z.string().nullable(),
    permissions: z
      .array(
        z.object({
          id: z.string(),
          type: z.string(),
          emailAddress: z.string().nullable(),
        }),
      )
      .nullable(),
  })
  export type DriveFile = z.infer<typeof DriveFileSchema>
}

export type GoogleClient = JWT | OAuth2Client

export type GoogleServiceAccount = {
  client_email: string
  private_key: string
}

export enum Subsystem {
  Server = "Server",
  Auth = "Auth",
  Cronjob = "Cronjob",
  Ingest = "Ingest",
  Integrations = "Integrations",
  Search = "Search",
  Vespa = "Vespa",
  Db = "Db",
  Api = "Api",
  Utils = "Utils",
  Queue = "Queue",
  Eval = "Eval"
}

export enum OperationStatus {
  Success = "Success",
  Failure = "Failure",
  Pendings = "Pending",
  Cancelled = "Cancelled",
}

export type additionalMessage = Partial<{
  Status: OperationStatus
  TimeTaken: number
}>
