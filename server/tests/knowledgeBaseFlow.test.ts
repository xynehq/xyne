import { describe, expect, mock, test } from "bun:test"
import { Apps, KnowledgeBaseEntity } from "@xyne/vespa-ts/types"
import type {
  Collection,
  CollectionItem,
  CollectionLsProjection,
} from "@/db/schema"
import type { MinimalAgentFragment } from "@/api/chat/types"

process.env.ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

const {
  __knowledgeBaseFlowInternals,
  canonicalizeKnowledgeBasePath,
  executeLsKnowledgeBase,
  executeSearchKnowledgeBase,
} = await import("@/api/chat/tools/knowledgeBaseFlow")
const { mergeCollectionItemMetadata } = await import("@/queue/fileProcessor")

const createCollection = (overrides: Partial<Collection>): Collection => ({
  id: "collection-default",
  workspaceId: 1,
  ownerId: 1,
  name: "Default Collection",
  description: null,
  vespaDocId: "cl-default",
  isPrivate: true,
  totalItems: 0,
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

const createItem = (overrides: Partial<CollectionItem>): CollectionItem => ({
  id: "item-default",
  collectionId: "collection-default",
  parentId: null,
  workspaceId: 1,
  ownerId: 1,
  name: "default",
  type: "folder",
  path: "/",
  position: 0,
  vespaDocId: "clfd-default",
  totalFileCount: 0,
  originalName: null,
  storagePath: null,
  storageKey: null,
  mimeType: null,
  fileSize: null,
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

const collectionAlpha = createCollection({
  id: "collection-alpha",
  name: "Alpha",
  description: "Alpha docs",
  totalItems: 4,
  metadata: { team: "platform" },
})

const collectionBeta = createCollection({
  id: "collection-beta",
  name: "Beta",
  description: "Beta docs",
  totalItems: 1,
  metadata: { team: "sales" },
})

const projectsFolder = createItem({
  id: "folder-projects",
  collectionId: collectionAlpha.id,
  name: "Projects",
  type: "folder",
  path: "/",
  position: 0,
  totalFileCount: 2,
  metadata: { section: "root" },
})

const apiFolder = createItem({
  id: "folder-api",
  collectionId: collectionAlpha.id,
  parentId: projectsFolder.id,
  name: "API",
  type: "folder",
  path: "/Projects/",
  position: 0,
  totalFileCount: 1,
  metadata: { section: "nested" },
})

const specFile = createItem({
  id: "file-spec",
  collectionId: collectionAlpha.id,
  parentId: apiFolder.id,
  name: "spec.md",
  type: "file",
  path: "/Projects/API/",
  position: 0,
  vespaDocId: "clf-spec",
  originalName: "spec.md",
  mimeType: "text/markdown",
  metadata: { language: "md" },
})

const readmeFile = createItem({
  id: "file-readme",
  collectionId: collectionAlpha.id,
  name: "README.txt",
  type: "file",
  path: "/",
  position: 1,
  vespaDocId: "clf-readme",
  originalName: "README.txt",
  mimeType: "text/plain",
  metadata: { language: "txt" },
})

const betaFile = createItem({
  id: "file-beta",
  collectionId: collectionBeta.id,
  name: "beta.txt",
  type: "file",
  path: "/",
  position: 0,
  vespaDocId: "clf-beta",
  originalName: "beta.txt",
  mimeType: "text/plain",
})

type LsKnowledgeBaseToolParams = Parameters<typeof executeLsKnowledgeBase>[0]
type SearchKnowledgeBaseOptions = NonNullable<
  Parameters<typeof executeSearchKnowledgeBase>[2]
>
type SearchExecutor = NonNullable<SearchKnowledgeBaseOptions["searchExecutor"]>

function cloneMetadata(
  metadata: unknown,
): Record<string, unknown> | null | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined
  }
  return { ...(metadata as Record<string, unknown>) }
}

function withLsDefaults(
  params: Partial<LsKnowledgeBaseToolParams>,
): LsKnowledgeBaseToolParams {
  return {
    depth: 1,
    offset: 0,
    metadata: false,
    ...params,
  }
}

function buildFixtures() {
  const collections = [
    {
      ...collectionAlpha,
      metadata: cloneMetadata(collectionAlpha.metadata),
    },
    {
      ...collectionBeta,
      metadata: cloneMetadata(collectionBeta.metadata),
    },
  ]
  const items = [
    { ...projectsFolder, metadata: cloneMetadata(projectsFolder.metadata) },
    { ...apiFolder, metadata: cloneMetadata(apiFolder.metadata) },
    { ...specFile, metadata: cloneMetadata(specFile.metadata) },
    { ...readmeFile, metadata: cloneMetadata(readmeFile.metadata) },
    { ...betaFile, metadata: cloneMetadata(betaFile.metadata) },
  ]

  return { collections, items }
}

function createEmptyProjectionRow(
  collectionId: string,
  lsCollectionProjectionUpdatedAt = new Date(0),
): CollectionLsProjection {
  return {
    collectionId,
    projection: {
      rootIds: [],
      childrenByParentId: {},
      nodesById: {},
      nodeIdByPath: {},
    },
    lsCollectionProjectionUpdatedAt,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    lastError: null,
  }
}

function createRepo(options?: {
  initialProjections?: Record<string, CollectionLsProjection | undefined>
  failProjectionUpsert?: boolean
}) {
  const { collections, items } = buildFixtures()
  const counters = {
    listCollectionItems: 0,
    listCollectionItemsByIds: 0,
    getCollectionLsProjection: 0,
    upsertCollectionLsProjection: 0,
    recordCollectionLsProjectionError: 0,
  }
  const projectionRows = new Map<string, CollectionLsProjection>()
  Object.entries(options?.initialProjections ?? {}).forEach(
    ([collectionId, row]) => {
      if (row) projectionRows.set(collectionId, row)
    },
  )

  const repo = {
    counters,
    collections,
    items,
    projectionRows,
    async getUserByEmail() {
      return { id: 1 }
    },
    async listUserScopedCollections() {
      return collections
    },
    async getCollectionById(collectionId: string) {
      return (
        collections.find((collection) => collection.id === collectionId) ?? null
      )
    },
    async getCollectionItemById(itemId: string) {
      return items.find((item) => item.id === itemId) ?? null
    },
    async listCollectionItems(collectionId: string) {
      counters.listCollectionItems += 1
      return items.filter((item) => item.collectionId === collectionId)
    },
    async listCollectionItemsByIds(collectionId: string, itemIds: string[]) {
      counters.listCollectionItemsByIds += 1
      return items.filter(
        (item) =>
          item.collectionId === collectionId && itemIds.includes(item.id),
      )
    },
    async getCollectionLsProjection(collectionId: string) {
      counters.getCollectionLsProjection += 1
      return projectionRows.get(collectionId) ?? null
    },
    async upsertCollectionLsProjection(params: any) {
      counters.upsertCollectionLsProjection += 1
      if (options?.failProjectionUpsert) {
        throw new Error("projection upsert failed")
      }
      const row: CollectionLsProjection = {
        collectionId: params.collectionId,
        projection: params.projection,
        lsCollectionProjectionUpdatedAt: params.lsCollectionProjectionUpdatedAt,
        createdAt:
          projectionRows.get(params.collectionId)?.createdAt ??
          new Date("2025-01-01T00:00:00.000Z"),
        updatedAt: new Date("2025-01-03T00:00:00.000Z"),
        lastError: params.lastError ?? null,
      }
      projectionRows.set(params.collectionId, row)
      return row
    },
    async recordCollectionLsProjectionError(
      collectionId: string,
      lastError: string,
    ) {
      counters.recordCollectionLsProjectionError += 1
      const existing =
        projectionRows.get(collectionId) ??
        createEmptyProjectionRow(collectionId)
      projectionRows.set(collectionId, {
        ...existing,
        lastError,
        updatedAt: new Date("2025-01-04T00:00:00.000Z"),
      })
    },
  }

  return repo
}

function createAgentPrompt(itemIds: string[]) {
  return JSON.stringify({
    appIntegrations: {
      knowledge_base: {
        selectedAll: false,
        itemIds,
      },
    },
  })
}

function createContext(itemIds: string[]) {
  return {
    user: {
      email: "tester@example.com",
      numericId: 7,
      workspaceNumericId: 9,
    },
    agentPrompt: createAgentPrompt(itemIds),
  } as any
}

describe("canonicalizeKnowledgeBasePath", () => {
  test("normalizes root, repeated separators, trailing separators, and preserves case", () => {
    expect(canonicalizeKnowledgeBasePath("")).toBe("/")
    expect(canonicalizeKnowledgeBasePath("////")).toBe("/")
    expect(canonicalizeKnowledgeBasePath("Projects//API/Specs/")).toBe(
      "/Projects/API/Specs",
    )
    expect(canonicalizeKnowledgeBasePath("/TeamA/API")).toBe("/TeamA/API")
  })

  test("rejects dot segments", () => {
    expect(() => canonicalizeKnowledgeBasePath("/Projects/./API")).toThrow()
    expect(() => canonicalizeKnowledgeBasePath("/Projects/../API")).toThrow()
  })
})

describe("knowledge base target resolution", () => {
  test("resolves collection, folder, file, path, and root path targets", async () => {
    const repo = createRepo()
    const cache = { direct: new Map(), projection: new Map() }

    const collectionTarget =
      await __knowledgeBaseFlowInternals.resolveKnowledgeBaseTarget(
        { type: "collection", collectionId: collectionAlpha.id },
        repo,
        cache,
      )
    expect(collectionTarget.kind).toBe("collection")
    expect(collectionTarget.collection.id).toBe(collectionAlpha.id)
    expect(collectionTarget.path).toBe("/")

    const folderTarget =
      await __knowledgeBaseFlowInternals.resolveKnowledgeBaseTarget(
        { type: "folder", folderId: projectsFolder.id },
        repo,
        cache,
      )
    expect(folderTarget.kind).toBe("node")
    if (folderTarget.kind !== "node") {
      throw new Error("Expected folder target to resolve to a node")
    }
    expect(folderTarget.node.id).toBe(projectsFolder.id)
    expect(folderTarget.path).toBe("/Projects")

    const fileTarget =
      await __knowledgeBaseFlowInternals.resolveKnowledgeBaseTarget(
        { type: "file", fileId: specFile.id },
        repo,
        cache,
      )
    expect(fileTarget.kind).toBe("node")
    if (fileTarget.kind !== "node") {
      throw new Error("Expected file target to resolve to a node")
    }
    expect(fileTarget.node.id).toBe(specFile.id)
    expect(fileTarget.path).toBe("/Projects/API/spec.md")

    const pathTarget =
      await __knowledgeBaseFlowInternals.resolveKnowledgeBaseTarget(
        {
          type: "path",
          collectionId: collectionAlpha.id,
          path: "//Projects//API/",
        },
        repo,
        cache,
      )
    expect(pathTarget.kind).toBe("node")
    if (pathTarget.kind !== "node") {
      throw new Error("Expected path target to resolve to a node")
    }
    expect(pathTarget.node.id).toBe(apiFolder.id)
    expect(pathTarget.path).toBe("/Projects/API")

    const rootPathTarget =
      await __knowledgeBaseFlowInternals.resolveKnowledgeBaseTarget(
        {
          type: "path",
          collectionId: collectionAlpha.id,
          path: "/",
        },
        repo,
        cache,
      )
    expect(rootPathTarget.kind).toBe("collection")
    expect(rootPathTarget.collection.id).toBe(collectionAlpha.id)
    expect(rootPathTarget.path).toBe("/")
  })
})

describe("lsKnowledgeBase", () => {
  test("lists accessible collections without scanning collection trees", async () => {
    const repo = createRepo()
    const result = await executeLsKnowledgeBase(
      withLsDefaults({
        metadata: true,
      }),
      createContext([`cl-${collectionAlpha.id}`, `cl-${collectionBeta.id}`]),
      repo,
    )

    expect(result.status).toBe("success")
    expect(repo.counters.listCollectionItems).toBe(0)
    expect(
      (result as any).data.entries.map((entry: any) => entry.name),
    ).toEqual(["Alpha", "Beta"])
    expect((result as any).data.entries[0].details).toEqual({
      total_items: 4,
      name: "Alpha",
      last_updated_by_email: "owner@example.com",
      description: "Alpha docs",
      updated_at: collectionAlpha.updatedAt,
      created_at: collectionAlpha.createdAt,
      metadata: { team: "platform" },
    })
  })

  test("lists collection contents with depth, pagination, and metadata", async () => {
    const repo = createRepo()
    const result = await executeLsKnowledgeBase(
      withLsDefaults({
        target: { type: "collection", collectionId: collectionAlpha.id },
        depth: 2,
        limit: 2,
        offset: 1,
        metadata: true,
      }),
      createContext([`cl-${collectionAlpha.id}`]),
      repo,
    )

    expect(result.status).toBe("success")
    expect(repo.counters.listCollectionItems).toBe(1)
    expect(repo.counters.upsertCollectionLsProjection).toBe(1)
    expect((result as any).data.total).toBe(3)
    expect((result as any).data.entries.map((entry: any) => entry.id)).toEqual([
      apiFolder.id,
      readmeFile.id,
    ])
    expect((result as any).data.entries[0].details.total_file_count).toBe(1)
    expect((result as any).data.entries[1].details.mime_type).toBe("text/plain")
  })

  test("lists folder, file, and path targets correctly", async () => {
    const repo = createRepo()

    const folderResult = await executeLsKnowledgeBase(
      withLsDefaults({
        target: { type: "folder", folderId: projectsFolder.id },
        depth: 2,
      }),
      createContext([`cl-${collectionAlpha.id}`]),
      repo,
    )
    expect(folderResult.status).toBe("success")
    expect(
      (folderResult as any).data.entries.map((entry: any) => entry.id),
    ).toEqual([apiFolder.id, specFile.id])

    const fileResult = await executeLsKnowledgeBase(
      withLsDefaults({
        target: { type: "file", fileId: specFile.id },
        metadata: true,
      }),
      createContext([`cl-${collectionAlpha.id}`]),
      repo,
    )
    expect(fileResult.status).toBe("success")
    expect((fileResult as any).data.entries).toHaveLength(1)
    expect((fileResult as any).data.entries[0]).toMatchObject({
      id: specFile.id,
      depth: 0,
      path: "/Projects/API/spec.md",
    })

    const pathResult = await executeLsKnowledgeBase(
      withLsDefaults({
        target: {
          type: "path",
          collectionId: collectionAlpha.id,
          path: "/Projects/API",
        },
      }),
      createContext([`cl-${collectionAlpha.id}`]),
      repo,
    )
    expect(pathResult.status).toBe("success")
    expect(
      (pathResult as any).data.entries.map((entry: any) => entry.id),
    ).toEqual([specFile.id])
  })

  test("rejects out-of-scope collection and path targets before loading projections", async () => {
    const collectionRepo = createRepo()
    const collectionResult = await executeLsKnowledgeBase(
      withLsDefaults({
        target: { type: "collection", collectionId: collectionAlpha.id },
        depth: 2,
      }),
      createContext([`cl-${collectionBeta.id}`]),
      collectionRepo,
    )

    expect(collectionResult.status).toBe("error")
    expect((collectionResult as any).error.message).toContain(
      "outside the current KB scope",
    )
    expect(collectionRepo.counters.listCollectionItems).toBe(0)
    expect(collectionRepo.counters.getCollectionLsProjection).toBe(0)

    const pathRepo = createRepo()
    const pathResult = await executeLsKnowledgeBase(
      withLsDefaults({
        target: {
          type: "path",
          collectionId: collectionAlpha.id,
          path: "/Projects/API",
        },
      }),
      createContext([`cl-${collectionBeta.id}`]),
      pathRepo,
    )

    expect(pathResult.status).toBe("error")
    expect((pathResult as any).error.message).toContain(
      "outside the current KB scope",
    )
    expect(pathRepo.counters.listCollectionItems).toBe(0)
    expect(pathRepo.counters.getCollectionLsProjection).toBe(0)
  })

  test("rejects out-of-scope folder and file targets before loading projections", async () => {
    const folderRepo = createRepo()
    const folderResult = await executeLsKnowledgeBase(
      withLsDefaults({
        target: { type: "folder", folderId: projectsFolder.id },
        depth: 2,
      }),
      createContext([`cl-${collectionBeta.id}`]),
      folderRepo,
    )

    expect(folderResult.status).toBe("error")
    expect((folderResult as any).error.message).toContain(
      "outside the current KB scope",
    )
    expect(folderRepo.counters.listCollectionItems).toBe(0)
    expect(folderRepo.counters.getCollectionLsProjection).toBe(0)

    const fileRepo = createRepo()
    const fileResult = await executeLsKnowledgeBase(
      withLsDefaults({
        target: { type: "file", fileId: specFile.id },
      }),
      createContext([`cl-${collectionBeta.id}`]),
      fileRepo,
    )

    expect(fileResult.status).toBe("error")
    expect((fileResult as any).error.message).toContain(
      "outside the current KB scope",
    )
    expect(fileRepo.counters.listCollectionItems).toBe(0)
    expect(fileRepo.counters.getCollectionLsProjection).toBe(0)
  })

  test("projection build correctness and traversal match stage 1 output", async () => {
    const repo = createRepo()
    const alphaItems = repo.items.filter(
      (item) => item.collectionId === collectionAlpha.id,
    )
    const projection =
      __knowledgeBaseFlowInternals.buildCollectionLsProjection(alphaItems)

    expect(projection.rootIds).toEqual([projectsFolder.id, readmeFile.id])
    expect(projection.childrenByParentId[projectsFolder.id]).toEqual([
      apiFolder.id,
    ])
    expect(projection.nodeIdByPath["/Projects/API/spec.md"]).toBe(specFile.id)

    const collection = repo.collections.find(
      (item) => item.id === collectionAlpha.id,
    )!
    const directSnapshot = __knowledgeBaseFlowInternals.buildCollectionTree(
      collection,
      alphaItems,
    )
    const projectionSnapshot =
      __knowledgeBaseFlowInternals.buildSnapshotFromProjection(
        collection,
        __knowledgeBaseFlowInternals.buildCollectionLsProjection(alphaItems),
      )

    const directEntries = __knowledgeBaseFlowInternals.flattenLsEntries(
      {
        kind: "collection",
        targetType: "collection",
        collection,
        path: "/",
        snapshot: directSnapshot,
      },
      3,
    )
    const projectionEntries = __knowledgeBaseFlowInternals.flattenLsEntries(
      {
        kind: "collection",
        targetType: "collection",
        collection,
        path: "/",
        snapshot: projectionSnapshot,
      },
      3,
    )

    expect(projectionEntries).toEqual(directEntries)
  })

  test("lazily rebuilds stale projection and then reuses persisted projection without scanning again", async () => {
    const repo = createRepo({
      initialProjections: {
        [collectionAlpha.id]: createEmptyProjectionRow(
          collectionAlpha.id,
          new Date("2024-12-31T00:00:00.000Z"),
        ),
      },
    })

    const firstResult = await executeLsKnowledgeBase(
      withLsDefaults({
        target: { type: "collection", collectionId: collectionAlpha.id },
        depth: 2,
      }),
      createContext([`cl-${collectionAlpha.id}`]),
      repo,
    )

    expect(firstResult.status).toBe("success")
    expect(repo.counters.listCollectionItems).toBe(1)
    expect(repo.counters.upsertCollectionLsProjection).toBe(1)
    expect(repo.projectionRows.get(collectionAlpha.id)?.lastError).toBeNull()

    const secondResult = await executeLsKnowledgeBase(
      withLsDefaults({
        target: { type: "collection", collectionId: collectionAlpha.id },
        depth: 2,
      }),
      createContext([`cl-${collectionAlpha.id}`]),
      repo,
    )

    expect(secondResult.status).toBe("success")
    expect(repo.counters.listCollectionItems).toBe(1)
    expect(repo.counters.getCollectionLsProjection).toBeGreaterThanOrEqual(2)
  })

  test("falls back to direct-db traversal and records last_error when projection rebuild fails", async () => {
    const repo = createRepo({
      failProjectionUpsert: true,
    })

    const result = await executeLsKnowledgeBase(
      withLsDefaults({
        target: { type: "collection", collectionId: collectionAlpha.id },
        depth: 2,
      }),
      createContext([`cl-${collectionAlpha.id}`]),
      repo,
    )

    expect(result.status).toBe("success")
    expect(repo.counters.listCollectionItems).toBe(2)
    expect(repo.counters.recordCollectionLsProjectionError).toBe(1)
    expect(repo.projectionRows.get(collectionAlpha.id)?.lastError).toContain(
      "projection upsert failed",
    )
  })

  test("falls back to direct-db traversal when a persisted projection is malformed", async () => {
    const repo = createRepo({
      initialProjections: {
        [collectionAlpha.id]: {
          ...createEmptyProjectionRow(
            collectionAlpha.id,
            collectionAlpha.collectionSourceUpdatedAt,
          ),
          projection: {
            rootIds: "invalid",
            childrenByParentId: {},
            nodesById: {},
            nodeIdByPath: {},
          } as any,
        },
      },
    })

    const result = await executeLsKnowledgeBase(
      withLsDefaults({
        target: { type: "collection", collectionId: collectionAlpha.id },
        depth: 2,
      }),
      createContext([`cl-${collectionAlpha.id}`]),
      repo,
    )

    expect(result.status).toBe("success")
    expect(repo.counters.getCollectionLsProjection).toBe(1)
    expect(repo.counters.listCollectionItems).toBe(1)
    expect(repo.counters.upsertCollectionLsProjection).toBe(0)
    expect(repo.counters.recordCollectionLsProjectionError).toBe(1)
    expect(repo.projectionRows.get(collectionAlpha.id)?.lastError).toContain(
      "expected array, received string",
    )
  })
})

describe("searchKnowledgeBase", () => {
  test("agent-scoped KB access does not widen", async () => {
    const repo = createRepo()
    const searchExecutor = mock(
      async (): Promise<MinimalAgentFragment[]> => [],
    )
    const result = await executeSearchKnowledgeBase(
      {
        query: "api",
        filters: {
          targets: [
            {
              type: "collection",
              collectionId: collectionAlpha.id,
            },
          ],
        },
      },
      createContext([`clfd-${projectsFolder.id}`]),
      {
        repo,
        searchExecutor,
      },
    )

    expect(result.status).toBe("error")
    expect((result as any).error.message).toContain(
      "outside the current KB scope",
    )
    expect(searchExecutor).not.toHaveBeenCalled()
  })

  test("rejects out-of-scope collection and path search targets before resolving snapshots", async () => {
    const collectionRepo = createRepo()
    const collectionSearchExecutor = mock(
      async (): Promise<MinimalAgentFragment[]> => [],
    )
    const collectionResult = await executeSearchKnowledgeBase(
      {
        query: "api",
        filters: {
          targets: [
            {
              type: "collection",
              collectionId: collectionAlpha.id,
            },
          ],
        },
      },
      createContext([`cl-${collectionBeta.id}`]),
      {
        repo: collectionRepo,
        searchExecutor: collectionSearchExecutor,
      },
    )

    expect(collectionResult.status).toBe("error")
    expect((collectionResult as any).error.message).toContain(
      "outside the current KB scope",
    )
    expect(collectionRepo.counters.listCollectionItems).toBe(0)
    expect(collectionRepo.counters.getCollectionLsProjection).toBe(0)
    expect(collectionSearchExecutor).not.toHaveBeenCalled()

    const pathRepo = createRepo()
    const pathSearchExecutor = mock(
      async (): Promise<MinimalAgentFragment[]> => [],
    )
    const pathResult = await executeSearchKnowledgeBase(
      {
        query: "api",
        filters: {
          targets: [
            {
              type: "path",
              collectionId: collectionAlpha.id,
              path: "/Projects/API",
            },
          ],
        },
      },
      createContext([`cl-${collectionBeta.id}`]),
      {
        repo: pathRepo,
        searchExecutor: pathSearchExecutor,
      },
    )

    expect(pathResult.status).toBe("error")
    expect((pathResult as any).error.message).toContain(
      "outside the current KB scope",
    )
    expect(pathRepo.counters.listCollectionItems).toBe(0)
    expect(pathRepo.counters.getCollectionLsProjection).toBe(0)
    expect(pathSearchExecutor).not.toHaveBeenCalled()
  })

  test("rejects out-of-scope folder and file search targets before resolving snapshots", async () => {
    const folderRepo = createRepo()
    const folderSearchExecutor = mock(
      async (): Promise<MinimalAgentFragment[]> => [],
    )
    const folderResult = await executeSearchKnowledgeBase(
      {
        query: "api",
        filters: {
          targets: [
            {
              type: "folder",
              folderId: projectsFolder.id,
            },
          ],
        },
      },
      createContext([`cl-${collectionBeta.id}`]),
      {
        repo: folderRepo,
        searchExecutor: folderSearchExecutor,
      },
    )

    expect(folderResult.status).toBe("error")
    expect((folderResult as any).error.message).toContain(
      "outside the current KB scope",
    )
    expect(folderRepo.counters.listCollectionItems).toBe(0)
    expect(folderRepo.counters.getCollectionLsProjection).toBe(0)
    expect(folderSearchExecutor).not.toHaveBeenCalled()

    const fileRepo = createRepo()
    const fileSearchExecutor = mock(
      async (): Promise<MinimalAgentFragment[]> => [],
    )
    const fileResult = await executeSearchKnowledgeBase(
      {
        query: "api",
        filters: {
          targets: [
            {
              type: "file",
              fileId: specFile.id,
            },
          ],
        },
      },
      createContext([`cl-${collectionBeta.id}`]),
      {
        repo: fileRepo,
        searchExecutor: fileSearchExecutor,
      },
    )

    expect(fileResult.status).toBe("error")
    expect((fileResult as any).error.message).toContain(
      "outside the current KB scope",
    )
    expect(fileRepo.counters.listCollectionItems).toBe(0)
    expect(fileRepo.counters.getCollectionLsProjection).toBe(0)
    expect(fileSearchExecutor).not.toHaveBeenCalled()
  })

  test("maps filters.targets into the current KB search path and preserves citations", async () => {
    const repo = createRepo()
    const fragments: MinimalAgentFragment[] = [
      {
        id: "file-spec:0",
        content: "API search hit",
        source: {
          docId: "file-spec",
          title: "spec.md",
          url: "https://example.com/spec",
          app: Apps.KnowledgeBase,
          entity: KnowledgeBaseEntity.File,
        },
        confidence: 0.91,
      },
    ]

    let capturedSelections: unknown = null
    const searchExecutor = mock(
      async (options: any): Promise<MinimalAgentFragment[]> => {
        capturedSelections = options.collectionSelections
        return fragments
      },
    ) as SearchExecutor

    const result = await executeSearchKnowledgeBase(
      {
        query: "api contract",
        filters: {
          targets: [
            {
              type: "path",
              collectionId: collectionAlpha.id,
              path: "//Projects//API/",
            },
          ],
        },
        limit: 5,
        offset: 2,
        excludedIds: ["skip-me"],
      },
      createContext([`clfd-${projectsFolder.id}`]),
      {
        repo,
        searchExecutor,
      },
    )

    expect(searchExecutor).toHaveBeenCalledTimes(1)
    expect(capturedSelections).toEqual([
      {
        collectionFolderIds: [apiFolder.id],
      },
    ])
    expect(result).toEqual({
      status: "success",
      data: fragments,
    })
  })
})

describe("stage 3 metadata integrity", () => {
  test("merges file processing metadata instead of replacing upload-time metadata", () => {
    expect(
      mergeCollectionItemMetadata(
        {
          originalPath: "Projects/API/spec.md",
          originalFileName: "spec.md",
          wasOverwritten: true,
        },
        {
          chunksCount: 12,
          imageChunksCount: 2,
          pdfProcessingMethod: "ocr",
        },
      ),
    ).toEqual({
      originalPath: "Projects/API/spec.md",
      originalFileName: "spec.md",
      wasOverwritten: true,
      chunksCount: 12,
      imageChunksCount: 2,
      pdfProcessingMethod: "ocr",
    })
  })

  test("prefers computed processing metadata over stale upload-time values", () => {
    expect(
      mergeCollectionItemMetadata(
        {
          chunksCount: 1,
          imageChunksCount: 0,
          processingMethod: "application/pdf",
          pageTitle: "Old Title",
          sheetName: "Sheet 0",
          sheetIndex: 0,
          totalSheets: 1,
        },
        {
          chunksCount: 12,
          imageChunksCount: 2,
          processingMethod: "text/plain",
          pageTitle: "Fresh Title",
          sheetName: "Sheet 1",
          sheetIndex: 1,
          totalSheets: 3,
        },
      ),
    ).toEqual({
      chunksCount: 12,
      imageChunksCount: 2,
      processingMethod: "text/plain",
      pageTitle: "Fresh Title",
      sheetName: "Sheet 1",
      sheetIndex: 1,
      totalSheets: 3,
    })
  })
})
