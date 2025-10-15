import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { users } from "./users"

// Call type enum
export enum CallType {
  Video = "video",
  Audio = "audio",
}

// PostgreSQL enum for call types
export const callTypeEnum = pgEnum(
  "call_type",
  Object.values(CallType) as [string, ...string[]],
)

// Calls Table
export const calls = pgTable("calls", {
  id: serial("id").notNull().primaryKey(),
  externalId: text("external_id").unique().notNull(),
  createdByUserId: integer("created_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  participants: jsonb("participants")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  invitedUsers: jsonb("invited_users")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  roomLink: text("room_link").notNull(),
  callType: callTypeEnum("call_type").notNull().default(CallType.Video),
})

export const insertCallSchema = createInsertSchema(calls).omit({
  id: true,
  startedAt: true,
})

export const selectCallSchema = createSelectSchema(calls)

export type InsertCall = z.infer<typeof insertCallSchema>
export type SelectCall = z.infer<typeof selectCallSchema>
