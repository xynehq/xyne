import { beforeEach, describe, expect, mock, test } from "bun:test"
import { importFresh } from "./syncControlTestHelpers"

const getWorkerStateMock = mock(() => ({
  workers: [{ targetId: "worker-1", workerGroup: "sync-slack" }],
}))
const pauseWorkerGroupMock = mock(
  async (workerGroup: string, count?: number) => ({
    workerGroup,
    requested: count ?? 1,
    affected: count ?? 1,
    results: [],
  }),
)
const resumeWorkerGroupMock = mock(
  async (workerGroup: string, count?: number) => ({
    workerGroup,
    requested: count ?? 1,
    affected: count ?? 1,
    results: [],
  }),
)

const loadRoutes = () =>
  importFresh<typeof import("@/sync-control/internalRoutes")>(
    "../sync-control/internalRoutes.ts",
  )

beforeEach(() => {
  process.env.METRICS_SECRET = "internal-secret"
  getWorkerStateMock.mockClear()
  pauseWorkerGroupMock.mockClear()
  resumeWorkerGroupMock.mockClear()
})

const deps = () => ({
  getWorkerState: getWorkerStateMock,
  pauseWorkerGroup: pauseWorkerGroupMock,
  resumeWorkerGroup: resumeWorkerGroupMock,
})

describe("sync-server internal sync-control auth", () => {
  test("rejects worker state reads when secret is missing", async () => {
    delete process.env.METRICS_SECRET
    const { buildInternalSyncControlRoutes } = await loadRoutes()

    const response = await buildInternalSyncControlRoutes(deps()).request(
      "/workers/state",
      { headers: { Authorization: "Bearer internal-secret" } },
    )

    expect(response.status).toBe(401)
    expect(getWorkerStateMock).not.toHaveBeenCalled()
  })

  test("rejects worker commands with bad bearer tokens", async () => {
    const { buildInternalSyncControlRoutes } = await loadRoutes()

    const response = await buildInternalSyncControlRoutes(deps()).request(
      "/workers/pause",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer wrong",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workerGroup: "sync-slack", count: 1 }),
      },
    )

    expect(response.status).toBe(401)
    expect(pauseWorkerGroupMock).not.toHaveBeenCalled()
  })

  test("allows worker state reads with the internal bearer token", async () => {
    const { buildInternalSyncControlRoutes } = await loadRoutes()

    const response = await buildInternalSyncControlRoutes(deps()).request(
      "/workers/state",
      { headers: { Authorization: "Bearer internal-secret" } },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      workers: [{ targetId: "worker-1", workerGroup: "sync-slack" }],
    })
    expect(getWorkerStateMock).toHaveBeenCalledTimes(1)
  })

  test("passes validated pause and resume commands to worker control", async () => {
    const { buildInternalSyncControlRoutes } = await loadRoutes()
    const app = buildInternalSyncControlRoutes(deps())

    await app.request("/workers/pause", {
      method: "POST",
      headers: {
        Authorization: "Bearer internal-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workerGroup: "sync-slack", count: 2 }),
    })
    await app.request("/workers/resume", {
      method: "POST",
      headers: {
        Authorization: "Bearer internal-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workerGroup: "sync-slack", count: 1 }),
    })

    expect(pauseWorkerGroupMock).toHaveBeenCalledWith("sync-slack", 2)
    expect(resumeWorkerGroupMock).toHaveBeenCalledWith("sync-slack", 1)
  })
})
