import config from "@/config"
import { z } from "zod"
import secureJsonParse from "secure-json-parse"
import {
  Apps,
  AuthType,
  ConnectorStatus,
  DriveEntity,
  SlackEntity,
} from "@/shared/types"
import { UserRole } from "@/shared/types"
import type { PgTransaction } from "drizzle-orm/pg-core"
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js"
import { JWT, type OAuth2Client } from "google-auth-library"
import type {
  CalendarEntity,
  MailAttachmentEntity,
  MailEntity,
  PeopleEntity,
} from "@xyne/vespa-ts/types"

export enum ProcessingJobType {
  FILE = "file",
  COLLECTION = "collection",
  FOLDER = "folder",
}

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
  entity: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  lastUpdated: z.string().default("anytime"),
  isQueryTyped: z.preprocess((val) => val === "true", z.boolean()).optional(),
  debug: z
    .union([z.string(), z.undefined(), z.null()])
    .transform((x) => (x ? x === "true" : false))
    .pipe(z.boolean())
    .optional(),
  agentId: z.string().optional(),
  isAgentIntegSearch: z.string().optional(),
})

export const searchSchema = baseSearchSchema.refine(
  (data) => {
    if (data.isAgentIntegSearch) {
      return true
    }
    // Otherwise use the existing validation
    return (data.app && data.entity) || (!data.app && !data.entity)
  },
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
  "service-key": z
    .any()
    .refine(
      (file) =>
        file.type === "application/json" || file.name?.endsWith(".json"),
      "File must be a JSON file",
    )
    .refine(
      (file) => file.size <= config.MAX_SERVICE_ACCOUNT_FILE_SIZE_BYTES,
      `File size must be less than ${config.MAX_SERVICE_ACCOUNT_FILE_SIZE_BYTES / 1024}KB`,
    )
    .refine(async (file) => {
      try {
        const content = await file.text()
        secureJsonParse(content, undefined, {
          protoAction: "error",
          constructorAction: "error",
        }) // Use secure JSON parsing with strict security options
        return true
      } catch {
        return false
      }
    }, "File must contain valid and secure JSON"),
  app: z.nativeEnum(Apps),
  email: z.string().email(),
  whitelistedEmails: z.string().optional(),
})

export type ServiceAccountConnection = z.infer<
  typeof addServiceConnectionSchema
>

export const updateServiceConnectionSchema = z.object({
  "service-key": z
    .any()
    .refine(
      (file) =>
        file.type === "application/json" || file.name?.endsWith(".json"),
      "File must be a JSON file",
    )
    .refine(
      (file) => file.size <= config.MAX_SERVICE_ACCOUNT_FILE_SIZE_BYTES,
      `File size must be less than ${config.MAX_SERVICE_ACCOUNT_FILE_SIZE_BYTES / 1024}KB`,
    )
    .refine(async (file) => {
      try {
        const content = await file.text()
        secureJsonParse(content, undefined, {
          protoAction: "error",
          constructorAction: "error",
        }) // Use secure JSON parsing with strict security options
        return true
      } catch {
        return false
      }
    }, "File must contain valid and secure JSON"),
  connectorId: z.string().min(1, "Connector ID is required"),
})

export type UpdateServiceAccountConnection = z.infer<
  typeof updateServiceConnectionSchema
>

export const addApiKeyConnectorSchema = z.object({
  app: z.nativeEnum(Apps),
  apiKey: z.string(),
})

export type ApiKeyConnector = z.infer<typeof addApiKeyConnectorSchema>

export enum MCPConnectorMode {
  SSE = "sse",
  StreamableHTTP = "streamable-http",
}

export const addApiKeyMCPConnectorSchema = z.object({
  url: z.string().url({ message: "must be a valid HTTP(S) URL" }),
  name: z.string(),
  mode: z.nativeEnum(MCPConnectorMode),
  headers: z.record(z.string(), z.string()),
})

export type ApiKeyMCPConnector = z.infer<typeof addApiKeyMCPConnectorSchema>

export const addStdioMCPConnectorSchema = z.object({
  command: z.string(),
  args: z.union([
    z.array(z.string()),
    z.string().transform((val) => {
      if (!val) {
        return []
      }
      // Use regex to handle quoted arguments, allowing spaces within arguments
      // Supports both single and double quotes
      const args = val.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
      return args.map((arg) => {
        // Remove surrounding quotes if present
        if (
          (arg.startsWith('"') && arg.endsWith('"')) ||
          (arg.startsWith("'") && arg.endsWith("'"))
        ) {
          return arg.slice(1, -1)
        }
        return arg
      })
    }),
  ]),
  name: z.string(),
  appType: z.string(),
})

export type StdioMCPConnector = z.infer<typeof addStdioMCPConnectorSchema>

export const createOAuthProvider = z
  .object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    app: z.nativeEnum(Apps),
    isUsingGlobalCred: z
      .preprocess((val) => val === "true", z.boolean())
      .default(false),
    isGlobalProvider: z
      .preprocess((val) => val === "true", z.boolean())
      .default(false)
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.isUsingGlobalCred) {
      if (!data.clientId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "clientId is required when isUsingGlobalCred is false",
          path: ["clientId"],
        })
      }
      if (!data.clientSecret) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "clientSecret is required when isUsingGlobalCred is false",
          path: ["clientSecret"],
        })
      }
      if (!data.scopes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "scopes is required when isUsingGlobalCred is false",
          path: ["scopes"],
        })
      }
    }
  })

export const microsoftServiceSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  tenantId: z.string(),
  app: z.nativeEnum(Apps),
})

export const deleteConnectorSchema = z.object({
  connectorId: z.string(),
})

export const chatIdParamSchema = z.object({
  chatId: z.string().min(1, "Chat ID must be a non-empty string"),
})

export const updateConnectorStatusSchema = z.object({
  connectorId: z.string(),
  status: z.nativeEnum(ConnectorStatus),
})

export const updateToolStatusSchema = z.object({
  toolId: z.coerce.number(), // Try coercing to number
  enabled: z.boolean(),
})

export const updateToolsStatusSchema = z.object({
  tools: z.array(updateToolStatusSchema),
})

export const serviceAccountIngestMoreSchema = z.object({
  connectorId: z.string(),
  emailsToIngest: z.array(z.string().email()),
  startDate: z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/, {
    message: "Start date must be in YYYY-MM-DD format or empty",
  }),
  endDate: z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/, {
    message: "End date must be in YYYY-MM-DD format or empty",
  }),
  insertDriveAndContacts: z.boolean(),
  insertGmail: z.boolean(),
  insertCalendar: z.boolean(),
})

export const deleteUserDataSchema = z.object({
  emailToClear: z
    .string()
    .email({ message: "Invalid email address to clear." }),
  options: z
    .object({
      startDate: z
        .string()
        .regex(/^$|^\d{4}-\d{2}-\d{2}$/, {
          message: "Start date must be in YYYY-MM-DD format or empty",
        })
        .optional(),
      endDate: z
        .string()
        .regex(/^$|^\d{4}-\d{2}-\d{2}$/, {
          message: "End date must be in YYYY-MM-DD format or empty",
        })
        .optional(),
      servicesToClear: z.array(z.string()).optional(), // e.g., ["drive", "gmail", "calendar"]
      deleteOnlyIfSoleOwnerInPermissions: z.boolean().optional(),
      deleteSyncJob: z.boolean().optional().default(false),
    })
    .optional(),
})

export type DeleteUserDataPayload = z.infer<typeof deleteUserDataSchema>

export type OAuthProvider = z.infer<typeof createOAuthProvider>
export type microsoftService = z.infer<typeof microsoftServiceSchema>

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

export type TxnOrClient = PgTransaction<any> | PostgresJsDatabase<any>

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

// Microsoft delta token schemas
const MicrosoftDriveDeltaTokenSchema = z.object({
  type: z.literal("microsoftDriveDeltaToken"),
  driveToken: z.string(),
  contactsToken: z.string(),
  lastSyncedAt: z.coerce.date(),
})

const MicrosoftOutlookDeltaTokenSchema = z.object({
  type: z.literal("microsoftOutlookDeltaToken"),
  deltaToken: z.string().optional(), // Backward compatibility
  deltaTokens: z.record(z.string(), z.string()).optional(), // New multi-folder approach
  lastSyncedAt: z.coerce.date(),
})

const MicrosoftCalendarDeltaTokenSchema = z.object({
  type: z.literal("microsoftCalendarDeltaToken"),
  calendarDeltaToken: z.string(),
  lastSyncedAt: z.coerce.date(),
})
const MicrosoftSharepointDeltaTokenSchema = z.object({
  type: z.literal("microsoftSharepointDeltaTokens"),
  deltaLinks: z.record(z.string(), z.string()).optional(),
  lastSyncedAt: z.coerce.date(),
})

const ChangeTokenSchema = z.discriminatedUnion("type", [
  DefaultTokenSchema,
  GoogleDriveChangeTokenSchema,
  GmailChangeTokenSchema,
  CalendarEventsChangeTokenSchema,
  MicrosoftDriveDeltaTokenSchema,
  MicrosoftOutlookDeltaTokenSchema,
  MicrosoftCalendarDeltaTokenSchema,
  MicrosoftSharepointDeltaTokenSchema,
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

export type MicrosoftServiceCredentials = {
  tenantId: string
  clientId: string
  clientSecret: string
  scopes: string[]
  access_token: string
  expires_at: string
}

export enum MessageTypes {
  JwtParams = "JwtParams",
}

export enum WorkerResponseTypes {
  Stats = "Stats",
  HistoryId = "HistoryId",
  Error = "Error",
  ProgressUpdate = "ProgressUpdate",
}

export enum Subsystem {
  Server = "Server",
  SyncServer = "SyncServer",
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
  AgentApi = "AgentApi",
  WorkflowApi = "WorkflowApi",
  Metric = "Metric",
  Slack = "Slack",
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

export enum Platform {
  Web = "web",
  Mobile = "mobile",
  Slack = "slack",
}

export const AnswerWithCitationsSchema = z.object({
  answer: z.string(),
  citations: z.array(z.number()),
})

export const MCPClientConfig = z.object({
  url: z.string(),
  version: z.string(),
  mode: z.nativeEnum(MCPConnectorMode).optional(),
})

export type MCPClientConfig = z.infer<typeof MCPClientConfig>

export const MCPClientStdioConfig = z.object({
  command: z.string(),
  args: z.array(z.string()),
  version: z.string(),
})

export const ingestMoreChannelSchema = z.object({
  connectorId: z.number(),
  channelsToIngest: z.array(z.string()),
  startDate: z.string(),
  endDate: z.string(),
  includeBotMessage: z.boolean().optional().default(false),
})
export const startSlackIngestionSchema = z.object({
  connectorId: z.number(),
})
export const startGoogleIngestionSchema = z.object({
  connectorId: z.string(),
})

export type EntityType =
  | DriveEntity
  | SlackEntity
  | MailEntity
  | MailAttachmentEntity
  | CalendarEntity
  | PeopleEntity
export type OperationType =
  | "ingestion"
  | "request"
  | "response"
  | "chat-create"
  | "chat-response"
  | "chat-response-error"
  | "search"
  | "search-response"
  | "ingest-more_user"

export type loggerChildSchema = {
  email: string
  appType?: Apps
  entityType?: EntityType
  responseCode?: string
  responseStatus?: string
  operationType?: OperationType
}
export const UserRoleChangeSchema = z.object({
  userId: z.string(),
  newRole: z.nativeEnum(UserRole),
})

export type userRoleChange = z.infer<typeof UserRoleChangeSchema>

// Admin pagination response schema
export const AdminChatsPaginationResponseSchema = z.object({
  data: z.array(z.any()), // Chat data array
  pagination: z.object({
    totalCount: z.number(),
    currentPage: z.number(),
    pageSize: z.number(),
    hasNextPage: z.boolean(),
    hasPreviousPage: z.boolean(),
  }),
})

export type AdminChatsPaginationResponse = z.infer<
  typeof AdminChatsPaginationResponseSchema
>

export const UserMetadata = z.object({
  userTimezone: z.string(),
  dateForAI: z.string(),
})

export type UserMetadataType = z.infer<typeof UserMetadata>

// ChunkMetadata type for OCR and file processing
export type ChunkMetadata = {
  chunk_index: number
  page_numbers: number[]
  block_labels: string[]
}

// DuckDB related types
export interface DuckDBQuery {
  sql: string
  notes: string
}

export interface DuckDBResult {
  user_question: string
  resolved_metric?: string
  sql: string
  execution_meta: {
    row_count: number
    elapsed_ms: number
    as_of: string
  }
  schema_fragment?: {
    table: string
    columns: Record<string, string>
  }
  assumptions: string[]
  data: {
    rows: unknown[][]
  }
}
