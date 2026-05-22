// HTTP adapter for FoldersService — exposes the Projects feature under
// /v2/folders/*. Membership operations (add/remove a conversation to/from
// a folder) live under /v2/folders/:folderId/conversations/:conversationId
// per the API design: the folders router is the single owner of the
// conversation↔folder relationship endpoints.

import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"

import {
  FolderForbiddenError,
  FolderNotFoundError,
  FoldersService,
  InvalidFolderPayloadError,
  type FolderAuth,
} from "../services/folders"
import { viewerFromPayload } from "../agent/services/chat"

type Vars = {
  jwtPayload: { sub: string; workspaceId: string }
}

const router = new Hono<{ Variables: Vars }>()
const service = new FoldersService()

const authOf = (c: Context<{ Variables: Vars }>): FolderAuth =>
  viewerFromPayload(c.get("jwtPayload"))

const handle = async (
  c: Context,
  fn: () => Promise<Response | object>,
): Promise<Response> => {
  try {
    const result = await fn()
    return result instanceof Response ? result : c.json(result)
  } catch (err) {
    if (err instanceof FolderNotFoundError) {
      throw new HTTPException(404, { message: err.message })
    }
    if (err instanceof FolderForbiddenError) {
      throw new HTTPException(403, { message: err.message })
    }
    if (err instanceof InvalidFolderPayloadError) {
      throw new HTTPException(400, { message: err.message })
    }
    if (err instanceof HTTPException) {
      throw err
    }
    const message = err instanceof Error ? err.message : "Internal error"
    throw new HTTPException(500, { message })
  }
}

// GET /v2/folders — every folder owned by the viewer, newest activity first.
router.get("/", (c) =>
  handle(c, async () => {
    const folders = await service.list(authOf(c))
    return { folders }
  }),
)

// GET /v2/folders/most-used?limit=3 — sidebar top-N. Registered before
// /:folderId to keep `most-used` from being parsed as an id.
router.get("/most-used", (c) =>
  handle(c, async () => {
    const limitRaw = c.req.query("limit")
    const parsed = Number.parseInt(limitRaw ?? "3", 10)
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 3
    const folders = await service.listMostUsed(authOf(c), limit)
    return { folders }
  }),
)

// POST /v2/folders { name, description? }
router.post("/", (c) =>
  handle(c, async () => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string
      description?: string | null
    }
    const created = await service.create(authOf(c), {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(body.description !== undefined
        ? { description: body.description }
        : {}),
    })
    c.status(201)
    return created
  }),
)

// GET /v2/folders/:folderId
router.get("/:folderId", (c) =>
  handle(c, async () => {
    const folder = await service.get(authOf(c), c.req.param("folderId"))
    return folder
  }),
)

// PATCH /v2/folders/:folderId  { name?, description? }
router.patch("/:folderId", (c) =>
  handle(c, async () => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string
      description?: string | null
    }
    const updated = await service.update(authOf(c), c.req.param("folderId"), {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(body.description !== undefined
        ? { description: body.description }
        : {}),
    })
    return updated
  }),
)

// DELETE /v2/folders/:folderId — soft delete; the folder's conversations
// have their folder_id set to NULL inside the same transaction so they
// stay visible in Recents but are no longer pinned to a project.
router.delete("/:folderId", (c) =>
  handle(c, async () => {
    await service.softDelete(authOf(c), c.req.param("folderId"))
    return { ok: true }
  }),
)

// PATCH /v2/folders/:folderId/conversations/:conversationId
// Idempotent "place this conversation into this folder". Used both for the
// drag-and-drop path and the three-dots menu's "Move to project" item.
// Move-between-folders works by just PATCHing the destination — folder_id is
// a single-value field, so re-assignment is implicit.
router.patch("/:folderId/conversations/:conversationId", (c) =>
  handle(c, async () => {
    await service.addConversation(
      authOf(c),
      c.req.param("folderId"),
      c.req.param("conversationId"),
    )
    return { ok: true }
  }),
)

// DELETE /v2/folders/:folderId/conversations/:conversationId
// Removes a single membership (sets folder_id=null on the conversation,
// scoped to this folder so a stale request can't accidentally un-file a
// conversation that's since been moved to a different project).
router.delete("/:folderId/conversations/:conversationId", (c) =>
  handle(c, async () => {
    await service.removeConversation(
      authOf(c),
      c.req.param("folderId"),
      c.req.param("conversationId"),
    )
    return { ok: true }
  }),
)

export default router
