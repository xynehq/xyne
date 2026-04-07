/**
 * Spatial deduplication for semantic nodes
 * Resolves conflicts between tables and OCR images using bbox overlap (IoU)
 *
 * Principle: Table > Paragraph > Image
 * When image overlaps table: merge OCR text into table.rawText, drop image
 */

import type { SemanticNode, SemanticTableNode, BBox } from "./types"

/** IoU threshold for considering two nodes as representing the same content */
const IOU_THRESHOLD = 0.9

/**
 * Calculate Intersection over Union (IoU) of two bounding boxes
 */
export function calculateIoU(a: BBox, b: BBox): number {
  const x1 = Math.max(a.l, b.l)
  const y1 = Math.max(a.t, b.t)
  const x2 = Math.min(a.r, b.r)
  const y2 = Math.min(a.b, b.b)

  const intersectionWidth = Math.max(0, x2 - x1)
  const intersectionHeight = Math.max(0, y2 - y1)
  const intersection = intersectionWidth * intersectionHeight

  const areaA = (a.r - a.l) * (a.b - a.t)
  const areaB = (b.r - b.l) * (b.b - b.t)
  const union = areaA + areaB - intersection

  if (union === 0) return 0
  return intersection / union
}

/**
 * Group nodes by page number for efficient comparison
 */
function groupNodesByPage(nodes: SemanticNode[]): Map<number, SemanticNode[]> {
  const groups = new Map<number, SemanticNode[]>()

  for (const node of nodes) {
    const pageNo = node.pageNo
    if (pageNo === undefined) continue

    const existing = groups.get(pageNo) || []
    existing.push(node)
    groups.set(pageNo, existing)
  }

  return groups
}

/**
 * Check if a node has a valid bounding box
 */
function hasValidBBox(node: SemanticNode): boolean {
  return node.bbox !== undefined
}

/**
 * Merge image node into table node
 * Attaches image description (OCR text) to table's rawText field
 */
function mergeImageIntoTable(tableNode: SemanticTableNode, imageNode: SemanticNode): void {
  if (imageNode.type !== "image") return

  const imageDescription = (imageNode as { description?: string }).description || ""

  if (!tableNode.rawText) {
    tableNode.rawText = imageDescription
  } else {
    tableNode.rawText = `${tableNode.rawText}\n${imageDescription}`
  }

  // Merge source refs to maintain traceability
  tableNode.sourceRefs = [...new Set([...tableNode.sourceRefs, ...imageNode.sourceRefs])]
}

/**
 * Resolve conflicts within a group of nodes from the same page
 *
 * Algorithm:
 * 1. Sort by priority (table > paragraph > image > other)
 * 2. For each node, check if it overlaps with already-kept nodes
 * 3. If overlap with table: merge/drop based on type
 * 4. If overlap with other: keep both (partial overlap case)
 */
function resolvePageConflicts(pageNodes: SemanticNode[]): SemanticNode[] {
  const result: SemanticNode[] = []

  // Priority order: table (3) > paragraph (2) > image (1) > other (0)
  const getPriority = (node: SemanticNode): number => {
    switch (node.type) {
      case "table": return 3
      case "paragraph": return 2
      case "image": return 1
      default: return 0
    }
  }

  // Sort by priority descending
  const sortedNodes = [...pageNodes].sort((a, b) => getPriority(b) - getPriority(a))

  for (const node of sortedNodes) {
    // Skip nodes without spatial info
    if (!hasValidBBox(node)) {
      result.push(node)
      continue
    }

    // Find overlapping nodes in result
    const overlapping = result.filter(existing =>
      existing.pageNo === node.pageNo &&
      hasValidBBox(existing) &&
      calculateIoU(existing.bbox!, node.bbox!) > IOU_THRESHOLD
    )

    if (overlapping.length === 0) {
      // No overlap - keep node
      result.push(node)
      continue
    }
    
    // Check if any overlapping node is a table
    const overlappingTable = overlapping.find(n => n.type === "table") as SemanticTableNode | undefined

    if (node.type === "image" && overlappingTable) {
      // Image overlapping table: merge OCR text into table, drop image
      mergeImageIntoTable(overlappingTable, node)
      continue
    }

    if (node.type === "table") {
      // Table overlapping other nodes: keep table, remove overlapping images
      const imagesToRemove = overlapping.filter(n => n.type === "image")
      for (const imageNode of imagesToRemove) {
        mergeImageIntoTable(node as SemanticTableNode, imageNode)
        const index = result.indexOf(imageNode)
        if (index !== -1) {
          result.splice(index, 1)
        }
      }
      result.push(node)
      continue
    }

    // For other cases (paragraph + image, etc.), keep both
    // This handles partial overlaps correctly
    result.push(node)
  }

  return result
}

/**
 * Deduplicate semantic nodes based on spatial overlap
 *
 * Process:
 * 1. Group nodes by page number
 * 2. Within each page, resolve conflicts using IoU > 0.9 threshold
 * 3. Merge overlapping image OCR text into tables
 * 4. Return filtered nodes in original order
 *
 * Priority: Table > Paragraph > Image
 */
export function deduplicateNodes(nodes: SemanticNode[]): SemanticNode[] {
  // Group by page
  const pageGroups = groupNodesByPage(nodes)

  // Build set of nodes to keep
  const keptNodes = new Set<SemanticNode>()

  for (const [, pageNodes] of pageGroups) {
    const resolved = resolvePageConflicts(pageNodes)
    for (const node of resolved) {
      keptNodes.add(node)
    }
  }

  // Return nodes in original order (filter out removed ones)
  return nodes.filter(node => keptNodes.has(node))
}

/**
 * Generator wrapper for streaming deduplication
 * Collects all nodes first, then deduplicates, then yields
 */
export function* deduplicatedSemanticIterator(
  nodes: Iterable<SemanticNode>
): Generator<SemanticNode> {
  const nodeArray = [...nodes]
  const deduped = deduplicateNodes(nodeArray)
  for (const node of deduped) {
    yield node
  }
}
