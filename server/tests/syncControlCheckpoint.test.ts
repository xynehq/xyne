import { beforeEach, describe, expect, mock, test } from "bun:test"
import {
  adminActor,
  importFresh,
  installLoggerMock,
  installSyncControlDbMock,
  resetSyncControlDbMock,
  rows,
  syncControlDbMock,
  syncControlDbState,
} from "./syncControlTestHelpers"

installLoggerMock()

const domainCancelHandlerMock = mock(async () => undefined)

installSyncControlDbMock()

const loadCheckpoint = () =>
  importFresh<typeof import("@/sync-control/checkpoint")>(
    "../sync-control/checkpoint.ts",
  )

const control = (overrides: Record<string, unknown>) => ({
  id: 1,
  externalId: "control-1",
  workspaceId: adminActor.workspaceId,
  scopeType: "email",
  scopeValue: "person@example.com",
  queueName: null,
  controlType: "pause",
  reason: "maintenance",
  createdByUserId: adminActor.userId,
  createdByEmail: adminActor.email,
  expiresAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  deletedAt: null,
  ...overrides,
})

beforeEach(() => {
  resetSyncControlDbMock()
  syncControlDbState.executeFallback = rows([{ id: "job-1" }])
  domainCancelHandlerMock.mockClear()
})

describe("sync control checkpoint", () => {
  test("allows work when no matching controls exist", async () => {
    const { checkSyncControl } = await loadCheckpoint()

    await expect(
      checkSyncControl({
        queueName: "sync-SaaS-service_account-per-user",
        jobId: "job-1",
        jobData: {
          email: "person@example.com",
          workspaceId: adminActor.workspaceId,
        },
        checkpoint: "before_start",
      }),
    ).resolves.toBe("allowed")
    expect(syncControlDbMock.execute).not.toHaveBeenCalled()
  })

  test("defers fetched jobs before start for defer-before-start queues", async () => {
    syncControlDbState.activeControls = [control({ controlType: "pause" })]
    const { checkSyncControl } = await loadCheckpoint()

    await expect(
      checkSyncControl({
        queueName: "sync-SaaS-service_account-per-user",
        jobId: "job-1",
        jobData: {
          email: "person@example.com",
          workspaceId: adminActor.workspaceId,
        },
        checkpoint: "before_start",
        deferSeconds: 60,
      }),
    ).resolves.toBe("deferred")
    expect(syncControlDbMock.execute).toHaveBeenCalledTimes(1)
  })

  test("does not defer active rows for checkpoint-only queues", async () => {
    syncControlDbState.activeControls = [control({ controlType: "pause" })]
    const { checkSyncControl } = await loadCheckpoint()

    await expect(
      checkSyncControl({
        queueName: "sync-SaaS-service_account-scheduler",
        jobId: "job-1",
        jobData: {
          email: "person@example.com",
          workspaceId: adminActor.workspaceId,
        },
        checkpoint: "before_start",
      }),
    ).resolves.toBe("deferred")
    expect(syncControlDbMock.execute).not.toHaveBeenCalled()
  })

  test("checkpoint pauses return without throwing generic errors", async () => {
    syncControlDbState.activeControls = [control({ controlType: "pause" })]
    const { checkSyncControl } = await loadCheckpoint()

    await expect(
      checkSyncControl({
        queueName: "sync-SaaS-service_account-per-user",
        jobData: {
          email: "person@example.com",
          workspaceId: adminActor.workspaceId,
        },
        checkpoint: "loop_checkpoint",
      }),
    ).resolves.toBe("deferred")
    expect(syncControlDbMock.execute).not.toHaveBeenCalled()
  })

  test("cancel controls run domain cancellation without force-mutating active pg-boss rows", async () => {
    syncControlDbState.activeControls = [
      control({ controlType: "cancel", reason: "operator cancel" }),
    ]
    const { SyncQueueRegistry } = await import("@/sync-control/registry")
    SyncQueueRegistry[
      "sync-SaaS-service_account-per-user"
    ].domainCancelHandler = domainCancelHandlerMock
    const { checkSyncControl } = await loadCheckpoint()

    await expect(
      checkSyncControl({
        queueName: "sync-SaaS-service_account-per-user",
        jobId: "job-1",
        jobData: {
          email: "person@example.com",
          workspaceId: adminActor.workspaceId,
        },
        checkpoint: "before_start",
        actor: adminActor,
      }),
    ).resolves.toBe("cancelled")
    expect(domainCancelHandlerMock).toHaveBeenCalledWith(
      {
        email: "person@example.com",
        jobId: "job-1",
        queueName: "sync-SaaS-service_account-per-user",
      },
      "operator cancel",
      adminActor,
    )
    expect(syncControlDbMock.execute).not.toHaveBeenCalled()
    SyncQueueRegistry[
      "sync-SaaS-service_account-per-user"
    ].domainCancelHandler = undefined
  })
})
