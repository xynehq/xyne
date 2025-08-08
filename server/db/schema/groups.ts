import { sql } from "drizzle-orm"
import { pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const groups = pgTable("groups", {
  id: text("id").notNull().primaryKey(),
  name: text("name").notNull(),
  groupEmail: text("email").notNull(),
  description: text("description").notNull(),
  directMembersCount: text("directMembersCount").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
})
