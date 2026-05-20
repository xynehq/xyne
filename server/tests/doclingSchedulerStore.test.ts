import { beforeEach, describe, expect, mock, test } from "bun:test"

process.env.ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

type MockState = {
  conflictDoNothingConfigs: Array<Record<string, unknown>>
  insertValuesPayloads: unknown[]
  dbReturningQueue: unknown[][]
  dbUpdateWhereClauses: unknown[]
  dbUpdateSetPayloads: unknown[]
  txReturningQueue: unknown[][]
  txUpdateWhereClauses: unknown[]
  txUpdateSetPayloads: unknown[]
  txDeleteWhereClauses: unknown[]
  txInsertValuesPayloads: unknown[]
  executeQueries: unknown[]
}

const state: MockState = {
  conflictDoNothingConfigs: [],
  insertValuesPayloads: [],
  dbReturningQueue: [],
  dbUpdateWhereClauses: [],
  dbUpdateSetPayloads: [],
  txReturningQueue: [],
  txUpdateWhereClauses: [],
  txUpdateSetPayloads: [],
  txDeleteWhereClauses: [],
  txInsertValuesPayloads: [],
  executeQueries: [],
}

const resetState = () => {
  state.conflictDoNothingConfigs = []
  state.insertValuesPayloads = []
  state.dbReturningQueue = []
  state.dbUpdateWhereClauses = []
  state.dbUpdateSetPayloads = []
  state.txReturningQueue = []
  state.txUpdateWhereClauses = []
  state.txUpdateSetPayloads = []
  state.txDeleteWhereClauses = []
  state.txInsertValuesPayloads = []
  state.executeQueries = []
}

const createUpdateWhereResult = (queue: unknown[][]) => ({
  returning: async () => queue.shift() || [],
  then: (resolve: (value: undefined) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(undefined).then(resolve, reject),
})

const db = {
  execute: async (query: unknown) => {
    state.executeQueries.push(query)
    return { rows: [] }
  },
  insert: (_table: unknown) => ({
    values: (payload: unknown) => {
      state.insertValuesPayloads.push(payload)
      return {
        onConflictDoNothing: (config: Record<string, unknown>) => {
          state.conflictDoNothingConfigs.push(config)
          return {
            returning: async () => state.dbReturningQueue.shift() || [],
          }
        },
      }
    },
  }),
  update: (_table: unknown) => ({
    set: (payload: unknown) => {
      state.dbUpdateSetPayloads.push(payload)
      return {
        where: (clause: unknown) => {
          state.dbUpdateWhereClauses.push(clause)
          return createUpdateWhereResult(state.dbReturningQueue)
        },
      }
    },
  }),
  transaction: async (
    callback: (tx: {
      update: (table: unknown) => {
        set: (payload: unknown) => {
          where: (clause: unknown) => {
            returning: () => Promise<unknown[]>
            then: (
              resolve: (value: undefined) => unknown,
              reject?: (reason: unknown) => unknown,
            ) => Promise<unknown>
          }
        }
      }
      delete: (table: unknown) => {
        where: (clause: unknown) => Promise<void>
      }
      insert: (table: unknown) => {
        values: (payload: unknown) => Promise<void>
      }
    }) => Promise<unknown>,
  ) =>
    callback({
      update: (_table: unknown) => ({
        set: (payload: unknown) => {
          state.txUpdateSetPayloads.push(payload)
          return {
            where: (clause: unknown) => {
              state.txUpdateWhereClauses.push(clause)
              return createUpdateWhereResult(state.txReturningQueue)
            },
          }
        },
      }),
      delete: (_table: unknown) => ({
        where: async (clause: unknown) => {
          state.txDeleteWhereClauses.push(clause)
        },
      }),
      insert: (_table: unknown) => ({
        values: async (payload: unknown) => {
          state.txInsertValuesPayloads.push(payload)
        },
      }),
    }),
}

mock.module("@/db/client", () => ({ db }))

const {
  markDoclingFileCompleted,
  markDoclingFileSplitComplete,
  markDoclingPartSubmitRetry,
  upsertDoclingAsyncFileForSplit,
} = await import("@/lib/doclingSchedulerStore")

const renderSql = (query: unknown) =>
  (query as {
    toQuery: (dialect: {
      escapeName: (name: string) => string
      escapeParam: (index: number, value: unknown) => string
      escapeString: (value: string) => string
      casing: { getColumnCasing: (column: { name: string }) => string }
    }) => { sql: string; params: unknown[] }
  }).toQuery({
    escapeName: (name) => name,
    escapeParam: () => "?",
    escapeString: (value) => `'${value.replaceAll("'", "''")}'`,
    casing: {
      getColumnCasing: (column) => column.name,
    },
  })

beforeEach(() => {
  resetState()
})

describe("Docling scheduler store", () => {
  test("ignores duplicate file enqueues instead of rewriting active rows", async () => {
    await upsertDoclingAsyncFileForSplit({
      fileId: "file-1",
      vespaDocId: "vespa-1",
      collectionId: "collection-1",
      parentId: null,
      collectionName: "Collection",
      fileName: "report.pdf",
      originalName: "report.pdf",
      sourcePath: "workspace-1/collection-1/2026/05/report.pdf",
      sourceStorageKey: "workspace-1/collection-1/2026/05/report.pdf",
      path: "/",
      mimeType: "application/pdf",
      baseMimeType: "application/pdf",
      fileSize: 128,
      uploadedByEmail: "user@example.com",
      pageTitle: "",
      metadata: {},
      totalPages: 0,
      totalParts: 0,
      pageChunkSize: 50,
    })

    expect(state.conflictDoNothingConfigs).toHaveLength(1)
  })

  test("split completion is fenced by an active lease", async () => {
    state.txReturningQueue.push([])

    const committed = await markDoclingFileSplitComplete(
      {
        fileId: "file-1",
        leaseOwner: "splitter-1",
      } as never,
      {
        fileId: "file-1",
        vespaDocId: "vespa-1",
        sourcePath: "workspace-1/collection-1/2026/05/report.pdf",
        sourceSize: 128,
        sourceMtimeMs: Date.now(),
        fileName: "report.pdf",
        totalPages: 10,
        pageChunkSize: 5,
        partsTotal: 2,
        stageDir: "/tmp/stage/file-1/run-1",
        partsDir: "/tmp/stage/file-1/run-1/parts",
        manifestPath: "/tmp/stage/file-1/run-1/manifest.json",
        parts: [],
      },
      "/tmp/stage/file-1/run-1/results",
    )

    expect(committed).toBe(false)
    expect(state.txDeleteWhereClauses).toHaveLength(0)
    expect(state.txInsertValuesPayloads).toHaveLength(0)

    const leaseGuard = renderSql(state.txUpdateWhereClauses[0]!)
    expect(leaseGuard.sql).toContain("lease_owner")
    expect(leaseGuard.sql).toContain("lease_until")
    expect(leaseGuard.sql).toContain("NOW()")
  })

  test("write completion is fenced by an active lease", async () => {
    state.txReturningQueue.push([])

    const committed = await markDoclingFileCompleted({
      fileId: "file-1",
      vespaDocId: "vespa-1",
      statusMessage: "done",
      metadata: {},
      leaseOwner: "writer-1",
    })

    expect(committed).toBe(false)

    const leaseGuard = renderSql(state.txUpdateWhereClauses[0]!)
    expect(leaseGuard.sql).toContain("lease_owner")
    expect(leaseGuard.sql).toContain("lease_until")
    expect(leaseGuard.sql).toContain("NOW()")
  })

  test("submit retry only requeues active submissions", async () => {
    await markDoclingPartSubmitRetry({
      fileId: "file-1",
      partIndex: 0,
      jobId: "docling:file-1:part:0:attempt:1",
      errorMessage: "submit failed",
      availableAt: new Date("2026-05-20T00:00:00.000Z"),
    })

    const query = renderSql(state.executeQueries[0]!)
    expect(query.sql).toContain("status IN (?, ?)")
    expect(query.params).toContain("submitting")
    expect(query.params).toContain("submitted")
  })
})
