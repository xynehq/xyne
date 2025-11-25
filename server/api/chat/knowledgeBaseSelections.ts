import { db } from "@/db/client"
import {
  getCollectionsByOwner,
} from "@/db/knowledgeBase"
import { getUserByEmail } from "@/db/user"
import { collectionItems, collections } from "@/db/schema"
import { and, eq, inArray, isNull } from "drizzle-orm"
import { Apps } from "@xyne/vespa-ts/types"
import { expandSheetIds } from "@/search/utils"
import type { SelectPublicAgent } from "@/shared/types"
import { isAppSelectionMap, parseAppSelections } from "./utils"

export type PathExtractedInfo = {
  collectionFileIds: string[]
  collectionFolderIds: string[]
  collectionIds: string[]
}

export enum KnowledgeBaseScope {
  UserOwned = "user_owned",
  AgentScoped = "agent_scoped",
  AllAccessible = "all_accessible",
}

export interface BuildKnowledgeBaseSelectionsParams {
  scope: KnowledgeBaseScope
  email: string
  selectedItems?: Partial<Record<Apps, string[]>>
  pathExtractedInfo?: PathExtractedInfo
  publicAgents?: SelectPublicAgent[]
}

export type KnowledgeBaseSelection = {
  collectionIds?: string[]
  collectionFolderIds?: string[]
  collectionFileIds?: string[]
}

export async function buildKnowledgeBaseCollectionSelections(
  params: BuildKnowledgeBaseSelectionsParams,
): Promise<KnowledgeBaseSelection[]> {
  const {
    scope,
    email,
    selectedItems,
    pathExtractedInfo,
    publicAgents,
  } = params

  switch (scope) {
    case KnowledgeBaseScope.AgentScoped: {
      const ids = resolveKnowledgeItemIds(pathExtractedInfo, selectedItems)
      return convertPrefixedIdsToSelections(ids)
    }
    case KnowledgeBaseScope.UserOwned: {
      return buildUserOwnedSelections(
        email,
        resolveKnowledgeItemIds(pathExtractedInfo, selectedItems),
      )
    }
    case KnowledgeBaseScope.AllAccessible: {
      return buildAllAccessibleSelections({
        email,
        selectedItems,
        pathExtractedInfo,
        publicAgents,
      })
    }
    default:
      return []
  }
}

async function buildUserOwnedSelections(
  email: string,
  explicitSelections: string[],
): Promise<KnowledgeBaseSelection[]> {
  const [user] = await getUserByEmail(db, email)
  if (!user) return []

  const ownedCollections = await getCollectionsByOwner(db, user.id)
  if (!ownedCollections.length) return []

  const ownedCollectionIds = new Set(
    ownedCollections.map((c) => Number(c.id)),
  )

  const prefixedSelections = explicitSelections.length
    ? await filterPrefixedIdsToOwner(explicitSelections, ownedCollectionIds, user.id)
    : Array.from(ownedCollectionIds).map((id) => `cl-${id}`)

  return convertPrefixedIdsToSelections(prefixedSelections)
}

async function buildAllAccessibleSelections(params: {
  email: string
  selectedItems?: Partial<Record<Apps, string[]>>
  pathExtractedInfo?: PathExtractedInfo
  publicAgents?: SelectPublicAgent[]
}): Promise<KnowledgeBaseSelection[]> {
  const { email, selectedItems, pathExtractedInfo, publicAgents } = params

  const allIds = new Set<string>(
    resolveKnowledgeItemIds(pathExtractedInfo, selectedItems),
  )

  const userSelections = await buildUserOwnedSelections(email, [])
  userSelections.forEach((selection) => {
    selection.collectionIds?.forEach((id) => allIds.add(`cl-${id}`))
    selection.collectionFolderIds?.forEach((id) => allIds.add(`clfd-${id}`))
    selection.collectionFileIds?.forEach((id) => allIds.add(`clf-${id}`))
  })

  if (publicAgents?.length) {
    const publicIds = extractKnowledgeIdsFromPublicAgents(
      publicAgents,
      pathExtractedInfo,
    )
    publicIds.forEach((id) => allIds.add(id))
  }

  return convertPrefixedIdsToSelections(Array.from(allIds))
}

function resolveKnowledgeItemIds(
  pathExtractedInfo?: PathExtractedInfo,
  selectedItems?: Partial<Record<Apps, string[]>>,
): string[] {
  if (pathExtractedInfo) {
    if (pathExtractedInfo.collectionFolderIds.length)
      return pathExtractedInfo.collectionFolderIds
    if (pathExtractedInfo.collectionFileIds.length)
      return pathExtractedInfo.collectionFileIds
    if (pathExtractedInfo.collectionIds.length)
      return pathExtractedInfo.collectionIds
  }

  return selectedItems?.[Apps.KnowledgeBase] ?? []
}

async function filterPrefixedIdsToOwner(
  prefixedIds: string[],
  ownedCollectionIds: Set<number>,
  ownerId: number,
): Promise<string[]> {
  const collectionIds: string[] = []
  const folderIds: string[] = []
  const fileIds: string[] = []

  prefixedIds.forEach((id) => {
    if (id.startsWith("clfd-")) {
      folderIds.push(id.replace(/^clfd[-_]/, ""))
    } else if (id.startsWith("clf-")) {
      fileIds.push(id.replace(/^clf[-_]/, ""))
    } else if (id.startsWith("cl-")) {
      const collectionId = id.replace(/^cl[-_]/, "")
      const numericCollectionId = Number(collectionId)
      if (
        !Number.isNaN(numericCollectionId) &&
        ownedCollectionIds.has(numericCollectionId)
      ) {
        collectionIds.push(collectionId)
      }
    }
  })

  const ownedFolderIds = await filterChildItemsByOwner(folderIds, ownerId)
  const ownedFileIds = await filterChildItemsByOwner(fileIds, ownerId)

  return [
    ...collectionIds.map((id) => `cl-${id}`),
    ...ownedFolderIds.map((id) => `clfd-${id}`),
    ...ownedFileIds.map((id) => `clf-${id}`),
  ]
}

async function filterChildItemsByOwner(
  itemIds: string[],
  ownerId: number,
): Promise<string[]> {
  if (!itemIds.length) return []

  const rows = await db
    .select({ id: collectionItems.id })
    .from(collectionItems)
    .innerJoin(collections, eq(collectionItems.collectionId, collections.id))
    .where(
      and(
        inArray(collectionItems.id, itemIds),
        eq(collections.ownerId, ownerId),
        isNull(collectionItems.deletedAt),
        isNull(collections.deletedAt),
      ),
    )

  return rows.map((row) => row.id)
}

function convertPrefixedIdsToSelections(
  prefixedIds: string[],
): KnowledgeBaseSelection[] {
  if (!prefixedIds.length) return []

  const collectionIds = new Set<string>()
  const collectionFolderIds = new Set<string>()
  const collectionFileIds = new Set<string>()

  prefixedIds.forEach((itemId) => {
    if (itemId.startsWith("cl-")) {
      collectionIds.add(itemId.replace(/^cl[-_]/, ""))
    } else if (itemId.startsWith("clfd-")) {
      collectionFolderIds.add(itemId.replace(/^clfd[-_]/, ""))
    } else if (itemId.startsWith("clf-")) {
      expandSheetIds(itemId.replace(/^clf[-_]/, "")).forEach((id) =>
        collectionFileIds.add(id),
      )
    }
  })

  const selection: KnowledgeBaseSelection = {}
  if (collectionIds.size) selection.collectionIds = Array.from(collectionIds)
  if (collectionFolderIds.size)
    selection.collectionFolderIds = Array.from(collectionFolderIds)
  if (collectionFileIds.size)
    selection.collectionFileIds = Array.from(collectionFileIds)

  return Object.keys(selection).length ? [selection] : []
}

function extractKnowledgeIdsFromPublicAgents(
  publicAgents: SelectPublicAgent[],
  pathExtractedInfo?: PathExtractedInfo,
): string[] {
  const ids = new Set<string>()

  for (const publicAgent of publicAgents) {
    if (!publicAgent?.appIntegrations) continue
    if (isAppSelectionMap(publicAgent.appIntegrations)) {
      const { selectedItems } = parseAppSelections(
        publicAgent.appIntegrations,
      )
      const kbIds = resolveKnowledgeItemIds(pathExtractedInfo, selectedItems)
      kbIds.forEach((id) => ids.add(id))
    }
  }

  return Array.from(ids)
}
