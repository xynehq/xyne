import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { XyneApiError, XyneAuthError } from "../../core/errors"
import type { ChatStreamEvent } from "../../core/types"
import { XyneClient } from "../../core/xyne-client"

function makeSseResponse(events: ChatStreamEvent[]): Response {
  const encoder = new TextEncoder()
  const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("XyneClient", () => {
  const mockFetch =
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function createClient(overrides?: {
    onTokenExpired?: () => Promise<string>
  }) {
    return new XyneClient({
      baseUrl: "https://api.test.com/sdk",
      token: "initial-token",
      onTokenExpired:
        overrides?.onTokenExpired ?? (async () => "refreshed-token"),
    })
  }

  describe("chat", () => {
    it("sends POST with auth header and streams events", async () => {
      const sseEvents: ChatStreamEvent[] = [
        { type: "text", content: "hello" },
        { type: "done" },
      ]
      mockFetch.mockResolvedValueOnce(makeSseResponse(sseEvents))

      const client = createClient()
      const events: ChatStreamEvent[] = []
      for await (const event of client.chat("test query")) {
        events.push(event)
      }

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, init] = mockFetch.mock.calls[0]!
      expect(url).toBe("https://api.test.com/sdk/chat")
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
        "Bearer initial-token",
      )
      expect(JSON.parse(init?.body as string)).toEqual({ query: "test query" })
      expect(events).toHaveLength(2)
      expect(events[0]?.type).toBe("text")
      expect(events[1]?.type).toBe("done")
    })
  })

  describe("search", () => {
    it("sends POST and returns parsed JSON", async () => {
      const body = {
        results: [{ docId: "d1", title: "T", score: 0.9, content: "text" }],
      }
      mockFetch.mockResolvedValueOnce(makeJsonResponse(body))

      const client = createClient()
      const result = await client.search("test")

      expect(result.results).toHaveLength(1)
      expect(result.results[0]?.docId).toBe("d1")
    })
  })

  describe("token refresh", () => {
    it("retries on 401 with refreshed token", async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeJsonResponse({ error: "Token expired" }, 401),
        )
        .mockResolvedValueOnce(
          makeJsonResponse({
            results: [{ docId: "d1", title: "T", score: 1, content: "c" }],
          }),
        )

      const onTokenExpired = vi.fn(async () => "new-token")
      const client = createClient({ onTokenExpired })
      const result = await client.search("test")

      expect(onTokenExpired).toHaveBeenCalledOnce()
      expect(result.results).toHaveLength(1)
      // Second call should use new token
      const secondCall = mockFetch.mock.calls[1]!
      expect(
        (secondCall[1]?.headers as Record<string, string>)["Authorization"],
      ).toBe("Bearer new-token")
    })

    it("throws XyneAuthError if refresh also returns 401", async () => {
      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({ error: "expired" }, 401))
        .mockResolvedValueOnce(
          makeJsonResponse({ error: "still expired" }, 401),
        )

      const client = createClient()
      await expect(client.search("test")).rejects.toThrow(XyneAuthError)
    })

    it("deduplicates concurrent refresh calls", async () => {
      let resolveRefresh: ((token: string) => void) | undefined
      const onTokenExpired = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveRefresh = resolve
          }),
      )

      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({ error: "expired" }, 401))
        .mockResolvedValueOnce(makeJsonResponse({ error: "expired" }, 401))
        .mockImplementation(() =>
          Promise.resolve(
            makeJsonResponse({
              results: [{ docId: "d1", title: "T", score: 1, content: "c" }],
            }),
          ),
        )

      const client = createClient({ onTokenExpired })
      const p1 = client.search("q1")
      const p2 = client.search("q2")

      // Both requests are waiting for refresh
      await vi.waitFor(() => expect(resolveRefresh).toBeDefined())
      resolveRefresh?.("shared-token")

      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1.results).toHaveLength(1)
      expect(r2.results).toHaveLength(1)
      expect(onTokenExpired).toHaveBeenCalledOnce()
    })
  })

  describe("error handling", () => {
    it("throws XyneApiError on non-401 error", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ error: "Bad request" }, 400),
      )

      const client = createClient()
      try {
        await client.search("test")
        expect.fail("Should have thrown")
      } catch (err) {
        expect(err).toBeInstanceOf(XyneApiError)
        expect((err as XyneApiError).status).toBe(400)
      }
    })
  })

  describe("setToken", () => {
    it("updates token for subsequent requests", async () => {
      mockFetch.mockResolvedValue(makeJsonResponse({ results: [] }))

      const client = createClient()
      client.setToken("updated-token")
      await client.search("test")

      const [, init] = mockFetch.mock.calls[0]!
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
        "Bearer updated-token",
      )
    })
  })
})
