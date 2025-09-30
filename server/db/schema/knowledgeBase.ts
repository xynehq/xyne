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
} from "drizzle-orm/pg-core"
import { relations, sql } from "drizzle-orm"
import { users } from "./users"
import { UploadStatus } from "@/shared/types"
import { workspaces } from "./workspaces"

// Collections table - stores collections within the knowledge base feature
export const collections = pgTable(
  "collections",
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
    vespaDocId: varchar("vespa_doc_id", { length: 100 }).notNull(), // For collection-level indexing
    isPrivate: boolean("is_private").default(true).notNull(),
    totalItems: integer("total_items").default(0).notNull(),
    lastUpdatedByEmail: varchar("last_updated_by_email", { length: 255 }),
    lastUpdatedById: integer("last_updated_by_id").references(() => users.id),
    uploadStatus: varchar("upload_status", { length: 20 }).default(UploadStatus.PENDING).notNull().$type<UploadStatus>(),
    statusMessage: text("status_message"), // Stores processing status and error messages
    retryCount: integer("retry_count").default(0).notNull(), // Track processing retry attempts
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
    via_apiKey: boolean("via_apiKey").notNull().default(false),
  },
  (table) => ({
    // Ensure unique names per owner (excluding soft-deleted items)
    uniqueOwnerName: uniqueIndex(
      "unique_owner_collection_name_not_deleted",
    )
      .on(table.ownerId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    // Index for finding collections by owner
    idxOwnerCollections: index("idx_owner_collections").on(table.ownerId),
    // Index for workspace collections
    idxWorkspaceCollections: index("idx_workspace_collections").on(
      table.workspaceId,
    ),
    // Index for soft deletes
    idxDeletedAt: index("idx_collection_deleted_at").on(table.deletedAt),
    // Index for privacy filtering
    idxPrivacy: index("idx_collection_privacy").on(table.isPrivate),
    // Index for vespa doc id
    idxVespaDocId: index("idx_collection_vespa_doc_id").on(table.vespaDocId),
  }),
)

// Collection Items table - stores folders and files within collections
export const collectionItems = pgTable(
  "collection_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"), // null for root items, references other collection_items for nested structure
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => users.id),
    name: varchar("name", { length: 255 }).notNull(),
    type: varchar("type", { length: 20 }).notNull().$type<"folder" | "file">(), // Only folder and file types
    path: text("path").notNull(),
    position: integer("position").default(0).notNull(),
    vespaDocId: varchar("vespa_doc_id", { length: 100 }), // For both folders and files
    totalFileCount: integer("total_file_count").default(0).notNull(),
    // File-specific fields (consolidated from separate files table)
    originalName: varchar("original_name", { length: 255 }),
    storagePath: text("storage_path"),
    storageKey: varchar("storage_key", { length: 100 }),
    mimeType: varchar("mime_type", { length: 100 }),
    fileSize: bigint("file_size", { mode: "number" }),
    checksum: varchar("checksum", { length: 64 }),

    uploadedByEmail: varchar("uploaded_by_email", { length: 255 }),
    uploadedById: integer("uploaded_by_id").references(() => users.id),
    lastUpdatedByEmail: varchar("last_updated_by_email", { length: 255 }),
    lastUpdatedById: integer("last_updated_by_id").references(() => users.id),

    processingInfo: jsonb("processing_info").default({}).notNull(),
    processedAt: timestamp("processed_at"),
    uploadStatus: varchar("upload_status", { length: 20 }).default(UploadStatus.PENDING).notNull().$type<UploadStatus>(),
    statusMessage: text("status_message"), // Stores error messages, processing details, or success info
    retryCount: integer("retry_count").default(0).notNull(), // Track processing retry attempts
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => ({
    // Ensure unique names at the same level within a collection (excluding soft-deleted items)
    uniqueCollectionParentName: uniqueIndex(
      "unique_collection_parent_name_not_deleted",
    )
      .on(table.collectionId, table.parentId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    // Index for finding items by collection
    idxItemsCollection: index("idx_items_collection").on(table.collectionId),
    // Index for finding items by parent
    idxItemsParent: index("idx_items_parent").on(
      table.parentId,
      table.position,
    ),
    // Index for finding items by type within collection
    idxItemsCollectionType: index("idx_items_collection_type").on(
      table.collectionId,
      table.type,
    ),
    // Index for path-based queries
    idxItemsPath: index("idx_items_path").on(table.collectionId, table.path),
    // Index for soft deletes
    idxItemsDeletedAt: index("idx_items_deleted_at").on(table.deletedAt),
    // Index for vespa doc id
    idxItemsVespaDocId: index("idx_items_vespa_doc_id").on(table.vespaDocId),
    // Index for storage key (for files)
    idxItemsStorageKey: index("idx_items_storage_key").on(table.storageKey),
  }),
)

// Relations definitions using Drizzle ORM relations() function
export const collectionsRelations = relations(collections, ({ many, one }) => ({
  items: many(collectionItems),
  owner: one(users, {
    fields: [collections.ownerId],
    references: [users.id],
  }),
  workspace: one(workspaces, {
    fields: [collections.workspaceId],
    references: [workspaces.id],
  }),
  lastUpdatedBy: one(users, {
    fields: [collections.lastUpdatedById],
    references: [users.id],
  }),
}))

export const collectionItemsRelations = relations(
  collectionItems,
  ({ one, many }) => ({
    collection: one(collections, {
      fields: [collectionItems.collectionId],
      references: [collections.id],
    }),
    parent: one(collectionItems, {
      fields: [collectionItems.parentId],
      references: [collectionItems.id],
      relationName: "parent_child",
    }),
    children: many(collectionItems, {
      relationName: "parent_child",
    }),
    owner: one(users, {
      fields: [collectionItems.ownerId],
      references: [users.id],
    }),
    workspace: one(workspaces, {
      fields: [collectionItems.workspaceId],
      references: [workspaces.id],
    }),
    uploadedBy: one(users, {
      fields: [collectionItems.uploadedById],
      references: [users.id],
    }),
    lastUpdatedBy: one(users, {
      fields: [collectionItems.lastUpdatedById],
      references: [users.id],
    }),
  }),
)

// Type definitions for use in the application
export type Collection = typeof collections.$inferSelect
export type NewCollection = typeof collections.$inferInsert
export type CollectionItem = typeof collectionItems.$inferSelect
export type NewCollectionItem = typeof collectionItems.$inferInsert

// Helper types
export type Folder = CollectionItem & { type: "folder" }
export type File = CollectionItem & { type: "file" }
