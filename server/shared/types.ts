// TODO: need to figure out a shared import module name
// when imported from frontend and backend
// @ts-ignore
import type { AppRoutes, WsApp } from '@/server'
import { z } from 'zod'
// export type { AutocompleteResults, Autocomplete, Entity, FileAutocomplete, UserAutocomplete } from '@/types'

export type AppType = typeof AppRoutes
export type WebSocketApp = typeof WsApp


export enum Apps {
    // includes everything google
    GoogleWorkspace = "google-workspace",
    // more granular
    GoogleDrive = "google-drive",

    Notion = "notion"
}

export interface FileResponse {
    docId: string,
    title: string,
    chunk: string,
    chunkIndex: number,
    url: string,
    app: Apps,
    entity: Entity,
    mimeType: string,
    photoLink: string,
    owner: string,
    ownerEmail: string,
    chunks_summary: string[]
}

export enum AuthType {
    OAuth = 'oauth',
    ServiceAccount = 'service_account',
    // where there is a custom JSON
    // we store all the key information
    // needed for end to end encryption
    Custom = 'custom',
    ApiKey = 'api_key'
}

export enum ConnectorStatus {
    Connected = 'connected',
    // Pending = 'pending',
    Connecting = 'connecting',
    Failed = 'failed',
    // for oauth we will default to this
    NotConnected = 'not-connected'
}

export enum SyncJobStatus {
    // never ran
    NotStarted = 'NotStarted',
    // Ongoing
    Started = 'Started',
    // last status failed
    Failed = 'Failed',
    // last status was good
    Successful = 'Successful'
}

export enum GooglePeopleEntity {
    Contacts = "Contacts",
    OtherContacts = "OtherContacts",
    AdminDirectory = "AdminDirectory"
}

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


export const PeopleEntitySchema = z.nativeEnum(GooglePeopleEntity)

export type PeopleEntity = z.infer<typeof PeopleEntitySchema>

export enum NotionEntity {
    Page = "page",
    Database = "database"
}

const FileEntitySchema = z.nativeEnum(DriveEntity)

const NotionEntitySchema = z.nativeEnum(NotionEntity)

export const entitySchema = z.union([
    PeopleEntitySchema, FileEntitySchema, NotionEntitySchema
])

export type Entity = PeopleEntity | DriveEntity | NotionEntity

export type WorkspaceEntity = DriveEntity

const AutocompleteFileSchema = z.object({
    type: z.literal('file'),
    title: z.string(),
    app: z.nativeEnum(Apps),
    entity: entitySchema
})

const AutocompleteUserSchema = z.object({
    type: z.literal('user'),
    name: z.string(),
    email: z.string(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    photoLink: z.string()
})

const AutocompleteSchema = z.discriminatedUnion('type', [
    AutocompleteFileSchema, AutocompleteUserSchema
]);

export const AutocompleteResultsSchema = z.object({
    children: z.array(z.object({
        relevance: z.number(),
        fields: AutocompleteSchema
    }))
})

export type AutocompleteResults = z.infer<typeof AutocompleteResultsSchema>


// when imported from the frontend the type comes with unknown types
// possibly related to
// https://github.com/colinhacks/zod/issues/3536#issuecomment-2374074951
export type FileAutocomplete = z.infer<typeof AutocompleteFileSchema>
export type UserAutocomplete = z.infer<typeof AutocompleteUserSchema>
export type Autocomplete = z.infer<typeof AutocompleteSchema>
