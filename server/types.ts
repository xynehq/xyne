import config from '@/config'
import { z } from 'zod'
import { Apps, AuthType } from '@/shared/types'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { GoogleTokens } from 'arctic'

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

export const AutocompleteResultSchema = z.object({
    title: z.string().min(1),
})

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
    SaaS = 'saas',
    Database = 'database',
    API = 'api',
    File = 'file',
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
// temporary roles
export enum UserRole {
    User = "user",
    Admin = "admin",
    SuperAdmin = "super_admin"
}

export type TxnOrClient = PgTransaction<any> | PostgresJsDatabase


export type OAuthCredentials = GoogleTokens | any