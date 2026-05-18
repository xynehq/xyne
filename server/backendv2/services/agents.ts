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
  deleteAgentByExternalIdWithPermissionCheck,
  getAgentsAccessibleToUser,
  getAgentsMadeByMe,
  getAgentsSharedToMe,
} from "@/db/agent"
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

// ─── Input shapes ───────────────────────────────────────────────────────────

export type Auth = {
  email: string
  workspaceExternalId: string
}

export const listAgentsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
  filter: z.enum(["all", "madeByMe", "sharedToMe"]).optional().default("all"),
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
    const { filter, limit, offset } = query
    switch (filter) {
      case "madeByMe":
        return getAgentsMadeByMe(db, userId, workspaceId, limit, offset)
      case "sharedToMe":
        return getAgentsSharedToMe(db, userId, workspaceId, limit, offset)
      case "all":
      default:
        return getAgentsAccessibleToUser(db, userId, workspaceId, limit, offset)
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
}

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
