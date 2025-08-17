import {
  describe,
  expect,
  test,
  beforeAll,
  mock,
  beforeEach,
  afterAll,
} from "bun:test"
import config from "@/config"
import VespaClient from "@xyne/vespa-ts/client"

// mocking at top before importing vespaClient
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

describe("VespaClient", () => {
  let vespaClient: VespaClient
  const endpoint = `http://${config.vespaBaseHost}:8080`
  const mockPayload = {
    yql: "select * from sources * where true",
    query: "What is Vespa?",
    email: "user@example.com",
    "ranking.profile": "default",
    "input.query(e)": "embed(What is Vespa?)",
    hits: 10,
    alpha: 0.5,
    offset: 20,
    app: "searchApp",
    entity: "knowledgeBase",
  }

  mock.module("../config", () => ({
    vespaMaxRetryAttempts: 3,
    vespaRetryDelay: 100,
  }))

  beforeAll(() => {
    vespaClient = new VespaClient(endpoint)
  })

  afterAll(() => {
    mock.restore()
  })

  test("search should succeed on first attempt", async () => {
    const mockResponse = {
      root: {
        fields: { totalCount: 1 },
      },
    }

    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      ),
    )

    const result = await vespaClient.search(mockPayload)

    expect(result).toEqual(mockResponse)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledWith(
      `http://${config.vespaBaseHost}:8080/search/`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(mockPayload),
      },
    )
  })

  test("search should not retry on 404", async () => {
    global.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    )

    try {
      await vespaClient.search(mockPayload)
      // Should throw an error
    } catch (error: any) {
      expect(error.message).toInclude("Vespa search error")
      expect(global.fetch).toHaveBeenCalledTimes(1)
    }
  })

  test("search should retry on 500 up to maxRetries", async () => {
    global.fetch = mock(() =>
      Promise.resolve(new Response("Server Error", { status: 500 })),
    )

    // Mock setTimeout to speed up tests
    // @ts-ignore
    global.setTimeout = mock((fn) => {
      fn()
      return 0 as any
    })

    try {
      await vespaClient.search(mockPayload)
      throw new Error("Should have thrown an error")
    } catch (error: any) {
      expect(error.message).toInclude("Vespa search error")
      // Initial request + 3 retries
      expect(global.fetch).toHaveBeenCalledTimes(
        config.vespaMaxRetryAttempts + 1,
      )
    }
  })

  test("search should succeed after initial failure", async () => {
    const mockResponse = {
      root: {
        fields: { totalCount: 1 },
      },
    }

    global.fetch = mock()
      .mockImplementationOnce(() =>
        Promise.resolve(new Response("Server Error", { status: 500 })),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(JSON.stringify(mockResponse), { status: 200 }),
        ),
      )

    // Mock setTimeout to speed up tests
    // @ts-ignore
    global.setTimeout = mock((fn) => {
      fn()
      return 0 as any
    })

    const result = await vespaClient.search(mockPayload)

    expect(result).toEqual(mockResponse)
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })
})
