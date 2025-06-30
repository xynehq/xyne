import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  boolean,
  index,
  unique,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { chats } from "./chats"
import { messages } from "./messages"
import { workspaces } from "./workspaces"
import { users } from "./users"

export const sharedChats = pgTable(
  "shared_chats",
  {
    id: serial("id").notNull().primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id), // Reference to the specific message up to which to share
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    shareToken: text("share_token").unique().notNull(), // Encoded token containing chatId and messageId
    title: text("title").notNull(), // Title at the time of sharing
    deletedAt: timestamp("deleted_at", { withTimezone: true }), // Soft delete for deactivating shares
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (table) => ({
    shareTokenIndex: index("shared_chats_share_token_index").on(
      table.shareToken,
    ),
    chatIdIndex: index("shared_chats_chat_id_index").on(table.chatId),
    messageIdIndex: index("shared_chats_message_id_index").on(table.messageId),
    userIdIndex: index("shared_chats_user_id_index").on(table.userId),
    deletedAtIndex: index("shared_chats_deleted_at_index").on(table.deletedAt),
    uniqueChatMessage: unique("unique_chat_message_share").on(
      table.chatId,
      table.messageId,
    ), // Ensure one share per chat+message combination
  }),
)

export const insertSharedChatSchema = createInsertSchema(sharedChats).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
})

export type InsertSharedChat = z.infer<typeof insertSharedChatSchema>

export const selectSharedChatSchema = createSelectSchema(sharedChats)
export type SelectSharedChat = z.infer<typeof selectSharedChatSchema>

export const selectPublicSharedChatSchema = selectSharedChatSchema.omit({
  id: true,
  userId: true,
  workspaceId: true,
})
export type SelectPublicSharedChat = z.infer<
  typeof selectPublicSharedChatSchema
>
