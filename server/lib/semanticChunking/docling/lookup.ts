/**
 * Build lookup map from all Docling arrays for fast $ref resolution
 */

import type {
  DoclingDocument,
  DoclingNode,
  DoclingTextItem,
  DoclingTableItem,
  DoclingPictureItem,
  DoclingGroupItem,
  DoclingKeyValueItem,
  DoclingFormItem,
} from "./types"

/**
 * Build a lookup map from all Docling item arrays
 * This allows O(1) resolution of $ref pointers
 */
export function buildLookup(doc: DoclingDocument): Map<string, DoclingNode> {
  const lookup = new Map<string, DoclingNode>()

  // Add all text items
  for (const item of doc.texts || []) {
    lookup.set(item.self_ref, item)
  }

  // Add all tables
  for (const item of doc.tables || []) {
    lookup.set(item.self_ref, item)
  }

  // Add all pictures
  for (const item of doc.pictures || []) {
    lookup.set(item.self_ref, item)
  }

  // Add all groups
  for (const item of doc.groups || []) {
    lookup.set(item.self_ref, item)
  }

  // Add key-value items
  for (const item of doc.key_value_items || []) {
    lookup.set(item.self_ref, item)
  }

  // Add form items
  for (const item of doc.form_items || []) {
    lookup.set(item.self_ref, item)
  }

  return lookup
}

/**
 * Resolve a $ref pointer to the actual node
 */
export function resolveRef(
  ref: { $ref: string },
  lookup: Map<string, DoclingNode>
): DoclingNode | undefined {
  return lookup.get(ref.$ref)
}

/**
 * Type guard: Check if node is a text item
 */
export function isTextItem(node: DoclingNode): node is DoclingTextItem {
  return "label" in node && typeof (node as DoclingTextItem).label === "string"
}

/**
 * Type guard: Check if node is a table
 */
export function isTableItem(node: DoclingNode): node is DoclingTableItem {
  return "data" in node && node.self_ref?.startsWith("#/tables/")
}

/**
 * Type guard: Check if node is a picture
 */
export function isPictureItem(node: DoclingNode): node is DoclingPictureItem {
  return node.self_ref?.startsWith("#/pictures/")
}

/**
 * Type guard: Check if node has children (is a group/container or text with nested content)
 */
export function hasChildren(node: DoclingNode): node is (DoclingGroupItem | DoclingTextItem) & { children: { $ref: string }[] } {
  return (
    "children" in node &&
    Array.isArray((node as DoclingGroupItem | DoclingTextItem).children) &&
    (node as DoclingGroupItem | DoclingTextItem).children!.length > 0
  )
}

/**
 * Type guard: Check if node is a group container
 */
export function isGroupItem(node: DoclingNode): node is DoclingGroupItem {
  return node.self_ref?.startsWith("#/groups/") ?? false
}

/**
 * Type guard: Check if node is a key-value item
 */
export function isKeyValueItem(node: DoclingNode): node is DoclingKeyValueItem {
  return node.self_ref?.startsWith("#/key_value_items/") ?? false
}

/**
 * Get content layer from any node
 */
export function getContentLayer(node: DoclingNode): "body" | "furniture" | undefined {
  // Most items have content_layer directly
  if ("content_layer" in node) {
    return node.content_layer
  }
  return undefined
}
