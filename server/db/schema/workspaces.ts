import { sql } from "drizzle-orm"
import { serial, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

// Workspaces Table
export const workspaces = pgTable("workspaces", {
  id: serial("id").notNull().primaryKey(),
  name: text("name").notNull(),
  domain: text("domain").notNull().unique(),
  // email
  createdBy: text("created_by").notNull().unique(),
  externalId: text("external_id").unique().notNull(),
  photoLink: text("photoLink"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
})

export const selectWorkspaceSchema = createSelectSchema(workspaces)
export type SelectWorkspace = z.infer<typeof selectWorkspaceSchema>

export const workspacePublicSchema = selectWorkspaceSchema.omit({
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  id: true,
})

export type PublicWorkspace = z.infer<typeof workspacePublicSchema>
