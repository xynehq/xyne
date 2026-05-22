import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import {
  AgentNotAccessibleError,
  ChatService,
  ConcurrentRunError,
  ConversationNotFoundError,
  ForbiddenError,
  MessageNotFoundError,
  viewerFromPayload,
} from "../services/chat"
import { agentDeps } from "../wiring"
import {
  asConversationId,
  asMessageId,
  asRunId,
  asFolderId,
  type Cursor,
  type MessageFeedbackRating,
  type StreamEvent,
} from "../storage/types"

type Vars = {
  jwtPayload: { sub: string; workspaceId: string }
}

const service = new ChatService(agentDeps())

const router = new Hono<{ Variables: Vars }>()

const viewer = (
  c: Context<{ Variables: Vars }>,
): ReturnType<typeof viewerFromPayload> =>
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
    if (err instanceof MessageNotFoundError) {
      throw new HTTPException(404, { message: err.message })
    }
    if (err instanceof ForbiddenError) {
      throw new HTTPException(403, { message: err.message })
    }
    if (err instanceof ConcurrentRunError) {
      throw new HTTPException(409, { message: err.message })
    }
    if (err instanceof AgentNotAccessibleError) {
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

// GET /v2/chat/conversations?folderId=&limit=&cursor=
// `folderId` scopes the result to conversations inside a specific project.
// Absent (or empty) = all conversations regardless of folder.
router.get("/conversations", (c) =>
  handle(c, async () => {
    const folderIdRaw = (c.req.query("folderId") ?? "").trim()
    const filter = folderIdRaw
      ? { folderId: asFolderId(folderIdRaw) }
      : undefined
    return service.listConversations(viewer(c), readCursor(c), filter)
  }),
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
      agentId?: string
      thinkingLevel?: string
    }
    if (!body.text) {
      throw new HTTPException(400, { message: "text required" })
    }
    const allowedLevels = ["minimal", "low", "medium", "high"] as const
    type ThinkingLevel = (typeof allowedLevels)[number]
    const thinkingLevel: ThinkingLevel | undefined = allowedLevels.includes(
      body.thinkingLevel as ThinkingLevel,
    )
      ? (body.thinkingLevel as ThinkingLevel)
      : undefined
    // DO NOT forward c.req.raw.signal. We want the pi-mono run to outlive
    // client disconnects (refresh, tab close, network blip) so the user can
    // resume by reattaching to the conversation's SSE stream — they get back
    // a partial answer instead of losing the whole turn. The run still ends
    // bounded by pi-mono's own timeouts. Explicit cancel is a separate
    // endpoint (TODO), not coupled to TCP teardown.
    return service.sendMessage(viewer(c), {
      conversationId: asConversationId(c.req.param("id")),
      text: body.text,
      ...(body.model ? { model: body.model } : {}),
      ...(body.agentId ? { agentId: body.agentId } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    })
  }),
)

// POST /v2/chat/conversations/:id/interrupt
router.post("/conversations/:id/interrupt", (c) =>
  handle(c, async () =>
    service.interrupt(viewer(c), asConversationId(c.req.param("id"))),
  ),
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

// GET /v2/chat/conversations/:id/runs/:parentRunId/nested  (M8)
// Returns every sub-agent run spawned under the given parent run plus
// the sub-agent's assistant messages (with blocks). Ordered by
// startedAt — the UI matches the Nth dispatchSubagent tool_call to
// the Nth entry in `nestedRuns`.
router.get("/conversations/:id/runs/:parentRunId/nested", (c) =>
  handle(c, async () =>
    service.listNestedRuns(
      viewer(c),
      asConversationId(c.req.param("id")),
      asRunId(c.req.param("parentRunId")),
    ),
  ),
)

// ─── Message feedback ────────────────────────────────────────────────────────
// PUT semantics — single endpoint upserts. Client always sends the desired
// final state; toggling like→dislike or editing tags/comment all hit this.
// DELETE retracts. GET reads the viewer's own rating (used to paint the
// filled icon state when a chat reloads).

const FEEDBACK_TAG_LIMIT = 16
const FEEDBACK_TAG_MAX_LEN = 64
const FEEDBACK_COMMENT_MAX_LEN = 4000

const parseFeedbackBody = (
  raw: unknown,
): {
  rating: MessageFeedbackRating
  tags?: string[]
  comment?: string
  shareChat?: boolean
} => {
  if (!raw || typeof raw !== "object") {
    throw new HTTPException(400, { message: "body required" })
  }
  const body = raw as Record<string, unknown>
  if (body["rating"] !== "like" && body["rating"] !== "dislike") {
    throw new HTTPException(400, {
      message: "rating must be 'like' or 'dislike'",
    })
  }
  const out: {
    rating: MessageFeedbackRating
    tags?: string[]
    comment?: string
    shareChat?: boolean
  } = { rating: body["rating"] }
  // Tags: cap count + length so a malicious client can't bloat the row.
  if (body["tags"] !== undefined) {
    if (!Array.isArray(body["tags"])) {
      throw new HTTPException(400, { message: "tags must be an array" })
    }
    const tags = body["tags"]
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && t.length <= FEEDBACK_TAG_MAX_LEN)
      .slice(0, FEEDBACK_TAG_LIMIT)
    out.tags = tags
  }
  if (body["comment"] !== undefined) {
    if (typeof body["comment"] !== "string") {
      throw new HTTPException(400, { message: "comment must be a string" })
    }
    const c = body["comment"].trim()
    if (c.length > 0) {
      out.comment = c.slice(0, FEEDBACK_COMMENT_MAX_LEN)
    }
  }
  if (body["shareChat"] !== undefined) {
    out.shareChat = Boolean(body["shareChat"])
  }
  return out
}

// PUT /v2/chat/conversations/:id/messages/:messageId/feedback
router.put("/conversations/:id/messages/:messageId/feedback", (c) =>
  handle(c, async () => {
    const body = parseFeedbackBody(await c.req.json().catch(() => null))
    return service.setMessageFeedback(
      viewer(c),
      asConversationId(c.req.param("id")),
      asMessageId(c.req.param("messageId")),
      body,
    )
  }),
)

// GET /v2/chat/conversations/:id/messages/:messageId/feedback
router.get("/conversations/:id/messages/:messageId/feedback", (c) =>
  handle(c, async () => {
    const fb = await service.getMessageFeedback(
      viewer(c),
      asConversationId(c.req.param("id")),
      asMessageId(c.req.param("messageId")),
    )
    return fb ?? { feedback: null }
  }),
)

// DELETE /v2/chat/conversations/:id/messages/:messageId/feedback
router.delete("/conversations/:id/messages/:messageId/feedback", (c) =>
  handle(c, async () => {
    const deleted = await service.deleteMessageFeedback(
      viewer(c),
      asConversationId(c.req.param("id")),
      asMessageId(c.req.param("messageId")),
    )
    return { deleted }
  }),
)

// GET /v2/chat/conversations/:id/stream  (SSE — live turn/block events)
router.get("/conversations/:id/stream", (c) => {
  const convId = asConversationId(c.req.param("id"))

  // Resume cursor — the browser's native EventSource sends the last id it
  // saw as `Last-Event-ID` on auto-reconnect. We also accept it as a query
  // param so clients without the auto-reconnect header (or doing a manual
  // explicit reopen) can pass one.
  const lastEventIdHeader =
    c.req.header("Last-Event-ID") ?? c.req.header("last-event-id")
  const sinceSeqQ = c.req.query("sinceSeq")
  const parsed = Number(lastEventIdHeader ?? sinceSeqQ ?? 0)
  const sinceSeq = Number.isFinite(parsed) && parsed > 0 ? parsed : 0

  return streamSSE(c, async (stream) => {
    type Pending = { event: StreamEvent; seq: number }
    const queue: Pending[] = []
    let waiter: (() => void) | null = null
    const wake = (): void => {
      const w = waiter
      waiter = null
      w?.()
    }

    let unsubscribe: (() => void) | null
    try {
      unsubscribe = await service.subscribe(
        viewer(c),
        convId,
        (event, seq) => {
          queue.push({ event, seq })
          wake()
        },
        { sinceSeq },
      )
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
            event: next.event.kind,
            data: JSON.stringify(next.event),
            // SSE `id:` field — the browser stores it; on auto-reconnect it
            // sends `Last-Event-ID: <id>` so we can resume from the cursor.
            id: String(next.seq),
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
