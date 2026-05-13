import { type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { db } from "@/db/client"
import { workspaces, users } from "@/db/schema"
import { eq, and } from "drizzle-orm"
import {
  createCollection,
  getCollectionsByOwner,
  getCollectionById,
  getCollectionByName,
  getCollectionItemsByParent,
} from "@/db/knowledgeBase"
import { deleteCollection } from "@/api/knowledgeBase"
import { boss, FileProcessingQueue } from "@/queue/api-server-queue"
import { ProcessingJobType } from "@/types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server)

/**
 * Resolves the SDK user's external workspace ID and email to internal integer IDs
 * needed by the collections/collection_items tables.
 */
async function resolveSdkIdentity(c: Context): Promise<{
  workspaceId: number
  userId: number
  workspaceExternalId: string
  userEmail: string
}> {
  // Dashboard JWT path
  const payload = c.get("jwtPayload") as
    | { sub?: string; workspaceId?: string }
    | undefined
  // API key middleware path
  const apiKeyWorkspaceId = c.get("workspaceId") as string | undefined
  const apiKeyUserEmail = c.get("userEmail") as string | undefined

  const workspaceExternalId = apiKeyWorkspaceId ?? payload?.workspaceId
  const userEmail = apiKeyUserEmail ?? payload?.sub

  if (!workspaceExternalId || !userEmail) {
    throw new HTTPException(401, { message: "Could not resolve identity" })
  }

  // Lookup workspace internal ID
  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.externalId, workspaceExternalId))
    .limit(1)

  if (!workspace) {
    throw new HTTPException(404, { message: "Workspace not found" })
  }

  // Lookup user internal ID
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, userEmail))
    .limit(1)

  if (!user) {
    throw new HTTPException(404, { message: "User not found" })
  }

  return {
    workspaceId: workspace.id,
    userId: user.id,
    workspaceExternalId,
    userEmail,
  }
}

/**
 * Resolves the workspace external ID to the admin email (workspaces.createdBy).
 * This is used to scope Vespa queries — documents have `createdBy = adminEmail`.
 */
export async function resolveWorkspaceCreator(
  workspaceExternalId: string,
): Promise<string> {
  const [workspace] = await db
    .select({ createdBy: workspaces.createdBy })
    .from(workspaces)
    .where(eq(workspaces.externalId, workspaceExternalId))
    .limit(1)

  if (!workspace) {
    throw new HTTPException(404, { message: "Workspace not found" })
  }

  return workspace.createdBy
}

/**
 * Resolves a collection name to its UUID for the given workspace.
 * Returns undefined if collectionName is not provided.
 * Throws 404 if the name doesn't match any collection.
 */
export async function resolveCollectionId(
  workspaceExternalId: string,
  collectionName: string | undefined,
): Promise<string | undefined> {
  if (!collectionName) return undefined

  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.externalId, workspaceExternalId))
    .limit(1)

  if (!workspace) {
    throw new HTTPException(404, { message: "Workspace not found" })
  }

  const collection = await getCollectionByName(db, workspace.id, collectionName)
  if (!collection) {
    throw new HTTPException(404, {
      message: `Collection "${collectionName}" not found`,
    })
  }

  return collection.id
}

/**
 * GET /api/sdk/dashboard/collections
 * Lists all collections owned by the current SDK user.
 */
export const ListSdkCollectionsApi = async (c: Context) => {
  const { userId } = await resolveSdkIdentity(c)

  const results = await getCollectionsByOwner(db, userId)

  return c.json({
    collections: results.map((col) => ({
      id: col.id,
      name: col.name,
      description: col.description,
      totalItems: col.totalItems,
      uploadStatus: col.uploadStatus,
      createdAt: col.createdAt,
      updatedAt: col.updatedAt,
    })),
  })
}

/**
 * POST /api/sdk/dashboard/collections
 * Creates a new collection for the SDK user.
 */
export const CreateSdkCollectionApi = async (c: Context) => {
  const { name, description } = c.req.valid("json" as never)
  const { workspaceId, userId } = await resolveSdkIdentity(c)

  const collection = await createCollection(db, {
    workspaceId,
    ownerId: userId,
    name: name as string,
    description: (description as string) ?? null,
    isPrivate: true,
    via_apiKey: false,
  })

  // Enqueue collection processing job (creates skeleton Vespa doc)
  await boss.send(
    FileProcessingQueue,
    {
      collectionId: collection.id,
      type: ProcessingJobType.COLLECTION,
    },
    { retryLimit: 3 },
  )

  return c.json(
    {
      id: collection.id,
      name: collection.name,
      description: collection.description,
      uploadStatus: collection.uploadStatus,
      createdAt: collection.createdAt,
    },
    201,
  )
}

/**
 * DELETE /api/sdk/dashboard/collections/:collectionId
 * Deletes a collection and all its items.
 */
export const DeleteSdkCollectionApi = async (c: Context) => {
  const collectionId = c.req.param("collectionId")
  const { userId, userEmail } = await resolveSdkIdentity(c)

  // Verify collection exists and belongs to this user
  const collection = await getCollectionById(db, collectionId)
  if (!collection) {
    throw new HTTPException(404, { message: "Collection not found" })
  }
  if (collection.ownerId !== userId) {
    throw new HTTPException(403, { message: "Not the collection owner" })
  }

  const { success, deletedCount, deletedFiles, deletedFolders } =
    await deleteCollection(db, collectionId, userEmail)

  if (!success) {
    throw new HTTPException(500, { message: "Failed to delete collection" })
  }

  Logger.info(
    `SDK deleted collection ${collectionId}: ${deletedCount} items, ${deletedFiles} files, ${deletedFolders} folders`,
  )

  return c.json({ success: true, deletedCount, deletedFiles, deletedFolders })
}

/**
 * GET /api/sdk/dashboard/collections/:collectionId/items
 * Lists items in a collection (root level).
 */
export const ListSdkCollectionItemsApi = async (c: Context) => {
  const collectionId = c.req.param("collectionId")
  const { userId } = await resolveSdkIdentity(c)

  const collection = await getCollectionById(db, collectionId)
  if (!collection) {
    throw new HTTPException(404, { message: "Collection not found" })
  }
  if (collection.ownerId !== userId) {
    throw new HTTPException(403, { message: "Not the collection owner" })
  }

  const parentId = c.req.query("parentId") || null
  const items = await getCollectionItemsByParent(db, collectionId, parentId)

  return c.json({
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      mimeType: item.mimeType,
      fileSize: item.fileSize,
      uploadStatus: item.uploadStatus,
      statusMessage: item.statusMessage,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
  })
}
