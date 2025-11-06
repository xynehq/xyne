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

export const indexSearchParamsSchema = z.object({
  agentId: z.string().optional(),
})

export const toolsListItemSchema = z.object({
  connectorId: z.string(),
  tools: z.array(z.string()),
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

export enum CallType {
  Video = "video",
  Audio = "audio",
}

export enum OAuthIntegrationStatus {
  Provider = "Provider", // yet to create provider
  OAuth = "OAuth", // provider created but OAuth not yet connected
  OAuthConnecting = "OAuthConnecting",
  OAuthReadyForIngestion = "OAuthReadyForIngestion", // OAuth completed, ready to start ingestion
  OAuthConnected = "OAuthConnected",
  OAuthPaused = "OAuthPaused",
}

export interface ToolsListItem {
  connectorId: string
  tools: string[]
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
  wholeSheet?: boolean
  threadId?: string // Optional threadId for chat references
  parentThreadId?: string // Optional parentThreadId for email thread
}

export interface LexicalEditorState {
  root: {
    children: any[]
    direction?: string | null
    format?: string | number
    indent?: number
    type?: string
    version?: number
  }
}

// Channel types
export enum ChannelType {
  Public = "public",
  Private = "private",
}

export enum ChannelMemberRole {
  Owner = "owner",
  Admin = "admin",
  Member = "member",
}

export interface Channel {
  id: number
  name: string
  description?: string
  purpose?: string
  type: ChannelType
  isArchived: boolean
  createdAt: string
  archivedAt?: string | null
  memberRole?: ChannelMemberRole
  joinedAt?: string
  lastReadAt?: string | null
  memberCount?: number
  unreadCount?: number
}

export interface ChannelMember {
  id: string
  name: string
  email: string
  photoLink?: string | null
  role: ChannelMemberRole
  joinedAt: string
}

export interface ChannelMessage {
  id: number
  channelId: number
  messageContent: LexicalEditorState
  isEdited: boolean
  isPinned: boolean
  pinnedAt?: string | null
  createdAt: string
  deletedAt?: string | null
  updatedAt?: string
  sender: {
    id: string
    name: string
    email: string
    photoLink?: string | null
  }
  pinnedBy?: {
    id: string
    name: string
  }
  // Thread information
  threadId?: number | null
  replyCount?: number
  lastReplyAt?: string | null
  repliers?: Array<{ userId: string; name: string; photoLink: string | null }>
}
