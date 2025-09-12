import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
  jsonb,
  boolean,
  pgEnum,
  unique,
  index,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { encryptedText } from "../customType"
import { Encryption } from "@/utils/encryption"
import { Apps, AuthType, ConnectorStatus } from "@/shared/types"
import { workspaces } from "./workspaces"
import { users } from "./users"
import { connectors } from "../schema"

// Tools Table
export const tools = pgTable(
  "tools",
  {
    id: serial("id").notNull().primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    connectorId: integer("connector_id")
      .notNull()
      .references(() => connectors.id),
    externalId: text("external_id").unique(),
    toolName: text("tool_name").notNull(),
    toolSchema: text("tool_schema").notNull(), // Store the entire schema as a string
    description: text("description"),
    enabled: boolean("enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (table) => ({
    // Create a unique index on the combination of workspaceId, connectorId, and toolName
    uniqueTool: unique().on(
      table.workspaceId,
      table.connectorId,
      table.toolName,
    ),
    // Add indexes for common query patterns
    connectorIdIdx: index("tools_connector_id_idx").on(table.connectorId),
    toolNameIdx: index("tools_tool_name_idx").on(table.toolName),
  }),
)

// Create Zod schemas for the tools table
export const insertToolSchema = createInsertSchema(tools).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
})
export type InsertTool = z.infer<typeof insertToolSchema>

export const selectToolSchema = createSelectSchema(tools)
export type SelectTool = z.infer<typeof selectToolSchema>

// Schema for tool schema validation (optional but recommended)
export const toolSchemaStructure = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.object({
    type: z.literal("object"),
    properties: z.record(z.any(), z.any()),
  }),
  annotations: z
    .object({
      title: z.string().optional(),
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
})
export type ToolSchemaStructure = z.infer<typeof toolSchemaStructure>
