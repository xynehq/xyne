import type { Tool } from "@xynehq/jaf"
import { ToolErrorCodes, ToolResponse } from "@xynehq/jaf"
import { Apps } from "@xyne/vespa-ts/types"
import { and, eq, inArray, isNull } from "drizzle-orm"
import { z, type ZodType } from "zod"
import {
  buildKnowledgeBaseCollectionSelections,
  KnowledgeBaseScope,
  type KnowledgeBaseSelection,
} from "@/api/chat/knowledgeBaseSelections"
import { db } from "@/db/client"
import {
  getCollectionById,
  getCollectionItemById,
  getCollectionLsProjection,
  getCollectionsByOwner,
  recordCollectionLsProjectionError,
  upsertCollectionLsProjection,
} from "@/db/knowledgeBase"
import {
  collectionItems,
  type Collection,
  type CollectionItem,
  type CollectionLsProjection,
} from "@/db/schema"
import { getUserByEmail } from "@/db/user"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import { executeVespaSearch } from "./global"
import type { Ctx } from "./types"
import { parseAgentAppIntegrations } from "./utils"

const Logger = getLogger(Subsystem.Chat)

// Narrows JAF tool parameter typing from a Zod schema.
type ToolSchemaParameters<T> = Tool<T, Ctx>["schema"]["parameters"]
// Bridges a Zod schema into the tool parameter type expected by JAF.
const toToolSchemaParameters = <T>(
  schema: ZodType<T>,
): ToolSchemaParameters<T> => schema as unknown as ToolSchemaParameters<T>

const KNOWLEDGE_BASE_TARGET_DESCRIPTION =
  "A discriminated knowledge-base target object for browse/search. Set `type` to one of `collection`, `folder`, `file`, or `path`, then provide only the matching ID/path fields for that variant."

const KNOWLEDGE_BASE_OFFSET_DESCRIPTION =
  "Pagination offset. Use it after reviewing the current page to continue from the next unseen rows or fragments."

const KNOWLEDGE_BASE_EXCLUDED_IDS_DESCRIPTION =
  "Previously seen result document `docId`s to suppress on follow-up KB searches. Prefer `fragment.source.docId` values from prior results. Do not pass collection, folder, file, path, or fragment IDs."

export const LS_KNOWLEDGE_BASE_TOOL_DESCRIPTION = [
  "Browse the caller's accessible knowledge-base namespace.",
  "Use it to discover collections, inspect folder/file layout, confirm canonical paths, answer inventory or metadata questions directly, or obtain IDs for a later `searchKnowledgeBase.filters.targets` call.",
  "It is especially useful when the user wants answers constrained by structure or metadata such as a specific folder, collection, file set, or file type like PDFs.",
  "Skip `ls` only when the exact KB scope is already known and browsing will not improve the answer.",
  "Start shallow with `depth: 1` and `metadata: false` if unsure; but you are always free to enable metadata or deepen traversal only when the task truly needs row details or more hierarchy.",
].join(" ")

export const SEARCH_KNOWLEDGE_BASE_TOOL_DESCRIPTION = [
  "Search document content inside the caller's accessible knowledge-base scope and return cited fragments.",
  "Use it directly when the task is about document contents and the relevant KB scope is already known or broad KB search is acceptable.",
  "Pair it with `ls` when you need structural scoping, canonical-path confirmation, or file preselection such as searching only .txt files from a folder.",
  "If the collection, folder, file, or path is known, pass it in `filters.targets`; file targets can come from prior `ls` output.",
  "`filters.targets` narrows search by location, while `excludedIds` should contain previously seen document/result IDs to avoid rereading the same hits.",
].join(" ")

export const KnowledgeBaseTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("collection"),
    collectionId: z
      .string()
      .describe(
        "Knowledge-base collection row ID as a string, typically a UUID. Reuse `ls` output directly here: for a collection row, pass `entries[i].id`; for a previously targeted `ls` response, pass `target.collection_id`. This stays a collection DB ID through KB search and is translated downstream into Vespa `clId` filtering. Do not pass a folder ID, file ID, or path here.",
      ),
  }).describe(
    "Object shape: `{ type: \"collection\", collectionId: string }`. Targets an entire collection root. Best when the user names a known collection or you want to browse/search everything inside it.",
  ),
  z.object({
    type: z.literal("folder"),
    folderId: z
      .string()
      .describe(
        "Knowledge-base folder row ID as a string, typically a UUID. Reuse `ls` output directly here: when an `ls` entry has `type: \"folder\"`, pass that row's `id` as `folderId`. This is later translated into KB folder selections and then Vespa `clFd` filtering. Do not pass a collection ID, file ID, or path here.",
      ),
  }).describe(
    "Object shape: `{ type: \"folder\", folderId: string }`. Targets a folder subtree inside a collection. Useful after `ls` returns a folder ID or the folder is already known.",
  ),
  z.object({
    type: z.literal("file"),
    fileId: z
      .string()
      .describe(
        "Knowledge-base file row ID as a string, typically a UUID. Reuse `ls` output directly here: when an `ls` entry has `type: \"file\"`, pass that row's `id` as `fileId`. This is later translated into the file's Vespa document `docId` filtering downstream. Do not pass a collection ID, folder ID, or path here.",
      ),
  }).describe(
    "Object shape: `{ type: \"file\", fileId: string }`. Targets one exact file. Use for pinpointed browsing/search when the relevant document is already known.",
  ),
  z.object({
    type: z.literal("path"),
    collectionId: z
      .string()
      .describe(
        "Knowledge-base collection row ID as a string, typically a UUID. Required with `type: \"path\"` so the path is resolved inside the correct collection. Reuse `ls` output directly here with `entries[i].collection_id` or `target.collection_id` from a prior targeted `ls` response.",
      ),
    path: z
      .string()
      .describe(
        "Collection-relative path string such as `/`, `/Policies`, `/Policies/Security`, or `/Policies/Security.md`. Reuse `ls` output directly here with `entries[i].path` or `target.path` from a prior targeted `ls` response. A missing leading slash is accepted and will be canonicalized. `path: \"/\"` means the collection root. `.` and `..` path segments are invalid. The resolved path is then translated into collection, folder, or file search scope before Vespa filtering.",
      ),
  }).describe(
    "Object shape: `{ type: \"path\", collectionId: string, path: string }`. Targets a collection-relative path when the location is known or easier to express than raw folder/file IDs.",
  ),
]).describe(KNOWLEDGE_BASE_TARGET_DESCRIPTION)

export type KnowledgeBaseTarget = z.infer<typeof KnowledgeBaseTargetSchema>

export const LsKnowledgeBaseInputSchema = z.object({
  target: KnowledgeBaseTargetSchema.optional().describe(
    "Optional KB location to browse. Omit it to list accessible collections. Provide a collection, folder, file, or path target when you already know where to inspect or when the user asked about a specific location.",
  ),
  depth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .default(1)
    .describe(
      "Traversal depth from the target. `1` lists immediate children only. Start shallow and increase depth only when the task truly needs more hierarchy.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Maximum number of browse rows to return from the flattened listing. Keep this small for discovery and page with `offset` when needed.",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe(KNOWLEDGE_BASE_OFFSET_DESCRIPTION),
  metadata: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Return persisted row metadata when true. Leave false for normal navigation; enable when you need details like description, mime type for filtering PDFs or other file types, timestamps, or collection metadata.",
    ),
}).describe(
  "Browse accessible knowledge-base collections, folders, and files. Use for navigation and scope discovery, not for full-text retrieval.",
)

export type LsKnowledgeBaseToolParams = z.infer<
  typeof LsKnowledgeBaseInputSchema
>
export const SearchKnowledgeBaseInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Short, content-focused KB retrieval query. Use the semantic terms you expect inside documents, not navigation instructions. If the scope is known, narrow with `filters.targets` instead of stuffing paths or folder names into the query.",
    ),
  filters: z
    .object({
      targets: z
        .array(KnowledgeBaseTargetSchema)
        .min(1)
        .optional()
        .describe(
          "Optional union of KB locations to search inside the current allowed scope. Each target may be a collection root, folder subtree, exact file, or collection-relative path. Use this when the user query or prior `ls` output tells you where to search; file targets are especially useful after `ls` identifies a subset such as PDFs.",
        ),
    })
    .optional()
    .describe(
      "Optional structural scope for KB search. Omit it when a broad search across the caller's allowed KB scope is appropriate.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe(
      "Maximum number of KB fragments to return (up to 25). Keep this tight for precision-first retrieval; raise it only when the user needs broader coverage.",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(KNOWLEDGE_BASE_OFFSET_DESCRIPTION),
  excludedIds: z
    .array(z.string())
    .optional()
    .describe(KNOWLEDGE_BASE_EXCLUDED_IDS_DESCRIPTION),
}).describe(
  "Full-text search over document content in the caller's accessible knowledge-base scope.",
)

export type SearchKnowledgeBaseToolParams = z.infer<
  typeof SearchKnowledgeBaseInputSchema
>

// Reuses the global Vespa search implementation shape for dependency injection in tests.
type SearchExecutor = typeof executeVespaSearch

// Carries the resolved KB scope and selection state for the current tool execution.
type KnowledgeBaseScopeState = {
  email: string
  scope: KnowledgeBaseScope
  selectedItems: Partial<Record<Apps, string[]>>
  baseSelections: KnowledgeBaseSelection[]
}

// Represents a navigable KB item inside an in-memory tree or projection snapshot.
type KnowledgeBaseNavigationNode = {
  id: string
  parent_id: string | null
  collection_id: string
  type: "folder" | "file"
  name: string
  path: string
}

const CollectionLsProjectionPayloadSchema = z.object({
  rootIds: z.array(z.string()),
  childrenByParentId: z.record(z.string(), z.array(z.string())),
  nodesById: z.record(
    z.string(),
    z.object({
      id: z.string(),
      parent_id: z.string().nullable(),
      collection_id: z.string(),
      type: z.enum(["folder", "file"]),
      name: z.string(),
      path: z.string(),
    }),
  ),
  nodeIdByPath: z.record(z.string(), z.string()),
})

// Describes the persisted latest-only projection payload stored for ls traversal.
type CollectionLsProjectionPayload = z.infer<
  typeof CollectionLsProjectionPayloadSchema
>

// Holds the normalized navigation state needed to resolve and traverse a collection.
type KnowledgeBaseNavigationSnapshot = {
  collection: Collection
  rootIds: string[]
  childrenByParentId: Map<string, string[]>
  nodesById: Map<string, KnowledgeBaseNavigationNode>
  nodeIdByPath: Map<string, string>
}

// Groups the DB and projection operations the KB flow depends on.
type KnowledgeBaseRepository = {
  getUserByEmail: (email: string) => Promise<{ id: number } | null>
  listUserScopedCollections: (userId: number) => Promise<Collection[]>
  getCollectionById: (collectionId: string) => Promise<Collection | null>
  getCollectionItemById: (itemId: string) => Promise<CollectionItem | null>
  listCollectionItems: (collectionId: string) => Promise<CollectionItem[]>
  listCollectionItemsByIds?: (
    collectionId: string,
    itemIds: string[],
  ) => Promise<CollectionItem[]>
  getCollectionLsProjection?: (
    collectionId: string,
  ) => Promise<CollectionLsProjection | null>
  upsertCollectionLsProjection?: (params: {
    collectionId: string
    projection: CollectionLsProjectionPayload
    builtFromSourceUpdatedAt: Date
    lastError?: string | null
  }) => Promise<CollectionLsProjection>
  recordCollectionLsProjectionError?: (
    collectionId: string,
    lastError: string,
  ) => Promise<void>
}

// Represents a fully resolved KB target that browse/search can safely operate on.
type ResolvedKnowledgeBaseTarget =
  | {
      // Used when the target resolves to the collection root itself.
      kind: "collection"
      targetType: KnowledgeBaseTarget["type"]
      collection: Collection
      path: "/"
      snapshot: KnowledgeBaseNavigationSnapshot
    }
  | {
      // Used when the target resolves to a concrete folder or file node.
      kind: "node"
      targetType: KnowledgeBaseTarget["type"]
      collection: Collection
      node: KnowledgeBaseNavigationNode
      path: string
      snapshot: KnowledgeBaseNavigationSnapshot
    }

// Returns the merged search selections along with the resolved targets that produced them.
type SearchSelectionBuildResult = {
  selections: KnowledgeBaseSelection[]
  resolvedTargets: ResolvedKnowledgeBaseTarget[]
}

// Models one final ls row returned to the agent.
type LsEntry = {
  id: string
  type: "collection" | "folder" | "file"
  name: string
  path: string
  collection_id?: string
  parent_id?: string | null
  depth: number
  details?: Record<string, unknown>
}

// Captures a traversed node before optional live metadata hydration.
type LsEntrySeed = {
  id: string
  type: "folder" | "file"
  name: string
  path: string
  collection_id: string
  parent_id: string | null
  depth: number
}

// Separates direct-scan and projection-backed snapshots within one request.
type NavigationCache = {
  direct: Map<string, KnowledgeBaseNavigationSnapshot>
  projection: Map<string, KnowledgeBaseNavigationSnapshot>
}

// Wires the production DB-backed repository used by the KB flow.
const defaultKnowledgeBaseRepository: KnowledgeBaseRepository = {
  async getUserByEmail(email) {
    const [user] = await getUserByEmail(db, email)
    return user ? { id: user.id } : null
  },
  async listUserScopedCollections(userId) {
    return getCollectionsByOwner(db, userId)
  },
  async getCollectionById(collectionId) {
    return getCollectionById(db, collectionId)
  },
  async getCollectionItemById(itemId) {
    return getCollectionItemById(db, itemId)
  },
  async listCollectionItems(collectionId) {
    return db
      .select()
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.collectionId, collectionId),
          isNull(collectionItems.deletedAt),
        ),
      )
  },
  async listCollectionItemsByIds(collectionId, itemIds) {
    if (!itemIds.length) return []
    return db
      .select()
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.collectionId, collectionId),
          inArray(collectionItems.id, itemIds),
          isNull(collectionItems.deletedAt),
        ),
      )
  },
  async getCollectionLsProjection(collectionId) {
    return getCollectionLsProjection(db, collectionId)
  },
  async upsertCollectionLsProjection(params) {
    return upsertCollectionLsProjection(db, params)
  },
  async recordCollectionLsProjectionError(collectionId, lastError) {
    await recordCollectionLsProjectionError(db, collectionId, lastError)
  },
}

// Creates request-local caches so repeated resolutions do not rescan the same collection.
function createNavigationCache(): NavigationCache {
  return {
    direct: new Map(),
    projection: new Map(),
  }
}

// Canonicalizes collection-relative KB paths and rejects unsupported path segments.
export function canonicalizeKnowledgeBasePath(path: string): string {
  const rawPath = path.trim()
  if (!rawPath) return "/"

  const normalized = rawPath.startsWith("/") ? rawPath : `/${rawPath}`
  const collapsed = normalized.replace(/\/+/g, "/")
  const segments = collapsed.split("/").filter(Boolean)

  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Knowledge base paths cannot contain '.' or '..'")
  }

  return segments.length ? `/${segments.join("/")}` : "/"
}

// Builds the canonical absolute path for a persisted KB item row.
function buildItemCanonicalPath(
  item: Pick<CollectionItem, "name" | "path">,
): string {
  return canonicalizeKnowledgeBasePath(
    item.path === "/" ? `/${item.name}` : `${item.path}/${item.name}`,
  )
}

// Converts a persisted KB row into the lightweight navigation node shape.
function buildNavigationNode(
  item: Pick<
    CollectionItem,
    "id" | "parentId" | "collectionId" | "type" | "name" | "path"
  >,
): KnowledgeBaseNavigationNode {
  return {
    id: item.id,
    parent_id: item.parentId,
    collection_id: item.collectionId,
    type: item.type,
    name: item.name,
    path: buildItemCanonicalPath(item),
  }
}

// Keeps traversal order stable and folder-first for ls responses.
function sortItemsForTraversal(items: CollectionItem[]): CollectionItem[] {
  return [...items].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "folder" ? -1 : 1
    }
    if (left.position !== right.position) {
      return left.position - right.position
    }
    return left.name.localeCompare(right.name)
  })
}

// Builds an in-memory collection tree directly from live item rows.
function buildCollectionTree(
  collection: Collection,
  items: CollectionItem[],
): KnowledgeBaseNavigationSnapshot {
  const nodesById = new Map<string, KnowledgeBaseNavigationNode>()
  const nodeIdByPath = new Map<string, string>()
  const childItemsByParentId = new Map<string | null, CollectionItem[]>()

  for (const item of items) {
    const siblings = childItemsByParentId.get(item.parentId ?? null) ?? []
    siblings.push(item)
    childItemsByParentId.set(item.parentId ?? null, siblings)
  }

  const childrenByParentId = new Map<string, string[]>()
  let rootIds: string[] = []

  for (const item of items) {
    const node = buildNavigationNode(item)
    nodesById.set(node.id, node)
    nodeIdByPath.set(node.path, node.id)
  }

  rootIds = sortItemsForTraversal(childItemsByParentId.get(null) ?? []).map(
    (item) => item.id,
  )

  for (const [parentId, children] of childItemsByParentId.entries()) {
    if (!parentId) continue
    childrenByParentId.set(
      parentId,
      sortItemsForTraversal(children).map((item) => item.id),
    )
  }

  return {
    collection,
    rootIds,
    childrenByParentId,
    nodesById,
    nodeIdByPath,
  }
}

// Produces the normalized projection payload persisted for target-scoped ls.
function buildCollectionLsProjection(
  items: CollectionItem[],
): CollectionLsProjectionPayload {
  const nodesById: Record<string, KnowledgeBaseNavigationNode> = {}
  const nodeIdByPath: Record<string, string> = {}
  const childItemsByParentId = new Map<string | null, CollectionItem[]>()

  for (const item of items) {
    const siblings = childItemsByParentId.get(item.parentId ?? null) ?? []
    siblings.push(item)
    childItemsByParentId.set(item.parentId ?? null, siblings)

    const node = buildNavigationNode(item)
    nodesById[node.id] = node
    nodeIdByPath[node.path] = node.id
  }

  const rootIds = sortItemsForTraversal(
    childItemsByParentId.get(null) ?? [],
  ).map((item) => item.id)

  const childrenByParentId: Record<string, string[]> = {}
  for (const [parentId, children] of childItemsByParentId.entries()) {
    if (!parentId) continue
    childrenByParentId[parentId] = sortItemsForTraversal(children).map(
      (item) => item.id,
    )
  }

  return {
    rootIds,
    childrenByParentId,
    nodesById,
    nodeIdByPath,
  }
}

// Rehydrates an in-memory navigation snapshot from a stored projection row.
function buildSnapshotFromProjection(
  collection: Collection,
  projection: CollectionLsProjectionPayload,
): KnowledgeBaseNavigationSnapshot {
  return {
    collection,
    rootIds: projection.rootIds,
    childrenByParentId: new Map(
      Object.entries(projection.childrenByParentId).map(
        ([parentId, childIds]) => [parentId, childIds],
      ),
    ),
    nodesById: new Map(
      Object.entries(projection.nodesById).map(([nodeId, node]) => [
        nodeId,
        node,
      ]),
    ),
    nodeIdByPath: new Map(
      Object.entries(projection.nodeIdByPath).map(([path, nodeId]) => [
        path,
        nodeId,
      ]),
    ),
  }
}

// Validates and parses the stored projection payload before traversal.
function parseCollectionLsProjection(
  projection: unknown,
): CollectionLsProjectionPayload {
  return CollectionLsProjectionPayloadSchema.parse(projection)
}

// Compares a stored projection against the collection staleness watermark.
function isProjectionStale(
  collection: Collection,
  projection: CollectionLsProjection | null,
): boolean {
  if (!projection) return true

  return (
    projection.builtFromSourceUpdatedAt.getTime() <
    collection.lsProjectionSourceUpdatedAt.getTime()
  )
}

// Resolves the current caller's KB scope and base selections from agent context.
async function buildScopeState(
  context: Pick<Ctx, "agentPrompt" | "user">,
): Promise<KnowledgeBaseScopeState> {
  const email = context.user.email
  const { selectedItems } = parseAgentAppIntegrations(context.agentPrompt)
  const scope = context.agentPrompt
    ? KnowledgeBaseScope.AgentScoped
    : KnowledgeBaseScope.UserOwned
  const baseSelections = await buildKnowledgeBaseCollectionSelections({
    scope,
    email,
    selectedItems,
  })

  return {
    email,
    scope,
    selectedItems,
    baseSelections,
  }
}

// Lists only the collections available under the caller's effective KB scope.
async function listScopedCollections(
  repo: KnowledgeBaseRepository,
  scopeState: KnowledgeBaseScopeState,
): Promise<Collection[]> {
  if (scopeState.scope !== KnowledgeBaseScope.AgentScoped) {
    const user = await repo.getUserByEmail(scopeState.email)
    if (!user) {
      throw new Error(
        "User email not found while resolving knowledge base scope",
      )
    }
    return repo.listUserScopedCollections(user.id)
  }

  const collectionIds = new Set<string>()
  for (const selection of scopeState.baseSelections) {
    selection.collectionIds?.forEach((id) => collectionIds.add(id))

    for (const folderId of selection.collectionFolderIds ?? []) {
      const folder = await repo.getCollectionItemById(folderId)
      if (folder) collectionIds.add(folder.collectionId)
    }

    for (const fileId of selection.collectionFileIds ?? []) {
      const file = await repo.getCollectionItemById(fileId)
      if (file) collectionIds.add(file.collectionId)
    }
  }

  const collections = await Promise.all(
    Array.from(collectionIds).map((collectionId) =>
      repo.getCollectionById(collectionId),
    ),
  )

  return collections.filter(
    (collection): collection is Collection => !!collection,
  )
}

// Loads a live navigation snapshot by scanning all items in one collection.
async function loadDirectNavigationSnapshot(
  collectionId: string,
  repo: KnowledgeBaseRepository,
  cache: NavigationCache,
): Promise<KnowledgeBaseNavigationSnapshot> {
  const cached = cache.direct.get(collectionId)
  if (cached) return cached

  const collection = await repo.getCollectionById(collectionId)
  if (!collection) {
    throw new Error(`Knowledge base collection '${collectionId}' was not found`)
  }

  const items = await repo.listCollectionItems(collectionId)
  const snapshot = buildCollectionTree(collection, items)
  cache.direct.set(collectionId, snapshot)
  return snapshot
}

// Rebuilds and persists the latest projection snapshot for one collection.
async function rebuildCollectionProjection(
  collection: Collection,
  repo: KnowledgeBaseRepository,
): Promise<KnowledgeBaseNavigationSnapshot> {
  const items = await repo.listCollectionItems(collection.id)
  const projection = buildCollectionLsProjection(items)

  if (repo.upsertCollectionLsProjection) {
    await repo.upsertCollectionLsProjection({
      collectionId: collection.id,
      projection,
      builtFromSourceUpdatedAt: collection.lsProjectionSourceUpdatedAt,
      lastError: null,
    })
  }

  return buildSnapshotFromProjection(collection, projection)
}

// Loads a projection-backed snapshot and lazily rebuilds it when stale or missing. Main entry function
async function loadProjectionNavigationSnapshot(
  collectionId: string,
  repo: KnowledgeBaseRepository,
  cache: NavigationCache,
): Promise<KnowledgeBaseNavigationSnapshot> {
  const cached = cache.projection.get(collectionId)
  if (cached) return cached

  const collection = await repo.getCollectionById(collectionId)
  if (!collection) {
    throw new Error(`Knowledge base collection '${collectionId}' was not found`)
  }

  if (!repo.getCollectionLsProjection) {
    return loadDirectNavigationSnapshot(collectionId, repo, cache)
  }

  const existingProjection = await repo.getCollectionLsProjection(collectionId)
  if (!isProjectionStale(collection, existingProjection)) {
    const snapshot = buildSnapshotFromProjection(
      collection,
      parseCollectionLsProjection(existingProjection?.projection),
    )
    cache.projection.set(collectionId, snapshot)
    return snapshot
  }

  try {
    const snapshot = await rebuildCollectionProjection(collection, repo)
    cache.projection.set(collectionId, snapshot)
    return snapshot
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    try {
      await repo.recordCollectionLsProjectionError?.(collectionId, errorMessage)
    } catch {}

    return loadDirectNavigationSnapshot(collectionId, repo, cache)
  }
}

// Checks whether a node falls within a folder-scoped agent selection.
function isDescendantOfFolder(
  snapshot: KnowledgeBaseNavigationSnapshot,
  nodeId: string,
  folderId: string,
): boolean {
  let current = snapshot.nodesById.get(nodeId)
  while (current) {
    if (current.id === folderId) return true
    current = current.parent_id
      ? snapshot.nodesById.get(current.parent_id)
      : undefined
  }
  return false
}

// Enforces that a resolved target does not widen the current KB scope.
function isResolvedTargetAllowed(
  resolvedTarget: ResolvedKnowledgeBaseTarget,
  scopeState: KnowledgeBaseScopeState,
  scopedCollectionIds: Set<string>,
): boolean {
  if (scopeState.scope !== KnowledgeBaseScope.AgentScoped) {
    return scopedCollectionIds.has(resolvedTarget.collection.id)
  }

  if (!scopeState.baseSelections.length) return false

  return scopeState.baseSelections.some((selection) => {
    if (selection.collectionIds?.includes(resolvedTarget.collection.id)) {
      return true
    }

    if (resolvedTarget.kind !== "node") {
      return false
    }

    if (
      resolvedTarget.node.type === "file" &&
      selection.collectionFileIds?.includes(resolvedTarget.node.id)
    ) {
      return true
    }

    return (
      selection.collectionFolderIds?.some((folderId) =>
        isDescendantOfFolder(
          resolvedTarget.snapshot,
          resolvedTarget.node.id,
          folderId,
        ),
      ) ?? false
    )
  })
}

// Converts one resolved target into the search selection shape expected downstream.
function toSelectionForResolvedTarget(
  resolvedTarget: ResolvedKnowledgeBaseTarget,
): KnowledgeBaseSelection {
  if (resolvedTarget.kind === "collection") {
    return { collectionIds: [resolvedTarget.collection.id] }
  }

  if (resolvedTarget.node.type === "folder") {
    return { collectionFolderIds: [resolvedTarget.node.id] }
  }

  return { collectionFileIds: [resolvedTarget.node.id] }
}

// Unions collection, folder, and file selections while removing duplicates.
function mergeSelections(
  selections: KnowledgeBaseSelection[],
): KnowledgeBaseSelection[] {
  if (!selections.length) return []

  const collectionIds = new Set<string>()
  const collectionFolderIds = new Set<string>()
  const collectionFileIds = new Set<string>()

  for (const selection of selections) {
    selection.collectionIds?.forEach((id) => collectionIds.add(id))
    selection.collectionFolderIds?.forEach((id) => collectionFolderIds.add(id))
    selection.collectionFileIds?.forEach((id) => collectionFileIds.add(id))
  }

  const merged: KnowledgeBaseSelection = {}
  if (collectionIds.size) merged.collectionIds = Array.from(collectionIds)
  if (collectionFolderIds.size) {
    merged.collectionFolderIds = Array.from(collectionFolderIds)
  }
  if (collectionFileIds.size) {
    merged.collectionFileIds = Array.from(collectionFileIds)
  }

  return Object.keys(merged).length ? [merged] : []
}

// Resolves a target contract into a collection root or concrete node snapshot. Translation 
async function resolveKnowledgeBaseTarget(
  target: KnowledgeBaseTarget,
  repo: KnowledgeBaseRepository,
  cache: NavigationCache,
): Promise<ResolvedKnowledgeBaseTarget> {
  switch (target.type) {
    case "collection": {
      const snapshot = await loadProjectionNavigationSnapshot(
        target.collectionId,
        repo,
        cache,
      )
      return {
        kind: "collection",
        targetType: target.type,
        collection: snapshot.collection,
        path: "/",
        snapshot,
      }
    }
    case "path": {
      const snapshot = await loadProjectionNavigationSnapshot(
        target.collectionId,
        repo,
        cache,
      )
      const path = canonicalizeKnowledgeBasePath(target.path)
      if (path === "/") {
        return {
          kind: "collection",
          targetType: target.type,
          collection: snapshot.collection,
          path,
          snapshot,
        }
      }

      const nodeId = snapshot.nodeIdByPath.get(path)
      if (!nodeId) {
        throw new Error(
          `Knowledge base path '${path}' was not found in collection '${target.collectionId}'`,
        )
      }

      const node = snapshot.nodesById.get(nodeId)
      if (!node) {
        throw new Error(
          `Knowledge base path '${path}' could not be resolved in collection '${target.collectionId}'`,
        )
      }

      return {
        kind: "node",
        targetType: target.type,
        collection: snapshot.collection,
        node,
        path,
        snapshot,
      }
    }
    case "folder":
    case "file": {
      const itemId = target.type === "folder" ? target.folderId : target.fileId
      const directItem = await repo.getCollectionItemById(itemId)
      if (!directItem || directItem.type !== target.type) {
        throw new Error(
          `Knowledge base ${target.type} '${itemId}' was not found`,
        )
      }

      const snapshot = await loadProjectionNavigationSnapshot(
        directItem.collectionId,
        repo,
        cache,
      )
      const node = snapshot.nodesById.get(itemId)
      if (!node || node.type !== target.type) {
        throw new Error(
          `Knowledge base ${target.type} '${itemId}' was not found`,
        )
      }

      return {
        kind: "node",
        targetType: target.type,
        collection: snapshot.collection,
        node,
        path: node.path,
        snapshot,
      }
    }
  }
}

// Resolves search targets and maps them into the scoped KB selection format.
async function buildSearchSelections(
  params: SearchKnowledgeBaseToolParams,
  scopeState: KnowledgeBaseScopeState,
  repo: KnowledgeBaseRepository,
): Promise<SearchSelectionBuildResult> {
  if (!params.filters?.targets?.length) {
    return {
      selections: scopeState.baseSelections,
      resolvedTargets: [],
    }
  }

  const scopedCollections = await listScopedCollections(repo, scopeState)
  const scopedCollectionIds = new Set(
    scopedCollections.map((collection) => collection.id),
  )
  const cache = createNavigationCache()
  const resolvedTargets: ResolvedKnowledgeBaseTarget[] = []
  const selections: KnowledgeBaseSelection[] = []

  for (const target of params.filters.targets) {
    const resolvedTarget = await resolveKnowledgeBaseTarget(target, repo, cache)
    if (
      !isResolvedTargetAllowed(resolvedTarget, scopeState, scopedCollectionIds)
    ) {
      throw new Error(
        "Requested knowledge base target is outside the current KB scope",
      )
    }

    resolvedTargets.push(resolvedTarget)
    selections.push(toSelectionForResolvedTarget(resolvedTarget))
  }

  return {
    selections: mergeSelections(selections),
    resolvedTargets,
  }
}

// Shapes a collection row for no-target ls responses.
function createCollectionLsEntry(
  collection: Collection,
  includeMetadata: boolean,
): LsEntry {
  const entry: LsEntry = {
    id: collection.id,
    type: "collection",
    name: collection.name,
    path: "/",
    depth: 0,
  }

  if (includeMetadata) {
    entry.details = {
      total_items: collection.totalItems,
      name: collection.name,
      last_updated_by_email: collection.lastUpdatedByEmail,
      description: collection.description,
      updated_at: collection.updatedAt,
      created_at: collection.createdAt,
      metadata: collection.metadata,
    }
  }

  return entry
}

// Captures the minimal ls row state needed before metadata hydration.
function createSeedEntry(
  node: KnowledgeBaseNavigationNode,
  depth: number,
): LsEntrySeed {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    path: node.path,
    collection_id: node.collection_id,
    parent_id: node.parent_id,
    depth,
  }
}

// Combines traversal output with optional live item metadata for the response.
function createItemLsEntry(
  seed: LsEntrySeed,
  item: CollectionItem | null,
  includeMetadata: boolean,
): LsEntry {
  const entry: LsEntry = {
    id: seed.id,
    type: seed.type,
    name: seed.name,
    path: seed.path,
    collection_id: seed.collection_id,
    parent_id: seed.parent_id,
    depth: seed.depth,
  }

  if (includeMetadata && item) {
    entry.details = {
      type: item.type,
      name: item.name,
      collection_id: item.collectionId,
      mime_type: item.mimeType,
      updated_at: item.updatedAt,
      created_at: item.createdAt,
      metadata: item.metadata,
      ...(item.type === "folder"
        ? { total_file_count: item.totalFileCount }
        : {}),
    }
  }

  return entry
}

function summarizeResolvedTargetForLog(
  resolvedTarget: ResolvedKnowledgeBaseTarget,
) {
  return {
    kind: resolvedTarget.kind,
    targetType: resolvedTarget.targetType,
    collectionId: resolvedTarget.collection.id,
    collectionName: resolvedTarget.collection.name,
    path: resolvedTarget.path,
    ...(resolvedTarget.kind === "node"
      ? {
          node: {
            id: resolvedTarget.node.id,
            type: resolvedTarget.node.type,
            name: resolvedTarget.node.name,
            parentId: resolvedTarget.node.parent_id,
          },
        }
      : {}),
  }
}

// Traverses a resolved target into ordered ls seeds up to the requested depth.
function flattenLsEntries(
  resolvedTarget: ResolvedKnowledgeBaseTarget,
  depthLimit: number,
): LsEntrySeed[] {
  if (resolvedTarget.kind === "node" && resolvedTarget.node.type === "file") {
    return [createSeedEntry(resolvedTarget.node, 0)]
  }

  const rootIds =
    resolvedTarget.kind === "collection"
      ? resolvedTarget.snapshot.rootIds
      : (resolvedTarget.snapshot.childrenByParentId.get(
          resolvedTarget.node.id,
        ) ?? [])

  const entries: LsEntrySeed[] = []
  const stack = rootIds
    .slice()
    .reverse()
    .map((nodeId) => ({
      nodeId,
      depth: 1,
    }))

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue

    const node = resolvedTarget.snapshot.nodesById.get(current.nodeId)
    if (!node) continue

    entries.push(createSeedEntry(node, current.depth))

    if (current.depth >= depthLimit || node.type !== "folder") {
      continue
    }

    const childIds =
      resolvedTarget.snapshot.childrenByParentId.get(node.id) ?? []
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      stack.push({
        nodeId: childIds[index]!,
        depth: current.depth + 1,
      })
    }
  }

  return entries
}

// Loads only the persisted rows needed to hydrate paginated ls entries.
async function hydrateCollectionItemsForEntries(
  collectionId: string,
  itemIds: string[],
  repo: KnowledgeBaseRepository,
): Promise<Map<string, CollectionItem>> {
  if (!itemIds.length) return new Map()

  const items = repo.listCollectionItemsByIds
    ? await repo.listCollectionItemsByIds(collectionId, itemIds)
    : (await repo.listCollectionItems(collectionId)).filter((item) =>
        itemIds.includes(item.id),
      )

  return new Map(items.map((item) => [item.id, item]))
}

// Builds the paginated ls payload for a resolved collection, folder, or file target.
async function buildLsEntries(
  resolvedTarget: ResolvedKnowledgeBaseTarget,
  params: Pick<
    LsKnowledgeBaseToolParams,
    "depth" | "limit" | "offset" | "metadata"
  >,
  repo: KnowledgeBaseRepository,
): Promise<{ entries: LsEntry[]; total: number }> {
  const rawEntries = flattenLsEntries(resolvedTarget, params.depth ?? 1)
  const offset = params.offset ?? 0
  const limit = params.limit
  const paginatedEntries =
    typeof limit === "number"
      ? rawEntries.slice(offset, offset + limit)
      : rawEntries.slice(offset)

  const hydratedItems = params.metadata
    ? await hydrateCollectionItemsForEntries(
        resolvedTarget.collection.id,
        paginatedEntries.map((entry) => entry.id),
        repo,
      )
    : new Map<string, CollectionItem>()

  return {
    entries: paginatedEntries.map((entry) =>
      createItemLsEntry(
        entry,
        params.metadata ? (hydratedItems.get(entry.id) ?? null) : null,
        params.metadata ?? false,
      ),
    ),
    total: rawEntries.length,
  }
}

// Executes the internal ls tool over the caller's scoped KB view.
export async function executeLsKnowledgeBase(
  params: LsKnowledgeBaseToolParams,
  context: Ctx,
  repo: KnowledgeBaseRepository = defaultKnowledgeBaseRepository,
) {
  const email = context.user.email
  if (!email) {
    return ToolResponse.error(
      ToolErrorCodes.MISSING_REQUIRED_FIELD,
      "User email not found while executing ls",
      { toolName: "ls" },
    )
  }

  try {
    const scopeState = await buildScopeState(context)
    const collections = await listScopedCollections(repo, scopeState)
    if (!collections.length) {
      return ToolResponse.error(
        ToolErrorCodes.EXECUTION_FAILED,
        "No accessible knowledge base collections found for this user",
        { toolName: "ls" },
      )
    }

    const offset = params.offset ?? 0
    const limit = params.limit

    if (!params.target) {
      const entries = collections.map((collection) =>
        createCollectionLsEntry(collection, params.metadata ?? false),
      )
      const paginatedEntries =
        typeof limit === "number"
          ? entries.slice(offset, offset + limit)
          : entries.slice(offset)
      const response = {
        target: null,
        entries: paginatedEntries,
        total: entries.length,
        offset,
        limit: limit ?? paginatedEntries.length,
      }

      Logger.info(
        {
          email,
          scope: scopeState.scope,
          target: null,
          result: response,
        },
        "[KnowledgeBase][ls] Returning top-level browse result",
      )

      return ToolResponse.success(response)
    }

    const cache = createNavigationCache()
    const scopedCollectionIds = new Set(
      collections.map((collection) => collection.id),
    )
    const resolvedTarget = await resolveKnowledgeBaseTarget(
      params.target,
      repo,
      cache,
    )

    if (
      !isResolvedTargetAllowed(resolvedTarget, scopeState, scopedCollectionIds)
    ) {
      return ToolResponse.error(
        ToolErrorCodes.PERMISSION_DENIED,
        "Requested knowledge base target is outside the current KB scope",
        { toolName: "ls" },
      )
    }

    const { entries, total } = await buildLsEntries(
      resolvedTarget,
      params,
      repo,
    )
    const response = {
      target: {
        type:
          resolvedTarget.kind === "collection"
            ? "collection"
            : resolvedTarget.node.type,
        collection_id: resolvedTarget.collection.id,
        id:
          resolvedTarget.kind === "collection"
            ? resolvedTarget.collection.id
            : resolvedTarget.node.id,
        path: resolvedTarget.path,
      },
      entries,
      total,
      offset,
      limit: limit ?? entries.length,
    }

    Logger.info(
      {
        email,
        scope: scopeState.scope,
        requestedTarget: params.target,
        resolvedTarget: summarizeResolvedTargetForLog(resolvedTarget),
        result: response,
      },
      "[KnowledgeBase][ls] Returning targeted browse result",
    )

    return ToolResponse.success(response)
  } catch (error) {
    return ToolResponse.error(
      ToolErrorCodes.EXECUTION_FAILED,
      `Knowledge base browse failed: ${getErrorMessage(error)}`,
      { toolName: "ls" },
    )
  }
}

// Executes the internal KB search tool after resolving scoped target filters. Main function entry point for serachKB tool.
export async function executeSearchKnowledgeBase(
  params: SearchKnowledgeBaseToolParams,
  context: Ctx,
  options: {
    repo?: KnowledgeBaseRepository
    searchExecutor?: SearchExecutor
  } = {},
) {
  const email = context.user.email
  if (!email) {
    return ToolResponse.error(
      ToolErrorCodes.MISSING_REQUIRED_FIELD,
      "User email not found while executing searchKnowledgeBase",
      { toolName: "searchKnowledgeBase" },
    )
  }

  const query = params.query?.trim()
  if (!query) {
    return ToolResponse.error(
      ToolErrorCodes.MISSING_REQUIRED_FIELD,
      "Query cannot be empty for knowledge base search",
      { toolName: "searchKnowledgeBase" },
    )
  }

  const repo = options.repo ?? defaultKnowledgeBaseRepository
  const searchExecutor = options.searchExecutor ?? executeVespaSearch

  try {
    const scopeState = await buildScopeState(context)
    Logger.info(
      {
        email,
        scope: scopeState.scope,
        baseSelectionCount: scopeState.baseSelections.length,
        selectedItemKeys: Object.keys(
          scopeState.selectedItems as Record<string, unknown>,
        ).length,
        requestedTargetCount: params.filters?.targets?.length ?? 0,
      },
      "[MessageAgents][searchKnowledgeBaseTool] Using KnowledgeBaseScope for KB search",
    )

    const { selections, resolvedTargets } = await buildSearchSelections(
      params,
      scopeState,
      repo,
    )
    if (!selections.length) {
      return ToolResponse.error(
        ToolErrorCodes.EXECUTION_FAILED,
        "No accessible knowledge base collections found for this user",
        { toolName: "searchKnowledgeBase" },
      )
    }

    Logger.info(
      {
        email,
        query,
        requestedTargets: params.filters?.targets ?? [],
        resolvedTargets: resolvedTargets.map(summarizeResolvedTargetForLog),
        baseSelections: scopeState.baseSelections,
        finalCollectionSelections: selections,
        selectedKnowledgeItemIds:
          scopeState.selectedItems[Apps.KnowledgeBase] ?? [],
        excludedIds: params.excludedIds ?? [],
      },
      "[KnowledgeBase][search] Resolved KB targets into collection selections for Vespa",
    )

    const fragments = await searchExecutor({
      email,
      query,
      app: Apps.KnowledgeBase,
      agentAppEnums: [Apps.KnowledgeBase],
      limit: params.limit,
      offset: params.offset ?? 0,
      excludedIds: params.excludedIds,
      collectionSelections: selections,
      selectedItems: scopeState.selectedItems,
      userId: context.user.numericId ?? undefined,
      workspaceId: context.user.workspaceNumericId ?? undefined,
    })

    if (!fragments.length) {
      return ToolResponse.error(
        ToolErrorCodes.EXECUTION_FAILED,
        "No knowledge base results found for the query.",
        { toolName: "searchKnowledgeBase" },
      )
    }

    return ToolResponse.success(fragments)
  } catch (error) {
    return ToolResponse.error(
      ToolErrorCodes.EXECUTION_FAILED,
      `Knowledge base search failed: ${getErrorMessage(error)}`,
      { toolName: "searchKnowledgeBase" },
    )
  }
}
export const lsKnowledgeBaseTool: Tool<LsKnowledgeBaseToolParams, Ctx> = {
  schema: {
    name: "ls",
    description: LS_KNOWLEDGE_BASE_TOOL_DESCRIPTION,
    parameters: toToolSchemaParameters(LsKnowledgeBaseInputSchema),
  },
  execute: executeLsKnowledgeBase,
}
export const searchKnowledgeBaseTool: Tool<SearchKnowledgeBaseToolParams, Ctx> =
  {
    schema: {
      name: "searchKnowledgeBase",
      description: SEARCH_KNOWLEDGE_BASE_TOOL_DESCRIPTION,
      parameters: toToolSchemaParameters<SearchKnowledgeBaseToolParams>(
        SearchKnowledgeBaseInputSchema,
      ),
    },
    execute: executeSearchKnowledgeBase,
  }

export const __knowledgeBaseFlowInternals = {
  buildCollectionLsProjection,
  buildCollectionTree,
  buildItemCanonicalPath,
  buildLsEntries,
  buildSearchSelections,
  buildSnapshotFromProjection,
  createCollectionLsEntry,
  createItemLsEntry,
  flattenLsEntries,
  isDescendantOfFolder,
  isProjectionStale,
  isResolvedTargetAllowed,
  listScopedCollections,
  mergeSelections,
  parseCollectionLsProjection,
  rebuildCollectionProjection,
  resolveKnowledgeBaseTarget,
}
