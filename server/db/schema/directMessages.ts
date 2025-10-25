import { sql, relations } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  boolean,
  index,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { users } from "./users"

// Direct Messages Table - for user-to-user messaging
export const directMessages = pgTable(
  "direct_messages",
  {
    id: serial("id").notNull().primaryKey(),
    sentByUserId: integer("sent_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sentToUserId: integer("sent_to_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageContent: text("message_content").notNull(),
    isRead: boolean("is_read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    sentByIdx: index("direct_messages_sent_by_idx").on(table.sentByUserId),
    sentToIdx: index("direct_messages_sent_to_idx").on(table.sentToUserId),
    conversationIdx: index("direct_messages_conversation_idx").on(
      table.sentByUserId,
      table.sentToUserId,
    ),
    createdAtIdx: index("direct_messages_created_at_idx").on(table.createdAt),
  }),
)

// Zod schemas for direct messages
export const insertDirectMessageSchema = createInsertSchema(
  directMessages,
).omit({
  id: true,
  isRead: true,
  createdAt: true,
  updatedAt: true,
})

export const selectDirectMessageSchema = createSelectSchema(directMessages)

export type InsertDirectMessage = z.infer<typeof insertDirectMessageSchema>
export type SelectDirectMessage = z.infer<typeof selectDirectMessageSchema>

// Relations
export const directMessagesRelations = relations(directMessages, ({ one }) => ({
  sentBy: one(users, {
    fields: [directMessages.sentByUserId],
    references: [users.id],
    relationName: "sent_direct_messages",
  }),
  sentTo: one(users, {
    fields: [directMessages.sentToUserId],
    references: [users.id],
    relationName: "received_direct_messages",
  }),
}))
