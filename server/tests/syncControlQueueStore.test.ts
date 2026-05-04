import { beforeEach, describe, expect, mock, test } from "bun:test"
import {
  adminActor,
  importFresh,
  installSyncControlDbMock,
  resetSyncControlDbMock,
  rows,
  syncControlDbMock,
  syncControlDbState,
} from "./syncControlTestHelpers"

const bossMock = {
  cancel: mock(async (_queueName: string, ids: string[]) => ids.length),
  deleteJob: mock(async (_queueName: string, ids: string[]) => ids.length),
}

installSyncControlDbMock()
mock.module("@/queue/boss", () => ({ boss: bossMock }))

const loadQueueStore = () =>
  importFresh<typeof import("@/sync-control/queueStore")>(
    "../sync-control/queueStore.ts",
  )

beforeEach(() => {
  resetSyncControlDbMock()
  bossMock.cancel.mockClear()
  bossMock.deleteJob.mockClear()
})

describe("sync control queue store", () => {
  test("rejects unsupported queue filters before executing SQL", async () => {
    const queueStore = await loadQueueStore()

    await expect(
      queueStore.listJobs({
        queueName: "sync-SaaS-service_account-per-user",
        filters: { unknownFilter: "value" },
        actor: adminActor,
      }),
    ).rejects.toThrow(
      "Unsupported filter 'unknownFilter' for queue 'sync-SaaS-service_account-per-user'",
    )
    expect(syncControlDbMock.execute).not.toHaveBeenCalled()
  })

  test("requires a queue name when filters are supplied", async () => {
    const queueStore = await loadQueueStore()

    await expect(
      queueStore.countJobs({
        filters: { email: "person@example.com" },
        actor: adminActor,
      }),
    ).rejects.toThrow("queueName is required when filters are supplied")
    expect(syncControlDbMock.execute).not.toHaveBeenCalled()
  })

  test("state split helpers never manufacture missing active jobs", async () => {
    syncControlDbState.executeQueue = [
      rows([
        {
          id: "created-1",
          queueName: "sync-SaaS-service_account-per-user",
          state: "created",
        },
        {
          id: "active-1",
          queueName: "sync-SaaS-service_account-per-user",
          state: "active",
        },
      ]),
    ]
    const queueStore = await loadQueueStore()

    const split = await queueStore.splitJobsByState(
      "sync-SaaS-service_account-per-user",
      ["created-1", "active-1"],
    )

    expect(split.created.map((job) => job.id)).toEqual(["created-1"])
    expect(split.active.map((job) => job.id)).toEqual(["active-1"])
    expect(split.failed).toEqual([])
  })
})
