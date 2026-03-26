import type { Collection, CollectionItem } from "@/db/schema"

export type PublicCollection = Collection
export type PublicCollectionItem = Omit<CollectionItem, "toc" | "tocInfo">
export type PublicCollectionWithItems = PublicCollection & {
  items: PublicCollectionItem[]
}

export function serializePublicCollection(
  collection: Collection,
): PublicCollection {
  return collection
}

export function serializePublicCollectionItem(
  item: CollectionItem,
): PublicCollectionItem {
  const { toc: _toc, tocInfo: _tocInfo, ...publicItem } = item
  return publicItem
}

export function serializePublicCollectionItems(
  items: CollectionItem[],
): PublicCollectionItem[] {
  return items.map(serializePublicCollectionItem)
}

export function serializePublicCollectionWithItems(
  collection: Collection & { items: CollectionItem[] },
): PublicCollectionWithItems {
  return {
    ...collection,
    items: serializePublicCollectionItems(collection.items),
  }
}
