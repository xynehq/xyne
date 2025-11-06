import { sql, relations } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  boolean,
  index,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { users } from "./users"
import { channels, channelMessages } from "./channels"
import { directMessages } from "./directMessages"
import { lexicalEditorStateSchema } from "./directMessages"
import { MessageType } from "@/shared/types"

// Enum for message type - whether the thread is for channel or direct message
export const messageTypeEnum = pgEnum(
  "message_type",
  Object.values(MessageType) as [string, ...string[]],
)

// Threads Table - metadata for message threads
export const threads = pgTable(
  "threads",
  {
    id: serial("id").notNull().primaryKey(),
    // Reference to parent message - can be either channel message or direct message
    parentMessageId: integer("parent_message_id").notNull(),
    messageType: messageTypeEnum("message_type").notNull(), // 'channel' or 'direct'
    // For channel threads
    channelId: integer("channel_id").references(() => channels.id, {
      onDelete: "cascade",
    }),
    // Track reply count and last activity
    replyCount: integer("reply_count").notNull().default(0),
    lastReplyAt: timestamp("last_reply_at", { withTimezone: true }),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (table) => ({
    // Index for finding thread by parent message
    parentMessageTypeIdx: index("threads_parent_message_type_idx").on(
      table.parentMessageId,
      table.messageType,
    ),
    // Index for finding threads in a channel
    channelIdIdx: index("threads_channel_id_idx").on(table.channelId),
    // Index for sorting by last activity
    lastReplyAtIdx: index("threads_last_reply_at_idx").on(table.lastReplyAt),
  }),
)

// Thread Replies Table - messages within a thread
export const threadReplies = pgTable(
  "thread_replies",
  {
    id: serial("id").notNull().primaryKey(),
    threadId: integer("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    senderId: integer("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageContent: jsonb("message_content")
      .notNull()
      .$type<z.infer<typeof lexicalEditorStateSchema>>(),
    isEdited: boolean("is_edited").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    // Index for finding replies in a thread
    threadIdIdx: index("thread_replies_thread_id_idx").on(table.threadId),
    // Index for finding replies by sender
    senderIdIdx: index("thread_replies_sender_id_idx").on(table.senderId),
    // Index for sorting by creation time
    createdAtIdx: index("thread_replies_created_at_idx").on(table.createdAt),
  }),
)

// Zod schemas for threads
export const insertThreadSchema = createInsertSchema(threads, {
  parentMessageId: z.number().int().positive(),
  messageType: z.enum(["channel", "direct"]),
  channelId: z.number().int().positive().optional(),
}).omit({
  id: true,
  replyCount: true,
  lastReplyAt: true,
  createdAt: true,
  updatedAt: true,
})

export const selectThreadSchema = createSelectSchema(threads)

export type InsertThread = z.infer<typeof insertThreadSchema>
export type SelectThread = z.infer<typeof selectThreadSchema>

// Zod schemas for thread replies
export const insertThreadReplySchema = createInsertSchema(threadReplies, {
  messageContent: lexicalEditorStateSchema,
}).omit({
  id: true,
  isEdited: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
})

export const selectThreadReplySchema = createSelectSchema(threadReplies, {
  messageContent: lexicalEditorStateSchema,
})

export type InsertThreadReply = z.infer<typeof insertThreadReplySchema>
export type SelectThreadReply = z.infer<typeof selectThreadReplySchema>

// Relations
export const threadsRelations = relations(threads, ({ one, many }) => ({
  channel: one(channels, {
    fields: [threads.channelId],
    references: [channels.id],
  }),
  replies: many(threadReplies),
}))

export const threadRepliesRelations = relations(threadReplies, ({ one }) => ({
  thread: one(threads, {
    fields: [threadReplies.threadId],
    references: [threads.id],
  }),
  sender: one(users, {
    fields: [threadReplies.senderId],
    references: [users.id],
  }),
}))
