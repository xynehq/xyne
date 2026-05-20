// SubAgentsService — CRUD over the sub_agents table, scoped by a parent
// agent + the caller's workspace.
//
// Permission model mirrors AgentsService:
//   • read  (list / get)         → caller must have *any* access to the
//                                   parent agent (public viewer, viewer,
//                                   editor, or owner). Same predicate as
//                                   AgentsService.get.
//   • write (create / update /
//           remove)              → caller must be owner or editor on the
//                                   parent. Same predicate as
//                                   AgentsService.update.
//
// Sub-agents inherit the parent's workspace_id at insert time — they
// never live under a parent in a different workspace. The unique
// (parent_agent_id, name) index gives nice "name already used" errors at
// the DB layer; we surface them as a typed error so the route can return
// 409.
//
// We intentionally do NOT expose `parent_agent_id` directly on the wire.
// The parent is identified by external_id in the URL; sub-agents carry
// their own external_id + name + description + systemPrompt + tools.

import { and, eq, isNull } from "drizzle-orm"
import { z } from "zod"

import { db } from "@/db/client"
import {
  getAgentByExternalIdWithPermissionCheck,
} from "@/db/agent"
import {
  checkUserAgentAccessByExternalId,
} from "@/db/userAgentPermission"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { subAgents } from "@/db/schema"
import {
  subAgentThinkingLevelSchema,
  type SubAgentThinkingLevel,
} from "@/db/schema/subAgents"
import { UserAgentRole } from "@/shared/types"

// `createId` is the same opaque-id minter used for agents / chats.
import { createId } from "@paralleldrive/cuid2"

import {
  AgentNotFoundOrForbiddenError,
  UpdateHasNoFieldsError,
  UserOrWorkspaceNotFoundError,
  type Auth,
} from "./agents"

// ─── Public shapes ──────────────────────────────────────────────────────────

/** Subset of the sub_agents row we expose to the UI / runner. Numeric ids
 *  and FK references stay server-side; the wire-facing identity is the
 *  prefixed external_id. */
export type SubAgentPublic = {
  externalId: string
  name: string
  description: string
  systemPrompt: string
  tools: string[]
  // Reasoning effort for the nested pi-mono session. Configured per
  // sub-agent (not inherited from the parent at dispatch time). One of
  // "minimal" | "low" | "medium" | "high".
  thinkingLevel: SubAgentThinkingLevel
  createdAt: string
  updatedAt: string
}

// Name slug: lowercase, starts with a letter, hyphens allowed. Constrained
// so the parent LLM can refer to it unambiguously in dispatchSubagent's
// `name` argument; matches the column-level constraint enforced in
// db/schema/subAgents.ts.
const subAgentNameSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(
    /^[a-z][a-z0-9-]*$/,
    "name must be a lowercase slug ([a-z][a-z0-9-]*)",
  )

export const createSubAgentSchema = z.object({
  name: subAgentNameSchema,
  description: z.string().min(1).max(500),
  systemPrompt: z.string().min(1),
  tools: z.array(z.string()).optional().default([]),
  // Optional on create — defaults to "medium" if omitted. Callers
  // (UI form, API consumers) can still pin the level explicitly.
  thinkingLevel: subAgentThinkingLevelSchema.optional().default("medium"),
})
export type CreateSubAgentPayload = z.infer<typeof createSubAgentSchema>

export const updateSubAgentSchema = createSubAgentSchema.partial()
export type UpdateSubAgentPayload = z.infer<typeof updateSubAgentSchema>

// ─── Typed errors ───────────────────────────────────────────────────────────

export class SubAgentNotFoundError extends Error {
  public override readonly name = "SubAgentNotFoundError"
  public constructor(public readonly externalId: string) {
    super(`Sub-agent ${externalId} not found`)
  }
}

/** Raised when the unique (parent_agent_id, name) constraint fires on
 *  insert/update. Route maps it to 409 Conflict. */
export class SubAgentNameTakenError extends Error {
  public override readonly name = "SubAgentNameTakenError"
  public constructor(
    public readonly parentExternalId: string,
    public readonly takenName: string,
  ) {
    super(
      `A sub-agent named "${takenName}" already exists under parent ${parentExternalId}`,
    )
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

export class SubAgentsService {
  /** Resolve (numericUserId, numericWorkspaceId) from the JWT auth bundle.
   *  Same shape AgentsService uses. Centralised so every method shares the
   *  "User or workspace not found" branch. */
  private async resolveAuth(
    auth: Auth,
  ): Promise<{ userId: number; workspaceId: number }> {
    const uw = await getUserAndWorkspaceByEmail(
      db,
      auth.workspaceExternalId,
      auth.email,
    )
    if (!uw?.user || !uw?.workspace) {
      throw new UserOrWorkspaceNotFoundError()
    }
    return { userId: uw.user.id, workspaceId: uw.workspace.id }
  }

  /** Common prelude: confirm the caller has access to the parent agent
   *  (the level depends on `mode`) and return the parent's numeric id +
   *  workspace_id so write operations can reuse them.
   *
   *  `mode = "read"`  → any access role passes (matches AgentsService.get).
   *  `mode = "write"` → owner|editor only (matches AgentsService.update). */
  private async loadParent(
    auth: Auth,
    parentExternalId: string,
    mode: "read" | "write",
  ): Promise<{ id: number; workspaceId: number }> {
    const { userId, workspaceId } = await this.resolveAuth(auth)
    const parent = await getAgentByExternalIdWithPermissionCheck(
      db,
      parentExternalId,
      workspaceId,
      userId,
    )
    if (!parent) {
      throw new AgentNotFoundOrForbiddenError(parentExternalId)
    }
    if (mode === "write") {
      const perms = await checkUserAgentAccessByExternalId(
        db,
        userId,
        parentExternalId,
        workspaceId,
      )
      const my = perms?.find((p) => p.userId === userId)
      if (
        !my ||
        (my.role !== UserAgentRole.Owner && my.role !== UserAgentRole.Editor)
      ) {
        throw new AgentNotFoundOrForbiddenError(parentExternalId)
      }
    }
    return { id: parent.id, workspaceId: parent.workspaceId }
  }

  // The DB stores `tools` as JSONB. Postgres returns whatever shape it
  // serialised — fence at the boundary so callers see a clean `string[]`
  // regardless of how the row was written (legacy null, accidental object,
  // etc.).
  private static normaliseTools(raw: unknown): string[] {
    if (!Array.isArray(raw)) return []
    return raw.filter((t): t is string => typeof t === "string")
  }

  // Coerce a raw text column value into the closed SubAgentThinkingLevel
  // set. If the DB carries something unexpected (e.g. a leftover row
  // from before the column existed, or a future variant rolled in via
  // a different code path), fall back to "medium" rather than crash.
  // Same defensive-at-the-boundary principle as normaliseTools.
  private static normaliseThinkingLevel(raw: unknown): SubAgentThinkingLevel {
    const parsed = subAgentThinkingLevelSchema.safeParse(raw)
    return parsed.success ? parsed.data : "medium"
  }

  private static toPublic(row: {
    externalId: string
    name: string
    description: string
    systemPrompt: string
    tools: unknown
    thinkingLevel: unknown
    createdAt: Date
    updatedAt: Date
  }): SubAgentPublic {
    return {
      externalId: row.externalId,
      name: row.name,
      description: row.description,
      systemPrompt: row.systemPrompt,
      tools: SubAgentsService.normaliseTools(row.tools),
      thinkingLevel: SubAgentsService.normaliseThinkingLevel(row.thinkingLevel),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  public async list(
    auth: Auth,
    parentExternalId: string,
  ): Promise<SubAgentPublic[]> {
    const parent = await this.loadParent(auth, parentExternalId, "read")
    const rows = await db
      .select()
      .from(subAgents)
      .where(
        and(
          eq(subAgents.parentAgentId, parent.id),
          isNull(subAgents.deletedAt),
        ),
      )
      .orderBy(subAgents.createdAt)
    return rows.map(SubAgentsService.toPublic)
  }

  public async get(
    auth: Auth,
    parentExternalId: string,
    subExternalId: string,
  ): Promise<SubAgentPublic> {
    const parent = await this.loadParent(auth, parentExternalId, "read")
    const rows = await db
      .select()
      .from(subAgents)
      .where(
        and(
          eq(subAgents.parentAgentId, parent.id),
          eq(subAgents.externalId, subExternalId),
          isNull(subAgents.deletedAt),
        ),
      )
      .limit(1)
    if (!rows[0]) throw new SubAgentNotFoundError(subExternalId)
    return SubAgentsService.toPublic(rows[0])
  }

  public async create(
    auth: Auth,
    parentExternalId: string,
    payload: CreateSubAgentPayload,
  ): Promise<SubAgentPublic> {
    const parent = await this.loadParent(auth, parentExternalId, "write")
    const row = {
      externalId: `sub-${createId()}`,
      parentAgentId: parent.id,
      workspaceId: parent.workspaceId,
      name: payload.name,
      description: payload.description,
      systemPrompt: payload.systemPrompt,
      tools: payload.tools ?? [],
      thinkingLevel: payload.thinkingLevel ?? "medium",
    }
    try {
      const inserted = await db.insert(subAgents).values(row).returning()
      return SubAgentsService.toPublic(inserted[0]!)
    } catch (err) {
      // postgres-js raises a code-bearing error for unique violations; the
      // unique index name `sub_agents_name_per_parent_unique` tells us
      // exactly which constraint failed. Anything else propagates so the
      // route's error mapper can return 500.
      if (
        err instanceof Error &&
        /sub_agents_name_per_parent_unique/.test(err.message)
      ) {
        throw new SubAgentNameTakenError(parentExternalId, payload.name)
      }
      throw err
    }
  }

  public async update(
    auth: Auth,
    parentExternalId: string,
    subExternalId: string,
    payload: UpdateSubAgentPayload,
  ): Promise<SubAgentPublic> {
    if (Object.keys(payload).length === 0) {
      throw new UpdateHasNoFieldsError()
    }
    const parent = await this.loadParent(auth, parentExternalId, "write")

    // Build the SET clause without spreading `undefined`s — drizzle would
    // happily overwrite the column with NULL otherwise.
    const updateData: Record<string, unknown> = { updatedAt: new Date() }
    if (payload.name !== undefined) updateData["name"] = payload.name
    if (payload.description !== undefined)
      updateData["description"] = payload.description
    if (payload.systemPrompt !== undefined)
      updateData["systemPrompt"] = payload.systemPrompt
    if (payload.tools !== undefined) updateData["tools"] = payload.tools
    if (payload.thinkingLevel !== undefined)
      updateData["thinkingLevel"] = payload.thinkingLevel

    try {
      const rows = await db
        .update(subAgents)
        .set(updateData)
        .where(
          and(
            eq(subAgents.parentAgentId, parent.id),
            eq(subAgents.externalId, subExternalId),
            isNull(subAgents.deletedAt),
          ),
        )
        .returning()
      if (!rows[0]) throw new SubAgentNotFoundError(subExternalId)
      return SubAgentsService.toPublic(rows[0])
    } catch (err) {
      if (
        err instanceof Error &&
        /sub_agents_name_per_parent_unique/.test(err.message)
      ) {
        throw new SubAgentNameTakenError(parentExternalId, payload.name ?? "")
      }
      throw err
    }
  }

  public async remove(
    auth: Auth,
    parentExternalId: string,
    subExternalId: string,
  ): Promise<SubAgentPublic> {
    const parent = await this.loadParent(auth, parentExternalId, "write")
    const rows = await db
      .update(subAgents)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(subAgents.parentAgentId, parent.id),
          eq(subAgents.externalId, subExternalId),
          isNull(subAgents.deletedAt),
        ),
      )
      .returning()
    if (!rows[0]) throw new SubAgentNotFoundError(subExternalId)
    return SubAgentsService.toPublic(rows[0])
  }
}
