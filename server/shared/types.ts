// we use .. because vite is not able to resolve if we use @/search/types
import {
  entitySchema,
  VespaFileSchema,
  VespaUserSchema,
  Apps,
} from "search/types"
export {
  GooglePeopleEntity,
  DriveEntity,
  NotionEntity,
  Apps,
} from "search/types"
export type { Entity } from "search/types"
// @ts-ignore
import type { AppRoutes, WsApp } from "@/server"
import { z } from "zod"

export type AppType = typeof AppRoutes
export type WebSocketApp = typeof WsApp

export enum AuthType {
  OAuth = "oauth",
  ServiceAccount = "service_account",
  // where there is a custom JSON
  // we store all the key information
  // needed for end to end encryption
  Custom = "custom",
  ApiKey = "api_key",
}

export enum ConnectorStatus {
  Connected = "connected",
  // Pending = 'pending',
  Connecting = "connecting",
  Failed = "failed",
  // for oauth we will default to this
  NotConnected = "not-connected",
}

export enum SyncJobStatus {
  // never ran
  NotStarted = "NotStarted",
  // Ongoing
  Started = "Started",
  // last status failed
  Failed = "Failed",
  // last status was good
  Successful = "Successful",
}

export const AutocompleteFileSchema = z
  .object({
    type: z.literal("file"),
    relevance: z.number(),
    title: z.string(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
  })
  .strip()

export const AutocompleteUserSchema = z
  .object({
    type: z.literal("user"),
    relevance: z.number(),
    name: z.string(),
    email: z.string(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    photoLink: z.string().optional(),
  })
  .strip()

const AutocompleteSchema = z.discriminatedUnion("type", [
  AutocompleteFileSchema,
  AutocompleteUserSchema,
])

export const AutocompleteResultsSchema = z.object({
  results: z.array(AutocompleteSchema),
})

export type AutocompleteResults = z.infer<typeof AutocompleteResultsSchema>

// when imported from the frontend the type comes with unknown types
// possibly related to
// https://github.com/colinhacks/zod/issues/3536#issuecomment-2374074951
export type FileAutocomplete = z.infer<typeof AutocompleteFileSchema>
export type UserAutocomplete = z.infer<typeof AutocompleteUserSchema>
export type Autocomplete = z.infer<typeof AutocompleteSchema>

// search result

export const FileResponseSchema = VespaFileSchema.pick({
  docId: true,
  title: true,
  url: true,
  app: true,
  entity: true,
  owner: true,
  ownerEmail: true,
  photoLink: true,
})
  .extend({
    type: z.literal("file"),
    chunk: z.string().optional(),
    chunkIndex: z.number().optional(),
    mimeType: z.string(),
    chunks_summary: z.array(z.string()).optional(),
  })
  .strip()

export const UserResponseSchema = VespaUserSchema.pick({
  name: true,
  email: true,
  app: true,
  entity: true,
  photoLink: true,
})
  .strip()
  .extend({
    type: z.literal("user"),
  })

// Search Response Schema
export const SearchResultsSchema = z.discriminatedUnion("type", [
  UserResponseSchema,
  FileResponseSchema,
])

export type SearchResultDiscriminatedUnion = z.infer<typeof SearchResultsSchema>

export const SearchResponseSchema = z.object({
  count: z.number(),
  results: z.array(SearchResultsSchema),
  groupCount: z.any(),
})

export type FileResponse = z.infer<typeof FileResponseSchema>

export type SearchResponse = z.infer<typeof SearchResponseSchema>
