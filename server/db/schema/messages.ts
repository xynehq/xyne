import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  pgEnum,
  index,
  numeric,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { MessageRole } from "@/types"
import { MessageFeedback } from "@/shared/types"
import { chats } from "./chats"
import { users } from "./users"

const messageRoleField = "message_role"
export const messageRoleEnum = pgEnum(
  messageRoleField,
  Object.values(MessageRole) as [string, ...string[]],
)

export const messageFeedbackEnum = pgEnum(
  "message_feedback",
  Object.values(MessageFeedback) as [string, ...string[]],
)

export const messages = pgTable(
  "messages",
  {
    id: serial("id").notNull().primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    externalId: text("external_id").unique().notNull(),
    workspaceExternalId: text("workspace_external_id").notNull(),
    chatExternalId: text("chat_external_id").notNull(),
    message: text("message").notNull(),
    messageRole: messageRoleEnum(messageRoleField).notNull(),
    thinking: text("thinking").notNull().default(""),
    deepResearchSteps: jsonb("deep_research_steps")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // model id is present in the app itself
    // <provider><modelId>
    modelId: text("modelId").notNull(),
    email: text("email").notNull(),
    sources: jsonb("sources").notNull().default(sql`'[]'::jsonb`),
    imageCitations: jsonb("image_citations")
      .notNull()
      .default(sql`'[]' ::jsonb`),
    fileIds: jsonb("fileIds").notNull().default(sql`'[]'::jsonb`),
    attachments: jsonb("attachments").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    errorMessage: text("error_message").default(""),
    queryRouterClassification: jsonb("queryRouterClassification")
      .notNull()
      .default(sql`'[]'::jsonb`),
    feedback: jsonb("feedback"), // Enhanced feedback data in JSON format (supports both legacy enum values and new structure)
    tokensUsed: integer("tokens_used").default(0), // Total tokens used for this message
    cost: numeric("cost", { precision: 10, scale: 6 }).notNull().default("0"), // Actual cost in dollars for this LLM call
  },
  (table) => ({
    chatIdIndex: index("chat_id_index").on(table.chatId),
  }),
)

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
})

export type InsertMessage = z.infer<typeof insertMessageSchema>

// Select schema for messages
export const selectMessageSchema = createSelectSchema(messages)
export type SelectMessage = z.infer<typeof selectMessageSchema>

export const selectPublicMessageSchema = selectMessageSchema.omit({
  id: true,
  chatId: true,
  userId: true,
})

export const selectPublicMessagesSchema = z.array(selectPublicMessageSchema)
export type SelectPublicMessage = z.infer<typeof selectPublicMessageSchema>
