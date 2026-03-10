import { beforeEach, describe, expect, mock, test } from "bun:test"
import { Apps, KnowledgeBaseEntity, SearchModes } from "@xyne/vespa-ts/types"
import type { MinimalAgentFragment } from "@/api/chat/types"

process.env.ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

const mockLogger = {
  error: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  debug: mock(() => {}),
  child() {
    return mockLogger
  },
}

const mockGetAllFolderIds = mock(async (folderIds: string[]) => {
  if (folderIds.includes("folder-projects")) {
    return ["folder-api"]
  }
  return []
})

const mockGetCollectionFilesVespaIds = mock(async (fileIds: string[]) =>
  fileIds.map((fileId) => ({
    vespaDocId:
      {
        "file-spec": "clf-spec",
        "file-beta": "clf-beta",
      }[fileId] ?? null,
  })),
)

mock.module("@/logger", () => ({
  getLogger: () => mockLogger,
  getLoggerWithChild: () => () => mockLogger,
  Subsystem: {
    Chat: "Chat",
    Api: "Api",
    Vespa: "Vespa",
  },
}))

mock.module("@/db/client", () => ({
  db: {},
}))

mock.module("@/db/connector", () => ({
  db: {},
  insertConnector: mock(async () => null),
  getConnectors: mock(async () => []),
  getConnectorByApp: mock(async () => null),
  getConnector: mock(async () => null),
  getOAuthConnectorWithCredentials: mock(async () => null),
  getMicrosoftAuthConnectorWithCredentials: mock(async () => null),
  getConnectorByExternalId: mock(async () => null),
  getConnectorById: mock(async () => null),
  getConnectorByAppAndEmailId: mock(async () => null),
  updateConnector: mock(async () => null),
  deleteConnector: mock(async () => null),
  deleteOauthConnector: mock(async () => null),
  loadConnectorState: mock(async () => null),
  saveConnectorState: mock(async () => undefined),
  getDatabaseConnectorForUser: mock(async () => null),
  getOrCreateDatabaseConnectorKbCollectionId: mock(async () => null),
  getDatabaseConnectorExternalIdByKbCollectionId: mock(async () => null),
  clearDatabaseConnectorKbCollectionId: mock(async () => undefined),
}))

mock.module("@/db/user", () => ({
  getPublicUserAndWorkspaceByEmail: mock(async () => []),
  getUserAndWorkspaceByEmail: mock(async () => []),
  getUserAndWorkspaceByOnlyEmail: mock(async () => []),
  getUserByEmail: mock(async () => []),
  createUser: mock(async () => null),
  saveRefreshTokenToDB: mock(async () => undefined),
  deleteRefreshTokenFromDB: mock(async () => undefined),
  getUserById: mock(async () => null),
  getUserMetaData: mock(async () => null),
  getUsersByWorkspace: mock(async () => []),
  getAllLoggedInUsers: mock(async () => []),
  getAllIngestedUsers: mock(async () => []),
  updateUser: mock(async () => null),
  updateUserTimezone: mock(async () => null),
  getUserFromJWT: mock(async () => null),
  createUserApiKey: mock(async () => null),
}))

mock.module("@/db/knowledgeBase", () => ({
  touchCollectionLsStructure: mock(async () => undefined),
  touchCollectionLsStructures: mock(async () => undefined),
  getCollectionById: mock(async () => null),
  getCollectionItemById: mock(async () => null),
  getCollectionLsProjection: mock(async () => null),
  getCollectionsByOwner: mock(async () => []),
  getAccessibleCollections: mock(async () => []),
  recordCollectionLsProjectionError: mock(async () => undefined),
  upsertCollectionLsProjection: mock(async () => null),
  createCollection: mock(async () => null),
  updateCollection: mock(async () => null),
  softDeleteCollection: mock(async () => null),
  createCollectionItem: mock(async () => null),
  getCollectionItemsByParent: mock(async () => []),
  getCollectionItemByPath: mock(async () => null),
  updateCollectionItem: mock(async () => null),
  softDeleteCollectionItem: mock(async () => null),
  updateCollectionTotalCount: mock(async () => undefined),
  updateFolderTotalCount: mock(async () => undefined),
  updateParentFolderCounts: mock(async () => undefined),
  createFolder: mock(async () => null),
  createFileItem: mock(async () => null),
  getAllCollectionItems: mock(async () => []),
  getParentItems: mock(async () => []),
  getAllFolderIds: mockGetAllFolderIds,
  getCollectionFilesVespaIds: mockGetCollectionFilesVespaIds,
  getCollectionItemsStatusByCollections: mock(async () => []),
  getAllCollectionAndFolderItems: mock(async () => ({
    fileIds: [],
    folderIds: [],
  })),
  getAllFolderItems: mock(async () => []),
  getCollectionFoldersItemIds: mock(async () => []),
  getCollectionFileByItemId: mock(async () => null),
  createCollectionFile: mock(async () => null),
  updateCollectionFile: mock(async () => null),
  softDeleteCollectionFile: mock(async () => null),
  generateStorageKey: mock(() => "storage-key"),
  generateFileVespaDocId: mock(() => "file-vespa-id"),
  generateFolderVespaDocId: mock(() => "folder-vespa-id"),
  generateCollectionVespaDocId: mock(() => "collection-vespa-id"),
  markParentAsProcessing: mock(async () => undefined),
  updateParentStatus: mock(async () => undefined),
  getRecordBypath: mock(async () => null),
}))

const { executeLsKnowledgeBase, executeSearchKnowledgeBase } = await import(
  "@/api/chat/tools/knowledgeBaseFlow"
)
const { extractCollectionVespaIds } = await import("@/search/utils")
const { sharedVespaService } = await import("@/search/vespaService")

const collectionAlpha = {
  id: "collection-alpha",
  workspaceId: 1,
  ownerId: 1,
  name: "Alpha",
  description: "Alpha docs",
  vespaDocId: "cl-alpha",
  isPrivate: true,
  totalItems: 4,
  lastUpdatedByEmail: "owner@example.com",
  lastUpdatedById: 1,
  uploadStatus: "completed",
  statusMessage: null,
  retryCount: 0,
  metadata: {},
  permissions: [],
  collectionSourceUpdatedAt: new Date("2025-01-02T00:00:00.000Z"),
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
  updatedAt: new Date("2025-01-02T00:00:00.000Z"),
  deletedAt: null,
  via_apiKey: false,
} as any

const collectionBeta = {
  ...collectionAlpha,
  id: "collection-beta",
  name: "Beta",
  description: "Beta docs",
  vespaDocId: "cl-beta",
  totalItems: 1,
} as any

const projectsFolder = {
  id: "folder-projects",
  collectionId: collectionAlpha.id,
  parentId: null,
  workspaceId: 1,
  ownerId: 1,
  name: "Projects",
  type: "folder",
  path: "/",
  position: 0,
  vespaDocId: "clfd-projects",
  totalFileCount: 2,
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
  uploadStatus: "completed",
  statusMessage: null,
  retryCount: 0,
  metadata: {},
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
  updatedAt: new Date("2025-01-02T00:00:00.000Z"),
  deletedAt: null,
} as any

const apiFolder = {
  ...projectsFolder,
  id: "folder-api",
  parentId: projectsFolder.id,
  name: "API",
  path: "/Projects/",
  totalFileCount: 1,
  vespaDocId: "clfd-api",
} as any

const specFile = {
  ...projectsFolder,
  id: "file-spec",
  parentId: apiFolder.id,
  name: "spec.md",
  type: "file",
  path: "/Projects/API/",
  vespaDocId: "clf-spec",
  totalFileCount: 0,
  originalName: "spec.md",
  mimeType: "text/markdown",
} as any

const readmeFile = {
  ...specFile,
  id: "file-readme",
  parentId: null,
  name: "README.txt",
  path: "/",
  position: 1,
  vespaDocId: "clf-readme",
  originalName: "README.txt",
  mimeType: "text/plain",
} as any

const betaFile = {
  ...specFile,
  id: "file-beta",
  collectionId: collectionBeta.id,
  parentId: null,
  name: "beta.txt",
  path: "/",
  vespaDocId: "clf-beta",
  originalName: "beta.txt",
  mimeType: "text/plain",
} as any

function createRepo() {
  const collections = [collectionAlpha, collectionBeta]
  const items = [projectsFolder, apiFolder, specFile, readmeFile, betaFile]

  return {
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
      return items.filter((item) => item.collectionId === collectionId)
    },
    async listCollectionItemsByIds(collectionId: string, itemIds: string[]) {
      return items.filter(
        (item) =>
          item.collectionId === collectionId && itemIds.includes(item.id),
      )
    },
    async getCollectionLsProjection() {
      return null
    },
    async upsertCollectionLsProjection(params: any) {
      return {
        collectionId: params.collectionId,
        projection: params.projection,
        lsCollectionProjectionUpdatedAt: params.lsCollectionProjectionUpdatedAt,
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        updatedAt: new Date("2025-01-01T00:00:00.000Z"),
        lastError: null,
      }
    },
    async recordCollectionLsProjectionError() {
      return undefined
    },
  }
}

function createContext() {
  return {
    user: {
      email: "tester@example.com",
      numericId: 7,
      workspaceNumericId: 9,
    },
    agentPrompt: undefined,
  } as any
}

function buildKnowledgeBaseYql(processedSelections: {
  collectionIds?: string[]
  collectionFolderIds?: string[]
  collectionFileIds?: string[]
}) {
  return (sharedVespaService as any).HybridDefaultProfileForAgent(
    5,
    Apps.KnowledgeBase,
    null,
    SearchModes.NativeRank,
    null,
    undefined,
    [],
    [Apps.KnowledgeBase],
    [],
    null,
    [],
    processedSelections,
    [],
    {},
    "tester@example.com",
    {},
    "api contract",
  ).yql as string
}

async function runSearchAndCapture(params: any) {
  const repo = createRepo()
  let capturedSelections: any = null
  let capturedProcessedSelections: any = null
  let capturedYql = ""

  const searchExecutor = mock(async (options: any): Promise<MinimalAgentFragment[]> => {
    capturedSelections = options.collectionSelections
    capturedProcessedSelections = await extractCollectionVespaIds({
      collectionSelections: options.collectionSelections,
    } as any)
    capturedYql = buildKnowledgeBaseYql(capturedProcessedSelections)

    return [
      {
        id: "fragment-1",
        content: "hit",
        source: {
          docId: "clf-spec",
          title: "spec.md",
          url: "",
          app: Apps.KnowledgeBase,
          entity: KnowledgeBaseEntity.File,
        },
        confidence: 0.9,
      },
    ]
  })

  const result = await executeSearchKnowledgeBase(params, createContext(), {
    repo: repo as any,
    searchExecutor,
  })

  return {
    result,
    capturedSelections,
    capturedProcessedSelections,
    capturedYql,
    searchExecutor,
  }
}

async function runLs(params: any) {
  return executeLsKnowledgeBase(params, createContext(), createRepo() as any)
}

describe("knowledge base target translation to Vespa", () => {
  beforeEach(() => {
    mockGetAllFolderIds.mockClear()
    mockGetCollectionFilesVespaIds.mockClear()
  })

  test("collection targets remain collection IDs and become clId Vespa filters", async () => {
    const outcome = await runSearchAndCapture({
      query: "alpha docs",
      filters: {
        targets: [
          {
            type: "collection",
            collectionId: collectionAlpha.id,
          },
        ],
      },
    })

    expect(outcome.result.status).toBe("success")
    expect(outcome.capturedSelections).toEqual([
      {
        collectionIds: [collectionAlpha.id],
      },
    ])
    expect(outcome.capturedProcessedSelections).toEqual({
      collectionIds: [collectionAlpha.id],
    })
    expect(outcome.capturedYql).toContain(`clId contains '${collectionAlpha.id}'`)
  })

  test("folder and folder-path targets become clFd filters and expand descendant folders", async () => {
    const outcome = await runSearchAndCapture({
      query: "api docs",
      filters: {
        targets: [
          {
            type: "path",
            collectionId: collectionAlpha.id,
            path: "/Projects",
          },
        ],
      },
    })

    expect(outcome.result.status).toBe("success")
    expect(outcome.capturedSelections).toEqual([
      {
        collectionFolderIds: [projectsFolder.id],
      },
    ])
    expect(outcome.capturedProcessedSelections).toEqual({
      collectionFolderIds: [projectsFolder.id, apiFolder.id],
    })
    expect(outcome.capturedYql).toContain(`clFd contains '${projectsFolder.id}'`)
    expect(outcome.capturedYql).toContain(`clFd contains '${apiFolder.id}'`)
    expect(mockGetAllFolderIds).toHaveBeenCalledWith([projectsFolder.id], {})
  })

  test("file and file-path targets become docId filters using Vespa file doc IDs", async () => {
    const outcome = await runSearchAndCapture({
      query: "spec",
      filters: {
        targets: [
          {
            type: "path",
            collectionId: collectionAlpha.id,
            path: "/Projects/API/spec.md",
          },
        ],
      },
    })

    expect(outcome.result.status).toBe("success")
    expect(outcome.capturedSelections).toEqual([
      {
        collectionFileIds: [specFile.id],
      },
    ])
    expect(outcome.capturedProcessedSelections).toEqual({
      collectionFileIds: [specFile.vespaDocId],
    })
    expect(outcome.capturedYql).toContain(
      `docId contains '${specFile.vespaDocId}'`,
    )
    expect(mockGetCollectionFilesVespaIds).toHaveBeenCalledWith(
      [specFile.id],
      {},
    )
  })

  test("mixed targets are unioned before Vespa query construction", async () => {
    const outcome = await runSearchAndCapture({
      query: "mixed",
      filters: {
        targets: [
          {
            type: "collection",
            collectionId: collectionBeta.id,
          },
          {
            type: "folder",
            folderId: projectsFolder.id,
          },
          {
            type: "file",
            fileId: specFile.id,
          },
        ],
      },
    })

    expect(outcome.result.status).toBe("success")
    expect(outcome.capturedSelections).toEqual([
      {
        collectionIds: [collectionBeta.id],
        collectionFolderIds: [projectsFolder.id],
        collectionFileIds: [specFile.id],
      },
    ])
    expect(outcome.capturedProcessedSelections).toEqual({
      collectionIds: [collectionBeta.id],
      collectionFolderIds: [projectsFolder.id, apiFolder.id],
      collectionFileIds: [specFile.vespaDocId],
    })
    expect(outcome.capturedYql).toContain(`clId contains '${collectionBeta.id}'`)
    expect(outcome.capturedYql).toContain(`clFd contains '${projectsFolder.id}'`)
    expect(outcome.capturedYql).toContain(
      `docId contains '${specFile.vespaDocId}'`,
    )
    expect(outcome.capturedYql).toContain(" or ")
  })

  test("collection IDs returned by ls can be reused directly as collection targets", async () => {
    const lsResult = await runLs({})
    expect(lsResult.status).toBe("success")

    const collectionEntry = (lsResult as any).data.entries.find(
      (entry: any) => entry.type === "collection" && entry.id === collectionAlpha.id,
    )
    expect(collectionEntry).toBeDefined()

    const outcome = await runSearchAndCapture({
      query: "alpha docs",
      filters: {
        targets: [
          {
            type: "collection",
            collectionId: collectionEntry.id,
          },
        ],
      },
    })

    expect(outcome.capturedSelections).toEqual([
      {
        collectionIds: [collectionAlpha.id],
      },
    ])
    expect(outcome.capturedYql).toContain(`clId contains '${collectionAlpha.id}'`)
  })

  test("folder ls rows can be reused as folderId targets and path targets", async () => {
    const lsResult = await runLs({
      target: {
        type: "collection",
        collectionId: collectionAlpha.id,
      },
      depth: 2,
      metadata: true,
    })
    expect(lsResult.status).toBe("success")

    const folderEntry = (lsResult as any).data.entries.find(
      (entry: any) => entry.type === "folder" && entry.id === projectsFolder.id,
    )
    expect(folderEntry).toBeDefined()
    expect(folderEntry.collection_id).toBe(collectionAlpha.id)
    expect(folderEntry.path).toBe("/Projects")

    const folderIdOutcome = await runSearchAndCapture({
      query: "api docs",
      filters: {
        targets: [
          {
            type: "folder",
            folderId: folderEntry.id,
          },
        ],
      },
    })

    expect(folderIdOutcome.capturedSelections).toEqual([
      {
        collectionFolderIds: [projectsFolder.id],
      },
    ])
    expect(folderIdOutcome.capturedYql).toContain(
      `clFd contains '${projectsFolder.id}'`,
    )

    const pathOutcome = await runSearchAndCapture({
      query: "api docs",
      filters: {
        targets: [
          {
            type: "path",
            collectionId: folderEntry.collection_id,
            path: folderEntry.path,
          },
        ],
      },
    })

    expect(pathOutcome.capturedSelections).toEqual([
      {
        collectionFolderIds: [projectsFolder.id],
      },
    ])
    expect(pathOutcome.capturedYql).toContain(`clFd contains '${projectsFolder.id}'`)
  })

  test("file ls rows can be reused as fileId targets and path targets", async () => {
    const lsResult = await runLs({
      target: {
        type: "path",
        collectionId: collectionAlpha.id,
        path: "/Projects/API",
      },
      depth: 1,
      metadata: true,
    })
    expect(lsResult.status).toBe("success")

    const fileEntry = (lsResult as any).data.entries.find(
      (entry: any) => entry.type === "file" && entry.id === specFile.id,
    )
    expect(fileEntry).toBeDefined()
    expect(fileEntry.collection_id).toBe(collectionAlpha.id)
    expect(fileEntry.path).toBe("/Projects/API/spec.md")

    const fileIdOutcome = await runSearchAndCapture({
      query: "spec",
      filters: {
        targets: [
          {
            type: "file",
            fileId: fileEntry.id,
          },
        ],
      },
    })

    expect(fileIdOutcome.capturedSelections).toEqual([
      {
        collectionFileIds: [specFile.id],
      },
    ])
    expect(fileIdOutcome.capturedYql).toContain(
      `docId contains '${specFile.vespaDocId}'`,
    )

    const pathOutcome = await runSearchAndCapture({
      query: "spec",
      filters: {
        targets: [
          {
            type: "path",
            collectionId: fileEntry.collection_id,
            path: fileEntry.path,
          },
        ],
      },
    })

    expect(pathOutcome.capturedSelections).toEqual([
      {
        collectionFileIds: [specFile.id],
      },
    ])
    expect(pathOutcome.capturedYql).toContain(
      `docId contains '${specFile.vespaDocId}'`,
    )
  })
})
