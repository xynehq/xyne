// HTTP adapter for AgentsService. Same wire contract v1 served to the UI —
// the agents page POSTs/GETs land on /v2/agents/* now instead of /api/v1/*.
//
// All routes are gated by the parent app's `/v2/*` AuthMiddleware (JWT cookie
// required). Per-resource permission is enforced inside the service.

import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"

import {
  AgentNotFoundOrForbiddenError,
  AgentsService,
  OwnerUserOverlapError,
  UpdateHasNoFieldsError,
  UserOrWorkspaceNotFoundError,
  createAgentSchema,
  listAgentsQuerySchema,
  searchWorkspaceUsers,
  updateAgentSchema,
  type Auth,
} from "../services/agents"

type Vars = {
  jwtPayload: { sub: string; workspaceId: string }
}

const router = new Hono<{ Variables: Vars }>()
const service = new AgentsService()

const authOf = (c: Context<{ Variables: Vars }>): Auth => {
  const p = c.get("jwtPayload")
  return { email: p.sub, workspaceExternalId: p.workspaceId }
}

/** Single error→HTTP mapping point so the handlers stay focused on the
 *  happy path. Unrecognised errors propagate as 500 via Hono's default. */
const handle = async (
  c: Context,
  fn: () => Promise<Response | object>,
): Promise<Response> => {
  try {
    const result = await fn()
    return result instanceof Response ? result : c.json(result)
  } catch (err) {
    if (err instanceof UserOrWorkspaceNotFoundError) {
      throw new HTTPException(404, { message: "User or workspace not found" })
    }
    if (err instanceof AgentNotFoundOrForbiddenError) {
      throw new HTTPException(404, {
        message: "Agent not found or access denied",
      })
    }
    if (err instanceof OwnerUserOverlapError) {
      return c.json(
        {
          message: "Users cannot be both owners and regular users",
          conflictingEmails: err.conflictingEmails,
        },
        400,
      )
    }
    if (err instanceof UpdateHasNoFieldsError) {
      throw new HTTPException(400, { message: "No fields to update" })
    }
    if (err instanceof z.ZodError) {
      return c.json(
        { message: "Invalid input", errors: err.flatten().fieldErrors },
        400,
      )
    }
    if (err instanceof HTTPException) {
      throw err
    }
    throw new HTTPException(500, {
      message: err instanceof Error ? err.message : "Internal error",
    })
  }
}

// GET /v2/agents?limit=&offset=&filter=
router.get("/", (c) =>
  handle(c, async () => {
    const query = listAgentsQuerySchema.parse({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
      filter: c.req.query("filter"),
    })
    const agents = await service.list(authOf(c), query)
    // v1 returns a bare array here; the UI tolerates both shapes (see
    // listAgents in ui2/src/lib/api.ts), and chat's AgentSelector already
    // destructures `{ agents }`. We pick the envelope form because it's the
    // shape backendv2 uses everywhere else and is easier to extend.
    return { agents }
  }),
)

// GET /v2/agents/:agentExternalId
router.get("/:agentExternalId", (c) =>
  handle(c, async () => {
    const id = c.req.param("agentExternalId")
    const agent = await service.get(authOf(c), id)
    return agent
  }),
)

// GET /v2/agents/:agentExternalId/permissions
router.get("/:agentExternalId/permissions", (c) =>
  handle(c, async () => {
    const id = c.req.param("agentExternalId")
    const perms = await service.getPermissions(authOf(c), id)
    return perms
  }),
)

// POST /v2/agents
router.post("/", (c) =>
  handle(c, async () => {
    const body = await c.req.json().catch(() => ({}))
    const payload = createAgentSchema.parse(body)
    const created = await service.create(authOf(c), payload)
    c.status(201)
    return created
  }),
)

// PUT /v2/agents/:agentExternalId
router.put("/:agentExternalId", (c) =>
  handle(c, async () => {
    const id = c.req.param("agentExternalId")
    const body = await c.req.json().catch(() => ({}))
    const payload = updateAgentSchema.parse(body)
    const updated = await service.update(authOf(c), id, payload)
    return updated
  }),
)

// DELETE /v2/agents/:agentExternalId
router.delete("/:agentExternalId", (c) =>
  handle(c, async () => {
    const id = c.req.param("agentExternalId")
    const deleted = await service.remove(authOf(c), id)
    // Match v1's response envelope so the UI's existing handler
    // (which just checks for ok status) keeps working.
    return { message: "Agent deleted successfully", agent: deleted }
  }),
)

// ─── Workspace user search ──────────────────────────────────────────────────
// Lives at /v2/users/search so the agent form's viewer/owner pickers have a
// stable URL. Mounted alongside the agents router by server.ts.
export const usersRouter = new Hono<{ Variables: Vars }>()

usersRouter.get("/search", (c) =>
  handle(c, async () => {
    const q = (c.req.query("q") ?? "").trim()
    const limit = Math.max(
      1,
      Math.min(Number.parseInt(c.req.query("limit") ?? "10", 10) || 10, 100),
    )
    if (!q) return { users: [] }
    const users = await searchWorkspaceUsers(authOf(c), q, limit)
    return { users }
  }),
)

export default router
