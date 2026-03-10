import { describe, expect, test } from "bun:test"
import type { CollectionItem, NewCollectionItem } from "../db/schema"

process.env.ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

const DRIZZLE_TABLE_NAME = Symbol.for("drizzle:Name")

function getTableName(table: unknown): string | undefined {
  if (!table || typeof table !== "object") {
    return undefined
  }

  return (table as Record<symbol, string | undefined>)[DRIZZLE_TABLE_NAME]
}

async function loadUpdateCollectionItem() {
  const module = await import(
    `../db/knowledgeBase.ts?knowledgeBaseDbTest=${Date.now()}-${Math.random()}`
  )
  return module.updateCollectionItem
}

const createItem = (overrides: Partial<CollectionItem> = {}): CollectionItem => ({
  id: "item-1",
  collectionId: "collection-alpha",
  parentId: null,
  workspaceId: 1,
  ownerId: 1,
  name: "README.md",
  type: "file",
  path: "/",
  position: 0,
  vespaDocId: "clf-item-1",
  totalFileCount: 0,
  originalName: "README.md",
  storagePath: "/tmp/readme.md",
  storageKey: "storage-key",
  mimeType: "text/markdown",
  fileSize: 128,
  checksum: null,
  uploadedByEmail: "owner@example.com",
  uploadedById: 1,
  lastUpdatedByEmail: "owner@example.com",
  lastUpdatedById: 1,
  processingInfo: {},
  processedAt: null,
  uploadStatus: "completed" as any,
  statusMessage: null,
  retryCount: 0,
  metadata: {},
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
  updatedAt: new Date("2025-01-02T00:00:00.000Z"),
  deletedAt: null,
  ...overrides,
})

function createMockTrx(
  existingItem: CollectionItem,
  updateOverrides: Partial<CollectionItem> = {},
) {
  const updateCalls: Array<{
    tableName?: string
    values?: Record<string, unknown>
  }> = []

  const trx = {
    select() {
      return {
        from() {
          return {
            where: async () => [existingItem],
          }
        },
      }
    },
    update(table: unknown) {
      const call: { tableName?: string; values?: Record<string, unknown> } = {
        tableName: getTableName(table),
      }
      updateCalls.push(call)

      return {
        set(values: Record<string, unknown>) {
          call.values = values
          return {
            where() {
              if (call.tableName === "collection_items") {
                return {
                  returning: async () => [
                    {
                      ...existingItem,
                      ...updateOverrides,
                      ...values,
                    },
                  ],
                }
              }

              return Promise.resolve([])
            },
          }
        },
      }
    },
  }

  return { trx: trx as any, updateCalls }
}

describe("updateCollectionItem", () => {
  test("touches the collection ls watermark when structure fields change", async () => {
    const existingItem = createItem()
    const { trx, updateCalls } = createMockTrx(existingItem, {
      name: "Guide.md",
    })
    const updateCollectionItem = await loadUpdateCollectionItem()

    const result = await updateCollectionItem(trx, existingItem.id, {
      name: "Guide.md",
    } satisfies Partial<NewCollectionItem>)

    expect(result.name).toBe("Guide.md")

    const collectionTouchCalls = updateCalls.filter(
      (call) => call.tableName === "collections",
    )
    expect(collectionTouchCalls).toHaveLength(1)
    expect(collectionTouchCalls[0]?.values).toHaveProperty(
      "collectionSourceUpdatedAt",
    )
    expect(collectionTouchCalls[0]?.values).toHaveProperty("updatedAt")
  })

  test("does not touch the collection ls watermark for non-structural updates", async () => {
    const existingItem = createItem()
    const { trx, updateCalls } = createMockTrx(existingItem, {
      statusMessage: "Queued",
    })
    const updateCollectionItem = await loadUpdateCollectionItem()

    const result = await updateCollectionItem(trx, existingItem.id, {
      statusMessage: "Queued",
    } satisfies Partial<NewCollectionItem>)

    expect(result.statusMessage).toBe("Queued")
    expect(
      updateCalls.filter((call) => call.tableName === "collections"),
    ).toHaveLength(0)
  })

  test("touches collection ls watermarks when an item moves to another collection", async () => {
    const existingItem = createItem()
    const { trx, updateCalls } = createMockTrx(existingItem, {
      collectionId: "collection-beta",
    })
    const updateCollectionItem = await loadUpdateCollectionItem()

    const result = await updateCollectionItem(trx, existingItem.id, {
      collectionId: "collection-beta",
    } satisfies Partial<NewCollectionItem>)

    expect(result.collectionId).toBe("collection-beta")

    const collectionTouchCalls = updateCalls.filter(
      (call) => call.tableName === "collections",
    )
    expect(collectionTouchCalls).toHaveLength(1)
    expect(collectionTouchCalls[0]?.values).toHaveProperty(
      "collectionSourceUpdatedAt",
    )
  })
})
