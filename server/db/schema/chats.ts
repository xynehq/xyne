import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  index,
  pgEnum,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { workspaces } from "./workspaces"
import { users } from "./users"
import { Platform } from "@/types"

const platform = "platform"
export const platformEnum = pgEnum(
  platform,
  Object.values(Platform) as [string, ...string[]],
)

// Chat type enum for better scalability
export enum ChatType {
  Default = "default",
  KbChat = "kb_chat",
}

const chatType = "chat_type"
export const chatTypeEnum = pgEnum(
  chatType,
  Object.values(ChatType) as [string, ...string[]],
)

export const chats = pgTable(
  "chats",
  {
    id: serial("id").notNull().primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    externalId: text("external_id").unique().notNull(),
    workspaceExternalId: text("workspace_external_id").notNull(),
    isBookmarked: boolean("is_bookmarked").notNull().default(false),
    email: text("email").notNull(),
    title: text("title").notNull(),
    // metadata for any file that is uploaded as
    // attachment for that chat
    attachments: jsonb("attachments").notNull(),
    agentId: text("agent_id"), // Added agentId field
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    platform: platformEnum(platform).notNull().default(Platform.Web),
    via_apiKey: boolean("via_apiKey").notNull().default(false),
    chatType: chatTypeEnum(chatType).notNull().default(ChatType.Default),
  },
  (table) => ({
    isBookmarkedIndex: index("is_bookmarked_index").on(table.isBookmarked),
  }),
)

export const insertChatSchema = createInsertSchema(chats, {
  agentId: z.string().optional(), // Make agentId optional in the Zod schema
}).omit({
  id: true,
})
export type InsertChat = z.infer<typeof insertChatSchema>

export const selectChatSchema = createSelectSchema(chats)
export type SelectChat = z.infer<typeof selectChatSchema>

export const selectPublicChatSchema = selectChatSchema.omit({
  id: true,
  userId: true,
})
export type SelectPublicChat = z.infer<typeof selectPublicChatSchema>
