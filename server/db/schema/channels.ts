import { sql, relations } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  boolean,
  index,
  jsonb,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { users } from "./users"
import { workspaces } from "./workspaces"
import { lexicalEditorStateSchema } from "./directMessages"
import { ChannelType, ChannelMemberRole } from "@/shared/types"

export const channelTypeEnum = pgEnum(
  "channel_type",
  Object.values(ChannelType) as [string, ...string[]],
)

export const channelMemberRoleEnum = pgEnum(
  "channel_member_role",
  Object.values(ChannelMemberRole) as [string, ...string[]],
)

// Channels Table - for group messaging
export const channels = pgTable(
  "channels",
  {
    id: serial("id").notNull().primaryKey(),
    channelExternalId: text("channel_external_id").unique().notNull(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // e.g., "general", "random", "project-x"
    description: text("description"), // Optional channel description
    purpose: text("purpose"), // Optional channel purpose/topic
    type: channelTypeEnum("type").notNull().default(ChannelType.Public),
    isArchived: boolean("is_archived").notNull().default(false),
    createdByUserId: integer("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    channelExternalIdIdx: index("channels_channel_external_id_idx").on(
      table.channelExternalId,
    ),
    workspaceIdIdx: index("channels_workspace_id_idx").on(table.workspaceId),
    typeIdx: index("channels_type_idx").on(table.type),
    isArchivedIdx: index("channels_is_archived_idx").on(table.isArchived),
    // Unique constraint: channel name must be unique within a workspace
    workspaceNameUnique: uniqueIndex("channels_workspace_name_unique").on(
      table.workspaceId,
      sql`LOWER(${table.name})`,
    ),
  }),
)

// Channel Members Table - who belongs to which channel
export const channelMembers = pgTable(
  "channel_members",
  {
    id: serial("id").notNull().primaryKey(),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: channelMemberRoleEnum("role")
      .notNull()
      .default(ChannelMemberRole.Member),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }), // For unread message tracking
  },
  (table) => ({
    channelIdIdx: index("channel_members_channel_id_idx").on(table.channelId),
    userIdIdx: index("channel_members_user_id_idx").on(table.userId),
    // Unique constraint: a user can only be in a channel once
    channelUserUnique: uniqueIndex("channel_members_channel_user_unique").on(
      table.channelId,
      table.userId,
    ),
  }),
)

// Channel Messages Table - messages sent to channels
export const channelMessages = pgTable(
  "channel_messages",
  {
    id: serial("id").notNull().primaryKey(),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    sentByUserId: integer("sent_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageContent: jsonb("message_content")
      .notNull()
      .$type<z.infer<typeof lexicalEditorStateSchema>>(),
    isEdited: boolean("is_edited").notNull().default(false),
    isPinned: boolean("is_pinned").notNull().default(false),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    pinnedByUserId: integer("pinned_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    channelIdIdx: index("channel_messages_channel_id_idx").on(table.channelId),
    sentByUserIdIdx: index("channel_messages_sent_by_user_id_idx").on(
      table.sentByUserId,
    ),
    createdAtIdx: index("channel_messages_created_at_idx").on(table.createdAt),
    isPinnedIdx: index("channel_messages_is_pinned_idx").on(table.isPinned),
  }),
)

// Zod schemas for channels
export const insertChannelSchema = createInsertSchema(channels, {
  name: z
    .string()
    .min(1, "Channel name is required")
    .max(80, "Channel name must be less than 80 characters")
    .regex(
      /^[a-z0-9-_]+$/,
      "Channel name can only contain lowercase letters, numbers, hyphens, and underscores",
    ),
  description: z.string().max(250).optional(),
  purpose: z.string().max(250).optional(),
}).omit({
  id: true,
  channelExternalId: true,
  createdAt: true,
  updatedAt: true,
  isArchived: true,
  archivedAt: true,
})

export const selectChannelSchema = createSelectSchema(channels)

export type InsertChannel = z.infer<typeof insertChannelSchema>
export type SelectChannel = z.infer<typeof selectChannelSchema>

// Zod schemas for channel members
export const insertChannelMemberSchema = createInsertSchema(channelMembers, {
  role: z.nativeEnum(ChannelMemberRole).optional(),
}).omit({
  id: true,
  joinedAt: true,
})

export const selectChannelMemberSchema = createSelectSchema(channelMembers)

export type InsertChannelMember = z.infer<typeof insertChannelMemberSchema>
export type SelectChannelMember = z.infer<typeof selectChannelMemberSchema>

// Zod schemas for channel messages
export const insertChannelMessageSchema = createInsertSchema(channelMessages, {
  messageContent: lexicalEditorStateSchema,
}).omit({
  id: true,
  isEdited: true,
  isPinned: true,
  pinnedAt: true,
  pinnedByUserId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
})

export const selectChannelMessageSchema = createSelectSchema(channelMessages, {
  messageContent: lexicalEditorStateSchema,
})

export type InsertChannelMessage = z.infer<typeof insertChannelMessageSchema>
export type SelectChannelMessage = z.infer<typeof selectChannelMessageSchema>

// Relations
export const channelsRelations = relations(channels, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [channels.workspaceId],
    references: [workspaces.id],
    relationName: "workspace_channels",
  }),
  createdBy: one(users, {
    fields: [channels.createdByUserId],
    references: [users.id],
    relationName: "created_channels",
  }),
  members: many(channelMembers, {
    relationName: "channel_members_list",
  }),
  messages: many(channelMessages, {
    relationName: "channel_messages_list",
  }),
}))

export const channelMembersRelations = relations(channelMembers, ({ one }) => ({
  channel: one(channels, {
    fields: [channelMembers.channelId],
    references: [channels.id],
    relationName: "channel_members_list",
  }),
  user: one(users, {
    fields: [channelMembers.userId],
    references: [users.id],
    relationName: "user_channel_memberships",
  }),
}))

export const channelMessagesRelations = relations(
  channelMessages,
  ({ one }) => ({
    channel: one(channels, {
      fields: [channelMessages.channelId],
      references: [channels.id],
      relationName: "channel_messages_list",
    }),
    sentBy: one(users, {
      fields: [channelMessages.sentByUserId],
      references: [users.id],
      relationName: "sent_channel_messages",
    }),
    pinnedBy: one(users, {
      fields: [channelMessages.pinnedByUserId],
      references: [users.id],
      relationName: "pinned_channel_messages",
    }),
  }),
)
