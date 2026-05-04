import { mock } from "bun:test"
import type { Actor, PgBossJobState, QueueJobRow } from "@/sync-control/types"

export const adminActor: Actor = {
  userId: 1,
  email: "admin@example.com",
  workspaceId: 10,
  workspaceExternalId: "workspace-admin",
  role: "Admin" as any,
  isSuperAdmin: false,
}

export const superAdminActor: Actor = {
  userId: 2,
  email: "root@example.com",
  workspaceId: 99,
  workspaceExternalId: "workspace-root",
  role: "SuperAdmin" as any,
  isSuperAdmin: true,
}

export const makeJob = (
  id: string,
  state: PgBossJobState,
  overrides: Partial<QueueJobRow> = {},
): QueueJobRow => ({
  id,
  queueName: "sync-SaaS-service_account-per-user",
  state,
  priority: 0,
  data: {},
  retryLimit: 0,
  retryCount: 0,
  startAfter: null,
  startedOn: state === "active" ? new Date("2026-01-01T00:00:00.000Z") : null,
  createdOn: new Date("2026-01-01T00:00:00.000Z"),
  completedOn: null,
  singletonKey: null,
  ...overrides,
})

export const importFresh = <T>(path: string) =>
  import(`${path}?syncControlTest=${Date.now()}-${Math.random()}`) as Promise<T>

export const mockLogger = {
  error: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  debug: mock(() => {}),
  child() {
    return mockLogger
  },
}

export const installLoggerMock = () => {
  mock.module("@/logger", () => ({
    getLogger: () => mockLogger,
    getLoggerWithChild: () => () => mockLogger,
    LogMiddleware: () => async (_c: any, next: () => Promise<void>) => next(),
  }))
}

export const makeJsonContext = ({
  email = adminActor.email,
  body = {},
  query = {},
  headers = {},
}: {
  email?: string
  body?: Record<string, unknown>
  query?: Record<string, unknown>
  headers?: Record<string, string | undefined>
} = {}) => {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )

  return {
    get: (key: string) => (key === "jwtPayload" ? { sub: email } : undefined),
    req: {
      valid: (target: "json" | "query") => (target === "json" ? body : query),
      header: (name: string) => normalizedHeaders.get(name.toLowerCase()),
    },
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  } as any
}

export const readJson = async <T = any>(response: Response): Promise<T> =>
  response.json() as Promise<T>

export const syncControlDbState = {
  activeControls: [] as any[],
  executeQueue: [] as unknown[],
  executeFallback: { rows: [] } as unknown,
  inserts: [] as any[],
}

export const syncControlDbMock = {
  insert: mock(() => ({
    values: (values: any) => ({
      returning: async () => {
        syncControlDbState.inserts.push(values)
        return [{ id: syncControlDbState.inserts.length, ...values }]
      },
    }),
  })),
  update: mock(() => ({
    set: (values: any) => ({
      where: () => ({
        returning: async () => {
          const targets = syncControlDbState.activeControls.length
            ? syncControlDbState.activeControls.filter(
                (row) => row.controlType !== "cancel",
              )
            : [{ id: 1 }]
          for (const row of targets) {
            Object.assign(row, values)
          }
          return targets.map((row) => ({ ...row, ...values }))
        },
      }),
    }),
  })),
  select: mock(() => ({
    from: () => {
      const whereResult = {
        orderBy: () => ({
          limit: async () => [],
        }),
        limit: async () => syncControlDbState.activeControls,
        returning: async () => syncControlDbState.activeControls,
        then: (resolve: any, reject: any) =>
          Promise.resolve(syncControlDbState.activeControls).then(
            resolve,
            reject,
          ),
      }
      return {
        where: () => whereResult,
        orderBy: () => ({
          limit: async () => [],
        }),
      }
    },
  })),
  execute: mock(async () =>
    syncControlDbState.executeQueue.length
      ? syncControlDbState.executeQueue.shift()
      : syncControlDbState.executeFallback,
  ),
}

export const installSyncControlDbMock = () => {
  mock.module("@/db/client", () => ({
    db: syncControlDbMock,
    closeDbClient: async () => undefined,
  }))
}

export const resetSyncControlDbMock = () => {
  syncControlDbState.activeControls = []
  syncControlDbState.executeQueue = []
  syncControlDbState.executeFallback = { rows: [] }
  syncControlDbState.inserts = []
  syncControlDbMock.insert.mockClear()
  syncControlDbMock.update.mockClear()
  syncControlDbMock.select.mockClear()
  syncControlDbMock.execute.mockClear()
}

export const rows = (rows: unknown[]) => ({ rows })
export const countRows = (count: number) => rows([{ count }])
