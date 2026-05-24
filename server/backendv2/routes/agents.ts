// HTTP adapter for AgentsService. Same wire contract v1 served to the UI —
// the agents page POSTs/GETs land on /v2/agents/* now instead of /api/v1/*.
//
// All routes are gated by the parent app's `/v2/*` AuthMiddleware (JWT cookie
// required). Per-resource permission is enforced inside the service.

import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
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
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT_MAIN,
  DEFAULT_SYSTEM_PROMPT_SUBAGENTS,
  DEFAULT_SYSTEM_PROMPT_TOOLS,
} from "../agent/pi-mono/system-prompt"
import { TOOL_REGISTRY } from "../agent/pi-mono/tools/registry"
import {
  ExtractorAgentNotFoundError,
  MissingResponseSchemaError,
  NotAnExtractorError,
  runExtract,
} from "../agent/extractor/extract"
import { agentDeps } from "../agent/wiring"
import subAgentsRouter from "./subAgents"

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
    if (err instanceof ExtractorAgentNotFoundError) {
      throw new HTTPException(404, {
        message: "Extractor not found or access denied",
      })
    }
    if (err instanceof NotAnExtractorError) {
      throw new HTTPException(400, {
        message: "This agent is not an extractor",
      })
    }
    if (err instanceof MissingResponseSchemaError) {
      throw new HTTPException(400, {
        message: "Extractor has no response schema configured",
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

// GET /v2/agents/defaults — exposes the server's default system prompt to
// the agent form. Returns the three independently editable sections (M2
// split) so each "Use default" button in the form can pre-fill its own
// textarea. `prompt` is kept on the response for back-compat with the v1
// AgentForm that hasn't been updated yet — equal to the assembled prompt
// with no overrides and no sub-agents, so it matches what the LLM sees
// today. Registered before /:agentExternalId to avoid path collision.
router.get("/defaults", (c) =>
  c.json({
    prompt: DEFAULT_SYSTEM_PROMPT,
    sections: {
      main: DEFAULT_SYSTEM_PROMPT_MAIN,
      tools: DEFAULT_SYSTEM_PROMPT_TOOLS,
      subagents: DEFAULT_SYSTEM_PROMPT_SUBAGENTS,
    },
  }),
)

// GET /v2/agents/tools — registry catalog the agent form's tool picker
// renders. Returns name + label + short description + category for each
// tool. Pure data — no per-agent state — so this is safely cacheable on
// the client for the page lifetime. Mounted before /:agentExternalId to
// avoid path collision.
router.get("/tools", (c) =>
  c.json({
    tools: TOOL_REGISTRY.map((t) => ({
      name: t.name,
      label: t.label,
      description: t.description,
      category: t.category,
    })),
  }),
)

// GET /v2/agents/default — workspace-wide default agent. Auto-created
// on first read (the unique partial index handles concurrent inserts).
// Returns the same shape as a regular GET /v2/agents/:id so the agent
// form can drive both paths from one code branch.
router.get("/default", (c) =>
  handle(c, async () => {
    const agent = await service.getOrCreateDefault(authOf(c))
    return agent
  }),
)

// PUT /v2/agents/default — patch the workspace default agent (system
// prompt sections, tools allowlist). Name / sharing / permissions stay
// fixed for this row and the route layer strips them out of the
// payload server-side as a belt + braces guard against UI bugs.
router.put("/default", (c) =>
  handle(c, async () => {
    const body = await c.req.json().catch(() => ({}))
    const payload = updateAgentSchema.parse(body)
    const updated = await service.updateDefault(authOf(c), payload)
    return updated
  }),
)

// GET /v2/agents?limit=&offset=&filter=
router.get("/", (c) =>
  handle(c, async () => {
    const isExtractorRaw = c.req.query("isExtractor")
    const query = listAgentsQuerySchema.parse({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
      filter: c.req.query("filter"),
      ...(isExtractorRaw !== undefined ? { isExtractor: isExtractorRaw } : {}),
    })
    const agents = await service.list(authOf(c), query)
    // v1 returns a bare array here; the UI tolerates both shapes (see
    // listAgents in ui2/src/lib/api.ts), and chat's AgentSelector already
    // destructures `{ agents }`. We pick the envelope form because it's the
    // shape backendv2 uses everywhere else and is easier to extend.
    return { agents }
  }),
)

// GET /v2/agents/default/effective-prompt — the assembled prompt the
// LLM sees when no agent scope is selected (= the default agent's
// effective prompt). Used by any view surface that wants to preview
// what the General agent actually emits. Registered before the param
// route so /default doesn't get captured as :agentExternalId.
router.get("/default/effective-prompt", (c) =>
  handle(c, async () => {
    const agent = await service.getOrCreateDefault(authOf(c))
    const result = await service.getEffectivePrompt(authOf(c), agent.externalId)
    return result
  }),
)

// GET /v2/agents/:agentExternalId/effective-prompt — the assembled
// prompt the LLM would see if a turn started right now under this
// agent. View page calls this so editors see the bytes the model
// receives rather than guessing from per-section overrides + the
// workspace defaults.
router.get("/:agentExternalId/effective-prompt", (c) =>
  handle(c, async () => {
    const id = c.req.param("agentExternalId")
    const result = await service.getEffectivePrompt(authOf(c), id)
    return result
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

// POST /v2/agents/:agentExternalId/extract — programmatic extractor.
// Runs the agent's pi-mono loop on the caller's input, validates the
// returned JSON against the agent's responseSchema, and re-prompts on
// failure up to extractorMaxRetries. Returns either { ok: true, value }
// or { ok: false, errors, lastRawText } plus per-attempt debug.
const extractInputSchema = z.object({
  input: z.string().min(1),
  maxRetries: z.number().int().min(0).max(10).optional(),
  modelLabel: z.string().optional(),
  thinkingLevel: z
    .enum(["minimal", "low", "medium", "high"])
    .optional(),
  debug: z.boolean().optional(),
  debugVerbosity: z.enum(["summary", "detailed"]).optional(),
})

router.post("/:agentExternalId/extract", (c) =>
  handle(c, async () => {
    const id = c.req.param("agentExternalId")
    const body = await c.req.json().catch(() => ({}))
    const payload = extractInputSchema.parse(body)
    const auth = authOf(c)
    const result = await runExtract(
      agentDeps(),
      { email: auth.email, workspaceExternalId: auth.workspaceExternalId },
      id,
      {
        input: payload.input,
        ...(payload.maxRetries !== undefined
          ? { maxRetries: payload.maxRetries }
          : {}),
        ...(payload.modelLabel ? { modelLabel: payload.modelLabel } : {}),
        ...(payload.thinkingLevel
          ? { thinkingLevel: payload.thinkingLevel }
          : {}),
        ...(payload.debug !== undefined ? { debug: payload.debug } : {}),
        ...(payload.debugVerbosity
          ? { debugVerbosity: payload.debugVerbosity }
          : {}),
      },
    )
    if (!result.ok) c.status(422)
    return result
  }),
)

// Streaming variant of /extract — emits each captured DebugEvent as
// an SSE frame as it fires, then a final `result` frame with the
// ExtractResult envelope. The UI subscribes here so the chat
// DebugPanel lights up live during a long extraction; the plain
// JSON /extract endpoint stays for programmatic callers.
router.post("/:agentExternalId/extract/stream", (c) => {
  return streamSSE(c, async (stream) => {
    let payload: z.infer<typeof extractInputSchema>
    try {
      const body = await c.req.json().catch(() => ({}))
      payload = extractInputSchema.parse(body)
    } catch (err) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          message: err instanceof Error ? err.message : String(err),
        }),
      })
      return
    }

    const id = c.req.param("agentExternalId")
    const auth = authOf(c)
    await stream.writeSSE({ event: "ready", data: "" })

    try {
      const result = await runExtract(
        agentDeps(),
        { email: auth.email, workspaceExternalId: auth.workspaceExternalId },
        id,
        {
          input: payload.input,
          ...(payload.maxRetries !== undefined
            ? { maxRetries: payload.maxRetries }
            : {}),
          ...(payload.modelLabel ? { modelLabel: payload.modelLabel } : {}),
          ...(payload.thinkingLevel
            ? { thinkingLevel: payload.thinkingLevel }
            : {}),
          ...(payload.debug !== undefined ? { debug: payload.debug } : {}),
          ...(payload.debugVerbosity
            ? { debugVerbosity: payload.debugVerbosity }
            : {}),
        },
        c.req.raw.signal,
        (event): void => {
          stream
            .writeSSE({
              event: event.kind,
              data: JSON.stringify(event),
            })
            .catch(() => {
              /* client may have closed */
            })
        },
      )
      await stream.writeSSE({
        event: "result",
        data: JSON.stringify(result),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: msg }),
      })
    }
  })
})

// Sub-agents CRUD lives under each parent agent. Mounting at
// /:agentExternalId/sub-agents so the parent id is implicit in the URL
// and the sub-router can pull it from c.req.param("agentExternalId").
router.route("/:agentExternalId/sub-agents", subAgentsRouter)

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
