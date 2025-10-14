import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { users } from "./users"

// Calls Table
export const calls = pgTable("calls", {
  id: serial("id").notNull().primaryKey(),
  externalId: text("external_id").unique().notNull(),
  roomName: text("room_name").unique().notNull(),
  createdByUserId: integer("created_by_user_id")
    .notNull()
    .references(() => users.id),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  // Store participant external IDs as JSON array
  participants: jsonb("participants").$type<string[]>().notNull().default([]),
  // Store invited user external IDs as JSON array
  invitedUsers: jsonb("invited_users").$type<string[]>().notNull().default([]),
  roomLink: text("room_link").notNull(),
  callType: text("call_type").notNull().default("video"), // 'video' or 'audio'
})

export const insertCallSchema = createInsertSchema(calls).omit({
  id: true,
  startedAt: true,
})

export const selectCallSchema = createSelectSchema(calls)

export type InsertCall = z.infer<typeof insertCallSchema>
export type SelectCall = z.infer<typeof selectCallSchema>
