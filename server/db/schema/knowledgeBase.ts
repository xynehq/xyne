import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  integer,
  bigint,
  index,
  uniqueIndex,
  boolean,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";
import { workspaces } from "./workspaces";

// Knowledge Base Collections table - only stores KB containers
export const kbCollection = pgTable(
  "kb_collection",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => users.id),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    vespaDocId: varchar("vespa_doc_id", { length: 100 }).notNull(), // For KB-level indexing
    isPrivate: boolean("is_private").default(true).notNull(),
    totalItems: integer("total_items").default(0).notNull(),
    lastUpdatedByEmail: varchar("last_updated_by_email", { length: 255 }),
    lastUpdatedById: integer("last_updated_by_id")
      .references(() => users.id),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => ({
    // Ensure unique names per workspace (excluding soft-deleted items)
    uniqueWorkspaceName: uniqueIndex("unique_workspace_kb_name_not_deleted")
      .on(table.workspaceId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    // Index for finding KBs by owner
    idxOwnerKbs: index("idx_owner_kbs").on(table.ownerId),
    // Index for workspace KBs
    idxWorkspaceKbs: index("idx_workspace_kbs").on(table.workspaceId),
    // Index for soft deletes
    idxDeletedAt: index("idx_kb_deleted_at").on(table.deletedAt),
    // Index for privacy filtering
    idxPrivacy: index("idx_kb_privacy").on(table.isPrivate),
    // Index for vespa doc id
    idxVespaDocId: index("idx_kb_vespa_doc_id").on(table.vespaDocId),
  })
);

// KB Items table - stores folders and files only
export const kbItems = pgTable(
  "kb_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kbId: uuid("kb_id")
      .notNull()
      .references(() => kbCollection.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"), // null for root items, references other kb_items for nested structure
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => users.id),
    name: varchar("name", { length: 255 }).notNull(),
    type: varchar("type", { length: 20 })
      .notNull()
      .$type<"folder" | "file">(), // Only folder and file types
    path: text("path").notNull(),
    position: integer("position").default(0).notNull(),
    vespaDocId: varchar("vespa_doc_id", { length: 100 }), // For both folders and files
    totalFileCount: integer("total_file_count").default(0).notNull(),
    // File-specific fields (consolidated from kb_files)
    originalName: varchar("original_name", { length: 255 }),
    storagePath: text("storage_path"),
    storageKey: varchar("storage_key", { length: 100 }),
    mimeType: varchar("mime_type", { length: 100 }),
    fileSize: bigint("file_size", { mode: "number" }),
    checksum: varchar("checksum", { length: 64 }),

    uploadedByEmail: varchar("uploaded_by_email", { length: 255 }),
    uploadedById: integer("uploaded_by_id")
      .references(() => users.id),
    lastUpdatedByEmail: varchar("last_updated_by_email", { length: 255 }),
    lastUpdatedById: integer("last_updated_by_id")
      .references(() => users.id),

    processingInfo: jsonb("processing_info").default({}).notNull(),
    processedAt: timestamp("processed_at"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => ({
    // Ensure unique names at the same level within a KB (excluding soft-deleted items)
    uniqueKbParentName: uniqueIndex("unique_kb_parent_name_not_deleted")
      .on(table.kbId, table.parentId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    // Index for finding items by KB
    idxItemsKb: index("idx_items_kb").on(table.kbId),
    // Index for finding items by parent
    idxItemsParent: index("idx_items_parent").on(
      table.parentId,
      table.position
    ),
    // Index for finding items by type within KB
    idxItemsKbType: index("idx_items_kb_type").on(table.kbId, table.type),
    // Index for path-based queries
    idxItemsPath: index("idx_items_path").on(table.kbId, table.path),
    // Index for soft deletes
    idxItemsDeletedAt: index("idx_items_deleted_at").on(table.deletedAt),
    // Index for vespa doc id
    idxItemsVespaDocId: index("idx_items_vespa_doc_id").on(table.vespaDocId),
    // Index for storage key (for files)
    idxItemsStorageKey: index("idx_items_storage_key").on(table.storageKey),
  })
);

// Self-referential foreign key for parent-child relationship
export const kbItemsRelations = {
  parent: {
    fields: [kbItems.parentId],
    references: [kbItems.id],
    onDelete: "cascade" as const,
  },
  kbCollection: {
    fields: [kbItems.kbId],
    references: [kbCollection.id],
    onDelete: "cascade" as const,
  },
};

// Type definitions for use in the application
export type KbCollection = typeof kbCollection.$inferSelect;
export type NewKbCollection = typeof kbCollection.$inferInsert;
export type KbItem = typeof kbItems.$inferSelect;
export type NewKbItem = typeof kbItems.$inferInsert;

// Helper types
export type Folder = KbItem & { type: "folder" };
export type File = KbItem & { type: "file" };

// Legacy type alias for backwards compatibility during transition
export type KnowledgeBase = KbCollection;
export type NewKnowledgeBase = NewKbCollection;
export type KbFile = KbItem & { type: "file" };
export type NewKbFile = Omit<NewKbItem, "type"> & { type?: "file" };
