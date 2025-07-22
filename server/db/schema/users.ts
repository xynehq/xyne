import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { UserRole } from "@/shared/types"
import { workspaces } from "./workspaces"

export const userRoleEnum = pgEnum(
  "role",
  Object.values(UserRole) as [string, ...string[]],
)

// Users Table
export const users = pgTable(
  "users",
  {
    id: serial("id").notNull().primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    email: text("email").notNull(),
    name: text("name").notNull(),
    photoLink: text("photoLink"),
    externalId: text("external_id").unique().notNull(),
    // this will come handy for jwt token
    workspaceExternalId: text("workspace_external_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
      .notNull()
      .default(sql`'1970-01-01T00:00:00Z'`),
    lastLogin: timestamp("last_login", { withTimezone: true }),
    role: userRoleEnum("role").notNull().default(UserRole.User),
    refreshToken: text("refreshToken").notNull(),
  },
  (table) => ({
    emailUniqueIndex: uniqueIndex("email_unique_index").on(
      sql`LOWER(${table.email})`,
    ),
  }),
)

export const selectUserSchema = createSelectSchema(users)
export type SelectUser = z.infer<typeof selectUserSchema>

export const userPublicSchema = selectUserSchema.omit({
  lastLogin: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  id: true,
  workspaceId: true,
})

export type PublicUser = z.infer<typeof userPublicSchema>
