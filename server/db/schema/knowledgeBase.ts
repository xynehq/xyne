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

// Unified items table (knowledge bases, folders, and files)
export const kbItems = pgTable(
  "kb_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    parentId: uuid("parent_id"), // null for root knowledge bases
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => users.id),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"), // Used for knowledge base description
    type: varchar("type", { length: 20 })
      .notNull()
      .$type<"knowledge_base" | "folder" | "file">(),
    path: text("path").notNull(),
    position: integer("position").default(0).notNull(), // For ordering within parent
    totalCount: integer("total_count").default(0).notNull(), // Total items for folders/KBs
    isPrivate: boolean("is_private").default(true).notNull(), // Privacy control
    lastUpdatedByEmail: varchar("last_updated_by_email", { length: 255 }),
    lastUpdatedById: integer("last_updated_by_id")
      .references(() => users.id),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => ({
    // Ensure unique names at the same level (excluding soft-deleted items)
    uniqueParentName: uniqueIndex("unique_parent_name_not_deleted")
      .on(table.workspaceId, table.parentId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    // Index for finding root knowledge bases
    idxRootItems: index("idx_root_items").on(
      table.workspaceId,
      table.parentId,
      table.type
    ),
    // Index for finding items by parent
    idxItemsParent: index("idx_items_parent").on(
      table.parentId,
      table.position
    ),
    // Index for owner's knowledge bases
    idxOwnerKbs: index("idx_owner_kbs").on(
      table.ownerId,
      table.type,
      table.parentId
    ),
    // Index for path-based queries
    idxItemsPath: index("idx_items_path").on(table.workspaceId, table.path),
    // Index for soft deletes
    idxDeletedAt: index("idx_deleted_at").on(table.deletedAt),
    // Index for privacy filtering
    idxPrivacy: index("idx_privacy").on(table.isPrivate),
  })
);

// Self-referential foreign key for parent-child relationship
export const kbItemsRelations = {
  parent: {
    fields: [kbItems.parentId],
    references: [kbItems.id],
    onDelete: "cascade" as const,
  },
};

// File-specific information
export const kbFiles = pgTable(
  "kb_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    itemId: uuid("item_id")
      .notNull()
      .unique()
      .references(() => kbItems.id, { onDelete: "cascade" }),
    vespaDocId: varchar("vespa_doc_id", { length: 100 }).notNull(), // Reference to Vespa document
    originalName: varchar("original_name", { length: 255 }).notNull(),
    storagePath: text("storage_path").notNull(), // Path on disk
    storageKey: varchar("storage_key", { length: 100 }).notNull(), // Unique storage identifier
    mimeType: varchar("mime_type", { length: 100 }),
    fileSize: bigint("file_size", { mode: "number" }),
    checksum: varchar("checksum", { length: 64 }), // SHA256
    uploadedByEmail: varchar("uploaded_by_email", { length: 255 }),
    uploadedById: integer("uploaded_by_id")
      .references(() => users.id),
    lastUpdatedByEmail: varchar("last_updated_by_email", { length: 255 }),
    lastUpdatedById: integer("last_updated_by_id")
      .references(() => users.id),
    processingInfo: jsonb("processing_info").default({}).notNull(), // Processing details, errors, etc.
    processedAt: timestamp("processed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => ({
    idxKbFilesItem: index("idx_kb_files_item").on(table.itemId),
    idxKbFilesStorageKey: index("idx_kb_files_storage_key").on(
      table.storageKey
    ),
    idxKbFilesCreatedAt: index("idx_kb_files_created_at").on(table.createdAt),
  })
);

// Type definitions for use in the application
export type KbItem = typeof kbItems.$inferSelect;
export type NewKbItem = typeof kbItems.$inferInsert;
export type KbFile = typeof kbFiles.$inferSelect;
export type NewKbFile = typeof kbFiles.$inferInsert;

// Helper types
export type KnowledgeBase = KbItem & { type: "knowledge_base" };
export type Folder = KbItem & { type: "folder" };
export type File = KbItem & { type: "file" };
