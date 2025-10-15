import { sql, relations } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  pgEnum,
  primaryKey,
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
  roomLink: text("room_link").notNull(),
  callType: callTypeEnum("call_type").notNull().default(CallType.Audio),
})

// Junction table for call participants
export const callParticipants = pgTable(
  "call_participants",
  {
    callId: integer("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    leftAt: timestamp("left_at", { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.callId, table.userId] }),
  }),
)

// Junction table for invited users
export const callInvitedUsers = pgTable(
  "call_invited_users",
  {
    callId: integer("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    invitedAt: timestamp("invited_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.callId, table.userId] }),
  }),
)

// Zod schemas for calls
export const insertCallSchema = createInsertSchema(calls).omit({
  id: true,
  startedAt: true,
})

export const selectCallSchema = createSelectSchema(calls)

export type InsertCall = z.infer<typeof insertCallSchema>
export type SelectCall = z.infer<typeof selectCallSchema>

// Zod schemas for call participants
export const insertCallParticipantSchema = createInsertSchema(
  callParticipants,
).omit({
  joinedAt: true,
})

export const selectCallParticipantSchema = createSelectSchema(callParticipants)

export type InsertCallParticipant = z.infer<typeof insertCallParticipantSchema>
export type SelectCallParticipant = z.infer<typeof selectCallParticipantSchema>

// Zod schemas for invited users
export const insertCallInvitedUserSchema = createInsertSchema(
  callInvitedUsers,
).omit({
  invitedAt: true,
})

export const selectCallInvitedUserSchema = createSelectSchema(callInvitedUsers)

export type InsertCallInvitedUser = z.infer<typeof insertCallInvitedUserSchema>
export type SelectCallInvitedUser = z.infer<typeof selectCallInvitedUserSchema>

// Relations
export const callsRelations = relations(calls, ({ one, many }) => ({
  createdBy: one(users, {
    fields: [calls.createdByUserId],
    references: [users.id],
  }),
  participants: many(callParticipants),
  invitedUsers: many(callInvitedUsers),
}))

export const callParticipantsRelations = relations(
  callParticipants,
  ({ one }) => ({
    call: one(calls, {
      fields: [callParticipants.callId],
      references: [calls.id],
    }),
    user: one(users, {
      fields: [callParticipants.userId],
      references: [users.id],
    }),
  }),
)

export const callInvitedUsersRelations = relations(
  callInvitedUsers,
  ({ one }) => ({
    call: one(calls, {
      fields: [callInvitedUsers.callId],
      references: [calls.id],
    }),
    user: one(users, {
      fields: [callInvitedUsers.userId],
      references: [users.id],
    }),
  }),
)
