import { Apps, AuthType, Entity } from "shared/types"
import { z } from "zod"
import { LastUpdated } from "@/components/SearchFilter"

export const searchSchema = z.object({
  query: z.string().optional(),
  groupCount: z
    .union([z.string(), z.undefined(), z.null()])
    .transform((x) => (x ? x === "true" : false))
    .pipe(z.boolean())
    .optional(),
  offset: z
    .union([z.string(), z.undefined(), z.number(), z.null()])
    .transform((x) => Number(x ?? 0))
    .pipe(z.number().min(0))
    .optional(),
  // removed min page size for filters
  page: z
    .union([z.string(), z.undefined(), z.number(), z.null()])
    .transform((x) => Number(x ?? 8))
    .pipe(z.number())
    .optional(),
  app: z.string().min(1).optional(),
  entity: z.string().min(1).optional(),
})

export type Connectors = {
  app: string
  status: string
  authType: AuthType
}

export type Groups = Record<Apps, Record<Entity, number>>

export type Filter = {
  app?: Apps
  entity?: Entity
  lastUpdated?: LastUpdated
}

export enum OAuthIntegrationStatus {
  Provider = "Provider", // yet to create provider
  OAuth = "OAuth", // provider created but OAuth not yet connected
  OAuthConnecting = "OAuthConnecting",
  OAuthConnected = "OAuthConnected",
  OAuthPaused = "OAuthPaused",
}

export interface Reference {
  id: string
  title: string
  url?: string
  docId?: string
  app?: string
  entity?: string
  type: "citation" | "global"
  photoLink?: string
  mailId?: string
  userMap?: Record<string, string>
}
