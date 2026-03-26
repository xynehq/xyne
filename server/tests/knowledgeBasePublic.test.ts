import { describe, expect, test } from "bun:test"
import type { Collection, CollectionItem } from "@/db/schema"
import {
  serializePublicCollection,
  serializePublicCollectionItem,
  serializePublicCollectionWithItems,
} from "@/api/knowledgeBase/public"

const createCollection = (overrides: Partial<Collection> = {}): Collection => ({
  id: "collection-1",
  workspaceId: 1,
  ownerId: 1,
  name: "Policies",
  description: null,
  vespaDocId: "cl-1",
  isPrivate: true,
  totalItems: 1,
  lastUpdatedByEmail: "owner@example.com",
  lastUpdatedById: 1,
  uploadStatus: "completed" as any,
  statusMessage: null,
  retryCount: 0,
  metadata: {},
  permissions: [],
  collectionSourceUpdatedAt: new Date("2025-01-02T00:00:00.000Z"),
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
  updatedAt: new Date("2025-01-02T00:00:00.000Z"),
  deletedAt: null,
  via_apiKey: false,
  ...overrides,
})

const createItem = (overrides: Partial<CollectionItem> = {}): CollectionItem => ({
  id: "file-1",
  collectionId: "collection-1",
  parentId: null,
  workspaceId: 1,
  ownerId: 1,
  name: "Security.pdf",
  type: "file",
  path: "/",
  position: 0,
  vespaDocId: "clf-1",
  totalFileCount: 0,
  originalName: "Security.pdf",
  storagePath: "/tmp/Security.pdf",
  storageKey: "key-1",
  mimeType: "application/pdf",
  fileSize: 1024,
  checksum: null,
  uploadedByEmail: "owner@example.com",
  uploadedById: 1,
  lastUpdatedByEmail: "owner@example.com",
  lastUpdatedById: 1,
  processingInfo: {},
  processedAt: new Date("2025-01-02T00:00:00.000Z"),
  uploadStatus: "completed" as any,
  statusMessage: null,
  retryCount: 0,
  metadata: { source: "upload" },
  toc: [{ title: "Overview", level: 1, page_number: 1 }],
  tocInfo: {
    status: "completed",
    attempts: 1,
    lastError: null,
  },
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
  updatedAt: new Date("2025-01-02T00:00:00.000Z"),
  deletedAt: null,
  ...overrides,
})

describe("knowledgeBase public serializers", () => {
  test("preserves collection fields exactly as-is", () => {
    const collection = createCollection({ description: "Security docs" })
    expect(serializePublicCollection(collection)).toEqual(collection)
  })

  test("omits toc fields from collection items", () => {
    const item = createItem()
    expect(serializePublicCollectionItem(item)).toEqual({
      id: item.id,
      collectionId: item.collectionId,
      parentId: item.parentId,
      workspaceId: item.workspaceId,
      ownerId: item.ownerId,
      name: item.name,
      type: item.type,
      path: item.path,
      position: item.position,
      vespaDocId: item.vespaDocId,
      totalFileCount: item.totalFileCount,
      originalName: item.originalName,
      storagePath: item.storagePath,
      storageKey: item.storageKey,
      mimeType: item.mimeType,
      fileSize: item.fileSize,
      checksum: item.checksum,
      uploadedByEmail: item.uploadedByEmail,
      uploadedById: item.uploadedById,
      lastUpdatedByEmail: item.lastUpdatedByEmail,
      lastUpdatedById: item.lastUpdatedById,
      processingInfo: item.processingInfo,
      processedAt: item.processedAt,
      uploadStatus: item.uploadStatus,
      statusMessage: item.statusMessage,
      retryCount: item.retryCount,
      metadata: item.metadata,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      deletedAt: item.deletedAt,
    })
  })

  test("omits toc fields from nested collection item payloads", () => {
    const collection = createCollection()
    const item = createItem()
    expect(
      serializePublicCollectionWithItems({
        ...collection,
        items: [item],
      }),
    ).toEqual({
      ...collection,
      items: [serializePublicCollectionItem(item)],
    })
  })
})
