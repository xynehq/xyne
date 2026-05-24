// Agent CRUD service for backendv2.
//
// Mirrors v1's business logic (server/api/agent.ts + server/db/agent.ts) 1:1:
//   • workspace-scoped queries with same `*WithPermissionCheck` helpers
//   • owner/editor/viewer roles enforced exactly like v1 (read = any access,
//     update = owner | editor, delete = owner only)
//   • email-overlap guard ("a user cannot be both owner and viewer")
//   • create/update inside a transaction so agent + permission sync are atomic
//   • soft delete via deletedAt
//
// Two intentional simplifications over v1:
//   • No `via_apiKey` / `ApiKeyScopes` branches — backendv2 has no API-key
//     middleware that would set them; the JWT path is the only auth surface.
//   • A single `Auth` type carries (email, workspaceExternalId) from the JWT;
//     the service resolves numeric ids per call. Routes don't see the DB ids.
//
// Errors are typed so the route layer can map them to HTTP status without a
// stringly-typed contract.

import { and, eq, isNull } from "drizzle-orm"
import { z } from "zod"

import { db } from "@/db/client"
import {
  insertAgent,
  getAgentByExternalIdWithPermissionCheck,
  updateAgentByExternalIdWithPermissionCheck,
  updateAgentByExternalId,
  deleteAgentByExternalIdWithPermissionCheck,
  getAgentsAccessibleToUser,
  getAgentsMadeByMe,
  getAgentsSharedToMe,
} from "@/db/agent"
import { agents, selectAgentSchema } from "@/db/schema/agents"
import { subAgents as dbSubAgents } from "@/db/schema/subAgents"
import {
  syncAgentUserPermissions,
  getAgentUsers,
  checkUserAgentAccessByExternalId,
} from "@/db/userAgentPermission"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { users } from "@/db/schema"
import { selectPublicAgentSchema } from "@/db/schema"
import { fetchedDataSourceSchema } from "@/db/schema/agents"
import { UserAgentRole } from "@/shared/types"
import { type SelectAgent } from "@/db/agent"
import { type SelectPublicAgent } from "@/db/schema"

import { resolveAgentSystemPrompt } from "../agent/pi-mono/system-prompt"
import { allRegisteredToolNames } from "../agent/pi-mono/tools/registry"

// ─── Input shapes ───────────────────────────────────────────────────────────

export type Auth = {
  email: string
  workspaceExternalId: string
}

export const listAgentsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
  filter: z.enum(["all", "madeByMe", "sharedToMe"]).optional().default("all"),
  // Extractors are agents with isExtractor=true. Same table, separate
  // UI surface — the list endpoint filters when the param is present.
  // Omit → return all (back-compat with callers that don't pass it).
  isExtractor: z.preprocess((v) => {
    if (v === "true") return true
    if (v === "false") return false
    return v
  }, z.boolean().optional()),
})
export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>

// Mirrors v1 `createAgentSchema` (server/api/agent.ts:38) field-for-field so
// the wire contract is identical for the UI.
export const createAgentSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().min(1, "Model is required"),
  isPublic: z.boolean().optional().default(false),
  appIntegrations: z
    .union([
      z.array(z.string()),
      z.record(
        z.string(),
        z.object({
          itemIds: z.array(z.string()).default([]),
          selectedAll: z.boolean(),
          filters: z
            .array(
              z.object({
                id: z.number(),
                from: z.array(z.string()).optional(),
                to: z.array(z.string()).optional(),
                cc: z.array(z.string()).optional(),
                bcc: z.array(z.string()).optional(),
                senderId: z.array(z.string()).optional(),
                channelId: z.array(z.string()).optional(),
                timeRange: z
                  .object({
                    startDate: z.number(),
                    endDate: z.number(),
                  })
                  .optional(),
              }),
            )
            .optional(),
        }),
      ),
    ])
    .optional()
    .default([]),
  allowWebSearch: z.boolean().optional().default(false),
  isRagOn: z.boolean().optional().default(true),
  uploadedFileNames: z.array(z.string()).optional().default([]),
  userEmails: z.array(z.string().email()).optional().default([]),
  ownerEmails: z.array(z.string().email()).optional().default([]),
  docIds: z.array(fetchedDataSourceSchema).optional().default([]),

  // ── M4a: per-section system prompt + tool allowlist ─────────────────────
  // Each of the three section fields is optional and nullable:
  //   • omit (key absent)  → leave the column unchanged on update
  //   • set to a non-empty string → use that section verbatim
  //   • set to "" or null  → clear the override, fall back to the default
  // The route layer never invents defaults; the assembler does so at run time.
  systemPromptMain: z.string().nullable().optional(),
  systemPromptTools: z.string().nullable().optional(),
  systemPromptSubagents: z.string().nullable().optional(),
  // Pi-mono registry tool name allowlist. Empty array = all tools (matches
  // the runner's `undefined` path). The route layer validates that every
  // name exists in the registry in M5.
  tools: z.array(z.string()).optional(),

  // ── Extractors: structured-response agents ─────────────────────────────
  // isExtractor flips an agent into Extractor mode — same table, same
  // shape, except the chat service validates the LLM's final text
  // against `responseSchema` and re-prompts on failure (up to
  // extractorMaxRetries times). responseSchema is JSON Schema; the
  // visual builder on the form serialises to it.
  // No `.default(…)` on the extractor fields — zod's `.partial()` keeps
  // defaults around, which would silently demote `isExtractor` back to
  // false (and reset `extractorMaxRetries` to 2) on any update that
  // omits them. The service layer fills the defaults at the value-write
  // site instead, so create-without-these-fields still works.
  isExtractor: z.boolean().optional(),
  responseSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  extractorMaxRetries: z.number().int().min(0).max(10).optional(),
  // Note: `isDefault` is intentionally NOT exposed on this schema. The
  // per-workspace default agent is created/maintained by M4b's
  // ensureDefaultAgent path; flipping the flag via PATCH would let a user
  // claim or duplicate the workspace default.
})
export type CreateAgentPayload = z.infer<typeof createAgentSchema>

export const updateAgentSchema = createAgentSchema.partial().extend({
  userEmails: z.array(z.string().email()).optional(),
  ownerEmails: z.array(z.string().email()).optional(),
})
export type UpdateAgentPayload = z.infer<typeof updateAgentSchema>

// ─── Typed errors ───────────────────────────────────────────────────────────

export class UserOrWorkspaceNotFoundError extends Error {
  public override readonly name = "UserOrWorkspaceNotFoundError"
}

export class AgentNotFoundOrForbiddenError extends Error {
  public override readonly name = "AgentNotFoundOrForbiddenError"
  public constructor(public readonly externalId: string) {
    super(`Agent ${externalId} not found or access denied`)
  }
}

/** Same rule as v1: an email may appear in `userEmails` OR `ownerEmails`, not
 *  both. We surface the offending emails so the UI can highlight them. */
export class OwnerUserOverlapError extends Error {
  public override readonly name = "OwnerUserOverlapError"
  public constructor(public readonly conflictingEmails: string[]) {
    super("Users cannot be both owners and regular users")
  }
}

export class UpdateHasNoFieldsError extends Error {
  public override readonly name = "UpdateHasNoFieldsError"
  public constructor() {
    super("No fields to update")
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

export class AgentsService {
  /** Resolve numeric user + workspace ids from the JWT-derived email and
   *  workspace external id. Centralised so every method shares the same
   *  "User or workspace not found" branch. */
  private async resolveAuth(
    auth: Auth,
  ): Promise<{ userId: number; workspaceId: number }> {
    try {
      const uw = await getUserAndWorkspaceByEmail(
        db,
        auth.workspaceExternalId,
        auth.email,
      )
      if (!uw?.user || !uw?.workspace) {
        throw new UserOrWorkspaceNotFoundError()
      }
      return { userId: uw.user.id, workspaceId: uw.workspace.id }
    } catch (err) {
      // `getUserAndWorkspaceByEmail` raises HTTPException(404) on miss — we
      // normalise to our typed error so the route layer maps it uniformly.
      if (err instanceof UserOrWorkspaceNotFoundError) throw err
      throw new UserOrWorkspaceNotFoundError()
    }
  }

  public async list(
    auth: Auth,
    query: ListAgentsQuery,
  ): Promise<SelectPublicAgent[]> {
    const { userId, workspaceId } = await this.resolveAuth(auth)
    const { filter, limit, offset, isExtractor } = query
    switch (filter) {
      case "madeByMe":
        return getAgentsMadeByMe(
          db,
          userId,
          workspaceId,
          limit,
          offset,
          isExtractor,
        )
      case "sharedToMe":
        return getAgentsSharedToMe(
          db,
          userId,
          workspaceId,
          limit,
          offset,
          isExtractor,
        )
      case "all":
      default:
        return getAgentsAccessibleToUser(
          db,
          userId,
          workspaceId,
          limit,
          offset,
          isExtractor,
        )
    }
  }

  public async get(auth: Auth, externalId: string): Promise<SelectPublicAgent> {
    const { userId, workspaceId } = await this.resolveAuth(auth)
    const agent = await getAgentByExternalIdWithPermissionCheck(
      db,
      externalId,
      workspaceId,
      userId,
    )
    if (!agent) throw new AgentNotFoundOrForbiddenError(externalId)
    return selectPublicAgentSchema.parse(agent)
  }

  public async getPermissions(
    auth: Auth,
    externalId: string,
  ): Promise<{ userEmails: string[]; ownerEmails: string[] }> {
    const { userId, workspaceId } = await this.resolveAuth(auth)
    const agent = await getAgentByExternalIdWithPermissionCheck(
      db,
      externalId,
      workspaceId,
      userId,
    )
    if (!agent) throw new AgentNotFoundOrForbiddenError(externalId)
    const permissions = await getAgentUsers(db, agent.id)
    const userEmails: string[] = []
    const ownerEmails: string[] = []
    for (const p of permissions) {
      if (p.role === UserAgentRole.Owner) ownerEmails.push(p.user.email)
      else userEmails.push(p.user.email)
    }
    return { userEmails, ownerEmails }
  }

  public async create(
    auth: Auth,
    payload: CreateAgentPayload,
  ): Promise<SelectPublicAgent> {
    const { userId, workspaceId } = await this.resolveAuth(auth)
    assertOwnerUserDisjoint(payload.userEmails, payload.ownerEmails)

    // Note: `uploadedFileNames` from the wire is accepted by the Zod schema
    // for forward-compat with the v1 UI but isn't a column on the agents
    // table — v1 also silently dropped it at the DB layer. We do the same.
    const agentData = {
      name: payload.name,
      description: payload.description,
      prompt: payload.prompt,
      model: payload.model,
      isPublic: payload.isPublic,
      appIntegrations: payload.appIntegrations,
      allowWebSearch: payload.allowWebSearch,
      isRagOn: payload.isRagOn,
      docIds: payload.docIds,
      userEmails: payload.userEmails,
      ownerEmails: payload.ownerEmails,
      // M4a section fields. Forwarded as-is — when undefined the DB-layer
      // insert leaves them NULL (matches the schema defaults).
      ...(payload.systemPromptMain !== undefined
        ? { systemPromptMain: payload.systemPromptMain }
        : {}),
      ...(payload.systemPromptTools !== undefined
        ? { systemPromptTools: payload.systemPromptTools }
        : {}),
      ...(payload.systemPromptSubagents !== undefined
        ? { systemPromptSubagents: payload.systemPromptSubagents }
        : {}),
      // M7-pre: `tools = []` now means "literally no tools" at run time
      // (no more "[] → all" wildcard). To keep new agents usable by
      // default, materialise the full registry server-side whenever the
      // create payload omits tools or sends an empty list. The user can
      // then deselect tiles in the form.
      tools:
        payload.tools && payload.tools.length > 0
          ? payload.tools
          : allRegisteredToolNames(),
      // Extractor mode + retry budget. responseSchema only forwards
      // when isExtractor is true to keep plain-agent rows clean.
      isExtractor: payload.isExtractor ?? false,
      ...(payload.isExtractor && payload.responseSchema !== undefined
        ? { responseSchema: payload.responseSchema }
        : {}),
      extractorMaxRetries: payload.extractorMaxRetries ?? 2,
    }

    const created = await db.transaction(async (tx) => {
      const agent = await insertAgent(tx, agentData, userId, workspaceId)

      // Private agents propagate explicit viewer permissions; public agents
      // skip this (no need to maintain a viewer list — visibility is implicit).
      if (
        !payload.isPublic &&
        payload.userEmails &&
        payload.userEmails.length > 0
      ) {
        await syncAgentUserPermissions(
          tx,
          agent.id,
          payload.userEmails,
          payload.ownerEmails ?? [],
          workspaceId,
        )
      }
      return agent
    })

    return selectPublicAgentSchema.parse(created)
  }

  public async update(
    auth: Auth,
    externalId: string,
    payload: UpdateAgentPayload,
  ): Promise<SelectPublicAgent> {
    if (Object.keys(payload).length === 0) {
      throw new UpdateHasNoFieldsError()
    }

    const { userId, workspaceId } = await this.resolveAuth(auth)
    assertOwnerUserDisjoint(payload.userEmails, payload.ownerEmails)

    // Two-phase access check (kept identical to v1): first the
    // permission-aware get, then a direct lookup in the user_agent_permission
    // table. The second catches the case where the row exists for someone
    // else but the caller has *no* permission row at all — v1 returns 404
    // for both, we do the same.
    const existing = await getAgentByExternalIdWithPermissionCheck(
      db,
      externalId,
      workspaceId,
      userId,
    )
    const callerPerms = await checkUserAgentAccessByExternalId(
      db,
      userId,
      externalId,
      workspaceId,
    )
    if (!existing || !callerPerms?.find((p) => p.userId === userId)) {
      throw new AgentNotFoundOrForbiddenError(externalId)
    }

    const updated = await db.transaction(async (tx) => {
      const agent = await updateAgentByExternalIdWithPermissionCheck(
        tx,
        externalId,
        workspaceId,
        userId,
        payload,
      )
      if (!agent) {
        // The permission check above passed but the WithPermissionCheck
        // helper also requires owner|editor role for *writes* — surface
        // the same 404-equivalent v1 surfaces.
        throw new AgentNotFoundOrForbiddenError(externalId)
      }

      // Permission re-sync mirrors v1's three branches exactly:
      //   • flipping to public → clear all non-owner permissions
      //   • flipping/staying private with explicit userEmails → resync
      //   • userEmails alone (no isPublic) → only resync if currently private
      if (payload.isPublic === true) {
        await syncAgentUserPermissions(
          tx,
          agent.id,
          [],
          payload.ownerEmails ?? [],
          workspaceId,
        )
      } else if (
        payload.isPublic === false &&
        payload.userEmails !== undefined
      ) {
        await syncAgentUserPermissions(
          tx,
          agent.id,
          payload.userEmails,
          payload.ownerEmails ?? [],
          workspaceId,
        )
      } else if (payload.userEmails !== undefined && !existing.isPublic) {
        await syncAgentUserPermissions(
          tx,
          agent.id,
          payload.userEmails,
          payload.ownerEmails ?? [],
          workspaceId,
        )
      }

      return agent
    })

    return selectPublicAgentSchema.parse(updated)
  }

  public async remove(
    auth: Auth,
    externalId: string,
  ): Promise<SelectPublicAgent> {
    const { userId, workspaceId } = await this.resolveAuth(auth)

    const existing = await getAgentByExternalIdWithPermissionCheck(
      db,
      externalId,
      workspaceId,
      userId,
    )
    const callerPerms = await checkUserAgentAccessByExternalId(
      db,
      userId,
      externalId,
      workspaceId,
    )
    if (!existing || !callerPerms?.find((p) => p.userId === userId)) {
      throw new AgentNotFoundOrForbiddenError(externalId)
    }

    const deleted = await deleteAgentByExternalIdWithPermissionCheck(
      db,
      externalId,
      workspaceId,
      userId,
    )
    if (!deleted) {
      // Same defence-in-depth note as v1: the WithPermissionCheck delete
      // returns null when the caller isn't an owner. Surface 404-equivalent.
      throw new AgentNotFoundOrForbiddenError(externalId)
    }
    return selectPublicAgentSchema.parse(deleted)
  }

  // ── Effective prompt (view page) ─────────────────────────────────────────
  //
  // Compute and return the system prompt the LLM would actually see if
  // a turn started right now under this agent — i.e. resolveAgentSystem
  // Prompt applied to the agent's row + its live sub-agents. The view
  // page calls this so editors see the bytes the model receives rather
  // than guessing from the per-section overrides + workspace defaults.
  //
  // Permission gate is the same as `get` — any access role passes (a
  // public viewer can see the agent and its effective prompt).
  public async getEffectivePrompt(
    auth: Auth,
    externalId: string,
  ): Promise<{
    prompt: string
    sources: {
      main: "override" | "default"
      tools: "override" | "default"
      subagents: "override" | "default" | "suppressed"
    }
  }> {
    const { userId, workspaceId } = await this.resolveAuth(auth)
    const agent = await getAgentByExternalIdWithPermissionCheck(
      db,
      externalId,
      workspaceId,
      userId,
    )
    if (!agent) throw new AgentNotFoundOrForbiddenError(externalId)

    const subAgentRows = await db
      .select({
        name: dbSubAgents.name,
        description: dbSubAgents.description,
      })
      .from(dbSubAgents)
      .where(
        and(
          eq(dbSubAgents.parentAgentId, agent.id),
          isNull(dbSubAgents.deletedAt),
        ),
      )

    // After the legacy `prompt` migration there is only one path:
    // assemble main + tools + sub-agents from per-section overrides,
    // filling nulls with the workspace defaults. The per-section
    // sources just say whether each came from an override or the
    // default; sub-agents reports "suppressed" when the agent has
    // zero sub-agents (the block isn't emitted at all).
    const has = (v: string | null | undefined): boolean =>
      typeof v === "string" && v.length > 0
    const sources = {
      main: has(agent.systemPromptMain)
        ? ("override" as const)
        : ("default" as const),
      tools: has(agent.systemPromptTools)
        ? ("override" as const)
        : ("default" as const),
      subagents:
        subAgentRows.length === 0
          ? ("suppressed" as const)
          : has(agent.systemPromptSubagents)
            ? ("override" as const)
            : ("default" as const),
    }

    const prompt = resolveAgentSystemPrompt({
      systemPromptMain: agent.systemPromptMain,
      systemPromptTools: agent.systemPromptTools,
      systemPromptSubagents: agent.systemPromptSubagents,
      subAgents: subAgentRows,
    })

    return { prompt, sources }
  }

  // ── M4b: workspace-wide default agent ────────────────────────────────────
  //
  // The default agent is the row used when a chat turn carries no agent
  // scope (the "General agent" path). One per workspace, enforced by the
  // unique partial index `agents_default_per_workspace_unique`. Created
  // lazily on first access — the unique index doubles as a race-safety
  // belt if two requests try to insert simultaneously.

  /** Return the default agent for the caller's workspace, creating it on
   *  the fly if it doesn't exist yet. Idempotent. Permission-free — every
   *  user in the workspace shares the same default and the read returns
   *  it for everyone; only PUT is restricted (see updateDefault). */
  public async getOrCreateDefault(auth: Auth): Promise<SelectAgent> {
    const { userId, workspaceId } = await this.resolveAuth(auth)
    const existing = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          eq(agents.isDefault, true),
          isNull(agents.deletedAt),
        ),
      )
      .limit(1)
    if (existing[0]) return selectAgentSchema.parse(existing[0])

    // Lazy insert. `userId` is the caller's id — the user_id column is
    // NOT NULL on agents, so it has to be SOMEONE; using the caller
    // keeps it traceable. This is purely audit, not permission: the
    // default agent isn't owned in the editorial sense, any workspace
    // admin can edit it (M4b's update path uses an admin gate, not
    // owner-of-row).
    try {
      const inserted = await db
        .insert(agents)
        .values({
          workspaceId,
          userId,
          externalId: `agent-default-${createDefaultAgentExternalIdSuffix(workspaceId)}`,
          name: "General agent",
          description:
            "Workspace default — used when a chat turn doesn't pick a specific agent.",
          model: "Auto",
          isPublic: true,
          isDefault: true,
          // Materialise the full registry so the default agent has every
          // tool available out of the box. [] is "no tools" under the
          // M7-pre uniform semantic, which would silently disable
          // retrieval on un-scoped chats — definitely not what we want
          // for the workspace fallback.
          tools: allRegisteredToolNames(),
        })
        .returning()
      if (!inserted[0]) {
        throw new Error("ensure default agent: insert returned no row")
      }
      return selectAgentSchema.parse(inserted[0])
    } catch (err) {
      // Lost the unique-index race against a parallel insert — re-read.
      if (
        err instanceof Error &&
        /agents_default_per_workspace_unique/.test(err.message)
      ) {
        const retry = await db
          .select()
          .from(agents)
          .where(
            and(
              eq(agents.workspaceId, workspaceId),
              eq(agents.isDefault, true),
              isNull(agents.deletedAt),
            ),
          )
          .limit(1)
        if (retry[0]) return selectAgentSchema.parse(retry[0])
      }
      throw err
    }
  }

  /** Patch the workspace default agent. Reuses the regular update DB
   *  helper (which itself takes a Partial of the InsertAgent shape) but
   *  bypasses the owner/editor permission check — every workspace
   *  member can read the default, but write access is gated at the
   *  route layer by a TODO admin-role check. For now we accept any
   *  authenticated user from the workspace (matches v1's effective
   *  policy where there's no formal admin role yet). */
  public async updateDefault(
    auth: Auth,
    payload: UpdateAgentPayload,
  ): Promise<SelectAgent> {
    if (Object.keys(payload).length === 0) {
      throw new UpdateHasNoFieldsError()
    }
    const { workspaceId } = await this.resolveAuth(auth)
    const current = await this.getOrCreateDefault(auth)

    // Defensive: never let the default row's `isDefault` flag get
    // flipped via PATCH, and never let its name/visibility be cleared
    // out from under us.
    const { isDefault: _drop, ...rest } = payload as UpdateAgentPayload & {
      isDefault?: boolean
    }

    const updated = await updateAgentByExternalId(
      db,
      current.externalId,
      workspaceId,
      rest,
    )
    if (!updated) {
      throw new AgentNotFoundOrForbiddenError(current.externalId)
    }
    return selectAgentSchema.parse(updated)
  }
}

// Stable-ish externalId suffix for the workspace default row. We don't
// strictly need uniqueness across workspaces (the row's external_id is
// already unique), but keeping the workspace id in the suffix makes
// it grep-able in logs and DB inspections.
const createDefaultAgentExternalIdSuffix = (workspaceId: number): string =>
  `w${String(workspaceId)}-${Math.random().toString(36).slice(2, 10)}`

// ─── Helpers ────────────────────────────────────────────────────────────────

const assertOwnerUserDisjoint = (
  userEmails: string[] | undefined,
  ownerEmails: string[] | undefined,
): void => {
  if (!userEmails || !ownerEmails) return
  const ownerSet = new Set(ownerEmails)
  const overlap = userEmails.filter((e) => ownerSet.has(e))
  if (overlap.length > 0) throw new OwnerUserOverlapError(overlap)
}

// ─── Workspace user search ──────────────────────────────────────────────────
// Tiny side-piece, doesn't justify its own service class. Same shape v1's
// SearchWorkspaceUsersApi returns: `{ users: [{ id, name, email, photoLink }] }`
// where `id` is the user's externalId (the UI uses externalIds, never numeric).
export type WorkspaceUserResult = {
  id: string
  name: string
  email: string
  photoLink: string | null
}

export const searchWorkspaceUsers = async (
  auth: Auth,
  q: string,
  limit: number,
): Promise<WorkspaceUserResult[]> => {
  if (!q.trim()) return []
  const uw = await getUserAndWorkspaceByEmail(
    db,
    auth.workspaceExternalId,
    auth.email,
  )
  if (!uw?.user || !uw?.workspace) {
    throw new UserOrWorkspaceNotFoundError()
  }
  // TODO: push the LIKE into SQL — kept in-memory to mirror v1's behaviour
  // exactly. Fine for the workspace sizes we have today; revisit if user
  // counts grow.
  const rows = await db
    .select({
      id: users.externalId,
      name: users.name,
      email: users.email,
      photoLink: users.photoLink,
    })
    .from(users)
    .where(
      and(eq(users.workspaceId, uw.workspace.id), isNull(users.deletedAt)),
    )
  const needle = q.toLowerCase()
  return rows
    .filter(
      (u) =>
        u.name.toLowerCase().includes(needle) ||
        u.email.toLowerCase().includes(needle),
    )
    .slice(0, limit)
    .map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      photoLink: u.photoLink ?? null,
    }))
}
