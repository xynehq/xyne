// Persistence for the "Projects" feature — folders that group v2 chat
// conversations. Soft-deleted only (is_deleted=true); rows are never removed,
// so links from audit trails stay resolvable.
//
// Shape decisions:
//   • Id prefix folder_<uuid> matches the v2 conv_/turn_/run_/msg_ pattern.
//   • Timestamps are bigint(ms) — same as v2_chat_*.
//   • Soft delete via is_deleted boolean (not archived_at). On delete we flip
//     is_deleted=true and null out v2_chat_conversations.folder_id in the
//     same transaction.

import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
} from "drizzle-orm/pg-core"

export const v2ChatFolders = pgTable(
  "v2_chat_folders",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    isDeleted: boolean("is_deleted").notNull().default(false),
  },
  (table) => ({
    ownerCreatedIndex: index("v2_chat_folder_owner_created_index").on(
      table.ownerId,
      table.createdAt,
    ),
    ownerUpdatedIndex: index("v2_chat_folder_owner_updated_index").on(
      table.ownerId,
      table.updatedAt,
    ),
  }),
)
