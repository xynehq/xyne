// HTTP adapter for SubAgentsService — sub-agent CRUD scoped under a parent
// agent's external id. Mounted at /v2/agents/:agentExternalId/sub-agents
// by the v2 server so the route's parent context is implicit in the URL.
//
// Per-resource permission lives in the service. The route is responsible
// for: shape validation (zod), error → HTTP mapping, and the auth bundle
// extraction we share with the parent agents route.

import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"

import {
  AgentNotFoundOrForbiddenError,
  UpdateHasNoFieldsError,
  UserOrWorkspaceNotFoundError,
  type Auth,
} from "../services/agents"
import {
  SubAgentNameTakenError,
  SubAgentNotFoundError,
  SubAgentsService,
  createSubAgentSchema,
  updateSubAgentSchema,
} from "../services/subAgents"

type Vars = {
  jwtPayload: { sub: string; workspaceId: string }
}

// `mergeParams: true` lets us pick up :agentExternalId from the parent
// router's path even though we don't redeclare the param here.
const router = new Hono<{ Variables: Vars }>()
const service = new SubAgentsService()

const authOf = (c: Context<{ Variables: Vars }>): Auth => {
  const p = c.get("jwtPayload")
  return { email: p.sub, workspaceExternalId: p.workspaceId }
}

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
        message: "Parent agent not found or access denied",
      })
    }
    if (err instanceof SubAgentNotFoundError) {
      throw new HTTPException(404, { message: "Sub-agent not found" })
    }
    if (err instanceof SubAgentNameTakenError) {
      return c.json(
        {
          message: "A sub-agent with that name already exists under this parent",
          takenName: err.takenName,
        },
        409,
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

const parentIdOf = (c: Context): string => c.req.param("agentExternalId") ?? ""

// GET   /v2/agents/:agentExternalId/sub-agents
router.get("/", (c) =>
  handle(c, async () => {
    const subAgents = await service.list(authOf(c), parentIdOf(c))
    return { subAgents }
  }),
)

// POST  /v2/agents/:agentExternalId/sub-agents
router.post("/", (c) =>
  handle(c, async () => {
    const body = await c.req.json().catch(() => ({}))
    const payload = createSubAgentSchema.parse(body)
    const created = await service.create(authOf(c), parentIdOf(c), payload)
    c.status(201)
    return created
  }),
)

// GET   /v2/agents/:agentExternalId/sub-agents/:subExternalId
router.get("/:subExternalId", (c) =>
  handle(c, async () => {
    const sub = await service.get(
      authOf(c),
      parentIdOf(c),
      c.req.param("subExternalId") ?? "",
    )
    return sub
  }),
)

// PATCH /v2/agents/:agentExternalId/sub-agents/:subExternalId
router.patch("/:subExternalId", (c) =>
  handle(c, async () => {
    const body = await c.req.json().catch(() => ({}))
    const payload = updateSubAgentSchema.parse(body)
    const updated = await service.update(
      authOf(c),
      parentIdOf(c),
      c.req.param("subExternalId") ?? "",
      payload,
    )
    return updated
  }),
)

// DELETE /v2/agents/:agentExternalId/sub-agents/:subExternalId
router.delete("/:subExternalId", (c) =>
  handle(c, async () => {
    const deleted = await service.remove(
      authOf(c),
      parentIdOf(c),
      c.req.param("subExternalId") ?? "",
    )
    return { message: "Sub-agent deleted successfully", subAgent: deleted }
  }),
)

export default router
