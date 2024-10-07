import config from '@/config'
import { nativeEnum, z } from 'zod'
import { Apps, AuthType } from '@/shared/types'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { GoogleTokens } from 'arctic'
import { JWT, type OAuth2Client } from 'google-auth-library'

export enum GooglePeopleEntity {
    Contacts = "Contacts",
    OtherContacts = "OtherContacts",
    AdminDirectory = "AdminDirectory"
}

const UserSchema = z.object({
    docid: z.string().min(1),
    name: z.string().min(1),
    email: z.string().min(1).email(),
    app: z.nativeEnum(Apps),
    entity: z.nativeEnum(GooglePeopleEntity),
    gender: z.string().optional(),
    photoLink: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    langauge: z.string().optional(),
    includeInGlobalAddressList: z.boolean().optional(),
    isAdmin: z.boolean().optional(),
    isDelegatedAdmin: z.boolean().optional(),
    suspended: z.boolean().optional(),
    archived: z.boolean().optional(),
    urls: z.array(z.string()).optional(),
    orgName: z.string().optional(),
    orgJobTitle: z.string().optional(),
    orgDepartment: z.string().optional(),
    orgLocation: z.string().optional(),
    orgDescription: z.string().optional(),
    creationTime: z.number(),
    lastLoggedIn: z.number().optional(),
    birthday: z.number().optional(),
    occupations: z.array(z.string()).optional(),
    userDefined: z.array(z.string()).optional(),
    customerId: z.string().optional(),
    clientData: z.array(z.string()).optional(),
});

export type User = z.infer<typeof UserSchema>

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




export type PeopleEntity = GooglePeopleEntity

export const AutocompleteResultSchema = z.union([
    z.object({
        title: z.string().min(1),
        app: z.nativeEnum(Apps),
        entity: z.string().min(1)
    }),
    UserSchema.pick({
        name: true,
        email: true,
        app: true,
        entity: true
    })
])

export type Autocomplete = z.infer<typeof AutocompleteResultSchema>


export type Entity = PeopleEntity

export type WorkspaceEntity = DriveEntity

export enum DriveEntity {
    Docs = "docs",
    Sheets = "sheets",
    Presentation = "presentation",
    PDF = "pdf",
    Folder = "folder",
    Misc = "driveFile",
    Drawing = "drawing",
    Form = "form",
    Script = "script",
    Site = "site",
    Map = "map",
    Audio = "audio",
    Video = "video",
    Photo = "photo",
    ThirdPartyApp = "third_party_app",
    Image = "image",
    Zip = "zip",
    WordDocument = "word_document",
    ExcelSpreadsheet = "excel_spreadsheet",
    PowerPointPresentation = "powerpoint_presentation",
    Text = "text",
    CSV = "csv",
}


// type GoogleContacts = people_v1.Schema$Person
// type WorkspaceDirectoryUser = admin_directory_v1.Schema$User

// People graph of google workspace
// type GoogleWorkspacePeople = WorkspaceDirectoryUser | GoogleContacts

// type PeopleData = GoogleWorkspacePeople

export const AutocompleteResultsSchema = z.object({
    children: z.array(AutocompleteResultSchema)
})

export type AutocompleteResults = z.infer<typeof AutocompleteResultsSchema>

// Base interface for Vespa response
export interface VespaResponse<T> {
    root: VespaRoot<T>
}

// Root type handling both regular search results and groups
export interface VespaRoot<T> {
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
    children: (VespaResult<T> | VespaGroup)[]
}

// For regular search results
export type VespaResult<T> = {
    id: string
    relevance: number
    fields: T
    pathId?: string
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

namespace Google {
    export const DriveFileSchema = z.object({
        id: z.string().nullable(),
        webViewLink: z.string().nullable(),
        createdTime: z.string().nullable(),
        modifiedTime: z.string().nullable(),
        name: z.string().nullable(),
        owners: z.array(
            z.object({
                displayName: z.string().optional(),
                emailAddress: z.string().optional(),
                kind: z.string().optional(),
                me: z.boolean().optional(),
                permissionId: z.string().optional(),
                photoLink: z.string().optional(),
            })
        ).optional(),
        fileExtension: z.string().nullable(),
        mimeType: z.string().nullable(),
        permissions: z.array(
            z.object({
                id: z.string(),
                type: z.string(),
                emailAddress: z.string().nullable(),
            })
        ).nullable(),
    });
    export type DriveFile = z.infer<typeof DriveFileSchema>
}

const VespaFileSchema = z.object({
    docId: z.string(),
    app: z.nativeEnum(Apps),
    entity: z.string(),
    title: z.string(),
    url: z.string().nullable(),
    // we don't want zod to validate this for perf reason
    chunks: z.array(z.string()),
    // we don't want zod to validate this field
    chunk_embeddings: z.object({
        type: z.string(),
        blocks: z.any()
    }),
    owner: z.string().nullable(),
    ownerEmail: z.string().nullable(),
    photoLink: z.string().nullable(),
    permissions: z.array(z.string()),
    mimeType: z.string().nullable(),
});

// Infer the TypeScript type from the Zod schema
export type VespaFile = z.infer<typeof VespaFileSchema>;
export type VespaFileWithDrivePermission = Omit<VespaFile, "permissions"> & {
    permissions: any[]
}


export type GoogleClient = JWT | OAuth2Client

export type GoogleServiceAccount = {
    client_email: string,
    private_key: string,
}
