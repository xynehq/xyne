import { beforeEach, describe, expect, mock, test } from "bun:test"
import {
  adminActor,
  installSyncControlDbMock,
  resetSyncControlDbMock,
  rows,
  superAdminActor,
  syncControlDbMock,
  syncControlDbState,
} from "./syncControlTestHelpers"

type ControlRow = {
  id: number
  externalId: string
  workspaceId: number | null
  scopeType: string
  scopeValue: string
  queueName: string | null
  controlType: "pause" | "cancel"
  reason: string
  createdByUserId: number
  createdByEmail: string
  expiresAt: Date | null
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

let controls: ControlRow[] = []
let nextId = 1
const activeControls = () => {
  const now = Date.now()
  return controls.filter(
    (control) =>
      !control.deletedAt &&
      (!control.expiresAt || control.expiresAt.getTime() > now),
  )
}

installSyncControlDbMock()

const controlState = await import("@/sync-control/controlState")

const baseControl = (overrides: Partial<ControlRow> = {}): ControlRow => ({
  id: nextId++,
  externalId: `seed-${nextId}`,
  workspaceId: 10,
  scopeType: "email",
  scopeValue: "person@example.com",
  queueName: "sync-SaaS-service_account-per-user",
  controlType: "pause",
  reason: "test",
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
  controls = []
  nextId = 1
})

describe("sync control state", () => {
  test("creates pause and cancel controls with actor metadata", async () => {
    const pause = await controlState.createPauseControl(
      {
        workspaceId: adminActor.workspaceId,
        scopeType: "email",
        scopeValue: "person@example.com",
        queueName: "sync-SaaS-service_account-per-user",
        reason: "maintenance",
      },
      adminActor,
    )
    const cancel = await controlState.createCancelControl(
      {
        workspaceId: adminActor.workspaceId,
        scopeType: "job",
        scopeValue: "job-1",
        queueName: "sync-SaaS-service_account-per-user",
        reason: "requested",
      },
      adminActor,
    )

    expect(pause.controlType).toBe("pause")
    expect(cancel.controlType).toBe("cancel")
    expect(pause.createdByEmail).toBe(adminActor.email)
    expect(cancel.createdByUserId).toBe(adminActor.userId)
  })

  test("resume soft-deletes pause controls without creating resumed rows", async () => {
    controls.push(
      baseControl({ controlType: "pause" }),
      baseControl({
        controlType: "cancel",
        scopeType: "job",
        scopeValue: "job-1",
      }),
    )
    syncControlDbState.activeControls = activeControls()

    const resumedCount = await controlState.resumeControls(
      {
        workspaceId: adminActor.workspaceId,
        scopeType: "email",
        scopeValue: "person@example.com",
        queueName: "sync-SaaS-service_account-per-user",
      },
      adminActor,
    )

    expect(resumedCount).toBe(1)
    expect(
      controls.filter((control) => control.controlType === "pause")[0]
        ?.deletedAt,
    ).toBeInstanceOf(Date)
    expect(
      controls.some((control) => (control.controlType as string) === "resumed"),
    ).toBe(false)
    expect(
      controls.find((control) => control.controlType === "cancel")?.deletedAt,
    ).toBeNull()
  })

  test("ignores expired and soft-deleted controls when matching jobs", async () => {
    controls.push(
      baseControl({ scopeValue: "person@example.com" }),
      baseControl({
        scopeValue: "expired@example.com",
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
      }),
      baseControl({
        scopeValue: "deleted@example.com",
        deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    )
    syncControlDbState.activeControls = activeControls()

    const matches = await controlState.getMatchingControls({
      queueName: "sync-SaaS-service_account-per-user",
      jobData: { email: "person@example.com" },
      actor: adminActor,
    })

    expect(matches).toHaveLength(1)
    expect(matches[0]?.scopeValue).toBe("person@example.com")
  })

  test("applies workspace visibility differently for Admin and SuperAdmin", async () => {
    controls.push(
      baseControl({ workspaceId: 10, scopeValue: "person@example.com" }),
      baseControl({ workspaceId: 20, scopeValue: "person@example.com" }),
      baseControl({ workspaceId: null, scopeType: "global", scopeValue: "*" }),
    )
    syncControlDbState.activeControls = activeControls()

    const adminMatches = await controlState.getMatchingControls({
      queueName: "sync-SaaS-service_account-per-user",
      jobData: { email: "person@example.com", workspaceId: 10 },
      actor: adminActor,
    })
    const superMatches = await controlState.getMatchingControls({
      queueName: "sync-SaaS-service_account-per-user",
      jobData: { email: "person@example.com", workspaceId: 10 },
      actor: superAdminActor,
    })

    const sortWorkspaceIds = (ids: Array<number | null>) =>
      ids.sort((a, b) => (a ?? -1) - (b ?? -1))
    expect(
      sortWorkspaceIds(adminMatches.map((control) => control.workspaceId)),
    ).toEqual([null, 10])
    expect(
      sortWorkspaceIds(superMatches.map((control) => control.workspaceId)),
    ).toEqual([null, 10])
  })

  test("fails closed for workspace-scoped controls when job workspace is unknown", async () => {
    controls.push(
      baseControl({ workspaceId: 10, scopeValue: "person@example.com" }),
      baseControl({ workspaceId: null, scopeType: "global", scopeValue: "*" }),
    )
    syncControlDbState.activeControls = activeControls()

    const matches = await controlState.getMatchingControls({
      queueName: "sync-SaaS-service_account-per-user",
      jobData: { email: "person@example.com" },
      actor: adminActor,
    })

    expect(matches.map((control) => control.workspaceId)).toEqual([null])
  })

  test("hydrates KB file controls before collection and email matching", async () => {
    syncControlDbState.executeQueue = [
      rows([
        {
          collectionId: "collection-1",
          email: "uploader@example.com",
          workspaceId: adminActor.workspaceId,
        },
      ]),
    ]
    controls.push(
      baseControl({
        scopeType: "collection",
        scopeValue: "collection-1",
        queueName: "file-processing",
      }),
      baseControl({
        scopeType: "email",
        scopeValue: "uploader@example.com",
        queueName: "file-processing",
      }),
    )
    syncControlDbState.activeControls = activeControls()

    const matches = await controlState.getMatchingControls({
      queueName: "file-processing",
      jobData: { fileId: "file-1" },
      actor: adminActor,
    })

    expect(syncControlDbMock.execute).toHaveBeenCalledTimes(1)
    expect(matches.map((control) => control.scopeType).sort()).toEqual([
      "collection",
      "email",
    ])
  })

  test("reports queue, worker, and job pause state", async () => {
    controls.push(
      baseControl({
        scopeType: "queue",
        scopeValue: "sync-slack-oauth",
        queueName: "sync-slack-oauth",
      }),
      baseControl({
        scopeType: "worker_group",
        scopeValue: "sync-slack",
        queueName: null,
      }),
      baseControl({
        scopeType: "job",
        scopeValue: "job-1",
        controlType: "cancel",
      }),
    )
    syncControlDbState.activeControls = activeControls()

    await expect(controlState.isQueuePaused("sync-slack-oauth")).resolves.toBe(
      true,
    )
    await expect(controlState.isWorkerGroupPaused("sync-slack")).resolves.toBe(
      true,
    )
    await expect(
      controlState.isJobPausedOrCancelled({
        queueName: "sync-SaaS-service_account-per-user",
        jobData: { email: "person@example.com" },
        jobId: "job-1",
      }),
    ).resolves.toMatchObject({ cancelled: true })
  })
})
