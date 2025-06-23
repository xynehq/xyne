import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core"
import { workspaces } from "./workspaces"
import { users } from "./users"
import { chats } from "./chats"
import { messages } from "./messages"
import { bytea } from "../customType"

export const chatTrace = pgTable(
  "chat_trace",
  {
    id: serial("id").notNull().primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id),
    chatExternalId: text("chat_external_id").notNull(),
    messageExternalId: text("message_external_id").notNull(),
    email: text("email").notNull(),
    traceJson: bytea("trace_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (table) => ({
    workspaceIdIndex: index("chat_trace_workspace_id_index").on(
      table.workspaceId,
    ),
    userIdIndex: index("chat_trace_user_id_index").on(table.userId),
    chatExternalIdIndex: index("chat_trace_chat_external_id_index").on(
      table.chatExternalId,
    ),
    messageExternalIdIndex: index("chat_trace_message_external_id_index").on(
      table.messageExternalId,
    ),
  }),
)
