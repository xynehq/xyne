import config from "@/config"
import { z } from "zod"
import { Apps, AuthType, ConnectorStatus } from "@/shared/types"
import type { PgTransaction } from "drizzle-orm/pg-core"
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js"
import { JWT, type OAuth2Client } from "google-auth-library"

// type GoogleContacts = people_v1.Schema$Person
// type WorkspaceDirectoryUser = admin_directory_v1.Schema$User

// People graph of google workspace
// type GoogleWorkspacePeople = WorkspaceDirectoryUser | GoogleContacts

// type PeopleData = GoogleWorkspacePeople

const baseSearchSchema = z.object({
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
  page: z
    .union([z.string(), z.undefined(), z.null()])
    .transform((x) => Number(x ?? config.page))
    .pipe(z.number())
    .optional(),
  app: z.nativeEnum(Apps).optional(),
  entity: z.string().min(1).optional(),
  lastUpdated: z.string().default("anytime"),
  isQueryTyped: z.preprocess((val) => val === "true", z.boolean()).optional(),
  debug: z
    .union([z.string(), z.undefined(), z.null()])
    .transform((x) => (x ? x === "true" : false))
    .pipe(z.boolean())
    .optional(),
})

export const searchSchema = baseSearchSchema.refine(
  (data) => (data.app && data.entity) || (!data.app && !data.entity),
  {
    message: "app and entity must be provided together",
    path: ["app", "entity"],
  },
)

export const answerSchema = z.object({
  query: z.string(),
  app: z.nativeEnum(Apps).optional(),
  entity: z.string().min(1).optional(),
})

export const searchQuerySchema = baseSearchSchema.extend({
  permissions: z.array(z.string()),
})

export type SearchQuery = z.infer<typeof searchQuerySchema>

export const oauthStartQuerySchema = z.object({
  app: z.nativeEnum(Apps),
})

export type SlackConfig = z.infer<typeof UpdatedAtValSchema>

export type OAuthStartQuery = z.infer<typeof oauthStartQuerySchema>

export const addServiceConnectionSchema = z.object({
  "service-key": z.any(),
  app: z.nativeEnum(Apps),
  email: z.string().email(),
  whitelistedEmails: z.string().optional(),
})

export type ServiceAccountConnection = z.infer<
  typeof addServiceConnectionSchema
>

export const addApiKeyConnectorSchema = z.object({
  app: z.nativeEnum(Apps),
  apiKey: z.string(),
})

export type ApiKeyConnector = z.infer<typeof addApiKeyConnectorSchema>

export const createOAuthProvider = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  scopes: z.array(z.string()),
  app: z.nativeEnum(Apps),
})

export const deleteConnectorSchema = z.object({
  connectorId: z.string(),
})

export const updateConnectorStatusSchema = z.object({
  connectorId: z.string(),
  status: z.nativeEnum(ConnectorStatus),
})

export const serviceAccountIngestMoreSchema = z.object({
  connectorId: z.string(),
  emailsToIngest: z.array(z.string().email()),
  startDate: z
    .string()
    .regex(/^$|^\d{4}-\d{2}-\d{2}$/, {
      message: "Start date must be in YYYY-MM-DD format or empty",
    }),
  endDate: z
    .string()
    .regex(/^$|^\d{4}-\d{2}-\d{2}$/, {
      message: "End date must be in YYYY-MM-DD format or empty",
    }),
  insertDriveAndContacts: z.boolean(),
  insertGmail: z.boolean(),
  insertCalendar: z.boolean(),
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
  whiteListedEmails?: string[]
}

export type SaaSOAuthJob = Omit<SaaSJob, "userId" | "workspaceId">

export type TxnOrClient = PgTransaction<any> | PostgresJsDatabase

export type OAuthCredentials = {
  data: {
    access_token: string
    refresh_token: string
    accessTokenExpiresAt: Date
  }
}

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

// history id was getting removed if we just use union
// and do parse of selectSyncJobSchema

// Define ChangeToken schema
const DefaultTokenSchema = z.object({
  type: z.literal("default"),
  token: z.string(),
  lastSyncedAt: z.coerce.date(),
})

// Google Drive and Contact change token
// clubbing drive, contact and other contact tokens
const GoogleDriveChangeTokenSchema = z.object({
  type: z.literal("googleDriveChangeToken"),
  driveToken: z.string(),
  contactsToken: z.string(),
  otherContactsToken: z.string(),
  lastSyncedAt: z.coerce.date(),
})

const GmailChangeTokenSchema = z.object({
  type: z.literal("gmailChangeToken"),
  historyId: z.string(),
  lastSyncedAt: z.coerce.date(),
})

const CalendarEventsChangeTokenSchema = z.object({
  type: z.literal("calendarEventsChangeToken"),
  calendarEventsToken: z.string(),
  lastSyncedAt: z.coerce.date(),
})

const ChangeTokenSchema = z.discriminatedUnion("type", [
  DefaultTokenSchema,
  GoogleDriveChangeTokenSchema,
  GmailChangeTokenSchema,
  CalendarEventsChangeTokenSchema,
])

// Define UpdatedAtVal schema
const UpdatedAtValSchema = z.object({
  type: z.literal("updatedAt"),
  updatedAt: z.coerce.date(),
})

// Define Config schema (either ChangeToken or UpdatedAtVal)
export const SyncConfigSchema = z.union([ChangeTokenSchema, UpdatedAtValSchema])

// TypeScript type for Config
export type SyncConfig = z.infer<typeof SyncConfigSchema>

export type ChangeToken = z.infer<typeof ChangeTokenSchema>
export type GoogleChangeToken = z.infer<typeof GoogleDriveChangeTokenSchema>
export type GmailChangeToken = z.infer<typeof GmailChangeTokenSchema>
export type CalendarEventsChangeToken = z.infer<
  typeof CalendarEventsChangeTokenSchema
>

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

export enum MessageTypes {
  JwtParams = "JwtParams",
}

export enum WorkerResponseTypes {
  Stats = "Stats",
  HistoryId = "HistoryId",
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
  Chat = "Chat",
  Utils = "Utils",
  Queue = "Queue",
  Eval = "Eval",
  AI = "AI",
  Tuning = "Tuning",
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

export enum MessageRole {
  System = "system",
  User = "user",
  Assistant = "assistant",
}

export const AnswerWithCitationsSchema = z.object({
  answer: z.string(),
  citations: z.array(z.number()),
})
