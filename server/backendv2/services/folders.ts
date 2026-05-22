// FoldersService — CRUD for the "Projects" feature plus the membership
// operations (add/remove a conversation to/from a folder).
//
// Auth model mirrors ChatService's Viewer:
//   • userId = JWT subject (email) — same shape as v2_chat_conversations.owner_id
//   • workspaceId = JWT workspaceId (external id) — same shape as
//     v2_chat_conversations.workspace_id
// Every read filters by ownerId; every write re-reads the row and re-checks
// ownership before touching it. Folders are soft-deleted via is_deleted, never
// hard-deleted. When a folder is soft-deleted we null out folder_id on all of
// its conversations in the same transaction so the FK's ON DELETE SET NULL is
// just defence in depth.

import { and, desc, eq, sql } from "drizzle-orm"

import { db } from "@/db/client"
import { v2ChatFolders } from "@/db/schema/conversationFolders"
import { v2ChatConversations } from "@/db/schema/v2Chat"
import { type FolderId, asFolderId } from "../agent/storage/types"
import { type Viewer } from "../agent/services/chat"

// Viewer lives in agent/services/chat.ts so the JWT → Viewer translation is
// in one place; folders use the same shape (userId = email, workspaceId =
// workspace external id).
export type FolderAuth = Viewer

// ─── Domain shapes ──────────────────────────────────────────────────────────
export type Folder = {
  id: FolderId
  ownerId: string
  workspaceId: string
  name: string
  description: string | null
  createdAt: number
  updatedAt: number
}

/** Augmented view used by the sidebar "most-used" listing. Carries the
 *  derived signal we sort by so the UI can render "Last activity 3m ago"
 *  next to each folder without a second roundtrip. */
export type FolderWithActivity = Folder & {
  /** MAX(conversation.updated_at) for conversations in this folder, or null
   *  when the folder is empty. */
  lastTouchedAt: number | null
  conversationCount: number
}

// ─── Typed errors ───────────────────────────────────────────────────────────
export class FolderNotFoundError extends Error {
  public override readonly name = "FolderNotFoundError"
  public constructor(public readonly id: string) {
    super(`Folder ${id} not found`)
  }
}

export class FolderForbiddenError extends Error {
  public override readonly name = "FolderForbiddenError"
  public constructor() {
    super("Not your folder")
  }
}

export class InvalidFolderPayloadError extends Error {
  public override readonly name = "InvalidFolderPayloadError"
  public constructor(message: string) {
    super(message)
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const newFolderId = (): FolderId =>
  asFolderId(`folder_${crypto.randomUUID()}`)
const now = (): number => Date.now()

const NAME_MAX = 120
const DESC_MAX = 2000

const normaliseName = (raw: string | undefined): string => {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) {
    throw new InvalidFolderPayloadError("name is required")
  }
  if (trimmed.length > NAME_MAX) {
    throw new InvalidFolderPayloadError(
      `name must be ${NAME_MAX} characters or fewer`,
    )
  }
  return trimmed
}

const normaliseDescription = (
  raw: string | undefined | null,
): string | null => {
  if (raw === undefined || raw === null) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.length > DESC_MAX) {
    throw new InvalidFolderPayloadError(
      `description must be ${DESC_MAX} characters or fewer`,
    )
  }
  return trimmed
}

type FolderRow = typeof v2ChatFolders.$inferSelect

const rowToFolder = (row: FolderRow): Folder => ({
  id: asFolderId(row.id),
  ownerId: row.ownerId,
  workspaceId: row.workspaceId,
  name: row.name,
  description: row.description ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

// ─── Service ────────────────────────────────────────────────────────────────
export class FoldersService {
  /** List every non-deleted folder owned by the viewer, newest first. */
  public async list(auth: FolderAuth): Promise<Folder[]> {
    const rows = await db
      .select()
      .from(v2ChatFolders)
      .where(
        and(
          eq(v2ChatFolders.ownerId, String(auth.userId)),
          eq(v2ChatFolders.isDeleted, false),
        ),
      )
      .orderBy(desc(v2ChatFolders.updatedAt))
    return rows.map(rowToFolder)
  }

  /** Sidebar "top N" listing. Sorted by recency of activity inside the folder
   *  (MAX(conversation.updated_at)), falling back to the folder's own
   *  updated_at when the folder is empty. */
  public async listMostUsed(
    auth: FolderAuth,
    limit: number,
  ): Promise<FolderWithActivity[]> {
    const cappedLimit = Math.max(1, Math.min(limit, 50))
    // Left join: empty folders still show up but with lastTouchedAt=null.
    // NULLS LAST so folders with no conversations sort after active ones.
    const rows = await db
      .select({
        folder: v2ChatFolders,
        lastTouchedAt: sql<
          number | null
        >`max(${v2ChatConversations.updatedAt})`.as("last_touched_at"),
        conversationCount: sql<number>`count(${v2ChatConversations.id})::int`.as(
          "conversation_count",
        ),
      })
      .from(v2ChatFolders)
      .leftJoin(
        v2ChatConversations,
        and(
          eq(v2ChatConversations.folderId, v2ChatFolders.id),
          // Exclude archived conversations from the activity metric so
          // soft-deleted chats don't keep a stale folder pinned to the top.
          sql`${v2ChatConversations.archivedAt} is null`,
        ),
      )
      .where(
        and(
          eq(v2ChatFolders.ownerId, String(auth.userId)),
          eq(v2ChatFolders.isDeleted, false),
        ),
      )
      .groupBy(v2ChatFolders.id)
      .orderBy(
        sql`max(${v2ChatConversations.updatedAt}) desc nulls last`,
        desc(v2ChatFolders.updatedAt),
      )
      .limit(cappedLimit)

    return rows.map((r) => ({
      ...rowToFolder(r.folder),
      lastTouchedAt: r.lastTouchedAt ?? null,
      conversationCount: Number(r.conversationCount ?? 0),
    }))
  }

  public async get(auth: FolderAuth, folderId: string): Promise<Folder> {
    const folder = await this.readOwn(auth, folderId)
    return folder
  }

  public async create(
    auth: FolderAuth,
    payload: { name?: string; description?: string | null },
  ): Promise<Folder> {
    const name = normaliseName(payload.name)
    const description = normaliseDescription(payload.description)
    const id = newFolderId()
    const ts = now()
    const rows = await db
      .insert(v2ChatFolders)
      .values({
        id: String(id),
        ownerId: String(auth.userId),
        workspaceId: String(auth.workspaceId),
        name,
        description,
        createdAt: ts,
        updatedAt: ts,
        isDeleted: false,
      })
      .returning()
    const row = rows[0]
    if (!row) {
      throw new Error("v2ChatFolders: insert returned no row")
    }
    return rowToFolder(row)
  }

  public async update(
    auth: FolderAuth,
    folderId: string,
    patch: { name?: string; description?: string | null },
  ): Promise<Folder> {
    await this.readOwn(auth, folderId) // permission check
    const set: Record<string, unknown> = { updatedAt: now() }
    if (patch.name !== undefined) {
      set.name = normaliseName(patch.name)
    }
    if (patch.description !== undefined) {
      set.description = normaliseDescription(patch.description)
    }
    // Nothing to update besides updatedAt? Still bump — caller asked for it.
    const rows = await db
      .update(v2ChatFolders)
      .set(set)
      .where(eq(v2ChatFolders.id, folderId))
      .returning()
    const row = rows[0]
    if (!row) {
      throw new FolderNotFoundError(folderId)
    }
    return rowToFolder(row)
  }

  /** Soft-delete the folder (is_deleted=true) AND null out folder_id on every
   *  conversation that was in it. The FK ON DELETE SET NULL only fires on
   *  hard-delete, which we never do — so we maintain the same end-state
   *  explicitly in a transaction. */
  public async softDelete(auth: FolderAuth, folderId: string): Promise<void> {
    await this.readOwn(auth, folderId)
    await db.transaction(async (tx) => {
      await tx
        .update(v2ChatConversations)
        .set({ folderId: null, updatedAt: now() })
        .where(eq(v2ChatConversations.folderId, folderId))
      await tx
        .update(v2ChatFolders)
        .set({ isDeleted: true, updatedAt: now() })
        .where(eq(v2ChatFolders.id, folderId))
    })
  }

  /** Put a conversation into this folder. Idempotent — re-adding a conversation
   *  that's already in the folder is a no-op (bumps folder.updated_at though,
   *  which feeds "most used" so the sidebar reorders). */
  public async addConversation(
    auth: FolderAuth,
    folderId: string,
    conversationId: string,
  ): Promise<void> {
    const folder = await this.readOwn(auth, folderId)
    // Conversation ownership check — the row must belong to the viewer.
    const convRows = await db
      .select({
        id: v2ChatConversations.id,
        ownerId: v2ChatConversations.ownerId,
      })
      .from(v2ChatConversations)
      .where(eq(v2ChatConversations.id, conversationId))
      .limit(1)
    const conv = convRows[0]
    if (!conv) {
      throw new FolderNotFoundError(conversationId)
    }
    if (conv.ownerId !== String(auth.userId)) {
      throw new FolderForbiddenError()
    }
    await db.transaction(async (tx) => {
      await tx
        .update(v2ChatConversations)
        .set({ folderId: folder.id, updatedAt: now() })
        .where(eq(v2ChatConversations.id, conversationId))
      await tx
        .update(v2ChatFolders)
        .set({ updatedAt: now() })
        .where(eq(v2ChatFolders.id, folderId))
    })
  }

  /** Remove a conversation from this folder (sets folder_id=null). Bounded by
   *  the (folderId, conversationId) tuple so a stale UI move-back doesn't
   *  inadvertently un-file a conversation that's since been moved elsewhere. */
  public async removeConversation(
    auth: FolderAuth,
    folderId: string,
    conversationId: string,
  ): Promise<void> {
    await this.readOwn(auth, folderId)
    const convRows = await db
      .select({
        id: v2ChatConversations.id,
        ownerId: v2ChatConversations.ownerId,
      })
      .from(v2ChatConversations)
      .where(eq(v2ChatConversations.id, conversationId))
      .limit(1)
    const conv = convRows[0]
    if (!conv) return // nothing to remove
    if (conv.ownerId !== String(auth.userId)) {
      throw new FolderForbiddenError()
    }
    await db
      .update(v2ChatConversations)
      .set({ folderId: null, updatedAt: now() })
      .where(
        and(
          eq(v2ChatConversations.id, conversationId),
          eq(v2ChatConversations.folderId, folderId),
        ),
      )
  }

  // ─── Internal ────────────────────────────────────────────────────────────
  /** Read a folder + assert it belongs to the viewer and isn't soft-deleted.
   *  Single source of truth for the auth check across get/update/delete/move. */
  private async readOwn(
    auth: FolderAuth,
    folderId: string,
  ): Promise<Folder> {
    const rows = await db
      .select()
      .from(v2ChatFolders)
      .where(eq(v2ChatFolders.id, folderId))
      .limit(1)
    const row = rows[0]
    if (!row || row.isDeleted) {
      throw new FolderNotFoundError(folderId)
    }
    if (row.ownerId !== String(auth.userId)) {
      throw new FolderForbiddenError()
    }
    return rowToFolder(row)
  }
}
