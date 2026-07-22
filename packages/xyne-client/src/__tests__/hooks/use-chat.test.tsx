import { act, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { XyneProvider } from "../../components/xyne-provider"
import type { ChatStreamEvent } from "../../core/types"
import { useChat } from "../../hooks/use-chat"

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

const mockFetch =
  vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()

function wrapper({ children }: { children: ReactNode }) {
  return (
    <XyneProvider
      baseUrl="https://api.test.com/sdk"
      token="test-token"
      onTokenExpired={async () => "refreshed"}
    >
      {children}
    </XyneProvider>
  )
}

describe("useChat", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("starts with empty state", () => {
    const { result } = renderHook(() => useChat(), { wrapper })

    expect(result.current.messages).toEqual([])
    expect(result.current.isStreaming).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it("sends a message and receives streamed response", async () => {
    mockFetch.mockResolvedValueOnce(
      makeSseResponse([
        { type: "text", content: "Hello " },
        { type: "text", content: "world" },
        { type: "done" },
      ]),
    )

    const { result } = renderHook(() => useChat(), { wrapper })

    await act(async () => {
      result.current.sendMessage("hi")
    })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0]?.role).toBe("user")
    expect(result.current.messages[0]?.content).toBe("hi")
    expect(result.current.messages[0]?.status).toBe("complete")

    expect(result.current.messages[1]?.role).toBe("assistant")
    expect(result.current.messages[1]?.content).toBe("Hello world")
    expect(result.current.messages[1]?.status).toBe("complete")
    expect(result.current.isStreaming).toBe(false)
  })

  it("handles sources in stream", async () => {
    mockFetch.mockResolvedValueOnce(
      makeSseResponse([
        { type: "text", content: "Answer" },
        {
          type: "sources",
          sources: [{ docId: "d1", title: "Doc", score: 0.9 }],
        },
        { type: "done" },
      ]),
    )

    const { result } = renderHook(() => useChat(), { wrapper })

    await act(async () => {
      result.current.sendMessage("question")
    })

    const assistant = result.current.messages[1]!
    expect(assistant.sources).toHaveLength(1)
    expect(assistant.sources?.[0]?.title).toBe("Doc")
  })

  it("handles error events from stream", async () => {
    mockFetch.mockResolvedValueOnce(
      makeSseResponse([{ type: "error", content: "Something broke" }]),
    )

    const { result } = renderHook(() => useChat(), { wrapper })

    await act(async () => {
      result.current.sendMessage("bad query")
    })

    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.error?.message).toBe("Something broke")
    expect(result.current.messages[1]?.status).toBe("error")
    expect(result.current.isStreaming).toBe(false)
  })

  it("handles fetch errors", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"))

    const { result } = renderHook(() => useChat(), { wrapper })

    await act(async () => {
      result.current.sendMessage("test")
    })

    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.messages[1]?.status).toBe("error")
    expect(result.current.isStreaming).toBe(false)
  })

  it("ignores empty/whitespace messages", async () => {
    const { result } = renderHook(() => useChat(), { wrapper })

    await act(async () => {
      result.current.sendMessage("   ")
    })

    expect(result.current.messages).toHaveLength(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("clears messages", async () => {
    mockFetch.mockResolvedValueOnce(
      makeSseResponse([{ type: "text", content: "hi" }, { type: "done" }]),
    )

    const { result } = renderHook(() => useChat(), { wrapper })

    await act(async () => {
      result.current.sendMessage("test")
    })
    expect(result.current.messages).toHaveLength(2)

    act(() => {
      result.current.clearMessages()
    })

    expect(result.current.messages).toHaveLength(0)
    expect(result.current.error).toBeNull()
  })
})
