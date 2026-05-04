import { beforeEach, describe, expect, mock, test } from "bun:test"
import {
  importFresh,
  installLoggerMock,
  installSyncControlDbMock,
  resetSyncControlDbMock,
  rows,
  syncControlDbState,
} from "./syncControlTestHelpers"

installLoggerMock()

const workCalls: any[][] = []
const offWorkCalls: any[] = []
let pausedWorkerGroups = new Set<string>()
let pausedJobIds = new Set<string>()
let offWorkFailureIds = new Set<string>()

const bossMock = {
  work: mock(async (...args: any[]) => {
    workCalls.push(args)
    return `boss-worker-${workCalls.length}`
  }),
  offWork: mock(async (input: { id: string }) => {
    offWorkCalls.push(input)
    if (offWorkFailureIds.has(input.id)) {
      throw new Error(`failed offWork ${input.id}`)
    }
  }),
}

mock.module("@/queue/boss", () => ({ boss: bossMock }))
installSyncControlDbMock()

const loadWorkerControl = () =>
  importFresh<typeof import("@/sync-control/workerControl")>(
    "../sync-control/workerControl.ts",
  )

beforeEach(() => {
  workCalls.length = 0
  offWorkCalls.length = 0
  resetSyncControlDbMock()
  pausedWorkerGroups = new Set()
  pausedJobIds = new Set()
  offWorkFailureIds = new Set()
  syncControlDbState.executeFallback = rows([{ id: "deferred-job" }])
  syncControlDbState.activeControls = [
    ...[...pausedWorkerGroups].map((workerGroup, index) => ({
      id: index + 1,
      externalId: `worker-control-${workerGroup}`,
      workspaceId: null,
      scopeType: "worker_group",
      scopeValue: workerGroup,
      queueName: null,
      controlType: "pause",
      reason: "paused",
      createdByUserId: 1,
      createdByEmail: "admin@example.com",
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    })),
  ]
  bossMock.work.mockClear()
  bossMock.offWork.mockClear()
})

const refreshControls = () => {
  syncControlDbState.activeControls = [
    ...[...pausedWorkerGroups].map((workerGroup, index) => ({
      id: index + 1,
      externalId: `worker-control-${workerGroup}`,
      workspaceId: null,
      scopeType: "worker_group",
      scopeValue: workerGroup,
      queueName: null,
      controlType: "pause",
      reason: "paused",
      createdByUserId: 1,
      createdByEmail: "admin@example.com",
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    })),
    ...[...pausedJobIds].map((jobId, index) => ({
      id: index + 100,
      externalId: `job-control-${jobId}`,
      workspaceId: null,
      scopeType: "job",
      scopeValue: jobId,
      queueName: "sync-SaaS-service_account-per-user",
      controlType: "pause",
      reason: "paused",
      createdByUserId: 1,
      createdByEmail: "admin@example.com",
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    })),
  ]
}

describe("sync worker control", () => {
  test("does not fetch new jobs when a worker group starts paused", async () => {
    pausedWorkerGroups.add("sync-slack")
    refreshControls()
    const workerControl = await loadWorkerControl()

    const bossWorkerId = await workerControl.registerBossWorker({
      queueName: "sync-slack-oauth",
      workerGroup: "sync-slack",
      handler: async () => undefined,
    })

    expect(bossWorkerId).toBe("")
    expect(bossMock.work).not.toHaveBeenCalled()
    expect(workerControl.getWorkerState().workers[0]).toMatchObject({
      queueName: "sync-slack-oauth",
      workerGroup: "sync-slack",
      status: "paused",
    })
  })

  test("pause and resume respect count for local pg-boss workers", async () => {
    const workerControl = await loadWorkerControl()
    await workerControl.registerBossWorker({
      queueName: "sync-slack-oauth",
      workerGroup: "sync-slack",
      handler: async () => undefined,
    })
    await workerControl.registerBossWorker({
      queueName: "sync-slack-oauth-per-user",
      workerGroup: "sync-slack",
      handler: async () => undefined,
    })
    await workerControl.registerBossWorker({
      queueName: "sync-SaaS-service_account-per-user",
      workerGroup: "sync-service-account-per-user",
      handler: async () => undefined,
    })

    const pauseResult = await workerControl.pauseWorkerGroup("sync-slack", 1)
    expect(pauseResult.affected).toBe(1)
    expect(offWorkCalls).toEqual([{ id: "boss-worker-1" }])
    expect(
      workerControl
        .getWorkerState()
        .workers.filter((worker) => worker.workerGroup === "sync-slack"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "paused" }),
        expect.objectContaining({ status: "running" }),
      ]),
    )

    const resumeResult = await workerControl.resumeWorkerGroup("sync-slack", 1)
    expect(resumeResult.affected).toBe(1)
    expect(workCalls).toHaveLength(4)
  })

  test("wrapped handlers defer the whole batch when any job is blocked", async () => {
    pausedJobIds.add("deferred-job")
    refreshControls()
    const handler = mock(async (jobs: any[]) => jobs.map((job) => job.id))
    const workerControl = await loadWorkerControl()

    await workerControl.registerBossWorker({
      queueName: "sync-SaaS-service_account-per-user",
      workerGroup: "sync-service-account-per-user",
      workOptions: { batchSize: 2 },
      handler,
    })
    const wrappedHandler = workCalls[0]?.[2]
    const result = await wrappedHandler([
      { id: "allowed-job", data: { email: "ok@example.com" } },
      { id: "deferred-job", data: { email: "paused@example.com" } },
    ])

    expect(handler).not.toHaveBeenCalled()
    expect(result).toBeUndefined()
  })

  test("returns partial success when some local workers fail to pause", async () => {
    const workerControl = await loadWorkerControl()
    await workerControl.registerBossWorker({
      queueName: "sync-slack-oauth",
      workerGroup: "sync-slack",
      handler: async () => undefined,
    })
    await workerControl.registerBossWorker({
      queueName: "sync-slack-oauth-per-user",
      workerGroup: "sync-slack",
      handler: async () => undefined,
    })
    offWorkFailureIds.add("boss-worker-1")

    const result = await workerControl.pauseWorkerGroup("sync-slack")

    expect(result.affected).toBe(1)
    expect(result.results).toEqual([
      expect.objectContaining({ status: "failed", workerId: "boss-worker-1" }),
      expect.objectContaining({ status: "paused", workerId: "boss-worker-2" }),
    ])
  })

  test("sends targeted thread IPC and records acknowledgements", async () => {
    const workerControl = await loadWorkerControl()
    const thread = {
      postMessage: mock((message: any) => {
        queueMicrotask(() => {
          workerControl.handleThreadWorkerMessage({
            type: "worker-paused",
            requestId: message.requestId,
            childId: message.childId,
            bossWorkerId: "thread-boss-2",
          })
        })
      }),
    }
    workerControl.registerThreadWorker({
      childId: "file-processing:1",
      workerGroup: "file-processing",
      thread: thread as any,
    })
    workerControl.handleThreadWorkerMessage({
      status: "initialized",
      childId: "file-processing:1",
      workerStatus: "running",
      bossWorkerId: "thread-boss-1",
    })

    const result = await workerControl.pauseWorkerGroup("file-processing", 1)

    expect(thread.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "pause-worker",
        childId: "file-processing:1",
        workerGroup: "file-processing",
      }),
    )
    expect(result).toMatchObject({
      requested: 1,
      affected: 1,
      results: [
        {
          targetId: "file-processing:1",
          status: "paused",
          workerId: "thread-boss-2",
        },
      ],
    })
    expect(workerControl.getWorkerState().workers[0]).toMatchObject({
      status: "paused",
      bossWorkerId: "thread-boss-2",
    })
  })

  test("thread command failures are returned without failing the whole command", async () => {
    const workerControl = await loadWorkerControl()
    const thread = {
      postMessage: mock((message: any) => {
        queueMicrotask(() => {
          workerControl.handleThreadWorkerMessage({
            type: "worker-command-failed",
            requestId: message.requestId,
            childId: message.childId,
            error: "worker refused command",
          })
        })
      }),
    }
    workerControl.registerThreadWorker({
      childId: "file-processing:1",
      workerGroup: "file-processing",
      thread: thread as any,
    })
    workerControl.handleThreadWorkerMessage({
      status: "initialized",
      childId: "file-processing:1",
      workerStatus: "running",
      bossWorkerId: "thread-boss-1",
    })

    const result = await workerControl.pauseWorkerGroup("file-processing", 1)

    expect(result).toMatchObject({
      affected: 0,
      results: [
        {
          targetId: "file-processing:1",
          status: "failed",
          error: "worker refused command",
        },
      ],
    })
  })
})
