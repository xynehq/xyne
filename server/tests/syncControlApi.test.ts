import { beforeEach, describe, expect, mock, test } from "bun:test"
import { HTTPException } from "hono/http-exception"
import {
  adminActor,
  countRows,
  installSyncControlDbMock,
  makeJob,
  makeJsonContext,
  readJson,
  resetSyncControlDbMock,
  rows,
  superAdminActor,
  syncControlDbMock,
  syncControlDbState,
} from "./syncControlTestHelpers"

let currentRole = "Admin"
const originalFetch = globalThis.fetch

const getUserByEmailMock = mock(async (_db: unknown, email: string) => [
  {
    id:
      currentRole === "SuperAdmin" ? superAdminActor.userId : adminActor.userId,
    email,
    workspaceId:
      currentRole === "SuperAdmin"
        ? superAdminActor.workspaceId
        : adminActor.workspaceId,
    workspaceExternalId:
      currentRole === "SuperAdmin"
        ? superAdminActor.workspaceExternalId
        : adminActor.workspaceExternalId,
    role: currentRole,
  },
])

const createAuditLogMock = mock(async (input: any) => ({
  id: 100,
  ...input,
}))
const completeAuditLogMock = mock(async (_auditId: number, input: any) => ({
  id: _auditId,
  ...input,
}))
const failAuditLogMock = mock(
  async (_audit: { id: number }, error: unknown) => ({
    resultStatus: "failed",
    errorMessage: error instanceof Error ? error.message : String(error),
  }),
)

const bossMock = {
  cancel: mock(async (_queueName: string, ids: string[]) => ids.length),
  deleteJob: mock(async (_queueName: string, ids: string[]) => ids.length),
}

mock.module("@/config", () => ({
  default: {
    JwtPayloadKey: "jwtPayload",
    syncServerHost: "localhost",
    syncServerPort: 3010,
  },
}))

installSyncControlDbMock()
mock.module("@/db/user", () => ({ getUserByEmail: getUserByEmailMock }))
mock.module("@/queue/boss", () => ({ boss: bossMock }))
mock.module("@/utils", () => ({
  getErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}))
mock.module("@/sync-control/audit", () => ({
  createAuditLog: createAuditLogMock,
  completeAuditLog: completeAuditLogMock,
  failAuditLog: failAuditLogMock,
}))

const syncControl = await import("@/api/syncControl")

const expectHttpStatus = async (promise: Promise<unknown>, status: number) => {
  try {
    await promise
    throw new Error("Expected HTTPException")
  } catch (error) {
    expect(error).toBeInstanceOf(HTTPException)
    expect((error as HTTPException).status).toBe(status as any)
  }
}

beforeEach(() => {
  currentRole = "Admin"
  process.env.METRICS_SECRET = "internal-secret"
  globalThis.fetch = originalFetch
  resetSyncControlDbMock()
  getUserByEmailMock.mockClear()
  createAuditLogMock.mockClear()
  completeAuditLogMock.mockClear()
  failAuditLogMock.mockClear()
  bossMock.cancel.mockClear()
  bossMock.deleteJob.mockClear()
})

describe("sync control API", () => {
  test("schemas require reasons for mutating controls", () => {
    expect(
      syncControl.syncPauseResumeSchema.safeParse({
        scopeType: "email",
        scopeValue: "person@example.com",
      }).success,
    ).toBe(false)
    expect(
      syncControl.syncJobsDeleteSchema.safeParse({
        queueName: "sync-test",
        filters: { email: "person@example.com" },
      }).success,
    ).toBe(false)
  })

  test("Admin cannot create a global pause", async () => {
    await expectHttpStatus(
      syncControl.PauseSyncControl(
        makeJsonContext({
          body: {
            scopeType: "global",
            scopeValue: "*",
            reason: "maintenance",
          },
        }),
      ),
      403,
    )
    expect(createAuditLogMock).not.toHaveBeenCalled()
  })

  test("cancel defaults to dry-run and audits the operation", async () => {
    syncControlDbState.executeQueue = [
      countRows(2),
      rows([makeJob("queued-1", "created"), makeJob("active-1", "active")]),
    ]

    const response = await syncControl.CancelSyncJobs(
      makeJsonContext({
        body: {
          queueName: "sync-SaaS-service_account-per-user",
          filters: { email: "person@example.com" },
          reason: "operator check",
        },
      }),
    )

    expect(await readJson(response)).toMatchObject({
      dryRun: true,
      matchedCount: 2,
      cancellableQueuedCount: 1,
      activeJobControlCount: 1,
    })
    expect(createAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cancel", dryRun: true }),
      expect.objectContaining({ isSuperAdmin: false }),
    )
    expect(completeAuditLogMock).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ resultStatus: "success", affectedJobCount: 2 }),
    )
    expect(bossMock.cancel).not.toHaveBeenCalled()
    expect(syncControlDbState.inserts).toEqual([])
  })

  test("cancel mutates queued jobs and creates job-scoped controls for active matches only", async () => {
    currentRole = "SuperAdmin"
    syncControlDbState.executeQueue = [
      countRows(4),
      rows([
        makeJob("created-1", "created"),
        makeJob("retry-1", "retry"),
        makeJob("active-1", "active"),
        makeJob("failed-1", "failed"),
      ]),
      rows([{ id: "created-1" }, { id: "retry-1" }]),
    ]

    const response = await syncControl.CancelSyncJobs(
      makeJsonContext({
        email: superAdminActor.email,
        body: {
          queueName: "sync-SaaS-service_account-per-user",
          filters: {},
          dryRun: false,
          reason: "operator cancel",
        },
      }),
    )

    expect(await readJson(response)).toMatchObject({
      dryRun: false,
      cancelledQueued: 2,
      activeJobControlsCreated: 1,
      terminalNoopCount: 1,
    })
    expect(syncControlDbMock.execute).toHaveBeenCalledTimes(3)
    expect(syncControlDbState.inserts).toContainEqual(
      expect.objectContaining({
        scopeType: "job",
        scopeValue: "active-1",
        queueName: "sync-SaaS-service_account-per-user",
      }),
    )
  })

  test("Admin broad delete is rejected before audit creation", async () => {
    await expectHttpStatus(
      syncControl.DeleteSyncJobs(
        makeJsonContext({
          body: {
            queueName: "sync-SaaS-service_account-per-user",
            filters: {},
            dryRun: false,
            reason: "too broad",
          },
        }),
      ),
      403,
    )
    expect(createAuditLogMock).not.toHaveBeenCalled()
  })

  test("delete rejects selected active jobs and records a failed audit", async () => {
    syncControlDbState.executeQueue = [
      countRows(2),
      rows([makeJob("created-1", "created"), makeJob("active-1", "active")]),
    ]

    await expectHttpStatus(
      syncControl.DeleteSyncJobs(
        makeJsonContext({
          body: {
            queueName: "sync-SaaS-service_account-per-user",
            filters: { email: "person@example.com" },
            dryRun: false,
            reason: "delete queued",
          },
        }),
      ),
      409,
    )
    expect(bossMock.deleteJob).not.toHaveBeenCalled()
    expect(failAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 100 }),
      expect.any(HTTPException),
    )
  })

  test("clear dry-run defaults include failed, exclude completed, and report active separately", async () => {
    currentRole = "SuperAdmin"
    syncControlDbState.executeQueue = [
      rows([
        {
          queueName: "sync-SaaS-service_account-per-user",
          state: "created",
          count: 2,
        },
        {
          queueName: "sync-SaaS-service_account-per-user",
          state: "failed",
          count: 3,
        },
        {
          queueName: "sync-SaaS-service_account-per-user",
          state: "completed",
          count: 5,
        },
        {
          queueName: "sync-SaaS-service_account-per-user",
          state: "active",
          count: 7,
        },
      ]),
    ]

    const response = (await syncControl.ClearSyncQueues(
      makeJsonContext({
        email: superAdminActor.email,
        body: {
          queues: ["sync-SaaS-service_account-per-user"],
          confirmation: "CLEAR_SYNC_SERVER_QUEUE",
          reason: "clear old jobs",
        },
      }),
    )) as Response

    expect((await readJson(response)) as any).toEqual({
      dryRun: true,
      affectedJobCount: 5,
      perQueue: {
        "sync-SaaS-service_account-per-user": {
          eligibleCount: 5,
          activeNotTouched: 7,
        },
      },
    })
    expect(bossMock.deleteJob).not.toHaveBeenCalled()
  })

  test("clear non-dry-run deletes eligible batches and never includes active jobs", async () => {
    currentRole = "SuperAdmin"
    syncControlDbState.executeQueue = [
      rows([
        {
          queueName: "sync-SaaS-service_account-per-user",
          state: "created",
          count: 1,
        },
        {
          queueName: "sync-SaaS-service_account-per-user",
          state: "active",
          count: 1,
        },
      ]),
      rows([makeJob("created-1", "created")]),
      rows([{ id: "created-1" }]),
    ]

    const response = await syncControl.ClearSyncQueues(
      makeJsonContext({
        email: superAdminActor.email,
        body: {
          queues: ["sync-SaaS-service_account-per-user"],
          confirmation: "CLEAR_SYNC_SERVER_QUEUE",
          dryRun: false,
          reason: "clear old jobs",
        },
      }),
    )

    expect(await readJson(response)).toMatchObject({
      dryRun: false,
      affectedJobCount: 1,
      perQueue: {
        "sync-SaaS-service_account-per-user": {
          deleted: 1,
          activeNotTouched: 1,
        },
      },
    })
    expect(syncControlDbMock.execute).toHaveBeenCalledTimes(3)
  })

  test("worker proxy failures mark the audit failed", async () => {
    currentRole = "SuperAdmin"
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ message: "sync-server unavailable" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch

    await expectHttpStatus(
      syncControl.PauseSyncWorkers(
        makeJsonContext({
          email: superAdminActor.email,
          body: {
            workerGroup: "sync-slack",
            count: 1,
            reason: "stop intake",
          },
        }),
      ),
      502,
    )
    expect(createAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "worker_pause",
        scopeType: "worker_group",
        scopeValue: "sync-slack",
        dryRun: false,
      }),
      expect.objectContaining({ isSuperAdmin: true }),
    )
    expect(failAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 100 }),
      expect.any(HTTPException),
    )
  })
})
