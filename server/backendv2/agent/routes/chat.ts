import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import {
  ChatService,
  ConversationNotFoundError,
  ForbiddenError,
  viewerFromPayload,
} from "../services/chat"
import { agentDeps } from "../wiring"
import {
  asConversationId,
  type Cursor,
  type StreamEvent,
} from "../storage/types"

type Vars = {
  jwtPayload: { sub: string; workspaceId: string }
}

const service = new ChatService(agentDeps())

const router = new Hono<{ Variables: Vars }>()

const viewer = (c: Context<{ Variables: Vars }>): ReturnType<typeof viewerFromPayload> =>
  viewerFromPayload(c.get("jwtPayload"))

const readCursor = (c: Context): Cursor => {
  const limitRaw = c.req.query("limit")
  const limit = Math.max(
    1,
    Math.min(Number.parseInt(limitRaw ?? "50", 10) || 50, 200),
  )
  const token = c.req.query("cursor")
  if (token) {
    return { kind: "after", token, limit }
  }
  return { kind: "first", limit }
}

const handle = async (
  c: Context,
  fn: () => Promise<Response | object>,
): Promise<Response> => {
  try {
    const result = await fn()
    if (result instanceof Response) {
      return result
    }
    return c.json(result)
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      throw new HTTPException(404, { message: err.message })
    }
    if (err instanceof ForbiddenError) {
      throw new HTTPException(403, { message: err.message })
    }
    if (err instanceof HTTPException) {
      throw err
    }
    const message = err instanceof Error ? err.message : "Internal error"
    throw new HTTPException(500, { message })
  }
}

// POST /v2/chat/conversations
router.post("/conversations", (c) =>
  handle(c, async () => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string }
    const conv = await service.createConversation(
      viewer(c),
      body.title ?? "New chat",
    )
    return conv
  }),
)

// GET /v2/chat/conversations
router.get("/conversations", (c) =>
  handle(c, async () => service.listConversations(viewer(c), readCursor(c))),
)

// GET /v2/chat/conversations/:id
router.get("/conversations/:id", (c) =>
  handle(c, async () =>
    service.getConversation(viewer(c), asConversationId(c.req.param("id"))),
  ),
)

// PATCH /v2/chat/conversations/:id  (rename)
router.patch("/conversations/:id", (c) =>
  handle(c, async () => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string }
    if (!body.title) {
      throw new HTTPException(400, { message: "title required" })
    }
    await service.renameConversation(
      viewer(c),
      asConversationId(c.req.param("id")),
      body.title,
    )
    return { ok: true }
  }),
)

// DELETE /v2/chat/conversations/:id  (soft delete / archive)
router.delete("/conversations/:id", (c) =>
  handle(c, async () => {
    await service.archiveConversation(
      viewer(c),
      asConversationId(c.req.param("id")),
    )
    return { ok: true }
  }),
)

// POST /v2/chat/conversations/:id/messages
router.post("/conversations/:id/messages", (c) =>
  handle(c, async () => {
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: string
      model?: string
    }
    if (!body.text) {
      throw new HTTPException(400, { message: "text required" })
    }
    return service.sendMessage(viewer(c), {
      conversationId: asConversationId(c.req.param("id")),
      text: body.text,
      ...(body.model ? { model: body.model } : {}),
    })
  }),
)

// GET /v2/chat/conversations/:id/messages
router.get("/conversations/:id/messages", (c) =>
  handle(c, async () =>
    service.listMessages(
      viewer(c),
      asConversationId(c.req.param("id")),
      readCursor(c),
    ),
  ),
)

// GET /v2/chat/conversations/:id/stream  (SSE — live turn/block events)
router.get("/conversations/:id/stream", (c) => {
  const convId = asConversationId(c.req.param("id"))
  return streamSSE(c, async (stream) => {
    const queue: StreamEvent[] = []
    let waiter: (() => void) | null = null
    const wake = (): void => {
      const w = waiter
      waiter = null
      w?.()
    }

    let unsubscribe: (() => void) | null
    try {
      unsubscribe = await service.subscribe(viewer(c), convId, (event) => {
        queue.push(event)
        wake()
      })
    } catch (err) {
      if (err instanceof ConversationNotFoundError) {
        throw new HTTPException(404, { message: err.message })
      }
      if (err instanceof ForbiddenError) {
        throw new HTTPException(403, { message: err.message })
      }
      throw err
    }

    const pingTimer = setInterval(() => {
      if (!stream.closed) {
        stream
          .writeSSE({ event: "ping", data: String(Date.now()) })
          .catch(() => {})
      }
    }, 15000)

    await stream.writeSSE({ event: "ready", data: "" })

    const abort = c.req.raw.signal
    let aborted = abort.aborted
    abort.addEventListener("abort", () => {
      aborted = true
      wake()
    })

    try {
      while (!aborted && !stream.closed) {
        const next = queue.shift()
        if (next) {
          await stream.writeSSE({
            event: next.kind,
            data: JSON.stringify(next),
          })
          continue
        }
        await new Promise<void>((resolve) => {
          waiter = resolve
        })
      }
    } finally {
      clearInterval(pingTimer)
      unsubscribe()
    }
  })
})

export default router
