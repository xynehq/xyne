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
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { SearchModes } from "@xyne/vespa-ts/types"
import { workspaces } from "./workspaces"
import { users } from "./users"

// User Personalization Table
export const userPersonalization = pgTable(
  "user_personalization",
  {
    id: serial("id").notNull().primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id)
      .unique(), // Each user has only one personalization setting
    email: text("email").notNull(),
    // Store parameters as a JSON object keyed by rank profile name
    parameters: jsonb("parameters").notNull().default(sql`'{}'::jsonb`), // Default to empty JSON object
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => ({
    userIdx: index("user_personalization_user_idx").on(t.userId),
    emailIdx: index("user_personalization_email_idx").on(t.email),
    workspaceIdx: index("user_personalization_workspace_idx").on(t.workspaceId),
  }),
)

// Define the structure for a single rank profile's parameters
const rankProfileParamsSchema = z.object({
  alpha: z.number().min(0).max(1).optional(), // Alpha range 0.0-1.0
  // Add other potential parameters here, e.g.:
  // beta: z.number().optional(),
})

// Define the main parameters schema as a record (dictionary)
const parametersSchema = z.record(
  z.nativeEnum(SearchModes),
  rankProfileParamsSchema,
) // Keys are SearchModes enum

export const selectPersonalizationSchema = createSelectSchema(
  userPersonalization,
  {
    parameters: parametersSchema, // Validate the JSON structure on select
  },
)
export const insertPersonalizationSchema = createInsertSchema(
  userPersonalization,
  {
    parameters: parametersSchema, // Validate the JSON structure on insert
    email: z.string().email(),
    workspaceId: z.number().int(), // Add workspaceId validation
  },
)

export type SelectPersonalization = z.infer<typeof selectPersonalizationSchema>
export type InsertPersonalization = z.infer<typeof insertPersonalizationSchema>
