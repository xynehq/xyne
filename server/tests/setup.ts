import { beforeAll, mock } from "bun:test"

beforeAll(() => {
  const mockPinoLogger = {
    error: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    debug: mock(() => {}),
    child: () => mockPinoLogger,
  }

  mock.module("../logger", () => ({
    getLogger: () => mockPinoLogger,
    LogMiddleware: () => {
      return async (c: any, next: () => any) => {
        await next()
      }
    },
  }))
})
