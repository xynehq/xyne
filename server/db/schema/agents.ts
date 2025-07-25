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
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { workspaces } from "./workspaces"
import { users } from "./users"

// Agents Table
export const agents = pgTable(
  "agents",
  {
    id: serial("id").notNull().primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    externalId: text("external_id").unique().notNull(),
    name: text("name").notNull(),
    description: text("description"),
    prompt: text("prompt"),
    model: text("model").notNull(),
    isPublic: boolean("is_public").default(false).notNull(),
    appIntegrations: jsonb("app_integrations").default(sql`'[]'::jsonb`), // Array of integration IDs/names
    allowWebSearch: boolean("allow_web_search").default(false),
    isRagOn: boolean("is_rag_on").default(true).notNull(),
    docIds: jsonb("doc_ids").default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    agentWorkspaceIdIndex: index("agent_workspace_id_index").on(
      table.workspaceId,
    ),
    agentUserIdIndex: index("agent_user_id_index").on(table.userId),
    agentExternalIdIndex: uniqueIndex("agent_external_id_unique_index").on(
      table.externalId,
    ),
  }),
)

export const insertAgentSchema = createInsertSchema(agents, {
  appIntegrations: z.array(z.string()).optional().default([]),
  docIds: z.array(z.string()).optional().default([]),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
})
export type InsertAgent = z.infer<typeof insertAgentSchema>

export const selectAgentSchema = createSelectSchema(agents, {
  appIntegrations: z.array(z.string()).optional().default([]),
  docIds: z.array(z.string()).optional().default([]),
})
export type SelectAgent = z.infer<typeof selectAgentSchema>

export const selectPublicAgentSchema = selectAgentSchema.omit({
  id: true,
  workspaceId: true,
  userId: true,
  deletedAt: true,
})
export type SelectPublicAgent = z.infer<typeof selectPublicAgentSchema>
