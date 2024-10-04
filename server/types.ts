import config from '@/config'
import { z } from 'zod'
import { Apps, AuthType } from '@/shared/types'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { GoogleTokens } from 'arctic'
import { admin_directory_v1, google, people_v1, type drive_v3 } from 'googleapis'

export interface File {
    docId: string,
    title: string,
    chunk: string,
    chunkIndex: number,
    url: string,
    app: string,
    entity: string,
    permissions: string[],
    owner: string,
    ownerEmail: string,
    photoLink: string,
    mimeType: string,
    title_embedding: number[],
    chunk_embedding: number[]
}

export enum GooglePeopleSource {
    Contacts = "Contacts",
    OtherContacts = "OtherContacts",
    AdminDirectory = "AdminDirectory"
}

export type PeopleSource = GooglePeopleSource
// TODO: turn it into a union the moment PeopleSource has more than one type
export const PeopleSourceSchema = z.nativeEnum(GooglePeopleSource)

export const AutocompleteResultSchema = z.union([
    z.object({
        title: z.string().min(1),
        app: z.string().min(1),
        entity: z.string().min(1)
    }),
    z.object({
        name: z.string().min(1),
        email: z.string().min(1),
        source: PeopleSourceSchema
    })
])



type GoogleContacts = people_v1.Schema$Person
type WorkspaceDirectoryUser = admin_directory_v1.Schema$User

// People graph of google workspace
type GoogleWorkspacePeople = WorkspaceDirectoryUser | GoogleContacts

type PeopleData = GoogleWorkspacePeople

export const AutocompleteResultsSchema = z.object({
    children: z.array(AutocompleteResultSchema)
})

export type AutocompleteResults = z.infer<typeof AutocompleteResultsSchema>

// Base interface for Vespa response
export interface VespaResponse {
    root: VespaRoot
}

// Root type handling both regular search results and groups
export interface VespaRoot {
    id: string
    relevance: number
    fields?: {
        totalCount: number
    }
    coverage: {
        coverage: number
        documents: number
        full: boolean
        nodes: number
        results: number
        resultsFull: number
    }
    children: (VespaResult | VespaGroup)[]
}

// For regular search results
export type VespaResult = {
    id: string
    relevance: number
    fields: {
        title: string
        [key: string]: any
    }
}

// For grouping response (e.g., app/entity counts)
export interface VespaGroup {
    id: string
    relevance: number
    label: string
    value?: string // e.g., app or entity value
    fields?: {
        "count()": number
    }
    children: VespaGroup[] // Nested groups (e.g., app -> entity)
}


export interface XyneSearchResponse {

}

export const searchSchema = z.object({
    query: z.string(),
    groupCount: z.union([z.string(), z.undefined(), z.null()]).transform(x => x ? x === 'true' : false).pipe(z.boolean()).optional(),
    offset: z.union([z.string(), z.undefined(), z.null()]).transform(x => Number(x ?? 0)).pipe(z.number().min(0)).optional(),
    // removed min page size for filters
    page: z.union([z.string(), z.undefined(), z.null()]).transform(x => Number(x ?? config.page)).pipe(z.number()).optional(),
    app: z.string().min(1).optional(),
    entity: z.string().min(1).optional()
})

export const searchQuerySchema = searchSchema.extend({
    permissions: z.array(z.string())
})

export type SearchQuery = z.infer<typeof searchQuerySchema>

export const oauthStartQuerySchema = z.object({
    app: z.nativeEnum(Apps)
})
export type OAuthStartQuery = z.infer<typeof oauthStartQuerySchema>

export const addServiceConnectionSchema = z.object({
    'service-key': z.any(),
    app: z.nativeEnum(Apps),
    email: z.string(),
})

export type ServiceAccountConnection = z.infer<typeof addServiceConnectionSchema>

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
    SaaS = 'SaaS',
    // DuckDB, Postgres, MySQL
    Database = 'Database',
    // Weather api?
    API = 'Api',
    // Manually uploaded data like pdf
    File = 'File',
    // Where we can scrape and crawl
    Website = 'Website'
}

export type SaaSJob = {
    connectorId: number,
    workspaceId: number,
    userId: number,
    app: Apps,
    externalId: string,
    authType: AuthType,
    email: string
}

export type SaaSOAuthJob = Omit<SaaSJob, "userId" | "workspaceId">

// very rudimentary
export enum UserRole {
    User = "User", // can do oauth of their own data or api key based
    TeamLeader = "TeamLeader", // manage Users
    Admin = "Admin", // Service account related changes
    SuperAdmin = "SuperAdmin" // Admin level changes
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
const ChangeTokenSchema = z.object({
    token: z.string(),
    lastSyncedAt: z.coerce.date()
});

// Define UpdatedAtVal schema
const UpdatedAtValSchema = z.object({
    updatedAt: z.coerce.date()
});

// Define Config schema (either ChangeToken or UpdatedAtVal)
export const SyncConfigSchema = z.union([ChangeTokenSchema, UpdatedAtValSchema]);

// TypeScript type for Config
export type SyncConfig = z.infer<typeof SyncConfigSchema>;

export type ChangeToken = z.infer<typeof ChangeTokenSchema>

export enum DriveMime {
    Docs = "application/vnd.google-apps.document",
    Sheets = "application/vnd.google-apps.spreadsheet",
    Slides = "application/vnd.google-apps.presentation",
}

