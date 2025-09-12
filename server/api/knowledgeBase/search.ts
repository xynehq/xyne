import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { db } from "@/db/client"
import { getUserByEmail } from "@/db/user"
import { getAccessibleCollections } from "@/db/knowledgeBase"
import { getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import config from "@/config"
import {
  collections,
  collectionItems,
  type Collection,
  type CollectionItem,
} from "@/db/schema"
import { and, eq, isNull, ilike, or, desc, asc } from "drizzle-orm"
import { getAuth, safeGet } from "../agent"
import { ApiKeyScopes } from "@/shared/types"

const { JwtPayloadKey } = config
const loggerWithChild = getLoggerWithChild(Subsystem.Api)

// Schema for search request
export const searchKnowledgeBaseSchema = z.object({
  query: z.string().optional(),
  type: z
    .enum(["collection", "folder", "file", "all"])
    .optional()
    .default("all"),
  collectionId: z.string().optional(), // If provided, search only within this collection
  limit: z
    .string()
    .optional()
    .default("20")
    .transform((value) => parseInt(value, 10))
    .refine((value) => !isNaN(value) && value >= 1 && value <= 100, {
      message: "Limit must be a number between 1 and 100",
    }),
  offset: z
    .string()
    .optional()
    .default("0")
    .transform((value) => parseInt(value, 10))
    .refine((value) => !isNaN(value) && value >= 0, {
      message: "Offset must be a number greater than or equal to 0",
    }),
})

export type SearchKnowledgeBaseRequest = z.infer<
  typeof searchKnowledgeBaseSchema
>

// Response types
export interface SearchKnowledgeBaseResult {
  id: string
  name: string
  type: "collection" | "folder" | "file"
  description?: string
  collectionId?: string
  collectionName?: string
  parentId?: string | null
  path?: string
  mimeType?: string
  fileSize?: number
  totalItems?: number // For collections
  totalFileCount?: number // For folders
  createdAt: Date
  updatedAt: Date
  isPrivate?: boolean // For collections
  metadata?: any
}

export interface SearchKnowledgeBaseResponse {
  results: SearchKnowledgeBaseResult[]
  total: number
  hasMore: boolean
}

/**
 * Search collections, folders, and files from PostgreSQL
 * This API provides search functionality for the agent creation dropdown
 * when Vespa search is not available due to permissions
 */
export const SearchKnowledgeBaseApi = async (c: Context) => {
  const { email: userEmail, via_apiKey } = getAuth(c)

  if (via_apiKey) {
    const apiKeyScopes =
      safeGet<{ scopes?: string[] }>(c, "config")?.scopes || []
    if (!apiKeyScopes.includes(ApiKeyScopes.SEARCH_COLLECTION)) {
      return c.json(
        { message: "API key does not have scope to search collections" },
        403,
      )
    }
  }

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    // @ts-ignore - query validation handled by zValidator
    const params = c.req.valid("query") as SearchKnowledgeBaseRequest
    const { query, type, collectionId, limit, offset } = params

    loggerWithChild({ email: userEmail }).info(
      `Searching knowledge base: query="${query}", type="${type}", collectionId="${collectionId}", limit=${limit}, offset=${offset}`,
    )

    const results: SearchKnowledgeBaseResult[] = []

    // Search collections (if type allows)
    if (type === "all" || type === "collection") {
      const accessibleCollections = await getAccessibleCollections(db, user.id)

      let filteredCollections = accessibleCollections

      // Filter by search query if provided
      if (query && query.trim()) {
        const searchTerm = query.trim().toLowerCase()
        filteredCollections = accessibleCollections.filter(
          (collection) =>
            collection.name.toLowerCase().includes(searchTerm) ||
            (collection.description &&
              collection.description.toLowerCase().includes(searchTerm)),
        )
      }

      // Add collections to results
      filteredCollections.forEach((collection) => {
        results.push({
          id: collection.id,
          name: collection.name,
          type: "collection",
          description: collection.description || undefined,
          totalItems: collection.totalItems || 0,
          createdAt: collection.createdAt,
          updatedAt: collection.updatedAt,
          isPrivate: collection.isPrivate,
          metadata: collection.metadata,
        })
      })
    }

    // Search folders and files (if type allows)
    if (type === "all" || type === "folder" || type === "file") {
      // Get accessible collections first
      const accessibleCollections = await getAccessibleCollections(db, user.id)
      const accessibleCollectionIds = accessibleCollections.map((c) => c.id)

      if (accessibleCollectionIds.length > 0) {
        // Build where conditions
        const whereConditions = [
          isNull(collectionItems.deletedAt),
          or(
            ...accessibleCollectionIds.map((id) =>
              eq(collectionItems.collectionId, id),
            ),
          ),
        ]

        // Filter by collection if specified
        if (collectionId) {
          // Verify user has access to this collection
          const hasAccess = accessibleCollectionIds.includes(collectionId)
          if (!hasAccess) {
            throw new HTTPException(403, {
              message: "You don't have access to this collection",
            })
          }
          whereConditions.push(eq(collectionItems.collectionId, collectionId))
        }

        // Filter by type if specified (not "all")
        if (type === "folder") {
          whereConditions.push(eq(collectionItems.type, "folder"))
        } else if (type === "file") {
          whereConditions.push(eq(collectionItems.type, "file"))
        }

        // Add search query filter if provided
        if (query && query.trim()) {
          const searchTerm = `%${query.trim()}%`
          whereConditions.push(
            or(
              ilike(collectionItems.name, searchTerm),
              ilike(collectionItems.originalName, searchTerm),
              ilike(collectionItems.path, searchTerm),
            ),
          )
        }

        // Execute the query with joins to get collection names - fetch ALL matching items
        const itemsQuery = await db
          .select({
            id: collectionItems.id,
            name: collectionItems.name,
            originalName: collectionItems.originalName,
            type: collectionItems.type,
            collectionId: collectionItems.collectionId,
            collectionName: collections.name,
            parentId: collectionItems.parentId,
            path: collectionItems.path,
            mimeType: collectionItems.mimeType,
            fileSize: collectionItems.fileSize,
            totalFileCount: collectionItems.totalFileCount,
            createdAt: collectionItems.createdAt,
            updatedAt: collectionItems.updatedAt,
            metadata: collectionItems.metadata,
          })
          .from(collectionItems)
          .innerJoin(
            collections,
            eq(collectionItems.collectionId, collections.id),
          )
          .where(and(...whereConditions))
          .orderBy(
            desc(collectionItems.type), // Folders first, then files
            asc(collectionItems.name),
          )
        // Remove limit and offset here - we'll paginate the final combined results

        // Add items to results
        itemsQuery.forEach((item) => {
          results.push({
            id: item.id,
            name: item.originalName || item.name,
            type: item.type as "folder" | "file",
            collectionId: item.collectionId,
            collectionName: item.collectionName,
            parentId: item.parentId,
            path: item.path || undefined,
            mimeType: item.mimeType || undefined,
            fileSize: item.fileSize || undefined,
            totalFileCount: item.totalFileCount || undefined,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            metadata: item.metadata,
          })
        })
      }
    }

    // Sort results by type priority and name
    results.sort((a, b) => {
      // Priority: collections first, then folders, then files
      const typePriority = { collection: 0, folder: 1, file: 2 }
      const aPriority = typePriority[a.type]
      const bPriority = typePriority[b.type]

      if (aPriority !== bPriority) {
        return aPriority - bPriority
      }

      // Within same type, sort by name
      return a.name.localeCompare(b.name)
    })

    // Apply pagination to combined results
    const paginatedResults = results.slice(offset, offset + limit)
    const hasMore = results.length > offset + limit

    const response: SearchKnowledgeBaseResponse = {
      results: paginatedResults,
      total: results.length, // Total results found
      hasMore,
    }

    loggerWithChild({ email: userEmail }).info(
      `Knowledge base search completed: ${response.results.length} results returned, ${response.total} total found`,
    )

    return c.json(response)
  } catch (error) {
    if (error instanceof HTTPException) throw error
    if (error instanceof z.ZodError) {
      throw new HTTPException(400, {
        message: `Invalid request data: ${JSON.stringify(error.issues)}`,
      })
    }

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to search knowledge base: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to search knowledge base",
    })
  }
}
